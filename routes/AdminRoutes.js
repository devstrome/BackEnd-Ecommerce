const express = require('express');
const router = express.Router();

const AdminController = require('../controller/adminController'); // Full controller with auth & CRUD
const upload = require('../config/multerconfig');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/AdminAuthMiddleware'); // Validates access token and super-admin access
const { checkBan } = require('../middleware/banCheck');
const { authLimiter } = require('../middleware/securityHardening');
const Order = require('../models/Order');
const Contact = require('../models/Contact');

// 🔐 Auth & Session
router.post('/admin/login', authLimiter, checkBan, AdminController.login);             // Admin login
router.post('/admin/register', authenticateAdmin, checkBan, upload.single('image'), AdminController.register); // Register (superAdmin only)
router.post('/admin/logout', authenticateAdmin, AdminController.logout); 
router.post("/admin/verify-token",  AdminController.verifyToken)    
router.post('/admin/refresh-token', AdminController.refreshToken);           // Get new access token
router.get('/admin/me', authenticateAdmin, AdminController.getCurrentAdmin);
router.patch('/admin/me', authenticateAdmin, upload.single('image'), AdminController.updateCurrentAdmin);
router.post('/admin/me/password', authenticateAdmin, AdminController.changeCurrentAdminPassword);

// 🔒 Create/Update/Delete admins (superAdmin only)
router.post('/create-admin', authenticateAdmin, upload.single('image'), AdminController.createAdmin);
router.put('/update-admin/:id', authenticateAdmin, upload.single('image'), AdminController.updateAdmin);
router.delete('/delete-admin', authenticateAdmin, AdminController.deleteAdmin);

// 📤 Generic image upload (admin) — CloudinaryStorage stores it, returns the URL
router.post('/upload/image', authenticateAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided' });
  res.json({ success: true, url: req.file.path });
});

// 📍 Admin info
// Sidebar badge counts (unopened new orders + pending contacts)
router.get('/admin/notifications/count', authenticateAdmin, async (req, res) => {
  try {
    const isFullAccess = req.admin?.superAdmin;
    const canSeeOrders = isFullAccess || req.admin?.permissions?.includes('orders');
    const canSeeContacts = isFullAccess || req.admin?.permissions?.includes('contacts');
    const [orders, contacts] = await Promise.all([
      canSeeOrders ? Order.countDocuments({ isNewForAdmin: true }) : 0,
      canSeeContacts ? Contact.countDocuments({ status: 'pending' }) : 0,
    ]);
    res.json({ success: true, counts: { orders, contacts } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// Narrowed to 24-hex ObjectId so other /api/admin/* routes (announcements,
// hero-slides, help-pages, notifications/count...) are not swallowed by this handler
router.get('/admin/:id([0-9a-fA-F]{24})', authenticateAdmin, requireSuperAdmin, AdminController.getSingleAdmin);
router.get('/admins', authenticateAdmin, requireSuperAdmin, AdminController.getAllAdmins);            // View all (superAdmin only)

module.exports = router;
