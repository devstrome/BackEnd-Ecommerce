const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/errorHandler');
const mongoose = require('mongoose');
const escapeRegex = require('../utils/escapeRegex');

// Socket.io instance (set from server.js)
let ioInstance = null;
module.exports.setSocketIO = (io) => {
  ioInstance = io;
};

// Helper function for inventory notifications
function notifyInventoryUpdate(inventory, eventType) {
  if (!ioInstance) return;

  // Emit low stock alert to dashboard
  if (inventory.availableQuantity <= 5) {
    ioInstance.to('dashboardRoom').emit('lowStockAlert', inventory);
  }
}

// Attach variant/color information to an inventory item (shared by list & scan endpoints)
const enrichInventoryItem = (itemObj) => {
  if (itemObj.productId && itemObj.productId.variants) {
    const variantId = itemObj.variantId?._id || itemObj.variantId;
    const variant = itemObj.productId.variants.find(v => v._id.toString() === String(variantId || ''));
    if (variant) {
      const variantRegionId = variant.regionId?._id || variant.regionId || null;
      const storedRegionId = itemObj.regionId?._id || itemObj.regionId || null;
      const regionName = variant.regionId?.name || itemObj.regionId?.name || itemObj.regionName || '';
      itemObj.variantId = {
        _id: variant._id,
        colorName: variant.colorName,
        regionId: variantRegionId || storedRegionId,
        regionName,
        hexCode: variant.hexCode,
        images: variant.images,
        sizes: variant.sizes,
        prices: variant.prices,
        discountPrices: variant.discountPrices,
        stock: variant.stock,
        stockBySize: variant.stockBySize,
        measureType: variant.measureType,
        unitName: variant.unitName
      };
      itemObj.regionId = variantRegionId || storedRegionId;
      itemObj.regionName = regionName;
      // Add color information at the top level for easier access
      itemObj.colorName = variant.colorName;
      itemObj.hexCode = variant.hexCode;
      itemObj.variantImage = variant.images?.[0]?.url || variant.images?.[0];
      // Also include the new fields from the inventory model
      itemObj.imageUri = itemObj.imageUri || variant.images?.[0]?.url || variant.images?.[0];
      itemObj.color = itemObj.color || {
        name: variant.colorName || 'Default',
        hexCode: variant.hexCode || '#000000'
      };
    }
  }
  return itemObj;
};
exports.enrichInventoryItem = enrichInventoryItem;

