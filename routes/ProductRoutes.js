const express = require('express');
const router = express.Router();
const upload = require('../config/multerconfig');
const {
  addProduct,
  getProducts,
  updateProduct,
  deleteProduct,
  getSingleProduct,
  deleteVariant,
  addReview,
  getReviews,
  updateReview,
  deleteReview,
  updateStock,
  getStock,
  toggleLike,
  getLikeStatus,
  toggleWishlist,
  getWishlist,
  purchaseBroadcast,
  generateSKUs,
  generateProductSKU,
  getTopRatedProducts
} = require('../controller/productController');


const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const authenticateUser = require('../middleware/UserAuthMiddleware');

// 📥 Create product — authenticated admin
router.post(
  '/products',
  authenticateAdmin,
  upload.fields([
    { name: 'mainImage', maxCount: 1 },
    { name: 'images-0', maxCount: 10 },
    { name: 'images-1', maxCount: 10 },
    { name: 'images-2', maxCount: 10 },
    { name: 'images-3', maxCount: 10 },
    { name: 'images-4', maxCount: 10 },
  ]),
  addProduct
);


router.get('/products',  getProducts);
// must be declared before '/products/:id'
router.get('/products/top-rated', getTopRatedProducts);
router.post('/products/generate-skus', authenticateAdmin, generateSKUs);
router.post('/products/:id/generate-sku', authenticateAdmin, generateProductSKU);
router.get('/products/:id',  getSingleProduct);
// Reviews
router.get('/products/:id/reviews', getReviews);
router.post('/products/:id/reviews', authenticateUser, addReview);
router.put('/products/:id/reviews/:reviewId', authenticateUser, updateReview);
router.delete('/products/:id/reviews/:reviewId', authenticateUser, deleteReview);

// ✏️ Update product — authenticated admin
router.put(
  '/products/:id',
  authenticateAdmin,
  upload.fields([
    { name: 'mainImage', maxCount: 1 },
    { name: 'images-0', maxCount: 10 },
    { name: 'images-1', maxCount: 10 },
    { name: 'images-2', maxCount: 10 },
    { name: 'images-3', maxCount: 10 },
    { name: 'images-4', maxCount: 10 },
  ]),
  updateProduct
);

// 🗑️ Delete product — requires the Products module permission.
router.delete('/products/:id', authenticateAdmin, deleteProduct);

// 🧹 Delete variant — requires the Products module permission.
router.delete('/products/varients/:id', authenticateAdmin, deleteVariant);

// 📦 Stock management routes
router.get('/products/:id/stock', getStock);
router.put('/products/:id/variants/:variantId/stock', authenticateAdmin, updateStock);

// ❤️ Like / Love
router.get('/products/:id/like/status', authenticateUser, getLikeStatus);
router.post('/products/:id/like', authenticateUser, toggleLike);

// ⭐ Wishlist
router.get('/wishlist', authenticateUser, getWishlist);
router.post('/wishlist', authenticateUser, toggleWishlist);

// 📢 Live purchase broadcast (admin)
router.post('/products/purchase-broadcast', authenticateAdmin, purchaseBroadcast);

module.exports = router;
