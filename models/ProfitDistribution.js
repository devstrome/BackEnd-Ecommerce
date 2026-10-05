const mongoose = require('mongoose');

const DistributionShareSchema = new mongoose.Schema({
  partnerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  name: { type: String, required: true },
  percentage: { type: Number, required: true },
  amount: { type: Number, required: true },
});

const ProfitDistributionSchema = new mongoose.Schema(
  {
    period: { type: String, required: true, unique: true }, // 'YYYY-MM'
    totalProfit: { type: Number, required: true, min: 0.01 },
    totalAssetAtDistribution: { type: Number, required: true, min: 0 },
    distributions: [DistributionShareSchema],
    status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ProfitDistribution', ProfitDistributionSchema);