// Get all inventory items
exports.getAllInventory = catchAsyncErrors(async (req, res, next) => {
  const {
    page = 1, limit = 10, search = '', status = '', productId = '',
    variantId = '', regionId = '', color = '', size = ''
  } = req.query;

  const stringFilters = [search, status, productId, variantId, regionId, color, size];
  if (stringFilters.some((value) => typeof value !== 'string')) {
    return res.status(400).json({ message: 'Inventory filters must be single string values' });
  }
  const pageText = String(page);
  const limitText = String(limit);
  if (!/^\d+$/.test(pageText) || !/^\d+$/.test(limitText)) {
    return res.status(400).json({ message: 'Page and limit must be positive integers' });
  }
  const pageNum = Number(pageText);
  const limitNum = Number(limitText);
  if (!Number.isSafeInteger(pageNum) || pageNum < 1 || pageNum > 10000000 ||
      !Number.isSafeInteger(limitNum) || limitNum < 1) {
    return res.status(400).json({ message: 'Page and limit are outside the supported range' });
  }
  if (productId && !mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'Invalid product ID' });
  }
  if (variantId && !mongoose.Types.ObjectId.isValid(variantId)) {
    return res.status(400).json({ message: 'Invalid variant ID' });
  }
  if (regionId && !mongoose.Types.ObjectId.isValid(regionId)) {
    return res.status(400).json({ message: 'Invalid region ID' });
  }
  if (search.length > 100 || color.length > 100 || size.length > 100) {
    return res.status(400).json({ message: 'Search, color, and size filters must be 100 characters or fewer' });
  }
  
  const query = {};
  const andClauses = [];
  
  if (search) {
    const searchRegex = escapeRegex(String(search).trim().slice(0, 100));
    andClauses.push({
      $or: [
        { barcode: { $regex: searchRegex, $options: 'i' } },
        { realBarcode: { $regex: searchRegex, $options: 'i' } },
        { qrCode: { $regex: searchRegex, $options: 'i' } }
      ]
    });
  }
  
  if (status) {
    query.status = status;
  }
  
  if (productId) {
    query.productId = productId;
  }

  if (variantId) {
    query.variantId = variantId;
  }

  if (regionId) {
    // Older stock rows may not have copied regionId when they were created.
    // Resolve those rows from the owning product variant so filtering remains
    // consistent with the product's current variant → region relationship.
    const productsWithRegion = await Product.find({ 'variants.regionId': regionId }).select('variants');
    const regionVariantIds = [];
    productsWithRegion.forEach((product) => {
      product.variants.forEach((variant) => {
        if (String(variant.regionId?._id || variant.regionId || '') === regionId) {
          regionVariantIds.push(variant._id);
        }
      });
    });
    andClauses.push(regionVariantIds.length
      ? { variantId: { $in: regionVariantIds } }
      : { regionId });
  }

  if (size) {
    query.size = size;
  }

  if (color) {
    const normalizedColor = color.trim();
    const escaped = escapeRegex(normalizedColor);
    const colorRx = { $regex: `^${escaped}$`, $options: 'i' };
    const colorClause = { $or: [{ 'color.name': colorRx }] };
    // Also match items whose stored color is missing but whose variant has this color name
    const productsWithColor = await Product.find({ 'variants.colorName': colorRx }).select('variants');
    const colorVariantIds = [];
    productsWithColor.forEach(p => {
      p.variants.forEach(v => {
        if (v.colorName && v.colorName.toLowerCase() === normalizedColor.toLowerCase()) colorVariantIds.push(v._id);
      });
    });
    if (colorVariantIds.length > 0) colorClause.$or.push({ variantId: { $in: colorVariantIds } });
    andClauses.push(colorClause);
  }

  if (andClauses.length > 0) {
    query.$and = andClauses;
  }
  
  const effectiveLimit = Math.min(limitNum, 100);
  const skip = (pageNum - 1) * effectiveLimit;
  
  const inventory = await Inventory.find(query)
    .populate({ path: 'regionId', select: 'name' })
    .populate({ path: 'productId', select: 'name mainImage mainPrice variants', populate: { path: 'variants.regionId', select: 'name' } })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(effectiveLimit);
  
  // Attach variant information to each inventory item
  const inventoryWithVariants = inventory.map(item => enrichInventoryItem(item.toObject()));
  
  const total = await Inventory.countDocuments(query);
  
  res.status(200).json({
    success: true,
    inventory: inventoryWithVariants,
    pagination: {
      page: pageNum,
      limit: effectiveLimit,
      total,
      totalPages: Math.ceil(total / effectiveLimit)
    }
  });
});

// Get inventory by ID
exports.getInventoryById = catchAsyncErrors(async (req, res, next) => {
  const inventory = await Inventory.findById(req.params.id)
    .populate({ path: 'regionId', select: 'name' })
    .populate({ path: 'productId', select: 'name mainImage mainPrice variants', populate: { path: 'variants.regionId', select: 'name' } });
  
  if (!inventory) {
    return next(new ErrorHandler('Inventory not found', 404));
  }
  
  res.status(200).json({
    success: true,
    inventory: enrichInventoryItem(inventory.toObject())
  });
});

