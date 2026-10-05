const express = require('express');
const router = express.Router();
const controller = require('../controller/CheckoutRuleController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// Public
router.get('/checkout-rules', controller.listActive);
router.post('/checkout-rules/evaluate', controller.evaluate);

// Admin
router.get('/checkout-rules/admin/all', authenticateAdmin, controller.listAll);
router.post('/checkout-rules', authenticateAdmin, controller.create);
router.put('/checkout-rules/:id', authenticateAdmin, controller.update);
router.delete('/checkout-rules/:id', authenticateAdmin, controller.remove);

module.exports = router;
