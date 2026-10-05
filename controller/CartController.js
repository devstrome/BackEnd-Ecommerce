const mongoose = require('mongoose');
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const Coupon = require("../models/Coupon");

// Helper: recalc totals and (re)apply coupon if valid
async function recalcCartWithCoupon(cart) {
  // Reset per-item discounts
  cart.items = cart.items.map((itemDoc) => {
    const item = typeof itemDoc.toObject === "function" ? itemDoc.toObject() : { ...itemDoc };
    return { ...item, discountApplied: 0 };
  });

  // Total before discount
  const totalBeforeDiscount = round2(
    cart.items.reduce((sum, it) => sum + round2(getBasePrice(it) * Number(it.quantity ?? 0)), 0)
  );

  let totalDiscount = 0;

  if (cart.couponId) {
    // Ensure coupon document
    let coupon = cart.couponId;
    if (!coupon || !coupon.discount) {
      coupon = await Coupon.findById(cart.couponId).lean();
    } else if (typeof coupon.toObject === "function") {
      coupon = coupon.toObject();
    }

    if (coupon) {
      const { valid } = validateCouponDetailed(coupon, cart.items);

      if (valid) {
        // Apply per-item discount only to eligible items
        cart.items = cart.items.map((item) => {
          const qty = Number(item?.quantity ?? 0);
          const base = getBasePrice(item);
          if (!Number.isFinite(qty) || qty <= 0 || base <= 0) return { ...item, discountApplied: 0 };

          const eligible = isItemEligible(item, coupon);
          if (!eligible) return { ...item, discountApplied: 0 };

          const subtotal = round2(base * qty);
          const itemDiscount = calculateDiscount(subtotal, coupon);
          totalDiscount += itemDiscount;
          return { ...item, discountApplied: itemDiscount };
        });
      } else {
        // Invalidate coupon if no longer valid
        cart.couponId = null;
      }
    } else {
      cart.couponId = null;
    }
  }

  // Cap discount to subtotal
  totalDiscount = Math.min(round2(totalDiscount), totalBeforeDiscount);

  cart.totalAmount = totalBeforeDiscount;
  cart.discountAmount = totalDiscount;

  return cart;
}


exports.addToCart = async (req, res) => {
  const {
    userId,
    name,
    productId,
    quantity,
    size,
    color,
    mainImage,
    price,
    variantId,
    measureType,
    unitName,
  } = req.body;

  try {
    const qty = Number(quantity);
    const unitPrice = Number(price);

    if (
      !userId ||
      !productId ||
      !size ||
      !color ||
      !mainImage ||
      !unitPrice ||
      qty <= 0
    ) {
      return res.status(400).json({
        message: "Missing required fields or invalid quantity/price.",
      });
    }

    const product = await Product.findById(productId).lean();
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    let cart = await Cart.findOne({ userId }).populate("couponId");
    if (!cart) {
      cart = new Cart({
        userId,
        items: [],
        discountAmount: 0,
        totalAmount: 0,
      });
    }

    const existingIndex = cart.items.findIndex(
      (item) =>
        item.productId.toString() === productId.toString() &&
        (item.variantId?.toString?.() || item.variantId) ===
          (variantId?.toString?.() || variantId) &&
        item.size === size &&
        item.color === color &&
        item.measureType === measureType &&
        item.unitName === unitName
    );

    if (existingIndex > -1) {
      const existingItem = cart.items[existingIndex];
      existingItem.quantity = Number(existingItem.quantity ?? 0) + qty;
      existingItem.price = unitPrice;
      existingItem.mainImage = mainImage;
      existingItem.name = name ?? existingItem.name;
    } else {
      cart.items.push({
        variantId,
        productId,
        name,
        quantity: qty,
        price: unitPrice,
        mainImage,
        size,
        color,
        measureType,
        unitName,
      });
    }

    await recalcCartWithCoupon(cart);
    await cart.save();

    const updatedCart = await Cart.findOne({ userId })
      .populate("items.productId")
      .populate("couponId");

    res.status(200).json({
      message: "Item added to cart",
      cart: updatedCart,
      totals: {
        totalBeforeDiscount: updatedCart.totalAmount,
        totalDiscount: updatedCart.discountAmount,
        totalAfterDiscount: round2(
          updatedCart.totalAmount - updatedCart.discountAmount
        ),
      },
    });
  } catch (error) {
    console.error("Error adding to cart:", error);
    res.status(500).json({
      message: "Error adding to cart",
      error: error.message || error,
    });
  }
};

