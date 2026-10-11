const POSOrder = require('../models/POSOrder');
const User = require('../models/User');
const LoyaltyAccount = require('../models/LoyaltyAccount');
const LoyaltyGiftCode = require('../models/LoyaltyGiftCode');
const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/errorHandler');
const { sendPOSReceipt } = require('../utils/emailService');
const { enrichInventoryItem } = require('./InventoryController');
const { createOrderInvoicePdf } = require('../utils/orderInvoicePdf');
const escapeRegex = require('../utils/escapeRegex');
const {
  getLoyaltyAccount,
  getLoyaltySettings,
  changeLoyaltyBalance,
  calculateOrderReward,
  hashCode,
} = require('../utils/loyaltyService');

const reversePOSOrderLoyalty = async (posOrder, session = null) => {
  if (!posOrder?.loyaltyUserId) return;
  if (Number(posOrder.loyaltyAmountUsed || 0) > 0) {
    await changeLoyaltyBalance({
      userId: posOrder.loyaltyUserId,
      amountBDT: posOrder.loyaltyAmountUsed,
      direction: 'credit',
      source: 'pos_refund',
      referenceId: posOrder.orderNumber,
      note: `Restored loyalty balance for deleted, cancelled, or refunded POS order #${posOrder.orderNumber}`,
      idempotencyKey: `pos:${posOrder._id}:loyalty-restore`,
      session,
    });
  }
  if (Number(posOrder.loyaltyRewardEarned || 0) > 0) {
    await changeLoyaltyBalance({
      userId: posOrder.loyaltyUserId,
      amountBDT: posOrder.loyaltyRewardEarned,
      direction: 'debit',
      source: 'pos_refund',
      referenceId: posOrder.orderNumber,
      note: `Reversed loyalty reward for deleted, cancelled, or refunded POS order #${posOrder.orderNumber}`,
      idempotencyKey: `pos:${posOrder._id}:reward-reversal`,
      session,
      allowNegative: true,
    });
  }
  for (const redemption of posOrder.giftCodeRedemptions || []) {
    if (Number(redemption.balanceCreditedBDT || 0) > 0) {
      await changeLoyaltyBalance({
        userId: posOrder.loyaltyUserId,
        amountBDT: redemption.balanceCreditedBDT,
        direction: 'debit',
        source: 'pos_refund',
        referenceId: posOrder.orderNumber,
        note: `Reversed unused POS voucher balance ••••-${redemption.codeSuffix}`,
        idempotencyKey: `pos:${posOrder._id}:gift-remainder-reversal:${redemption.giftCodeId}`,
        session,
        allowNegative: true,
      });
    }
    await LoyaltyGiftCode.updateOne(
      { _id: redemption.giftCodeId, status: 'redeemed', redeemedBy: posOrder.loyaltyUserId, redeemedAt: redemption.redeemedAt },
      { $set: { status: 'active', redeemedBy: null, redeemedAt: null } },
      session ? { session } : {},
    );
  }
};

const inventoryVariantPopulate = {
  path: 'items.inventoryId',
  select: 'barcode realBarcode qrCode availableQuantity regionId regionName variantId productId imageUri size color price discountPrice',
  populate: {
    path: 'productId',
    select: 'name sku mainImage measureType unitName variants',
    populate: { path: 'variants.regionId', select: 'name' },
  },
};

const imageUrl = (value) => typeof value === 'string'
  ? value
  : value?.secure_url || value?.url || value?.src || value?.path || '';

const hydratePOSOrderRegions = (posOrder) => {
  if (!posOrder) return posOrder;
  const plainOrder = posOrder?.toObject ? posOrder.toObject() : posOrder;
  return {
    ...plainOrder,
    items: (plainOrder.items || []).map((plainItem) => {
      const inventory = plainItem.inventoryId;
      const enrichedInventory = inventory?.productId?.variants
        ? enrichInventoryItem(inventory)
        : inventory;
      return {
        ...plainItem,
        variantInfo: {
          ...(plainItem.variantInfo || {}),
          size: plainItem.variantInfo?.size || enrichedInventory?.size || '',
          color: plainItem.variantInfo?.color || enrichedInventory?.color?.name || enrichedInventory?.colorName || '',
          measureType: plainItem.variantInfo?.measureType || enrichedInventory?.variantId?.measureType || '',
          unitName: plainItem.variantInfo?.unitName || enrichedInventory?.variantId?.unitName || '',
          regionId: plainItem.variantInfo?.regionId || enrichedInventory?.regionId || null,
          regionName: plainItem.variantInfo?.regionName || enrichedInventory?.regionName || '',
          imageUrl: plainItem.variantInfo?.imageUrl || imageUrl(enrichedInventory?.variantImage) || imageUrl(enrichedInventory?.imageUri) || imageUrl(enrichedInventory?.productId?.mainImage),
          sku: plainItem.variantInfo?.sku || enrichedInventory?.productId?.sku || '',
          barcode: plainItem.variantInfo?.barcode || enrichedInventory?.barcode || '',
          realBarcode: plainItem.variantInfo?.realBarcode || enrichedInventory?.realBarcode || '',
          qrCode: plainItem.variantInfo?.qrCode || enrichedInventory?.qrCode || '',
        },
        productName: plainItem.productName || enrichedInventory?.productId?.name || 'Product',
      };
    }),
  };
};

