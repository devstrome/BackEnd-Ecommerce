const Product = require('../models/Product');
const User = require('../models/User');
const cloudinary = require('../config/coudinaryconfig');
const mongoose = require('mongoose');
const Shipping = require('../models/Shipping');
const seoService = require('../utils/seoService');
const { revalidateCarts } = require('./CartController');
const { emitStoreEvent } = require('../utils/storeEvents');

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

    const variants = typeof req.body.variants === 'string'
      ? JSON.parse(req.body.variants)
      : req.body.variants;

    const newProduct = new Product({
      name: req.body.name,
      categories: normalizeCategories(req.body.categories),
      brand: req.body.brand,
      broadcast: req.body.broadcast === 'true' || req.body.broadcast === true,
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
        let stockBySize = [];
        if (Array.isArray(variant.stockBySize)) {
          stockBySize = variant.stockBySize;
        } else if (Array.isArray(variant.stock)) {
          stockBySize = variant.stock;
        } else if (typeof variant.stock === 'number') {
          // If stock is a single number, distribute it across all sizes
          stockBySize = new Array(variant.sizes.length).fill(variant.stock);
        } else {
          // Default to 0 for each size
          stockBySize = new Array(variant.sizes.length).fill(0);
        }

        // Ensure stockBySize array matches the sizes array length
        while (stockBySize.length < variant.sizes.length) {
          stockBySize.push(0);
        }
        stockBySize = stockBySize.slice(0, variant.sizes.length);

        // Calculate total stock for backward compatibility
        const totalStock = stockBySize.reduce((sum, stock) => sum + stock, 0);

        return ({
          ...variant,
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
    
    res.status(201).json(newProduct);
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    const variants = typeof req.body.variants === 'string'
      ? JSON.parse(req.body.variants)
      : req.body.variants;

    product.name = req.body.name || product.name;
    if (req.body.categories !== undefined) product.categories = normalizeCategories(req.body.categories);
    product.brand = req.body.brand || product.brand;
    if (req.body.broadcast !== undefined) product.broadcast = req.body.broadcast === 'true' || req.body.broadcast === true;
    product.mainPrice = req.body.mainPrice || product.mainPrice;
    product.discountPrice = req.body.discountPrice || product.discountPrice;
    product.mainBadgeName = req.body.mainBadgeName || product.mainBadgeName;
    product.mainBadgeColor = req.body.mainBadgeColor || product.mainBadgeColor;
    product.gender = req.body.gender || product.gender;
    product.mainImage = mainImageUrl;
    product.measureType = req.body.measureType || product.measureType; // Update measureType
    product.unitName = req.body.unitName || product.unitName;          // Update unitName

    product.variants = await Promise.all(variants.map(async (variant, index) => {
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
      let stockBySize = [];
      if (Array.isArray(variant.stockBySize)) {
        stockBySize = variant.stockBySize;
      } else if (Array.isArray(variant.stock)) {
        stockBySize = variant.stock;
      } else if (typeof variant.stock === 'number') {
        // If stock is a single number, distribute it across all sizes
        stockBySize = new Array(variant.sizes.length).fill(variant.stock);
      } else {
        // Default to 0 for each size
        stockBySize = new Array(variant.sizes.length).fill(0);
      }

      // Ensure stockBySize array matches the sizes array length
      while (stockBySize.length < variant.sizes.length) {
        stockBySize.push(0);
      }
      stockBySize = stockBySize.slice(0, variant.sizes.length);

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

    // Price may have changed — re-price + re-validate open carts holding this
    // product, then nudge all clients to re-read catalog data.
    revalidateCarts({ productIds: [product._id] }).catch(() => {});
    emitStoreEvent('product_updated', { productId: product._id, brand: product.brand });

    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getProducts = async (req, res) => {
  try {
    const { q: searchQuery, category, brand, gender, minPrice, maxPrice, limit = 50 } = req.query;
    
    // Build search filter
    let filter = {};
    
    // Text search across multiple fields
    if (searchQuery) {
      filter.$or = [
        { name: { $regex: searchQuery, $options: 'i' } },
        { brand: { $regex: searchQuery, $options: 'i' } },
        { categories: { $regex: searchQuery, $options: 'i' } },
        { description: { $regex: searchQuery, $options: 'i' } }
      ];
    }
    
    // Category filter
    if (category) {
      filter.categories = { $regex: category, $options: 'i' };
    }
    
    // Brand filter
    if (brand) {
      filter.brand = { $regex: brand, $options: 'i' };
    }
    
    // Gender filter
    if (gender) {
      filter.gender = gender;
    }
    
    // Price range filter
    if (minPrice || maxPrice) {
      filter.mainPrice = {};
      if (minPrice) filter.mainPrice.$gte = parseFloat(minPrice);
      if (maxPrice) filter.mainPrice.$lte = parseFloat(maxPrice);
    }
    
    // Execute query with population
    const products = await Product.find(filter)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });
    
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
    const product = await Product.findById(id);
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
    }
    
    res.status(200).json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteVariant = async (req, res) => {
  try {
    const { id } = req.params;
    // Assuming you want to delete a variant by id inside a product
    // You might want to implement logic to find product and remove variant from variants array
    // This example assumes Product.variant is a separate model, which might not be true.
    await Product.variant.findByIdAndDelete(id);
    res.status(200).json({ message: 'Variant deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    const populated = await Product.findById(id).populate('reviews.user', 'firstName lastName email');
    return res.status(200).json({ message: 'Review saved', product: populated });
  } catch (error) {
    console.error('addReview error', error);
    return res.status(500).json({ message: 'Failed to add review' });
  }
}

async function getReviews(req, res) {
  try {
    const { id } = req.params; // product id
    const product = await Product.findById(id).populate('reviews.user', 'firstName lastName email');
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
    const populated = await Product.findById(id).populate('reviews.user', 'firstName lastName email');
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
    const populated = await Product.findById(id).populate('reviews.user', 'firstName lastName email');
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
    const { size, quantity, action = 'set' } = req.body; // action can be 'set', 'increase', 'decrease'

    if (!size || quantity === undefined) {
      return res.status(400).json({ message: 'Size and quantity are required' });
    }

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const variant = product.variants.id(variantId);
    if (!variant) {
      return res.status(404).json({ message: 'Variant not found' });
    }

    const sizeIndex = variant.sizes.indexOf(size);
    if (sizeIndex === -1) {
      return res.status(400).json({ message: 'Size not found in variant' });
    }

    // Initialize stockBySize if it doesn't exist
    if (!variant.stockBySize) {
      variant.stockBySize = new Array(variant.sizes.length).fill(0);
    }

    // Update stock for the specific size based on action
    const currentStock = variant.stockBySize[sizeIndex] || 0;
    let newStock;

    switch (action) {
      case 'increase':
        newStock = currentStock + quantity;
        break;
      case 'decrease':
        newStock = Math.max(0, currentStock - quantity);
        break;
      case 'set':
      default:
        newStock = Math.max(0, quantity);
        break;
    }

    variant.stockBySize[sizeIndex] = newStock;

    // Update legacy stock field (sum of all sizes)
    variant.stock = variant.stockBySize.reduce((sum, stock) => sum + stock, 0);

    await product.save();

    // Emit stock update event
    emitProductUpdate(product._id, 'stock_updated', {
      variantId: variant._id,
      size: size,
      newStock: variant.stockBySize[sizeIndex],
      totalStock: variant.stock,
      action: action,
      product: product
    });

    return res.status(200).json({
      message: 'Stock updated successfully',
      product: product,
      updatedStock: {
        size: size,
        quantity: variant.stockBySize[sizeIndex],
        totalStock: variant.stock,
        action: action
      }
    });
  } catch (error) {
    console.error('updateStock error', error);
    return res.status(500).json({ message: 'Failed to update stock' });
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
    const product = await Product.findById(id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    product.likesCount = (product.likesCount || 0) + 1;
    await product.save();

    if (ioInstance) {
      ioInstance.to(`product_${id}`).emit('productUpdate', {
        productId: id,
        updateType: 'like',
        likesCount: product.likesCount
      });
    }

    res.json({ likesCount: product.likesCount });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update like', error: error.message });
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
      $or: [{ sku: { $exists: false } }, { sku: null }, { sku: '' }]
    }).select('name');

    if (!missing.length) return res.json({ count: 0 });

    const existing = new Set(
      (await Product.find({ sku: { $exists: true, $nin: [null, ''] } }).select('sku'))
        .map((p) => p.sku)
    );

    let count = 0;
    for (const product of missing) {
      const base = (product.name || 'PRD').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'PRD';
      let sku = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        const suffix = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
        const candidate = `${base}-${suffix}`;
        if (!existing.has(candidate)) { sku = candidate; break; }
      }
      if (!sku) continue;
      existing.add(sku);
      await Product.updateOne({ _id: product._id }, { $set: { sku } });
      count++;
    }
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: 'Failed to generate SKUs', error: error.message });
  }
}

// Top rated products for the home page (sorted by rating, then review count)
const getTopRatedProducts = async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const products = await Product.find({ averageRating: { $gt: 0 } })
      .sort({ averageRating: -1, totalReviews: -1 })
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
  toggleWishlist,
  getWishlist,
  purchaseBroadcast,
  setSocketIO
};