exports.syncCart = async (req, res) => {
  try {
    const { userId, items } = req.body;

    if (!userId || !Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: "Invalid request format",
      });
    }

    const buildKey = ({ productId, variantId, size, color, measureType, unitName }) =>
      `${productId}_${variantId || ""}_${size || ""}_${color || ""}_${measureType || ""}_${unitName || ""}`;

    const validItems = items
      .filter(item => mongoose.Types.ObjectId.isValid(item?.productId))
      .map(item => ({
        ...item,
        productId: new mongoose.Types.ObjectId(item.productId),
        variantId: item.variantId ? new mongoose.Types.ObjectId(item.variantId) : null,
        size: item.size || "",
        color: item.color || "",
        measureType: item.measureType || "",
        unitName: item.unitName || "",
      }));

    const products = await Product.find({
      $or: [
        { _id: { $in: validItems.map(i => i.productId) } },
        { "variants._id": { $in: validItems.map(i => i.productId) } },
      ],
    }).populate("variants");

    const productMap = new Map();
    const variantMap = new Map();

    products.forEach(product => {
      productMap.set(product._id.toString(), product);
      (product.variants || []).forEach(variant => {
        variantMap.set(variant._id.toString(), { parentProduct: product, variant });
      });
    });

    const validatedItems = validItems.filter(item =>
      productMap.has(item.productId.toString()) || variantMap.has(item.productId.toString())
    );

    let cart = await Cart.findOneAndUpdate(
      { userId },
      { $setOnInsert: { items: [], totalAmount: 0, discountAmount: 0 } },
      { new: true, upsert: true }
    ).populate("couponId");

    const mergedItems = new Map();

    cart.items.forEach(item => {
      const key = buildKey({
        productId: item.productId.toString(),
        variantId: item.variantId?.toString() || "",
        size: item.size || "",
        color: item.color || "",
        measureType: item.measureType || "",
        unitName: item.unitName || "",
      });
      mergedItems.set(key, item.toObject());
    });

    validatedItems.forEach(clientItem => {
      const variantData = variantMap.get(clientItem.productId.toString());
      const isVariant = !!variantData;

      const product = isVariant
        ? variantData.parentProduct
        : productMap.get(clientItem.productId.toString());

      const variant = isVariant
        ? variantData.variant
        : product?.variants?.find(v => clientItem.variantId && v._id.equals(clientItem.variantId));

      const price = product?.discountPrice || product?.mainPrice;
      const stock = variant?.stock ?? 0;

      if (!price || !stock) return;

      const key = buildKey({
        productId: product._id.toString(),
        variantId: variant?._id?.toString() || "",
        size: clientItem.size,
        color: clientItem.color,
        measureType: clientItem.measureType,
        unitName: clientItem.unitName,
      });

      const existing = mergedItems.get(key);
      const quantity = Math.min(Number(clientItem.quantity) || 1, stock);

      if (existing) {
        existing.quantity = Math.min(Number(existing.quantity || 0) + quantity, stock);
        mergedItems.set(key, existing);
      } else {
        mergedItems.set(key, {
          productId: product._id,
          variantId: variant?._id || null,
          size: clientItem.size || "N/A",
          color: clientItem.color || "N/A",
          measureType: clientItem.measureType || "",
          unitName: clientItem.unitName || "",
          price,
          quantity,
          discountApplied: 0,
          name: product.name,
          mainImage: variant?.images?.[0] || product.mainImage,
        });
      }
    });

    cart.items = Array.from(mergedItems.values()).filter(item => Number(item.quantity) > 0);

    const subtotal = round2(
      cart.items.reduce(
        (sum, item) => sum + round2(Number(item.price) * Number(item.quantity)),
        0
      )
    );

    cart.items = cart.items.map(item => ({ ...item, discountApplied: 0 }));
    cart.discountAmount = 0;
    cart.totalAmount = subtotal;

    if (cart.couponId) {
      let coupon =
        typeof cart.couponId.toObject === "function"
          ? cart.couponId.toObject()
          : cart.couponId;

      if (!coupon?.discount) {
        coupon = await Coupon.findById(cart.couponId).lean();
      }

      if (coupon && coupon.isActive && new Date(coupon.expirationDate) > new Date()) {
        const { valid } = validateCouponDetailed(coupon, cart.items);

        if (valid) {
          let totalDiscount = 0;

          cart.items = cart.items.map(item => {
            const eligible = isItemEligible(item, coupon);
            if (!eligible) return { ...item, discountApplied: 0 };

            const itemSubtotal = round2(Number(item.price) * Number(item.quantity));
            const itemDiscount = calculateDiscount(itemSubtotal, coupon);

            totalDiscount += itemDiscount;
            return { ...item, discountApplied: round2(itemDiscount) };
          });

          cart.discountAmount = Math.min(round2(totalDiscount), subtotal);
        } else {
          cart.couponId = null;
          cart.discountAmount = 0;
        }
      } else {
        cart.couponId = null;
        cart.discountAmount = 0;
      }
    }

    await cart.save();

    const populatedCart = await Cart.findById(cart._id)
      .populate("items.productId", "name price mainImage variants")
      .populate("couponId", "code discountType discount discountValue");

    res.status(200).json({
      success: true,
      cart: {
        items: populatedCart.items.map(item => ({
          ...item.toObject(),
          price: Number(item.price).toFixed(2),
          discountApplied: Number(item.discountApplied || 0).toFixed(2),
        })),
        totalAmount: Number(populatedCart.totalAmount).toFixed(2),
        discountAmount: Number(populatedCart.discountAmount).toFixed(2),
        totalAfterDiscount: round2(
          populatedCart.totalAmount - populatedCart.discountAmount
        ).toFixed(2),
        couponId: populatedCart.couponId,
      },
    });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Cart synchronization failed",
    });
  }
};

