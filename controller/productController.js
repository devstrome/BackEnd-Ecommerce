const Product = require('../models/Product');
const User = require('../models/User');
const cloudinary = require('../config/coudinaryconfig');
const mongoose = require('mongoose');
const { randomBytes } = require('crypto');
const Shipping = require('../models/Shipping');
const Region = require('../models/Region');
const seoService = require('../utils/seoService');
const { revalidateCarts } = require('./CartController');
const { emitStoreEvent } = require('../utils/storeEvents');
const escapeRegex = require('../utils/escapeRegex');

// Normalize categories coming from multipart form data into a clean string array.
// Handles: '["Makeup","Lip"]' (legacy JSON string), arrays with JSON-string
// elements, nested arrays, and plain strings.
function normalizeCategories(val) {
  const out = [];
  const push = (item) => {
    if (Array.isArray(item)) { item.forEach(push); return; }
    if (typeof item !== 'string') return;
    const t = item.trim();
    if (!t) return;
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) { p.forEach(push); return; }
      if (typeof p === 'string') { push(p); return; } // recurse: legacy double-encoded strings
      out.push(String(p));
      return;
    } catch {}
    out.push(t);
  };
  push(val);
  return out.filter(Boolean);
}

function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseBoolean(value) {
  return value === true || value === 'true';
}

function parseOptionalDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error('Estimated pre-order date is invalid');
    error.statusCode = 400;
    throw error;
  }
  return date;
}

async function createProductSku(productName) {
  const prefix = String(productName || 'PRD').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'PRD';
  for (let attempt = 0; attempt < 20; attempt++) {
    const sku = `${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`;
    if (!(await Product.exists({ sku }))) return sku;
  }
  const error = new Error('Unable to create a unique product SKU. Please try again.');
  error.statusCode = 503;
  throw error;
}

function optionsFromLegacyVariant(variant = {}, productMeasureType = '', productUnitName = '') {
  if (Array.isArray(variant.options) && variant.options.length) return variant.options;
  const sizes = Array.isArray(variant.sizes) ? variant.sizes : [];
  const prices = Array.isArray(variant.prices) ? variant.prices : [];
  const discounts = Array.isArray(variant.discountPrices) ? variant.discountPrices : [];
  const stocks = Array.isArray(variant.stockBySize) ? variant.stockBySize : [];
  return sizes.map((size, index) => ({
    size: String(size || '').trim(),
    measureType: variant.measureType || productMeasureType || '',
    unitName: variant.unitName || productUnitName || '',
    price: Number.isFinite(Number(prices[index])) ? Number(prices[index]) : undefined,
    discountPrice: Number(discounts[index]) || 0,
    stock: Number(stocks[index]) || 0,
    badgeName: variant.badgeNames?.[index] || '',
    badgeColor: variant.badgeColors?.[index] || '',
  }));
}

function validateVariantConfigurations(variants, measureType = '', unitName = '', legacyRegionVariantIds = new Set()) {
  return variants.map((variant, variantIndex) => {
    if (!variant.regionId && !legacyRegionVariantIds.has(String(variant._id || ''))) {
      const error = new Error(`Select a region for color ${variant.colorName || variantIndex + 1}`);
      error.statusCode = 422;
      throw error;
    }
    if (!String(variant.colorName || '').trim()) {
      const error = new Error(`Color is required for variant ${variantIndex + 1}`);
      error.statusCode = 422;
      throw error;
    }

    const options = optionsFromLegacyVariant(variant, measureType, unitName).map((option, optionIndex) => {
      const price = Number(option.price);
      const discountPrice = Number(option.discountPrice || 0);
      const stock = Number(option.stock);
      if (!Number.isFinite(price) || price <= 0) {
        const error = new Error(`Enter a valid price for ${variant.colorName}, option ${optionIndex + 1}`);
        error.statusCode = 422;
        throw error;
      }
      if (!Number.isFinite(discountPrice) || discountPrice < 0 || discountPrice > price) {
        const error = new Error(`Discount price for ${variant.colorName}, option ${optionIndex + 1} must be between 0 and the price`);
        error.statusCode = 422;
        throw error;
      }
      if (!Number.isInteger(stock) || stock < 0) {
        const error = new Error(`Stock for ${variant.colorName}, option ${optionIndex + 1} must be a non-negative whole number`);
        error.statusCode = 422;
        throw error;
      }
      const normalized = {
        ...option,
        size: String(option.size || '').trim(),
        measureType: String(option.measureType || measureType || '').trim(),
        unitName: String(option.unitName || unitName || '').trim(),
        price,
        discountPrice,
        stock,
      };
      if (!normalized.size && (!normalized.measureType || !normalized.unitName)) {
        const error = new Error(`Option ${optionIndex + 1} for ${variant.colorName} needs a size or a measure type and unit`);
        error.statusCode = 422;
        throw error;
      }
      return normalized;
    });

    if (!options.length) {
      const error = new Error(`Add at least one size or measure option for ${variant.colorName}`);
      error.statusCode = 422;
      throw error;
    }
    const optionKeys = options.map((option) => [option.size, option.measureType, option.unitName].map(value => value.toLowerCase()).join('|'));
    if (new Set(optionKeys).size !== optionKeys.length) {
      const error = new Error(`Variant ${variant.colorName} contains duplicate size or measure options`);
      error.statusCode = 422;
      throw error;
    }
    return { ...variant, options };
  });
}

