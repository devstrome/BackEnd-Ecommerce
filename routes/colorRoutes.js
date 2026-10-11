const express = require('express');
const router = express.Router();

const {
  addColor,
  getColors,
  updateColor,
  deleteColor
} = require('../controller/colorController');


const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// Read — any authenticated admin
router.get('/colors',  getColors);

// Create and update — authenticated admin
router.post('/colors', authenticateAdmin, addColor);
router.put('/colors/:id', authenticateAdmin, updateColor);

// Delete — requires the Products module permission
router.delete('/colors/:id', authenticateAdmin, deleteColor);

module.exports = router;