exports.updateQuantity = async (req, res) => {
  const { id } = req.params; // cart item _id
  const { userId, quantity } = req.body;

  try {
    const qty = Number(quantity);
    if (!userId || !Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ message: "Invalid user or quantity" });
    }

    const cart = await Cart.findOne({ userId }).populate("couponId");
    if (!cart) return res.status(404).json({ message: "Cart not found" });

    const itemIndex = cart.items.findIndex(item => item._id.toString() === id);
    if (itemIndex === -1) return res.status(404).json({ message: "Item not found" });

    if (qty === 0) {
      cart.items.splice(itemIndex, 1);
    } else {
      cart.items[itemIndex].quantity = qty;
    }

    if (cart.items.length === 0) {
      cart.items = [];
      cart.totalAmount = 0;
      cart.discountAmount = 0;
      cart.couponId = null;
      await cart.save();

      return res.json({
        message: "Quantity updated (cart now empty)",
        cart,
        totals: {
          totalBeforeDiscount: 0,
          totalDiscount: 0,
          totalAfterDiscount: 0,
        },
      });
    }

    await recalcCartWithCoupon(cart);
    await cart.save();

    const updatedCart = await Cart.findOne({ userId })
      .populate("items.productId")
      .populate("couponId");

    res.json({
      message: "Quantity updated",
      cart: updatedCart,
      totals: {
        totalBeforeDiscount: updatedCart.totalAmount,
        totalDiscount: updatedCart.discountAmount,
        totalAfterDiscount: round2(updatedCart.totalAmount - updatedCart.discountAmount),
      },
    });
  } catch (error) {
    console.error("Error updating quantity:", error);
    res.status(500).json({ message: "Error updating quantity", error: error.message });
  }
};

