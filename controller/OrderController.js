const Order = require('../models/Order');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const DigitalProductCode = require('../models/DigitalProductCode');
const mongoose = require('mongoose');
const { 
  assignInventoryToOrder, 
  releaseInventoryFromOrder, 
  validateInventoryAvailability 
} = require('../utils/inventoryHelpers');
const { sendOrderConfirmation, sendOrderProcessing, sendOrderShipped, sendOrderDelivered, sendOrderCancelled, sendOrderFinalization, sendOrderInvoicePdf } = require('../utils/emailService');
const { createOrderInvoicePdf } = require('../utils/orderInvoicePdf');
const { ownsOrder, customerOrdersFilter } = require('../utils/orderAccess');
const escapeRegex = require('../utils/escapeRegex');
const DIGITAL_FREE_SHIPPING_NAME = 'Digital Products — Free Delivery';
const {
  getLoyaltyAccount,
  getLoyaltySettings,
  changeLoyaltyBalance,
  earnOrderReward,
  encryptDigitalCode,
  reserveDigitalCodesForOrder,
  releaseDigitalCodesForOrder,
  sendOrderDigitalCodes,
  readManualDigitalFulfillment,
  sendOrderManualDigitalFulfillment,
} = require('../utils/loyaltyService');

const reverseOrderLoyalty = async (order, session = null) => {
  if (!order?.userId) return;
  if (Number(order.loyaltyAmountUsed || 0) > 0) {
    await changeLoyaltyBalance({
      userId: order.userId,
      amountBDT: order.loyaltyAmountUsed,
      direction: 'credit',
      source: 'order_refund',
      referenceId: order.orderId,
      note: `Restored loyalty balance for cancelled, refunded, or deleted order #${order.orderId}`,
      idempotencyKey: `order:${order._id}:loyalty-restore`,
      session,
    });
  }
  if (Number(order.loyaltyRewardEarned || 0) > 0) {
    await changeLoyaltyBalance({
      userId: order.userId,
      amountBDT: order.loyaltyRewardEarned,
      direction: 'debit',
      source: 'reward_reversal',
      referenceId: order.orderId,
      note: `Reversed loyalty reward for cancelled, refunded, or deleted order #${order.orderId}`,
      idempotencyKey: `order:${order._id}:reward-reversal`,
      session,
      allowNegative: true,
    });
  }
};

// Socket.io instance (set from server.js)
let ioInstance = null;

async function hydrateFinanceItemSnapshots(items, session = null) {
  const sourceItems = (items || []).map((item) => typeof item?.toObject === 'function' ? item.toObject() : { ...item });
  const productIds = [...new Set(sourceItems.map((item) => String(item.productId?._id || item.productId || '')).filter(mongoose.isValidObjectId))];
  if (!productIds.length) return sourceItems;
  let query = Product.find({ _id: { $in: productIds } }).select('name slug sku brand categories mainImage costPrice isDigitalProduct variants');
  if (session) query = query.session(session);
  const products = await query.lean();
  const byId = new Map(products.map((product) => [String(product._id), product]));
  return sourceItems.map((item) => {
    const product = byId.get(String(item.productId?._id || item.productId || ''));
    if (!product) return item;
    const variant = (product.variants || []).find((entry) => String(entry._id) === String(item.variantId?._id || item.variantId || ''));
    const configuration = item.configuration || {};
    const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
    const option = (variant?.options || []).find((entry) =>
      same(entry.size, configuration.size || item.size) &&
      same(entry.measureType, configuration.measureType || item.measureType) &&
      same(entry.unitName, configuration.unitName || item.unitName)
    );
    const color = configuration.color || item.color || variant?.colorName || '';
    const size = configuration.size || item.size || '';
    const variantName = item.variantName || [color, size].filter(Boolean).join(' / ');
    const fallbackCost = option?.costPrice ?? variant?.costPrice ?? product.costPrice;
    return {
      ...item,
      productSlug: item.productSlug || product.slug || '',
      brand: item.brand || product.brand || '',
      categories: item.categories?.length ? item.categories : product.categories || [],
      variantName,
      variantImage: item.variantImage || variant?.images?.[0] || item.mainImage || '',
      hexCode: item.hexCode || configuration.hexCode || variant?.hexCode || '',
      costPrice: item.costPrice ?? (fallbackCost !== null && fallbackCost !== undefined && Number.isFinite(Number(fallbackCost)) ? Number(fallbackCost) : null),
      isDigitalProduct: Boolean(item.isDigitalProduct || product.isDigitalProduct),
    };
  });
}

// Older orders may predate the digital-product flag on each line item. Use the
// current catalog flag as a fallback so admin fulfillment fields and courier
// visibility still work for those saved orders.
async function hydrateOrderDigitalFlags(orderOrOrders) {
  const input = Array.isArray(orderOrOrders) ? orderOrOrders : [orderOrOrders];
  const orders = input.filter(Boolean).map((order) => typeof order.toObject === 'function' ? order.toObject() : order);
  const productIds = [...new Set(orders.flatMap((order) => (order.items || [])
    .map((item) => String(item.productId?._id || item.productId || ''))
    .filter(mongoose.isValidObjectId)))];
  if (!productIds.length) return Array.isArray(orderOrOrders) ? orders : orders[0] || null;
  const products = await Product.find({ _id: { $in: productIds } }).select('isDigitalProduct').lean();
  const digitalProducts = new Set(products.filter((product) => product.isDigitalProduct).map((product) => String(product._id)));
  const hydrated = orders.map((order) => ({
    ...order,
    items: (order.items || []).map((item) => ({
      ...item,
      isDigitalProduct: Boolean(item.isDigitalProduct || digitalProducts.has(String(item.productId?._id || item.productId || ''))),
    })),
  }));
  return Array.isArray(orderOrOrders) ? hydrated : hydrated[0] || null;
}
module.exports.setSocketIO = (io) => {
  ioInstance = io;
};

// Look up an order by its human-readable orderId OR its Mongo _id
// (the admin UI sometimes passes _id, the user UI passes orderId)
const findOrderByRefundKey = (key, session) => {
  const query = mongoose.isValidObjectId(key)
    ? Order.findOne({ $or: [{ orderId: key }, { _id: key }] })
    : Order.findOne({ orderId: key });
  if (session) return query.session(session);
  return query;
};

// Helper function to emit inventory assignment events
function emitInventoryAssignment(productId, variantId, size, action, data = {}) {
  if (!ioInstance) {
    console.log('❌ ioInstance not available for inventory assignment emission');
    return;
  }

  const eventData = {
    productId,
    variantId,
    size,
    action,
    timestamp: new Date(),
    ...data
  };

  console.log(`📦 Attempting to emit inventory assignment: ${action} for product ${productId}, variant ${variantId}, size ${size}`);
  console.log('📦 Event data:', eventData);

  // Emit to product room
  ioInstance.to(`product_${productId}`).emit('inventoryAssignment', eventData);
  
  // Emit to admin room for monitoring
  ioInstance.to('adminRoom').emit('inventoryAssignment', eventData);
  
  console.log(`✅ Inventory assignment emitted: ${action} for product ${productId}, variant ${variantId}, size ${size}`);
}

