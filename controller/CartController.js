const mongoose = require('mongoose');
const escapeRegex = require('../utils/escapeRegex');
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const Coupon = require("../models/Coupon");
const { resolveProductConfiguration } = require('../utils/productPricing');

function authenticatedUserId(req, requestedUserId) {
  const authenticatedId = req.user?._id?.toString();
  if (authenticatedId && requestedUserId && authenticatedId !== requestedUserId.toString()) {
    const error = new Error('You can only change your own cart');
    error.statusCode = 403;
    throw error;
  }
  return authenticatedId || requestedUserId;
}

function cartConfiguration(item) {
  return {
    regionId: item.regionId,
    variantId: item.variantId,
    color: item.color,
    size: item.size,
    measureType: item.measureType,
    unitName: item.unitName,
  };
}

async function refreshCartFromCatalog(cart) {
  for (const item of cart.items) {
    const product = await Product.findById(item.productId).lean();
    if (!product) {
      item.isAvailable = false;
      item.unavailableReason = 'This product is no longer available';
      continue;
    }
    try {
      const current = await resolveProductConfiguration(product, cartConfiguration(item));
      item.regionId = current.regionId;
      item.regionName = current.regionName;
      item.sku = product.sku || item.sku || '';
      item.hexCode = current.hexCode || '';
      item.variantId = current.variantId;
      item.color = current.color;
      item.size = current.size;
      item.measureType = current.measureType;
      item.unitName = current.unitName;
      item.price = current.finalPrice;
      item.originalPrice = current.price;
      item.discountPrice = current.discountPrice;
      item.stockAvailable = current.stock;
      item.mainImage = current.images?.[0] || product.mainImage || item.mainImage;
      item.name = product.name || item.name;
      item.isPreOrder = Boolean(product.isPreOrder);
      item.isDigitalProduct = Boolean(product.isDigitalProduct);
      item.preOrderEstimatedDate = product.isPreOrder ? product.preOrderEstimatedDate || null : null;
      const quantity = Number(item.quantity);
      const validQuantity = Number.isInteger(quantity) && quantity > 0;
      const inStock = product.isPreOrder || current.stock === null || quantity <= current.stock;
      item.isAvailable = !product.comingSoon && (product.isPreOrder || current.available) && validQuantity && inStock;
      item.unavailableReason = product.comingSoon
        ? 'This product is not available for ordering yet'
        : !product.isPreOrder && !current.available
        ? 'This configuration is out of stock'
        : !validQuantity
          ? 'Cart quantity must be a positive whole number'
          : !inStock
            ? `Only ${current.stock} left in stock`
            : '';
    } catch (error) {
      item.isAvailable = false;
      item.unavailableReason = error.message;
    }
  }
  return cart;
}

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
        const result = calculateCouponDiscounts(cart.items, coupon);
        cart.items = result.items;
        totalDiscount = result.totalDiscount;
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
  try {
    const { productId, quantity, ...selected } = req.body;
    const userId = authenticatedUserId(req, req.body.userId);
    const qty = Number(quantity);
    if (!userId || !mongoose.Types.ObjectId.isValid(productId) || !Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ message: 'A valid product, user, and positive integer quantity are required' });
    }

    const product = await Product.findById(productId).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (product.comingSoon) return res.status(409).json({ message: 'This product is not available for ordering yet' });
    const resolved = await resolveProductConfiguration(product, selected);
    if (!product.isPreOrder && resolved.stock !== null && qty > resolved.stock) {
      return res.status(409).json({ message: `Only ${resolved.stock} item(s) are available`, stock: resolved.stock });
    }

    let cart = await Cart.findOne({ userId }).populate('couponId');
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
        (item.regionId?.toString?.() || '') === (resolved.regionId?.toString?.() || '') &&
        (item.variantId?.toString?.() || '') === (resolved.variantId?.toString?.() || '') &&
        item.size === resolved.size &&
        item.color === resolved.color &&
        item.measureType === resolved.measureType &&
        item.unitName === resolved.unitName
    );

    if (existingIndex > -1) {
      const existingItem = cart.items[existingIndex];
      const nextQuantity = Number(existingItem.quantity ?? 0) + qty;
      if (!product.isPreOrder && resolved.stock !== null && nextQuantity > resolved.stock) {
        return res.status(409).json({ message: `Only ${resolved.stock} item(s) are available`, stock: resolved.stock });
      }
      existingItem.quantity = nextQuantity;
      existingItem.price = resolved.finalPrice;
      existingItem.originalPrice = resolved.price;
      existingItem.discountPrice = resolved.discountPrice;
      existingItem.hexCode = resolved.hexCode || '';
      existingItem.stockAvailable = resolved.stock;
      existingItem.isAvailable = true;
      existingItem.unavailableReason = '';
      existingItem.isPreOrder = Boolean(product.isPreOrder);
      existingItem.isDigitalProduct = Boolean(product.isDigitalProduct);
      existingItem.preOrderEstimatedDate = product.isPreOrder ? product.preOrderEstimatedDate || null : null;
      existingItem.mainImage = resolved.images?.[0] || product.mainImage;
      existingItem.name = product.name;
    } else {
      cart.items.push({
        variantId: resolved.variantId,
        productId,
        regionId: resolved.regionId,
        regionName: resolved.regionName,
        sku: product.sku || '',
        hexCode: resolved.hexCode || '',
        originalPrice: resolved.price,
        discountPrice: resolved.discountPrice,
        stockAvailable: resolved.stock,
        isAvailable: true,
        isPreOrder: Boolean(product.isPreOrder),
        isDigitalProduct: Boolean(product.isDigitalProduct),
        preOrderEstimatedDate: product.isPreOrder ? product.preOrderEstimatedDate || null : null,
        name: product.name,
        quantity: qty,
        price: resolved.finalPrice,
        mainImage: resolved.images?.[0] || product.mainImage,
        size: resolved.size,
        color: resolved.color,
        measureType: resolved.measureType,
        unitName: resolved.unitName,
      });
    }

    await refreshCartFromCatalog(cart);
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
    res.status(error.statusCode || 500).json({
      message: "Error adding to cart",
      error: error.message || error,
    });
  }
};

