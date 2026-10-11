const express = require('express');
const router = express.Router();
const Subscriber = require('../controller/SubscriberController');
const Newsletter = require('../controller/NewsletterController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const { subscriberLimiter, newsletterSendLimiter } = require('../middleware/securityHardening');

// Public — newsletter signup
router.post('/subscribers/subscribe', subscriberLimiter, Subscriber.subscribe);

// Admin — subscribers
router.get('/admin/subscribers/stats', authenticateAdmin, Subscriber.getSubscriberStats);
router.get('/admin/subscribers', authenticateAdmin, Subscriber.listSubscribers);
router.delete('/admin/subscribers/:id', authenticateAdmin, Subscriber.deleteSubscriber);
router.post('/admin/users/subscribe-all', authenticateAdmin, Subscriber.subscribeAllUsers);

// Admin — newsletters
router.get('/admin/newsletters', authenticateAdmin, Newsletter.getAllNewsletters);
router.post('/admin/newsletters', authenticateAdmin, Newsletter.createNewsletter);
router.post('/admin/newsletters/:id/send', authenticateAdmin, newsletterSendLimiter, Newsletter.sendNewsletter);
router.delete('/admin/newsletters/:id', authenticateAdmin, Newsletter.deleteNewsletter);

module.exports = router;
