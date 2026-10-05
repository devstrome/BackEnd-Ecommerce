const express = require('express');
const router = express.Router();
const orderController = require('../controller/OrderController');

const { authenticateAdmin, requireSuperAdmin } = require('../middleware/AdminAuthMiddleware');
const authenticate = require('../middleware/UserAuthMiddleware');
const upload = require('../config/multerconfig');



// 🛒 Create order — authenticated user
router.post('/order', authenticate, orderController.createOrder);


router.get('/orders', authenticate , orderController.getOrders);

router.get('/allorders',authenticateAdmin, orderController.getAllOrders);

// 🛡️ Admin: create an order manually for a customer
router.post('/admin/orders', authenticateAdmin, orderController.adminCreateOrder);

// 🕵️ Get single order — either
router.get('/orders/:orderId',   orderController.getOrderByOrderId);

// 🔄 Update status — admin only
router.patch('/orders/:orderId/status', authenticateAdmin, orderController.updateOrderStatus);

// ❌ Cancel order — either
router.patch('/orders/:orderId/cancel', authenticate ,  orderController.cancelOrder);

// ❌ Cancel order — either
router.patch('/orders/cancel/:orderId', authenticateAdmin ,  orderController.cancelOrderAdmin);

// 💰 Refund order — admin only
router.patch('/orders/:orderId/refund', authenticateAdmin, orderController.refundOrder);

// Refund request - user submits a request
router.patch('/orders/:orderId/refund-request', authenticate, orderController.requestRefund);

// Refund request - admin approves or rejects
router.patch('/orders/:orderId/refund-request/admin', authenticateAdmin, orderController.processRefundRequest);

// Refund request evidence image upload (authenticated user)
router.post('/upload/refund-image', authenticate, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided' });
  return res.json({ success: true, url: req.file.path });
});

// 🗑️ Delete — only super admin
router.delete('/orders/:orderId', [authenticateAdmin, requireSuperAdmin], orderController.deleteOrder);

// ✏️ Admin edit order (full update)
router.put('/orders/:orderId', authenticateAdmin, orderController.adminUpdateOrder);

// 🔹 Assign inventory to order item via scanning
router.post('/orders/:orderId/assign-inventory', authenticateAdmin, orderController.assignInventoryToOrderItem);

// 🔹 Remove inventory from order item
router.delete('/orders/:orderId/remove-inventory', authenticateAdmin, orderController.removeInventoryFromOrderItem);

// 📧 Send order finalization email
router.post('/orders/:orderId/send-finalization-email', authenticateAdmin, orderController.sendOrderFinalizationEmail);

module.exports = router;