// Create new inventory item
exports.createInventory = catchAsyncErrors(async (req, res, next) => {
  const { productId, variantId, regionId, realBarcode, size, stockQuantity, location, notes, price, discountPrice, costPrice } = req.body;
  
  // Validate product and variant
  const product = await Product.findById(productId).populate('variants.regionId', 'name');
  if (!product) {
    return next(new ErrorHandler('Product not found', 404));
  }
  
  const variant = product.variants.find(v => v._id.toString() === variantId);
  if (!variant) {
    return next(new ErrorHandler('Product variant not found', 404));
  }

  const variantRegionId = variant.regionId?._id || variant.regionId || null;
  if (regionId && String(regionId) !== String(variantRegionId || '')) {
    return next(new ErrorHandler('Selected region does not match the product variant', 400));
  }
  
  // Check if size exists in variant
  if (!variant.sizes.includes(size)) {
    return next(new ErrorHandler('Size not available for this variant', 400));
  }
  
  // Check if inventory already exists for this combination
  const existingInventory = await Inventory.findOne({
    productId,
    variantId,
    size
  });
  
  if (existingInventory) {
    return next(new ErrorHandler('Inventory already exists for this product variant and size', 400));
  }
  
  // Generate unique barcode and QR code
  const barcode = await Inventory.generateBarcode();
  const qrCode = await Inventory.generateQRCode();
  
  // Find the correct price and discount price for this specific size
  let variantPrice = price || product.mainPrice;
  let variantDiscountPrice = discountPrice || null;
  
  // If variant has prices array, find the matching price for this size
  if (variant.prices && variant.prices.length > 0) {
    const sizeIndex = variant.sizes.indexOf(size);
    if (sizeIndex !== -1 && sizeIndex < variant.prices.length) {
      variantPrice = variant.prices[sizeIndex];
    } else {
      variantPrice = variant.prices[0]; // Fallback to first price
    }
  }
  
  // If variant has discountPrices array, find the matching discount price for this size
  if (variant.discountPrices && variant.discountPrices.length > 0) {
    const sizeIndex = variant.sizes.indexOf(size);
    if (sizeIndex !== -1 && sizeIndex < variant.discountPrices.length) {
      variantDiscountPrice = variant.discountPrices[sizeIndex];
    }
  }
  
  const inventory = await Inventory.create({
    productId,
    variantId,
    regionId: variant.regionId?._id || variant.regionId || null,
    regionName: variant.regionId?.name || '',
    size,
    barcode,
    realBarcode: String(realBarcode || '').trim(),
    qrCode,
    stockQuantity: 1, // Each inventory item represents exactly 1 individual item
    availableQuantity: 1,
    assignedQuantity: 0,
    price: variantPrice,
    discountPrice: variantDiscountPrice,
    costPrice: costPrice !== undefined && costPrice !== '' ? Number(costPrice) : (variant.options?.find(option => String(option.size).trim().toLowerCase() === String(size).trim().toLowerCase())?.costPrice ?? variant.costPrice ?? product.costPrice ?? null),
    imageUri: variant.images?.[0]?.url || variant.images?.[0] || null,
    color: {
      name: variant.colorName || 'Default',
      hexCode: variant.hexCode || '#000000'
    },
    location,
    notes
  });
  
  res.status(201).json({
    success: true,
    message: 'Inventory created successfully',
    inventory
  });
});

// Update inventory item
exports.updateInventory = catchAsyncErrors(async (req, res, next) => {
  const { stockQuantity, location, notes, status, price, discountPrice, costPrice, realBarcode } = req.body;
  
  const inventory = await Inventory.findById(req.params.id);
  if (!inventory) {
    return next(new ErrorHandler('Inventory not found', 404));
  }
  
  // Update fields
  if (stockQuantity !== undefined) inventory.stockQuantity = stockQuantity;
  if (location) inventory.location = location;
  if (notes !== undefined) inventory.notes = notes;
  if (status) inventory.status = status;
  if (price !== undefined) inventory.price = price;
  if (discountPrice !== undefined) inventory.discountPrice = discountPrice;
  if (costPrice !== undefined) inventory.costPrice = costPrice === null || costPrice === '' ? null : Number(costPrice);
  if (realBarcode !== undefined) inventory.realBarcode = String(realBarcode || '').trim();
  
  await inventory.save();
  
  res.status(200).json({
    success: true,
    message: 'Inventory updated successfully',
    inventory
  });
});

