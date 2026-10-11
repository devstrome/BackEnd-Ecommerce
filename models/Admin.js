const mongoose = require('mongoose');
const { ADMIN_PERMISSION_CODES } = require('../config/adminPermissions');

const adminSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  userName: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  imageUrl: {
    type: String,
    required: true,
  },
  admin: {
    type: Boolean,
    default: true,
  },
  superAdmin: {
    type: Boolean,
    default: false,
  },
  role: {
    type: String,
    enum: ['super_admin', 'admin', 'custom'],
    default: 'custom',
    index: true,
  },
  roleName: { type: String, trim: true, maxlength: 60, default: '' },
  permissions: {
    type: [{ type: String, enum: ADMIN_PERMISSION_CODES }],
    default: [],
  },
  permissionsConfigured: { type: Boolean, default: false },

  // 🔐 Tokens
  refreshToken: {
    type: String,
    default: null,
  },
  accessTokens: [{
    token: { type: String, required: true },
    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
  }],
  lastLoginIp: { type: String },
  lastDeviceId: { type: String },
  lastFingerprint: { type: String },
  lastNetwork: { type: String },
  banned: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model("Admin", adminSchema);
