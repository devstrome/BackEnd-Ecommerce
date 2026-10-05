const express = require('express');
const router = express.Router();
const partnershipController = require('../controller/PartnershipController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

router.get('/partnership', authenticateAdmin, partnershipController.getState);
router.post('/partnership/partners', authenticateAdmin, partnershipController.addPartner);
router.delete('/partnership/partners/:id', authenticateAdmin, partnershipController.removePartner);
router.post('/partnership/contributions', authenticateAdmin, partnershipController.addContribution);
router.get('/partnership/profits', authenticateAdmin, partnershipController.getProfits);
router.post('/partnership/profits', authenticateAdmin, partnershipController.createProfit);
router.patch('/partnership/profits/:id', authenticateAdmin, partnershipController.updateProfit);
router.delete('/partnership/profits/:id', authenticateAdmin, partnershipController.deleteProfit);

module.exports = router;
