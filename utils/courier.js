// Courier provider integrations (Pathao + Steadfast).
// Two-stage flow lives in CourierController:
//   stage 1 = queue from the Orders page, stage 2 = dispatch to the real API here.

const axios = require('axios');

// Forward-only progression. Statuses arrive from three directions (webhook,
// track polling, manual buttons) and any of them can be stale or out of order,
// so a status may never move backwards in this list.
const RANK = {
  queued: 0, booked: 1, picked: 2, in_transit: 3,
  delivered: 4, returned: 5, cancelled: 5, failed: 4,
};

// true when `to` is not a regression away from `from`
const isForwardStep = (from, to) =>
  !(from && RANK[to] != null && RANK[from] != null && RANK[to] < RANK[from]);

const normPhone = (p) => {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.startsWith('880')) return '0' + digits.slice(3);
  return digits;
};

// Shop/sender contact sent with every booking (Pathao `sender_phone`,
// Steadfast `sender_phone`). Overridable via COURIER_SENDER_PHONE.
const SENDER_PHONE = '8801601886367';
const senderPhone = () =>
  String(process.env.COURIER_SENDER_PHONE || SENDER_PHONE).trim();

const shippableItems = (order) => (order?.items || []).filter((item) => !item?.isDigitalProduct);

// ─── Pathao ─────────────────────────────────────────────────────────────
let pathaoToken = null; // { access_token, refresh_token, expiresAt }

const pathaoConfigured = () =>
  Boolean(process.env.PATHAO_BASE_URL && process.env.PATHAO_CLIENT_ID &&
    process.env.PATHAO_CLIENT_SECRET && process.env.PATHAO_USERNAME && process.env.PATHAO_PASSWORD);

async function pathaoTokenRefresh(force = false) {
  if (!pathaoConfigured()) {
    throw new Error('Pathao is not configured (PATHAO_* env vars missing)');
  }
  if (!force && pathaoToken && pathaoToken.expiresAt > Date.now()) return pathaoToken.access_token;

  const { data } = await axios.post(
    `${process.env.PATHAO_BASE_URL}/aladdin/api/v1/issue-token`,
    {
      client_id: process.env.PATHAO_CLIENT_ID,
      client_secret: process.env.PATHAO_CLIENT_SECRET,
      username: process.env.PATHAO_USERNAME,
      password: process.env.PATHAO_PASSWORD,
      grant_type: 'password',
    },
    { timeout: 30000 }
  );
  pathaoToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000,
  };
  return pathaoToken.access_token;
}

