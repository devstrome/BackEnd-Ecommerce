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
    productName: {
      type: String,
      required: true
    },
    variantInfo: {
      size: String,
      color: String,
      barcode: String,
      measureType: String,
      unitName: String
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
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'mobile_payment', 'bank_transfer'],
    required: true
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
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



module.exports = mongoose.model('POSOrder', POSOrderSchema);