// Delete inventory item
exports.deleteInventory = catchAsyncErrors(async (req, res, next) => {
  const inventory = await Inventory.findById(req.params.id);
  if (!inventory) {
    return next(new ErrorHandler('Inventory not found', 404));
  }

  if (inventory.assignedQuantity > 0) {
    return next(new ErrorHandler('Assigned inventory cannot be deleted. Release it from its order first.', 409));
  }
  
  await Inventory.findByIdAndDelete(req.params.id);
  
  res.status(200).json({
    success: true,
    message: 'Inventory deleted successfully'
  });
});

// Delete a selection in one request so large selections do not overwhelm the API.
exports.deleteInventoryBulk = catchAsyncErrors(async (req, res, next) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
    return next(new ErrorHandler('Provide between 1 and 500 inventory IDs', 400));
  }

  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    return next(new ErrorHandler('One or more inventory IDs are invalid', 400));
  }

  const result = await Inventory.deleteMany({
    _id: { $in: uniqueIds },
    $or: [
      { assignedQuantity: { $lte: 0 } },
      { assignedQuantity: { $exists: false } },
    ],
  });
  const remaining = await Inventory.countDocuments({
    _id: { $in: uniqueIds },
    assignedQuantity: { $gt: 0 },
  });

  return res.status(200).json({
    success: true,
    deletedCount: result.deletedCount || 0,
    skippedCount: remaining,
    message: remaining
      ? `Deleted ${result.deletedCount || 0} item(s); ${remaining} assigned item(s) were kept.`
      : `Deleted ${result.deletedCount || 0} inventory item(s) successfully.`,
  });
});

// Scan barcode/QR code
const PROJ = 'name mainImage mainPrice variants sku';

// Resolve a scanned/typed code: generated barcode → product barcode → QR → product SKU.
const findInventoryByCode = async (code) => {
  const c = String(code).trim();
  let inventory = await Inventory.findOne({ $or: [{ barcode: c }, { qrCode: c }] })
    .populate({ path: 'regionId', select: 'name' })
    .populate({ path: 'productId', select: PROJ, populate: { path: 'variants.regionId', select: 'name' } });

  if (!inventory) {
    inventory = await Inventory.findOne({ realBarcode: c, availableQuantity: { $gt: 0 }, status: 'active' })
      .sort({ createdAt: 1 })
      .populate({ path: 'regionId', select: 'name' })
      .populate({ path: 'productId', select: PROJ, populate: { path: 'variants.regionId', select: 'name' } });
  }

  if (!inventory) {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const product = await Product.findOne({ sku: { $regex: `^${escaped}$`, $options: 'i' } }).select('_id');
    if (product) {
      inventory = await Inventory.findOne({ productId: product._id, availableQuantity: { $gt: 0 } })
        .populate({ path: 'regionId', select: 'name' })
        .populate({ path: 'productId', select: PROJ, populate: { path: 'variants.regionId', select: 'name' } });
    }
  }
  return inventory;
};

exports.scanCode = catchAsyncErrors(async (req, res, next) => {
  const { code } = req.body;
  
  const inventory = await findInventoryByCode(code);
  
  if (!inventory) {
    return next(new ErrorHandler('Code not found', 404));
  }
  
  res.status(200).json({
    success: true,
    inventory: enrichInventoryItem(inventory.toObject())
  });
});

// Scan barcode/QR code via GET request (for frontend scanning)
exports.scanInventoryByCode = catchAsyncErrors(async (req, res, next) => {
  const { code } = req.query;
  
  if (!code) {
    return next(new ErrorHandler('Code parameter is required', 400));
  }
  
  const inventory = await findInventoryByCode(code);
  
  if (!inventory) {
    return next(new ErrorHandler('Inventory item not found', 404));
  }
  
  res.status(200).json({
    success: true,
    inventory: enrichInventoryItem(inventory.toObject())
  });
});

