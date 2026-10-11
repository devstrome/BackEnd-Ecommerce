const mongoose = require('mongoose');

const loyaltyGiftCodeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true, unique: true, index: true },
  // Kept encrypted so authenticated admins can retrieve/copy generated codes later.
  // Redemption continues to use the one-way hash above.
  codeEncrypted: { type: String, select: false },
  codeSuffix: { type: String, required: true },
  amountBDT: { type: Number, required: true, min: 0.01 },
  status: { type: String, enum: ['active', 'redeemed', 'revoked'], default: 'active', index: true },
  expiresAt: { type: Date, default: null },
  redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  redeemedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  batchId: { type: String, required: true, index: true },
}, { timestamps: true });

module.exports = mongoose.model('LoyaltyGiftCode', loyaltyGiftCodeSchema);