// Helper function for socket notifications
function notifyOrderUpdate(order, eventType) {
  if (!ioInstance) return;

  // `userId` may be populated by callers, so always derive the raw id before
  // constructing the authenticated customer's private socket room/event name.
  const orderUserId = order.userId?._id || order.userId;

  const events = {
    create: {
      admin: 'admin:newOrder',
      user: orderUserId ? `user:orderUpdate:${orderUserId}` : null,
      dashboard: 'newOrder'
    },
    update: {
      admin: 'admin:updateOrder',
      user: orderUserId ? `user:orderUpdate:${orderUserId}` : null,
      dashboard: 'orderStatusUpdate'
    },
    cancel: {
      admin: 'admin:cancelOrder',
      user: orderUserId ? `user:orderUpdate:${orderUserId}` : null,
      dashboard: 'orderStatusUpdate'
    },
    delete: {
      admin: 'admin:orderDeleted',
      dashboard: 'orderDeleted'
    }
  };

  const event = events[eventType];
  if (!event) return;

  // Notify admin
  if (event.admin) {
    // Create a clean order object for Socket.IO emission
    const cleanOrderForSocket = {
      _id: order._id,
      orderId: order.orderId,
      userId: order.userId,
      orderStatus: order.orderStatus,
      isNewForAdmin: !!order.isNewForAdmin,
      paymentStatus: order.paymentStatus,
      refundStatus: order.refundStatus,
      totalAmount: order.totalAmount,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
    ioInstance.to('adminRoom').emit(event.admin, cleanOrderForSocket);

    // Rich order alerts are sent only to admins whose role includes order
    // access. The compact update above remains for existing real-time tables.
    const shippingAddress = order.shippingAddress || {};
    const notificationItems = (order.items || []).map((item) => ({
      name: item.name || 'Product',
      quantity: Number(item.quantity) || 1,
      price: Number(item.price) || 0,
      variantName: item.variantName || '',
      color: item.color || item.configuration?.color || '',
      size: item.size || item.configuration?.size || '',
      regionName: item.regionName || item.configuration?.regionName || '',
      image: item.mainImage || item.variantImage || '',
    }));
    ioInstance.to('adminOrdersRoom').emit('admin:orderNotification', {
      eventType,
      _id: order._id,
      orderId: order.orderId,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      totalAmount: order.totalAmount,
      grandTotal: order.grandTotal,
      shippingCost: order.shippingCost,
      customerName: shippingAddress.fullName || '',
      customerPhone: shippingAddress.phone || '',
      shippingAddress: [shippingAddress.address, shippingAddress.city, shippingAddress.state, shippingAddress.postalCode, shippingAddress.country].filter(Boolean).join(', '),
      firstItemImage: notificationItems[0]?.image || '',
      items: notificationItems,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    });
  }

  // Notify dashboard
  if (event.dashboard) {
    // Create a clean order object for dashboard notification
    const orderData = {
      _id: order._id,
      orderId: order.orderId,
      orderNumber: order.orderNumber || (order._id ? order._id.toString().slice(-6) : ''),
      status: order.orderStatus,
      paymentStatus: order.paymentStatus,
      totalAmount: order.totalAmount,
      userId: order.userId,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
    
    ioInstance.to('dashboardRoom').emit(event.dashboard, orderData);
  }

  // Notify specific user
  if (event.user && orderUserId) {
    ioInstance.to(`user_${orderUserId}`).emit(event.user, {
      eventType,
      order
    });
  }
}

// Generate unique 10-digit orderId
async function generateOrderId() {
  const MAX_ATTEMPTS = 10;
  let orderId;
  let exists = true;
  let attempts = 0;

  while (exists && attempts < MAX_ATTEMPTS) {
    orderId = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    exists = await Order.exists({ orderId });
    attempts++;
  }

  if (exists) {
    throw new Error(`Could not generate unique orderId after ${MAX_ATTEMPTS} attempts`);
  }
  return orderId;
}

module.exports.getAllOrders = async (req, res) => {
  try {
    const isAdmin = !!req.admin;
    const userDocId = req.user?._id;

    // Query params
    const {
      page = '1',
      limit = '20',
      sortBy = 'createdAt',
      sortOrder = 'desc',
      status,
      paymentStatus,
      userId,
      orderId,
      q,
      from,
      to,
      isActive,
      refundStatus,
    } = req.query;

    const stringFilters = [sortBy, sortOrder, status, paymentStatus, userId, orderId, q, from, to, isActive, refundStatus];
    if (stringFilters.some((value) => value !== undefined && typeof value !== 'string')) {
      return res.status(400).json({ message: 'Order filters must be single string values' });
    }
    if (!/^\d+$/.test(String(page)) || !/^\d+$/.test(String(limit))) {
      return res.status(400).json({ message: 'Page and limit must be positive integers' });
    }

    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 || parsedPage > 10000000 ||
        !Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({ message: 'Page and limit are outside the supported range' });
    }
    const pageNum = parsedPage;
    const limitNum = Math.min(parsedLimit, 100);
    const skip = (pageNum - 1) * limitNum;

    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
      return res.status(400).json({ message: 'sortOrder must be asc or desc' });
    }
    const allowedSortFields = new Set(['createdAt', 'updatedAt', 'orderId', 'orderStatus', 'paymentStatus', 'totalAmount']);
    const safeSortBy = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';
    if (q && q.length > 100) return res.status(400).json({ message: 'Search query must be 100 characters or fewer' });

    // Base filter
    const filter = {};

    // Role constraint
    if (isAdmin) {
      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        filter.userId = userId;
      }
    } else {
      if (!userDocId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      filter.userId = userDocId;
    }

    // Exact orderId
    if (orderId) {
      filter.orderId = orderId.trim();
    }

    // Order status filter
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length) filter.orderStatus = { $in: statuses };
    }

    // Payment status filter
    if (paymentStatus) {
      const pStatuses = paymentStatus.split(',').map(s => s.trim()).filter(Boolean);
      if (pStatuses.length) filter.paymentStatus = { $in: pStatuses };
    }

    // isActive filter
    if (typeof isActive === 'string') {
      if (isActive.toLowerCase() === 'true') filter.isActive = true;
      if (isActive.toLowerCase() === 'false') filter.isActive = false;
    }

    // Refund request status filter
    if (refundStatus) {
      const rStatuses = refundStatus.split(',').map(s => s.trim()).filter(Boolean);
      if (rStatuses.length) filter.refundStatus = { $in: rStatuses };
    }

    // Date range
    if (from || to) {
      filter.createdAt = {};
      if (from) {
        const fromDate = new Date(from);
        if (Number.isNaN(fromDate.getTime())) return res.status(400).json({ message: 'Invalid from date' });
        filter.createdAt.$gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        if (Number.isNaN(toDate.getTime())) return res.status(400).json({ message: 'Invalid to date' });
        filter.createdAt.$lte = toDate;
      }
    }

    // Free-text search
    if (q && q.trim()) {
      const rx = new RegExp(escapeRegex(q.trim().slice(0, 100)), 'i');
      filter.$or = [
        { orderId: rx },
        { couponCode: rx },
        { 'shippingAddress.fullName': rx },
        { 'items.name': rx },
      ];
    }

    // Sorting
    const sort = { [safeSortBy]: sortOrder === 'asc' ? 1 : -1 };

    // Query + total
    let ordersQuery = Order.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .populate('items.regionId', 'name');
    if (isAdmin) {
      ordersQuery = ordersQuery.populate({
          path: 'items.assignedInventoryItems',
          select: 'barcode realBarcode qrCode imageUri size color regionId regionName variantId productId',
          populate: [
            { path: 'regionId', select: 'name' },
            { path: 'productId', select: 'name mainImage' },
          ],
      });
    } else {
      ordersQuery = ordersQuery.select(
        '-items.costPrice -items.assignedInventoryItems -items.assignedInventorySnapshots -items.digitalCodeIds -items.inventoryId -items.manualDigitalFulfillmentEncrypted'
      );
    }

    let [orders, total] = await Promise.all([
      ordersQuery.lean(),
      Order.countDocuments(filter),
    ]);
    if (isAdmin) orders = await hydrateOrderDigitalFlags(orders);

    return res.json({
      data: orders,
      meta: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
        sortBy,
        sortOrder,
        filtersApplied: {
          isAdmin,
          userId: filter.userId?.toString?.() || undefined,
          status: filter.orderStatus?.$in,
          paymentStatus: filter.paymentStatus?.$in,
          refundStatus: filter.refundStatus?.$in,
          orderId: filter.orderId,
          isActive: filter.isActive,
          from: from || undefined,
          to: to || undefined,
          q: q || undefined,
        },
      },
    });
  } catch (err) {
    console.error('Get Orders Error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports.markOrderOpened = async (req, res) => {
  try {
    const order = await findOrderByRefundKey(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.isNewForAdmin) {
      order.isNewForAdmin = false;
      await order.save();
    }

    return res.json({ success: true, orderId: order._id, isNewForAdmin: false });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to mark order as opened' });
  }
};

module.exports.createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      shippingAddress,
      shipping,
      paymentMethod,
      paymentDetails,
      selectedPaymentMethodId,
      loyaltyAmountBDT = 0,
    } = req.body;

    const userId = req.user?._id?.toString();
    if (!userId || (req.body.userId && req.body.userId.toString() !== userId)) {
      await session.abortTransaction();
      return res.status(403).json({ message: 'The authenticated account does not match this checkout' });
    }
    if (!shippingAddress || !shipping?.name) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Validate shipping address
    const requiredShippingFields = ['fullName', 'address', 'city', 'postalCode', 'country', 'phone'];
    for (const field of requiredShippingFields) {
      if (!shippingAddress[field]?.trim()) {
        await session.abortTransaction();
        return res.status(400).json({ message: `Shipping address '${field}' is required` });
      }
    }

    // Verify user exists
    const user = await User.findById(userId).session(session).lean();
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found' });
    }

    // The persisted server cart is authoritative. Re-resolve every option,
    // price, discount, and stock level before creating the order snapshot.
    const { refreshCartFromCatalog, recalcCartWithCoupon } = require('./CartController');
    const cart = await Cart.findOne({ userId }).populate('couponId').session(session);
    if (!cart || !cart.items.length) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Your cart is empty. Add items before placing the order.' });
    }
    await refreshCartFromCatalog(cart);
    await recalcCartWithCoupon(cart);
    const unavailableItems = cart.items.filter((item) => !item.isAvailable);
    if (unavailableItems.length) {
      await cart.save({ session });
      await session.commitTransaction();
      return res.status(409).json({
        message: 'Some cart items have changed or are unavailable. Review your cart and try again.',
        items: unavailableItems.map((item) => ({ itemId: item._id, message: item.unavailableReason })),
      });
    }
    const items = await hydrateFinanceItemSnapshots(cart.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId || null,
      regionId: item.regionId || null,
      regionName: item.regionName || '',
      configuration: {
        regionId: item.regionId || null,
        regionName: item.regionName || '',
        color: item.color || '',
        hexCode: item.hexCode || '',
        size: item.size || '',
        measureType: item.measureType || '',
        unitName: item.unitName || '',
      },
      name: item.name,
      sku: item.sku || '',
      quantity: Number(item.quantity),
      price: Number(item.price),
      originalPrice: Number(item.originalPrice ?? item.price),
      discountPrice: item.discountPrice ?? null,
      discountApplied: Number(item.discountApplied || 0),
      mainImage: item.mainImage || '',
      variantImage: item.mainImage || '',
      size: item.size || '',
      color: item.color || '',
      measureType: item.measureType || '',
      unitName: item.unitName || '',
      isPreOrder: Boolean(item.isPreOrder),
      isDigitalProduct: Boolean(item.isDigitalProduct),
      preOrderEstimatedDate: item.preOrderEstimatedDate || null,
    })), session);
    const totalAmount = Number(cart.totalAmount || 0);
    const discountAmount = Number(cart.discountAmount || 0);
    const couponCode = cart.couponId?.code || null;
    const hasDigitalProducts = items.some((item) => item.isDigitalProduct);



    // Resolve the selected tender. Its requirement is checked after the server
    // calculates shipping and the amount the loyalty balance will cover.
    let selectedPaymentMethod = null;
    const requestedPaymentMethod = String(paymentMethod || '').trim();
    const requestedPaymentKey = requestedPaymentMethod.toLowerCase();
    if (['loyalty balance', 'loyalty'].includes(requestedPaymentKey)) {
      selectedPaymentMethod = { methodId: 'loyalty', type: 'Loyalty Balance', label: 'Loyalty Balance' };
    } else if (requestedPaymentKey === 'cash on delivery' || requestedPaymentKey === 'cash') {
      selectedPaymentMethod = {
        methodId: 'cash',
        type: 'Cash on Delivery',
        label: 'Cash on Delivery',
      };
    } else if (requestedPaymentMethod) {
      const method = (user.paymentMethods || []).find(
        m => m._id.toString() === selectedPaymentMethodId
      );
      if (!method) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'Payment method not found' });
      }

      selectedPaymentMethod = {
        methodId: method._id,
        type: method.type,
        label: method.label || `${method.type} ${method.walletNumberMasked || ''}`,
      };
    }

    let normalizedPaymentMethod = selectedPaymentMethod?.type || requestedPaymentMethod;

    // Validate shipping information
    if (!shipping || !shipping.name) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Valid shipping information is required' });
    }

    const isDigitalOnlyOrder = items.length > 0 && items.every((item) => Boolean(item.isDigitalProduct));
    let orderShipping;
    if (isDigitalOnlyOrder) {
      if (shipping.name !== DIGITAL_FREE_SHIPPING_NAME) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Digital-only orders use Free Delivery and do not need a courier method' });
      }
      orderShipping = { name: DIGITAL_FREE_SHIPPING_NAME, charge: 0, estimatedDays: 0 };
    } else {
      // Physical and mixed carts must use an active, server-configured method.
      const Shipping = require('../models/Shipping');
      const shippingMethod = await Shipping.findOne({ name: shipping.name, isActive: true }).session(session);
      if (!shippingMethod) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Selected shipping method is not available' });
      }
      orderShipping = {
        name: shippingMethod.name,
        charge: shippingMethod.charge,
        estimatedDays: shippingMethod.estimatedDays,
      };
    }

    // Apply admin-configured checkout rules (min/max order, COD limits, delivery multiplier, fees...)
    const { evaluateCheckoutRules } = require('../utils/checkoutRuleEngine');
    const checkoutRuleInput = {
      subtotal: Number(totalAmount),
      discountAmount: Number(discountAmount || 0),
      shippingCharge: orderShipping.charge,
      shippingMethodName: orderShipping.name,
      paymentMethod: normalizedPaymentMethod,
      items: items.map(i => ({ name: i.name, quantity: Number(i.quantity) || 0, price: Number(i.price) || 0, isDigitalProduct: Boolean(i.isDigitalProduct) })),
    };
    let ruleEval = await evaluateCheckoutRules(checkoutRuleInput);

    if (!ruleEval.ok) {
      await session.abortTransaction();
      return res.status(400).json({
        message: ruleEval.blockers.map(b => b.message).join(' '),
        blockers: ruleEval.blockers,
      });
    }

    // 🔹 Update order items without automatic inventory assignment
    const itemsWithInventory = items.map((item) => {
      return {
        ...item,
        assignedInventoryItems: [],
        inventoryAssigned: false
      };
    });

    const requestedLoyaltyAmount = Number(loyaltyAmountBDT || 0);
    if (!Number.isFinite(requestedLoyaltyAmount) || requestedLoyaltyAmount < 0) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Enter a valid BDT loyalty amount' });
    }
    const loyaltySettings = await getLoyaltySettings(session);
    const loyaltyAccount = await getLoyaltyAccount(userId, session);
    const getLoyaltyUse = (total) => Math.round(Math.min(
      requestedLoyaltyAmount,
      Number(loyaltyAccount.balanceBDT || 0),
      loyaltySettings.enabled ? Number(total || 0) * Number(loyaltySettings.maxRedeemPercent || 0) / 100 : 0,
      Number(total || 0),
    ) * 100) / 100;
    let loyaltyAmountUsed = getLoyaltyUse(ruleEval.grandTotal);
    let amountDue = Math.max(0, Math.round((Number(ruleEval.grandTotal || 0) - loyaltyAmountUsed) * 100) / 100);

    if (amountDue <= 0 && requestedPaymentKey !== 'loyalty balance' && requestedPaymentKey !== 'loyalty') {
      const loyaltyRuleEval = await evaluateCheckoutRules({ ...checkoutRuleInput, paymentMethod: 'Loyalty Balance' });
      if (!loyaltyRuleEval.ok) {
        await session.abortTransaction();
        return res.status(400).json({
          message: loyaltyRuleEval.blockers.map(b => b.message).join(' '),
          blockers: loyaltyRuleEval.blockers,
        });
      }
      const loyaltyRuleUse = getLoyaltyUse(loyaltyRuleEval.grandTotal);
      if (loyaltyRuleUse >= Number(loyaltyRuleEval.grandTotal || 0)) {
        ruleEval = loyaltyRuleEval;
        loyaltyAmountUsed = loyaltyRuleUse;
        amountDue = Math.max(0, Math.round((Number(ruleEval.grandTotal || 0) - loyaltyAmountUsed) * 100) / 100);
      }
    }

    if (amountDue > 0 && (!selectedPaymentMethod || ['loyalty', 'loyalty balance'].includes(String(selectedPaymentMethod.type).toLowerCase()))) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Select a payment method for the amount remaining after loyalty balance.' });
    }
    if (amountDue <= 0) {
      selectedPaymentMethod = { methodId: 'loyalty', type: 'Loyalty Balance', label: 'Loyalty Balance' };
      normalizedPaymentMethod = 'Loyalty Balance';
    }

    if (amountDue > 0 && hasDigitalProducts) {
      const walletType = String(selectedPaymentMethod?.type || '').trim().toLowerCase();
      const trxId = String(paymentDetails?.trxId || '').trim();
      if (!['bkash', 'nagad'].includes(walletType)) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Digital products require bKash or Nagad for the amount remaining after loyalty balance.' });
      }
      if (walletType !== requestedPaymentKey) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Select the same bKash or Nagad wallet used to pay for the digital product.' });
      }
      if (!/^[a-z0-9]{8,}$/i.test(trxId)) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'A valid bKash or Nagad transaction ID is required for digital products.' });
      }
    }

    // Create the order only after loyalty and payment rules are finalized so
    // the saved totals and wallet ledger always use the same server values.
    const orderId = await generateOrderId();
    const newOrder = new Order({
      orderId,
      userId,
      items: itemsWithInventory,
      isNewForAdmin: true,
      totalAmount,
      discountAmount,
      couponCode,
      shippingAddress,
      shipping: orderShipping,
      shippingCost: ruleEval.deliveryCharge,
      extraFees: ruleEval.extraFees,
      extraFeeTotal: ruleEval.extraFeeTotal,
      checkoutRulesApplied: ruleEval.appliedRules,
      grandTotal: ruleEval.grandTotal,
      amountDue,
      loyaltyAmountUsed,
      paymentMethod: normalizedPaymentMethod,
      selectedPaymentMethod,
      paymentDetails,
      paymentStatus: amountDue <= 0 ? 'completed' : 'pending',
      orderStatus: amountDue <= 0 ? 'processing' : 'pending',
      isActive: true,
    });

    await newOrder.save({ session });
    await reserveDigitalCodesForOrder(newOrder, session);
    if (loyaltyAmountUsed > 0) {
      await changeLoyaltyBalance({
        userId,
        amountBDT: loyaltyAmountUsed,
        direction: 'debit',
        source: 'order_redemption',
        referenceId: newOrder.orderId,
        note: `Loyalty balance used on order #${newOrder.orderId}`,
        idempotencyKey: `order:${newOrder._id}:redeem`,
        session,
      });
    }
    if (newOrder.paymentStatus === 'completed') {
      newOrder.loyaltyRewardEarned = await earnOrderReward(newOrder, session);
    }
    const savedOrder = await newOrder.save({ session });
    cart.items = [];
    cart.totalAmount = 0;
    cart.discountAmount = 0;
    cart.couponId = null;
    await cart.save({ session });
    await session.commitTransaction();

    // Notify via Socket.IO
    notifyOrderUpdate(savedOrder, 'create');
    
    // Send immediate order confirmation email
    try {
      const user = await User.findById(userId).lean();
      if (user && user.email) {
        const emailResult = await sendOrderConfirmation(savedOrder, user);
        if (emailResult.success) {
          // Mark email as sent
          await Order.findByIdAndUpdate(savedOrder._id, {
            $set: { emailSent: 'confirmation' }
          });
          console.log(`✅ Immediate confirmation email sent for order #${savedOrder.orderId}`);
        } else {
          console.log(`⚠️ Failed to send immediate confirmation email for order #${savedOrder.orderId}: ${emailResult.message}`);
        }
        if (savedOrder.paymentStatus === 'completed' && savedOrder.items.some((item) => item.isDigitalProduct)) {
          const digitalResult = await sendOrderDigitalCodes(savedOrder, user);
          if (!digitalResult.success) console.error(`Digital fulfillment email was not sent for order #${savedOrder.orderId}: ${digitalResult.message}`);
        }
      }
    } catch (emailError) {
      console.error(`❌ Error sending immediate confirmation email for order #${savedOrder.orderId}:`, emailError.message);
      // Don't fail the order creation if email fails
    }
    
    return res.status(201).json(savedOrder);
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Create Order Error:', err);
    const statusCode = err.code === 'DIGITAL_CODE_STOCK_UNAVAILABLE' ? 409 : 500;
    return res.status(statusCode).json({ message: err.message || 'Server error', ...(statusCode === 409 ? { code: err.code } : {}) });
  } finally {
    session.endSession();
  }
};

