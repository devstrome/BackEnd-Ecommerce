const Coupon = require("../models/Coupon");
const Product = require("../models/Product");
const { emitStoreEvent } = require("../utils/storeEvents");
const { revalidateCarts } = require("./CartController");

// Create a new coupon
exports.createCoupon = async (req, res) => {
  try {
    const { code, discount, expirationDate, isActive, applicableProducts } = req.body;

    // Check if the coupon code already exists
    const existingCoupon = await Coupon.findOne({ code });
    if (existingCoupon) {
      return res.status(400).json({ message: "Coupon code already exists" });
    }

    // Validate applicable products and variants
    for (const item of applicableProducts) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(400).json({ message: `Product ${item.product} not found` });
      }

      for (const variant of item.variants) {
        const productVariant = product.variants.find((v) => v._id.equals(variant.variantId));
        if (!productVariant) {
          return res.status(400).json({ message: `Variant ${variant.variantId} not found in product ${item.product}` });
        }

        // Validate sizes
        if (!Array.isArray(variant.sizes) || variant.sizes.length === 0) {
          return res.status(400).json({ message: `Sizes are required for variant ${variant.variantId}` });
        }

        // Check if all selected sizes exist in the product variant
        for (const size of variant.sizes) {
          if (!productVariant.sizes.includes(size)) {
            return res.status(400).json({ message: `Size ${size} not found in variant ${variant.variantId}` });
          }
        }
      }
    }

    // Create the coupon
    const coupon = new Coupon({
      code,
      discount,
      expirationDate,
      isActive,
      applicableProducts,
    });

    // Save the coupon to the database
    await coupon.save();

    // Push the new coupon to every open client so admin + storefront lists
    // refresh immediately.
    emitStoreEvent("coupon_created", { coupon });

    res.status(201).json({ message: "Coupon created successfully", coupon });
  } catch (error) {
    res.status(500).json({ message: "Error creating coupon", error: error.message });
  }
};

// Get all coupons
exports.getAllCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find().populate("applicableProducts.product");
    res.status(200).json(coupons);
  } catch (error) {
    res.status(500).json({ message: "Error fetching coupons", error: error.message });
  }
};

// Get a single coupon by ID
exports.getCouponById = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id).populate("applicableProducts.product");
    if (!coupon) {
      return res.status(404).json({ message: "Coupon not found" });
    }
    res.status(200).json(coupon);
  } catch (error) {
    res.status(500).json({ message: "Error fetching coupon", error: error.message });
  }
};

// Update a coupon by ID
exports.updateCoupon = async (req, res) => {
  try {
    const { code, discount, expirationDate, isActive, applicableProducts } = req.body;

    // Validate applicable products and variants
    for (const item of applicableProducts) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(400).json({ message: `Product ${item.product} not found` });
      }

      for (const variant of item.variants) {
        const productVariant = product.variants.find((v) => v._id.equals(variant.variantId));
        if (!productVariant) {
          return res.status(400).json({ message: `Variant ${variant.variantId} not found in product ${item.product}` });
        }

        // Validate sizes
        if (!Array.isArray(variant.sizes) || variant.sizes.length === 0) {
          return res.status(400).json({ message: `Sizes are required for variant ${variant.variantId}` });
        }

        // Check if all selected sizes exist in the product variant
        for (const size of variant.sizes) {
          if (!productVariant.sizes.includes(size)) {
            return res.status(400).json({ message: `Size ${size} not found in variant ${variant.variantId}` });
          }
        }
      }
    }

    const coupon = await Coupon.findByIdAndUpdate(
      req.params.id,
      { code, discount, expirationDate, isActive, applicableProducts },
      { new: true }
    ).populate("applicableProducts.product");

    if (!coupon) {
      return res.status(404).json({ message: "Coupon not found" });
    }

    emitStoreEvent("coupon_updated", { coupon });
    // Re-validate every cart currently holding this coupon
    revalidateCarts({ couponId: coupon._id }).catch(() => {});

    res.status(200).json({ message: "Coupon updated successfully", coupon });
  } catch (error) {
    res.status(500).json({ message: "Error updating coupon", error: error.message });
  }
};

// Delete a coupon by ID
exports.deleteCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: "Coupon not found" });
    }
    emitStoreEvent("coupon_deleted", { couponId: req.params.id, code: coupon.code });
    // Carts pointing at the deleted coupon must drop it
    revalidateCarts({ couponId: coupon._id }).catch(() => {});
    res.status(200).json({ message: "Coupon deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting coupon", error: error.message });
  }
};