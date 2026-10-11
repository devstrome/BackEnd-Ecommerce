const mongoose = require('mongoose');

const loyaltyTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  direction: { type: String, enum: ['credit', 'debit'], required: true },
  amountBDT: { type: Number, required: true, min: 0.01 },
  balanceAfterBDT: { type: Number, required: true },
  source: {
    type: String,
    enum: ['gift_code', 'order_reward', 'order_redemption', 'order_refund', 'reward_reversal', 'pos_redemption', 'pos_reward', 'pos_gift_code', 'pos_refund', 'admin_adjustment'],
    required: true,
  },
  referenceId: { type: String, default: '' },
  note: { type: String, default: '', trim: true, maxlength: 300 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  idempotencyKey: { type: String, required: true, unique: true },
}, { timestamps: true });

loyaltyTransactionSchema.index({ userId: 1, createdAt: -1 });
module.exports = mongoose.model('LoyaltyTransaction', loyaltyTransactionSchema);