// 🛡️ Admin: manually create an order for a customer (with full totals computed server-side)
module.exports.adminCreateOrder = async (req, res) => {
  try {
    const {
      userId,
      email,
      items,
      shippingAddress,
      shipping,
      paymentMethod,
      selectedPaymentMethodId,
      paymentDetails,
      discountAmount = 0,
      couponCode = null,
      orderStatus = 'pending',
      paymentStatus = 'pending',
    } = req.body;

    if (!userId || !items || !Array.isArray(items) || items.length === 0 ||
      !shippingAddress || !paymentMethod || !shipping || !shipping.name) {
      return res.status(400).json({ message: 'Missing required fields (user, items, address, shipping method, payment)' });
    }

    // Validate shipping address
    const requiredShippingFields = ['fullName', 'address', 'city', 'postalCode', 'country', 'phone'];
    for (const field of requiredShippingFields) {
      if (!shippingAddress[field]?.trim()) {
        return res.status(400).json({ message: `Shipping address '${field}' is required` });
      }
    }

    // Validate items and compute subtotal server-side
    for (const item of items) {
      if (!item.variantId || !item.productId || !item.name ||
        typeof item.discountApplied !== 'number' ||
        !item.quantity || !item.price || !item.mainImage ||
        !item.measureType || !item.unitName) {
        return res.status(400).json({ message: 'Each item must include required fields (variant, product, name, quantity, price, image, measure)' });
      }
    }
    const subtotal = items.reduce((sum, it) => sum + Number(it.price) * Number(it.quantity), 0);

    // User must exist
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Confirmation email destination: admin-entered email wins, fallback to the user's account email
    const recipientEmail = String(email || user.email || '').trim();
    if (!recipientEmail || !/^\S+@\S+\.\S+$/.test(recipientEmail)) {
      return res.status(400).json({ message: 'A valid customer email address is required' });
    }

    // Payment resolution (COD or a saved wallet method of that user)
    const pmLower = String(paymentMethod).toLowerCase();
    const isCod = pmLower === 'cash on delivery' || pmLower === 'cash';
    let normalizedPaymentMethod;
    let selectedPaymentMethod;

    if (isCod) {
      normalizedPaymentMethod = 'Cash on Delivery';
      selectedPaymentMethod = { methodId: 'cash', type: 'Cash on Delivery', label: 'Cash on Delivery' };
    } else {
      const method = (user.paymentMethods || []).find(
        m => m._id.toString() === selectedPaymentMethodId
      );
      if (!method) {
        // Admin may record a manual wallet payment not saved on the user's profile
        if (!['bkash', 'nagad', 'bKash', 'Nagad'].includes(paymentMethod)) {
          return res.status(400).json({ message: 'Select a valid payment method for this user' });
        }
        selectedPaymentMethod = { methodId: 'admin-manual', type: paymentMethod, label: paymentMethod };
      } else {
        selectedPaymentMethod = {
          methodId: method._id,
          type: method.type,
          label: method.label || `${method.type} ${method.walletNumberMasked || ''}`,
        };
      }
      normalizedPaymentMethod = paymentMethod;
    }

    // Shipping method must be active in DB; charge comes from DB
    const Shipping = require('../models/Shipping');
    const shippingMethod = await Shipping.findOne({ name: shipping.name, isActive: true });
    if (!shippingMethod) {
      return res.status(400).json({ message: 'Selected shipping method is not available' });
    }

    // Apply checkout rules for delivery/fee math (admin override: blockers become warnings)
    const { evaluateCheckoutRules } = require('../utils/checkoutRuleEngine');
    const ruleEval = await evaluateCheckoutRules({
      subtotal,
      discountAmount: Number(discountAmount) || 0,
      shippingCharge: shippingMethod.charge,
      shippingMethodName: shippingMethod.name,
      paymentMethod: normalizedPaymentMethod,
      items: items.map(i => ({ name: i.name, quantity: Number(i.quantity) || 0, price: Number(i.price) || 0, isDigitalProduct: Boolean(i.isDigitalProduct) })),
    });

    // Validate status values against model enums
    const validOrderStatus = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    const validPaymentStatus = ['pending', 'completed', 'failed', 'refunded'];
    const finalOrderStatus = validOrderStatus.includes(orderStatus) ? orderStatus : 'pending';
    const finalPaymentStatus = validPaymentStatus.includes(paymentStatus) ? paymentStatus : 'pending';

    const enrichedItems = await hydrateFinanceItemSnapshots(items);
    const itemsWithInventory = enrichedItems.map((item) => ({
      ...item,
      assignedInventoryItems: [],
      inventoryAssigned: false,
    }));

    const orderId = await generateOrderId();
    const newOrder = new Order({
      orderId,
      userId,
      items: itemsWithInventory,
      isNewForAdmin: true,
      totalAmount: subtotal,
      discountAmount: Number(discountAmount) || 0,
      couponCode,
      shippingAddress,
      shipping: {
        name: shippingMethod.name,
        charge: shippingMethod.charge,
        estimatedDays: shippingMethod.estimatedDays,
      },
      shippingCost: ruleEval.deliveryCharge,
      extraFees: ruleEval.extraFees,
      extraFeeTotal: ruleEval.extraFeeTotal,
      checkoutRulesApplied: ruleEval.appliedRules,
      grandTotal: ruleEval.grandTotal,
      paymentMethod: normalizedPaymentMethod,
      selectedPaymentMethod,
      paymentDetails: paymentDetails || {},
      paymentStatus: finalPaymentStatus,
      orderStatus: finalOrderStatus,
      isActive: true,
    });

    const orderSession = await mongoose.startSession();
    let savedOrder;
    try {
      orderSession.startTransaction();
      savedOrder = await newOrder.save({ session: orderSession });
      await reserveDigitalCodesForOrder(savedOrder, orderSession);
      if (savedOrder.paymentStatus === 'completed') {
        savedOrder.loyaltyRewardEarned = await earnOrderReward(savedOrder, orderSession);
      }
      savedOrder = await savedOrder.save({ session: orderSession });
      await orderSession.commitTransaction();
    } catch (persistError) {
      if (orderSession.inTransaction()) await orderSession.abortTransaction();
      throw persistError;
    } finally {
      await orderSession.endSession();
    }
    notifyOrderUpdate(savedOrder, 'create');

    // Send order confirmation email (never fail order creation if email fails)
    let emailSent = false;
    try {
      const emailResult = await sendOrderConfirmation(savedOrder, {
        fullName: shippingAddress.fullName,
        email: recipientEmail,
      });
      emailSent = !!emailResult.success;
      if (emailSent) {
        await Order.updateOne({ _id: savedOrder._id }, { $set: { emailSent: 'confirmation' } });
        savedOrder.emailSent = 'confirmation';
        console.log(`✅ Admin order confirmation email sent for #${savedOrder.orderId} → ${recipientEmail}`);
      } else {
        console.warn(`⚠️ Failed to send admin order confirmation email for #${savedOrder.orderId}: ${emailResult.message || emailResult.error}`);
      }
      if (savedOrder.paymentStatus === 'completed' && savedOrder.items.some((item) => item.isDigitalProduct)) {
        const fulfillmentUser = { ...user, fullName: shippingAddress.fullName || user.fullName, email: recipientEmail };
        const digitalResult = await sendOrderDigitalCodes(savedOrder, fulfillmentUser);
        if (!digitalResult.success) console.error(`Digital fulfillment email was not sent for admin order #${savedOrder.orderId}: ${digitalResult.message}`);
      }
    } catch (emailError) {
      console.error(`⚠️ Error sending admin order confirmation email for #${savedOrder.orderId}:`, emailError.message);
    }

    return res.status(201).json({
      order: savedOrder,
      orderId: savedOrder.orderId,
      emailSent,
      warnings: ruleEval.blockers, // checkout rules the admin overrode
    });
  } catch (err) {
    console.error('Admin Create Order Error:', err);
    const statusCode = err.code === 'DIGITAL_CODE_STOCK_UNAVAILABLE' ? 409 : 500;
    return res.status(statusCode).json({ message: err.message || 'Server error', ...(statusCode === 409 ? { code: err.code } : {}) });
  }
};

