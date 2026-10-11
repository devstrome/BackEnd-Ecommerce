const mongoose = require('mongoose');

// 🔹 Individual item in the order
const orderItemSchema = new mongoose.Schema({
  variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  regionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Region', default: null },
  regionName: { type: String, default: '' },
  productSlug: { type: String, default: '' },
  brand: { type: String, default: '' },
  categories: { type: [String], default: [] },
  variantName: { type: String, default: '' },
  variantImage: { type: String, default: '' },
  hexCode: { type: String, default: '' },
  barcode: { type: String, default: '' },
  costPrice: { type: Number, min: 0, default: null },
  originalPrice: { type: Number, min: 0 },
  discountPrice: { type: Number, min: 0, default: null },
  sku: { type: String, default: '' },
  configuration: {
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Region', default: null },
    regionName: { type: String, default: '' },
    color: { type: String, default: '' },
    hexCode: { type: String, default: '' },
    size: { type: String, default: '' },
    measureType: { type: String, default: '' },
    unitName: { type: String, default: '' },
  },
  discountApplied: { type: Number, default: 0 },
  name: { type: String, required: true },
  quantity: { type: Number, required: true },
  price: { type: Number, required: true },
  mainImage: { type: String, required: true },
  size: { type: String },
  color: { type: String },
  measureType: { type: String },
  unitName: { type: String },
  isPreOrder: { type: Boolean, default: false },
  isDigitalProduct: { type: Boolean, default: false },
  digitalCodeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DigitalProductCode' }],
  // Manual digital credentials are encrypted at rest and only returned through
  // authenticated order fulfillment/customer-owner endpoints.
  manualDigitalFulfillmentEncrypted: { type: String, default: '', select: false },
  manualDigitalFulfillmentSentAt: { type: Date, default: null },
  preOrderEstimatedDate: { type: Date, default: null },
  // 🔹 Inventory tracking
  assignedInventoryItems: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Inventory' 
  }], // Array of inventory item IDs assigned to this order item
  assignedInventorySnapshots: [{
    inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory' },
    costPrice: { type: Number, min: 0, default: null },
    barcode: { type: String, default: '' },
    realBarcode: { type: String, default: '' },
    qrCode: { type: String, default: '' },
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Region', default: null },
    regionName: { type: String, default: '' },
    color: { type: String, default: '' },
    size: { type: String, default: '' },
    imageUri: { type: String, default: '' },
    _id: false,
  }],
  inventoryAssigned: { type: Boolean, default: false }, // Track if inventory has been assigned
});

// 🔹 Payment details, varies by method
const paymentDetailsSchema = new mongoose.Schema({
  trxId: { type: String, trim: true }, // For bKash/Nagad
  walletNumberMasked: { type: String, trim: true },
  gatewayTransactionId: { type: String, trim: true },
  codNote: { type: String, trim: true }, // Optional note for Cash on Delivery
}, { _id: false });

// 🔹 Shipping method (per order)
const shippingMethodSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  charge: { type: Number, default: 0 },
  estimatedDays: { type: Number, default: 0 },
}, { _id: false });

// 🔹 Shipping address
const shippingAddressSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  address: { type: String, required: true },
  city: { type: String, required: true },
  postalCode: { type: String, required: true },
  state: { type: String, required: true },
  country: { type: String, required: true },
  phone: { type: String, required: true },
}, { _id: false });

// 🔹 Main order schema
const orderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: [orderItemSchema],
  totalAmount: { type: Number, required: true },
  discountAmount: { type: Number, default: 0 },
  shipping: { type: shippingMethodSchema, default: {} },
  shippingCost: { type: Number, default: 0 },
  // 🔹 Checkout rule extras (handling fees etc. computed by checkout rule engine)
  extraFees: {
    type: [{
      label: { type: String },
      amount: { type: Number },
      ruleId: { type: String },
      _id: false,
    }],
    default: [],
  },
  extraFeeTotal: { type: Number, default: 0 },
  checkoutRulesApplied: {
    type: [{
      ruleId: { type: String },
      name: { type: String },
      type: { type: String },
      value: { type: Number },
      message: { type: String },
      _id: false,
    }],
    default: [],
  },
  grandTotal: { type: Number, default: 0 },
  amountDue: { type: Number, min: 0, default: 0 },
  loyaltyAmountUsed: { type: Number, min: 0, default: 0 },
  loyaltyRewardEarned: { type: Number, min: 0, default: 0 },
  refundAmount: { type: Number, min: 0, default: 0 },
  returnAmount: { type: Number, min: 0, default: 0 },
  couponCode: { type: String, default: null }, // Changed from couponId (ObjectId) to couponCode (String)
  couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null }, // Keep both for backward compatibility
  shippingAddress: shippingAddressSchema,
  paymentMethod: {
    type: String,
    enum: ['bKash', 'Nagad', 'Cash on Delivery', 'Loyalty Balance', 'bkash', 'nagad', 'cash', 'loyalty'],
    required: true,
  },
  selectedPaymentMethod: {
    methodId: { type: String },
    type: { type: String },
    label: { type: String }
  },
  paymentDetails: { type: paymentDetailsSchema, default: {} },
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending',
  },
  orderStatus: {
    type: String,
    enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
    default: 'pending',
  },
  // Set only on newly created orders so older records are not incorrectly
  // presented as new when this notification behavior is enabled.
  isNewForAdmin: { type: Boolean, default: false, index: true },
  // 🔹 Refund request workflow (user requests, admin approves/rejects)
  refundStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected'],
    default: 'none',
  },
refundReason: { type: String, default: '' },
refundNote: { type: String, default: '' },
refundImage: { type: String, default: '' },
refundBkashNumber: { type: String, default: '' },
  refundRequestedAt: { type: Date, default: null },
  refundAdminNote: { type: String, default: '' },
  refundProcessedAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
  // Courier hand-off (two-stage: admin queues from Orders -> dispatches from
  // the Courier page to the actual Pathao/Steadfast API)
  courier: {
    service: { type: String, enum: ['pathao', 'steadfast', 'manual', null], default: null },
    status: {
      type: String,
      enum: ['queued', 'booked', 'picked', 'in_transit', 'delivered', 'returned', 'cancelled', 'failed', null],
      default: null,
    },
    trackingNumber: { type: String, default: null },
    consignmentId: { type: String, default: null },
    invoice: { type: String, default: null },
    codAmount: { type: Number, default: 0 },
    queuedAt: { type: Date, default: null },
    bookedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastResponse: { type: Object, default: null },
  },
  // Email notification tracking
  emailSent: {
    type: String,
    enum: ['confirmation', 'processing', 'shipped', 'delivered', null],
    default: null
  },
}, { timestamps: true });

orderSchema.index({ createdAt: -1, orderStatus: 1, paymentStatus: 1 });

module.exports = mongoose.model('Order', orderSchema);
