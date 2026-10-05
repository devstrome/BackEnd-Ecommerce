const POSOrder = require('../models/POSOrder');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/errorHandler');
const { sendPOSReceipt } = require('../utils/emailService');
const { enrichInventoryItem } = require('./InventoryController');

// Generate unique POS order number
async function generatePOSOrderNumber() {
  const MAX_ATTEMPTS = 10;
  let orderNumber;
  let exists = true;
  let attempts = 0;

  while (exists && attempts < MAX_ATTEMPTS) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    
    orderNumber = `POS${year}${month}${day}${random}`;
    exists = await POSOrder.exists({ orderNumber });
    attempts++;
  }

  if (exists) {
    throw new Error(`Could not generate unique POS order number after ${MAX_ATTEMPTS} attempts`);
  }
  return orderNumber;
}

// Create new POS order
exports.createPOSOrder = catchAsyncErrors(async (req, res, next) => {
  const {
    customer,
    items,
    subtotal,
    tax,
    discount,
    total,
    paymentMethod,
    outlet,
    notes
  } = req.body;

  // Validate items and check inventory
  if (!Array.isArray(items) || items.length === 0) {
    return next(new ErrorHandler('Order must contain at least one item', 400));
  }

  const seenInventoryIds = new Set();
  const normalizedItems = [];

  for (const item of items) {
    const qty = Math.max(1, Number(item.quantity) || 1);

    if (seenInventoryIds.has(String(item.inventoryId))) {
      return next(new ErrorHandler('Duplicate inventory item in cart: same unit scanned twice', 400));
    }
    seenInventoryIds.add(String(item.inventoryId));

    const inventory = await Inventory.findById(item.inventoryId);
    if (!inventory) {
      return next(new ErrorHandler(`Inventory item not found: ${item.inventoryId}`, 404));
    }

    if (inventory.availableQuantity < qty) {
      return next(new ErrorHandler(`Insufficient stock for ${inventory.barcode}`, 400));
    }

    normalizedItems.push({
      inventoryId: item.inventoryId,
      productId: item.productId,
      productName: item.productName,
      variantInfo: {
        size: item.variantInfo?.size ?? item.size,
        color: item.variantInfo?.color ?? item.color,
        barcode: item.variantInfo?.barcode ?? item.barcode,
        measureType: item.measureType ?? item.variantInfo?.measureType,
        unitName: item.unitName ?? item.variantInfo?.unitName
      },
      quantity: qty,
      unitPrice: item.unitPrice,
      discountPrice: item.discountPrice,
      totalPrice: item.totalPrice,
      scannedBarcode: item.scannedBarcode
    });
  }

  // Generate unique order number
  const orderNumber = await generatePOSOrderNumber();

  const posOrder = await POSOrder.create({
    orderNumber,
    customer,
    items: normalizedItems,
    subtotal,
    tax,
    discount,
    total,
    paymentMethod,
    paymentStatus: 'completed', // Auto-confirm payment
    orderStatus: 'completed', // Auto-confirm order
    cashier: req.admin.id,
    outlet,
    notes
  });

  // Update inventory — quantity-aware (pipeline update survives findByIdAndUpdate
  // bypassing the schema pre-save hook; status mirrors the same rule as the hook)
  for (const item of normalizedItems) {
    await Inventory.findByIdAndUpdate(item.inventoryId, [
      {
        $set: {
          assignedQuantity: item.quantity,
          availableQuantity: { $max: [0, { $subtract: ['$stockQuantity', item.quantity] }] },
          status: {
            $cond: [{ $lte: [{ $subtract: ['$stockQuantity', item.quantity] }, 0] }, 'out_of_stock', 'active']
          },
          lastUpdated: new Date()
        }
      }
    ]);
  }

  // Broadcast live purchase via socket
  try {
    const io = req.app.get('socketio');
    if (io) {
      for (const item of items) {
        const prod = await Product.findById(item.productId).select('name');
        if (prod) {
          io.emit('livePurchase', {
            productId: item.productId,
            productName: prod.name || item.productName,
            quantity: item.quantity,
            timestamp: new Date()
          });
        }
      }
    }
  } catch (e) {
    console.error('Failed to broadcast purchase:', e.message);
  }

  // Send receipt email (non-blocking)
  if (posOrder.customer?.email) {
    sendPOSReceipt(posOrder).catch(err => {
      console.error('Failed to send POS receipt email:', err.message);
    });
  }

  res.status(201).json({
    success: true,
    posOrder
  });
});

