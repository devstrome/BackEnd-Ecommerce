const express = require('express');
const router = express.Router();
const {
  submitContact,
  getAllContacts,
  getContact,
  updateContactStatus,
  deleteContact,
  getContactStats,
  markAsResolved,
  bulkUpdateContacts,
  exportContacts,
  replyToContact
} = require('../controller/contactController');

const { isAuthenticatedAdmin } = require('../middleware/auth');
const { contactLimiter } = require('../middleware/securityHardening');

// Public routes
router.post('/submit', contactLimiter, submitContact);

// Admin routes (protected)
router.get('/admin/contacts', isAuthenticatedAdmin, getAllContacts);
router.get('/admin/contacts/:id', isAuthenticatedAdmin, getContact);
router.post('/admin/contacts/:id/reply', isAuthenticatedAdmin, replyToContact);
router.put('/admin/contacts/:id', isAuthenticatedAdmin, updateContactStatus);
router.delete('/admin/contacts/:id', isAuthenticatedAdmin, deleteContact);
router.get('/admin/stats', isAuthenticatedAdmin, getContactStats);
router.put('/admin/contacts/:id/resolve', isAuthenticatedAdmin, markAsResolved);
router.put('/admin/contacts/bulk-update', isAuthenticatedAdmin, bulkUpdateContacts);
router.get('/admin/export', isAuthenticatedAdmin, exportContacts);

module.exports = router;
