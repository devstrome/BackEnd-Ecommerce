const Coupon = require("../models/Coupon");
const Product = require("../models/Product");
const { emitStoreEvent } = require("../utils/storeEvents");
const { revalidateCarts } = require("./CartController");
const escapeRegex = require("../utils/escapeRegex");

const idOf = (value) => String(value?._id || value || "");

function normalizeCouponPayload(body = {}) {
  const code = String(body.code || "").trim();
  const discount = Number(body.discount);
  const expirationDate = body.expirationDate;
  const minCartValue = Number(body.minCartValue ?? body.minAmount ?? 0);
  const rawCap = body.maxDiscountAmount ?? body.maxAmount;
  const maxDiscountAmount = rawCap === "" || rawCap === null || rawCap === undefined
    ? null
    : Number(rawCap);

  if (!code) throw Object.assign(new Error("Coupon code is required"), { statusCode: 400 });
  if (!Number.isFinite(discount) || discount <= 0 || discount > 100) {
    throw Object.assign(new Error("Discount must be between 1 and 100 percent"), { statusCode: 400 });
  }
  if (!expirationDate || Number.isNaN(new Date(expirationDate).getTime())) {
    throw Object.assign(new Error("A valid expiration date is required"), { statusCode: 400 });
  }
  if (!Number.isFinite(minCartValue) || minCartValue < 0) {
    throw Object.assign(new Error("Minimum cart value must be zero or greater"), { statusCode: 400 });
  }
  if (maxDiscountAmount !== null && (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount < 0)) {
    throw Object.assign(new Error("Maximum discount must be zero or greater"), { statusCode: 400 });
  }

  return {
    code,
    discount,
    expirationDate,
    isActive: body.isActive !== false,
    minCartValue,
    maxDiscountAmount: maxDiscountAmount > 0 ? maxDiscountAmount : null,
    applicableProducts: Array.isArray(body.applicableProducts) ? body.applicableProducts : [],
  };
}

async function validateApplicableProducts(applicableProducts) {
  for (const item of applicableProducts) {
    const productId = idOf(item?.product || item?.productId);
    if (!productId) throw Object.assign(new Error("A product is required for each coupon product rule"), { statusCode: 400 });
    const product = await Product.findById(productId);
    if (!product) throw Object.assign(new Error(`Product ${productId} not found`), { statusCode: 400 });

    for (const target of item.variants || []) {
      const productVariant = product.variants.find((variant) => idOf(variant._id) === idOf(target.variantId));
      if (!productVariant) {
        throw Object.assign(new Error(`Variant ${target.variantId} not found in product ${productId}`), { statusCode: 400 });
      }

      const targetRegionId = idOf(target.regionId);
      const actualRegionId = idOf(productVariant.regionId);
      if (targetRegionId && targetRegionId !== actualRegionId) {
        throw Object.assign(new Error(`Region does not match variant ${target.variantId}`), { statusCode: 400 });
      }

      const selectedSizes = Array.isArray(target.sizes) ? target.sizes.map((size) => String(size).trim()).filter(Boolean) : [];
      if (!selectedSizes.length) {
        throw Object.assign(new Error(`Sizes are required for variant ${target.variantId}`), { statusCode: 400 });
      }
      const availableSizes = new Set([
        ...(Array.isArray(productVariant.sizes) ? productVariant.sizes : []),
        ...(Array.isArray(productVariant.options) ? productVariant.options.map((option) => option.size) : []),
      ].map((size) => String(size || "").trim().toLowerCase()).filter(Boolean));
      for (const size of selectedSizes) {
        if (!availableSizes.has(size.toLowerCase())) {
          throw Object.assign(new Error(`Size ${size} not found in variant ${target.variantId}`), { statusCode: 400 });
        }
      }
      target.regionId = targetRegionId || actualRegionId || null;
      target.regionName = String(target.regionName || "").trim();
      target.sizes = selectedSizes;
    }
  }
}

const couponPopulate = {
  path: "applicableProducts.product",
  populate: { path: "variants.regionId", select: "name slug" },
};

// Create a new coupon
exports.createCoupon = async (req, res) => {
  try {
    const payload = normalizeCouponPayload(req.body);

    // Check if the coupon code already exists
    const existingCoupon = await Coupon.findOne({ code: { $regex: `^${escapeRegex(payload.code)}$`, $options: "i" } });
    if (existingCoupon) {
      return res.status(400).json({ message: "Coupon code already exists" });
    }

    await validateApplicableProducts(payload.applicableProducts);

    // Create the coupon
    const coupon = new Coupon(payload);

    // Save the coupon to the database
    await coupon.save();

    // Push the new coupon to every open client so admin + storefront lists
    // refresh immediately.
    emitStoreEvent("coupon_created", { coupon });

    res.status(201).json({ message: "Coupon created successfully", coupon });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Error creating coupon", error: error.message });
  }
};

// Get all coupons
exports.getAllCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find().populate(couponPopulate);
    res.status(200).json(coupons);
  } catch (error) {
    res.status(500).json({ message: "Error fetching coupons", error: error.message });
  }
};

// Get a single coupon by ID
exports.getCouponById = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id).populate(couponPopulate);
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
    const payload = normalizeCouponPayload(req.body);
    const duplicate = await Coupon.findOne({
      _id: { $ne: req.params.id },
      code: { $regex: `^${escapeRegex(payload.code)}$`, $options: "i" },
    }).select("_id");
    if (duplicate) {
      return res.status(400).json({ message: "Coupon code already exists" });
    }
    await validateApplicableProducts(payload.applicableProducts);

    const coupon = await Coupon.findByIdAndUpdate(
      req.params.id,
      payload,
      { new: true, runValidators: true }
    ).populate(couponPopulate);

    if (!coupon) {
      return res.status(404).json({ message: "Coupon not found" });
    }

    emitStoreEvent("coupon_updated", { coupon });
    // Re-validate every cart currently holding this coupon
    revalidateCarts({ couponId: coupon._id }).catch(() => {});

    res.status(200).json({ message: "Coupon updated successfully", coupon });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Error updating coupon", error: error.message });
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