module.exports.getOrderByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'Order ID required' });

    let order = await Order.findOne({ orderId }).select('+items.manualDigitalFulfillmentEncrypted').populate('items.regionId', 'name').lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    order = await hydrateOrderDigitalFlags(order);
    if (!ownsOrder(order, req.user?._id)) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Format items for response
    order.items = await Promise.all(order.items.map(async (item) => {
      let digitalFulfillment;
      if (item.isDigitalProduct && order.paymentStatus === 'completed') {
        const manualDetails = item.manualDigitalFulfillmentSentAt
          ? readManualDigitalFulfillment(item)
          : {};
        const sentCodes = (item.digitalCodeIds || []).length
          ? await DigitalProductCode.find({
            _id: { $in: item.digitalCodeIds },
            reservedOrderId: order._id,
            reservedItemId: item._id,
            status: 'sent',
          }).select('+codeEncrypted').lean()
          : [];
        const decryptDigitalCode = require('../utils/loyaltyService').decryptDigitalCode;
        const codes = sentCodes.map((record) => {
          try {
            return decryptDigitalCode(record.codeEncrypted);
          } catch {
            return '';
          }
        }).filter(Boolean);
        if (Object.values(manualDetails).some(Boolean) || codes.length) {
          digitalFulfillment = { ...manualDetails, ...(codes.length ? { codes } : {}) };
        }
      }
      const customerItem = { ...item };
      [
        'costPrice', 'assignedInventoryItems', 'assignedInventorySnapshots', 'digitalCodeIds',
        'inventoryId', 'inventoryAssigned', 'manualDigitalFulfillmentEncrypted',
      ].forEach((field) => delete customerItem[field]);
      return {
        ...customerItem,
        variant: variantSummary(item),
        ...(digitalFulfillment ? { digitalFulfillment } : {}),
        manualDigitalFulfillmentEncrypted: undefined,
      };
    }));

    return res.json(order);
  } catch (err) {
    console.error('Get Order Error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports.getAdminOrderByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'Order ID required' });

    let order = await Order.findOne({ orderId }).populate('items.regionId', 'name').lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    order = await hydrateOrderDigitalFlags(order);
    order.items = order.items.map((item) => ({ ...item, variant: variantSummary(item) }));
    return res.json(order);
  } catch (err) {
    console.error('Admin get order error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

const MANUAL_DIGITAL_FIELDS = ['code', 'loginId', 'username', 'password', 'pin', 'accessUrl', 'expiry', 'serialNumber', 'instructions', 'additionalDetails'];
const normalizeManualDigitalDetails = (details = {}) => Object.fromEntries(
  MANUAL_DIGITAL_FIELDS.map((field) => [field, String(details?.[field] ?? '').trim().slice(0, 4000)]),
);
const hasManualDigitalDetails = (details) => MANUAL_DIGITAL_FIELDS.some((field) => Boolean(details[field]));

module.exports.getAdminDigitalFulfillment = async (req, res) => {
  try {
    let order = await findOrderByRefundKey(req.params.orderId).select('+items.manualDigitalFulfillmentEncrypted').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order = await hydrateOrderDigitalFlags(order);
    const items = (order.items || []).filter((item) => item.isDigitalProduct).map((item) => ({
      itemId: String(item._id),
      name: item.name,
      variantName: item.variantName || [item.color, item.size].filter(Boolean).join(' / '),
      quantity: Number(item.quantity) || 1,
      details: normalizeManualDigitalDetails(readManualDigitalFulfillment(item)),
      sentAt: item.manualDigitalFulfillmentSentAt || null,
    }));
    return res.json({ success: true, orderId: order.orderId, items });
  } catch (error) {
    console.error('Admin digital fulfillment load error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load digital delivery details' });
  }
};

module.exports.updateAdminDigitalFulfillment = async (req, res) => {
  try {
    const submittedItems = req.body?.items;
    if (!Array.isArray(submittedItems) || submittedItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Add digital delivery details for at least one item' });
    }
    const order = await findOrderByRefundKey(req.params.orderId).select('+items.manualDigitalFulfillmentEncrypted');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const hydratedOrder = await hydrateOrderDigitalFlags(order);
    const digitalIds = new Set((hydratedOrder.items || []).filter((item) => item.isDigitalProduct).map((item) => String(item._id)));
    const digitalItems = new Map((order.items || []).filter((item) => digitalIds.has(String(item._id))).map((item) => {
      item.isDigitalProduct = true;
      return [String(item._id), item];
    }));
    for (const submitted of submittedItems) {
      const item = digitalItems.get(String(submitted?.itemId || ''));
      if (!item) return res.status(400).json({ success: false, message: 'A selected order item is not a digital product in this order' });
      const details = normalizeManualDigitalDetails(submitted.details);
      const previous = normalizeManualDigitalDetails(readManualDigitalFulfillment(item));
      const changed = JSON.stringify(previous) !== JSON.stringify(details);
      item.manualDigitalFulfillmentEncrypted = hasManualDigitalDetails(details) ? encryptDigitalCode(JSON.stringify(details)) : '';
      if (changed) item.manualDigitalFulfillmentSentAt = null;
    }
    await order.save();
    return res.json({
      success: true,
      items: (order.items || []).filter((item) => item.isDigitalProduct).map((item) => ({
        itemId: String(item._id),
        details: normalizeManualDigitalDetails(readManualDigitalFulfillment(item)),
        sentAt: item.manualDigitalFulfillmentSentAt || null,
      })),
    });
  } catch (error) {
    console.error('Admin digital fulfillment update error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Unable to save digital delivery details' });
  }
};

module.exports.emailAdminDigitalFulfillment = async (req, res) => {
  try {
    const order = await findOrderByRefundKey(req.params.orderId).select('+items.manualDigitalFulfillmentEncrypted');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const hydratedOrder = await hydrateOrderDigitalFlags(order);
    const digitalIds = new Set((hydratedOrder.items || []).filter((item) => item.isDigitalProduct).map((item) => String(item._id)));
    for (const item of order.items || []) if (digitalIds.has(String(item._id))) item.isDigitalProduct = true;
    if (order.paymentStatus !== 'completed') {
      return res.status(409).json({ success: false, message: 'Confirm payment before emailing digital delivery details' });
    }
    const user = await User.findById(order.userId).select('firstName lastName fullName email');
    const result = await sendOrderManualDigitalFulfillment(order, user);
    if (!result.success) return res.status(502).json({ success: false, message: result.message || 'Could not email digital delivery details' });
    return res.json({ success: true, message: `Digital delivery details emailed to ${user.email}` });
  } catch (error) {
    console.error('Admin digital fulfillment email error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Unable to email digital delivery details' });
  }
};

function variantSummary(item) {
  return {
    size: item.size,
    color: item.color,
    measureType: item.measureType,
    unitName: item.unitName,
  };
}