// Get all POS orders
exports.getAllPOSOrders = catchAsyncErrors(async (req, res, next) => {
  const { page = 1, limit = 10, status, outlet, dateFrom, dateTo, search } = req.query;
  
  const query = {};
  
  if (status) query.orderStatus = status;
  if (outlet) query.outlet = outlet;
  if (search) {
    const rx = { $regex: String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    query.$or = [
      { orderNumber: rx },
      { 'customer.name': rx },
      { 'customer.phone': rx }
    ];
  }
  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }

  const posOrders = await POSOrder.find(query)
    .populate('cashier', 'firstName lastName')
    .populate('items.inventoryId', 'barcode qrCode availableQuantity')
    .populate('items.productId', 'name images')
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const total = await POSOrder.countDocuments(query);

  res.status(200).json({
    success: true,
    posOrders,
    totalPages: Math.ceil(total / limit),
    currentPage: page,
    total
  });
});

// Get single POS order
exports.getPOSOrder = catchAsyncErrors(async (req, res, next) => {
  const posOrder = await POSOrder.findById(req.params.id)
    .populate('cashier', 'firstName lastName')
    .populate('items.inventoryId', 'barcode qrCode availableQuantity')
    .populate('items.productId', 'name images');

  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  res.status(200).json({
    success: true,
    posOrder
  });
});

// Update POS order status
exports.updatePOSOrderStatus = catchAsyncErrors(async (req, res, next) => {
  const { orderStatus, paymentStatus } = req.body;

  const posOrder = await POSOrder.findById(req.params.id);
  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  posOrder.orderStatus = orderStatus || posOrder.orderStatus;
  posOrder.paymentStatus = paymentStatus || posOrder.paymentStatus;
  
  await posOrder.save();

  res.status(200).json({
    success: true,
    posOrder
  });
});

// Scan barcode and get product info (barcode → qrCode → product SKU)
exports.scanBarcode = catchAsyncErrors(async (req, res, next) => {
  const { barcode } = req.body;
  if (!barcode) {
    return next(new ErrorHandler('Barcode is required', 400));
  }

  const code = String(barcode).trim();
  const PROJ = 'name mainImage mainPrice variants sku';
  let inventory = await Inventory.findOne({ barcode: code })
    .populate('productId', PROJ);

  if (!inventory) {
    inventory = await Inventory.findOne({ qrCode: code })
      .populate('productId', PROJ);
  }

  if (!inventory) {
    // Product-level SKU: sell first available unit of that product
    const product = await Product.findOne({ sku: { $regex: `^${code}$`, $options: 'i' } }).select('_id');
    if (product) {
      inventory = await Inventory.findOne({ productId: product._id, availableQuantity: { $gt: 0 } })
        .populate('productId', PROJ);
    }
  }

  if (!inventory) {
    return next(new ErrorHandler('Product not found with this barcode', 404));
  }

  if (inventory.availableQuantity <= 0) {
    return next(new ErrorHandler('Product is out of stock', 400));
  }

  res.status(200).json({
    success: true,
    inventory: enrichInventoryItem(inventory.toObject())
  });
});

