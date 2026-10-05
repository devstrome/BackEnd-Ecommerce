const axios = require('axios');
const AIChat = require('../models/AIChat');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const embeddingService = require('../utils/embeddingService');

const fmt = v => `BDT${Number(v||0).toFixed(2)}`;
const toN = (v,f=0) => { const n=Number(v); return Number.isFinite(n)?n:f; };

function effectivePrice(p) {
  const d = toN(p?.discountPrice), m = toN(p?.mainPrice);
  return d>0&&d<m ? d : m||d;
}

function totalStock(p) {
  if (!p?.variants?.length) return 0;
  return p.variants.reduce((s,v)=>{
    if (Array.isArray(v?.stockBySize)&&v.stockBySize.length) return s+v.stockBySize.reduce((a,b)=>a+toN(b,0),0);
    return s+toN(v?.stock,0);
  },0);
}

async function findProduct(name) {
  if (!name) return null;
  const c = name.replace(/^[\s,:-]+|[\s,:-]+$/g,''); if(!c) return null;
  let p = await Product.findOne({name:new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i')}).lean(); if(p) return p;
  const t = c.split(/\s+/).filter(w=>w.length>2).slice(0,4);
  if(!t.length) return null;
  return Product.findOne({name:new RegExp(t.map(v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'i')}).lean();
}

// ─── Natural language tool results ─────────────────────────
async function findOrder(userId, msg) {
  const m = msg.match(/\d{10}/); const id = m?m[0]:null;
  if (id) {
    const o = await Order.findOne({orderId:id,userId}).lean();
    if (!o) return `I searched for order #${id} but couldn't find it in your account. Could you double-check the number?`;
    const date = o.createdAt ? new Date(o.createdAt).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) : 'N/A';
    const items = (o.items||[]).map(i=>i.name).filter(Boolean);
    const itemStr = items.length > 3 ? items.slice(0,3).join(', ') + ` and ${items.length-3} more` : items.join(', ');
    return `📦 **Order #${o.orderId}** — Status: *${o.orderStatus}*, Payment: *${o.paymentStatus}*\n💰 Total: ${fmt(o.grandTotal||o.totalAmount)} — Placed on ${date}\n🛒 Items: ${itemStr||'N/A'}`;
  }
  const list = await Order.find({userId}).sort({createdAt:-1}).limit(3).lean();
  if (!list.length) return `You don't have any orders yet. Would you like me to help you find some products instead? 😊`;
  return `Here are your latest orders:\n${list.map((o,i)=>{
    const date = o.createdAt ? new Date(o.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
    const items = (o.items||[]).slice(0,2).map(i=>i.name).filter(Boolean).join(', ');
    return `${i+1}. **#${o.orderId}** — ${o.orderStatus} — ${fmt(o.grandTotal||o.totalAmount)} ${date ? '('+date+')' : ''}${items ? ' — '+items : ''}`;
  }).join('\n')}\n\nWant details on a specific order? Just send me the order number!`;
}

async function compareProds(msg) {
  const parts = msg.split(/\s+vs\.?\s+/i);
  if (parts.length<2) {
    const m = msg.match(/compare\s+(.+?)\s+and\s+(.+)/i);
    if (!m) return `Sure, I can compare products! Just tell me what you'd like to compare, like "Nike Air vs Adidas Run" or "Compare iPhone and Samsung".`;
    parts[0]=m[1]; parts[1]=m[2];
  }
  const [a,b] = await Promise.all([findProduct(parts[0]), findProduct(parts[1])]);
  if (!a||!b) return `I found ${a ? '✓ '+a.name : '✗ ' + parts[0].trim()} and ${b ? '✓ '+b.name : '✗ ' + parts[1].trim()}. Could you be more specific with the product names?`;
  const pa={n:a.name,p:effectivePrice(a),r:toN(a.averageRating,0),s:totalStock(a),b:a.brand||'N/A'};
  const pb={n:b.name,p:effectivePrice(b),r:toN(b.averageRating,0),s:totalStock(b),b:b.brand||'N/A'};
  const cheaper = pa.p < pb.p ? pa.n : pb.p < pa.p ? pb.n : 'Same price';
  const betterRated = pa.r > pb.r ? pa.n : pb.r > pa.r ? pb.n : 'Tie';
  let winner = pa.p < pb.p && pa.r >= pb.r ? pa.n : pb.p < pa.p && pb.r >= pa.r ? pb.n : null;
  let rec = winner ? ` I'd lean toward **${winner}** — great value and quality!` : ' Both have their strengths!';
  return `Here's how they compare:\n\n**${pa.n}**\n💰 ${fmt(pa.p)} | ⭐ ${pa.r.toFixed(1)} rating | 📦 ${pa.s} in stock | 🏷️ ${pa.b}\n\n**${pb.n}**\n💰 ${fmt(pb.p)} | ⭐ ${pb.r.toFixed(1)} rating | 📦 ${pb.s} in stock | 🏷️ ${pb.b}\n\n📊 Cheaper option: ${cheaper}\n📊 Better rated: ${betterRated}${rec}`;
}

