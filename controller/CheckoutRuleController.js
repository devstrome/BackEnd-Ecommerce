const CheckoutRule = require('../models/CheckoutRule');
const { evaluateCheckoutRules } = require('../utils/checkoutRuleEngine');
const { emitStoreEvent } = require('../utils/storeEvents');

// Public: active rules (for showing notices/promos, e.g. free delivery threshold)
exports.listActive = async (req, res) => {
  try {
    const rules = await CheckoutRule.find({ isActive: true }).sort({ priority: 1, createdAt: 1 }).lean();
    res.json(rules.map(r => ({ _id: r._id, name: r.name, type: r.type, value: r.value, message: r.message })));
  } catch (err) {
    console.error('Checkout rules list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Public: evaluate rules for the current cart/checkout state
exports.evaluate = async (req, res) => {
  try {
    const result = await evaluateCheckoutRules(req.body || {});
    res.json(result);
  } catch (err) {
    console.error('Checkout rules evaluate error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Admin: list all rules
exports.listAll = async (req, res) => {
  try {
    const rules = await CheckoutRule.find().sort({ priority: 1, createdAt: -1 });
    res.json(rules);
  } catch (err) {
    console.error('Checkout rules admin list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Admin: create rule
exports.create = async (req, res) => {
  try {
    const { name, type, value, message = '', isActive = true, priority = 10 } = req.body;
    if (!name || !type || value === undefined || value === null || value === '') {
      return res.status(400).json({ message: 'name, type and value are required' });
    }
    if (!CheckoutRule.RULE_TYPES.includes(type)) {
      return res.status(400).json({ message: `Invalid rule type. Allowed: ${CheckoutRule.RULE_TYPES.join(', ')}` });
    }
    const numValue = Number(value);
    if (!Number.isFinite(numValue) || numValue < 0) {
      return res.status(400).json({ message: 'value must be a non-negative number' });
    }
    const rule = await CheckoutRule.create({
      name,
      type,
      value: numValue,
      message,
      isActive: !!isActive,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 10,
    });
    emitStoreEvent('checkout_rule_created', { rule });
    res.status(201).json(rule);
  } catch (err) {
    console.error('Checkout rule create error:', err);
    res.status(400).json({ message: err.message || 'Failed to create rule' });
  }
};

// Admin: update rule
exports.update = async (req, res) => {
  try {
    const rule = await CheckoutRule.findById(req.params.id);
    if (!rule) return res.status(404).json({ message: 'Rule not found' });

    const { name, type, value, message, isActive, priority } = req.body;
    if (type !== undefined) {
      if (!CheckoutRule.RULE_TYPES.includes(type)) {
        return res.status(400).json({ message: `Invalid rule type. Allowed: ${CheckoutRule.RULE_TYPES.join(', ')}` });
      }
      rule.type = type;
    }
    if (name !== undefined) rule.name = name;
    if (value !== undefined) {
      const numValue = Number(value);
      if (!Number.isFinite(numValue) || numValue < 0) {
        return res.status(400).json({ message: 'value must be a non-negative number' });
      }
      rule.value = numValue;
    }
    if (message !== undefined) rule.message = message;
    if (isActive !== undefined) rule.isActive = !!isActive;
    if (priority !== undefined && Number.isFinite(Number(priority))) rule.priority = Number(priority);

    await rule.save();
    emitStoreEvent('checkout_rule_updated', { rule });
    res.json(rule);
  } catch (err) {
    console.error('Checkout rule update error:', err);
    res.status(400).json({ message: err.message || 'Failed to update rule' });
  }
};

// Admin: delete rule
exports.remove = async (req, res) => {
  try {
    const rule = await CheckoutRule.findByIdAndDelete(req.params.id);
    if (!rule) return res.status(404).json({ message: 'Rule not found' });
    emitStoreEvent('checkout_rule_deleted', { ruleId: rule._id, name: rule.name });
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('Checkout rule delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};
