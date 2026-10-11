const express = require('express');
const router = express.Router();
const controller = require('../controller/LoyaltyController');
const authenticate = require('../middleware/UserAuthMiddleware');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

router.get('/loyalty/me', authenticate, controller.getMyLoyalty);
router.post('/loyalty/redeem', authenticate, controller.redeemGiftCode);

router.get('/admin/loyalty/settings', authenticateAdmin, controller.getAdminSettings);
router.patch('/admin/loyalty/settings', authenticateAdmin, controller.updateAdminSettings);
router.get('/admin/loyalty/customers', authenticateAdmin, controller.listLoyaltyCustomers);
router.post('/admin/loyalty/tiers', authenticateAdmin, controller.assignLoyaltyTier);
router.get('/admin/loyalty/gift-codes', authenticateAdmin, controller.listGiftCodes);
router.post('/admin/loyalty/gift-codes', authenticateAdmin, controller.createGiftCodes);
router.patch('/admin/loyalty/gift-codes/:codeId', authenticateAdmin, controller.updateGiftCode);
router.post('/admin/loyalty/gift-codes/:codeId/replace', authenticateAdmin, controller.replaceLegacyGiftCode);
router.delete('/admin/loyalty/gift-codes/:codeId', authenticateAdmin, controller.deleteGiftCode);
router.post('/admin/loyalty/adjust', authenticateAdmin, controller.adjustCustomerBalance);
router.get('/admin/loyalty/digital-products', authenticateAdmin, controller.getDigitalProducts);
router.get('/admin/loyalty/digital-codes', authenticateAdmin, controller.listDigitalCodes);
router.post('/admin/loyalty/digital-codes', authenticateAdmin, controller.addDigitalCodes);
router.delete('/admin/loyalty/digital-codes/:codeId', authenticateAdmin, controller.removeDigitalCode);

module.exports = router;