async function recommend(userId, msg) {
  const under = msg.match(/(?:under|below|upto|max|within|budget\s*(?:of)?)\s*(?:bdt|tk|\$)?\s*(\d{2,8})/i);
  const maxBudget = under ? toN(under[1]) : null;
  const gender = msg.match(/female|women|woman|girls|her/i)?'Female':msg.match(/male|men|man|boys|him/i)?'Male':null;

  // Try vector semantic search first
  if (embeddingService.isAvailable()) {
    const { results, method } = await embeddingService.searchProductsByQuery(msg, {
      limit: 10, gender, budget: maxBudget ? { max: maxBudget } : undefined,
    });
    if (results.length > 0) {
      const h = maxBudget ? `Here are my top picks under ${fmt(maxBudget)}` : `Here are some recommendations I think you'll love`;
      const tag = gender ? ' for you' : '';
      return `${h}${tag}:\n\n${results.slice(0,5).map((p,i)=>`${i+1}. **${p.name}** — ${fmt(effectivePrice(p))} ⭐ ${toN(p.averageRating,0).toFixed(1)} (${toN(p.totalReviews,0)} reviews)`).join('\n')}\n\nWould you like more details on any of these? 😊`;
    }
  }

  // Fallback: keyword-based search with scoring
  const filter = {}; if(gender) filter.gender=gender;
  const terms = msg.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(t=>t.length>2&&!/recommend|suggest|show|best|under|find|me/.test(t)).slice(0,5);
  if (terms.length) filter.$or = [{name:new RegExp(terms.join('|'),'i')},{brand:new RegExp(terms.join('|'),'i')}];
  const candidates = await Product.find(filter).sort({likesCount:-1,averageRating:-1,createdAt:-1}).limit(80).lean();
  let valid = candidates.filter(p=>{const pr=effectivePrice(p); return pr>0&&(!maxBudget||pr<=maxBudget);});
  if (!valid.length) return maxBudget ? `I couldn't find anything under ${fmt(maxBudget)}. Want to try a different budget or category?` : `I couldn't find anything matching right now. Try a different keyword or category!`;

  const prefs = {cats:new Set(),brands:new Set()};
  try{const u=await User.findById(userId).populate({path:'wishlist',select:'categories brand'}).lean(); if(u?.wishlist) u.wishlist.forEach(p=>{(Array.isArray(p.categories)?p.categories:[]).forEach(c=>prefs.cats.add(String(c).toLowerCase())); if(p.brand)prefs.brands.add(p.brand.toLowerCase());});}catch{}
  const scored = valid.map(p=>{
    const pr=effectivePrice(p), rat=toN(p.averageRating,0), lks=toN(p.likesCount,0), stock=totalStock(p);
    let score=rat*20+lks*0.4+(p.mainPrice>0&&p.discountPrice>0?((p.mainPrice-p.discountPrice)/p.mainPrice)*100:0)*1.8;
    score+=stock>0?Math.min(stock,30):-100;
    const cats=(Array.isArray(p.categories)?p.categories:[]).map(c=>String(c).toLowerCase());
    if(cats.some(c=>prefs.cats.has(c)))score+=15; if(p.brand&&prefs.brands.has(p.brand.toLowerCase()))score+=12;
    return {p,score,pr,stock};
  }).filter(i=>i.stock>0).sort((a,b)=>b.score-a.score).slice(0,5);
  if(!scored.length) return `I found some options but they're out of stock. What's your budget?`;
  const h = maxBudget ? `Here are my top picks under ${fmt(maxBudget)}` : `Here are some recommendations I think you'll love`;
  return `${h}:\n\n${scored.map((i,idx)=>`${idx+1}. **${i.p.name}** — ${fmt(i.pr)} ⭐ ${toN(i.p.averageRating,0).toFixed(1)}`).join('\n')}\n\nWant more details on any? 😊`;
}