module.exports.getOrders = async (req, res) => {
  try {
    const filter = customerOrdersFilter(req.user?._id);
    if (!filter) return res.status(401).json({ message: 'Login required' });
    const orders = await Order.find(filter).populate('items.regionId', 'name').sort({ createdAt: -1 });
    return res.json(orders);
  } catch (err) {
    console.error('Get Orders Error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports.updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId } = req.params;
    const { orderStatus, paymentStatus } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: 'Order ID required' });
    }

    const allowedOrderStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    const allowedPaymentStatuses = ['pending', 'completed', 'failed', 'refunded'];

    const update = {};
    if (orderStatus && allowedOrderStatuses.includes(orderStatus)) update.orderStatus = orderStatus;
    if (paymentStatus && allowedPaymentStatuses.includes(paymentStatus)) update.paymentStatus = paymentStatus;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'No valid status provided' });
    }

    let updatedOrder;
    let statusChanged = false;
    let paymentStatusChanged = false;
    await session.withTransaction(async () => {
      const existingOrder = await Order.findById(orderId).session(session);
      if (!existingOrder) {
        const notFound = new Error('Order not found');
        notFound.statusCode = 404;
        throw notFound;
      }
      statusChanged = Object.entries(update).some(([field, value]) => existingOrder[field] !== value);
      paymentStatusChanged = Object.prototype.hasOwnProperty.call(update, 'paymentStatus') && existingOrder.paymentStatus !== update.paymentStatus;
      existingOrder.set(update);

      if (existingOrder.paymentStatus === 'completed') {
        existingOrder.loyaltyRewardEarned = await earnOrderReward(existingOrder, session);
      }
      if (['failed', 'refunded'].includes(existingOrder.paymentStatus) || existingOrder.orderStatus === 'cancelled') {
        await reverseOrderLoyalty(existingOrder, session);
        await releaseDigitalCodesForOrder(existingOrder, session);
      }

      updatedOrder = await existingOrder.save({ session });
    });
    
    // Notify via Socket.IO
    notifyOrderUpdate(updatedOrder, 'update');
    
    // Send status-specific emails
    try {
      const user = await User.findById(updatedOrder.userId).lean();
      if (user && user.email) {
        if (updatedOrder.paymentStatus === 'completed' && updatedOrder.items.some((item) => item.isDigitalProduct)) {
          const digitalResult = await sendOrderDigitalCodes(updatedOrder, user);
          if (!digitalResult.success) console.error(`Digital fulfillment email was not sent for order #${updatedOrder.orderId}: ${digitalResult.message}`);
        }
        let emailResult;
        
        if (orderStatus === 'processing' && updatedOrder.emailSent !== 'processing') {
          emailResult = await sendOrderProcessing(updatedOrder, user);
          if (emailResult.success) {
            await Order.findByIdAndUpdate(updatedOrder._id, {
              $set: { emailSent: 'processing' }
            });
            console.log(`✅ Processing email sent for order #${updatedOrder.orderId}`);
          }
        } else if (orderStatus === 'shipped' && updatedOrder.emailSent !== 'shipped') {
          emailResult = await sendOrderShipped(updatedOrder, user);
          if (emailResult.success) {
            await Order.findByIdAndUpdate(updatedOrder._id, {
              $set: { emailSent: 'shipped' }
            });
            console.log(`✅ Shipped email sent for order #${updatedOrder.orderId}`);
          }
        } else if (orderStatus === 'delivered' && updatedOrder.emailSent !== 'delivered') {
          emailResult = await sendOrderDelivered(updatedOrder, user);
          if (emailResult.success) {
            await Order.findByIdAndUpdate(updatedOrder._id, {
              $set: { emailSent: 'delivered' }
            });
            console.log(`✅ Delivered email sent for order #${updatedOrder.orderId}`);
          }
        }
        
        if (emailResult && !emailResult.success) {
          console.log(`⚠️ Failed to send status email for order #${updatedOrder.orderId}: ${emailResult.message}`);
        }
      }
    } catch (emailError) {
      console.error(`❌ Error sending status email for order #${updatedOrder.orderId}:`, emailError.message);
      // Don't fail the status update if email fails
    }

    if (paymentStatusChanged && !Object.prototype.hasOwnProperty.call(update, 'orderStatus')) {
      const { sendAdminOrderNotification } = require('../utils/emailService');
      const user = await User.findById(updatedOrder.userId).lean();
      const adminEmailResult = await sendAdminOrderNotification(updatedOrder, user, 'payment_status_updated');
      if (!adminEmailResult.success) console.warn(`Admin payment status email was not sent for #${updatedOrder.orderId}: ${adminEmailResult.message}`);
    }
    
    return res.json(updatedOrder);
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Update Order Status Error:', err);
    return res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Server error' });
  } finally {
    session.endSession();
  }
};

module.exports.cancelOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId } = req.params;

    if (!orderId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Order ID is required' });
    }

    const order = await Order.findOne({ orderId }).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!ownsOrder(order, req.user?._id)) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!['pending', 'processing'].includes(order.orderStatus)) {
      await session.abortTransaction();
      return res.status(400).json({
        message: `Cannot cancel order with status '${order.orderStatus}'`
      });
    }

    // 🔹 Release inventory items before cancelling order
    if (order.items && order.items.length > 0) {
      const inventoryRelease = await releaseInventoryFromOrder(order.items, 'order_cancelled');
      if (!inventoryRelease.success) {
        console.error('Failed to release inventory on order cancellation:', inventoryRelease.errors);
        // Continue with cancellation even if inventory release fails
      }
    }

    order.orderStatus = 'cancelled';
    order.isActive = false;
    await reverseOrderLoyalty(order, session);
    await releaseDigitalCodesForOrder(order, session);

    const updatedOrder = await order.save({ session });
    await session.commitTransaction();

    notifyOrderUpdate(updatedOrder, 'cancel');

    // Send cancellation email
    try {
      const user = await User.findById(order.userId).lean();
      if (user && user.email) {
        const emailResult = await sendOrderCancelled(updatedOrder, user);
        if (emailResult.success) {
          await Order.findByIdAndUpdate(updatedOrder._id, {
            $set: { emailSent: 'cancelled' }
          });
          console.log(`✅ Cancellation email sent for order #${updatedOrder.orderId}`);
        } else {
          console.log(`⚠️ Failed to send cancellation email for order #${updatedOrder.orderId}: ${emailResult.message}`);
        }
      }
    } catch (emailError) {
      console.error(`❌ Error sending cancellation email for order #${updatedOrder.orderId}:`, emailError.message);
    }

    return res.json({ 
      success: true,
      message: 'Order cancelled successfully',
      order: updatedOrder 
    });

  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Cancel Order Error:', err);
    return res.status(500).json({ 
      success: false,
      message: err.message || 'Failed to cancel order' 
    });
  } finally {
    session.endSession();
  }
};

module.exports.cancelOrderAdmin = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId } = req.params;

    if (!orderId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Order ID is required' });
    }

    const order = await Order.findOne({ orderId }).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!['pending', 'processing'].includes(order.orderStatus)) {
      await session.abortTransaction();
      return res.status(400).json({
        message: `Cannot cancel order with status '${order.orderStatus}'`
      });
    }

    // 🔹 Release inventory items before cancelling order
    if (order.items && order.items.length > 0) {
      const inventoryRelease = await releaseInventoryFromOrder(order.items, 'order_cancelled');
      if (!inventoryRelease.success) {
        console.error('Failed to release inventory on order cancellation:', inventoryRelease.errors);
        // Continue with cancellation even if inventory release fails
      }
    }

    order.orderStatus = 'cancelled';
    order.isActive = false;
    await reverseOrderLoyalty(order, session);
    await releaseDigitalCodesForOrder(order, session);

    const updatedOrder = await order.save({ session });
    await session.commitTransaction();

    notifyOrderUpdate(updatedOrder, 'cancel');

    // Send cancellation email
    try {
      const user = await User.findById(order.userId).lean();
      if (user && user.email) {
        const emailResult = await sendOrderCancelled(updatedOrder, user);
        if (emailResult.success) {
          await Order.findByIdAndUpdate(updatedOrder._id, {
            $set: { emailSent: 'cancelled' }
          });
          console.log(`✅ Cancellation email sent for order #${updatedOrder.orderId}`);
        } else {
          console.log(`⚠️ Failed to send cancellation email for order #${updatedOrder.orderId}: ${emailResult.message}`);
        }
      }
    } catch (emailError) {
      console.error(`❌ Error sending cancellation email for order #${updatedOrder.orderId}:`, emailError.message);
    }

    return res.json({ 
      success: true,
      message: 'Order cancelled successfully',
      order: updatedOrder 
    });

  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Cancel Order Error:', err);
    return res.status(500).json({ 
      success: false,
      message: err.message || 'Failed to cancel order' 
    });
  } finally {
    session.endSession();
  }
};

module.exports.deleteOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId } = req.params;
    if (!orderId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Order ID required' });
    }

    const orderToDelete = await Order.findById(orderId).session(session);
    if (!orderToDelete) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    // 🔹 Release inventory items before deleting order
    let restoredInventoryItems = [];
    if (orderToDelete.items && orderToDelete.items.length > 0) {
      const inventoryRelease = await releaseInventoryFromOrder(orderToDelete.items, 'order_deleted', session);
      if (!inventoryRelease.success) {
        console.error('Failed to release inventory on order deletion:', inventoryRelease.errors);
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: 'Order was not deleted because assigned inventory could not be restored.',
          errors: inventoryRelease.errors,
        });
      }
      restoredInventoryItems = inventoryRelease.releasedItems || [];
    }

    await reverseOrderLoyalty(orderToDelete, session);
    await releaseDigitalCodesForOrder(orderToDelete, session);

    const deletedOrder = await Order.findByIdAndDelete(orderId).session(session);
    if (!deletedOrder) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    await session.commitTransaction();

    const restoredProductIds = [...new Set(restoredInventoryItems.map((item) => String(item.productId)).filter(Boolean))];
    if (restoredProductIds.length) {
      require('./CartController').revalidateCarts({ productIds: restoredProductIds }).catch(() => {});
      if (ioInstance) {
        for (const item of restoredInventoryItems) {
          ioInstance.to('adminRoom').emit('stockUpdate', {
            productId: item.productId,
            variantId: item.variantId,
            size: item.size,
            action: 'increase',
            reason: 'order_deleted',
          });
        }
      }
    }

    // Notify via Socket.IO
    notifyOrderUpdate({ 
      _id: orderId,
      orderId: deletedOrder.orderId,
      deletedAt: new Date(),
      deletedBy: req.user?.id || 'system' 
    }, 'delete');
    
    return res.json({ message: 'Order deleted successfully' });
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Delete Order Error:', err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    session.endSession();
  }
};

// Refund order and release inventory
module.exports.refundOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId } = req.params;
    const { refundReason = 'Admin refund' } = req.body;

    if (!orderId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Order ID is required' });
    }

    const order = await findOrderByRefundKey(orderId, session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check if order can be refunded
    if (order.paymentStatus === 'refunded') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Order is already refunded' });
    }

    if (order.paymentStatus !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ 
        message: `Cannot refund order with payment status '${order.paymentStatus}'` 
      });
    }

    // 🔹 Release inventory items
    if (order.items && order.items.length > 0) {
      const inventoryRelease = await releaseInventoryFromOrder(order.items, 'payment_refunded');
      if (!inventoryRelease.success) {
        console.error('Failed to release inventory on refund:', inventoryRelease.errors);
        // Continue with refund even if inventory release fails
      }
    }

    // Update order status
    order.paymentStatus = 'refunded';
    order.orderStatus = 'cancelled';
    order.isActive = false;
    order.refundAmount = Number(order.grandTotal || order.totalAmount || 0);
    await reverseOrderLoyalty(order, session);
    await releaseDigitalCodesForOrder(order, session);

    // Sync pending refund request (admin refunded directly while a request was open)
    if (order.refundStatus === 'pending') {
      order.refundStatus = 'approved';
      order.refundAdminNote = order.refundAdminNote || refundReason;
      order.refundProcessedAt = new Date();
    }

    const updatedOrder = await order.save({ session });
    await session.commitTransaction();

    // Notify via Socket.IO
    notifyOrderUpdate(updatedOrder, 'update');

    return res.json({ 
      success: true,
      message: 'Order refunded successfully',
      order: updatedOrder,
      refundReason
    });

  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Refund Order Error:', err);
    return res.status(500).json({ 
      success: false,
      message: err.message || 'Failed to refund order' 
    });
  } finally {
    session.endSession();
  }
};