function validateProductPrice(mainPrice, discountPrice) {
  const price = Number(mainPrice);
  const discount = Number(discountPrice || 0);
  if (!Number.isFinite(price) || price <= 0) {
    const error = new Error('A valid product price is required');
    error.statusCode = 422;
    throw error;
  }
  if (!Number.isFinite(discount) || discount < 0 || discount > price) {
    const error = new Error('Product discount price must be between 0 and the product price');
    error.statusCode = 422;
    throw error;
  }
}

async function validateRegionIds(regionIds = []) {
  const normalized = [...new Set(regionIds.filter(Boolean).map(String))];
  if (normalized.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    const error = new Error('Invalid region ID');
    error.statusCode = 400;
    throw error;
  }
  if (!normalized.length) return [];
  const regions = await Region.find({ _id: { $in: normalized }, isActive: true }).select('_id');
  if (regions.length !== normalized.length) {
    const error = new Error('One or more selected regions are missing or inactive');
    error.statusCode = 422;
    throw error;
  }
  return regions.map((region) => region._id);
}

// Socket.io instance (set from server.js)
let ioInstance = null;

// Helper function to emit product updates
function emitProductUpdate(productId, updateType, data = {}) {
  if (!ioInstance) return;

  const eventData = {
    productId,
    updateType,
    timestamp: new Date(),
    ...data
  };

  // Emit to product room
  ioInstance.to(`product_${productId}`).emit('productUpdate', eventData);
  
  // Emit to admin room for monitoring
  ioInstance.to('adminRoom').emit('productUpdate', eventData);
  
  console.log(`📦 Product update emitted: ${updateType} for product ${productId}`);
}

function emitLiveProductBroadcast(product) {
  if (!ioInstance || !product?.broadcast) return;
  ioInstance.emit('liveProduct', {
    productId: String(product._id),
    productName: product.name,
    mainImage: product.mainImage || '',
    timestamp: new Date(),
  });
}

