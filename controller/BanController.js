const Ban = require('../models/Ban');
const User = require('../models/User');
const Admin = require('../models/Admin');
const { clientIp, networkOf } = require('../middleware/banCheck');

// GET /api/bans — list all bans (super admin)
exports.listBans = async (req, res) => {
  try {
    const filter = req.admin?.superAdmin ? {} : { targetType: 'user' };
    const bans = await Ban.find(filter).sort({ createdAt: -1 }).lean();
    res.json(bans);
  } catch (err) {
    res.status(500).json({ message: 'Failed to list bans', error: err.message });
  }
};

// POST /api/bans/user — ban a user's device/network
// body: { userId?, ip?, deviceId?, fingerprint?, network?, reason? }
// If userId given, its last-known identifiers are used as the ban basis.
exports.banUser = async (req, res) => {
  try {
    const { userId, ip, deviceId, fingerprint, network, reason = '' } = req.body || {};
    let target = null;
    if (userId) {
      target = await User.findById(userId);
      if (!target) return res.status(404).json({ message: 'User not found' });
    }

    const ban = await Ban.create({
      targetType: 'user',
      targetId: target?._id,
      targetEmail: target?.email,
      ip: ip || target?.lastLoginIp || '',
      deviceId: deviceId || target?.lastDeviceId || '',
      fingerprint: fingerprint || target?.lastFingerprint || '',
      network: network || target?.lastNetwork || (target?.lastLoginIp ? networkOf(target.lastLoginIp) : ''),
      reason,
      bannedBy: req.admin?._id,
    });

    if (target) {
      target.banned = true;
      target.accessTokens = [];
      target.refreshToken = null;
      await target.save();
    }

    res.status(201).json({ message: 'User banned', ban });
  } catch (err) {
    res.status(500).json({ message: 'Ban failed', error: err.message });
  }
};

// POST /api/bans/admin — ban an admin's device/network
exports.banAdmin = async (req, res) => {
  try {
    const { adminId, ip, deviceId, fingerprint, network, reason = '' } = req.body || {};
    let target = null;
    if (adminId) {
      target = await Admin.findById(adminId);
      if (!target) return res.status(404).json({ message: 'Admin not found' });
      if (String(target._id) === String(req.admin?._id)) {
        return res.status(400).json({ message: 'You cannot ban yourself' });
      }
    }

    const ban = await Ban.create({
      targetType: 'admin',
      targetId: target?._id,
      targetEmail: target?.email,
      ip: ip || target?.lastLoginIp || '',
      deviceId: deviceId || target?.lastDeviceId || '',
      fingerprint: fingerprint || target?.lastFingerprint || '',
      network: network || target?.lastNetwork || (target?.lastLoginIp ? networkOf(target.lastLoginIp) : ''),
      reason,
      bannedBy: req.admin?._id,
    });

    if (target) {
      target.banned = true;
      target.accessTokens = [];
      target.refreshToken = null;
      await target.save();
    }

    res.status(201).json({ message: 'Admin banned', ban });
  } catch (err) {
    res.status(500).json({ message: 'Ban failed', error: err.message });
  }
};

// DELETE /api/bans/:id — lift a ban
exports.unban = async (req, res) => {
  try {
    const existingBan = await Ban.findById(req.params.id).select('targetType');
    if (!existingBan) return res.status(404).json({ message: 'Ban not found' });
    if (existingBan.targetType === 'admin' && !req.admin?.superAdmin) {
      return res.status(403).json({ message: 'Only super admin can lift an admin ban' });
    }
    const ban = await Ban.findByIdAndDelete(req.params.id);
    if (!ban) return res.status(404).json({ message: 'Ban not found' });

    if (ban.targetId) {
      if (ban.targetType === 'user') {
        await User.findByIdAndUpdate(ban.targetId, { banned: false });
      } else {
        await Admin.findByIdAndUpdate(ban.targetId, { banned: false });
      }
    }
    res.json({ message: 'Ban lifted', ban });
  } catch (err) {
    res.status(500).json({ message: 'Unban failed', error: err.message });
  }
};
