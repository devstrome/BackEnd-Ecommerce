const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const { sendAccountCredentials } = require('../utils/emailService');
const { ADMIN_PERMISSION_CODES } = require('../config/adminPermissions');
const { publicSiteUrl } = require('../utils/brand');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

const safeAdmin = (admin) => {
  const value = admin?.toObject ? admin.toObject() : { ...admin };
  if (!value) return value;
  delete value.password;
  delete value.refreshToken;
  delete value.accessTokens;
  delete value.lastLoginIp;
  delete value.lastDeviceId;
  delete value.lastFingerprint;
  delete value.lastNetwork;
  return value;
};

// 🔐 Utility to generate access and refresh tokens
const generateTokens = (adminId) => {
  const accessToken = jwt.sign({ adminId }, JWT_SECRET, { expiresIn: '1h' });
  const refreshToken = jwt.sign({ adminId }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
};

exports.verifyToken = async (req, res) => {
  try {
    const { token, type } = req.body; // type: 'access' | 'refresh'

    if (!token) return res.status(400).json({ valid: false, message: 'Token is required' });
    if (!['access', 'refresh', undefined].includes(type)) {
      return res.status(400).json({ valid: false, message: 'Token type must be access or refresh' });
    }

    const isRefresh = type === 'refresh';
    const decoded = jwt.verify(token, isRefresh ? JWT_REFRESH_SECRET : JWT_SECRET);
    const admin = await Admin.findById(decoded.adminId).select('banned refreshToken accessTokens').lean();
    if (!admin || admin.banned) {
      return res.status(200).json({ valid: false, message: 'Admin account is unavailable' });
    }

    const isActive = isRefresh
      ? admin.refreshToken === token
      : (admin.accessTokens || []).some((entry) => entry.token === token && new Date(entry.expiresAt).getTime() > Date.now());
    return res.status(200).json(isActive
      ? { valid: true, adminId: decoded.adminId }
      : { valid: false, message: 'Token is expired or revoked' });

  } catch (error) {
    return res.status(200).json({ valid: false, message: 'Invalid or expired token' });
  }
};

const parseAdminPermissions = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
};

const parseBoolean = (value) => value === true || value === 'true' || value === '1' || value === 1;

const normalizeAdminAccess = (body = {}) => {
  const requestedSuperAdmin = parseBoolean(body.superAdmin);
  const requestedRole = String(body.role || (requestedSuperAdmin ? 'super_admin' : 'custom')).trim();
  if (!['super_admin', 'custom'].includes(requestedRole)) {
    throw Object.assign(new Error('Choose either a super admin or a custom permission role'), { statusCode: 400 });
  }
  const superAdmin = requestedSuperAdmin || requestedRole === 'super_admin';
  const role = superAdmin ? 'super_admin' : requestedRole;
  const permissions = parseAdminPermissions(body.permissions);
  if (permissions.some((permission) => !ADMIN_PERMISSION_CODES.includes(permission))) {
    throw Object.assign(new Error('One or more selected admin permissions are invalid'), { statusCode: 400 });
  }
  if (role === 'custom' && permissions.includes('admins')) {
    throw Object.assign(new Error('Admin account management is reserved for super admins'), { statusCode: 400 });
  }
  if (role === 'custom' && !permissions.length) {
    throw Object.assign(new Error('Select at least one sidebar section for a custom admin role'), { statusCode: 400 });
  }
  return {
    role,
    roleName: role === 'custom' ? String(body.roleName || 'Custom role').trim().slice(0, 60) : '',
    permissions: role === 'custom' ? [...new Set(permissions)] : [],
    permissionsConfigured: role === 'custom',
    superAdmin,
  };
};

// 🚪 Logout admin
exports.logout = async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(400).json({ message: 'Token is required' });
  }

  await Admin.findByIdAndUpdate(
    req.admin._id,
    {
      $pull: {
        accessTokens: { token: token }
      }
    }
  );

  res.json({ message: 'Logged out successfully' });
};

