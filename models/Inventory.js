const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const InventorySchema = new mongoose.Schema({
  productId: {
    type: Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  variantId: {
    type: Schema.Types.ObjectId,
    required: true
  },
  regionId: { type: Schema.Types.ObjectId, ref: 'Region', default: null },
  regionName: { type: String, default: '' },
  size: {
    type: String,
    required: true
  },
  imageUri: {
    type: String
  },
  color: {
    name: {
      type: String
    },
    hexCode: {
      type: String
    }
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  discountPrice: {
    type: Number,
    min: 0
  },
  costPrice: {
    type: Number,
    min: 0,
    default: null,
  },
  barcode: {
    type: String,
    unique: true,
    required: true
  },
  // Manufacturer/product barcode entered by staff. It is intentionally not
  // unique: the same retail barcode commonly identifies every unit in a SKU.
  realBarcode: {
    type: String,
    trim: true,
    default: '',
    maxlength: 120,
  },
  qrCode: {
    type: String,
    unique: true,
    required: true
  },
  stockQuantity: {
    type: Number,
    required: true,
    min: 0,
    default: 1
  },
  availableQuantity: {
    type: Number,
    default: 1
  },
  assignedQuantity: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'out_of_stock'],
    default: 'active'
  },
  location: {
    warehouse: {
      type: String,
      default: 'Main Warehouse'
    },
    shelf: {
      type: String
    },
    section: {
      type: String
    }
  },
  notes: {
    type: String
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Pre-save middleware to update status based on stock quantity
InventorySchema.pre('save', function(next) {
  // Since each inventory item represents exactly 1 individual item
  // stockQuantity should always be 1, and status depends on assignment
  if (this.assignedQuantity >= this.stockQuantity) {
    this.status = 'out_of_stock';
  } else {
    this.status = 'active';
  }
  
  // Set available quantity (should be 1 if not assigned, 0 if assigned)
  this.availableQuantity = Math.max(0, this.stockQuantity - this.assignedQuantity);
  
  this.lastUpdated = new Date();
  next();
});

// Static method to generate unique barcode
InventorySchema.statics.generateBarcode = async function() {
  const prefix = 'INV';
  const timestamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  const barcode = `${prefix}${timestamp}${random}`;
  
  // Check if barcode already exists
  const existing = await this.findOne({ barcode });
  if (existing) {
    return this.generateBarcode(); // Recursive call if duplicate
  }
  
  return barcode;
};

// Static method to generate unique QR code
InventorySchema.statics.generateQRCode = async function() {
  const prefix = 'QR';
  const timestamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  const qrCode = `${prefix}${timestamp}${random}`;
  
  // Check if QR code already exists
  const existing = await this.findOne({ qrCode });
  if (existing) {
    return this.generateQRCode(); // Recursive call if duplicate
  }
  
  return qrCode;
};

// Index for better query performance
InventorySchema.index({ productId: 1, variantId: 1, size: 1 });
InventorySchema.index({ status: 1 });
InventorySchema.index({ realBarcode: 1 });

module.exports = mongoose.model("Inventory", InventorySchema);
