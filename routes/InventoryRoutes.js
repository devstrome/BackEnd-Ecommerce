const express = require('express');
const router = express.Router();
const {
  getAllInventory,
  getInventoryById,
  createInventory,
  updateInventory,
  deleteInventory,
  scanCode,
  scanInventoryByCode,
  getInventoryStats,
  bulkCreateFromProduct,
  bulkCreate,
  generatePrintCodes,
  getInventoryBatch,
  restockInventory
} = require('../controller/InventoryController');

const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// All inventory routes require admin authentication
// (scoped to /inventory so this router does not intercept other /api routes)
router.use('/inventory', authenticateAdmin);

// Get all inventory items with pagination and filters
router.get('/inventory', getAllInventory);

// Get inventory statistics
router.get('/inventory/stats', getInventoryStats);

// Scan barcode/QR code via GET request (for frontend scanning)
router.get('/inventory/scan', scanInventoryByCode);

// Get multiple inventory items by IDs (for batch viewing)
router.get('/inventory/batch', getInventoryBatch);

// Scan barcode/QR code
router.post('/inventory/scan', scanCode);

// Create new inventory item
router.post('/inventory', createInventory);

// Update inventory item
router.put('/inventory/:id', updateInventory);

// Delete inventory item
router.delete('/inventory/:id', deleteInventory);

// Get inventory by ID (must be last to avoid conflicts with specific routes)
router.get('/inventory/:id', getInventoryById);

// Bulk create inventory from product variants
router.post('/inventory/bulk-create', bulkCreateFromProduct);

// Bulk create inventory items
router.post('/inventory/bulk', bulkCreate);

// Generate barcode/QR code for printing
router.post('/inventory/print-codes', generatePrintCodes);

// Restock inventory
router.post('/inventory/restock', restockInventory);

module.exports = router;