// Get inventory statistics
exports.getInventoryStats = catchAsyncErrors(async (req, res, next) => {
  const totalItems = await Inventory.countDocuments();
  const activeItems = await Inventory.countDocuments({ status: 'active' });
  const outOfStockItems = await Inventory.countDocuments({ status: 'out_of_stock' });
  
  // Calculate total available stock (sum of availableQuantity)
  const totalAvailable = await Inventory.aggregate([
    { $group: { _id: null, total: { $sum: '$availableQuantity' } } }
  ]);
  
  res.status(200).json({
    success: true,
    stats: {
      totalItems,
      activeItems,
      outOfStockItems,
      totalAvailable: totalAvailable[0]?.total || 0
    }
  });
});

// Bulk create inventory from product variants
exports.bulkCreateFromProduct = catchAsyncErrors(async (req, res, next) => {
  const { productId, stockQuantities, realBarcodes = {} } = req.body;
  
  const product = await Product.findById(productId).populate('variants.regionId', 'name');
  if (!product) {
    return next(new ErrorHandler('Product not found', 404));
  }
  
  const createdInventory = [];
  
  for (const variant of product.variants) {
    for (const size of variant.sizes) {
      const quantity = stockQuantities[variant._id]?.[size] || 0;
      
      if (quantity > 0) {
        // Check if inventory already exists
        const existing = await Inventory.findOne({
          productId,
          variantId: variant._id,
          size
        });
        
        if (!existing) {
          const barcode = await Inventory.generateBarcode();
          const qrCode = await Inventory.generateQRCode();
          
                  const inventory = await Inventory.create({
          productId,
          variantId: variant._id,
          regionId: variant.regionId?._id || variant.regionId || null,
          regionName: variant.regionId?.name || '',
          size,
          barcode,
          realBarcode: String(realBarcodes?.[variant._id]?.[size] || '').trim(),
          qrCode,
          stockQuantity: 1,
          availableQuantity: 1,
          assignedQuantity: 0,
          price: variant.prices?.[0] || product.mainPrice,
          costPrice: variant.costPrice ?? product.costPrice ?? null,
          imageUri: variant.images?.[0]?.url || variant.images?.[0] || null,
          color: {
            name: variant.colorName || 'Default',
            hexCode: variant.hexCode || '#000000'
          }
        });
          
          createdInventory.push(inventory);
        }
      }
    }
  }
  
  res.status(201).json({
    success: true,
    message: `${createdInventory.length} inventory items created successfully`,
    createdInventory
  });
});

