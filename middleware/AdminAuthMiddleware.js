const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const { permissionForAdminRequest } = require('../config/adminPermissions');

const JWT_SECRET = process.env.JWT_SECRET;

const authenticateAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const admin = await Admin.findById(decoded.adminId)
      .select('-password -refreshToken -lastLoginIp -lastDeviceId -lastFingerprint -lastNetwork');

    if (!admin) {
      return res.status(401).json({ message: 'Admin not found' });
    }

    if (admin.banned) {
      return res.status(403).json({ message: 'This admin account has been banned', banned: true });
    }

    // Reject tokens revoked in the admin's active-token list.
    const isTokenValid = admin.accessTokens?.some(t => t.token === token && t.expiresAt > Date.now());
    if (!isTokenValid) {
      return res.status(401).json({ message: 'Access token is no longer valid or has been revoked' });
    }

    req.admin = admin.toObject();
    // Keep Mongoose's standard `id` virtual for existing controllers.
    req.admin.id = String(admin._id);
    delete req.admin.accessTokens;
    if (!req.admin.superAdmin) {
      const requiredPermission = permissionForAdminRequest(req);
      const hasAssignedPermission = Array.isArray(req.admin.permissions) && req.admin.permissions.length > 0;
      if (requiredPermission === '__super_admin__') {
        return res.status(403).json({ message: 'Only super admin permitted' });
      }
      if (requiredPermission === '__unmapped__' || (requiredPermission === '__assigned__' && !hasAssignedPermission)) {
        return res.status(403).json({ message: 'This admin API is not assigned to your role' });
      }
      const acceptedPermissions = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
      if (requiredPermission && requiredPermission !== '__assigned__' && !acceptedPermissions.some((permission) => req.admin.permissions?.includes(permission))) {
        return res.status(403).json({ message: 'Your admin role does not have access to this section', requiredPermission });
      }
    }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.admin?.superAdmin) {
    return res.status(403).json({ message: 'Only super admin permitted' });
  }
  next();
};

module.exports = { authenticateAdmin, requireSuperAdmin };
