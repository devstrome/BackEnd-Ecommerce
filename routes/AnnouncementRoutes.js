const express = require('express');
const router = express.Router();
const Announcement = require('../controller/AnnouncementController');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/AdminAuthMiddleware');

// Public — top announcement bar
router.get('/announcements/random', Announcement.getRandomAnnouncement);

// Admin — management
router.get('/admin/announcements', authenticateAdmin, Announcement.getAllAnnouncements);
router.post('/admin/announcements', authenticateAdmin, Announcement.createAnnouncement);
router.put('/admin/announcements/:id', authenticateAdmin, Announcement.updateAnnouncement);
router.delete('/admin/announcements/:id', authenticateAdmin, requireSuperAdmin, Announcement.deleteAnnouncement);

module.exports = router;