// User: request a refund for their own order
module.exports.requestRefund = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason = '', note = '', refundImage = '', bkashNumber = '' } = req.body;

    if (!orderId) return res.status(400).json({ message: 'Order ID is required' });

    const order = await findOrderByRefundKey(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (String(order.userId) !== String(req.user._id)) {
      return res.status(403).json({ message: 'You can only request a refund for your own orders' });
    }

    if (order.paymentStatus === 'refunded') {
      return res.status(400).json({ message: 'Order is already refunded' });
    }
    if (order.refundStatus === 'pending') {
      return res.status(400).json({ message: 'A refund request is already pending for this order' });
    }
    if (order.refundStatus === 'approved') {
      return res.status(400).json({ message: 'Refund has already been approved for this order' });
    }

    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({ message: 'Please provide a reason for the refund request' });
    }
    const trimmedBkash = String(bkashNumber || '').trim();
    if (!trimmedBkash) {
      return res.status(400).json({ message: 'bKash number is required to receive the refund amount' });
    }

    order.refundStatus = 'pending';
    order.refundReason = trimmedReason;
    order.refundNote = String(note || '').trim();
    order.refundImage = String(refundImage || '').trim();
    order.refundBkashNumber = trimmedBkash;
    order.refundRequestedAt = new Date();
    order.refundAdminNote = '';
    order.refundProcessedAt = null;

    const updatedOrder = await order.save();

    // Sync: notify the admin panel and the user's open pages
    notifyOrderUpdate(updatedOrder, 'update');

    return res.json({
      success: true,
      message: 'Refund request submitted. We will review it shortly.',
      order: updatedOrder,
    });
  } catch (err) {
    console.error('Request Refund Error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

// Admin: approve or reject a user's refund request
module.exports.processRefundRequest = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { action, adminNote = '' } = req.body;

    if (!orderId) return res.status(400).json({ message: 'Order ID is required' });
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: "Action must be 'approve' or 'reject'" });
    }
    if (action === 'reject' && !String(adminNote || '').trim()) {
      return res.status(400).json({ message: 'Admin note is required when rejecting a refund request' });
    }

    const order = await findOrderByRefundKey(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.refundStatus !== 'pending') {
      return res.status(400).json({ message: 'No pending refund request found for this order' });
    }

    order.refundAdminNote = String(adminNote || '').trim();
    order.refundProcessedAt = new Date();

    if (action === 'reject') {
      order.refundStatus = 'rejected';
      const updatedOrder = await order.save();
      notifyOrderUpdate(updatedOrder, 'update');
      return res.json({
        success: true,
        message: 'Refund request rejected',
        order: updatedOrder,
      });
    }

    // Approve: release inventory and mark the money as refunded (when paid)
    if (order.items && order.items.length > 0) {
      const inventoryRelease = await releaseInventoryFromOrder(order.items, 'payment_refunded');
      if (!inventoryRelease.success) {
        console.error('Failed to release inventory on refund approval:', inventoryRelease.errors);
        // Continue with the refund even if inventory release fails
      }
    }

    if (order.paymentStatus === 'completed') {
      order.paymentStatus = 'refunded';
    }
    order.refundAmount = Number(order.grandTotal || order.totalAmount || 0);
    order.refundStatus = 'approved';
    order.orderStatus = 'cancelled';
    order.isActive = false;
    await reverseOrderLoyalty(order);
    await releaseDigitalCodesForOrder(order);

    const updatedOrder = await order.save();
    notifyOrderUpdate(updatedOrder, 'update');

    return res.json({
      success: true,
      message: 'Refund approved successfully',
      order: updatedOrder,
    });
  } catch (err) {
    console.error('Process Refund Request Error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

// Admin: update arbitrary order fields (items, shipping, totals, statuses, payment, address)
module.exports.adminUpdateOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId } = req.params;
    if (!orderId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Order ID required' });
    }

    const isObjectId = mongoose.Types.ObjectId.isValid(orderId);
    const order = isObjectId
      ? await Order.findById(orderId).session(session)
      : await Order.findOne({ orderId }).session(session);

    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    const payload = req.body || {};

    // Items
    if (Array.isArray(payload.items)) {
      // Basic validation
      for (const item of payload.items) {
        if (!item.productId || !item.variantId || !item.name || !item.mainImage) {
          await session.abortTransaction();
          return res.status(400).json({ message: 'Each item must include productId, variantId, name, mainImage' });
        }
      }

      const hydratedItems = await hydrateFinanceItemSnapshots(payload.items.map((item) => ({
        ...item,
        configuration: {
          ...(item.configuration || {}),
          regionId: item.regionId || item.configuration?.regionId || null,
          regionName: item.regionName || item.configuration?.regionName || '',
          color: item.color || item.configuration?.color || '',
          hexCode: item.hexCode || item.configuration?.hexCode || '',
          size: item.size || item.configuration?.size || '',
          measureType: item.measureType || item.configuration?.measureType || '',
          unitName: item.unitName || item.configuration?.unitName || '',
        },
      })), session);

      // 🔹 Release inventory from removed items
      if (order.items && order.items.length > 0) {
        // Find items that are being removed (items that exist in current order but not in new payload)
        const removedItems = order.items.filter(currentItem => {
          return !payload.items.some(newItem => 
            newItem.productId === currentItem.productId.toString() &&
            newItem.variantId === currentItem.variantId.toString() &&
            newItem.size === currentItem.size
          );
        });

        // Release inventory from removed items
        if (removedItems.length > 0) {
          const inventoryRelease = await releaseInventoryFromOrder(removedItems, 'item_removed_from_order');
          if (!inventoryRelease.success) {
            console.error('Failed to release inventory from removed items:', inventoryRelease.errors);
            // Continue with update even if inventory release fails
          } else {
            console.log(`✅ Released inventory from ${removedItems.length} removed items`);
          }
        }
      }

      // 🔹 Update order items without automatic inventory assignment
      await releaseDigitalCodesForOrder(order, session);
      order.items = payload.items.map((item, index) => {
        const snapshot = hydratedItems[index] || item;
        return {
          variantId: item.variantId,
          productId: item.productId,
          regionId: item.regionId || null,
          regionName: item.regionName || '',
          discountApplied: Number(item.discountApplied || 0),
          name: item.name,
          quantity: Number(item.quantity || 1),
          price: Number(item.price || 0),
          mainImage: item.mainImage,
          variantImage: snapshot.variantImage || item.variantImage || item.mainImage || '',
          sku: snapshot.sku || item.sku || '',
          brand: snapshot.brand || item.brand || '',
          categories: snapshot.categories || item.categories || [],
          productSlug: snapshot.productSlug || item.productSlug || '',
          variantName: snapshot.variantName || item.variantName || '',
          hexCode: snapshot.hexCode || item.hexCode || '',
          costPrice: snapshot.costPrice ?? item.costPrice ?? null,
          originalPrice: item.originalPrice ?? item.price,
          discountPrice: item.discountPrice ?? null,
          barcode: item.barcode || '',
          size: item.size,
          color: item.color,
          measureType: item.measureType,
          unitName: item.unitName,
          configuration: {
            regionId: item.regionId || null,
            regionName: item.regionName || '',
            color: item.color || '',
            hexCode: item.hexCode || '',
            size: item.size || '',
            measureType: item.measureType || '',
            unitName: item.unitName || '',
          },
          assignedInventoryItems: [],
          inventoryAssigned: false
        };
      });
    }

    // Shipping address
    if (payload.shippingAddress && typeof payload.shippingAddress === 'object') {
      order.shippingAddress = {
        fullName: payload.shippingAddress.fullName || order.shippingAddress?.fullName,
        address: payload.shippingAddress.address || order.shippingAddress?.address,
        city: payload.shippingAddress.city || order.shippingAddress?.city,
        postalCode: payload.shippingAddress.postalCode || order.shippingAddress?.postalCode,
        state: payload.shippingAddress.state || order.shippingAddress?.state,
        country: payload.shippingAddress.country || order.shippingAddress?.country,
        phone: payload.shippingAddress.phone || order.shippingAddress?.phone,
      };
    }

    // Payment + statuses
    if (typeof payload.paymentMethod === 'string') {
      order.paymentMethod = payload.paymentMethod;
    }
    if (payload.paymentDetails && typeof payload.paymentDetails === 'object') {
      order.paymentDetails = { ...order.paymentDetails?.toObject?.(), ...payload.paymentDetails };
    }
    if (payload.selectedPaymentMethod && typeof payload.selectedPaymentMethod === 'object') {
      order.selectedPaymentMethod = {
        methodId: payload.selectedPaymentMethod.methodId || order.selectedPaymentMethod?.methodId,
        type: payload.selectedPaymentMethod.type || order.selectedPaymentMethod?.type,
        label: payload.selectedPaymentMethod.label || order.selectedPaymentMethod?.label,
      };
    }
    if (typeof payload.paymentStatus === 'string') {
      // 🔹 Handle inventory release when payment is refunded
      if (payload.paymentStatus === 'refunded' && order.paymentStatus !== 'refunded') {
        if (order.items && order.items.length > 0) {
          const inventoryRelease = await releaseInventoryFromOrder(order.items, 'payment_refunded');
          if (!inventoryRelease.success) {
            console.error('Failed to release inventory on payment refund:', inventoryRelease.errors);
            // Continue with status update even if inventory release fails
          }
        }
      }
      order.paymentStatus = payload.paymentStatus;
    }
    if (typeof payload.orderStatus === 'string') {
      // Handle order reactivation when status changes from cancelled to other status
      const wasCancelled = ['cancelled', 'canceled'].includes(order.orderStatus?.toLowerCase());
      const newStatusNotCancelled = !['cancelled', 'canceled'].includes(payload.orderStatus?.toLowerCase());
      
      if (wasCancelled && newStatusNotCancelled) {
        // Reactivate the order
        order.isActive = true;
        order.emailSent = null; // Reset email sent status to allow new status emails
        console.log(`🔄 Order #${order.orderId} reactivated from cancelled status to ${payload.orderStatus}`);
      }
      
      order.orderStatus = payload.orderStatus;
    }

    // Coupon/discount
    if (payload.couponCode !== undefined) {
      order.couponCode = payload.couponCode || null;
    }
    if (payload.discountAmount !== undefined) {
      order.discountAmount = Number(payload.discountAmount || 0);
    }

    // Shipping
    if (payload.shipping && typeof payload.shipping === 'object') {
      order.shipping = {
        name: payload.shipping.name || order.shipping?.name,
        charge: Number(payload.shipping.charge || order.shipping?.charge || 0),
        estimatedDays: Number(payload.shipping.estimatedDays || order.shipping?.estimatedDays || 0),
      };
    }
    if (payload.shippingCost !== undefined) {
      order.shippingCost = Number(payload.shippingCost || order.shipping?.charge || 0);
    } else {
      // Keep in sync with shipping.charge if provided
      if (payload.shipping && payload.shipping.charge !== undefined) {
        order.shippingCost = Number(payload.shipping.charge) || 0;
      }
    }

    // Calculate totals correctly: Subtotal = sum of items, Grand Total = Subtotal - Discount + Shipping
    const subtotal = order.items.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0), 0);
    const discount = Number(order.discountAmount || 0);
    const shippingCost = Number(order.shippingCost || order.shipping?.charge || 0);
    
    // Always calculate grand total as: subtotal - discount + shipping
    const computedGrandTotal = subtotal - discount + shippingCost;
    
    // Update order totals
    order.totalAmount = subtotal; // totalAmount represents subtotal
    order.grandTotal = computedGrandTotal; // grandTotal = subtotal - discount + shipping

    if (order.paymentStatus === 'completed') {
      order.loyaltyRewardEarned = await earnOrderReward(order, session);
    }
    if (['failed', 'refunded'].includes(order.paymentStatus) || order.orderStatus === 'cancelled') {
      await reverseOrderLoyalty(order, session);
      await releaseDigitalCodesForOrder(order, session);
    }

    const updatedOrder = await order.save({ session });
    await session.commitTransaction();

    if (updatedOrder.paymentStatus === 'completed' && updatedOrder.items.some((item) => item.isDigitalProduct)) {
      try {
        const user = await User.findById(updatedOrder.userId).lean();
        const digitalResult = await sendOrderDigitalCodes(updatedOrder, user);
        if (!digitalResult.success) console.error(`Digital fulfillment email was not sent for order #${updatedOrder.orderId}: ${digitalResult.message}`);
      } catch (digitalError) {
        console.error(`Digital fulfillment email failed for order #${updatedOrder.orderId}:`, digitalError.message);
      }
    }

    // Notify via Socket.IO
    notifyOrderUpdate(updatedOrder, 'update');

    return res.json(updatedOrder);
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Admin Update Order Error:', err);
    return res.status(500).json({ message: err.message || 'Server error' });
  } finally {
    session.endSession();
  }
};

