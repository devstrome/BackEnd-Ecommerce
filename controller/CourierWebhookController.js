const crypto = require('crypto');
const Order = require('../models/Order');
const { isForwardStep } = require('../utils/courier');

// Steadfast webhook token (sent as Bearer + used to sign X-Signature)
const token = () => process.env.STEADFAST_WEBHOOK_TOKEN || '';

// Map Steadfast delivery_status values -> our internal courier statuses
function mapStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'delivered' || s === 'partial_delivered') return 'delivered';
  if (s === 'cancelled') return 'returned';
  if (s === 'unknown') return 'failed';
  if (s === 'pending') return 'booked';
  return null;
}

const rawBody = (buf) => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf || ''));

// POST /api/courier/webhook/steadfast  (mounted BEFORE express.json)
exports.steadfastWebhook = async (req, res) => {
  try {
    const body = rawBody(req.body);
    const secret = token();

    if (secret) {
      // 1) Bearer token check
      const auth = req.get('Authorization') || '';
      if (auth !== `Bearer ${secret}`) return res.sendStatus(401);

      // 2) HMAC-SHA256 signature check (timing safe)
      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
      const given = req.get('X-Signature') || '';
      const a = Buffer.from(expected);
      const b = Buffer.from(given);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
    }

    let event;
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ message: 'Invalid JSON' });
    }

    const type = event.notification_type;
    // Idempotency: retries carry the same Idempotency-Key — safe to re-process
    // (updates below are idempotent by design).

    if (!['delivery_status', 'tracking_update', 'consignment_update'].includes(type)) {
      return res.json({ status: 'ignored', type });
    }

    const consignmentId = event.consignment_id != null ? String(event.consignment_id) : null;
    const invoice = event.invoice ? String(event.invoice) : null;

    const order = await Order.findOne(
      consignmentId
        ? { 'courier.consignmentId': consignmentId }
        : { $or: [{ 'courier.invoice': invoice }, { orderId: invoice }] }
    );
    if (!order) return res.status(200).json({ status: 'ok', note: 'no matching order' });

    const newStatus = mapStatus(event.status);
    order.courier = { ...(order.courier ? order.courier.toObject() : {}) };
    order.courier.lastResponse = event;
    // Ignore stale/out-of-order events (e.g. a late 'pending' after 'delivered')
    if (newStatus && newStatus !== order.courier.status && isForwardStep(order.courier.status, newStatus)) {
      order.courier.status = newStatus;
      if (newStatus === 'delivered' && ['pending', 'processing', 'shipped'].includes(order.orderStatus)) {
        order.orderStatus = 'delivered';
      }
      await order.save();

      // Live-update the admin Courier/Orders pages without a manual refresh
      const io = req.app.get('socketio');
      if (io) {
        io.to('adminRoom').emit('courierStatusUpdate', {
          orderId: order.orderId || order._id,
          id: order._id,
          service: order.courier.service,
          status: order.courier.status,
          trackingNumber: order.courier.trackingNumber,
          updatedAt: new Date(),
        });
      }
    } else {
      // Acknowledge duplicates/stale events without changing anything
      await order.save();
      if (newStatus && isForwardStep(order.courier.status, newStatus) === false) {
        console.log(`Steadfast webhook: ignored stale '${event.status}' for ${order.orderId}`);
      }
    }

    res.json({ status: 'success' });
  } catch (error) {
    // Answer 5xx so Steadfast retries (3 attempts: now, +30s, +2min)
    console.error('Steadfast webhook error:', error.message);
    res.status(500).json({ message: error.message });
  }
};
