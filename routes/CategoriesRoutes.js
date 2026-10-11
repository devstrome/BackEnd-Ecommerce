const express = require('express');
const router = express.Router();
const {
  addCategory,
  getCategories,
  getCategoriesTree,
  updateCategory,
  deleteCategory,
  addBrandToCategory,
  removeBrandFromCategory
} = require('../controller/CategoriesController');


const {authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// Read — public
router.get('/categories/tree', getCategoriesTree);
router.get('/categories',  getCategories);

// Create and update — authenticated admin
router.post('/categories', authenticateAdmin, addCategory);
router.put('/categories/:id', authenticateAdmin, updateCategory);

// Per-category brand management — authenticated admin
router.post('/categories/:id/brands', authenticateAdmin, addBrandToCategory);
router.delete('/categories/:id/brands', authenticateAdmin, removeBrandFromCategory);

// Delete — requires the Products module permission
router.delete('/categories/:id', authenticateAdmin, deleteCategory);

module.exports = router;