const GREETINGS = /^(hi|hello|hey|howdy|good morning|good evening|good afternoon|sup|yo|heya|hii|helloo|helo)\b/i;
const GRATITUDE = /^(thanks|thank you|ty|thx|appreciate it|awesome|great)\b/i;

function detectGreeting(msg) { return GREETINGS.test(msg); }
function detectGratitude(msg) { return GRATITUDE.test(msg); }

const GREETING_REPLIES = [
  "Hey there! 👋 Welcome to BELORELLA. I'm your AI shopping assistant — I can help you track orders, compare products, or find something you'll love. What are you looking for today?",
  "Hi! So glad you're here 😊 I can look up your orders, compare products side by side, or recommend some great finds. Just tell me what you need!",
  "Hello! Ready to help 🚀 Whether it's an order update, product comparison, or just finding the perfect item — I've got you covered. What can I do for you?",
  "Hey! Thanks for stopping by 🙌 I'm here to make your shopping experience smoother. Need to track an order? Compare two products? Or want some personalized recommendations?",
];

const THANKS_REPLIES = [
  "You're welcome! 😊 Anything else I can help with? Orders, comparisons, recommendations — just ask!",
  "Happy to help! 🙌 Let me know if you need anything else — I'm always here.",
  "Anytime! 🎉 If you ever need to track an order, compare products, or get more recommendations, just give me a shout!",
];

const FALLBACK_GENERAL = [
  "I'm not quite sure how to help with that, but I'm great at tracking orders, comparing products, and finding recommendations! Want to try one of those? 😊",
  "Hmm, I'm still learning! 🤔 What I can do for you: track your orders, compare any two products, or find the best picks for you. Which sounds helpful?",
];

// ─── User context gatherer ─────────────────────────────────
async function gatherUserContext(userId) {
  const ctx = { name: '', cartCount: 0, wishlistCount: 0, wishlistItems: [], recentOrders: [] };
  try {
    const user = await User.findById(userId).select('firstName lastName').lean();
    if (user) ctx.name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there';
  } catch {}
  try {
    const userWithWishlist = await User.findById(userId).populate({ path: 'wishlist', select: 'name categories brand mainPrice discountPrice' }).lean();
    if (userWithWishlist?.wishlist) {
      ctx.wishlistItems = userWithWishlist.wishlist;
      ctx.wishlistCount = userWithWishlist.wishlist.length;
    }
  } catch {}
  try {
    const orders = await Order.find({ userId }).sort({ createdAt: -1 }).limit(3).select('orderId orderStatus grandTotal items createdAt').lean();
    ctx.recentOrders = orders.map(o => ({
      id: o.orderId, status: o.orderStatus, total: o.grandTotal,
      date: o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '',
      items: (o.items || []).slice(0, 2).map(i => i.name).filter(Boolean).join(', '),
    }));
  } catch {}
  return ctx;
}

