const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET;

// 🔐 Authenticate user from JWT token
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User.findById(decoded.userId).select('-password -refreshToken');
    if (!user) return res.status(401).json({ message: 'User not found' });
    if (user.banned) {
      return res.status(403).json({ message: 'This account has been banned', banned: true });
    }

    // ✅ Check if token is still active (optional but recommended)
    const isTokenValid = user.accessTokens?.some(t => t.token === token && t.expiresAt > Date.now());
    if (!isTokenValid) {
      return res.status(401).json({ message: 'Access token is no longer valid or has been revoked' });
    }

    req.user = user; // Attach sanitized user object to request
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    } else if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Malformed or invalid token' });
    } else {
      console.warn('JWT verification error:', err);
      return res.status(401).json({ message: 'Authentication failed' });
    }
  }
};

module.exports = authenticate;
