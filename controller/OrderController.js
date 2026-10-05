const Order = require('../models/Order');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const mongoose = require('mongoose');
const { 
  assignInventoryToOrder, 
  releaseInventoryFromOrder, 
  validateInventoryAvailability 
} = require('../utils/inventoryHelpers');
const { sendOrderConfirmation, sendOrderProcessing, sendOrderDelivered, sendOrderCancelled, sendOrderFinalization } = require('../utils/emailService');

// Socket.io instance (set from server.js)
let ioInstance = null;
module.exports.setSocketIO = (io) => {
  ioInstance = io;
};

// Look up an order by its human-readable orderId OR its Mongo _id
// (the admin UI sometimes passes _id, the user UI passes orderId)
const findOrderByRefundKey = async (key, session) => {
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

  const events = {
    create: {
      admin: 'admin:newOrder',
      user: `user:orderUpdate:${order.userId}`,
      dashboard: 'newOrder'
    },
    update: {
      admin: 'admin:updateOrder',
      user: `user:orderUpdate:${order.userId}`,
      dashboard: 'orderStatusUpdate'
    },
    cancel: {
      admin: 'admin:cancelOrder',
      user: `user:orderUpdate:${order.userId}`,
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
      paymentStatus: order.paymentStatus,
      refundStatus: order.refundStatus,
      totalAmount: order.totalAmount,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
    ioInstance.to('adminRoom').emit(event.admin, cleanOrderForSocket);
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
  if (event.user && order.userId) {
    ioInstance.to(`user_${order.userId}`).emit(event.user, {
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

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

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
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    // Free-text search
    if (q && q.trim()) {
      const rx = new RegExp(q.trim(), 'i');
      filter.$or = [
        { orderId: rx },
        { couponCode: rx },
        { 'shippingAddress.fullName': rx },
        { 'items.name': rx },
      ];
    }

    // Sorting
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    // Query + total
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

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

module.exports.createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      userId,
      items,
      totalAmount,
      discountAmount,
      couponCode,
      shippingAddress,
      shipping,
      paymentMethod,
      paymentDetails,
      selectedPaymentMethodId,
    } = req.body;

    if (!userId || !items || !Array.isArray(items) || items.length === 0 ||
      !totalAmount || !shippingAddress || !paymentMethod) {
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

    // Validate items
    for (const item of items) {
      if (!item.variantId || !item.productId || !item.name ||
        typeof item.discountApplied !== 'number' ||
        !item.quantity || !item.price || !item.mainImage ||
        !item.measureType || !item.unitName) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Each item must include required fields' });
      }
    }

    // Verify user exists
    const user = await User.findById(userId).session(session).lean();
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found' });
    }



    // Handle payment method
    let selectedPaymentMethod;
    if (paymentMethod.toLowerCase() === 'cash on delivery' || paymentMethod.toLowerCase() === 'cash') {
      selectedPaymentMethod = {
        methodId: 'cash',
        type: 'Cash on Delivery',
        label: 'Cash on Delivery',
      };
    } else {
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

    const normalizedPaymentMethod = paymentMethod.toLowerCase() === 'cash on delivery'
      ? 'Cash on Delivery'
      : paymentMethod;

    // Validate shipping information
    if (!shipping || !shipping.name || typeof shipping.charge !== 'number') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Valid shipping information is required' });
    }

    // Verify shipping method exists and is active
    const Shipping = require('../models/Shipping');
    const shippingMethod = await Shipping.findOne({ 
      name: shipping.name, 
      isActive: true 
    }).session(session);
    
    if (!shippingMethod) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Selected shipping method is not available' });
    }

    // Use shipping method data for consistency
    const orderShipping = {
      name: shippingMethod.name,
      charge: shippingMethod.charge,
      estimatedDays: shippingMethod.estimatedDays,
    };

    // Apply admin-configured checkout rules (min/max order, COD limits, delivery multiplier, fees...)
    const { evaluateCheckoutRules } = require('../utils/checkoutRuleEngine');
    const ruleEval = await evaluateCheckoutRules({
      subtotal: Number(totalAmount),
      discountAmount: Number(discountAmount || 0),
      shippingCharge: orderShipping.charge,
      paymentMethod: normalizedPaymentMethod,
      items: items.map(i => ({ name: i.name, quantity: Number(i.quantity) || 0 })),
    });

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

    // Create order
    const orderId = await generateOrderId();
    const newOrder = new Order({
      orderId,
      userId,
      items: itemsWithInventory,
      totalAmount, // This is the subtotal
      discountAmount,
      couponCode,
      shippingAddress,
      shipping: orderShipping,
      shippingCost: ruleEval.deliveryCharge,
      extraFees: ruleEval.extraFees,
      extraFeeTotal: ruleEval.extraFeeTotal,
      checkoutRulesApplied: ruleEval.appliedRules,
      grandTotal: ruleEval.grandTotal, // subtotal - discount + delivery + fees
      paymentMethod: normalizedPaymentMethod,
      selectedPaymentMethod,
      paymentDetails,
      paymentStatus: 'pending',
      orderStatus: 'pending',
      isActive: true,
    });

    const savedOrder = await newOrder.save({ session });
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
    return res.status(500).json({ message: err.message || 'Server error' });
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
      paymentMethod: normalizedPaymentMethod,
      items: items.map(i => ({ name: i.name, quantity: Number(i.quantity) || 0 })),
    });

    // Validate status values against model enums
    const validOrderStatus = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    const validPaymentStatus = ['pending', 'completed', 'failed', 'refunded'];
    const finalOrderStatus = validOrderStatus.includes(orderStatus) ? orderStatus : 'pending';
    const finalPaymentStatus = validPaymentStatus.includes(paymentStatus) ? paymentStatus : 'pending';

    const itemsWithInventory = items.map((item) => ({
      ...item,
      assignedInventoryItems: [],
      inventoryAssigned: false,
    }));

    const orderId = await generateOrderId();
    const newOrder = new Order({
      orderId,
      userId,
      items: itemsWithInventory,
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

    const savedOrder = await newOrder.save();
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
    return res.status(500).json({ message: err.message || 'Server error' });
  }
};

module.exports.getOrderByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'Order ID required' });

    const order = await Order.findOne({ orderId }).lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Format items for response
    order.items = order.items.map(item => ({
      ...item,
      variant: {
        size: item.size,
        color: item.color,
        measureType: item.measureType,
        unitName: item.unitName
      }
    }));

    return res.json(order);
  } catch (err) {
    console.error('Get Order Error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports.getOrders = async (req, res) => {
  try {
    const { userId } = req.query;
    const filter = userId && mongoose.Types.ObjectId.isValid(userId) ? { userId } : {};
    const orders = await Order.find(filter).sort({ createdAt: -1 });
    return res.json(orders);
  } catch (err) {
    console.error('Get Orders Error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports.updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId } = req.params;
    const { orderStatus, paymentStatus } = req.body;

    if (!orderId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Order ID required' });
    }

    const allowedOrderStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    const allowedPaymentStatuses = ['pending', 'completed', 'failed', 'refunded'];

    const update = {};
    if (orderStatus && allowedOrderStatuses.includes(orderStatus)) update.orderStatus = orderStatus;
    if (paymentStatus && allowedPaymentStatuses.includes(paymentStatus)) update.paymentStatus = paymentStatus;

    if (Object.keys(update).length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'No valid status provided' });
    }

    const updatedOrder = await Order.findOneAndUpdate(
      { _id: orderId },
      update,
      { new: true, session }
    );

    if (!updatedOrder) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    await session.commitTransaction();
    
    // Notify via Socket.IO
    notifyOrderUpdate(updatedOrder, 'update');
    
    // Send status-specific emails
    try {
      const user = await User.findById(updatedOrder.userId).lean();
      if (user && user.email) {
        let emailResult;
        
        if (orderStatus === 'processing' && updatedOrder.emailSent !== 'processing') {
          emailResult = await sendOrderProcessing(updatedOrder, user);
          if (emailResult.success) {
            await Order.findByIdAndUpdate(updatedOrder._id, {
              $set: { emailSent: 'processing' }
            });
            console.log(`✅ Processing email sent for order #${updatedOrder.orderId}`);
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
    
    return res.json(updatedOrder);
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('Update Order Status Error:', err);
    return res.status(500).json({ message: 'Server error' });
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
    if (orderToDelete.items && orderToDelete.items.length > 0) {
      const inventoryRelease = await releaseInventoryFromOrder(orderToDelete.items, 'order_deleted');
      if (!inventoryRelease.success) {
        console.error('Failed to release inventory on order deletion:', inventoryRelease.errors);
        // Continue with deletion even if inventory release fails
      }
    }

    const deletedOrder = await Order.findByIdAndDelete(orderId).session(session);
    if (!deletedOrder) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Order not found' });
    }

    await session.commitTransaction();

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
    order.refundStatus = 'approved';
    order.orderStatus = 'cancelled';
    order.isActive = false;

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
      order.items = payload.items.map((item) => {
        return {
          variantId: item.variantId,
          productId: item.productId,
          discountApplied: Number(item.discountApplied || 0),
          name: item.name,
          quantity: Number(item.quantity || 1),
          price: Number(item.price || 0),
          mainImage: item.mainImage,
          size: item.size,
          color: item.color,
          measureType: item.measureType,
          unitName: item.unitName,
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

    const updatedOrder = await order.save({ session });
    await session.commitTransaction();

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
        const sizeIndex = variant.sizes.indexOf(orderItem.size);
        if (sizeIndex !== -1) {
          // Initialize stockBySize array if it doesn't exist
          if (!variant.stockBySize) {
            variant.stockBySize = new Array(variant.sizes.length).fill(0);
          }
          
          // Decrease stock for the specific size
          if (variant.stockBySize[sizeIndex] > 0) {
            variant.stockBySize[sizeIndex] -= 1;
          }
          
          // Also update legacy stock field for backward compatibility
          if (variant.stock > 0) {
            variant.stock -= 1;
          }
          
          await product.save({ session });
          
          // Emit stock update event
          if (ioInstance) {
            ioInstance.to('adminRoom').emit('stockUpdate', {
              productId: product._id,
              variantId: variant._id,
              size: orderItem.size,
              newStock: variant.stockBySize[sizeIndex],
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
    orderItem.inventoryAssigned = orderItem.assignedInventoryItems.length > 0;

    // Save the order
    await order.save({ session });

      // If we reach here, the operation was successful
      await session.commitTransaction();
      session.endSession();
      
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
        const sizeIndex = variant.sizes.indexOf(orderItem.size);
        if (sizeIndex !== -1) {
          // Initialize stockBySize array if it doesn't exist
          if (!variant.stockBySize) {
            variant.stockBySize = new Array(variant.sizes.length).fill(0);
          }
          
          // Increase stock for the specific size
          variant.stockBySize[sizeIndex] += 1;
          
          // Also update legacy stock field for backward compatibility
          variant.stock += 1;
          
          await product.save({ session });
          
          // Emit stock update event
          if (ioInstance) {
            ioInstance.to('adminRoom').emit('stockUpdate', {
              productId: product._id,
              variantId: variant._id,
              size: orderItem.size,
              newStock: variant.stockBySize[sizeIndex],
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
    orderItem.inventoryAssigned = orderItem.assignedInventoryItems.length > 0;

    // Save the order
    await order.save({ session });

      // If we reach here, the operation was successful
      await session.commitTransaction();
      session.endSession();
      
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