const mongoose = require('mongoose');

const PopupAdSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  imageUrl: { type: String, required: true },
  linkUrl: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  isUrgent: { type: Boolean, default: false },
  urgentDurationValue: { type: Number, min: 1, default: 1 },
  urgentDurationUnit: {
    type: String,
    enum: ['seconds', 'minutes', 'hours', 'days', 'weeks'],
    default: 'hours',
  },
  urgentExpiresAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model("PopupAd", PopupAdSchema);
