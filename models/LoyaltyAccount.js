const mongoose = require('mongoose');

const loyaltyAccountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  balanceBDT: { type: Number, default: 0, required: true },
  tierName: { type: String, default: '', trim: true, maxlength: 40 },
  // Null means this customer uses the global loyalty earn rate.
  earnRatePercent: { type: Number, default: null, min: 0, max: 100 },
  tierAssignedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('LoyaltyAccount', loyaltyAccountSchema);