exports.syncCart = async (req, res) => {
  try {
    const userId = authenticatedUserId(req, req.body.userId);
    const incomingItems = req.body.items;
    if (!userId || !Array.isArray(incomingItems)) return res.status(400).json({ success: false, message: 'Invalid cart sync request' });

    let cart = await Cart.findOneAndUpdate(
      { userId },
      { $setOnInsert: { items: [], totalAmount: 0, discountAmount: 0 } },
      { new: true, upsert: true }
    ).populate('couponId');
    await refreshCartFromCatalog(cart);

    const buildKey = (item) => [
      normId(item.productId), normId(item.regionId), normId(item.variantId),
      normStr(item.size), normStr(item.color), normStr(item.measureType), normStr(item.unitName),
    ].join('|');
    const merged = new Map(cart.items.map((item) => [buildKey(item), item.toObject()]));

    for (const incoming of incomingItems) {
      if (!mongoose.Types.ObjectId.isValid(incoming?.productId)) continue;
      const product = await Product.findById(incoming.productId).lean();
      const qty = Number(incoming.quantity);
      if (!Number.isInteger(qty) || qty <= 0) continue;
      if (!product) {
        const unavailable = {
          productId: incoming.productId,
          variantId: incoming.variantId || null,
          regionId: incoming.regionId || null,
          name: incoming.name || 'Unavailable product',
          size: incoming.size || '', color: incoming.color || '',
          measureType: incoming.measureType || '', unitName: incoming.unitName || '',
        price: 0, originalPrice: 0, quantity: qty,
          mainImage: incoming.mainImage || '', isAvailable: false,
          unavailableReason: 'This product is no longer available',
        };
        merged.set(buildKey(unavailable), unavailable);
        continue;
      }
      if (product.comingSoon) {
        const unavailable = {
          productId: product._id,
          variantId: incoming.variantId || null,
          regionId: incoming.regionId || null,
          regionName: incoming.regionName || '',
          name: product.name,
          size: incoming.size || '',
          color: incoming.color || '',
          measureType: incoming.measureType || '',
          unitName: incoming.unitName || '',
          price: 0,
          originalPrice: 0,
          quantity: qty,
          mainImage: product.mainImage || incoming.mainImage || '',
          isAvailable: false,
          unavailableReason: 'This product is not available for ordering yet',
        };
        merged.set(buildKey(unavailable), unavailable);
        continue;
      }

      let resolved;
      let resolutionError = '';
      try { resolved = await resolveProductConfiguration(product, incoming); }
      catch (error) { resolutionError = error.message; }
      if (!resolved) {
        const unavailable = {
          productId: product._id, variantId: incoming.variantId || null, regionId: incoming.regionId || null,
          regionName: incoming.regionName || '', name: product.name,
          size: incoming.size || '', color: incoming.color || '',
          measureType: incoming.measureType || '', unitName: incoming.unitName || '',
        price: 0, originalPrice: 0, quantity: qty,
          mainImage: incoming.mainImage || product.mainImage || '',
          isAvailable: false, unavailableReason: resolutionError || 'This configuration is unavailable',
        };
        merged.set(buildKey(unavailable), unavailable);
        continue;
      }

      const resolvedItem = {
        productId: product._id,
        variantId: resolved.variantId,
        regionId: resolved.regionId,
        regionName: resolved.regionName,
        sku: product.sku || '',
        hexCode: resolved.hexCode || '',
        size: resolved.size, color: resolved.color,
        measureType: resolved.measureType, unitName: resolved.unitName,
        price: resolved.finalPrice, originalPrice: resolved.price,
        discountPrice: resolved.discountPrice,
        stockAvailable: resolved.stock,
        isPreOrder: Boolean(product.isPreOrder),
        isDigitalProduct: Boolean(product.isDigitalProduct),
        preOrderEstimatedDate: product.isPreOrder ? product.preOrderEstimatedDate || null : null,
        quantity: qty, discountApplied: 0, name: product.name,
        mainImage: resolved.images?.[0] || product.mainImage || '',
        isAvailable: product.isPreOrder || resolved.stock === null || qty <= resolved.stock,
        unavailableReason: !product.isPreOrder && resolved.stock !== null && qty > resolved.stock ? `Only ${resolved.stock} left in stock` : '',
      };
      const key = buildKey(resolvedItem);
      const existing = merged.get(key);
      if (existing) {
        existing.quantity = Number(existing.quantity || 0) + qty;
        if (!product.isPreOrder && resolved.stock !== null && existing.quantity > resolved.stock) {
          existing.isAvailable = false;
          existing.unavailableReason = `Only ${resolved.stock} left in stock`;
        }
      } else merged.set(key, resolvedItem);
    }

    cart.items = Array.from(merged.values());
    await refreshCartFromCatalog(cart);
    await recalcCartWithCoupon(cart);
    await cart.save();

    const populatedCart = await Cart.findById(cart._id)
      .populate('items.productId', 'name mainImage variants regionId regions')
      .populate('couponId');

    res.status(200).json({
      success: true,
      cart: {
        items: populatedCart.items.map(item => ({
          ...item.toObject(),
          price: Number(item.price || 0),
          discountApplied: Number(item.discountApplied || 0),
        })),
        totalAmount: Number(populatedCart.totalAmount || 0),
        discountAmount: Number(populatedCart.discountAmount || 0),
        totalAfterDiscount: round2(populatedCart.totalAmount - populatedCart.discountAmount),
        couponId: populatedCart.couponId,
      },
    });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Cart synchronization failed",
    });
  }
};

