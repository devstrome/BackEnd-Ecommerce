const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const applicableProductSchema = new Schema({
  product: {
    type: Schema.Types.ObjectId,
    ref: "Product",
    required: true,
  },
  variants: [
    {
      variantId: {
        type: Schema.Types.ObjectId,
        required: true,
      },
      regionId: {
        type: Schema.Types.ObjectId,
        ref: "Region",
        default: null,
      },
      regionName: {
        type: String,
        default: "",
        trim: true,
      },
      sizes: {
        type: [String],
        required: true,
      },
      color: {
        type: String,
        required: true,
      },
    },
  ],
});

const couponSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
    },
    discount: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    minCartValue: {
      type: Number,
      min: 0,
      default: 0,
    },
    maxDiscountAmount: {
      type: Number,
      min: 0,
      default: null,
    },
    expirationDate: {
      type: Date,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    applicableProducts: [applicableProductSchema],
  },
  { timestamps: true }
);

const Coupon = mongoose.model("Coupon", couponSchema);
module.exports = Coupon;
