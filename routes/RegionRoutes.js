const express = require('express');
const router = express.Router();
const controller = require('../controller/RegionController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

router.get('/regions', controller.listRegions);
router.post('/regions', authenticateAdmin, controller.createRegion);
router.put('/regions/:id', authenticateAdmin, controller.updateRegion);
router.delete('/regions/:id', authenticateAdmin, controller.deleteRegion);

module.exports = router;