// Assign inventory item to specific order item via scanning
module.exports.assignInventoryToOrderItem = async (req, res) => {
  const MAX_RETRIES = 3;
  let retryCount = 0;

  while (retryCount < MAX_RETRIES) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { orderId } = req.params;
      const { orderItemIndex, inventoryId, scannedCode } = req.body;

    if (!orderId || orderItemIndex === undefined || !inventoryId) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Order ID, order item index, and inventory ID are required' 
      });
    }

    // Find the order
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    // Validate order item index
    if (orderItemIndex < 0 || orderItemIndex >= order.items.length) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Invalid order item index' 
      });
    }

    // Find the inventory item
    const inventoryItem = await Inventory.findById(inventoryId).session(session);
    if (!inventoryItem) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false,
        message: 'Inventory item not found' 
      });
    }

    // Validate inventory availability
    if (inventoryItem.status !== 'active' || inventoryItem.assignedQuantity > 0) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Inventory item is not available for assignment' 
      });
    }

    // Validate that inventory matches the order item requirements
    const orderItem = order.items[orderItemIndex];
    if (inventoryItem.productId.toString() !== orderItem.productId.toString() ||
        inventoryItem.variantId.toString() !== orderItem.variantId.toString() ||
        inventoryItem.size !== orderItem.size) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Inventory item does not match order item specifications' 
      });
    }

    const expectedRegionId = orderItem.regionId || orderItem.configuration?.regionId;
    if (expectedRegionId && inventoryItem.regionId && String(expectedRegionId) !== String(inventoryItem.regionId)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Inventory item region does not match the order item',
      });
    }

    // Check if we already have enough inventory assigned for this item
    const currentAssignedCount = orderItem.assignedInventoryItems?.length || 0;
    if (currentAssignedCount >= orderItem.quantity) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Order item already has sufficient inventory assigned' 
      });
    }

    // Assign the inventory item
    inventoryItem.assignedQuantity = 1;
    inventoryItem.status = 'out_of_stock';
    inventoryItem.availableQuantity = 0;
    await inventoryItem.save({ session });

    // Update product variant stock
    const product = await Product.findById(orderItem.productId).session(session);
    if (product) {
      const variant = product.variants.id(orderItem.variantId);
      if (variant) {
        const configuration = orderItem.configuration || {};
        const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
        const option = variant.options?.find(candidate =>
          same(candidate.size, configuration.size || orderItem.size) &&
          same(candidate.measureType, configuration.measureType || orderItem.measureType) &&
          same(candidate.unitName, configuration.unitName || orderItem.unitName)
        );
        const sizeIndex = (variant.sizes || []).findIndex(size => same(size, configuration.size || orderItem.size));
        if (option || sizeIndex !== -1) {
          // Initialize stockBySize array if it doesn't exist
          if (!variant.stockBySize || variant.stockBySize.length !== variant.sizes.length) {
            variant.stockBySize = new Array(variant.sizes.length).fill(0);
          }
          
          // Decrease stock for the specific size
          if (sizeIndex !== -1 && variant.stockBySize[sizeIndex] > 0) {
            variant.stockBySize[sizeIndex] -= 1;
          }
          if (option && Number(option.stock) > 0) option.stock -= 1;
          
          // Also update legacy stock field for backward compatibility
          variant.stock = variant.options?.length
            ? variant.options.reduce((sum, entry) => sum + Number(entry.stock || 0), 0)
            : (variant.stockBySize || []).reduce((sum, count) => sum + Number(count || 0), 0);
          
          await product.save({ session });
          
          // Emit stock update event
          if (ioInstance) {
            ioInstance.to('adminRoom').emit('stockUpdate', {
              productId: product._id,
              variantId: variant._id,
              size: configuration.size || orderItem.size,
              newStock: option?.stock ?? variant.stockBySize[sizeIndex],
              action: 'decrease'
            });
          }
          
          // Emit inventory assignment event
          emitInventoryAssignment(
            product._id,
            variant._id,
            orderItem.size,
            'inventory_assigned',
            {
              inventoryId: inventoryItem._id,
              orderId: order._id,
              orderItemIndex: orderItemIndex
            }
          );
        }
      }
    }

    // Update the order item
    if (!orderItem.assignedInventoryItems) {
      orderItem.assignedInventoryItems = [];
    }
    orderItem.assignedInventoryItems.push(inventoryItem._id);
    if (!orderItem.assignedInventorySnapshots) orderItem.assignedInventorySnapshots = [];
    orderItem.assignedInventorySnapshots.push({
      inventoryId: inventoryItem._id,
      costPrice: inventoryItem.costPrice ?? null,
      barcode: inventoryItem.barcode || '',
      realBarcode: inventoryItem.realBarcode || '',
      qrCode: inventoryItem.qrCode || '',
      regionId: inventoryItem.regionId || null,
      regionName: inventoryItem.regionName || '',
      color: inventoryItem.color?.name || '',
      size: inventoryItem.size || '',
      imageUri: inventoryItem.imageUri || '',
    });
    const assignedCostSnapshots = orderItem.assignedInventorySnapshots;
    if (assignedCostSnapshots.length >= Number(orderItem.quantity) && assignedCostSnapshots.every((snapshot) => snapshot.costPrice !== null && snapshot.costPrice !== undefined && Number.isFinite(Number(snapshot.costPrice)))) {
      orderItem.costPrice = assignedCostSnapshots.reduce((sum, snapshot) => sum + Number(snapshot.costPrice), 0) / assignedCostSnapshots.length;
    }
    orderItem.inventoryAssigned = orderItem.assignedInventoryItems.length > 0;

    // Save the order
    await order.save({ session });

      // If we reach here, the operation was successful
      await session.commitTransaction();
      session.endSession();
      if (product) require('./CartController').revalidateCarts({ productIds: [product._id] }).catch(() => {});
      
      // Notify via Socket.IO
      try {
        notifyOrderUpdate(order, 'update');
      } catch (notificationError) {
        console.error('Notification error:', notificationError);
        // Don't fail the operation if notification fails
      }

      // Create clean objects for response to avoid circular references
      const cleanOrder = {
        _id: order._id,
        orderId: order.orderId,
        userId: order.userId,
        items: order.items.map(item => ({
          productId: item.productId,
          variantId: item.variantId,
          name: item.name,
          size: item.size,
          color: item.color,
          quantity: item.quantity,
          price: item.price,
          assignedInventoryItems: item.assignedInventoryItems || [],
          inventoryAssigned: item.inventoryAssigned || false
        })),
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt
      };

      const cleanInventory = {
        _id: inventoryItem._id,
        qrCode: inventoryItem.qrCode,
        barcode: inventoryItem.barcode,
        realBarcode: inventoryItem.realBarcode || '',
        status: inventoryItem.status,
        size: inventoryItem.size,
        productId: inventoryItem.productId,
        variantId: inventoryItem.variantId
      };

      return res.json({
        success: true,
        message: 'Inventory item assigned successfully',
        order: cleanOrder,
        assignedInventory: cleanInventory,
        scannedCode: scannedCode
      });

    } catch (err) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();
      
      // Check if it's a write conflict error
      if (err.message && err.message.includes('Write conflict') && retryCount < MAX_RETRIES - 1) {
        retryCount++;
        console.log(`Write conflict detected, retrying... (attempt ${retryCount}/${MAX_RETRIES})`);
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
        continue;
      }
      
      console.error('Assign Inventory Error:', err);
      return res.status(500).json({ 
        success: false,
        message: err.message || 'Failed to assign inventory item' 
      });
    }
  }
  
  // If we get here, all retries failed
  return res.status(500).json({ 
    success: false,
    message: 'Failed to assign inventory item after multiple attempts' 
  });
};

// Remove inventory item from specific order item
module.exports.removeInventoryFromOrderItem = async (req, res) => {
  const MAX_RETRIES = 3;
  let retryCount = 0;

  while (retryCount < MAX_RETRIES) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { orderId } = req.params;
      const { orderItemIndex, inventoryId } = req.body;

      if (!orderId || orderItemIndex === undefined || !inventoryId) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false,
          message: 'Order ID, order item index, and inventory ID are required' 
        });
      }

    // Find the order
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    // Validate order item index
    if (orderItemIndex < 0 || orderItemIndex >= order.items.length) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Invalid order item index' 
      });
    }

    // Find the inventory item
    const inventoryItem = await Inventory.findById(inventoryId).session(session);
    if (!inventoryItem) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false,
        message: 'Inventory item not found' 
      });
    }

    // Get the order item
    const orderItem = order.items[orderItemIndex];
    
    // Check if the inventory is actually assigned to this order item
    const assignedInventoryIds = orderItem.assignedInventoryItems || [];
    const isAssigned = assignedInventoryIds.some(id => {
      const idStr = id.toString ? id.toString() : String(id);
      const inventoryIdStr = inventoryId.toString ? inventoryId.toString() : String(inventoryId);
      return idStr === inventoryIdStr;
    });
    
    if (!isAssigned) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Inventory item is not assigned to this order item' 
      });
    }

    // Release the inventory item
    inventoryItem.assignedQuantity = 0;
    inventoryItem.status = 'active';
    inventoryItem.availableQuantity = 1;
    await inventoryItem.save({ session });

    // Update product variant stock (increase stock)
    const product = await Product.findById(orderItem.productId).session(session);
    if (product) {
      const variant = product.variants.id(orderItem.variantId);
      if (variant) {
        const configuration = orderItem.configuration || {};
        const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
        const option = variant.options?.find(candidate =>
          same(candidate.size, configuration.size || orderItem.size) &&
          same(candidate.measureType, configuration.measureType || orderItem.measureType) &&
          same(candidate.unitName, configuration.unitName || orderItem.unitName)
        );
        const sizeIndex = (variant.sizes || []).findIndex(size => same(size, configuration.size || orderItem.size));
        if (option || sizeIndex !== -1) {
          // Initialize stockBySize array if it doesn't exist
          if (!variant.stockBySize || variant.stockBySize.length !== variant.sizes.length) {
            variant.stockBySize = new Array(variant.sizes.length).fill(0);
          }
          
          // Increase stock for the specific size
          if (sizeIndex !== -1) variant.stockBySize[sizeIndex] += 1;
          if (option) option.stock = Number(option.stock || 0) + 1;
          
          // Also update legacy stock field for backward compatibility
          variant.stock = variant.options?.length
            ? variant.options.reduce((sum, entry) => sum + Number(entry.stock || 0), 0)
            : (variant.stockBySize || []).reduce((sum, count) => sum + Number(count || 0), 0);
          
          await product.save({ session });
          
          // Emit stock update event
          if (ioInstance) {
            ioInstance.to('adminRoom').emit('stockUpdate', {
              productId: product._id,
              variantId: variant._id,
              size: configuration.size || orderItem.size,
              newStock: option?.stock ?? variant.stockBySize[sizeIndex],
              action: 'increase'
            });
          }
          
          // Emit inventory removal event
          emitInventoryAssignment(
            product._id,
            variant._id,
            orderItem.size,
            'inventory_removed',
            {
              inventoryId: inventoryItem._id,
              orderId: order._id,
              orderItemIndex: orderItemIndex
            }
          );
        }
      }
    }

    // Remove the inventory ID from the order item
    orderItem.assignedInventoryItems = orderItem.assignedInventoryItems.filter(id => {
      const idStr = id.toString ? id.toString() : String(id);
      const inventoryIdStr = inventoryId.toString ? inventoryId.toString() : String(inventoryId);
      return idStr !== inventoryIdStr;
    });
    orderItem.assignedInventorySnapshots = (orderItem.assignedInventorySnapshots || []).filter((snapshot) => String(snapshot.inventoryId) !== String(inventoryId));
    if (orderItem.assignedInventorySnapshots.length > 0 && orderItem.assignedInventorySnapshots.every((snapshot) => snapshot.costPrice !== null && snapshot.costPrice !== undefined && Number.isFinite(Number(snapshot.costPrice)))) {
      orderItem.costPrice = orderItem.assignedInventorySnapshots.reduce((sum, snapshot) => sum + Number(snapshot.costPrice), 0) / orderItem.assignedInventorySnapshots.length;
    }
    orderItem.inventoryAssigned = orderItem.assignedInventoryItems.length > 0;

    // Save the order
    await order.save({ session });

      // If we reach here, the operation was successful
      await session.commitTransaction();
      session.endSession();
      if (product) require('./CartController').revalidateCarts({ productIds: [product._id] }).catch(() => {});
      
      // Notify via Socket.IO
      try {
        notifyOrderUpdate(order, 'update');
      } catch (notificationError) {
        console.error('Notification error:', notificationError);
        // Don't fail the operation if notification fails
      }

      // Create clean objects for response to avoid circular references
      const cleanOrder = {
        _id: order._id,
        orderId: order.orderId,
        userId: order.userId,
        items: order.items.map(item => ({
          productId: item.productId,
          variantId: item.variantId,
          name: item.name,
          size: item.size,
          color: item.color,
          quantity: item.quantity,
          price: item.price,
          assignedInventoryItems: item.assignedInventoryItems || [],
          inventoryAssigned: item.inventoryAssigned || false
        })),
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt
      };

      const cleanInventory = {
        _id: inventoryItem._id,
        qrCode: inventoryItem.qrCode,
        barcode: inventoryItem.barcode,
        status: inventoryItem.status,
        size: inventoryItem.size,
        productId: inventoryItem.productId,
        variantId: inventoryItem.variantId
      };

      return res.json({
        success: true,
        message: 'Inventory item removed successfully',
        order: cleanOrder,
        removedInventory: cleanInventory
      });

    } catch (err) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();
      
      // Check if it's a write conflict error
      if (err.message && err.message.includes('Write conflict') && retryCount < MAX_RETRIES - 1) {
        retryCount++;
        console.log(`Write conflict detected, retrying... (attempt ${retryCount}/${MAX_RETRIES})`);
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
        continue;
      }
      
      console.error('Remove Inventory Error:', err);
      return res.status(500).json({ 
        success: false,
        message: err.message || 'Failed to remove inventory item' 
      });
    }
  }
  
  // If we get here, all retries failed
  return res.status(500).json({ 
    success: false,
    message: 'Failed to remove inventory item after multiple attempts' 
  });
};