const addProduct = async (req, res) => {
  try {
    const files = req.files;
    let variantImages = {};
    let mainImageUrl = '';

    if (files) {
      for (const key of Object.keys(files)) {
        const fileArray = files[key];
        for (const file of fileArray) {
          const result = await cloudinary.uploader.upload(file.path);
          if (key === 'mainImage') {
            mainImageUrl = result.secure_url;
          } else {
            const variantIndex = key.split('-')[1];
            if (!variantImages[variantIndex]) {
              variantImages[variantIndex] = [];
            }
            variantImages[variantIndex].push(result.secure_url);
          }
        }
      }
    }

    let variants = parseJsonArray(req.body.variants);
    if (variants.length) variants = validateVariantConfigurations(variants, req.body.measureType, req.body.unitName);
    else validateProductPrice(req.body.mainPrice, req.body.discountPrice);
    const productRegions = parseJsonArray(req.body.regions);
    const validatedRegionIds = await validateRegionIds([
      req.body.regionId,
      ...productRegions,
      ...variants.map((variant) => variant.regionId),
    ]);
    const defaultRegionId = req.body.regionId || validatedRegionIds[0] || null;

    const newProduct = new Product({
      name: req.body.name,
      sku: await createProductSku(req.body.name),
      categories: normalizeCategories(req.body.categories),
      brand: req.body.brand,
      regionId: defaultRegionId,
      regions: validatedRegionIds,
      broadcast: parseBoolean(req.body.broadcast),
      isDigitalProduct: parseBoolean(req.body.isDigitalProduct),
      isPreOrder: parseBoolean(req.body.isPreOrder),
      preOrderEstimatedDate: parseBoolean(req.body.isPreOrder) ? parseOptionalDate(req.body.preOrderEstimatedDate) : null,
      comingSoon: parseBoolean(req.body.comingSoon),
      mainPrice: req.body.mainPrice,
      discountPrice: req.body.discountPrice,
      mainBadgeName: req.body.mainBadgeName,
      mainBadgeColor: req.body.mainBadgeColor,
      gender: req.body.gender,
      variants: await Promise.all(variants.map(async (variant, index) => {
        // Build shipping options strictly from shippingIds (persist the ids too
        // so product edit can restore the previous selections)
        let shippingFields = { shippingIds: [] };
        if (Array.isArray(variant.shippingIds) && variant.shippingIds.length > 0) {
          const ships = await Shipping.find({ _id: { $in: variant.shippingIds } });
          if (ships.length > 0) {
            const options = ships.map(s => ({ name: s.name, charge: s.charge, estimatedDays: s.estimatedDays }));
            shippingFields = { shippingOptions: options, shippingIds: ships.map(s => s._id) };
          }
        } else if (Array.isArray(variant.shippingIds)) {
          // explicit empty array = user cleared the selection
          shippingFields = { shippingOptions: [], shippingIds: [] };
        }

        // Handle stockBySize array - each size has its own stock
        const options = optionsFromLegacyVariant(variant, req.body.measureType, req.body.unitName);
        const sizes = Array.isArray(variant.sizes) && variant.sizes.length
          ? variant.sizes
          : options.map((option) => option.size || '');
        let stockBySize = [];
        if (Array.isArray(variant.stockBySize)) {
          stockBySize = variant.stockBySize;
        } else if (Array.isArray(variant.stock)) {
          stockBySize = variant.stock;
        } else if (typeof variant.stock === 'number') {
          // If stock is a single number, distribute it across all sizes
          stockBySize = new Array(sizes.length).fill(variant.stock);
        } else {
          // Default to 0 for each size
          stockBySize = options.map((option) => Number(option.stock) || 0);
        }

        // Ensure stockBySize array matches the sizes array length
        while (stockBySize.length < sizes.length) {
          stockBySize.push(0);
        }
        stockBySize = stockBySize.slice(0, sizes.length);

        // Calculate total stock for backward compatibility
        const totalStock = stockBySize.reduce((sum, stock) => sum + stock, 0);

        return ({
          ...variant,
          sizes,
          prices: Array.isArray(variant.prices) && variant.prices.length ? variant.prices : options.map((option) => option.price),
          discountPrices: Array.isArray(variant.discountPrices) && variant.discountPrices.length ? variant.discountPrices : options.map((option) => option.discountPrice),
          regionId: variant.regionId || defaultRegionId,
          options,
          deliveryTimes: undefined,
          ...shippingFields,
          images: variantImages[index] || [],
          stockBySize,
          stock: totalStock, // Legacy field
          specifications: Array.isArray(variant.specifications) ? variant.specifications : []
        });
      })),
      mainImage: mainImageUrl,
      measureType: req.body.measureType,
      unitName: req.body.unitName
    });

    await newProduct.save();
    
    // Auto-generate SEO in background
    seoService.generateSEO(newProduct).catch(err => console.error('SEO gen error:', err));
    
    // Emit product creation event
    emitProductUpdate(newProduct._id, 'product_created', {
      product: newProduct
    });
    emitLiveProductBroadcast(newProduct);
    
    res.status(201).json(newProduct);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    let product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const files = req.files;
    let variantImages = {};
    let mainImageUrl = product.mainImage;

    if (files) {
      for (const key of Object.keys(files)) {
        const fileArray = files[key];
        for (const file of fileArray) {
          const result = await cloudinary.uploader.upload(file.path);
          if (key === 'mainImage') {
            mainImageUrl = result.secure_url;
          } else {
            const variantIndex = key.split('-')[1];
            if (!variantImages[variantIndex]) {
              variantImages[variantIndex] = [];
            }
            variantImages[variantIndex].push(result.secure_url);
          }
        }
      }
    }

    let variants = req.body.variants === undefined ? null : parseJsonArray(req.body.variants);
    if (variants?.length) {
      const legacyRegionVariantIds = new Set(product.variants.filter((variant) => !variant.regionId).map((variant) => String(variant._id)));
      variants = validateVariantConfigurations(variants, req.body.measureType || product.measureType, req.body.unitName || product.unitName, legacyRegionVariantIds);
    }
    else if (variants && variants.length === 0) {
      validateProductPrice(req.body.mainPrice ?? product.mainPrice, req.body.discountPrice ?? product.discountPrice);
    }
    const productRegions = req.body.regions === undefined ? null : parseJsonArray(req.body.regions);
    const requestedRegionIds = [
      req.body.regionId,
      ...(productRegions || []),
      ...((variants || []).map((variant) => variant.regionId)),
    ];
    const validatedRegionIds = requestedRegionIds.some(Boolean)
      ? await validateRegionIds(requestedRegionIds)
      : null;

    product.name = req.body.name || product.name;
    if (req.body.categories !== undefined) product.categories = normalizeCategories(req.body.categories);
    product.brand = req.body.brand || product.brand;
    if (req.body.regionId !== undefined) product.regionId = req.body.regionId || null;
    if (productRegions) product.regions = validatedRegionIds || [];
    else if (validatedRegionIds) product.regions = validatedRegionIds;
    if (req.body.broadcast !== undefined) product.broadcast = parseBoolean(req.body.broadcast);
    if (req.body.isDigitalProduct !== undefined) product.isDigitalProduct = parseBoolean(req.body.isDigitalProduct);
    if (req.body.isPreOrder !== undefined) {
      product.isPreOrder = parseBoolean(req.body.isPreOrder);
      if (!product.isPreOrder) product.preOrderEstimatedDate = null;
    }
    if (req.body.preOrderEstimatedDate !== undefined) {
      product.preOrderEstimatedDate = product.isPreOrder ? parseOptionalDate(req.body.preOrderEstimatedDate) : null;
    }
    if (req.body.comingSoon !== undefined) product.comingSoon = parseBoolean(req.body.comingSoon);
    if (req.body.mainPrice !== undefined) product.mainPrice = Number(req.body.mainPrice);
    if (req.body.discountPrice !== undefined) product.discountPrice = Number(req.body.discountPrice);
    product.mainBadgeName = req.body.mainBadgeName || product.mainBadgeName;
    product.mainBadgeColor = req.body.mainBadgeColor || product.mainBadgeColor;
    product.gender = req.body.gender || product.gender;
    product.mainImage = mainImageUrl;
    product.measureType = req.body.measureType || product.measureType; // Update measureType
    product.unitName = req.body.unitName || product.unitName;          // Update unitName

    if (variants) product.variants = await Promise.all(variants.map(async (variant, index) => {
      const currentVariant = variant._id ? product.variants.id(variant._id) : product.variants[index];
      const keepLegacyRegion = !variant.regionId && currentVariant && !currentVariant.regionId;
      let shippingFields = {};
      if (Array.isArray(variant.shippingIds) && variant.shippingIds.length > 0) {
        const ships = await Shipping.find({ _id: { $in: variant.shippingIds } });
        if (ships.length > 0) {
          const options = ships.map(s => ({ name: s.name, charge: s.charge, estimatedDays: s.estimatedDays }));
          shippingFields = { shippingOptions: options, shippingIds: ships.map(s => s._id) };
        } else {
          // stale ids -> keep what is already stored for this variant
          shippingFields = {
            shippingOptions: product.variants[index]?.shippingOptions || [],
            shippingIds: product.variants[index]?.shippingIds || [],
          };
        }
      } else if (Array.isArray(variant.shippingIds)) {
        shippingFields = { shippingOptions: [], shippingIds: [] };
      }

      // Handle stockBySize array - each size has its own stock
      const options = optionsFromLegacyVariant(variant, req.body.measureType || product.measureType, req.body.unitName || product.unitName);
      const sizes = Array.isArray(variant.sizes) && variant.sizes.length
        ? variant.sizes
        : options.map((option) => option.size || '');
      let stockBySize = [];
      if (Array.isArray(variant.stockBySize)) {
        stockBySize = variant.stockBySize;
      } else if (Array.isArray(variant.stock)) {
        stockBySize = variant.stock;
      } else if (typeof variant.stock === 'number') {
        // If stock is a single number, distribute it across all sizes
        stockBySize = new Array(sizes.length).fill(variant.stock);
      } else {
        // Default to 0 for each size
        stockBySize = options.map((option) => Number(option.stock) || 0);
      }

      // Ensure stockBySize array matches the sizes array length
      while (stockBySize.length < sizes.length) {
        stockBySize.push(0);
      }
      stockBySize = stockBySize.slice(0, sizes.length);

      // Calculate total stock for backward compatibility
      const totalStock = stockBySize.reduce((sum, stock) => sum + stock, 0);

      // Start from existing images
      let imagesArray = Array.isArray(product.variants[index]?.images)
        ? [...product.variants[index].images]
        : [];

      // Handle deletion list from form-data field deleteImages-{index}
      const deleteKey = `deleteImages-${index}`;
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, deleteKey)) {
        try {
          const toDelete = JSON.parse(req.body[deleteKey]);
          if (Array.isArray(toDelete) && toDelete.length > 0) {
            imagesArray = imagesArray.filter((url) => !toDelete.includes(url));
          }
        } catch (e) {
          // ignore parse errors silently
        }
      }

      // Append any newly uploaded images for this variant
      if (variantImages[index] && Array.isArray(variantImages[index]) && variantImages[index].length > 0) {
        imagesArray = imagesArray.concat(variantImages[index]);
      }

              const merged = ({
          ...product.variants[index],
          ...variant,
          sizes,
          prices: Array.isArray(variant.prices) && variant.prices.length ? variant.prices : options.map((option) => option.price),
          discountPrices: Array.isArray(variant.discountPrices) && variant.discountPrices.length ? variant.discountPrices : options.map((option) => option.discountPrice),
          regionId: keepLegacyRegion ? null : (variant.regionId || req.body.regionId || product.regionId || null),
          options,
          deliveryTimes: undefined,
          ...shippingFields,
          images: imagesArray,
          stockBySize,
          stock: totalStock, // Legacy field
          specifications: Array.isArray(variant.specifications) ? variant.specifications : []
        });
      return merged;
    }));

    // Apply manually-edited SEO submitted with the form (JSON string from multipart)
    if (req.body.seo) {
      try { product.seo = JSON.parse(req.body.seo); } catch (e) { /* keep existing */ }
    }

    await product.save();
    
    // Fill/refresh auto-generated SEO in background — never overwrites manual edits
    seoService.generateSEO(product, { force: false }).catch(err => console.error('SEO gen error:', err));
    
    // Emit product update event
    emitProductUpdate(product._id, 'product_updated', {
      product: product
    });
    emitLiveProductBroadcast(product);

    // Price may have changed — re-price + re-validate open carts holding this
    // product, then nudge all clients to re-read catalog data.
    revalidateCarts({ productIds: [product._id] }).catch(() => {});
    emitStoreEvent('product_updated', { productId: product._id, brand: product.brand });

    res.status(200).json(product);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