exports.updateQuantity = async (req, res) => {
  const { id } = req.params; // cart item _id

  try {
    const userId = authenticatedUserId(req, req.body.userId);
    const quantity = req.body.quantity;
    const qty = Number(quantity);
    if (!userId || !Number.isInteger(qty) || qty < 0) {
      return res.status(400).json({ message: "Invalid user or quantity" });
    }

    const cart = await Cart.findOne({ userId }).populate("couponId");
    if (!cart) return res.status(404).json({ message: "Cart not found" });
    await refreshCartFromCatalog(cart);

    const itemIndex = cart.items.findIndex(item => item._id.toString() === id);
    if (itemIndex === -1) return res.status(404).json({ message: "Item not found" });

    if (qty === 0) {
      cart.items.splice(itemIndex, 1);
    } else {
      const item = cart.items[itemIndex];
      if (!item.isAvailable) return res.status(409).json({ message: item.unavailableReason || 'This cart item is unavailable' });
      if (!item.isPreOrder && item.stockAvailable !== null && item.stockAvailable !== undefined && qty > item.stockAvailable) {
        return res.status(409).json({ message: `Only ${item.stockAvailable} item(s) are available`, stock: item.stockAvailable });
      }
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

    return res.json({
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
    res.status(error.statusCode || 500).json({ message: "Error updating quantity", error: error.message });
  }
};

// Remove coupon from cart
exports.removeCoupon = async (req, res) => {
  try {
    const userId = authenticatedUserId(req, req.params.userId);
    // Find the user's cart
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    await refreshCartFromCatalog(cart);
    cart.couponId = null;
    await recalcCartWithCoupon(cart);

    await cart.save();
    const updatedCart = await Cart.findById(cart._id).populate('items.productId').populate('couponId');
    return res.status(200).json({
      cart: updatedCart,
      message: "Coupon removed successfully",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: "Error removing coupon", error: error.message });
  }
};

exports.increaseQuantity = async (req, res) => {
  const { id } = req.params; // cart item ID

  try {
    const userId = authenticatedUserId(req, req.body.userId);
    const cart = await Cart.findOne({ userId }).populate('couponId');
    if (!cart) return res.status(404).json({ message: "Cart not found" });
    await refreshCartFromCatalog(cart);

    const itemIndex = cart.items.findIndex(item => item._id.toString() === id);
    if (itemIndex === -1) return res.status(404).json({ message: "Item not found in cart" });

    const item = cart.items[itemIndex];
    if (!item.isAvailable) return res.status(409).json({ message: item.unavailableReason || 'This cart item is unavailable' });
    const nextQuantity = Number(item.quantity || 0) + 1;
    if (!item.isPreOrder && item.stockAvailable !== null && item.stockAvailable !== undefined && nextQuantity > item.stockAvailable) {
      return res.status(409).json({ message: `Only ${item.stockAvailable} item(s) are available`, stock: item.stockAvailable });
    }
    item.quantity = nextQuantity;

    await recalcCartWithCoupon(cart);
    await cart.save();

    const updatedCart = await Cart.findOne({ userId })
      .populate("items.productId")
      .populate("couponId");

    return res.json({
      message: "Quantity increased",
      cart: updatedCart,
      totalDiscount: round2(updatedCart.discountAmount),
    });
  } catch (error) {
    console.error("Error increasing quantity:", error);
    return res.status(error.statusCode || 500).json({ message: "Server error", error: error.message });
  }
};

exports.decreaseQuantity = async (req, res) => {
  const { id } = req.params; // Cart item ID

  try {
    const userId = authenticatedUserId(req, req.body.userId);
    const cart = await Cart.findOne({ userId }).populate('couponId');
    if (!cart) return res.status(404).json({ message: "Cart not found" });
    await refreshCartFromCatalog(cart);

    const itemIndex = cart.items.findIndex(item => item._id.toString() === id);
    if (itemIndex === -1) return res.status(404).json({ message: "Item not found in cart" });

    const item = cart.items[itemIndex];
    if (item.quantity > 1) {
      item.quantity -= 1;
    } else {
      cart.items.splice(itemIndex, 1);
    }
    if (!cart.items.length) cart.couponId = null;
    await recalcCartWithCoupon(cart);
    await cart.save();

    const updatedCart = await Cart.findOne({ userId })
      .populate("items.productId")
      .populate("couponId");

    return res.json({
      message: "Quantity decreased",
      cart: updatedCart,
      totalDiscount: round2(updatedCart.discountAmount),
    });
  } catch (error) {
    console.error("Error decreasing quantity:", error);
    return res.status(error.statusCode || 500).json({ message: "Server error", error: error.message });
  }
};


exports.removeFromCart = async (req, res) => {
  const { itemId } = req.params;

  try {
    const userId = authenticatedUserId(req, req.params.userId);
    const cart = await Cart.findOne({ userId }).populate("couponId");
    if (!cart) return res.status(404).json({ message: "Cart not found" });
    await refreshCartFromCatalog(cart);

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
    res.status(error.statusCode || 500).json({ message: "Error removing from cart", error: error.message });
  }
};


exports.getCart = async (req, res) => {
  try {
    const userId = authenticatedUserId(req, req.params.userId);
    const cart = await Cart.findOne({ userId })
      .populate('couponId');
    if (!cart) {
      return res.status(404).json({ message: 'Cart not found' });
    }

    await refreshCartFromCatalog(cart);
    await recalcCartWithCoupon(cart);
    await cart.save();
    const populatedCart = await Cart.findById(cart._id)
      .populate('items.productId')
      .populate('couponId');
    return res.status(200).json(populatedCart);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: 'Error retrieving cart', error: error.message });
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
  if (item?.isAvailable === false) return 0;
  // `price` is the current unit amount after product discount; order/cart
  // coupons apply to that amount. `originalPrice` is retained for display.
  const p = Number(item?.price ?? item?.originalPrice ?? 0);
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

function calculateCouponDiscounts(items, coupon) {
  const rows = (items || []).map((itemDoc) => {
    const item = typeof itemDoc?.toObject === "function" ? itemDoc.toObject() : { ...itemDoc };
    const quantity = Number(item?.quantity ?? 0);
    const base = getBasePrice(item);
    const eligible = Number.isFinite(quantity) && quantity > 0 && base > 0 && isItemEligible(item, coupon);
    return {
      item,
      rawDiscount: eligible ? calculateDiscount(round2(base * quantity), coupon) : 0,
    };
  });

  const rawTotal = round2(rows.reduce((sum, row) => sum + row.rawDiscount, 0));
  const subtotal = round2(rows.reduce((sum, row) => {
    const quantity = Number(row.item?.quantity ?? 0);
    const base = getBasePrice(row.item);
    return Number.isFinite(quantity) && quantity > 0 && base > 0 ? sum + base * quantity : sum;
  }, 0));
  const configuredCap = Number(coupon?.maxDiscountAmount ?? coupon?.maxAmount);
  const cap = Number.isFinite(configuredCap) && configuredCap > 0 ? configuredCap : subtotal;
  const totalDiscount = round2(Math.min(rawTotal, cap, subtotal));

  const rawTotalCents = Math.round(rawTotal * 100);
  const targetCents = Math.min(Math.round(totalDiscount * 100), rawTotalCents);
  const allocations = rows.map((row) => ({ cents: 0, remainder: 0 }));

  if (targetCents > 0 && rawTotalCents > 0) {
    let allocatedCents = 0;
    rows.forEach((row, index) => {
      const rawCents = Math.round(row.rawDiscount * 100);
      if (rawCents <= 0) return;
      const exactCents = rawCents * targetCents / rawTotalCents;
      allocations[index] = { cents: Math.floor(exactCents), remainder: exactCents % 1 };
      allocatedCents += allocations[index].cents;
    });

    // Distribute remaining cents by largest fractional remainder. This keeps
    // item-level discounts within each line's raw discount and sums exactly
    // to the capped coupon amount.
    let remainingCents = targetCents - allocatedCents;
    const remainderOrder = rows
      .map((row, index) => ({ index, rawCents: Math.round(row.rawDiscount * 100), remainder: allocations[index].remainder }))
      .filter(({ rawCents }) => rawCents > 0)
      .sort((a, b) => b.remainder - a.remainder);
    for (const allocation of remainderOrder) {
      if (remainingCents <= 0) break;
      if (allocations[allocation.index].cents < allocation.rawCents) {
        allocations[allocation.index].cents += 1;
        remainingCents -= 1;
      }
    }
  }

  const updatedItems = rows.map((row, index) => ({
    ...row.item,
    discountApplied: allocations[index].cents / 100,
  }));

  return { items: updatedItems, totalDiscount };
}

function isItemEligible(item, coupon) {
  const aps = coupon?.applicableProducts ?? [];
  if (!Array.isArray(aps) || aps.length === 0) return true;

  const itemProductId = normId(item?.productId);
  const itemVariantId = normId(item?.variantId);
  const itemSize = normStr(item?.size);
  const itemColor = normStr(item?.colorName ?? item?.color);
  const itemRegionId = normId(item?.regionId || item?.configuration?.regionId);

  for (const ap of aps) {
    const apProductId = normId(ap?.product ?? ap?.productId);
    if (!apProductId || apProductId !== itemProductId) continue;

    const apVariants = ap?.variants ?? [];
    if (!Array.isArray(apVariants) || apVariants.length === 0) return true;

    for (const vr of apVariants) {
      const vrId = normId(vr?.variantId);
      const vrRegionId = normId(vr?.regionId);
      const vrSizes = Array.isArray(vr?.sizes) ? vr.sizes.map(normStr) : [];
      const vrColor = normStr(vr?.color);

      const variantMatch = !vrId || vrId === itemVariantId;
      const regionMatch = !vrRegionId || vrRegionId === itemRegionId;
      const sizeMatch = vrSizes.length === 0 || vrSizes.includes(itemSize);
      const colorMatch = !vrColor || vrColor === itemColor;

      if (variantMatch && regionMatch && sizeMatch && colorMatch) return true;
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

  const minimumCartValue = Number(coupon?.minCartValue ?? coupon?.minAmount ?? 0);
  if (Number.isFinite(minimumCartValue) && minimumCartValue > 0 && subtotal < minimumCartValue) {
    return { valid: false, reason: `Minimum cart value not met: ${minimumCartValue}` };
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
  const rawCode = req.body?.couponCode;

  try {
    const userId = authenticatedUserId(req, req.params.userId);
    if (!rawCode || typeof rawCode !== "string") {
      return res.status(400).json({ success: false, message: "Coupon code is required" });
    }

    const couponCode = rawCode.trim();
    let cart = await Cart.findOne({ userId }).populate("items.productId");
    if (!cart) return res.status(404).json({ success: false, message: "Cart not found" });
    await refreshCartFromCatalog(cart);

    const coupon = await Coupon.findOne({
      code: { $regex: new RegExp(`^${escapeRegex(couponCode.slice(0, 100))}$`, "i") },
      isActive: true
    });
    if (!coupon) return res.status(400).json({ success: false, message: "Invalid coupon code" });

    const { valid, reason } = validateCouponDetailed(coupon, cart.items);
    if (!valid) return res.status(400).json({ success: false, message: reason });

    const discountResult = calculateCouponDiscounts(cart.items, coupon);
    const updatedItems = discountResult.items;
    const totalDiscount = discountResult.totalDiscount;

    const totalBeforeDiscount = round2(
      updatedItems.reduce((sum, it) => sum + round2(getBasePrice(it) * Number(it.quantity ?? 0)), 0)
    );

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
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Server error" });
  }
};



exports.deleteCart = async (req, res) => {
  try {
    const userId = authenticatedUserId(req, req.params.userId);
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

    return res.status(200).json({ message: 'Cart reset successfully', resetCart: cart });
  } catch (error) {
    console.error('Error resetting cart:', error);
    return res.status(error.statusCode || 500).json({ message: 'Error resetting cart', error: error.message });
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
      await refreshCartFromCatalog(cart);
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
exports.refreshCartFromCatalog = refreshCartFromCatalog;
exports.recalcCartWithCoupon = recalcCartWithCoupon;
