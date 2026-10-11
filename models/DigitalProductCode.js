const mongoose = require('mongoose');

const digitalProductCodeSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  codeHash: { type: String, required: true, unique: true, index: true },
  codeEncrypted: { type: String, required: true, select: false },
  status: { type: String, enum: ['available', 'reserved', 'sent', 'disabled'], default: 'available', index: true },
  reservedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  reservedItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
  reservedAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
}, { timestamps: true });

digitalProductCodeSchema.index({ productId: 1, variantId: 1, status: 1 });
module.exports = mongoose.model('DigitalProductCode', digitalProductCodeSchema);
