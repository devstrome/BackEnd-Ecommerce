const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Product = require('../models/Product');
const LoyaltyAccount = require('../models/LoyaltyAccount');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const LoyaltyGiftCode = require('../models/LoyaltyGiftCode');
const LoyaltySettings = require('../models/LoyaltySettings');
const DigitalProductCode = require('../models/DigitalProductCode');
const { sendLoyaltyTierEmail } = require('../utils/emailService');
const {
  hashCode,
  encryptDigitalCode,
  decryptDigitalCode,
  getLoyaltyAccount,
  getLoyaltySettings,
  changeLoyaltyBalance,
} = require('../utils/loyaltyService');

const roundBDT = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const makeGiftCode = () => {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `BEL-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
};

exports.getMyLoyalty = async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ success: false, message: 'Login required' });
    const [account, transactions, settings] = await Promise.all([
      getLoyaltyAccount(userId),
      LoyaltyTransaction.find({ userId }).sort({ createdAt: -1 }).limit(100).lean(),
      getLoyaltySettings(),
    ]);
    return res.json({
      success: true,
      balanceBDT: roundBDT(account.balanceBDT),
      transactions,
      tierName: account.tierName || '',
      earnRatePercent: account.earnRatePercent ?? settings.earnRatePercent,
      tierAssignedAt: account.tierAssignedAt || null,
      maxRedeemPercent: settings.maxRedeemPercent,
      enabled: settings.enabled,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load loyalty balance' });
  }
};

exports.listLoyaltyCustomers = async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 120);
    const userFilter = {};
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      userFilter.$or = [
          { fullName: { $regex: escaped, $options: 'i' } },
          { firstName: { $regex: escaped, $options: 'i' } },
          { lastName: { $regex: escaped, $options: 'i' } },
          { email: { $regex: escaped, $options: 'i' } },
      ];
    }
    const users = await User.find(userFilter)
      .select('firstName lastName fullName email')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    const accounts = await LoyaltyAccount.find({ userId: { $in: users.map((user) => user._id) } }).lean();
    const accountsByUserId = new Map(accounts.map((account) => [String(account.userId), account]));
    const customers = users.map((user) => {
      const account = accountsByUserId.get(String(user._id));
      return {
        userId: String(user._id),
        fullName: user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' '),
        email: user.email || '',
        balanceBDT: roundBDT(account?.balanceBDT || 0),
        tierName: account?.tierName || '',
        earnRatePercent: account?.earnRatePercent ?? null,
        tierAssignedAt: account?.tierAssignedAt || null,
      };
    });
    return res.json({ success: true, customers });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load loyalty customers' });
  }
};

exports.assignLoyaltyTier = async (req, res) => {
  try {
    const submittedUserIds = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String) : [];
    if (submittedUserIds.some((id) => !mongoose.isValidObjectId(id))) {
      return res.status(400).json({ success: false, message: 'One or more selected customer IDs are invalid' });
    }
    const userIds = [...new Set(submittedUserIds)];
    const tierName = String(req.body?.tierName || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
    const earnRatePercent = Number(req.body?.earnRatePercent);
    if (!userIds.length || userIds.length > 100) {
      return res.status(400).json({ success: false, message: 'Select between 1 and 100 loyalty customers' });
    }
    if (!tierName) return res.status(400).json({ success: false, message: 'Enter a loyalty tier name' });
    if (!Number.isFinite(earnRatePercent) || earnRatePercent < 0 || earnRatePercent > 100) {
      return res.status(400).json({ success: false, message: 'Loyalty percentage must be between 0 and 100' });
    }
    const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName fullName email').lean();
    if (users.length !== userIds.length) return res.status(404).json({ success: false, message: 'One or more selected customers could not be found' });
    const assignedAt = new Date();
    await LoyaltyAccount.bulkWrite(users.map((user) => ({
      updateOne: {
        filter: { userId: user._id },
        update: {
          $set: { tierName, earnRatePercent, tierAssignedAt: assignedAt },
          $setOnInsert: { userId: user._id, balanceBDT: 0 },
        },
        upsert: true,
      },
    })));

    const emailResults = await Promise.all(users.map(async (user) => {
      if (!user.email) return { email: '', success: false, message: 'Customer has no email address' };
      const result = await sendLoyaltyTierEmail({ user, tierName, earnRatePercent });
      return { email: user.email, success: Boolean(result.success), message: result.success ? '' : result.message || 'Email could not be sent' };
    }));
    const emailFailures = emailResults.filter((result) => !result.success);
    return res.json({
      success: true,
      assigned: users.length,
      emailsSent: emailResults.length - emailFailures.length,
      emailFailures,
      tier: { tierName, earnRatePercent },
      message: `${users.length} customer(s) added to ${tierName}; ${emailResults.length - emailFailures.length} email(s) sent`,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to assign loyalty tier' });
  }
};

exports.redeemGiftCode = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user?._id;
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!userId) throw Object.assign(new Error('Login required'), { statusCode: 401 });
    if (!code) throw Object.assign(new Error('Enter a gift code'), { statusCode: 400 });
    const now = new Date();
    const gift = await LoyaltyGiftCode.findOneAndUpdate(
      { codeHash: hashCode(code), status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { $set: { status: 'redeemed', redeemedBy: userId, redeemedAt: now } },
      { new: true, session },
    );
    if (!gift) throw Object.assign(new Error('This code is invalid, expired, or has already been redeemed'), { statusCode: 404 });

    const { account } = await changeLoyaltyBalance({
      userId,
      amountBDT: gift.amountBDT,
      direction: 'credit',
      source: 'gift_code',
      referenceId: gift._id,
      note: `Redeemed gift code ending ${gift.codeSuffix}`,
      idempotencyKey: `gift-code:${gift._id}`,
      session,
    });
    await session.commitTransaction();
    return res.json({ success: true, creditedBDT: gift.amountBDT, balanceBDT: roundBDT(account.balanceBDT) });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to redeem code' });
  } finally {
    await session.endSession();
  }
};

exports.getAdminSettings = async (req, res) => {
  try {
    const settings = await getLoyaltySettings();
    return res.json({ success: true, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateAdminSettings = async (req, res) => {
  try {
    const update = {};
    for (const field of ['earnRatePercent', 'maxRedeemPercent']) {
      if (req.body[field] !== undefined) {
        const value = Number(req.body[field]);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          return res.status(400).json({ success: false, message: `${field} must be between 0 and 100` });
        }
        update[field] = value;
      }
    }
    if (req.body.enabled !== undefined) update.enabled = Boolean(req.body.enabled);
    const settings = await LoyaltySettings.findOneAndUpdate(
      { _id: 'global' },
      { $set: update, $setOnInsert: { _id: 'global', enabled: true, earnRatePercent: 1, maxRedeemPercent: 100 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return res.json({ success: true, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to update loyalty settings' });
  }
};

exports.createGiftCodes = async (req, res) => {
  try {
    const amountBDT = roundBDT(req.body?.amountBDT);
    const count = Math.floor(Number(req.body?.count || 1));
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    if (!Number.isFinite(amountBDT) || amountBDT <= 0) return res.status(400).json({ success: false, message: 'Enter a gift amount greater than BDT 0' });
    if (!Number.isInteger(count) || count < 1 || count > 100) return res.status(400).json({ success: false, message: 'Generate between 1 and 100 codes at a time' });
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) return res.status(400).json({ success: false, message: 'Expiry date must be in the future' });

    const batchId = crypto.randomUUID();
    const issued = [];
    for (let index = 0; index < count; index += 1) {
      let code;
      let codeHash;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        code = makeGiftCode();
        codeHash = hashCode(code);
        if (!await LoyaltyGiftCode.exists({ codeHash })) break;
        code = null;
      }
      if (!code) throw new Error('Unable to generate a unique gift code; please retry');
      issued.push({
        code,
        codeHash,
        codeEncrypted: encryptDigitalCode(code),
        codeSuffix: code.slice(-4),
        amountBDT,
        expiresAt,
        createdBy: req.admin?.id || req.admin?._id,
        batchId,
      });
    }
    await LoyaltyGiftCode.insertMany(issued.map(({ code, ...document }) => document), { ordered: true });
    return res.status(201).json({
      success: true,
      batchId,
      codes: issued.map(({ code, amountBDT: amount, expiresAt: expiry }) => ({ code, amountBDT: amount, expiresAt: expiry })),
      message: 'Gift codes are encrypted at rest and remain available in admin gift code history.',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to create gift codes' });
  }
};

exports.listGiftCodes = async (req, res) => {
  try {
    const rows = await LoyaltyGiftCode.find().select('+codeEncrypted amountBDT codeSuffix status expiresAt redeemedAt createdAt batchId')
      .populate('redeemedBy', 'firstName lastName email')
      .sort({ createdAt: -1 }).limit(300).lean();
    const codes = rows.map(({ codeEncrypted, ...gift }) => {
      let code = null;
      if (codeEncrypted) {
        try { code = decryptDigitalCode(codeEncrypted); } catch { /* Keep legacy or unreadable codes masked. */ }
      }
      return { ...gift, code };
    });
    return res.json({ success: true, codes });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load gift codes' });
  }
};

exports.updateGiftCode = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.codeId)) return res.status(400).json({ success: false, message: 'Invalid gift code' });
    const amountBDT = roundBDT(req.body?.amountBDT);
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    if (!Number.isFinite(amountBDT) || amountBDT <= 0) return res.status(400).json({ success: false, message: 'Gift value must be greater than BDT 0' });
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) return res.status(400).json({ success: false, message: 'Expiry date must be in the future' });
    const update = { amountBDT, expiresAt };
    const replacementCode = String(req.body?.code || '').trim().toUpperCase();
    if (replacementCode) {
      if (replacementCode.length < 6 || replacementCode.length > 100) return res.status(400).json({ success: false, message: 'Gift code must be between 6 and 100 characters' });
      const codeHash = hashCode(replacementCode);
      if (await LoyaltyGiftCode.exists({ codeHash, _id: { $ne: req.params.codeId } })) {
        return res.status(409).json({ success: false, message: 'That gift code is already in use' });
      }
      Object.assign(update, { codeHash, codeEncrypted: encryptDigitalCode(replacementCode), codeSuffix: replacementCode.slice(-4) });
    }
    const gift = await LoyaltyGiftCode.findOneAndUpdate(
      { _id: req.params.codeId, status: 'active' },
      { $set: update },
      { new: true, runValidators: true },
    ).lean();
    if (!gift) return res.status(409).json({ success: false, message: 'Only active, unused gift codes can be edited' });
    return res.json({ success: true, giftCode: gift, ...(replacementCode ? { code: replacementCode } : {}) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to update gift code' });
  }
};

exports.replaceLegacyGiftCode = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.codeId)) return res.status(400).json({ success: false, message: 'Invalid gift code' });
    let code;
    let codeHash;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      code = makeGiftCode();
      codeHash = hashCode(code);
      if (!await LoyaltyGiftCode.exists({ codeHash })) break;
      code = null;
    }
    if (!code) return res.status(503).json({ success: false, message: 'Unable to create a replacement code; please retry' });
    const giftCode = await LoyaltyGiftCode.findOneAndUpdate(
      {
        _id: req.params.codeId,
        status: 'active',
        $or: [{ codeEncrypted: { $exists: false } }, { codeEncrypted: null }, { codeEncrypted: '' }],
      },
      { $set: { codeHash, codeEncrypted: encryptDigitalCode(code), codeSuffix: code.slice(-4) } },
      { new: true, runValidators: true },
    ).lean();
    if (!giftCode) return res.status(409).json({ success: false, message: 'This code is no longer active or already has a recoverable value' });
    return res.json({ success: true, code, giftCode, message: 'The old code was replaced. Copy and save this new code now.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to replace gift code' });
  }
};

exports.deleteGiftCode = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.codeId)) return res.status(400).json({ success: false, message: 'Invalid gift code' });
    const deleted = await LoyaltyGiftCode.findOneAndDelete({ _id: req.params.codeId, status: 'active' });
    if (!deleted) return res.status(409).json({ success: false, message: 'Only active, unused gift codes can be deleted' });
    return res.json({ success: true, deletedId: String(deleted._id) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to delete gift code' });
  }
};

exports.adjustCustomerBalance = async (req, res) => {
  try {
    const { userId, direction, note } = req.body || {};
    const amountBDT = roundBDT(req.body?.amountBDT);
    if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ success: false, message: 'Select a customer' });
    if (!['credit', 'debit'].includes(direction)) return res.status(400).json({ success: false, message: 'Select credit or debit' });
    if (!Number.isFinite(amountBDT) || amountBDT <= 0) return res.status(400).json({ success: false, message: 'Enter an amount greater than BDT 0' });
    const user = await User.findById(userId).select('firstName lastName email');
    if (!user) return res.status(404).json({ success: false, message: 'Customer not found' });
    const { account, transaction } = await changeLoyaltyBalance({
      userId, amountBDT, direction, source: 'admin_adjustment', note: String(note || 'Admin balance adjustment').slice(0, 300),
      createdBy: req.admin?.id || req.admin?._id,
      idempotencyKey: `admin-adjust:${crypto.randomUUID()}`,
    });
    return res.json({ success: true, balanceBDT: roundBDT(account.balanceBDT), transaction });
  } catch (error) {
    return res.status(error.message?.includes('enough') ? 400 : 500).json({ success: false, message: error.message || 'Unable to adjust customer balance' });
  }
};

exports.addDigitalCodes = async (req, res) => {
  try {
    const { productId, variantId = null } = req.body || {};
    const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : String(req.body?.codes || '').split(/\r?\n/))
      .map((code) => String(code).trim()).filter(Boolean))];
    if (!mongoose.isValidObjectId(productId)) return res.status(400).json({ success: false, message: 'Select a product' });
    if (codes.length < 1 || codes.length > 500) return res.status(400).json({ success: false, message: 'Add between 1 and 500 codes' });
    const product = await Product.findById(productId).select('name isDigitalProduct variants');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    if (product.isDigitalProduct === false) return res.status(400).json({ success: false, message: 'Enable digital product on this product before adding codes' });
    if (variantId && !product.variants?.id(variantId)) return res.status(400).json({ success: false, message: 'Variant does not belong to this product' });

    const documents = codes.map((code) => ({
      productId,
      variantId: variantId || null,
      codeHash: hashCode(code),
      codeEncrypted: encryptDigitalCode(code),
      addedBy: req.admin?.id || req.admin?._id,
    }));
    try {
      await DigitalProductCode.insertMany(documents, { ordered: false });
    } catch (error) {
      if (error.code !== 11000 && !error.writeErrors?.length) throw error;
      const insertedCount = error.insertedDocs?.length || 0;
      return res.status(201).json({ success: true, insertedCount, skippedDuplicates: codes.length - insertedCount, message: 'Existing duplicate codes were skipped' });
    }
    return res.status(201).json({ success: true, insertedCount: documents.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to add digital redemption codes' });
  }
};

exports.listDigitalCodes = async (req, res) => {
  try {
    const match = {};
    if (req.query.productId && mongoose.isValidObjectId(req.query.productId)) match.productId = new mongoose.Types.ObjectId(req.query.productId);
    const rows = await DigitalProductCode.aggregate([
      { $match: match },
      { $group: { _id: { productId: '$productId', variantId: '$variantId', status: '$status' }, count: { $sum: 1 } } },
      { $sort: { '_id.productId': 1, '_id.variantId': 1 } },
    ]);
    const productIds = [...new Set(rows.map((row) => String(row._id.productId)))];
    const products = await Product.find({ _id: { $in: productIds } }).select('name variants').lean();
    const byProduct = new Map(products.map((product) => [String(product._id), product]));
    return res.json({
      success: true,
      codes: rows.map((row) => {
        const product = byProduct.get(String(row._id.productId));
        const variant = product?.variants?.find((item) => String(item._id) === String(row._id.variantId));
        return { productId: String(row._id.productId), productName: product?.name || 'Product', variantId: row._id.variantId, variantName: variant?.colorName || '', status: row._id.status, count: row.count };
      }),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load digital code stock' });
  }
};

exports.getDigitalProducts = async (req, res) => {
  try {
    const products = await Product.find({ isDigitalProduct: true }).select('name sku variants').sort({ name: 1 }).lean();
    return res.json({ success: true, products: products.map((product) => ({
      _id: product._id,
      name: product.name,
      sku: product.sku || '',
      variants: (product.variants || []).map((variant) => ({
        _id: variant._id,
        name: [variant.regionName || variant.regionId?.name, variant.colorName].filter(Boolean).join(' · ') || variant.colorName || 'Default variant',
      })),
    })) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load digital products' });
  }
};

exports.removeDigitalCode = async (req, res) => {
  try {
    const deleted = await DigitalProductCode.findOneAndDelete({ _id: req.params.codeId, status: 'available' });
    if (!deleted) return res.status(409).json({ success: false, message: 'Only unassigned digital codes can be removed' });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to remove digital code' });
  }
};