async function pathaoRequest(method, url, body) {
  const doRequest = async (token) => axios({
    method,
    url: `${process.env.PATHAO_BASE_URL}${url}`,
    data: body,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  let token = await pathaoTokenRefresh();
  try {
    return await doRequest(token);
  } catch (err) {
    if (err.response?.status === 401) { // expired token -> refresh once
      token = await pathaoTokenRefresh(true);
      return await doRequest(token);
    }
    throw err;
  }
}

function providerError(err, provider) {
  const data = err.response?.data;
  // Some gateways (Steadfast) return a bare JSON string, not an object —
  // so data.message would be undefined and the real reason would be lost.
  let apiMessage;
  if (typeof data === 'string') apiMessage = data;
  else apiMessage = data?.message || data?.error || data?.errors;
  if (apiMessage == null || apiMessage === '') apiMessage = err.message;
  const detail = typeof apiMessage === 'string' ? apiMessage : JSON.stringify(apiMessage);
  const e = new Error(`${provider} API error: ${detail}`);
  e.status = err.response?.status;
  return e;
}

async function pathaoCreateShipment(order) {
  const addr = order.shippingAddress || {};
  const phone = normPhone(addr.phone);
  const items = shippableItems(order);
  if (!items.length) throw new Error('Digital-only orders do not require courier delivery');

  // store_id is REQUIRED (sets the pickup location). Use PATHAO_STORE_ID or
  // resolve the merchant's default/first active store automatically.
  let storeId = Number(process.env.PATHAO_STORE_ID) || null;
  if (!storeId) {
    const storesRes = await pathaoRequest('GET', '/aladdin/api/v1/stores');
    const list = storesRes.data?.data?.data || storesRes.data?.data || [];
    const stores = Array.isArray(list) ? list : [];
    const store = stores.find(s => s.is_default_store) || stores.find(s => s.is_active) || stores[0];
    storeId = store?.store_id ? Number(store.store_id) : null;
    if (!storeId) throw new Error('Pathao: no store found — create a store or set PATHAO_STORE_ID');
  }

  const payload = {
    store_id: storeId,
    merchant_order_id: order.orderId || String(order._id),
    sender_phone: senderPhone(),
    recipient_name: (addr.fullName || 'Customer').slice(0, 100),
    recipient_phone: phone,
    recipient_address: (addr.address || addr.street || 'N/A').slice(0, 220),
    delivery_type: Number(process.env.PATHAO_DELIVERY_TYPE) || 48, // 48 normal / 12 on-demand
    item_type: 2, // 1 document / 2 parcel
    item_quantity: Math.max(1, items.reduce((n, i) => n + (Number(i.quantity) || 1), 0)),
    item_weight: Number(process.env.PATHAO_DEFAULT_WEIGHT) || 0.5, // 0.5 - 10 kg
    item_description: items.map(i => i.name).filter(Boolean).join(', ').slice(0, 200) || 'Parcel',
    amount_to_collect: Math.round(order.paymentMethod && /cash|cod/i.test(order.paymentMethod)
      ? items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0) : 0),
    special_instruction: order.note || undefined,
  };
  if (addr.email) payload.recipient_secondary_phone = undefined;

  try {
    const res = await pathaoRequest('POST', '/aladdin/api/v1/orders', payload);
    const data = res.data?.data || {};
    return {
      ok: true,
      service: 'pathao',
      consignmentId: data.consignment_id != null ? String(data.consignment_id) : null,
      trackingNumber: data.consignment_id != null ? String(data.consignment_id) : null,
      invoice: data.merchant_order_id || payload.merchant_order_id,
      status: 'booked',
      raw: data,
    };
  } catch (err) {
    throw providerError(err, 'Pathao');
  }
}

async function pathaoTrack(shipment) {
  const cid = shipment?.courier?.consignmentId || shipment?.courier?.trackingNumber;
  if (!cid) throw new Error('No Pathao consignment id on this shipment');
  try {
    const res = await pathaoRequest('GET', `/aladdin/api/v1/orders/${encodeURIComponent(cid)}/info`);
    const data = res.data?.data || res.data || {};
    const rawStatus = String(data.order_status || data.order_status_slug || data.status || '').toLowerCase();
    let status = 'booked';
    if (rawStatus.includes('deliver')) status = 'delivered';
    else if (rawStatus.includes('transit') || rawStatus.includes('ride')) status = 'in_transit';
    else if (rawStatus.includes('pick')) status = 'picked';
    else if (rawStatus.includes('return') || rawStatus.includes('cancel')) status = 'returned';
    else if (rawStatus.includes('fail') || rawStatus.includes('hold') || rawStatus.includes('reject')) status = 'failed';
    // 'pending'/'created'/anything else -> stays 'booked'
    return { tracking: data, status };
  } catch (err) {
    throw providerError(err, 'Pathao');
  }
}

// ─── Steadfast ──────────────────────────────────────────────────────────
const steadfastBase = () =>
  (process.env.STEADFAST_BASE_URL || 'https://api.steadfast.com.bd/api/v1').replace(/\/$/, '');

const steadfastConfigured = () =>
  Boolean(process.env.STEADFAST_API_KEY && process.env.STEADFAST_SECRET_KEY);

function steadfastHeaders() {
  return {
    'Api-Key': process.env.STEADFAST_API_KEY,
    'Secret-Key': process.env.STEADFAST_SECRET_KEY,
    'Content-Type': 'application/json',
  };
}

async function steadfastCreateShipment(order) {
  if (!steadfastConfigured()) throw new Error('Steadfast is not configured (STEADFAST_API_KEY / STEADFAST_SECRET_KEY missing)');
  const addr = order.shippingAddress || {};
  const items = shippableItems(order);
  if (!items.length) throw new Error('Digital-only orders do not require courier delivery');
  const payload = {
    invoice: (order.orderId || String(order._id)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || `ORD${Date.now()}`,
    sender_phone: senderPhone(),
    recipient_name: (addr.fullName || 'Customer').slice(0, 100),
    recipient_phone: normPhone(addr.phone),
    recipient_address: (addr.address || addr.street || 'N/A').slice(0, 250),
    cod_amount: order.paymentMethod && /cash|cod/i.test(order.paymentMethod)
      ? items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0) : 0,
    note: order.note || undefined,
    recipient_email: order.email || addr.email || undefined,
    item_description: items.map(i => i.name).filter(Boolean).join(', ').slice(0, 200) || undefined,
    total_lot: Math.max(1, items.length),
    delivery_type: 0, // home delivery
  };
  try {
    const res = await axios.post(`${steadfastBase()}/create_order`, payload, {
      headers: steadfastHeaders(), timeout: 30000,
    });
    const data = res.data?.consignment || res.data || {};
    if (res.data?.status && Number(res.data.status) !== 200) {
      throw new Error(res.data.message || 'Steadfast rejected the shipment');
    }
    return {
      ok: true,
      service: 'steadfast',
      consignmentId: data.consignment_id != null ? String(data.consignment_id) : null,
      trackingNumber: data.tracking_code != null ? String(data.tracking_code) : (data.invoice || payload.invoice),
      invoice: data.invoice || payload.invoice,
      status: 'booked',
      raw: res.data,
    };
  } catch (err) {
    throw providerError(err, 'Steadfast');
  }
}

async function steadfastTrack(shipment) {
  if (!steadfastConfigured()) throw new Error('Steadfast is not configured (STEADFAST_API_KEY / STEADFAST_SECRET_KEY missing)');
  const c = shipment?.courier || {};
  const invoice = c.invoice || (shipment?.orderId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    let res;
    if (c.consignmentId) res = await axios.get(`${steadfastBase()}/status_by_cid/${c.consignmentId}`, { headers: steadfastHeaders(), timeout: 30000 });
    else if (c.trackingNumber) res = await axios.get(`${steadfastBase()}/status_by_trackingcode/${c.trackingNumber}`, { headers: steadfastHeaders(), timeout: 30000 });
    else res = await axios.get(`${steadfastBase()}/status_by_invoice/${encodeURIComponent(invoice)}`, { headers: steadfastHeaders(), timeout: 30000 });

    const data = res.data?.consignment || res.data || {};
    return { tracking: data, status: mapSteadfastStatus(data.status) };
  } catch (err) {
    throw providerError(err, 'Steadfast');
  }
}

// Official Steadfast status reference -> our internal courier statuses
function mapSteadfastStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.startsWith('delivered') || s.startsWith('partial_delivered')) return 'delivered';
  if (s.startsWith('cancelled')) return 'returned';
  if (s === 'exceptional' || s === 'unknown') return 'failed';
  if (s.includes('return')) return 'returned';
  if (s.includes('hold')) return 'booked';
  // pending / in_review / *_approval_pending are not confirmed yet
  return 'booked';
}

// Cancel a consignment at the courier (best effort).
// Pathao exposes POST /orders/{cid}/cancel. Steadfast's public API has no
// cancel endpoint (only create/status/balance/return-request), so it reports
// back that the merchant must cancel in their own portal.
async function pathaoCancel(shipment) {
  const cid = shipment?.courier?.consignmentId || shipment?.courier?.trackingNumber;
  if (!cid) throw new Error('No Pathao consignment id on this shipment');
  const res = await pathaoRequest('POST', `/aladdin/api/v1/orders/${encodeURIComponent(cid)}/cancel`);
  return { supported: true, raw: res.data };
}

async function steadfastCancel() {
  return {
    supported: false,
    note: 'Steadfast has no cancel API — cancel this consignment in the Packzy portal, then confirm here.',
  };
}

const PROVIDERS = {
  pathao: { create: pathaoCreateShipment, track: pathaoTrack, cancel: pathaoCancel, configured: pathaoConfigured },
  steadfast: { create: steadfastCreateShipment, track: steadfastTrack, cancel: steadfastCancel, configured: steadfastConfigured },
};

module.exports = { PROVIDERS, normPhone, isForwardStep, senderPhone, SENDER_PHONE };
