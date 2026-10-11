const crypto = require('crypto');
const LoyaltyAccount = require('../models/LoyaltyAccount');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const LoyaltySettings = require('../models/LoyaltySettings');
const DigitalProductCode = require('../models/DigitalProductCode');

const roundBDT = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const hashCode = (value) => crypto.createHash('sha256').update(String(value).trim().toUpperCase()).digest('hex');
const digitalEncryptionKey = () => crypto.createHash('sha256')
  .update(process.env.DIGITAL_CODE_ENCRYPTION_KEY || process.env.JWT_SECRET || 'belorella-digital-code-key')
  .digest();

const encryptDigitalCode = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', digitalEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
};

const decryptDigitalCode = (value) => {
  const [ivValue, tagValue, encryptedValue] = String(value || '').split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Digital redemption code is unreadable');
  const decipher = crypto.createDecipheriv('aes-256-gcm', digitalEncryptionKey(), Buffer.from(ivValue, 'base64'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64')), decipher.final()]).toString('utf8');
};

const getLoyaltyAccount = async (userId, session = null) => {
  const query = LoyaltyAccount.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, balanceBDT: 0 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) },
  );
  return query;
};

const getLoyaltySettings = async (session = null) => LoyaltySettings.findOneAndUpdate(
  { _id: 'global' },
  { $setOnInsert: { _id: 'global', enabled: true, earnRatePercent: 1, maxRedeemPercent: 100 } },
  { new: true, upsert: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) },
);

const changeLoyaltyBalance = async ({
  userId, amountBDT, direction, source, idempotencyKey, referenceId = '', note = '', createdBy = null, session = null, allowNegative = false,
}) => {
  const amount = roundBDT(amountBDT);
  if (!userId || !Number.isFinite(amount) || amount <= 0 || !['credit', 'debit'].includes(direction)) {
    throw new Error('A valid customer, direction, and BDT amount are required');
  }
  const previous = await LoyaltyTransaction.findOne({ idempotencyKey }).session(session || null);
  if (previous) return { transaction: previous, duplicate: true };

  await getLoyaltyAccount(userId, session);
  const filter = { userId };
  if (direction === 'debit' && !allowNegative) filter.balanceBDT = { $gte: amount };
  const updatedAccount = await LoyaltyAccount.findOneAndUpdate(
    filter,
    { $inc: { balanceBDT: direction === 'credit' ? amount : -amount } },
    { new: true, ...(session ? { session } : {}) },
  );
  if (!updatedAccount) throw new Error('The customer does not have enough BDT balance');

  const transaction = new LoyaltyTransaction({
    userId, direction, amountBDT: amount, balanceAfterBDT: roundBDT(updatedAccount.balanceBDT),
    source, idempotencyKey, referenceId: String(referenceId || ''), note, createdBy,
  });
  await transaction.save(session ? { session } : undefined);
  return { account: updatedAccount, transaction, duplicate: false };
};

const calculateOrderReward = async (order, session = null) => {
  const settings = await getLoyaltySettings(session);
  if (!settings.enabled) return 0;
  const account = order?.userId ? await getLoyaltyAccount(order.userId, session) : null;
  const configuredRate = account?.earnRatePercent;
  const earnRatePercent = configuredRate !== null && configuredRate !== undefined
    ? Number(configuredRate)
    : Number(settings.earnRatePercent);
  if (!Number.isFinite(earnRatePercent) || earnRatePercent <= 0) return 0;
  const eligibleAmount = Math.max(0, Number(order.totalAmount || 0) - Number(order.discountAmount || 0));
  return roundBDT(eligibleAmount * earnRatePercent / 100);
};

const earnOrderReward = async (order, session = null, source = 'order_reward') => {
  const amountBDT = await calculateOrderReward(order, session);
  if (!amountBDT || !order.userId) return 0;
  const { transaction } = await changeLoyaltyBalance({
    userId: order.userId,
    amountBDT,
    direction: 'credit',
    source,
    referenceId: order.orderId,
    idempotencyKey: `order:${order._id}:reward`,
    note: `Loyalty reward for order #${order.orderId}`,
    session,
  });
  return Number(transaction.amountBDT || 0);
};

const reserveDigitalCodesForOrder = async (order, session) => {
  for (const item of order.items || []) {
    if (!item.isDigitalProduct) continue;
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const reservations = [];
    for (let index = 0; index < quantity; index += 1) {
      const variantId = item.variantId?._id || item.variantId || null;
      let code = variantId
        ? await DigitalProductCode.findOneAndUpdate(
          { productId: item.productId, status: 'available', variantId },
          { $set: { status: 'reserved', reservedOrderId: order._id, reservedItemId: item._id, reservedAt: new Date() } },
          { new: true, sort: { createdAt: 1 }, session },
        )
        : null;
      if (!code) {
        code = await DigitalProductCode.findOneAndUpdate(
          { productId: item.productId, status: 'available', variantId: null },
          { $set: { status: 'reserved', reservedOrderId: order._id, reservedItemId: item._id, reservedAt: new Date() } },
          { new: true, sort: { createdAt: 1 }, session },
        );
      }
      if (!code) {
        // Orders may be fulfilled manually from the admin order screen when
        // preloaded code stock is empty or short. Keep any codes already
        // reserved and let the admin complete the remainder.
        break;
      }
      reservations.push(code._id);
    }
    item.digitalCodeIds = reservations;
  }
  await order.save({ session });
};