// Return the authenticated admin's current profile (never expose credentials).
exports.getCurrentAdmin = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin?._id);
    if (!admin || admin.banned) return res.status(404).json({ message: 'Admin not found' });
    res.json({ admin: safeAdmin(admin) });
  } catch (error) {
    res.status(500).json({ message: 'Failed to load admin profile', error: error.message });
  }
};

// Allow an admin to update their own basic profile without superadmin access.
exports.updateCurrentAdmin = async (req, res) => {
  try {
    const adminId = req.admin?._id;
    const { firstName, lastName, email, userName } = req.body || {};
    const updates = {};

    if (firstName !== undefined) {
      const value = String(firstName).trim();
      if (!value) return res.status(400).json({ message: 'First name is required' });
      updates.firstName = value.toUpperCase();
    }
    if (lastName !== undefined) {
      const value = String(lastName).trim();
      if (!value) return res.status(400).json({ message: 'Last name is required' });
      updates.lastName = value.toUpperCase();
    }
    if (email !== undefined) {
      const value = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return res.status(400).json({ message: 'Enter a valid email address' });
      }
      const conflict = await Admin.findOne({ email: value, _id: { $ne: adminId } }).select('_id').lean();
      if (conflict) return res.status(409).json({ message: 'That email is already used by another admin' });
      updates.email = value;
    }
    if (userName !== undefined) {
      const value = String(userName).trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(value)) {
        return res.status(400).json({ message: 'Username must be 3–30 characters using letters, numbers, dots, underscores, or hyphens' });
      }
      const conflict = await Admin.findOne({ userName: value, _id: { $ne: adminId } }).select('_id').lean();
      if (conflict) return res.status(409).json({ message: 'That username is already taken' });
      updates.userName = value;
    }
    if (req.file?.path) updates.imageUrl = req.file.path;
    if (!Object.keys(updates).length) return res.status(400).json({ message: 'No profile changes were provided' });

    const updated = await Admin.findByIdAndUpdate(adminId, { $set: updates }, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Admin not found' });
    res.json({ message: 'Profile updated successfully', admin: safeAdmin(updated) });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update admin profile', error: error.message });
  }
};

exports.changeCurrentAdminPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }

    const admin = await Admin.findById(req.admin?._id);
    if (!admin || admin.banned) return res.status(404).json({ message: 'Admin not found' });
    const matches = await bcrypt.compare(String(currentPassword), admin.password);
    if (!matches) return res.status(400).json({ message: 'Current password is incorrect' });
    if (String(currentPassword) === String(newPassword)) {
      return res.status(400).json({ message: 'Choose a new password different from the current password' });
    }

    admin.password = await bcrypt.hash(String(newPassword), 10);
    await admin.save();
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update password', error: error.message });
  }
};

// 🔁 Refresh access token
exports.refreshToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(403).json({ message: 'Refresh token is required' });

    const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
    const admin = await Admin.findById(decoded.adminId);

    if (!admin || admin.banned || admin.refreshToken !== token) {
      return res.status(403).json({ message: 'Invalid refresh token' });
    }

    const accessToken = jwt.sign({ adminId: decoded.adminId }, JWT_SECRET, { expiresIn: '1h' });

    // First, remove expired tokens
    await Admin.findByIdAndUpdate(
      decoded.adminId,
      {
        $pull: {
          accessTokens: {
            expiresAt: { $lte: new Date() }
          }
        }
      }
    );

    // Then, add the new token
    const updatedAdmin = await Admin.findByIdAndUpdate(
      decoded.adminId,
      {
        $push: {
          accessTokens: {
            token: accessToken,
            issuedAt: new Date(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          }
        }
      },
      { new: true, runValidators: true }
    );

    if (!updatedAdmin) {
      return res.status(403).json({ message: 'Admin not found' });
    }

    res.json({ accessToken });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(403).json({ message: 'Invalid or expired refresh token' });
  }
};