const getProducts = async (req, res) => {
  try {
    const scalarQuery = (key) => {
      const value = req.query[key];
      return value === undefined ? undefined : (typeof value === 'string' ? value.trim() : null);
    };
    const searchQuery = scalarQuery('q');
    const category = scalarQuery('category');
    const brand = scalarQuery('brand');
    const gender = scalarQuery('gender');
    const regionQuery = scalarQuery('region');
    const regionId = scalarQuery('regionId');
    const minPrice = scalarQuery('minPrice');
    const maxPrice = scalarQuery('maxPrice');
    const rawLimit = scalarQuery('limit');
    const limit = rawLimit ?? '50';
    if ([searchQuery, category, brand, gender, regionQuery, regionId, minPrice, maxPrice].some((value) => value === null)) {
      return res.status(400).json({ message: 'Search and filter parameters must be single values' });
    }
    if (rawLimit === null || (rawLimit !== undefined && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1))) {
      return res.status(400).json({ message: 'Limit must be a positive integer' });
    }
    if ([searchQuery, category, brand].some((value) => value && value.length > 100)) {
      return res.status(400).json({ message: 'Search filters must be 100 characters or fewer' });
    }
    const hasOffset = Object.prototype.hasOwnProperty.call(req.query, 'offset');
    const parsedLimit = /^\d+$/.test(limit) ? Number(limit) : NaN;
    const responseLimit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 50;
    const offsetValue = scalarQuery('offset');
    if (offsetValue === null || (offsetValue !== undefined && !/^\d+$/.test(offsetValue))) {
      return res.status(400).json({ message: 'Offset must be a non-negative integer' });
    }
    const parsedOffset = offsetValue === undefined ? 0 : Number(offsetValue);
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset > 10000000) {
      return res.status(400).json({ message: 'Offset is outside the supported range' });
    }
    const responseOffset = parsedOffset;
    
    // Build search filter
    let filter = {};
    
    // Text search across multiple fields
    if (searchQuery) {
      filter.$or = [
        { name: { $regex: escapeRegex(searchQuery), $options: 'i' } },
        { brand: { $regex: escapeRegex(searchQuery), $options: 'i' } },
        { categories: { $regex: escapeRegex(searchQuery), $options: 'i' } },
        { description: { $regex: escapeRegex(searchQuery), $options: 'i' } }
      ];
    }
    
    // Category filter
    if (category) {
      filter.categories = { $regex: escapeRegex(category), $options: 'i' };
    }
    
    // Brand filter
    if (brand) {
      filter.brand = { $regex: escapeRegex(brand), $options: 'i' };
    }
    
    // Gender filter
    if (gender) {
      filter.gender = gender;
    }

    const selectedRegion = regionId || regionQuery;
    if (selectedRegion) {
      const region = mongoose.Types.ObjectId.isValid(String(selectedRegion))
        ? await Region.findById(selectedRegion).select('_id').lean()
        : await Region.findOne({ slug: String(selectedRegion).toLowerCase() }).select('_id').lean();
      if (!region) return res.status(200).json(searchQuery ? { products: [], searchQuery, totalResults: 0 } : []);
      const regionMatch = { $or: [
        { regionId: region._id },
        { regions: region._id },
        { 'variants.regionId': region._id },
      ] };
      filter.$and = [...(filter.$and || []), regionMatch];
    }
    
    // Price range filter
    if (minPrice || maxPrice) {
      const parsedMinPrice = minPrice ? Number(minPrice) : undefined;
      const parsedMaxPrice = maxPrice ? Number(maxPrice) : undefined;
      if ((parsedMinPrice !== undefined && (!Number.isFinite(parsedMinPrice) || parsedMinPrice < 0)) ||
          (parsedMaxPrice !== undefined && (!Number.isFinite(parsedMaxPrice) || parsedMaxPrice < 0)) ||
          (parsedMinPrice !== undefined && parsedMaxPrice !== undefined && parsedMinPrice > parsedMaxPrice)) {
        return res.status(400).json({ message: 'Price filters must be valid non-negative amounts with minPrice <= maxPrice' });
      }
      filter.mainPrice = {};
      if (parsedMinPrice !== undefined) filter.mainPrice.$gte = parsedMinPrice;
      if (parsedMaxPrice !== undefined) filter.mainPrice.$lte = parsedMaxPrice;
    }
    
    // Execute query with population
    let productQuery = Product.find(filter)
      .populate('regionId', 'name slug')
      .populate('regions', 'name slug')
      .populate('variants.regionId', 'name slug')
      .limit(responseLimit)
      .sort({ createdAt: -1, _id: -1 });
    if (req.query.fields === 'sitemap') productQuery = productQuery.select('_id updatedAt createdAt');
    if (hasOffset) productQuery = productQuery.skip(responseOffset);
    const products = await productQuery;

    // Keep the established array/search contracts unchanged. Explicit offset
    // pagination is used by sitemap generation and other paged consumers.
    if (hasOffset) {
      const totalResults = await Product.countDocuments(filter);
      return res.status(200).json({
        products,
        totalResults,
        offset: responseOffset,
        limit: responseLimit,
        hasMore: responseOffset + products.length < totalResults,
      });
    }
    
    // If it's a search request, return with search metadata
    if (searchQuery) {
      res.status(200).json({
        products,
        searchQuery,
        totalResults: products.length,
        message: `Found ${products.length} products matching "${searchQuery}"`
      });
    } else {
      res.status(200).json(products);
    }
  } catch (error) {
    console.error('Error in getProducts:', error);
    res.status(500).json({ error: error.message });
  }
};

const getSingleProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await Product.findById(id)
      .populate('regionId', 'name slug')
      .populate('regions', 'name slug')
      .populate('variants.regionId', 'name slug');
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Legacy products (created before shippingIds were persisted): resolve ids
    // from the stored shippingOptions so the edit form can restore selections.
    const needsHeal = product.variants.some(v =>
      (!v.shippingIds || v.shippingIds.length === 0) &&
      Array.isArray(v.shippingOptions) && v.shippingOptions.length > 0
    );
    if (needsHeal) {
      const allShipping = await Shipping.find({});
      product.variants.forEach(v => {
        if ((v.shippingIds && v.shippingIds.length > 0) || !Array.isArray(v.shippingOptions)) return;
        const ids = v.shippingOptions.map(opt => {
          const match = allShipping.find(s =>
            s.name === opt.name &&
            Number(s.charge) === Number(opt.charge) &&
            Number(s.estimatedDays) === Number(opt.estimatedDays)
          ) || allShipping.find(s => s.name === opt.name);
          return match ? match._id : null;
        }).filter(Boolean);
        if (ids.length > 0) v.shippingIds = ids;
      });
      // persist the healed ids so future edits are stable
      product.save().catch(() => {});
    }

    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedProduct = await Product.findByIdAndDelete(id);
    
    // Emit product deletion event
    if (deletedProduct) {
      emitProductUpdate(id, 'product_deleted', {
        productId: id
      });
      revalidateCarts({ productIds: [deletedProduct._id] }).catch(() => {});
    }
    
    res.status(200).json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteVariant = async (req, res) => {
  try {
    const { id: variantId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(variantId)) return res.status(400).json({ message: 'Invalid variant ID' });
    const product = await Product.findOne({ 'variants._id': variantId });
    if (!product) return res.status(404).json({ message: 'Variant not found' });
    product.variants.pull(variantId);
    product.regions = [...new Set(product.variants.map(variant => String(variant.regionId || '')).filter(Boolean))];
    await product.save();
    revalidateCarts({ productIds: [product._id] }).catch(() => {});
    emitProductUpdate(product._id, 'variant_deleted', { variantId });
    return res.status(200).json({ message: 'Variant deleted successfully', product });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};



// ==============================
// Reviews
// ==============================
async function addReview(req, res) {
  try {
    const { id } = req.params; // product id
    const { rating, comment } = req.body;
    const userId = req.user?._id; // from auth middleware

    if (!userId) return res.status(401).json({ message: 'Login required' });
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating 1-5 required' });

    const product = await Product.findById(id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Prevent duplicate review by same user (optional)
    const existing = product.reviews?.find(r => r.user.toString() === userId.toString());
    if (existing) {
      existing.rating = rating;
      existing.comment = comment || existing.comment;
    } else {
      product.reviews.push({ user: userId, rating, comment });
    }

    // Recompute aggregates
    const totalReviews = product.reviews.length;
    const avg = product.reviews.reduce((sum, r) => sum + r.rating, 0) / (totalReviews || 1);
    product.totalReviews = totalReviews;
    product.averageRating = Number(avg.toFixed(2));

    await product.save();
    const populated = await Product.findById(id).populate('reviews.user', 'firstName lastName imageUrl');
    return res.status(200).json({ message: 'Review saved', product: populated });
  } catch (error) {
    console.error('addReview error', error);
    return res.status(500).json({ message: 'Failed to add review' });
  }
}

async function getReviews(req, res) {
  try {
    const { id } = req.params; // product id
    const product = await Product.findById(id).populate('reviews.user', 'firstName lastName imageUrl');
    if (!product) return res.status(404).json({ message: 'Product not found' });
    return res.status(200).json({ reviews: product.reviews, averageRating: product.averageRating, totalReviews: product.totalReviews });
  } catch (error) {
    console.error('getReviews error', error);
    return res.status(500).json({ message: 'Failed to fetch reviews' });
  }
}

async function updateReview(req, res) {
  try {
    const { id, reviewId } = req.params; // product id, review id
    const { rating, comment } = req.body;
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: 'Login required' });
    const product = await Product.findById(id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const review = product.reviews.id(reviewId);
    if (!review) return res.status(404).json({ message: 'Review not found' });
    if (review.user.toString() !== userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to edit this review' });
    }

    if (rating) review.rating = Math.min(5, Math.max(1, rating));
    if (comment !== undefined) review.comment = comment;

    // Recompute aggregates
    const totalReviews = product.reviews.length;
    const avg = product.reviews.reduce((sum, r) => sum + r.rating, 0) / (totalReviews || 1);
    product.totalReviews = totalReviews;
    product.averageRating = Number(avg.toFixed(2));

    await product.save();
    const populated = await Product.findById(id).populate('reviews.user', 'firstName lastName imageUrl');
    return res.status(200).json({ message: 'Review updated', product: populated });
  } catch (error) {
    console.error('updateReview error', error);
    return res.status(500).json({ message: 'Failed to update review' });
  }
}

async function deleteReview(req, res) {
  try {
    const { id, reviewId } = req.params; // product id, review id
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: 'Login required' });
    const product = await Product.findById(id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const review = product.reviews.id(reviewId);
    if (!review) return res.status(404).json({ message: 'Review not found' });
    if (review.user.toString() !== userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this review' });
    }

    review.remove();

    // Recompute aggregates
    const totalReviews = product.reviews.length;
    const avg = totalReviews > 0 ? (product.reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews) : 0;
    product.totalReviews = totalReviews;
    product.averageRating = Number(avg.toFixed(2));

    await product.save();
    const populated = await Product.findById(id).populate('reviews.user', 'firstName lastName imageUrl');
    return res.status(200).json({ message: 'Review deleted', product: populated });
  } catch (error) {
    console.error('deleteReview error', error);
    return res.status(500).json({ message: 'Failed to delete review' });
  }
}

