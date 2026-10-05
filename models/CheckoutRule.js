const mongoose = require('mongoose');

// Allowed checkout rule types
const RULE_TYPES = [
  'min_order',
  'max_order',
  'free_delivery_above',
  'delivery_multiplier',
  'extra_delivery_fee',
  'handling_fee_percent',
  'cod_min',
  'cod_max',
  'max_qty_per_item',
];

const checkoutRuleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: RULE_TYPES },
  value: { type: Number, required: true, min: 0 },
  message: { type: String, default: '' }, // custom customer-facing message (optional)
  isActive: { type: Boolean, default: true },
  priority: { type: Number, default: 10 }, // lower runs first
}, { timestamps: true });

const CheckoutRule = mongoose.model('CheckoutRule', checkoutRuleSchema);
CheckoutRule.RULE_TYPES = RULE_TYPES;

module.exports = CheckoutRule;
