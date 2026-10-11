const express = require('express');
const router = express.Router();
const {
  createPOSOrder,
  getAllPOSOrders,
  getPOSOrder,
  updatePOSOrderStatus,
  scanBarcode,
  searchProducts,
  getPOSStats,
  getRecentPOSOrders,
  printReceipt,
  refundPOSOrder,
  deletePOSOrder,
  sendPOSInvoiceEmail
} = require('../controller/POSController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const { findLoyaltyCustomer } = require('../controller/POSController');
const { validatePOSGiftCode } = require('../controller/POSController');

// All routes require admin authentication
router.use(authenticateAdmin);

// POS Order routes
router.post('/orders', createPOSOrder);
router.get('/loyalty/customer', findLoyaltyCustomer);
router.post('/gift-codes/validate', validatePOSGiftCode);
router.get('/orders', getAllPOSOrders);
router.get('/orders/:id', getPOSOrder);
router.put('/orders/:id/status', updatePOSOrderStatus);
router.post('/orders/:id/refund', refundPOSOrder);
router.post('/orders/:id/invoice-email', sendPOSInvoiceEmail);
router.delete('/orders/:id', deletePOSOrder);

// Barcode and search routes
router.post('/scan', scanBarcode);
router.get('/search', searchProducts);

// Dashboard and stats routes
router.get('/stats', getPOSStats);
router.get('/recent-orders', getRecentPOSOrders);

// Receipt routes
router.get('/orders/:id/receipt', printReceipt);

module.exports = router;