// 🧾 Register a new admin (superAdmin only)
exports.register = async (req, res) => {
  try {
    if (!req.admin?.superAdmin) {
      return res.status(403).json({ message: 'Only super admin can register new admins' });
    }

    const { firstName, lastName, email, userName, password } = req.body;
    const adminAccess = normalizeAdminAccess(req.body);

    const existingAdmin = await Admin.findOne({ $or: [{ email }, { userName }] });
    if (existingAdmin) return res.status(400).json({ message: 'Admin already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const fullName = `${firstName.trim()} ${lastName.trim()}`;
    const profileImageUrl = req.file?.path || `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}`;

    const admin = await Admin.create({
      firstName,
      lastName,
      email: email.trim(),
      userName: userName.trim().toLowerCase(),
      password: hashedPassword,
      imageUrl: profileImageUrl,
      ...adminAccess,
    });

    const { accessToken, refreshToken } = generateTokens(admin._id);
    
    // Update admin with tokens
    const updatedAdmin = await Admin.findByIdAndUpdate(
      admin._id,
      {
        refreshToken: refreshToken,
        accessTokens: [{
          token: accessToken,
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }]
      },
      { new: true, runValidators: true }
    );

    if (!updatedAdmin) {
      return res.status(500).json({ message: 'Failed to update admin session' });
    }

    sendAccountCredentials({
      to: email.trim(),
      name: fullName,
      email: email.trim(),
      role: 'admin',
      loginUrl: publicSiteUrl('/admin'),
    }).catch((err) => console.error('Failed to send admin credentials email:', err.message));

    res.status(201).json({ message: 'Admin registered successfully', admin: safeAdmin(updatedAdmin) });
  } catch (error) {
    console.error('Error registering admin:', error);
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Registration failed', error: error.message });
  }
};

// 🔑 Admin login
exports.login = async (req, res) => {
  try {
    const { emailOrUserName, password } = req.body;

    if (!emailOrUserName || !password) {
      return res.status(400).json({ message: 'Email/UserName and password are required' });
    }

    const admin = await Admin.findOne({
      $or: [
        { email: emailOrUserName.toLowerCase() },
        { userName: emailOrUserName.trim().toLowerCase() },
      ],
    });

    if (!admin) return res.status(400).json({ message: 'Admin not found' });
    if (admin.banned) return res.status(403).json({ message: 'This admin account has been banned', banned: true });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const { accessToken, refreshToken } = generateTokens(admin._id);

    // First, remove expired tokens
    await Admin.findByIdAndUpdate(
      admin._id,
      {
        $pull: {
          accessTokens: {
            expiresAt: { $lte: new Date() }
          }
        }
      }
    );

    // Then, add the new token and update refresh token
    const updatedAdmin = await Admin.findByIdAndUpdate(
      admin._id,
      {
        refreshToken: refreshToken,
        $push: {
          accessTokens: {
            token: accessToken,
            issuedAt: new Date(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          }
        },
        ...(req.clientIdent ? {
          lastLoginIp: req.clientIdent.ip,
          lastDeviceId: req.clientIdent.deviceId,
          lastFingerprint: req.clientIdent.fingerprint,
          lastNetwork: req.clientIdent.network,
        } : {}),
      },
      { new: true, runValidators: true }
    );

    if (!updatedAdmin) {
      return res.status(500).json({ message: 'Failed to update admin session' });
    }

    res.json({ message: 'Login successful', accessToken, refreshToken, admin: safeAdmin(updatedAdmin) });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ message: 'Login failed', error });
  }
};
// 🔐 Create admin (superAdmin only)
exports.createAdmin = async (req, res) => {
  try {
    if (!req.admin?.superAdmin) {
      return res.status(403).json({ message: 'Only super admin can create admins' });
    }

    const { firstName, lastName, email, userName, password } = req.body;
    const adminAccess = normalizeAdminAccess(req.body);

    const emailTrimmed = email?.trim();
    const userNameTrimmed = userName?.trim().toLowerCase();

    const emailExists = await Admin.findOne({ email: emailTrimmed });
    const userNameExists = await Admin.findOne({ userName: userNameTrimmed });
    if (emailExists || userNameExists) {
      return res.status(400).json({ message: `${userNameTrimmed} or ${emailTrimmed} is already taken` });
    }

    const hashedPassword = await bcrypt.hash(password.trim(), 10);
    const imageUrl = req.file?.path || `https://ui-avatars.com/api/?name=${encodeURIComponent(firstName + ' ' + lastName)}`;

    const admin = await Admin.create({
      firstName: firstName?.trim().toUpperCase(),
      lastName: lastName?.trim().toUpperCase(),
      email: emailTrimmed,
      userName: userNameTrimmed,
      password: hashedPassword,
      imageUrl,
      ...adminAccess,
    });

    // Generate tokens after creating the admin
    const { accessToken, refreshToken } = generateTokens(admin._id);

    // Update admin with tokens
    const updatedAdmin = await Admin.findByIdAndUpdate(
      admin._id,
      {
        refreshToken,
        accessTokens: [{
          token: accessToken,
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }],
      },
      { new: true }
    );

    // Email the new admin their login credentials (non-blocking)
    sendAccountCredentials({
      to: emailTrimmed,
      name: `${firstName} ${lastName}`.trim(),
      email: emailTrimmed,
      role: 'admin',
      loginUrl: publicSiteUrl('/admin'),
    }).catch((err) => console.error('Failed to send admin credentials email:', err.message));

    res.status(201).json({ message: 'Admin created successfully', admin: safeAdmin(updatedAdmin) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message, error: error.message });
  }
};

// ✏️ Update admin (superAdmin only)
exports.updateAdmin = async (req, res) => {
  try {
    if (!req.admin?.superAdmin) {
      return res.status(403).json({ message: 'Only super admin can update admins' });
    }

    const id = req.params.id;
    const { firstName, lastName, email, userName, password } = req.body;

    const trimmedEmail = email?.trim();
    const trimmedUserName = userName?.trim().toLowerCase();

    const updates = {};

    if (userName) {
      const conflictUser = await Admin.findOne({ userName: trimmedUserName, _id: { $ne: id } });
      if (conflictUser) return res.status(409).json({ message: `${trimmedUserName} is already taken` });
      updates.userName = trimmedUserName;
    }

    if (email) {
      const conflictEmail = await Admin.findOne({ email: trimmedEmail, _id: { $ne: id } });
      if (conflictEmail) return res.status(409).json({ message: `${trimmedEmail} is already taken` });
      updates.email = trimmedEmail;
    }

    if (firstName) updates.firstName = firstName.trim().toUpperCase();
    if (lastName) updates.lastName = lastName.trim().toUpperCase();
    if (password) updates.password = await bcrypt.hash(password.trim(), 10);
    if (req.file) updates.imageUrl = req.file.path;
    if (['superAdmin', 'role', 'permissions', 'roleName'].some((key) => req.body[key] !== undefined)) {
      Object.assign(updates, normalizeAdminAccess(req.body));
    }

    const updatedAdmin = await Admin.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!updatedAdmin) return res.status(404).json({ message: 'Admin not found' });

    res.json({ message: 'Admin updated successfully', admin: safeAdmin(updatedAdmin) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message, error: error.message });
  }
};