const toPOSInvoiceOrder = (source) => {
  const order = source?.toObject ? source.toObject() : source;
  const items = (order.items || []).map((item) => {
    const inventory = item.inventoryId && typeof item.inventoryId === 'object' ? item.inventoryId : null;
    const directProduct = item.productId && typeof item.productId === 'object' ? item.productId : null;
    const product = directProduct?.variants?.length ? directProduct : inventory?.productId?.variants?.length ? inventory.productId : directProduct || inventory?.productId;
    const variantInfo = item.variantInfo || {};
    const variantId = inventory?.variantId || item.variantId;
    const variant = product?.variants?.find((entry) => String(entry._id) === String(variantId)) || null;
    const variantImage = imageUrl(variant?.images?.[0]) || imageUrl(variantInfo.imageUrl) || imageUrl(inventory?.imageUri) || imageUrl(product?.mainImage);
    const barcode = inventory?.barcode || variantInfo.barcode || item.scannedBarcode || '';
    const realBarcode = inventory?.realBarcode || variantInfo.realBarcode || '';
    const qrCode = inventory?.qrCode || variantInfo.qrCode || '';
    const unitPrice = Number(item.unitPrice) || Number(inventory?.price) || 0;
    const effectivePrice = Number(item.discountPrice) > 0 ? Number(item.discountPrice) : unitPrice;
    const quantity = Math.max(1, Number(item.quantity) || 1);
    return {
      name: item.productName || product?.name || 'Product',
      productId: product || item.productId,
      variantId,
      sku: variantInfo.sku || product?.sku || '',
      mainImage: variantImage,
      variantImage,
      brand: item.brand || product?.brand || '',
      quantity,
      price: effectivePrice,
      originalPrice: unitPrice,
      discountApplied: Math.max(0, unitPrice - effectivePrice) * quantity,
      size: variantInfo.size || inventory?.size || '',
      color: variantInfo.color || inventory?.color?.name || variant?.colorName || '',
      variantName: variantInfo.variantName || [variantInfo.color || inventory?.color?.name || variant?.colorName, variantInfo.size || inventory?.size].filter(Boolean).join(' / '),
      barcode,
      realBarcode,
      measureType: variantInfo.measureType || variant?.measureType || product?.measureType || '',
      unitName: variantInfo.unitName || variant?.unitName || product?.unitName || '',
      regionId: variantInfo.regionId || inventory?.regionId || variant?.regionId?._id || variant?.regionId || null,
      regionName: variantInfo.regionName || inventory?.regionName || variant?.regionId?.name || '',
      assignedInventoryItems: inventory || barcode || qrCode || realBarcode ? [{
        id: inventory?._id || '',
        barcode,
        realBarcode,
        qrCode,
        regionId: variantInfo.regionId || inventory?.regionId || null,
        regionName: variantInfo.regionName || inventory?.regionName || variant?.regionId?.name || '',
        color: variantInfo.color || inventory?.color?.name || variant?.colorName || '',
        size: variantInfo.size || inventory?.size || '',
      }] : [],
    };
  });
  return {
    orderId: order.orderNumber,
    createdAt: order.createdAt,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    shippingAddress: {
      fullName: order.customer?.name || 'Walk-in Customer',
      phone: order.customer?.phone || '',
      address: order.customer?.address || 'In-store purchase',
      city: '', state: '', postalCode: '', country: 'Bangladesh',
    },
    shipping: { name: 'Point of Sale', charge: 0 },
    shippingCost: 0,
    totalAmount: Number(order.subtotal) || items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    discountAmount: Number(order.discount) || 0,
    tax: Number(order.tax) || 0,
    grandTotal: Number(order.total) || 0,
    amountDue: (Number(order.loyaltyAmountUsed) > 0 || Number(order.giftCodeAmountUsed) > 0) && Number.isFinite(Number(order.amountDue))
      ? Number(order.amountDue)
      : Math.max(0, (Number(order.total) || 0) - (Number(order.loyaltyAmountUsed) || 0) - (Number(order.giftCodeAmountUsed) || 0)),
    loyaltyAmountUsed: Number(order.loyaltyAmountUsed) || 0,
    giftCodeAmountUsed: Number(order.giftCodeAmountUsed) || 0,
    giftCodeRedemptions: (order.giftCodeRedemptions || []).map((entry) => ({
      codeSuffix: entry.codeSuffix,
      faceValueBDT: entry.faceValueBDT,
      appliedBDT: entry.appliedBDT,
    })),
    loyaltyRewardEarned: Number(order.loyaltyRewardEarned) || 0,
    items,
  };
};