// Bulk create inventory items
exports.bulkCreate = catchAsyncErrors(async (req, res, next) => {
  const { inventoryItems } = req.body;
  
  if (!Array.isArray(inventoryItems) || inventoryItems.length === 0) {
    return next(new ErrorHandler('Invalid inventory items data', 400));
  }
  
  const createdInventory = [];
  const errors = [];
  
  for (const item of inventoryItems) {
    try {
      const { productId, variantId, regionId, realBarcode, size, stockQuantity, location, notes, price, discountPrice, costPrice } = item;
      
      // Validate product and variant
      const product = await Product.findById(productId).populate('variants.regionId', 'name');
      if (!product) {
        errors.push(`Product not found for item: ${productId}`);
        continue;
      }
      
      const variant = product.variants.find(v => v._id.toString() === variantId);
      if (!variant) {
        errors.push(`Variant not found for product: ${productId}, variant: ${variantId}`);
        continue;
      }

      const variantRegionId = variant.regionId?._id || variant.regionId || null;
      if (regionId && String(regionId) !== String(variantRegionId || '')) {
        errors.push(`Selected region does not match variant: ${variantId}`);
        continue;
      }
      
      // Check if size exists in variant
      if (!variant.sizes.includes(size)) {
        errors.push(`Size ${size} not available for variant: ${variantId}`);
        continue;
      }
      
      // Check if inventory already exists for this combination
      const existingInventory = await Inventory.findOne({
        productId,
        variantId,
        size
      });
      
      if (existingInventory) {
        errors.push(`Inventory already exists for product: ${productId}, variant: ${variantId}, size: ${size}`);
        continue;
      }
      
      // Create individual inventory items for each unit
      const quantity = stockQuantity || 0;
      for (let i = 0; i < quantity; i++) {
        // Generate unique barcode and QR code for each item
        const barcode = await Inventory.generateBarcode();
        const qrCode = await Inventory.generateQRCode();
        
        // Find the correct price and discount price for this specific size
        let variantPrice = price || product.mainPrice;
        let variantDiscountPrice = discountPrice || null;
        
        // If variant has prices array, find the matching price for this size
        if (variant.prices && variant.prices.length > 0) {
          const sizeIndex = variant.sizes.indexOf(size);
          if (sizeIndex !== -1 && sizeIndex < variant.prices.length) {
            variantPrice = variant.prices[sizeIndex];
          } else {
            variantPrice = variant.prices[0]; // Fallback to first price
          }
        }
        
        // If variant has discountPrices array, find the matching discount price for this size
        if (variant.discountPrices && variant.discountPrices.length > 0) {
          const sizeIndex = variant.sizes.indexOf(size);
          if (sizeIndex !== -1 && sizeIndex < variant.discountPrices.length) {
            variantDiscountPrice = variant.discountPrices[sizeIndex];
          }
        }
        
        const inventory = await Inventory.create({
          productId,
          variantId,
          regionId: variant.regionId?._id || variant.regionId || null,
          regionName: variant.regionId?.name || '',
          size,
          barcode,
          realBarcode: String(realBarcode || '').trim(),
          qrCode,
          stockQuantity: 1, // Each item represents 1 unit
          price: variantPrice,
          discountPrice: variantDiscountPrice,
          costPrice: costPrice !== undefined && costPrice !== '' ? Number(costPrice) : (variant.options?.find(option => String(option.size).trim().toLowerCase() === String(size).trim().toLowerCase())?.costPrice ?? variant.costPrice ?? product.costPrice ?? null),
          imageUri: variant.images?.[0]?.url || variant.images?.[0] || null,
          color: {
            name: variant.colorName || 'Default',
            hexCode: variant.hexCode || '#000000'
          },
          location: location || {
            warehouse: 'Main Warehouse',
            shelf: '',
            section: ''
          },
          notes: notes || ''
        });
        
        createdInventory.push(inventory);
      }
    } catch (error) {
      errors.push(`Error creating inventory item: ${error.message}`);
    }
  }
  
  res.status(201).json({
    success: true,
    message: `${createdInventory.length} individual inventory items created successfully`,
    createdInventory,
    errors: errors.length > 0 ? errors : undefined
  });
});

