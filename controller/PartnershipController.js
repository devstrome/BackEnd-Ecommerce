const Partnership = require('../models/Partnership');
const ProfitDistribution = require('../models/ProfitDistribution');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

const getOrCreate = async () => {
  let doc = await Partnership.findOne();
  if (!doc) doc = await Partnership.create({ partners: [], contributions: [] });
  return doc;
};

const buildState = (doc) => {
  const totalAsset = round2((doc.partners || []).reduce((s, p) => s + (p.totalAmount || 0), 0));
  const partners = (doc.partners || []).map((p) => ({
    _id: p._id,
    name: p.name,
    totalAmount: round2(p.totalAmount || 0),
    percentage: totalAsset > 0 ? round2((p.totalAmount / totalAsset) * 100) : 0,
    createdAt: p.createdAt,
  }));
  const contributions = [...(doc.contributions || [])]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30)
    .map((c) => ({
      _id: c._id,
      partnerId: c.partnerId,
      partner: c.partner,
      amount: round2(c.amount),
      note: c.note,
      createdAt: c.createdAt,
    }));
  return { totalAsset, partners, contributions };
};

// GET /api/partnership — current assets, partners, percentages, history
module.exports.getState = async (req, res) => {
  try {
    const doc = await getOrCreate();
    res.status(200).json(buildState(doc));
  } catch (err) {
    console.error('Partnership getState error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};

// POST /api/partnership/partners — { name, amount? }
module.exports.addPartner = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const amount = Number(req.body.amount) || 0;
    if (!name) return res.status(400).json({ message: 'Partner name is required' });
    if (amount < 0) return res.status(400).json({ message: 'Amount cannot be negative' });

    const doc = await getOrCreate();
    if (doc.partners.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ message: 'A partner with this name already exists' });
    }

    const partner = { name, totalAmount: 0, createdAt: new Date() };
    if (amount > 0) {
      partner.totalAmount = round2(amount);
      doc.contributions.push({ partnerId: partner._id, partner: name, amount: round2(amount), note: 'Initial contribution' });
    }
    doc.partners.push(partner);
    await doc.save();
    res.status(201).json(buildState(doc));
  } catch (err) {
    console.error('Partnership addPartner error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};

// DELETE /api/partnership/partners/:id
module.exports.removePartner = async (req, res) => {
  try {
    const doc = await getOrCreate();
    const partner = doc.partners.id(req.params.id);
    if (!partner) return res.status(404).json({ message: 'Partner not found' });
    doc.partners.pull(req.params.id);
    await doc.save();
    res.status(200).json(buildState(doc));
  } catch (err) {
    console.error('Partnership removePartner error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};

// POST /api/partnership/contributions — { partnerId, amount, note? }
// Adds amount to the partner, updates total asset, all percentages recompute
module.exports.addContribution = async (req, res) => {
  try {
    const { partnerId, note = '' } = req.body;
    const amount = Number(req.body.amount);
    if (!partnerId) return res.status(400).json({ message: 'Partner is required' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than 0' });

    const doc = await getOrCreate();
    const partner = doc.partners.id(partnerId);
    if (!partner) return res.status(404).json({ message: 'Partner not found' });

    partner.totalAmount = round2((partner.totalAmount || 0) + amount);
    doc.contributions.push({ partnerId: partner._id, partner: partner.name, amount: round2(amount), note: String(note || '').trim() });
    await doc.save();
    res.status(201).json(buildState(doc));
  } catch (err) {
    console.error('Partnership addContribution error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};

// GET /api/partnership/profits
module.exports.getProfits = async (req, res) => {
  try {
    const profits = await ProfitDistribution.find().sort({ period: -1 }).limit(36);
    res.status(200).json(profits);
  } catch (err) {
    console.error('Partnership getProfits error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};

// POST /api/partnership/profits — { period: 'YYYY-MM', amount }
// Splits the monthly profit among partners by their current percentages
module.exports.createProfit = async (req, res) => {
  try {
    const period = String(req.body.period || '').trim();
    const amount = Number(req.body.amount);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      return res.status(400).json({ message: 'Period must be in YYYY-MM format' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Profit amount must be greater than 0' });
    }

    const existing = await ProfitDistribution.findOne({ period });
    if (existing) return res.status(400).json({ message: `A distribution for ${period} already exists` });

    const doc = await getOrCreate();
    const state = buildState(doc);
    if (state.totalAsset <= 0 || state.partners.length === 0) {
      return res.status(400).json({ message: 'Add partner assets first — total asset is 0' });
    }

    // Split by percentage; round each share, give rounding remainder to the largest partner
    const shares = state.partners.map((p) => ({
      partnerId: p._id,
      name: p.name,
      percentage: p.percentage,
      amount: round2((amount * p.totalAmount) / state.totalAsset),
    }));
    const shareSum = round2(shares.reduce((s, x) => s + x.amount, 0));
    const remainder = round2(amount - shareSum);
    if (remainder !== 0) {
      let biggest = 0;
      shares.forEach((s, i) => { if (s.amount > shares[biggest].amount) biggest = i; });
      shares[biggest].amount = round2(shares[biggest].amount + remainder);
    }

    const profit = await ProfitDistribution.create({
      period,
      totalProfit: round2(amount),
      totalAssetAtDistribution: state.totalAsset,
      distributions: shares,
      status: 'pending',
    });
    res.status(201).json(profit);
  } catch (err) {
    console.error('Partnership createProfit error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};

// PATCH /api/partnership/profits/:id — { status: 'pending' | 'paid' }
module.exports.updateProfit = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'paid'].includes(status)) {
      return res.status(400).json({ message: 'Status must be pending or paid' });
    }
    const profit = await ProfitDistribution.findById(req.params.id);
    if (!profit) return res.status(404).json({ message: 'Distribution not found' });
    profit.status = status;
    profit.paidAt = status === 'paid' ? new Date() : null;
    await profit.save();
    res.status(200).json(profit);
  } catch (err) {
    console.error('Partnership updateProfit error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};

// DELETE /api/partnership/profits/:id
module.exports.deleteProfit = async (req, res) => {
  try {
    const profit = await ProfitDistribution.findByIdAndDelete(req.params.id);
    if (!profit) return res.status(404).json({ message: 'Distribution not found' });
    res.status(200).json({ message: 'Distribution deleted' });
  } catch (err) {
    console.error('Partnership deleteProfit error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};