const sendPOSReceiptWithPdf = async (posOrder) => {
  const hydrated = hydratePOSOrderRegions(posOrder);
  const pdf = await createOrderInvoicePdf(toPOSInvoiceOrder(hydrated));
  return sendPOSReceipt(hydrated, pdf);
};

// Generate unique POS order number
async function generatePOSOrderNumber() {
  const MAX_ATTEMPTS = 10;
  let orderNumber;
  let exists = true;
  let attempts = 0;

  while (exists && attempts < MAX_ATTEMPTS) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    
    orderNumber = `POS${year}${month}${day}${random}`;
    exists = await POSOrder.exists({ orderNumber });
    attempts++;
  }

  if (exists) {
    throw new Error(`Could not generate unique POS order number after ${MAX_ATTEMPTS} attempts`);
  }
  return orderNumber;
}

// Create new POS order
exports.createPOSOrder = catchAsyncErrors(async (req, res, next) => {
  const {
    customer,
    items,
    subtotal,
    tax,
    discount,
    total,
    paymentMethod,
    outlet,
    notes,
    loyaltyUserId,
    loyaltyAmountBDT = 0,
    loyaltyGiftCode = '',
  } = req.body;

  // Validate items and check inventory
  if (!Array.isArray(items) || items.length === 0) {
    return next(new ErrorHandler('Order must contain at least one item', 400));
  }

  const seenInventoryIds = new Set();
  const normalizedItems = [];

  for (const item of items) {
    const qty = Math.max(1, Number(item.quantity) || 1);

    if (seenInventoryIds.has(String(item.inventoryId))) {
      return next(new ErrorHandler('Duplicate inventory item in cart: same unit scanned twice', 400));
    }
    seenInventoryIds.add(String(item.inventoryId));

    const inventory = await Inventory.findById(item.inventoryId);
    if (!inventory) {
      return next(new ErrorHandler(`Inventory item not found: ${item.inventoryId}`, 404));
    }

    if (inventory.availableQuantity < qty) {
      return next(new ErrorHandler(`Insufficient stock for ${inventory.barcode}`, 400));
    }

    if (item.productId && String(item.productId) !== String(inventory.productId)) {
      return next(new ErrorHandler(`Inventory product does not match ${inventory.barcode}`, 400));
    }

    const product = await Product.findById(inventory.productId)
      .select('name slug sku brand categories costPrice mainImage measureType unitName variants')
      .populate('variants.regionId', 'name');
    const variant = product?.variants?.id(inventory.variantId)
      || product?.variants?.find((entry) => String(entry._id) === String(inventory.variantId));
    const unitPrice = Math.max(0, Number(inventory.price) || 0);
    const rawDiscountPrice = Number(inventory.discountPrice);
    const discountPrice = rawDiscountPrice > 0 && rawDiscountPrice < unitPrice ? rawDiscountPrice : null;
    const effectivePrice = discountPrice || unitPrice;
    const variantImage = imageUrl(variant?.images?.[0]) || imageUrl(inventory.imageUri) || imageUrl(product?.mainImage);
    const regionId = inventory.regionId || variant?.regionId?._id || variant?.regionId || null;
    const regionName = inventory.regionName || variant?.regionId?.name || '';
    const colorName = inventory.color?.name || variant?.colorName || '';
    const size = inventory.size || item.variantInfo?.size || item.size || '';
    const option = (variant?.options || []).find((entry) => String(entry.size || '').trim().toLowerCase() === String(size).trim().toLowerCase());
    const rawCostPrice = inventory.costPrice ?? option?.costPrice ?? variant?.costPrice ?? product?.costPrice;
    const costPrice = rawCostPrice !== null && rawCostPrice !== undefined && Number.isFinite(Number(rawCostPrice)) ? Number(rawCostPrice) : null;

    normalizedItems.push({
      inventoryId: item.inventoryId,
      productId: inventory.productId,
      productSlug: product?.slug || '',
      brand: product?.brand || '',
      categories: product?.categories || [],
      productName: product?.name || item.productName || 'Product',
      sku: product?.sku || '',
      variantInfo: {
        size,
        color: colorName || item.variantInfo?.color || item.color,
        barcode: inventory.barcode,
        realBarcode: inventory.realBarcode || item.variantInfo?.realBarcode || '',
        qrCode: inventory.qrCode || item.variantInfo?.qrCode || '',
        variantId: variant?._id || null,
        variantName: [colorName, size].filter(Boolean).join(' / '),
        hexCode: inventory.color?.hexCode || variant?.hexCode || '',
        measureType: variant?.measureType || product?.measureType || item.measureType || item.variantInfo?.measureType || '',
        unitName: variant?.unitName || product?.unitName || item.unitName || item.variantInfo?.unitName || '',
        regionId,
        regionName,
        imageUrl: variantImage,
        sku: product?.sku || '',
      },
      quantity: qty,
      unitPrice,
      discountPrice,
      costPrice,
      totalPrice: effectivePrice * qty,
      scannedBarcode: inventory.barcode || item.scannedBarcode || '',
    });
  }

  const orderSubtotal = normalizedItems.reduce((sum, item) => sum + item.totalPrice, 0);
  const orderTax = Math.max(0, Number.isFinite(Number(tax)) ? Number(tax) : 0);
  const orderDiscount = Math.max(0, Number.isFinite(Number(discount)) ? Number(discount) : 0);
  const orderTotal = Math.max(0, orderSubtotal + orderTax - orderDiscount);

  const requestedLoyalty = Number(loyaltyAmountBDT || 0);
  if (!Number.isFinite(requestedLoyalty) || requestedLoyalty < 0) {
    return next(new ErrorHandler('Enter a valid BDT loyalty amount', 400));
  }
  if (requestedLoyalty > 0 && !mongoose.isValidObjectId(loyaltyUserId)) {
    return next(new ErrorHandler('Look up and select a loyalty customer before applying BDT', 400));
  }
  const normalizedGiftCode = String(loyaltyGiftCode || '').trim().toUpperCase();
  if (normalizedGiftCode && !mongoose.isValidObjectId(loyaltyUserId)) {
    return next(new ErrorHandler('Look up and select a loyalty customer before redeeming a gift code', 400));
  }
  if (normalizedGiftCode.length > 100) return next(new ErrorHandler('Gift code is invalid', 400));

  // Generate unique order number
  const orderNumber = await generatePOSOrderNumber();
  const session = await mongoose.startSession();
  let posOrder;
  try {
    session.startTransaction();
    const member = loyaltyUserId ? await User.findById(loyaltyUserId).session(session) : null;
    if (loyaltyUserId && !member) throw new ErrorHandler('Loyalty customer was not found', 404);
    const settings = await getLoyaltySettings(session);
    const account = member ? await getLoyaltyAccount(member._id, session) : null;
    const redeemLimit = settings.enabled ? orderTotal * Number(settings.maxRedeemPercent || 0) / 100 : 0;
    const loyaltyUsed = Math.round(Math.min(requestedLoyalty, Number(account?.balanceBDT || 0), redeemLimit, orderTotal) * 100) / 100;
    let giftCodeRecord = null;
    let giftCodeApplied = 0;
    let giftCodeBalanceCredited = 0;
    let giftCodeRedeemedAt = null;
    if (normalizedGiftCode) {
      const now = new Date();
      giftCodeRecord = await LoyaltyGiftCode.findOneAndUpdate(
        { codeHash: hashCode(normalizedGiftCode), status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
        { $set: { status: 'redeemed', redeemedBy: member._id, redeemedAt: now } },
        { new: true, session },
      );
      if (!giftCodeRecord) throw new ErrorHandler('Gift code is invalid, expired, or already redeemed', 400);
      giftCodeRedeemedAt = now;
      giftCodeApplied = Math.round(Math.min(Number(giftCodeRecord.amountBDT) || 0, Math.max(0, orderTotal - loyaltyUsed)) * 100) / 100;
      giftCodeBalanceCredited = Math.round(Math.max(0, Number(giftCodeRecord.amountBDT) - giftCodeApplied) * 100) / 100;
    }
    const rewardEarned = member ? await calculateOrderReward({ userId: member._id, totalAmount: orderSubtotal, discountAmount: orderDiscount }, session) : 0;

    posOrder = new POSOrder({
      orderNumber,
      customer: {
        ...customer,
        name: customer?.name || member?.fullName || 'Walk-in Customer',
        email: customer?.email || member?.email || '',
        phone: customer?.phone || member?.phoneNumber || '',
      },
      loyaltyUserId: member?._id || null,
      loyaltyAmountUsed: loyaltyUsed,
      giftCodeAmountUsed: giftCodeApplied,
      giftCodeRedemptions: giftCodeRecord ? [{
        giftCodeId: giftCodeRecord._id,
        codeSuffix: giftCodeRecord.codeSuffix,
        faceValueBDT: giftCodeRecord.amountBDT,
        appliedBDT: giftCodeApplied,
        balanceCreditedBDT: giftCodeBalanceCredited,
        redeemedAt: giftCodeRedeemedAt,
      }] : [],
      loyaltyRewardEarned: rewardEarned,
      amountDue: Math.max(0, Math.round((orderTotal - loyaltyUsed - giftCodeApplied) * 100) / 100),
      items: normalizedItems,
      subtotal: orderSubtotal,
      tax: orderTax,
      discount: orderDiscount,
      total: orderTotal,
      paymentMethod,
      paymentStatus: 'completed',
      orderStatus: 'completed',
      cashier: req.admin.id,
      outlet,
      notes: [String(notes || '').trim(), giftCodeRecord ? `Gift code redeemed ••••-${giftCodeRecord.codeSuffix} · ${giftCodeApplied.toFixed(2)} BDT applied` : ''].filter(Boolean).join('\n').slice(0, 5000),
    });
    await posOrder.save({ session });

    if (giftCodeBalanceCredited > 0 && member) {
      await changeLoyaltyBalance({
        userId: member._id,
        amountBDT: giftCodeBalanceCredited,
        direction: 'credit',
        source: 'pos_gift_code',
        referenceId: orderNumber,
        note: `Unused voucher value ••••-${giftCodeRecord.codeSuffix} credited to loyalty balance`,
        idempotencyKey: `pos:${orderNumber}:gift-code-remainder:${giftCodeRecord._id}`,
        createdBy: req.admin.id,
        session,
      });
    }

    if (loyaltyUsed > 0 && member) {
      await changeLoyaltyBalance({
        userId: member._id,
        amountBDT: loyaltyUsed,
        direction: 'debit',
        source: 'pos_redemption',
        referenceId: orderNumber,
        note: `Loyalty balance used at POS order #${orderNumber}`,
        idempotencyKey: `pos:${orderNumber}:redeem`,
        session,
      });
    }
    if (rewardEarned > 0 && member) {
      await changeLoyaltyBalance({
        userId: member._id,
        amountBDT: rewardEarned,
        direction: 'credit',
        source: 'pos_reward',
        referenceId: orderNumber,
        note: `Loyalty reward for POS order #${orderNumber}`,
        idempotencyKey: `pos:${orderNumber}:reward`,
        session,
      });
    }

    // Update inventory in the same transaction as loyalty balance and sale.
    for (const item of normalizedItems) {
      await Inventory.findByIdAndUpdate(item.inventoryId, [
        {
          $set: {
            assignedQuantity: item.quantity,
            availableQuantity: { $max: [0, { $subtract: ['$stockQuantity', item.quantity] }] },
            status: {
              $cond: [{ $lte: [{ $subtract: ['$stockQuantity', item.quantity] }, 0] }, 'out_of_stock', 'active']
            },
            lastUpdated: new Date()
          }
        }
      ], { session });
    }
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }

  // Broadcast live purchase via socket
  try {
    const io = req.app.get('socketio');
    if (io) {
      for (const item of items) {
        const prod = await Product.findById(item.productId).select('name');
        if (prod) {
          io.emit('livePurchase', {
            productId: item.productId,
            productName: prod.name || item.productName,
            quantity: item.quantity,
            timestamp: new Date()
          });
        }
      }
    }
  } catch (e) {
    console.error('Failed to broadcast purchase:', e.message);
  }

  // Send receipt email (non-blocking)
  if (posOrder.customer?.email) {
    sendPOSReceiptWithPdf(posOrder).catch(err => {
      console.error('Failed to send POS receipt email:', err.message);
    });
  }

  res.status(201).json({
    success: true,
    posOrder
  });
});

exports.findLoyaltyCustomer = catchAsyncErrors(async (req, res, next) => {
  const search = String(req.query.query || '').trim();
  if (search.length < 3) return next(new ErrorHandler('Enter at least 3 characters of phone or email', 400));
  const normalizedPhone = search.replace(/[\s()-]/g, '');
  const user = await User.findOne({
    $or: [
      { email: search.toLowerCase() },
      { phoneNumber: normalizedPhone },
      { phoneNumber: { $regex: `^${escapeRegex(normalizedPhone)}$`, $options: 'i' } },
    ],
  }).select('firstName lastName fullName email phoneNumber');
  if (!user) return next(new ErrorHandler('No registered customer matched that phone or email', 404));
  const account = await LoyaltyAccount.findOne({ userId: user._id }).lean();
  const loyaltySettings = await getLoyaltySettings();
  return res.json({
    success: true,
    customer: {
      userId: String(user._id),
      name: user.fullName || `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      phone: user.phoneNumber || '',
      balanceBDT: Math.round(Number(account?.balanceBDT || 0) * 100) / 100,
      tierName: account?.tierName || '',
      earnRatePercent: account?.earnRatePercent ?? loyaltySettings.earnRatePercent,
      enabled: loyaltySettings.enabled,
      maxRedeemPercent: loyaltySettings.maxRedeemPercent,
    },
  });
});

exports.validatePOSGiftCode = catchAsyncErrors(async (req, res, next) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const userId = String(req.body?.userId || '');
  if (code.length < 6 || code.length > 100) return next(new ErrorHandler('Enter a valid gift code', 400));
  if (!mongoose.isValidObjectId(userId) || !await User.exists({ _id: userId })) {
    return next(new ErrorHandler('Look up and select a loyalty customer before redeeming a gift code', 400));
  }
  const now = new Date();
  const gift = await LoyaltyGiftCode.findOne({
    codeHash: hashCode(code),
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).select('amountBDT codeSuffix expiresAt').lean();
  if (!gift) return next(new ErrorHandler('Gift code is invalid, expired, or already redeemed', 404));
  return res.json({
    success: true,
    giftCode: { amountBDT: gift.amountBDT, codeSuffix: gift.codeSuffix, expiresAt: gift.expiresAt || null },
  });
});

// Get all POS orders
exports.getAllPOSOrders = catchAsyncErrors(async (req, res, next) => {
  const { page = 1, limit = 10, status, outlet, dateFrom, dateTo, search } = req.query;
  
  const query = {};
  
  if (status) query.orderStatus = status;
  if (outlet) query.outlet = outlet;
  if (search) {
    const rx = { $regex: String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    query.$or = [
      { orderNumber: rx },
      { 'customer.name': rx },
      { 'customer.phone': rx }
    ];
  }
  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }

  const posOrders = await POSOrder.find(query)
    .populate('cashier', 'firstName lastName')
    .populate(inventoryVariantPopulate)
    .populate('items.productId', 'name images')
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const hydratedPOSOrders = posOrders.map(hydratePOSOrderRegions);
  const total = await POSOrder.countDocuments(query);

  res.status(200).json({
    success: true,
    posOrders: hydratedPOSOrders,
    totalPages: Math.ceil(total / limit),
    currentPage: page,
    total
  });
});

// Get single POS order
exports.getPOSOrder = catchAsyncErrors(async (req, res, next) => {
  const posOrder = await POSOrder.findById(req.params.id)
    .populate('cashier', 'firstName lastName')
    .populate(inventoryVariantPopulate)
    .populate('items.productId', 'name images');

  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  res.status(200).json({
    success: true,
    posOrder: hydratePOSOrderRegions(posOrder)
  });
});

// Update POS order status
exports.updatePOSOrderStatus = catchAsyncErrors(async (req, res, next) => {
  const { orderStatus, paymentStatus } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const posOrder = await POSOrder.findById(req.params.id).session(session);
    if (!posOrder) {
      await session.abortTransaction();
      return next(new ErrorHandler('POS Order not found', 404));
    }
    posOrder.orderStatus = orderStatus || posOrder.orderStatus;
    posOrder.paymentStatus = paymentStatus || posOrder.paymentStatus;
    if (['cancelled', 'refunded'].includes(String(posOrder.orderStatus).toLowerCase()) || posOrder.paymentStatus === 'refunded') {
      await reversePOSOrderLoyalty(posOrder, session);
    }
    await posOrder.save({ session });
    await session.commitTransaction();
    return res.status(200).json({ success: true, posOrder });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
});

// Scan generated barcode, manufacturer barcode, QR, or product SKU.
exports.scanBarcode = catchAsyncErrors(async (req, res, next) => {
  const { barcode } = req.body;
  if (!barcode) {
    return next(new ErrorHandler('Barcode is required', 400));
  }

  const code = String(barcode).trim();
  const PROJ = 'name mainImage mainPrice variants sku';
  const populatePOSProduct = (query) => query.populate({
    path: 'productId',
    select: PROJ,
    populate: { path: 'variants.regionId', select: 'name' },
  });
  let inventory = await populatePOSProduct(Inventory.findOne({ barcode: code }));

  if (!inventory) {
    inventory = await populatePOSProduct(Inventory.findOne({ qrCode: code }));
  }

  if (!inventory) {
    inventory = await populatePOSProduct(Inventory.findOne({ realBarcode: code, availableQuantity: { $gt: 0 }, status: 'active' }).sort({ createdAt: 1 }));
  }

  if (!inventory) {
    // Product-level SKU: sell first available unit of that product
    const product = await Product.findOne({ sku: { $regex: `^${escapeRegex(code)}$`, $options: 'i' } }).select('_id');
    if (product) {
      inventory = await populatePOSProduct(Inventory.findOne({ productId: product._id, availableQuantity: { $gt: 0 } }));
    }
  }

  if (!inventory) {
    return next(new ErrorHandler('Product not found with this barcode', 404));
  }

  if (inventory.availableQuantity <= 0) {
    return next(new ErrorHandler('Product is out of stock', 400));
  }

  res.status(200).json({
    success: true,
    inventory: enrichInventoryItem(inventory.toObject())
  });
});

// Search products by name, SKU, generated or manufacturer barcode, or QR code.
exports.searchProducts = catchAsyncErrors(async (req, res, next) => {
  const { query } = req.query;
  if (!query) {
    return res.status(200).json({ success: true, inventory: [] });
  }

  const rx = { $regex: String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

  // Product name / SKU matches → their available inventory units
  const products = await Product.find({ $or: [{ name: rx }, { sku: rx }] }).select('_id').limit(50);

  const inventory = await Inventory.find({
    $or: [
      { barcode: rx },
      { realBarcode: rx },
      { qrCode: rx },
      ...(products.length ? [{ productId: { $in: products.map(p => p._id) } }] : [])
    ]
  })
  .populate({
    path: 'productId',
    select: 'name mainImage mainPrice variants sku',
    populate: { path: 'variants.regionId', select: 'name' },
  })
  .limit(10);

  res.status(200).json({
    success: true,
    inventory: inventory.map(item => enrichInventoryItem(item.toObject()))
  });
});

// Get POS dashboard stats
exports.getPOSStats = catchAsyncErrors(async (req, res, next) => {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  const todayOrders = await POSOrder.find({
    createdAt: { $gte: startOfDay, $lt: endOfDay }
  });

  const totalSales = todayOrders.reduce((sum, order) => sum + order.total, 0);
  const totalOrders = todayOrders.length;
  const completedOrders = todayOrders.filter(order => order.orderStatus === 'completed').length;

  // Get low stock items (items with availableQuantity <= 0)
  const lowStockItems = await Inventory.find({
    availableQuantity: { $lte: 0 }
  })
  .populate('productId', 'name')
  .limit(5);

  res.status(200).json({
    success: true,
    stats: {
      todaySales: totalSales,
      todayOrders: totalOrders,
      completedOrders,
      lowStockItems
    }
  });
});

// Get recent POS orders
exports.getRecentPOSOrders = catchAsyncErrors(async (req, res, next) => {
  const recentOrders = await POSOrder.find()
    .populate('cashier', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(10);

  res.status(200).json({
    success: true,
    recentOrders
  });
});

// Print receipt
exports.printReceipt = catchAsyncErrors(async (req, res, next) => {
  const posOrder = await POSOrder.findById(req.params.id)
    .populate('cashier', 'firstName lastName')
    .populate('items.productId', 'name')
    .populate(inventoryVariantPopulate);

  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  const receipt = {
    orderNumber: posOrder.orderNumber,
    date: posOrder.createdAt,
    cashier: posOrder.cashier,
    customer: posOrder.customer,
    items: hydratePOSOrderRegions(posOrder).items,
    subtotal: posOrder.subtotal,
    tax: posOrder.tax,
    discount: posOrder.discount,
    total: posOrder.total,
    loyaltyAmountUsed: posOrder.loyaltyAmountUsed,
    giftCodeAmountUsed: posOrder.giftCodeAmountUsed || 0,
    giftCodeRedemptions: (posOrder.giftCodeRedemptions || []).map((entry) => ({ codeSuffix: entry.codeSuffix, appliedBDT: entry.appliedBDT })),
    amountDue: Number(posOrder.loyaltyAmountUsed) > 0 || Number(posOrder.giftCodeAmountUsed) > 0 ? posOrder.amountDue : posOrder.total,
    paymentMethod: posOrder.paymentMethod
  };

  res.status(200).json({
    success: true,
    receipt
  });
});

// Refund POS order
exports.refundPOSOrder = catchAsyncErrors(async (req, res, next) => {
  const { refundAmount, reason } = req.body;

  const posOrder = await POSOrder.findById(req.params.id);
  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  const orderTotal = Number(posOrder.total) || 0;
  const alreadyRefunded = Number(posOrder.refundAmount) || 0;
  const requestedRefund = Number(refundAmount);
  const remainingRefundable = Math.max(0, orderTotal - alreadyRefunded);
  if (!Number.isFinite(requestedRefund) || requestedRefund <= 0 || requestedRefund > remainingRefundable + 0.001) {
    return next(new ErrorHandler(`Refund must be greater than zero and no more than BDT ${remainingRefundable.toFixed(2)}`, 400));
  }

  posOrder.refundAmount = Math.round((alreadyRefunded + requestedRefund + Number.EPSILON) * 100) / 100;
  const isFullyRefunded = posOrder.refundAmount >= orderTotal - 0.001;
  posOrder.paymentStatus = isFullyRefunded ? 'refunded' : 'partially_refunded';
  if (isFullyRefunded) posOrder.orderStatus = 'refunded';
  const refundNote = `Refund: BDT ${requestedRefund.toFixed(2)}${reason ? ` - ${String(reason).trim()}` : ''}`;
  posOrder.notes = [posOrder.notes, refundNote].filter(Boolean).join('\n');

  // Only a full refund returns all order stock. Partial money refunds do not
  // imply that inventory was physically returned.
  if (isFullyRefunded) {
    for (const item of posOrder.items) {
      await Inventory.findByIdAndUpdate(item.inventoryId, [
        {
          $set: {
            assignedQuantity: 0,
            availableQuantity: '$stockQuantity',
            status: 'active',
            lastUpdated: new Date()
          }
        }
      ]);
    }
    await reversePOSOrderLoyalty(posOrder);
  }

  await posOrder.save();

  res.status(200).json({
    success: true,
    posOrder
  });
});

// Delete POS order
exports.deletePOSOrder = catchAsyncErrors(async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const posOrder = await POSOrder.findById(req.params.id).session(session);
    if (!posOrder) {
      await session.abortTransaction();
      return next(new ErrorHandler('POS Order not found', 404));
    }

    // Keep stock and wallet changes atomic with the POS order deletion.
    for (const item of posOrder.items) {
      await Inventory.findByIdAndUpdate(item.inventoryId, [
        {
          $set: {
            assignedQuantity: 0,
            availableQuantity: '$stockQuantity',
            status: 'active',
            lastUpdated: new Date()
          }
        }
      ], { session });
    }
    await reversePOSOrderLoyalty(posOrder, session);
    await POSOrder.findByIdAndDelete(req.params.id).session(session);
    await session.commitTransaction();
    return res.status(200).json({ success: true, message: 'POS Order deleted and loyalty balance reconciled' });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
});

// Email a copy of the receipt/invoice to the customer
exports.sendPOSInvoiceEmail = catchAsyncErrors(async (req, res, next) => {
  const posOrder = await POSOrder.findById(req.params.id)
    .populate('cashier', 'firstName lastName')
    .populate('items.productId', 'name sku mainImage measureType unitName variants')
    .populate(inventoryVariantPopulate);

  if (!posOrder) {
    return next(new ErrorHandler('POS Order not found', 404));
  }

  if (!posOrder.customer?.email) {
    return next(new ErrorHandler('This order has no customer email address', 400));
  }

  const result = await sendPOSReceiptWithPdf(posOrder);
  if (!result.success) {
    return next(new ErrorHandler(result.message || result.error || 'Failed to send invoice email', 500));
  }

  res.status(200).json({
    success: true,
    message: `Invoice emailed to ${posOrder.customer.email}`,
    messageId: result.messageId
  });
});