// 🗑️ Delete admin (superAdmin only)
exports.deleteAdmin = async (req, res) => {
  try {
    if (!req.admin?.superAdmin) {
      return res.status(403).json({ message: 'Only super admin can delete admins' });
    }

    const { deleteAdminId } = req.body;
    
    // Prevent super admin from deleting themselves
    if (deleteAdminId === req.admin._id.toString()) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    const deleted = await Admin.findByIdAndDelete(deleteAdminId);
    if (!deleted) return res.status(404).json({ message: 'Admin not found' });

    res.json({ message: 'Admin deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 🔍 Get single admin (any authenticated admin)
exports.getSingleAdmin = async (req, res) => {
  try {
    const id = req.params.id;
  const admin = await Admin.findById(id).select('-password -refreshToken -accessTokens -lastLoginIp -lastDeviceId -lastFingerprint -lastNetwork');
    if (!admin) return res.status(404).json({ message: 'Admin not found' });

    res.json(admin);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 📃 Get all admins (superAdmin only)
exports.getAllAdmins = async (req, res) => {
  try {
    if (!req.admin?.superAdmin) {
      return res.status(403).json({ message: 'Only super admin can view all admins' });
    }

  const admins = await Admin.find().select('-password -refreshToken -accessTokens -lastLoginIp -lastDeviceId -lastFingerprint -lastNetwork');
    res.json(admins);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