// Send order finalization email manually
module.exports.sendOrderFinalizationEmail = async (req, res) => {
  try {
    const { orderId } = req.params;

    // Find the order
    const order = await Order.findById(orderId).populate('userId', 'email fullName');
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Check if user exists
    if (!order.userId || !order.userId.email) {
      return res.status(400).json({
        success: false,
        message: 'User not found or email not available'
      });
    }

    // Send the finalization email
    const emailResult = await sendOrderFinalization(order, order.userId);
    
    if (emailResult.success) {
      // Update the order to mark finalization email as sent
      await Order.findByIdAndUpdate(orderId, {
        $set: { emailSent: 'finalized' }
      });

      return res.json({
        success: true,
        message: 'Order finalization email sent successfully',
        messageId: emailResult.messageId
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Failed to send finalization email',
        error: emailResult.message
      });
    }
  } catch (error) {
    console.error('Error sending order finalization email:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

const invoiceSettingsFrom = (source = {}) => ({
  showLogo: source.showLogo !== 'false' && source.showLogo !== false,
  includeSignature: source.includeSignature !== 'false' && source.includeSignature !== false,
  includeQRCode: source.includeQRCode !== 'false' && source.includeQRCode !== false,
  includeBarcode: source.includeBarcode !== 'false' && source.includeBarcode !== false,
});

const findInvoiceOrder = async (key) => {
  const query = mongoose.isValidObjectId(key)
    ? { $or: [{ _id: key }, { orderId: String(key) }] }
    : { orderId: String(key) };
  const order = await Order.findOne(query)
    .populate('userId', 'email firstName lastName fullName')
    .populate('items.regionId', 'name')
    .populate({
      path: 'items.assignedInventoryItems',
      select: 'barcode realBarcode qrCode imageUri size color regionId regionName variantId productId',
      populate: [
        { path: 'regionId', select: 'name' },
        { path: 'productId', select: 'name mainImage' },
      ],
    });
  if (!order) return null;

  const orderData = order.toObject();
  const productIds = orderData.items.map((item) => item.productId?._id || item.productId).filter(mongoose.isValidObjectId);
  const variantIds = orderData.items.map((item) => item.variantId?._id || item.variantId).filter(mongoose.isValidObjectId);
  const catalogMatch = [];
  if (productIds.length) catalogMatch.push({ _id: { $in: productIds } });
  if (variantIds.length) catalogMatch.push({ 'variants._id': { $in: variantIds } });
  const catalogProducts = catalogMatch.length
    ? await Product.find({ $or: catalogMatch })
      .select('name sku mainImage measureType unitName variants')
      .populate('regionId', 'name')
      .populate('regions', 'name')
      .populate('variants.regionId', 'name')
      .lean()
    : [];
  const byProductId = new Map(catalogProducts.map((product) => [String(product._id), product]));
  const byVariantId = new Map();
  catalogProducts.forEach((product) => (product.variants || []).forEach((variant) => byVariantId.set(String(variant._id), product)));

  orderData.items = orderData.items.map((item) => {
    const productId = item.productId?._id || item.productId;
    const variantId = item.variantId?._id || item.variantId;
    const product = (item.productId && typeof item.productId === 'object' && item.productId.name ? item.productId : null)
      || byProductId.get(String(productId))
      || byVariantId.get(String(variantId));
    return { ...item, productId: product || item.productId };
  });
  return orderData;
};

module.exports.getOrderInvoicePdf = async (req, res) => {
  try {
    const order = await findInvoiceOrder(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const pdf = await createOrderInvoicePdf(order, invoiceSettingsFrom(req.query));
    const safeOrderId = String(order.orderId).replace(/[^a-zA-Z0-9_-]/g, '');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': `inline; filename="BELORELLA_Order_${safeOrderId}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    return res.send(pdf);
  } catch (error) {
    console.error('Error generating order invoice PDF:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate invoice PDF' });
  }
};

module.exports.emailOrderInvoicePdf = async (req, res) => {
  try {
    const order = await findInvoiceOrder(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.userId?.email) return res.status(400).json({ success: false, message: 'Customer email is not available for this order' });

    const pdf = await createOrderInvoicePdf(order, invoiceSettingsFrom(req.body));
    const emailResult = await sendOrderInvoicePdf(order, order.userId, pdf);
    if (!emailResult.success) {
      return res.status(502).json({ success: false, message: emailResult.message || 'Failed to send invoice email' });
    }
    return res.json({
      success: true,
      emailSent: true,
      email: order.userId.email,
      message: `Invoice PDF sent to ${order.userId.email}`,
      messageId: emailResult.messageId,
    });
  } catch (error) {
    console.error('Error emailing order invoice PDF:', error);
    return res.status(500).json({ success: false, message: 'Failed to email invoice PDF' });
  }
};

module.exports.validateCheckout = async (req, res) => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) return res.status(401).json({ message: 'Login required' });

    const cart = await Cart.findOne({ userId }).populate('couponId');
    if (!cart || !cart.items.length) {
      return res.status(200).json({
        ok: false,
        blockers: [{ message: 'Your cart is empty. Add items before checkout.' }],
        items: [], subtotal: 0, discountAmount: 0, orderAmount: 0,
        baseDelivery: 0, deliveryCharge: 0, extraFees: [], extraFeeTotal: 0, grandTotal: 0,
        appliedRules: [], notices: [], cart: null,
      });
    }

    const { refreshCartFromCatalog, recalcCartWithCoupon } = require('./CartController');
    await refreshCartFromCatalog(cart);
    await recalcCartWithCoupon(cart);
    await cart.save();

    const blockers = cart.items
      .filter((item) => !item.isAvailable)
      .map((item) => ({ name: item.name, itemId: item._id, message: item.unavailableReason || 'This cart item is unavailable' }));
    const shippingName = String(req.body?.shippingName || '').trim();
    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const isDigitalOnlyOrder = cart.items.length > 0 && cart.items.every((item) => Boolean(item.isDigitalProduct));
    let shippingMethod = null;
    if (isDigitalOnlyOrder) {
      if (shippingName === DIGITAL_FREE_SHIPPING_NAME) {
        shippingMethod = { name: DIGITAL_FREE_SHIPPING_NAME, charge: 0, estimatedDays: 0 };
      } else {
        blockers.push({ message: 'Digital-only orders use Free Delivery and do not need a courier method.' });
      }
    } else if (shippingName) {
      const Shipping = require('../models/Shipping');
      shippingMethod = await Shipping.findOne({ name: shippingName, isActive: true }).lean();
      if (!shippingMethod) blockers.push({ message: 'Selected shipping method is not available' });
    } else blockers.push({ message: 'Select a shipping method to continue.' });

    const { evaluateCheckoutRules } = require('../utils/checkoutRuleEngine');
    const ruleResult = await evaluateCheckoutRules({
      subtotal: Number(cart.totalAmount || 0),
      discountAmount: Number(cart.discountAmount || 0),
      shippingCharge: Number(shippingMethod?.charge || 0),
      shippingMethodName: shippingMethod?.name || shippingName,
      paymentMethod,
      items: cart.items.map((item) => ({ name: item.name, quantity: Number(item.quantity) || 0, price: Number(item.price) || 0, isDigitalProduct: Boolean(item.isDigitalProduct) })),
    });
    blockers.push(...ruleResult.blockers);

    await cart.populate('items.productId');
    return res.status(200).json({
      ...ruleResult,
      ok: blockers.length === 0,
      blockers,
      shippingMethod: shippingMethod ? {
        name: shippingMethod.name,
        charge: shippingMethod.charge,
        estimatedDays: shippingMethod.estimatedDays,
      } : null,
      couponCode: cart.couponId?.code || null,
      items: cart.items.map((item) => ({
        itemId: item._id,
        productId: item.productId?._id || item.productId,
        configuration: { regionId: item.regionId, variantId: item.variantId, size: item.size, color: item.color, measureType: item.measureType, unitName: item.unitName },
        quantity: item.quantity,
        price: item.price,
        originalPrice: item.originalPrice,
        isAvailable: item.isAvailable,
        unavailableReason: item.unavailableReason,
      })),
      cart,
    });
  } catch (error) {
    console.error('Checkout validation error:', error);
    return res.status(error.statusCode || 500).json({ message: error.message || 'Unable to validate checkout' });
  }
};