const releaseDigitalCodesForOrder = async (order, session) => DigitalProductCode.updateMany(
  { reservedOrderId: order._id, status: 'reserved' },
  { $set: { status: 'available', reservedOrderId: null, reservedItemId: null, reservedAt: null } },
  session ? { session } : {},
);

const sendOrderDigitalCodes = async (order, user) => {
  if (!user?.email) return { success: false, message: 'Customer email is missing' };
  const itemGroups = [];
  for (const item of order.items || []) {
    if (!item.isDigitalProduct) continue;
    const ids = item.digitalCodeIds || [];
    if (!ids.length) continue;
    const records = await DigitalProductCode.find({ _id: { $in: ids }, reservedOrderId: order._id, status: 'reserved' })
      .select('+codeEncrypted')
      .lean();
    if (records.length < Math.max(1, Number(item.quantity) || 1)) {
      return { success: false, message: `Digital code stock is incomplete for ${item.name}; add the remaining details from the admin order screen.` };
    }
    itemGroups.push({
      itemId: String(item._id),
      productName: item.name,
      variantName: item.variantName || [item.color, item.size].filter(Boolean).join(' / '),
      codes: records.map((record) => decryptDigitalCode(record.codeEncrypted)),
      recordIds: records.map((record) => record._id),
    });
  }
  if (!itemGroups.length || itemGroups.some((group) => !group.codes.length)) {
    return { success: false, message: 'No reserved digital codes are ready to send' };
  }
  const { sendDigitalProductCodesEmail } = require('./emailService');
  const result = await sendDigitalProductCodesEmail({ user, order, itemGroups });
  if (result.success) {
    await DigitalProductCode.updateMany(
      { _id: { $in: itemGroups.flatMap((group) => group.recordIds) }, status: 'reserved' },
      { $set: { status: 'sent', sentAt: new Date() } },
    );
  }
  return result;
};

const readManualDigitalFulfillment = (item) => {
  if (!item?.manualDigitalFulfillmentEncrypted) return {};
  try {
    const value = JSON.parse(decryptDigitalCode(item.manualDigitalFulfillmentEncrypted));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

const sendOrderManualDigitalFulfillment = async (order, user) => {
  if (!user?.email) return { success: false, message: 'Customer email is missing' };
  const labels = {
    code: 'Redemption code / license key',
    loginId: 'Account ID / login',
    username: 'Username / email',
    password: 'Password',
    pin: 'PIN',
    accessUrl: 'Access / redemption URL',
    expiry: 'Expiry',
    serialNumber: 'Serial number',
    instructions: 'How to use',
    additionalDetails: 'Additional details',
  };
  const digitalItems = (order.items || []).filter((item) => item.isDigitalProduct);
  const itemGroups = digitalItems.map((item) => {
    const data = readManualDigitalFulfillment(item);
    const details = Object.entries(labels)
      .filter(([key]) => String(data[key] || '').trim())
      .map(([key, label]) => ({ field: key, label, value: String(data[key]).trim() }));
    return {
      itemId: String(item._id),
      productName: item.name,
      variantName: item.variantName || [item.color, item.size].filter(Boolean).join(' / '),
      details,
      sentAt: item.manualDigitalFulfillmentSentAt || null,
    };
  }).filter((group) => group.details.length > 0);
  if (!itemGroups.length) return { success: false, message: 'Add digital delivery details to at least one digital order item first' };

  const { sendDigitalProductCodesEmail } = require('./emailService');
  const result = await sendDigitalProductCodesEmail({ user, order, itemGroups, isManualFulfillment: true });
  if (result.success) {
    const sentAt = new Date();
    const sentIds = new Set(itemGroups.map((group) => group.itemId));
    const fulfilledItemIds = digitalItems.filter((item) => sentIds.has(String(item._id))).map((item) => item._id);
    for (const item of digitalItems) {
      if (sentIds.has(String(item._id))) item.manualDigitalFulfillmentSentAt = sentAt;
    }
    if (fulfilledItemIds.length) {
      await DigitalProductCode.updateMany(
        { reservedOrderId: order._id, reservedItemId: { $in: fulfilledItemIds }, status: 'reserved' },
        { $set: { status: 'available', reservedOrderId: null, reservedItemId: null, reservedAt: null } },
      );
    }
    await order.save();
  }
  return result;
};

module.exports = {
  roundBDT,
  hashCode,
  encryptDigitalCode,
  decryptDigitalCode,
  getLoyaltyAccount,
  getLoyaltySettings,
  changeLoyaltyBalance,
  calculateOrderReward,
  earnOrderReward,
  reserveDigitalCodesForOrder,
  releaseDigitalCodesForOrder,
  sendOrderDigitalCodes,
  readManualDigitalFulfillment,
  sendOrderManualDigitalFulfillment,
};
