const CheckoutRule = require('../models/CheckoutRule');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const money = (n) => `BDT ${round2(n)}`;

function defaultMessage(rule) {
  const value = Number(rule.value) || 0;
  switch (rule.type) {
    case 'min_order':
      return `Minimum order amount is ${money(value)}. Please add more items to your cart.`;
    case 'max_order':
      return `Maximum order amount is ${money(value)}. Please contact support for bulk orders.`;
    case 'cod_min':
      return `Cash on Delivery requires a minimum order of ${money(value)}. Please choose another payment method or increase your order.`;
    case 'cod_max':
      return `Cash on Delivery is available for orders up to ${money(value)}. Please choose another payment method.`;
    case 'max_qty_per_item':
      return `Maximum ${value} unit(s) allowed per product. Please adjust your cart.`;
    default:
      return rule.name || 'Checkout rule failed';
  }
}

// Pure function: applies a set of rules to a checkout input.
// input: { subtotal, discountAmount, shippingCharge, paymentMethod, items:[{name, quantity}] }
// Returns computed delivery, fees, blockers and applied rules.
function applyCheckoutRules(rules, input = {}) {
  const subtotal = Number(input.subtotal) || 0;
  const discountAmount = Number(input.discountAmount) || 0;
  const baseDelivery = Number(input.shippingCharge) || 0;
  const paymentMethod = String(input.paymentMethod || '');
  const items = Array.isArray(input.items) ? input.items : [];
  const isCod = paymentMethod.toLowerCase().includes('cash');

  // Payable merchandise amount before shipping & fees
  const orderAmount = round2(Math.max(subtotal - discountAmount, 0));

  const sorted = (Array.isArray(rules) ? rules : [])
    .filter(r => r && r.isActive !== false)
    .slice()
    .sort((a, b) => (Number(a.priority) || 10) - (Number(b.priority) || 10));

  const blockers = [];
  const appliedRules = [];
  const notices = [];

  const appliedEntry = (rule) => ({
    ruleId: rule._id ? String(rule._id) : null,
    name: rule.name,
    type: rule.type,
    value: Number(rule.value) || 0,
    message: rule.message || '',
  });

  const block = (rule, customMessage) => {
    blockers.push({
      ruleId: rule._id ? String(rule._id) : null,
      name: rule.name,
      message: (rule.message && rule.message.trim()) || customMessage || defaultMessage(rule),
    });
  };

  // 1) Blocking rules
  for (const rule of sorted) {
    switch (rule.type) {
      case 'min_order':
        if (orderAmount < Number(rule.value)) block(rule);
        break;
      case 'max_order':
        if (orderAmount > Number(rule.value)) block(rule);
        break;
      case 'cod_min':
        if (isCod && orderAmount < Number(rule.value)) block(rule);
        break;
      case 'cod_max':
        if (isCod && orderAmount > Number(rule.value)) block(rule);
        break;
      case 'max_qty_per_item': {
        const limit = Number(rule.value);
        const offender = items.find(it => Number(it?.quantity) > limit);
        if (offender) {
          block(rule, `"${offender.name}" exceeds the limit of ${limit} unit(s) per product.`);
        }
        break;
      }
      default:
        break;
    }
  }

  // 2) Delivery pipeline (free delivery wins; otherwise multiply then add)
  let deliveryCharge = baseDelivery;
  let freeDelivery = false;

  const freeRule = sorted.find(r => r.type === 'free_delivery_above' && orderAmount >= Number(r.value) && baseDelivery > 0);
  if (freeRule) {
    deliveryCharge = 0;
    freeDelivery = true;
    appliedRules.push(appliedEntry(freeRule));
  } else {
    for (const rule of sorted) {
      if (rule.type === 'delivery_multiplier' && Number(rule.value) > 0 && baseDelivery > 0) {
        deliveryCharge = deliveryCharge * Number(rule.value);
        appliedRules.push(appliedEntry(rule));
      }
    }
    for (const rule of sorted) {
      if (rule.type === 'extra_delivery_fee') {
        deliveryCharge = deliveryCharge + Number(rule.value);
        appliedRules.push(appliedEntry(rule));
      }
    }
  }
  deliveryCharge = round2(Math.max(deliveryCharge, 0));

  // 3) Percentage / handling fees
  const extraFees = [];
  for (const rule of sorted) {
    if (rule.type === 'handling_fee_percent' && Number(rule.value) > 0) {
      const amount = round2((orderAmount * Number(rule.value)) / 100);
      if (amount > 0) {
        extraFees.push({
          label: rule.name || 'Handling Fee',
          amount,
          ruleId: rule._id ? String(rule._id) : null,
        });
        appliedRules.push(appliedEntry(rule));
      }
    }
  }
  const extraFeeTotal = round2(extraFees.reduce((sum, f) => sum + f.amount, 0));

  const grandTotal = round2(orderAmount + deliveryCharge + extraFeeTotal);

  // Promo-style notices for thresholds not yet reached (e.g. free delivery)
  for (const rule of sorted) {
    if (rule.type === 'free_delivery_above' && baseDelivery > 0 && orderAmount < Number(rule.value)) {
      notices.push(
        (rule.message && rule.message.trim()) ||
        `Add ${money(Number(rule.value) - orderAmount)} more to get FREE delivery.`
      );
    }
  }

  return {
    ok: blockers.length === 0,
    subtotal: round2(subtotal),
    discountAmount: round2(discountAmount),
    orderAmount,
    baseDelivery: round2(baseDelivery),
    deliveryCharge,
    freeDelivery,
    extraFees,
    extraFeeTotal,
    blockers,
    appliedRules,
    notices,
    grandTotal,
  };
}

// Async wrapper: loads active rules from DB then evaluates.
async function evaluateCheckoutRules(input = {}) {
  const rules = await CheckoutRule.find({ isActive: true })
    .sort({ priority: 1, createdAt: 1 })
    .lean();
  return applyCheckoutRules(rules, input);
}

module.exports = { applyCheckoutRules, evaluateCheckoutRules };
