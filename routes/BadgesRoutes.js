const express = require('express');
const router = express.Router();
const { addBadge, getBadges, updateBadge, deleteBadge } = require('../controller/BadgeController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// Read — any authenticated admin
router.get('/badges',  getBadges);

// Create and update — regular admin access
router.post('/badges', authenticateAdmin, addBadge);
router.put('/badges/:id', authenticateAdmin, updateBadge);

// Delete — requires the Products module permission
router.delete('/badges/:id', authenticateAdmin, deleteBadge);

module.exports = router;
