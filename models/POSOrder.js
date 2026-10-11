const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const POSOrderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true,
    required: true
  },
  customer: {
    name: {
      type: String,
      required: true
    },
    phone: {
      type: String
    },
    email: {
      type: String
    },
    address: {
      type: String
    }
  },
  items: [{
    inventoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Inventory',
      required: true
    },
      productId: {
        type: Schema.Types.ObjectId,
        ref: 'Product',
        required: true
      },
      sku: { type: String, default: '' },
      productSlug: { type: String, default: '' },
      brand: { type: String, default: '' },
      categories: { type: [String], default: [] },
      productName: {
      type: String,
      required: true
    },
    variantInfo: {
      size: String,
      color: String,
      barcode: String,
      realBarcode: String,
      measureType: String,
      unitName: String,
      sku: String,
      imageUrl: String,
      qrCode: String,
      variantId: { type: Schema.Types.ObjectId, default: null },
      variantName: String,
      hexCode: String,
      regionId: { type: Schema.Types.ObjectId, ref: 'Region', default: null },
      regionName: String
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0
    },
    discountPrice: {
      type: Number,
      min: 0
    },
    costPrice: { type: Number, min: 0, default: null },
    totalPrice: {
      type: Number,
      required: true,
      min: 0
    },
    scannedBarcode: {
      type: String
    }
  }],
  subtotal: {
    type: Number,
    required: true,
    min: 0
  },
  tax: {
    type: Number,
    default: 0,
    min: 0
  },
  discount: {
    type: Number,
    default: 0,
    min: 0
  },
  total: {
    type: Number,
    required: true,
    min: 0
  },
  loyaltyUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  loyaltyAmountUsed: { type: Number, min: 0, default: 0 },
  giftCodeAmountUsed: { type: Number, min: 0, default: 0 },
  giftCodeRedemptions: [{
    giftCodeId: { type: Schema.Types.ObjectId, ref: 'LoyaltyGiftCode', required: true },
    codeSuffix: { type: String, required: true },
    faceValueBDT: { type: Number, min: 0, required: true },
    appliedBDT: { type: Number, min: 0, required: true },
    balanceCreditedBDT: { type: Number, min: 0, default: 0 },
    redeemedAt: { type: Date, required: true },
  }],
  loyaltyRewardEarned: { type: Number, min: 0, default: 0 },
  amountDue: { type: Number, min: 0, default: 0 },
  refundAmount: { type: Number, min: 0, default: 0 },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'mobile_payment', 'bank_transfer'],
    required: true
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'partially_refunded', 'refunded'],
    default: 'pending'
  },
  orderStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'cancelled', 'refunded'],
    default: 'pending'
  },
  cashier: {
    type: Schema.Types.ObjectId,
    ref: 'Admin',
    required: true
  },
  outlet: {
    type: String,
    required: true,
    default: 'Main Outlet'
  },
  notes: {
    type: String
  },
  scannedItems: [{
    barcode: String,
    scannedAt: {
      type: Date,
      default: Date.now
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

POSOrderSchema.index({ createdAt: -1, orderStatus: 1, paymentStatus: 1 });



module.exports = mongoose.model('POSOrder', POSOrderSchema);
