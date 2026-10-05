const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const {
  getAdminHelpPages,
  getAdminHelpPage,
  createHelpPage,
  updateHelpPage,
  deleteHelpPage,
  getPublicHelpPages,
  getPublicHelpPage,
} = require('../controller/HelpPageController');

// Admin CRUD
router.get('/admin/help-pages', authenticateAdmin, getAdminHelpPages);
router.get('/admin/help-pages/:id', authenticateAdmin, getAdminHelpPage);
router.post('/admin/help-pages', authenticateAdmin, createHelpPage);
router.put('/admin/help-pages/:id', authenticateAdmin, updateHelpPage);
router.delete('/admin/help-pages/:id', authenticateAdmin, deleteHelpPage);

// Public
router.get('/help-pages', getPublicHelpPages);
router.get('/help-pages/:slug', getPublicHelpPage);

module.exports = router;
