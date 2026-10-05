const express = require('express');
const router = express.Router();
const userController = require('../controller/UserController');
const authenticate = require('../middleware/UserAuthMiddleware');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const upload = require('../config/multerconfig');
const { checkBan } = require('../middleware/banCheck');

// 🔐 Public Auth Routes
router.post('/register', checkBan, userController.register);
router.post('/send-registration-otp', checkBan, userController.sendRegistrationOTP);
router.post('/verify-otp-and-register', checkBan, userController.verifyOTPAndRegister);
router.post('/resend-otp', userController.resendOTP);
router.post('/send-email-verification-otp', userController.sendEmailVerificationOTP);
router.post('/verify-email-with-otp', userController.verifyEmailWithOTP);
router.post('/verify-otp', userController.verifyOTP);
router.post('/send-forgot-password-otp', userController.sendForgotPasswordOTP);
router.post('/verify-forgot-password-otp', userController.verifyForgotPasswordOTP);
router.post('/login', checkBan, userController.login);
router.post('/auth/google', checkBan, userController.loginWithGoogle); // Google Sign-In / Sign-Up
router.put('/auth/set-password', authenticate, userController.setInitialPassword); // after Google sign-up
router.post('/refresh-token', userController.refreshToken);

// 🛡️ Protected Profile Routes
router.get('/user/profile', authenticate, userController.getProfile);
router.patch('/profile', authenticate, userController.updateProfile);
router.patch('/address', authenticate, userController.updateAddress);

// 🔐 Security Routes
router.put('/update-password', authenticate, userController.updatePassword);
router.post('/send-email-otp', authenticate, userController.sendEmailUpdateOTP);
router.put('/update-email', authenticate, userController.updateEmail);

// 💳 Payment Method Routes
router.patch('/payment-methods', authenticate, userController.updatePaymentMethods); // Replace all
router.post('/payment-methods', authenticate, userController.addPaymentMethod);       // Add one
router.delete('/payment-methods/:methodId', authenticate, userController.removePaymentMethod); // Delete one
router.patch('/payment-methods/:methodId/default', authenticate, userController.setDefaultPaymentMethod); // Set default
router.patch('/payment-methods/:methodId', authenticate, userController.editPaymentMethod); // Edit one

// ❌ Account Management
router.delete('/profile', authenticate, userController.deleteUser);

// 🚪 Optional: Logout (token revocation)
 router.post('/logout', authenticate, userController.logout);

// 👨‍💼 Admin Routes for User Management
router.post('/users', authenticateAdmin, upload.single('image'), userController.createUserByAdmin); // Create user (super admin only)
router.get('/users', authenticateAdmin, userController.getAllUsers); // Get all users (admin only)
router.get('/users/:userId', authenticateAdmin, userController.getUserById); // Get specific user (admin only)
router.put('/users/:userId', authenticateAdmin, upload.single('image'), userController.updateUserByAdmin); // Update user (admin only)
router.put('/profile/image', authenticate, upload.single('image'), userController.uploadProfileImage); // user uploads own avatar
router.delete('/users/:userId', authenticateAdmin, userController.deleteUserByAdmin); // Delete user (admin only)

// 📋 Admin: get all customer wishlists with populated products
router.get('/admin/wishlists', authenticateAdmin, async (req, res) => {
  try {
    const users = await require('../models/User').find(
      { wishlist: { $exists: true, $ne: [] } },
      'firstName lastName email wishlist'
    ).populate({ path: 'wishlist', select: 'name mainPrice discountPrice mainImage brand categories averageRating' }).sort({ createdAt: -1 }).lean();
    const filtered = users.filter(u => Array.isArray(u.wishlist) && u.wishlist.length > 0);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch wishlists', error: err.message });
  }
});

// ✉️ Admin: send a wishlist-related email to a customer via the server email account
router.post('/admin/wishlists/send-email', authenticateAdmin, async (req, res) => {
  try {
    const to = (req.body.to || '').trim();
    const subject = (req.body.subject || '').trim();
    const message = (req.body.message || '').trim();

    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ message: 'A valid recipient email is required' });
    }
    if (!subject) return res.status(400).json({ message: 'Subject is required' });
    if (!message) return res.status(400).json({ message: 'Message is required' });
    if (subject.length > 200) return res.status(400).json({ message: 'Subject cannot exceed 200 characters' });
    if (message.length > 5000) return res.status(400).json({ message: 'Message cannot exceed 5000 characters' });

    const { sendCustomEmail } = require('../utils/emailService');
    const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    const html = `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #1B1B1B;">
        <div style="background: #B1123B; padding: 24px; text-align: center; color: #fff; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 22px; letter-spacing: 3px;">BELORELLA</h1>
        </div>
        <div style="border: 1px solid #eee; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <div style="line-height: 1.6;">${escapeHtml(message).replace(/\n/g, '<br/>')}</div>
        </div>
        <p style="font-size: 12px; color: #888; text-align: center; margin-top: 16px;">
          &copy; ${new Date().getFullYear()} BELORELLA. All rights reserved.
        </p>
      </div>
    `;

    const result = await sendCustomEmail({ to, subject, html, text: message });
    if (!result.success) {
      return res.status(502).json({ message: result.message || result.error || 'Failed to send email' });
    }
    res.json({ message: 'Email sent successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to send email', error: err.message });
  }
});

module.exports = router;
