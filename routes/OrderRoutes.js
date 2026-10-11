const express = require('express');
const router = express.Router();
const orderController = require('../controller/OrderController');

const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const authenticate = require('../middleware/UserAuthMiddleware');
const upload = require('../config/multerconfig');



// 🛒 Create order — authenticated user
router.post('/checkout/validate', authenticate, orderController.validateCheckout);
router.post('/order', authenticate, orderController.createOrder);


router.get('/orders', authenticate , orderController.getOrders);
router.get('/admin/orders/:orderId', authenticateAdmin, orderController.getAdminOrderByOrderId);
router.get('/admin/orders/:orderId/digital-fulfillment', authenticateAdmin, orderController.getAdminDigitalFulfillment);
router.put('/orders/:orderId/digital-fulfillment', authenticateAdmin, orderController.updateAdminDigitalFulfillment);
router.post('/orders/:orderId/digital-fulfillment-email', authenticateAdmin, orderController.emailAdminDigitalFulfillment);

router.get('/allorders',authenticateAdmin, orderController.getAllOrders);
router.patch('/orders/:orderId/mark-opened', authenticateAdmin, orderController.markOrderOpened);

// Admin invoice preview / print and customer email with the generated PDF.
router.get('/orders/:orderId/invoice-pdf', authenticateAdmin, orderController.getOrderInvoicePdf);
router.post('/orders/:orderId/invoice-email', authenticateAdmin, orderController.emailOrderInvoicePdf);

// 🛡️ Admin: create an order manually for a customer
router.post('/admin/orders', authenticateAdmin, orderController.adminCreateOrder);

// Customer order reads are scoped to the authenticated account.
router.get('/orders/:orderId', authenticate, orderController.getOrderByOrderId);

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
router.delete('/orders/:orderId', authenticateAdmin, orderController.deleteOrder);

// ✏️ Admin edit order (full update)
router.put('/orders/:orderId', authenticateAdmin, orderController.adminUpdateOrder);

// 🔹 Assign inventory to order item via scanning
router.post('/orders/:orderId/assign-inventory', authenticateAdmin, orderController.assignInventoryToOrderItem);

// 🔹 Remove inventory from order item
router.delete('/orders/:orderId/remove-inventory', authenticateAdmin, orderController.removeInventoryFromOrderItem);

// 📧 Send order finalization email
router.post('/orders/:orderId/send-finalization-email', authenticateAdmin, orderController.sendOrderFinalizationEmail);

module.exports = router;