// Search products by name, SKU, barcode or qr code
exports.searchProducts = catchAsyncErrors(async (req, res, next) => {
  const { query } = req.query;
  if (!query) {
    return res.status(200).json({ success: true, inventory: [] });
  }

  const rx = { $regex: String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

  // Product name / SKU matches → their available inventory units
  const products = await Product.find({ $or: [{ name: rx }, { sku: rx }] }).select('_id').limit(50);

  const inventory = await Inventory.find({
    $or: [
      { barcode: rx },
      { qrCode: rx },
      ...(products.length ? [{ productId: { $in: products.map(p => p._id) } }] : [])
    ]
  })
  .populate('productId', 'name mainImage mainPrice variants sku')
  .limit(10);

  res.status(200).json({
    success: true,
    inventory: inventory.map(item => enrichInventoryItem(item.toObject()))
  });
});

// Get POS dashboard stats
exports.getPOSStats = catchAsyncErrors(async (req, res, next) => {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  const todayOrders = await POSOrder.find({
    createdAt: { $gte: startOfDay, $lt: endOfDay }
  });

  const totalSales = todayOrders.reduce((sum, order) => sum + order.total, 0);
  const totalOrders = todayOrders.length;
  const completedOrders = todayOrders.filter(order => order.orderStatus === 'completed').length;

  // Get low stock items (items with availableQuantity <= 0)
  const lowStockItems = await Inventory.find({
    availableQuantity: { $lte: 0 }
  })
  .populate('productId', 'name')
  .limit(5);

  res.status(200).json({
    success: true,
    stats: {
      todaySales: totalSales,
      todayOrders: totalOrders,
      completedOrders,
      lowStockItems
    }
  });
});

// Get recent POS orders
exports.getRecentPOSOrders = catchAsyncErrors(async (req, res, next) => {
  const recentOrders = await POSOrder.find()
    .populate('cashier', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(10);

  res.status(200).json({
    success: true,
    recentOrders
  });
});

// Print receipt
exports.printReceipt = catchAsyncErrors(async (req, res, next) => {
  const posOrder = await POSOrder.findById(req.params.id)
    .populate('cashier', 'firstName lastName')
    .populate('items.productId', 'name')
    .populate('items.inventoryId', 'barcode');

  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  const receipt = {
    orderNumber: posOrder.orderNumber,
    date: posOrder.createdAt,
    cashier: posOrder.cashier,
    customer: posOrder.customer,
    items: posOrder.items,
    subtotal: posOrder.subtotal,
    tax: posOrder.tax,
    discount: posOrder.discount,
    total: posOrder.total,
    paymentMethod: posOrder.paymentMethod
  };

  res.status(200).json({
    success: true,
    receipt
  });
});

// Refund POS order
exports.refundPOSOrder = catchAsyncErrors(async (req, res, next) => {
  const { refundAmount, reason } = req.body;

  const posOrder = await POSOrder.findById(req.params.id);
  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  if (posOrder.orderStatus === 'refunded') {
    return next(new ErrorHandler('Order already refunded', 400));
  }

  posOrder.orderStatus = 'refunded';
  posOrder.paymentStatus = 'refunded';
  posOrder.notes = `${posOrder.notes || ''}\nRefund: ${refundAmount} - ${reason}`;

  // Restore inventory items to active status (return assigned stock to available)
  for (const item of posOrder.items) {
    await Inventory.findByIdAndUpdate(item.inventoryId, [
      {
        $set: {
          assignedQuantity: 0,
          availableQuantity: '$stockQuantity',
          status: 'active',
          lastUpdated: new Date()
        }
      }
    ]);
  }

  await posOrder.save();

  res.status(200).json({
    success: true,
    posOrder
  });
});

// Delete POS order
exports.deletePOSOrder = catchAsyncErrors(async (req, res, next) => {
  const posOrder = await POSOrder.findById(req.params.id);
  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  // Restore inventory items to active status before deleting order
  for (const item of posOrder.items) {
    await Inventory.findByIdAndUpdate(item.inventoryId, [
      {
        $set: {
          assignedQuantity: 0,
          availableQuantity: '$stockQuantity',
          status: 'active',
          lastUpdated: new Date()
        }
      }
    ]);
  }

  // Delete the POS order
  await POSOrder.findByIdAndDelete(req.params.id);

  res.status(200).json({
    success: true,
    message: 'POS Order deleted successfully'
  });
});

// Email a copy of the receipt/invoice to the customer
exports.sendPOSInvoiceEmail = catchAsyncErrors(async (req, res, next) => {
  const posOrder = await POSOrder.findById(req.params.id)
    .populate('cashier', 'firstName lastName')
    .populate('items.productId', 'name')
    .populate('items.inventoryId', 'barcode');

  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  if (!posOrder.customer?.email) {
    return next(new ErrorHandler('This order has no customer email address', 400));
  }

  const result = await sendPOSReceipt(posOrder);
  if (!result.success) {
    return next(new ErrorHandler(result.message || result.error || 'Failed to send invoice email', 500));
  }

  res.status(200).json({
    success: true,
    message: `Invoice emailed to ${posOrder.customer.email}`,
    messageId: result.messageId
  });
});
