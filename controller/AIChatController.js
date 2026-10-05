const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const AIChat = require('../models/AIChat');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET;

// ─── Inline auth helper ───────────────────────────────────────────
function resolveUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.userId || null;
  } catch { return null; }
}

// ─── Utilities ────────────────────────────────────────────────────
function escapeRegex(v = '') { return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function toNumber(v, f = 0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function fmt(v) { return `BDT${toNumber(v).toFixed(2)}`; }

function effectivePrice(p) {
  const d = toNumber(p?.discountPrice, 0);
  const m = toNumber(p?.mainPrice, 0);
  return d > 0 && d < m ? d : m || d;
}

function extractCats(product) {
  const raw = Array.isArray(product?.categories) ? product.categories : [];
  const out = [];
  raw.forEach(item => {
    if (Array.isArray(item)) { item.forEach(s => out.push(String(s).trim())); return; }
    if (typeof item === 'string') {
      const t = item.trim(); if (!t) return;
      try { const p = JSON.parse(t); if (Array.isArray(p)) { p.forEach(s => out.push(String(s).trim())); return; } } catch {}
      out.push(t);
    }
  });
  return [...new Set(out.filter(Boolean))];
}

function totalStock(product) {
  if (!product || !Array.isArray(product.variants)) return 0;
  return product.variants.reduce((s, v) => {
    if (Array.isArray(v?.stockBySize) && v.stockBySize.length > 0) return s + v.stockBySize.reduce((a, b) => a + toNumber(b, 0), 0);
    return s + toNumber(v?.stock, 0);
  }, 0);
}

function normMsg(v) { return String(v || '').trim(); }

// ─── Intent detection ─────────────────────────────────────────────
function detectIntent(message) {
  const t = String(message || '').toLowerCase();
  return {
    order: /(order|track|tracking|delivery|shipment|shipping|status|where is|refund|cancel)/i.test(t),
    compare: /(compare|comparison|vs\.?|versus|difference between)/i.test(t),
    recommend: /(recommend|suggest|best|top|similar|alternative|budget|under|cheap|affordable|find me)/i.test(t),
    humanSupport: /(human|customer care|customer support|agent|representative|real person|admin)/i.test(t),
  };
}

function extractOrderId(message) {
  const t = String(message || '');
  const m = t.match(/\b\d{10}\b/); if (m) return m[0];
  const g = t.match(/\b\d{8,12}\b/); return g ? g[0] : null;
}

function parseCompareTargets(message) {
  const t = String(message || '').trim();
  let p = t.split(/\s+vs\.?\s+/i); if (p.length >= 2) return [p[0], p[1]].map(v => v.trim()).filter(Boolean).slice(0, 2);
  p = t.match(/compare\s+(.+?)\s+and\s+(.+)/i); if (p) return [p[1], p[2]].map(v => v.trim()).filter(Boolean).slice(0, 2);
  p = t.match(/difference\s+between\s+(.+?)\s+and\s+(.+)/i); if (p) return [p[1], p[2]].map(v => v.trim()).filter(Boolean).slice(0, 2);
  return [];
}

function extractBudget(message) {
  const t = String(message || '').toLowerCase();
  const b = t.match(/between\s*(\d{2,8})\s*(?:and|-|to)\s*(\d{2,8})/i);
  if (b) { const min = toNumber(b[1], 0); const max = toNumber(b[2], 0); if (max >= min && max > 0) return { min, max }; }
  const u = t.match(/(?:under|below|less than|up to|upto|max|maximum|within)\s*(?:bdt|tk|taka|\$)?\s*(\d{2,8})/i);
  if (u) return { min: 0, max: toNumber(u[1], 0) };
  return null;
}

function extractGender(message) {
  const t = String(message || '').toLowerCase();
  if (t.includes('female') || t.includes('women') || t.includes('woman') || t.includes('girls')) return 'Female';
  if (t.includes('male') || t.includes('men') || t.includes('man') || t.includes('boys')) return 'Male';
  if (t.includes('unisex')) return 'Unisex';
  return null;
}

async function findProductLoose(name) {
  if (!name) return null;
  const c = name.replace(/^[\s,:-]+|[\s,:-]+$/g, ''); if (!c) return null;
  let r = new RegExp(escapeRegex(c), 'i');
  let p = await Product.findOne({ name: r }).lean(); if (p) return p;
  const tokens = c.split(/\s+/).map(t => t.trim()).filter(t => t.length > 2).slice(0, 4);
  if (!tokens.length) return null;
  r = new RegExp(tokens.map(escapeRegex).join('|'), 'i');
  return Product.findOne({ name: r }).lean();
}

function summarizeOrder(order) {
  const items = Array.isArray(order.items) ? order.items.slice(0, 3) : [];
  const names = items.map(i => i?.name).filter(Boolean).join(', ');
  const more = Math.max((order.items?.length || 0) - items.length, 0);
  return [
    `Order #${order.orderId}`, `Status: ${order.orderStatus}`,
    `Payment: ${order.paymentStatus}`, `Total: ${fmt(order.grandTotal || order.totalAmount)}`,
    `Date: ${order.createdAt ? new Date(order.createdAt).toLocaleDateString() : 'N/A'}`,
    `Items: ${names || 'N/A'}${more > 0 ? ` +${more} more` : ''}`,
  ].join(' | ');
}

// ─── Tool functions ───────────────────────────────────────────────
async function gatherOrderInsight(userId, msg, actions) {
  const requestedOrderId = extractOrderId(msg);
  if (requestedOrderId) {
    actions.push(`lookup_order:${requestedOrderId}`);
    const order = await Order.findOne({ orderId: requestedOrderId, userId }).lean();
    if (order) return { text: `I found your order. ${summarizeOrder(order)}.` };
    return { text: `I could not find order #${requestedOrderId} in your account.` };
  }
  actions.push('lookup_recent_orders');
  const orders = await Order.find({ userId }).sort({ createdAt: -1 }).limit(3).lean();
  if (!orders.length) return { text: 'I do not see any orders in your account yet.' };
  return { text: `Here are your latest orders:\n${orders.map(o => `- ${summarizeOrder(o)}`).join('\n')}` };
}

async function gatherCompareInsight(msg, actions) {
  const [rawA, rawB] = parseCompareTargets(msg);
  if (!rawA || !rawB) return { text: 'Please tell me two product names to compare, like: "Compare Nike Air vs Adidas Run".' };
  actions.push(`compare:${rawA}_vs_${rawB}`);
  const [a, b] = await Promise.all([findProductLoose(rawA), findProductLoose(rawB)]);
  if (!a || !b) return { text: `Could not find both: ${a?.name || 'none'} / ${b?.name || 'none'}.` };
  const pa = { name: a.name, price: effectivePrice(a), rating: toNumber(a.averageRating, 0), reviews: toNumber(a.totalReviews, 0), stock: totalStock(a), brand: a.brand || 'N/A' };
  const pb = { name: b.name, price: effectivePrice(b), rating: toNumber(b.averageRating, 0), reviews: toNumber(b.totalReviews, 0), stock: totalStock(b), brand: b.brand || 'N/A' };
  const cheaper = pa.price < pb.price ? pa.name : pb.price < pa.price ? pb.name : 'Tie';
  const rated = pa.rating > pb.rating ? pa.name : pb.rating > pa.rating ? pb.name : 'Tie';
  return { text: [
    `Comparison: ${pa.name} vs ${pb.name}`,
    `- ${pa.name}: ${fmt(pa.price)} | rating ${pa.rating.toFixed(1)} (${pa.reviews} rev.) | stock ${pa.stock} | brand ${pa.brand}`,
    `- ${pb.name}: ${fmt(pb.price)} | rating ${pb.rating.toFixed(1)} (${pb.reviews} rev.) | stock ${pb.stock} | brand ${pb.brand}`,
    `- Better price: ${cheaper}`, `- Better rating: ${rated}`,
  ].join('\n') };
}

function extractQueryTerms(message) {
  const t = String(message || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    .filter(t => t.length > 2).filter(t => !['recommend','suggest','show','products','product','best','cheap','under','with','for','please','want','need','find','me','and','the','my','order','orders','track','status','compare','versus','between','from','that','have','price','budget','good','top','new'].includes(t));
  return [...new Set(t)].slice(0, 6);
}

async function gatherUserPrefs(userId) {
  const signals = { categories: new Set(), brands: new Set() };
  try {
    const user = await User.findById(userId).populate({ path: 'wishlist', select: 'categories brand' }).lean();
    if (user?.wishlist) user.wishlist.forEach(p => { extractCats(p).forEach(c => signals.categories.add(c.toLowerCase())); if (p?.brand) signals.brands.add(p.brand.toLowerCase()); });
  } catch {}
  try {
    const orders = await Order.find({ userId }).sort({ createdAt: -1 }).limit(3).lean();
    const pids = []; orders.forEach(o => (o.items || []).forEach(i => { if (i?.productId) pids.push(i.productId); }));
    if (pids.length) { const ps = await Product.find({ _id: { $in: pids } }).select('categories brand').lean(); ps.forEach(p => { extractCats(p).forEach(c => signals.categories.add(c.toLowerCase())); if (p?.brand) signals.brands.add(p.brand.toLowerCase()); }); }
  } catch {}
  return signals;
}

function scoreProduct(product, prefs) {
  const price = effectivePrice(product);
  const rating = toNumber(product.averageRating, 0);
  const likes = toNumber(product.likesCount, 0);
  const reviews = toNumber(product.totalReviews, 0);
  const stock = totalStock(product);
  const disc = product.mainPrice > 0 && product.discountPrice > 0 && product.discountPrice < product.mainPrice ? ((product.mainPrice - product.discountPrice) / product.mainPrice) * 100 : 0;
  let score = rating * 20 + likes * 0.4 + reviews * 0.2 + disc * 1.8;
  score += stock > 0 ? Math.min(stock, 30) : -100;
  const cats = extractCats(product).map(c => c.toLowerCase());
  const brand = String(product.brand || '').toLowerCase();
  if (cats.some(c => prefs.categories.has(c))) score += 15;
  if (brand && prefs.brands.has(brand)) score += 12;
  return score;
}

async function gatherRecommendInsight(userId, msg, actions) {
  const budget = extractBudget(msg);
  const gender = extractGender(msg);
  const terms = extractQueryTerms(msg);
  const filter = {};
  if (gender) filter.gender = gender;
  if (terms.length) filter.$or = [{ name: new RegExp(terms.map(escapeRegex).join('|'), 'i') }, { brand: new RegExp(terms.map(escapeRegex).join('|'), 'i') }, { categories: new RegExp(terms.map(escapeRegex).join('|'), 'i') }];
  actions.push(`recommend:${terms.join(',') || 'general'}`);
  const candidates = await Product.find(filter).sort({ likesCount: -1, averageRating: -1, createdAt: -1 }).limit(80).lean();
  const filtered = candidates.filter(p => { const pr = effectivePrice(p); return pr > 0 && (!budget || (!budget.min || pr >= budget.min) && (!budget.max || pr <= budget.max)); });
  const prefs = await gatherUserPrefs(userId);
  const ranked = filtered.map(p => ({ product: p, score: scoreProduct(p, prefs), price: effectivePrice(p), stock: totalStock(p) })).filter(i => i.stock > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  if (!ranked.length) return { text: 'Could not find in-stock products matching that request. Try a different budget, category, or brand.' };
  const bits = []; if (budget?.max) bits.push(`under ${fmt(budget.max)}`); if (gender) bits.push(`for ${gender.toLowerCase()}`);
  const header = bits.length ? `Top picks ${bits.join(' ')}:` : 'My top recommendations for you:';
  return { text: header + '\n' + ranked.map((i, idx) => `${idx + 1}. ${i.product.name} - ${fmt(i.price)} | rating ${toNumber(i.product.averageRating, 0).toFixed(1)} | stock ${i.stock}`).join('\n') };
}

// ─── LLM / Fallback ───────────────────────────────────────────────
function buildSystemPrompt() {
  return 'You are BELORELLA AI Helper in an ecommerce chatbox. Be concise and accurate. Use tool context provided. If order info is missing ask for order ID. When comparing highlight price, rating, stock. When recommending provide short ranked picks. If user asks for a human suggest switching to Customer Care. Tone: friendly support specialist.';
}

async function callLLM({ message, history, contextBlock }) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const apiUrl = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
  const safeHistory = Array.isArray(history) ? history.filter(h => h && typeof h.content === 'string' && ['user','assistant'].includes(h.role)).slice(-8).map(h => ({ role: h.role, content: h.content })) : [];
  try {
    const res = await axios.post(apiUrl, {
      model, temperature: 0.25, max_tokens: 500,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'system', content: `Tool Context:\n${contextBlock}` },
        ...safeHistory,
        { role: 'user', content: message },
      ],
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    return res?.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

function composeFallback(sections, intents) {
  const blocks = sections.filter(Boolean);
  if (!blocks.length) return 'I can help with order tracking, product comparison, and recommendations. What do you need?';
  let reply = blocks.join('\n\n');
  if (intents.humanSupport) reply += '\n\nIf you prefer, switch to Customer Care mode for a human agent.';
  return reply;
}

// ─── Exports ───────────────────────────────────────────────────────

/** POST /api/ai/chat — send a message, get AI reply */
exports.chatWithAI = async (req, res) => {
  try {
    const userId = resolveUser(req.headers.authorization);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const message = normMsg(req.body?.message);
    if (!message) return res.status(400).json({ message: 'Message is required' });

    // Load or create AI chat room
    let chat = await AIChat.findOne({ userId });
    if (!chat) chat = await AIChat.create({ userId, messages: [] });

    // Append user message
    chat.messages.push({ role: 'user', content: message, createdAt: new Date() });

    // Run tools
    const intents = detectIntent(message);
    const actions = [];
    const sections = [];

    if (intents.order) { const r = await gatherOrderInsight(userId, message, actions); if (r?.text) sections.push(r.text); }
    if (intents.compare) { const r = await gatherCompareInsight(message, actions); if (r?.text) sections.push(r.text); }
    if (intents.recommend || (!intents.order && !intents.compare)) { const r = await gatherRecommendInsight(userId, message, actions); if (r?.text) sections.push(r.text); }

    const contextBlock = sections.join('\n\n');
    let reply = composeFallback(sections, intents);
    let usedModel = false;

    // Build history from stored messages for LLM
    const storedHistory = chat.messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
    try { const r = await callLLM({ message, history: storedHistory.slice(0, -1), contextBlock }); if (r) { reply = r; usedModel = true; } } catch {}

    // Append assistant reply
    chat.messages.push({ role: 'assistant', content: reply, createdAt: new Date() });
    await chat.save();

    return res.json({ mode: 'ai', reply, actions, intents, usedModel });
  } catch (error) {
    console.error('AI chat error:', error);
    return res.status(500).json({ message: 'AI chat error', error: error.message });
  }
};

/** GET /api/ai/chat — fetch full message history */
exports.getChat = async (req, res) => {
  try {
    const userId = resolveUser(req.headers.authorization);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const chat = await AIChat.findOne({ userId }).lean();
    if (!chat) return res.json({ messages: [] });
    return res.json({ messages: chat.messages || [] });
  } catch (error) {
    return res.status(500).json({ message: 'Error fetching AI chat', error: error.message });
  }
};

/** DELETE /api/ai/chat — clear AI conversation history */
exports.deleteChat = async (req, res) => {
  try {
    const userId = resolveUser(req.headers.authorization);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    await AIChat.deleteOne({ userId });
    // Create fresh empty chat for next interaction
    await AIChat.create({ userId, messages: [] });
    return res.json({ message: 'AI chat cleared', fresh: true });
  } catch (error) {
    return res.status(500).json({ message: 'Error deleting AI chat', error: error.message });
  }
};