// Update stock for a specific variant and size
async function updateStock(req, res) {
  try {
    const { id, variantId } = req.params;
    const { size, measureType, unitName, quantity, action = 'set' } = req.body;
    const amount = Number(quantity);

    if ((!size && !measureType && !unitName) || !Number.isInteger(amount) || amount < 0) {
      return res.status(400).json({ message: 'A size or measure and a non-negative whole-number quantity are required' });
    }

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const variant = product.variants.id(variantId);
    if (!variant) {
      return res.status(404).json({ message: 'Variant not found' });
    }

    const option = variant.options?.find((candidate) =>
      (!size || String(candidate.size || '').toLowerCase() === String(size).toLowerCase()) &&
      (!measureType || String(candidate.measureType || '').toLowerCase() === String(measureType).toLowerCase()) &&
      (!unitName || String(candidate.unitName || '').toLowerCase() === String(unitName).toLowerCase())
    );
    const sizeIndex = (variant.sizes || []).findIndex((candidate) => String(candidate).toLowerCase() === String(size || '').toLowerCase());
    if (!option && sizeIndex === -1) return res.status(400).json({ message: 'Selected size or measure was not found in variant' });

    const currentStock = Number(option?.stock ?? variant.stockBySize?.[sizeIndex] ?? 0);
    let newStock;

    switch (action) {
      case 'increase':
        newStock = currentStock + amount;
        break;
      case 'decrease':
        newStock = Math.max(0, currentStock - amount);
        break;
      case 'set':
      default:
        newStock = amount;
        break;
    }

    if (option) option.stock = newStock;
    if (sizeIndex >= 0) {
      if (!variant.stockBySize || variant.stockBySize.length !== variant.sizes.length) {
        variant.stockBySize = new Array(variant.sizes.length).fill(0);
      }
      variant.stockBySize[sizeIndex] = newStock;
    }
    if (variant.options?.length) {
      variant.stock = variant.options.reduce((sum, candidate) => sum + Number(candidate.stock || 0), 0);
    } else {
      variant.stock = (variant.stockBySize || []).reduce((sum, stock) => sum + Number(stock || 0), 0);
    }

    // Update legacy stock field (sum of all sizes)
    variant.stock = variant.stockBySize.reduce((sum, stock) => sum + stock, 0);

    await product.save();
    revalidateCarts({ productIds: [product._id] }).catch(() => {});

    // Emit stock update event
    emitProductUpdate(product._id, 'stock_updated', {
      variantId: variant._id,
      size: size || option?.size || '',
      measureType: measureType || option?.measureType || '',
      unitName: unitName || option?.unitName || '',
      newStock,
      totalStock: variant.stock,
      action: action,
      product: product
    });

    return res.status(200).json({
      message: 'Stock updated successfully',
      product: product,
      updatedStock: {
        size: size || option?.size || '',
        measureType: measureType || option?.measureType || '',
        unitName: unitName || option?.unitName || '',
        quantity: newStock,
        totalStock: variant.stock,
        action: action
      }
    });
  } catch (error) {
    console.error('updateStock error', error);
    return res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update stock' });
  }
}

