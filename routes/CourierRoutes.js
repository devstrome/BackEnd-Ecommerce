const express = require('express');
const router = express.Router();
const courierController = require('../controller/CourierController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// Stage 1 — queue from the Orders page
router.post('/shipment', authenticateAdmin, courierController.queueShipment);
// Stage 2 — dispatch queued shipments to the real courier API
router.post('/shipments/:id/dispatch', authenticateAdmin, courierController.dispatchShipment);
// Listing for the admin Courier page
router.get('/shipments', authenticateAdmin, courierController.listShipments);
// Live tracking (falls back to stored data)
router.get('/track/:id', authenticateAdmin, courierController.trackShipment);
// Manual status updates
router.put('/status/:id', authenticateAdmin, courierController.updateStatus);
// Cancel a shipment with the courier
router.post('/shipments/:id/cancel', authenticateAdmin, courierController.cancelShipment);
// Remove a shipment from the courier list
router.delete('/shipments/:id', authenticateAdmin, courierController.deleteShipment);
// Edit recipient address / contact details
router.put('/shipments/:id', authenticateAdmin, courierController.updateShipment);
module.exports = router;
