const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { PROVIDERS, isForwardStep } = require('../utils/courier');

// Accept either a Mongo _id or a human-facing order number (e.g. "2386709092").
// findById() THROWS a CastError on non-ObjectId strings, which is why the old
// `findById(x) || findOne({orderId: x})` fallback never ran.
async function findOrder(id) {
  if (!id) return null;
  if (mongoose.isValidObjectId(id)) {
    const byId = await Order.findById(id);
    if (byId) return byId;
  }
  return await Order.findOne({ orderId: id })
    || await Order.findOne({ 'courier.consignmentId': String(id) })
    || await Order.findOne({ 'courier.invoice': String(id) });
}

// ─── Stage 1: admin picks a courier on the Orders page ──────────────────
// Queues the shipment only — no external API call yet.
exports.queueShipment = async (req, res) => {
  try {
    const { orderId, service } = req.body;
    if (!orderId || !service) {
      return res.status(400).json({ success: false, message: 'orderId and service are required' });
    }
    if (!PROVIDERS[service]) {
      return res.status(400).json({ success: false, message: `Unknown courier service '${service}'` });
    }
    const order = await findOrder(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.courier?.status === 'booked') {
      return res.status(400).json({ success: false, message: 'This order is already booked with a courier' });
    }

    order.courier = {
      ...(order.courier ? order.courier.toObject() : {}),
      service,
      status: 'queued',
      queuedAt: new Date(),
      lastError: null,
    };
    await order.save();

    res.json({
      success: true,
      message: `Order queued for ${service}. Dispatch it from the Courier page.`,
      courier: order.courier,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Stage 2: admin dispatches queued shipments to the courier API ──────
exports.dispatchShipment = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await findOrder(id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const service = req.body.service || order.courier?.service;
    if (!service || !PROVIDERS[service]) {
      return res.status(400).json({ success: false, message: 'No valid courier service on this order' });
    }
    if (order.courier?.status === 'booked' && order.courier?.consignmentId) {
      return res.status(400).json({ success: false, message: 'Already dispatched to the courier API' });
    }

    const provider = PROVIDERS[service];
    let result;
    try {
      result = await provider.create(order);
    } catch (err) {
      order.courier = {
        ...(order.courier ? order.courier.toObject() : {}),
        service,
        status: 'failed',
        lastError: err.message,
      };
      await order.save();
      return res.status(502).json({ success: false, message: err.message });
    }

    order.courier = {
      ...(order.courier ? order.courier.toObject() : {}),
      service,
      status: result.status || 'booked',
      trackingNumber: result.trackingNumber,
      consignmentId: result.consignmentId,
      invoice: result.invoice,
      codAmount: order.totalAmount || 0,
      bookedAt: new Date(),
      lastError: null,
      lastResponse: result.raw || null,
    };
    await order.save();

    // Booking with a courier means the parcel is on its way
    if (['pending', 'processing'].includes(order.orderStatus)) {
      order.orderStatus = 'shipped';
      await order.save();
    }

    res.json({
      success: true,
      message: `Dispatched via ${service}`,
      courier: order.courier,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── List shipments (admin Courier page) ────────────────────────────────
exports.listShipments = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const { service, status } = req.query;
    const search = String(req.query.search || req.query.q || '').trim();

    const filter = { 'courier.service': { $exists: true, $ne: null } };
    if (service) filter['courier.service'] = service;
    if (status) filter['courier.status'] = status;

    if (search) {
      const rx = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const or = [
        { orderId: new RegExp(rx, 'i') },
        { 'courier.trackingNumber': new RegExp(rx, 'i') },
        { 'courier.consignmentId': new RegExp(rx, 'i') },
        { 'shippingAddress.fullName': new RegExp(rx, 'i') },
        { 'shippingAddress.phone': new RegExp(rx, 'i') },
        { 'shippingAddress.city': new RegExp(rx, 'i') },
        { 'items.name': new RegExp(rx, 'i') },
      ];
      // brand lives on Product, not on the order item — resolve matches first
      const brandMatches = await Product.find({ brand: new RegExp(rx, 'i') })
        .select('_id').lean();
      if (brandMatches.length) {
        or.push({ 'items.productId': { $in: brandMatches.map(p => p._id) } });
      }
      filter.$or = or;
    }

    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .sort({ 'courier.queuedAt': -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'items.productId', select: 'name brand imageUrl' });

    res.json({
      orders,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      total,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Live tracking from the courier API ─────────────────────────────────
exports.trackShipment = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await findOrder(id);
    if (!order) return res.status(404).json({ message: 'Shipment not found' });
    await order.populate({ path: 'items.productId', select: 'name brand imageUrl' });

    const service = order.courier?.service;
    if (!service || !PROVIDERS[service] || service === 'manual') {
      return res.json({
        tracking: order.courier?.lastResponse || { note: 'No courier API data for this shipment' },
        order,
      });
    }

    try {
      const { tracking, status } = await PROVIDERS[service].track(order);
      // Never let a stale/poll response walk the status backwards
      if (status && status !== order.courier.status && isForwardStep(order.courier.status, status)) {
        order.courier.status = status;
        order.courier.lastResponse = tracking;
        await order.save();
      }
      return res.json({ tracking, order });
    } catch (err) {
      // API unavailable -> fall back to what we know instead of failing hard
      return res.json({ tracking: order.courier?.lastResponse || { note: err.message }, order });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Manual status update (admin Courier page buttons) ──────────────────
exports.updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['queued', 'booked', 'picked', 'in_transit', 'delivered', 'returned', 'cancelled', 'failed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `Invalid status '${status}'` });
    }
    const order = await findOrder(id);
    if (!order) return res.status(404).json({ message: 'Shipment not found' });

    order.courier = { ...(order.courier ? order.courier.toObject() : {}), status };
    await order.save();

    res.json({ success: true, courier: order.courier });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Cancel a shipment with the courier ─────────────────────────────────
// Pathao: calls their cancel endpoint. Steadfast: no cancel API exists, so
// we mark it locally and tell the admin to void it in the Packzy portal.
exports.cancelShipment = async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Shipment not found' });

    const c = order.courier;
    if (!c || !c.status) return res.status(400).json({ success: false, message: 'This order has no courier shipment' });
    if (c.status === 'cancelled') return res.status(400).json({ success: false, message: 'Already cancelled' });
    if (c.status === 'delivered') {
      return res.status(400).json({ success: false, message: 'Cannot cancel — parcel already delivered' });
    }

    const service = c.service;
    let courierCancelled = false;
    let note = null;

    // Only ask the courier API when a consignment actually exists there
    if (c.consignmentId && PROVIDERS[service] && typeof PROVIDERS[service].cancel === 'function') {
      try {
        const result = await PROVIDERS[service].cancel(order);
        courierCancelled = result.supported === true;
        note = result.note || null;
      } catch (err) {
        // API refused the cancel — don't lie about it locally
        return res.status(502).json({ success: false, message: `Courier rejected the cancel: ${err.message}` });
      }
    }

    order.courier = { ...c.toObject(), status: 'cancelled', lastError: null, cancelledAt: new Date() };
    if (order.orderStatus === 'shipped') order.orderStatus = 'processing';
    await order.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to('adminRoom').emit('courierStatusUpdate', {
        orderId: order.orderId || order._id,
        id: order._id,
        service,
        status: 'cancelled',
        updatedAt: new Date(),
      });
    }

    res.json({
      success: true,
      courierCancelled,
      message: courierCancelled
        ? 'Cancelled with the courier.'
        : (note || 'Marked cancelled here. Void it in the courier dashboard if a consignment was already created.'),
      courier: order.courier,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Remove a shipment from the courier queue/list ──────────────────────
// Clears the courier subdoc (and un-ships the order if dispatch is what
// moved it). Does NOT call the courier API to cancel — Pathao/Steadfast
// consignments already created must be voided in their own dashboards.
exports.deleteShipment = async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Shipment not found' });

    const wasBooked = order.courier?.consignmentId || order.courier?.status === 'booked';
    order.courier = undefined;
    // Dispatch is what flips a pending/processing order to shipped — undo it
    if (order.orderStatus === 'shipped') order.orderStatus = 'processing';
    await order.save();

    res.json({
      success: true,
      message: wasBooked
        ? 'Shipment removed. It was already sent to the courier — void it in the courier dashboard if needed.'
        : 'Shipment removed from the courier list.',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Edit recipient address / contact details ───────────────────────────
exports.updateShipment = async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Shipment not found' });

    const p = req.body || {};
    const addr = (order.shippingAddress ? order.shippingAddress.toObject() : {}) || {};
    const updatable = ['fullName', 'address', 'city', 'postalCode', 'state', 'country', 'phone'];
    const changes = [];
    for (const key of updatable) {
      if (p[key] !== undefined && String(p[key]).trim() !== '' && String(p[key]) !== String(addr[key] ?? '')) {
        addr[key] = String(p[key]).trim();
        changes.push(key);
      }
    }
    // address is required by the schema — never blank it out
    if (!String(addr.address || '').trim() || !String(addr.phone || '').trim()) {
      return res.status(400).json({ success: false, message: 'Address and phone are required' });
    }
    if (changes.length) {
      order.shippingAddress = addr;
      await order.save();
    }

    res.json({ success: true, changed: changes, shippingAddress: order.shippingAddress });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
