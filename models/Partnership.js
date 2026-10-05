const mongoose = require('mongoose');

const PartnerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  totalAmount: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: Date.now },
});

const ContributionSchema = new mongoose.Schema({
  partnerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  partner: { type: String, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

// Singleton document holding all partners and their contribution history
const PartnershipSchema = new mongoose.Schema(
  {
    partners: [PartnerSchema],
    contributions: [ContributionSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Partnership', PartnershipSchema);