// Remove coupon from cart
exports.removeCoupon = async (req, res) => {
  const { userId } = req.params;

  try {
    // Find the user's cart
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    // Remove the coupon and reset discount
    cart.couponId = null;
    cart.discountAmount = 0;

    // Reset discountApplied for all items
    cart.items = cart.items.map((item) => {
      return {
        ...item.toObject(),
        discountApplied: 0, // Reset discountApplied to 0
      };
    });

    await cart.save();
    

    res.status(200).json({
      cart,
      message: "Coupon removed successfully",
    });
  } catch (error) {
    res.status(500).json({ message: "Error removing coupon", error: error.message });
  }
};

exports.increaseQuantity = async (req, res) => {
  const { id } = req.params; // cart item ID
  const { userId, couponId } = req.body;

  try {
    const cart = await Cart.findOne({ userId }).populate("items.productId");
    if (!cart) return res.status(404).json({ message: "Cart not found" });

    const itemIndex = cart.items.findIndex(item => item._id.toString() === id);
    if (itemIndex === -1) return res.status(404).json({ message: "Item not found in cart" });

    // 🔼 Increase quantity
    const item = cart.items[itemIndex];
    item.quantity += 1;

    // 🧠 Apply coupon if provided and valid
    let totalDiscount = 0;

    if (couponId) {
      const coupon = await Coupon.findOne({ _id: couponId, isActive: true }).lean();
      const isValid = coupon && new Date(coupon.expirationDate) > new Date();

      if (isValid) {
        const eligible = isItemEligible(item, coupon);
        const base = getBasePrice(item);
        const subtotal = round2(base * item.quantity);

        item.discountApplied = eligible ? calculateDiscount(subtotal, coupon) : 0;

        totalDiscount = cart.items.reduce((sum, it) => sum + (it.discountApplied || 0), 0);
        cart.discountAmount = round2(totalDiscount);
        cart.couponId = coupon._id;
      } else {
        item.discountApplied = 0;
        cart.discountAmount = 0;
        cart.couponId = null;
      }
    }

    await cart.save();

    const updatedCart = await Cart.findOne({ userId })
      .populate("items.productId")
      .populate("couponId");

    res.json({
      message: "Quantity increased",
      cart: updatedCart,
      totalDiscount: round2(updatedCart.discountAmount),
    });
  } catch (error) {
    console.error("Error increasing quantity:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.decreaseQuantity = async (req, res) => {
  const { id } = req.params; // Cart item ID
  const { userId, couponId } = req.body;

  try {
    const cart = await Cart.findOne({ userId }).populate("items.productId");
    if (!cart) return res.status(404).json({ message: "Cart not found" });

    const itemIndex = cart.items.findIndex(item => item._id.toString() === id);
    if (itemIndex === -1) return res.status(404).json({ message: "Item not found in cart" });

    // 🔽 Decrease quantity or remove item
    const item = cart.items[itemIndex];
    if (item.quantity > 1) {
      item.quantity -= 1;
    } else {
      cart.items.splice(itemIndex, 1);
    }

    let totalDiscount = 0;

    // 🧠 Apply coupon logic if valid and cart has items
    if (couponId && cart.items.length > 0) {
      const coupon = await Coupon.findOne({ _id: couponId, isActive: true }).lean();
      const isValid = coupon && new Date(coupon.expirationDate) > new Date();

      if (isValid) {
        cart.items = cart.items.map(item => {
          const qty = Number(item.quantity ?? 0);
          const base = getBasePrice(item);

          if (!Number.isFinite(qty) || qty <= 0 || base <= 0) {
            return { ...item, discountApplied: 0 };
          }

          const eligible = isItemEligible(item, coupon);
          if (!eligible) return { ...item, discountApplied: 0 };

          const subtotal = round2(base * qty);
          const discountValue = calculateDiscount(subtotal, coupon);
          totalDiscount += discountValue;

          return { ...item, discountApplied: discountValue };
        });

        cart.couponId = couponId;
        cart.discountAmount = round2(totalDiscount);
      } else {
        cart.items = cart.items.map(item => ({ ...item, discountApplied: 0 }));
        cart.discountAmount = 0;
        cart.couponId = null;
      }
    } else {
      cart.items = cart.items.map(item => ({ ...item, discountApplied: 0 }));
      cart.discountAmount = 0;
      cart.couponId = null;
    }

    await cart.save();

    const updatedCart = await Cart.findOne({ userId })
      .populate("items.productId")
      .populate("couponId");

    res.json({
      message: "Quantity decreased",
      cart: updatedCart,
      totalDiscount: round2(updatedCart.discountAmount),
    });
  } catch (error) {
    console.error("Error decreasing quantity:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


exports.removeFromCart = async (req, res) => {
  const { userId, itemId } = req.params;

  try {
    const cart = await Cart.findOne({ userId }).populate("couponId");
    if (!cart) return res.status(404).json({ message: "Cart not found" });

    const itemIndex = cart.items.findIndex(item => item._id.toString() === itemId);
    if (itemIndex === -1) return res.status(404).json({ message: "Product not found in cart" });

    // 🗑️ Remove item
    cart.items.splice(itemIndex, 1);

    if (cart.items.length === 0) {
      cart.items = [];
      cart.totalAmount = 0;
      cart.discountAmount = 0;
      cart.couponId = null;
      await cart.save();

      return res.status(200).json({
        message: "Cart is now empty and reset",
        cart,
        totals: {
          totalBeforeDiscount: 0,
          totalDiscount: 0,
          totalAfterDiscount: 0,
        },
      });
    }

    // 🔁 Recalculate totals and reapply coupon
    await recalcCartWithCoupon(cart);
    await cart.save();

    const updatedCart = await Cart.findOne({ userId })
      .populate("items.productId")
      .populate("couponId");

    res.status(200).json({
      message: "Item removed from cart",
      cart: updatedCart,
      totals: {
        totalBeforeDiscount: updatedCart.totalAmount,
        totalDiscount: updatedCart.discountAmount,
        totalAfterDiscount: round2(updatedCart.totalAmount - updatedCart.discountAmount),
      },
    });
  } catch (error) {
    console.error("Error removing from cart:", error);
    res.status(500).json({ message: "Error removing from cart", error: error.message });
  }
};


exports.getCart = async (req, res) => {
  const { userId } = req.params;

  try {
    const cart = await Cart.findOne({ userId })
      .populate('items.productId')
      .populate('couponId');
    if (!cart) {
      return res.status(404).json({ message: 'Cart not found' });
    }

    res.status(200).json(cart);
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving cart', error });
  }
};


function round2(num) {
  return Number(Math.round((Number(num) + Number.EPSILON) * 100) / 100);
}

function normId(x) {
  if (!x) return "";
  return (x._id ? x._id.toString() : x.toString()).trim();
}

function normStr(x) {
  return (x ?? "").toString().trim().toLowerCase();
}

function getBasePrice(item) {
  const p = Number(item?.originalPrice ?? item?.price ?? 0);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

function calculateDiscount(itemSubtotal, coupon) {
  const type = normStr(coupon?.discountType ?? "percentage");
  const value = Number(coupon?.discount ?? 0);

  if (!Number.isFinite(itemSubtotal) || itemSubtotal <= 0) return 0;
  if (!Number.isFinite(value) || value <= 0) return 0;

  if (type === "percentage") {
    const pct = Math.min(Math.max(value, 0), 100);
    return round2(itemSubtotal * (pct / 100));
  }

  if (type === "fixed") {
    return round2(Math.min(value, itemSubtotal));
  }

  return 0;
}

function isItemEligible(item, coupon) {
  const aps = coupon?.applicableProducts ?? [];
  if (!Array.isArray(aps) || aps.length === 0) return true;

  const itemProductId = normId(item?.productId);
  const itemVariantId = normId(item?.variantId);
  const itemSize = normStr(item?.size);
  const itemColor = normStr(item?.colorName ?? item?.color);

  for (const ap of aps) {
    const apProductId = normId(ap?.product ?? ap?.productId);
    if (!apProductId || apProductId !== itemProductId) continue;

    const apVariants = ap?.variants ?? [];
    if (!Array.isArray(apVariants) || apVariants.length === 0) return true;

    for (const vr of apVariants) {
      const vrId = normId(vr?.variantId);
      const vrSizes = Array.isArray(vr?.sizes) ? vr.sizes.map(normStr) : [];
      const vrColor = normStr(vr?.color);

      const variantMatch = !vrId || vrId === itemVariantId;
      const sizeMatch = vrSizes.length === 0 || vrSizes.includes(itemSize);
      const colorMatch = !vrColor || vrColor === itemColor;

      if (variantMatch && sizeMatch && colorMatch) return true;
    }
  }

  return false;
}

function validateCouponDetailed(coupon, items) {
  if (!coupon?.isActive) return { valid: false, reason: "Coupon is inactive" };
  if (coupon?.expirationDate && new Date(coupon.expirationDate) < new Date()) {
    return { valid: false, reason: "Coupon expired" };
  }

  const subtotal = round2((items ?? []).reduce((sum, item) => {
    const qty = Number(item?.quantity ?? 0);
    const base = getBasePrice(item);
    return Number.isFinite(qty) && qty > 0 && base > 0 ? sum + base * qty : sum;
  }, 0));

  if (Number.isFinite(coupon?.minCartValue) && subtotal < Number(coupon.minCartValue)) {
    return { valid: false, reason: `Minimum cart value not met: ${coupon.minCartValue}` };
  }

  const aps = coupon?.applicableProducts ?? [];
  if (!Array.isArray(aps) || aps.length === 0) {
    const hasValid = (items ?? []).some(it => getBasePrice(it) > 0 && Number(it?.quantity ?? 0) > 0);
    return hasValid ? { valid: true } : { valid: false, reason: "No purchasable items in cart" };
  }

  const anyEligible = (items ?? []).some(it => isItemEligible(it, coupon));
  if (!anyEligible) return { valid: false, reason: "Coupon does not apply to any items in the cart" };

  return { valid: true };
}


exports.applyCoupon = async (req, res) => {
  const { userId } = req.params;
  const rawCode = req.body?.couponCode;

  try {
    if (!rawCode || typeof rawCode !== "string") {
      return res.status(400).json({ success: false, message: "Coupon code is required" });
    }

    const couponCode = rawCode.trim();
    let cart = await Cart.findOne({ userId }).populate("items.productId");
    if (!cart) return res.status(404).json({ success: false, message: "Cart not found" });

    const coupon = await Coupon.findOne({
      code: { $regex: new RegExp(`^${couponCode}$`, "i") },
      isActive: true
    });
    if (!coupon) return res.status(400).json({ success: false, message: "Invalid coupon code" });

    const { valid, reason } = validateCouponDetailed(coupon, cart.items);
    if (!valid) return res.status(400).json({ success: false, message: reason });

    let totalDiscount = 0;

    const updatedItems = cart.items.map((itemDoc) => {
      const item = typeof itemDoc.toObject === "function" ? itemDoc.toObject() : { ...itemDoc };
      const qty = Number(item?.quantity ?? 0);
      const base = getBasePrice(item);
      if (!Number.isFinite(qty) || qty <= 0 || base <= 0) return { ...item, discountApplied: 0 };

      const eligible = isItemEligible(item, coupon);
      if (!eligible) return { ...item, discountApplied: 0 };

      const subtotal = round2(base * qty);
      const discountValue = calculateDiscount(subtotal, coupon);
      totalDiscount += discountValue;

      return { ...item, discountApplied: discountValue };
    });

    const totalBeforeDiscount = round2(
      updatedItems.reduce((sum, it) => sum + round2(getBasePrice(it) * Number(it.quantity ?? 0)), 0)
    );

    totalDiscount = Math.min(round2(totalDiscount), totalBeforeDiscount);
    const totalAfterDiscount = round2(totalBeforeDiscount - totalDiscount);

    cart.items = updatedItems;
    cart.totalAmount = totalBeforeDiscount;
    cart.couponId = coupon._id;
    cart.discountAmount = totalDiscount;

    await cart.save();
    cart = await Cart.findOne({ userId })
      .populate("items.productId")
      .populate("couponId");

    return res.status(200).json({
      success: true,
      message: "Coupon applied successfully",
      couponCode,
      totalBeforeDiscount,
      totalDiscount,
      totalAfterDiscount,
      cart
    });
  } catch (error) {
    console.error("Error applying coupon:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};



exports.deleteCart = async (req, res) => {
  const { userId } = req.params;

  try {
    // Find the cart by userId
    const cart = await Cart.findOne({ userId });

    if (!cart) {
      return res.status(404).json({ message: 'Cart not found' });
    }

    // Reset the cart to its default state
    cart.items = []; // Clear all items
    cart.totalAmount = 0; // Reset total amount
    cart.discountAmount = 0; // Reset discount amount
    cart.couponId = null; // Remove applied coupon
    cart.isActive = true; // Reset isActive (if needed)

    // Save the updated cart
    await cart.save();

    res.status(200).json({ message: 'Cart reset successfully', resetCart: cart });
  } catch (error) {
    console.error('Error resetting cart:', error);
    res.status(500).json({ message: 'Error resetting cart', error: error.message });
  }
};

// -- Live sync helpers ----------------------------------------------------
// Resolve the current catalog price for a cart line. Mirrors what ProductView
// puts in the cart: the variant's discountPrice for that size, else the
// product-level discountPrice, else mainPrice.
function catalogPriceFor(product, item) {
  if (!product) return null;
  const variant =
    (Array.isArray(product.variants) &&
      product.variants.find(
        (v) =>
          String(v._id) === String(item.variantId || '') ||
          normStr(v.colorName) === normStr(item.color)
      )) ||
    null;

  const sizeIdx = variant && Array.isArray(variant.sizes)
    ? variant.sizes.findIndex((s) => normStr(s) === normStr(item.size))
    : -1;

  const pick = (arr) =>
    sizeIdx >= 0 && Array.isArray(arr) && Number.isFinite(Number(arr[sizeIdx])) && Number(arr[sizeIdx]) > 0
      ? Number(arr[sizeIdx])
      : null;

  const price =
    (variant && pick(variant.discountPrices)) ||
    (variant && pick(variant.prices)) ||
    (Number(product.discountPrice) > 0 ? Number(product.discountPrice) : null) ||
    (Number(product.mainPrice) > 0 ? Number(product.mainPrice) : null);

  return price && Number.isFinite(price) ? price : null;
}

// Re-price + re-validate carts affected by an admin change.
//  - couponId    -> only carts currently holding that coupon
//  - productIds  -> only carts containing those products (price sync)
// Emits `cart:updated` to each affected user's room so the open cart /
// checkout page refreshes without a reload.
async function revalidateCarts({ couponId = null, productIds = null } = {}) {
  const filter = {};
  if (couponId) filter.couponId = couponId;
  if (productIds && productIds.length) filter['items.productId'] = { $in: productIds };

  const carts = await Cart.find(filter);
  if (!carts.length) return [];

  const { emitToUser, emitStoreEvent } = require('../utils/storeEvents');
  const touched = [];

  for (const cart of carts) {
    try {
      if (productIds && productIds.length) {
        // Sync line prices to the current catalog price
        const uniquePids = [...new Set(cart.items.map((i) => normId(i.productId)).filter(Boolean))];
        const products = await Product.find({ _id: { $in: uniquePids } });
        const byId = new Map(products.map((p) => [String(p._id), p]));
        for (const item of cart.items) {
          const p = byId.get(normId(item.productId));
          const price = catalogPriceFor(p, item);
          if (price != null && price !== Number(item.price)) item.price = price;
        }
      }

      await recalcCartWithCoupon(cart);
      await cart.save();
      touched.push(cart.userId);
    } catch (e) {
      console.error('revalidateCarts failed for', cart.userId, e.message);
    }
  }

  // Tell every affected user their cart changed
  for (const userId of touched) {
    emitToUser(userId, 'cart_updated', {}, 'cart:updated');
  }
  if (touched.length) {
    emitStoreEvent('carts_revalidated', { count: touched.length }, 'storeChanged');
  }

  return touched;
}

exports.revalidateCarts = revalidateCarts;
exports.catalogPriceFor = catalogPriceFor;