// Get stock information for a product
async function getStock(req, res) {
  try {
    const { id } = req.params;
    const product = await Product.findById(id);
    
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const stockInfo = product.variants.map(variant => ({
      variantId: variant._id,
      colorName: variant.colorName,
      sizes: variant.sizes.map((size, index) => ({
        size: size,
        stock: variant.stockBySize ? variant.stockBySize[index] || 0 : 0
      })),
      totalStock: variant.stockBySize ? variant.stockBySize.reduce((sum, stock) => sum + stock, 0) : 0
    }));

    return res.status(200).json({
      productId: product._id,
      productName: product.name,
      stockInfo: stockInfo
    });
  } catch (error) {
    console.error('getStock error', error);
    return res.status(500).json({ message: 'Failed to get stock information' });
  }
}

// ======================
// Like / Love a product
// ======================
async function toggleLike(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    const { liked } = req.body || {};
    if (!userId) return res.status(401).json({ message: 'Login required' });
    if (typeof liked !== 'boolean') {
      return res.status(400).json({ message: 'A boolean liked value is required' });
    }

    const filter = { _id: id, likedBy: liked ? { $ne: userId } : userId };
    const update = liked
      ? { $addToSet: { likedBy: userId }, $inc: { likesCount: 1 } }
      : { $pull: { likedBy: userId }, $inc: { likesCount: -1 } };
    let product = await Product.findOneAndUpdate(filter, update, { new: true })
      .select('likesCount');

    // A missing match means the requested state was already set. Returning the
    // stored count makes retries and duplicate clicks idempotent.
    if (!product) {
      product = await Product.findById(id).select('likesCount');
      if (!product) return res.status(404).json({ message: 'Product not found' });
    }

    if (ioInstance) {
      ioInstance.to(`product_${id}`).emit('productUpdate', {
        productId: id,
        updateType: 'like',
        likesCount: product.likesCount
      });
    }

    res.json({ liked, likesCount: product.likesCount || 0 });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update like', error: error.message });
  }
}

