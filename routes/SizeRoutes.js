const express = require('express');
const router = express.Router();

const {
  addSize,
  getSizes,
  updateSize,
  deleteSize
} = require('../controller/sizeController');


const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// Read — any authenticated admin
router.get('/sizes', getSizes);

// Create and update — authenticated admin
router.post('/sizes', authenticateAdmin, addSize);
router.put('/sizes/:id', authenticateAdmin, updateSize);

// Delete — requires the Products module permission
router.delete('/sizes/:id', authenticateAdmin, deleteSize);

module.exports = router;
