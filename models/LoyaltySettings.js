const mongoose = require('mongoose');

const loyaltySettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  enabled: { type: Boolean, default: true },
  earnRatePercent: { type: Number, default: 1, min: 0, max: 100 },
  maxRedeemPercent: { type: Number, default: 100, min: 0, max: 100 },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('LoyaltySettings', loyaltySettingsSchema);