// Generate barcode/QR code for printing
exports.generatePrintCodes = catchAsyncErrors(async (req, res, next) => {
  const { inventoryIds, quantities } = req.body;
  
  const inventory = await Inventory.find({
    _id: { $in: inventoryIds }
  }).populate({ path: 'productId', select: 'name mainPrice variants', populate: { path: 'variants.regionId', select: 'name' } });
  
  if (inventory.length === 0) {
    return next(new ErrorHandler('No inventory items found', 404));
  }
  
  const printData = inventory.map(item => {
    const quantity = quantities?.[item._id] || 1; // Default to 1 since each item is individual
    const codes = [];
    
    // Get variant information
    let variantInfo = null;
    if (item.productId && item.productId.variants) {
      const variant = item.productId.variants.find(v => v._id.toString() === item.variantId.toString());
      if (variant) {
        variantInfo = {
          colorName: variant.colorName,
          hexCode: variant.hexCode,
          images: variant.images,
          sizes: variant.sizes,
          prices: variant.prices,
          measureType: variant.measureType,
          unitName: variant.unitName,
          regionId: variant.regionId?._id || variant.regionId || null,
          regionName: variant.regionId?.name || item.regionName || ''
        };
      }
    }
    
    // Generate codes for this individual item
    for (let i = 0; i < quantity; i++) {
      codes.push({
        id: item._id,
        barcode: item.barcode,
        realBarcode: item.realBarcode || '',
        qrCode: item.qrCode,
        productName: item.productId.name,
        price: item.discountPrice || item.price || item.productId.mainPrice,
        size: item.size,
        regionId: variantInfo?.regionId || item.regionId || null,
        regionName: variantInfo?.regionName || item.regionName || '',
        measureType: variantInfo?.measureType,
        unitName: variantInfo?.unitName,
        stockQuantity: item.stockQuantity,
        variantInfo: variantInfo,
        colorName: variantInfo?.colorName || 'Unknown',
        hexCode: variantInfo?.hexCode || '#000000',
        variantImage: variantInfo?.images?.[0]?.url || null
      });
    }
    
    return {
      item,
      codes,
      totalCodes: quantity
    };
  });
  
  res.status(200).json({
    success: true,
    printData,
    totalCodes: printData.reduce((sum, item) => sum + item.totalCodes, 0)
  });
});

// Restock inventory items (reset assigned to 0, make active)
exports.restockInventory = catchAsyncErrors(async (req, res, next) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return next(new ErrorHandler('Please provide items array with {id, quantity}', 400));
  }

  const results = [];

  for (const { id, quantity } of items) {
    if (!id || !quantity || quantity <= 0) {
      results.push({ id, status: 'skipped', reason: 'Invalid id or quantity' });
      continue;
    }

    const inventory = await Inventory.findById(id);
    if (!inventory) {
      results.push({ id, status: 'failed', reason: 'Inventory item not found' });
      continue;
    }

    inventory.assignedQuantity = 0;
    inventory.stockQuantity = quantity;
    await inventory.save();

    results.push({
      id,
      status: 'success',
      stockQuantity: inventory.stockQuantity,
      availableQuantity: inventory.availableQuantity,
      assignedQuantity: inventory.assignedQuantity,
      status: inventory.status
    });
  }

  res.status(200).json({
    success: true,
    message: `Restocked ${results.filter(r => r.status === 'success').length} items`,
    results
  });
});

// Get multiple inventory items by IDs (for batch viewing)
exports.getInventoryBatch = catchAsyncErrors(async (req, res, next) => {
  const { ids } = req.query;
  
  if (!ids) {
    return next(new ErrorHandler('Inventory IDs are required', 400));
  }

  const inventoryIds = ids.split(',').map(id => id.trim()).filter(Boolean);
  
  if (inventoryIds.length === 0) {
    return next(new ErrorHandler('No valid inventory IDs provided', 400));
  }

  // Validate that all IDs are valid ObjectIds
  const validIds = inventoryIds.filter(id => mongoose.Types.ObjectId.isValid(id));
  
  if (validIds.length !== inventoryIds.length) {
    return next(new ErrorHandler('Some inventory IDs are invalid', 400));
  }

  const inventory = await Inventory.find({
    _id: { $in: validIds }
  })
    .populate({ path: 'regionId', select: 'name' })
    .populate({ path: 'productId', select: 'name mainImage mainPrice variants', populate: { path: 'variants.regionId', select: 'name' } });

  if (inventory.length === 0) {
    return next(new ErrorHandler('No inventory items found', 404));
  }

  res.status(200).json({
    success: true,
    inventory: inventory.length === 1
      ? enrichInventoryItem(inventory[0].toObject())
      : inventory.map(item => enrichInventoryItem(item.toObject()))
  });
});
