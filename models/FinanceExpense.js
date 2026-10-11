const mongoose = require('mongoose');

const financeExpenseSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  category: { type: String, required: true, trim: true, maxlength: 80 },
  amount: { type: Number, required: true, min: 0.01 },
  date: { type: Date, required: true, index: true },
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
}, { timestamps: true });

financeExpenseSchema.index({ date: -1, category: 1 });

module.exports = mongoose.model('FinanceExpense', financeExpenseSchema);
