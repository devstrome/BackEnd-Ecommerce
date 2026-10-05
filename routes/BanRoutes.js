const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const BanController = require('../controller/BanController');

router.get('/bans', authenticateAdmin, BanController.listBans);
router.post('/bans/user', authenticateAdmin, BanController.banUser);
router.post('/bans/admin', authenticateAdmin, BanController.banAdmin);
router.delete('/bans/:id', authenticateAdmin, BanController.unban);

module.exports = router;
