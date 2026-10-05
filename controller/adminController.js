const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const { sendAccountCredentials } = require('../utils/emailService');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

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

    const secret = type === 'refresh' ? JWT_REFRESH_SECRET : JWT_SECRET;

    jwt.verify(token, secret, (err, decoded) => {
      if (err) return res.status(200).json({ valid: false, message: 'Invalid token' });
      res.status(200).json({ valid: true, adminId: decoded.adminId });
    });

  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ valid: false, message: 'Token verification failed' });
  }
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

// 🔁 Refresh access token
exports.refreshToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(403).json({ message: 'Refresh token is required' });

    const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
    const admin = await Admin.findById(decoded.adminId);

    if (!admin || admin.refreshToken !== token) {
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

    const { firstName, lastName, email, userName, password, superAdmin } = req.body;

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
      superAdmin: !!superAdmin,
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
      password,
      role: 'admin',
      loginUrl: process.env.ADMIN_URL || process.env.CLIENT_URL,
    }).catch((err) => console.error('Failed to send admin credentials email:', err.message));

    res.status(201).json({ message: 'Admin registered successfully', accessToken, refreshToken, admin: updatedAdmin });
  } catch (error) {
    console.error('Error registering admin:', error);
    res.status(500).json({ message: 'Registration failed', error });
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

    res.json({ message: 'Login successful', accessToken, refreshToken, admin: updatedAdmin });
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

    const { firstName, lastName, email, userName, password, superAdmin } = req.body;

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
      superAdmin: !!superAdmin,
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
    const plainPassword = password.trim();
    sendAccountCredentials({
      to: emailTrimmed,
      name: `${firstName} ${lastName}`.trim(),
      email: emailTrimmed,
      password: plainPassword,
      role: 'admin',
      loginUrl: process.env.ADMIN_URL || process.env.CLIENT_URL,
    }).catch((err) => console.error('Failed to send admin credentials email:', err.message));

    res.status(201).json({ message: 'Admin created successfully', admin: updatedAdmin, accessToken, refreshToken });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ✏️ Update admin (superAdmin only)
exports.updateAdmin = async (req, res) => {
  try {
    if (!req.admin?.superAdmin) {
      return res.status(403).json({ message: 'Only super admin can update admins' });
    }

    const id = req.params.id;
    const { firstName, lastName, email, userName, password, superAdmin } = req.body;

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
    if (superAdmin !== undefined) updates.superAdmin = !!superAdmin;

    const updatedAdmin = await Admin.findByIdAndUpdate(id, updates, { new: true });
    if (!updatedAdmin) return res.status(404).json({ message: 'Admin not found' });

    res.json({ message: 'Admin updated successfully', admin: updatedAdmin });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    const admin = await Admin.findById(id).select('-password -refreshToken');
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

    const admins = await Admin.find().select('-password -refreshToken');
    res.json(admins);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};