function formatUserContext(ctx) {
  const parts = [`User: ${ctx.name}`];
  if (ctx.cartCount > 0) parts.push(`Cart items: ${ctx.cartCount}`);
  if (ctx.wishlistCount > 0) {
    const names = ctx.wishlistItems.slice(0, 5).map(i => i.name).join(', ');
    parts.push(`Wishlist (${ctx.wishlistCount}): ${names}${ctx.wishlistCount > 5 ? '...' : ''}`);
  }
  if (ctx.recentOrders.length > 0) {
    parts.push(`Recent orders: ${ctx.recentOrders.map(o => `#${o.id} (${o.status})`).join(', ')}`);
  }
  return parts.join(' | ');
}

// ─── LLM system prompt (personalized AI) ───────────────────
function buildSystemPrompt(ctx) {
  const orderStr = ctx.recentOrders.map(function(o) { return '#' + o.id + ' (' + o.status + ')'; }).join(', ') || 'none';
  const wishlistNames = ctx.wishlistItems.slice(0, 5).map(function(i) { return i.name; }).join(', ') || 'none';
  const firstName = ctx.name.split(' ')[0] || 'there';
  const wishlistRef = ctx.wishlistItems.length > 0
    ? 'some great items in your wishlist'
    : 'items you might be interested in';
  const topWishlist = ctx.wishlistItems[0]?.name || 'products';
  return [
    'You are BELORELLA AI — a warm, intelligent shopping assistant. Your personality is like a helpful friend who genuinely knows the user.',
    '',
    '**About the user you are talking to:**',
    '- Name: ' + ctx.name,
    '- Wishlist: ' + ctx.wishlistCount + ' items (' + wishlistNames + ')',
    '- Recent orders: ' + orderStr,
    '',
    '**Your behavior:**',
    '- Use the user\'s name naturally. Example: "Hey ' + firstName + '! I noticed you have ' + wishlistRef + '"',
    '- Reference their wishlist or orders when relevant. Example: "I see you have been looking at ' + topWishlist + ' — here is something similar!"',
    '- If they have not ordered yet, offer to help them find products.',
    '- Respond naturally — like ChatGPT or DeepSeek. No robotic lists.',
    '- When tool data is provided, weave it naturally into your response.',
    '- Keep responses concise: 2-4 sentences.',
    '- Never invent facts — only use information provided.',
    '- Be warm, excited, and helpful.',
  ].join('\n');
}

// ─── Controller ────────────────────────────────────────────
exports.chat = async (req, res) => {
  const userId = req.user?._id;
  if (!userId) return res.status(401).json({ message: 'Please log in first.' });
  const msg = (req.body?.message||'').trim();
  if (!msg) return res.status(400).json({ message: 'Message is required.' });

  try {
    let chat = await AIChat.findOne({userId});
    if (!chat) chat = await AIChat.create({userId,messages:[]});
    chat.messages.push({role:'user',content:msg});

    const lower = msg.toLowerCase();
    const apiKey = process.env.AI_API_KEY;
    const isGreeting = detectGreeting(lower);
    const isThanks = detectGratitude(lower);
    const hasIntent = /(order|track|delivery|shipment|shipping|where is|refund|cancel|compare|vs\.?|versus|difference between|recommend|suggest|best|top|similar|alternative|budget|under|cheap|affordable|find me)/i.test(lower);

    let reply = '';
    let toolResult = '';

    // Only run product/order tools when there's an explicit intent
    if (hasIntent) {
      if (/(order|track|delivery|shipment|shipping|where is|refund|cancel)/i.test(lower)) {
        toolResult = await findOrder(userId, msg);
      } else if (/(compare|vs\.?|versus|difference between)/i.test(lower)) {
        toolResult = await compareProds(msg);
      } else {
        toolResult = await recommend(userId, msg);
      }
    }

    // Gather user context for personalization
    const userCtx = await gatherUserContext(userId);

    // Try LLM first — it handles greetings, chit-chat, rewrites equally well
    if (apiKey) {
      try {
        const hist = chat.messages.slice(-10).map(m=>({role:m.role,content:m.content}));
        const contextMsg = toolResult
          ? `Relevant info:\n${toolResult}\n\nRewrite naturally if it's about orders/products. If user is just chatting, respond naturally.`
          : `Respond naturally to the user in your warm, helpful personality.`;
        const r = await axios.post(process.env.AI_API_URL||'https://api.openai.com/v1/chat/completions', {
          model: process.env.AI_MODEL||'gpt-4o-mini',
          temperature: 0.7,
          max_tokens: 500,
          messages: [
            {role:'system',content: buildSystemPrompt(userCtx)},
            {role:'system',content: contextMsg},
            ...hist.slice(0,-1),
            {role:'user',content: msg},
          ],
        }, {headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},timeout:25000});
        if (r?.data?.choices?.[0]?.message?.content) {
          reply = r.data.choices[0].message.content.trim();
        }
      } catch {}
    }

    // Fallback if no LLM or LLM failed
    if (!reply) {
      if (toolResult) {
        reply = toolResult;
      } else if (isGreeting) {
        reply = GREETING_REPLIES[Math.floor(Math.random() * GREETING_REPLIES.length)];
      } else if (isThanks) {
        reply = THANKS_REPLIES[Math.floor(Math.random() * THANKS_REPLIES.length)];
      } else {
        reply = FALLBACK_GENERAL[Math.floor(Math.random() * FALLBACK_GENERAL.length)];
      }
    }

    chat.messages.push({role:'assistant',content:reply});
    await chat.save();
    return res.json({ reply });
  } catch (err) {
    console.error('AI Assistant error:', err);
    return res.status(500).json({ message: 'Something went wrong.' });
  }
};

exports.history = async (req, res) => {
  const userId = req.user?._id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  const chat = await AIChat.findOne({userId}).lean();
  return res.json({ messages: chat?.messages||[] });
};

exports.clear = async (req, res) => {
  const userId = req.user?._id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  await AIChat.deleteOne({userId});
  return res.json({ cleared: true });
};
