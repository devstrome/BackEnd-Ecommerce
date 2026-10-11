const express = require('express');
const router = express.Router();
const { addBrand, getBrands, updateBrand, deleteBrand } = require('../controller/BrandController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

router.get('/brands', getBrands);
router.post('/brands', authenticateAdmin, addBrand);
router.put('/brands/:id', authenticateAdmin, updateBrand);
router.delete('/brands/:id', authenticateAdmin, deleteBrand);

module.exports = router;