async function getLikeStatus(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: 'Login required' });

    const product = await Product.findById(id).select('likesCount');
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const liked = await Product.exists({ _id: id, likedBy: userId });
    res.json({ liked: Boolean(liked), likesCount: product.likesCount || 0 });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch like status', error: error.message });
  }
}

// ======================
// Wishlist (Auth Required)
// ======================
async function toggleWishlist(req, res) {
  try {
    const userDoc = await User.findById(req.user.id);
    if (!userDoc) return res.status(404).json({ message: 'User not found' });

    const { productId } = req.body;
    if (!productId) return res.status(400).json({ message: 'Product ID required' });

    const idx = userDoc.wishlist.findIndex(p => p.toString() === productId);
    if (idx > -1) {
      userDoc.wishlist.splice(idx, 1);
      await userDoc.save();
      return res.json({ wishlisted: false, wishlist: userDoc.wishlist });
    }

    userDoc.wishlist.push(productId);
    await userDoc.save();
    res.json({ wishlisted: true, wishlist: userDoc.wishlist });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update wishlist', error: error.message });
  }
}

async function getWishlist(req, res) {
  try {
    const userDoc = await User.findById(req.user.id).populate('wishlist');
    if (!userDoc) return res.status(404).json({ message: 'User not found' });
    res.json(userDoc.wishlist);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get wishlist', error: error.message });
  }
}

// ======================
// Live purchase broadcast
// ======================
async function purchaseBroadcast(req, res) {
  try {
    const { productId, productName } = req.body;
    if (!productId || !productName) return res.status(400).json({ message: 'Product ID and name required' });

    if (ioInstance) {
      ioInstance.emit('livePurchase', {
        productId,
        productName,
        timestamp: new Date()
      });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Failed to broadcast', error: error.message });
  }
}

// ======================
// Generate SKUs for products missing one
// ======================
async function generateSKUs(req, res) {
  try {
    const missing = await Product.find({
      $or: [{ sku: { $exists: false } }, { sku: null }, { sku: '' }, { sku: /^\s*$/ }]
    }).select('_id name');

    if (!missing.length) return res.json({ count: 0 });

    let count = 0;
    for (const product of missing) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const sku = await createProductSku(product.name);
        try {
          const result = await Product.updateOne({
            _id: product._id,
            $or: [{ sku: { $exists: false } }, { sku: null }, { sku: '' }, { sku: /^\s*$/ }],
          }, { $set: { sku } });
          if (result.modifiedCount > 0) count += 1;
          break;
        } catch (error) {
          if (error.code !== 11000 || attempt === 4) throw error;
        }
      }
    }
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ message: 'Failed to generate SKUs', error: error.message });
  }
}

async function generateProductSKU(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }
    const product = await Product.findById(req.params.id).select('name sku');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    if (String(product.sku || '').trim()) {
      return res.json({ success: true, generated: false, sku: product.sku });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const sku = await createProductSku(product.name);
      try {
        const result = await Product.updateOne({
          _id: product._id,
          $or: [{ sku: { $exists: false } }, { sku: null }, { sku: '' }, { sku: /^\s*$/ }],
        }, { $set: { sku } });
        if (result.modifiedCount > 0) {
          return res.json({ success: true, generated: true, sku });
        }
        const current = await Product.findById(product._id).select('sku');
        if (String(current?.sku || '').trim()) {
          return res.json({ success: true, generated: false, sku: current.sku });
        }
      } catch (error) {
        if (error.code !== 11000 || attempt === 4) throw error;
      }
    }
    return res.status(503).json({ success: false, message: 'Could not create a unique SKU. Please try again.' });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to generate SKU' });
  }
}

// Top rated products for the home page (sorted by rating, then review count)
const getTopRatedProducts = async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const products = await Product.find({ averageRating: { $gt: 0 } })
      .sort({ averageRating: -1, totalReviews: -1 })
      .populate('regionId', 'name slug')
      .populate('regions', 'name slug')
      .populate('variants.regionId', 'name slug')
      .limit(limit);
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Set Socket.IO instance
const setSocketIO = (io) => {
  ioInstance = io;
};

module.exports = {
  addProduct,
  generateSKUs,
  generateProductSKU,
  updateProduct,
  deleteProduct,
  getProducts,
  getTopRatedProducts,
  getSingleProduct,
  deleteVariant,
  addReview,
  getReviews,
  updateReview,
  deleteReview,
  updateStock,
  getStock,
  toggleLike,
  getLikeStatus,
  toggleWishlist,
  getWishlist,
  purchaseBroadcast,
  setSocketIO
};
