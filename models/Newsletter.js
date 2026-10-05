const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const newsletterSchema = new Schema({
  subject: { type: String, required: true, trim: true },
  htmlContent: { type: String, required: true },
  status: { type: String, enum: ['draft', 'sent'], default: 'draft' },
  sentCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  sentAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Newsletter', newsletterSchema, 'newsletters');
