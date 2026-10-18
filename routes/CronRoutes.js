const express = require('express');
const router = express.Router();
const cronManager = require('../utils/cronManager');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/AdminAuthMiddleware');

router.use(authenticateAdmin, requireSuperAdmin);

// Get cron job status (Admin only)
router.get('/status', (req, res) => {
  try {
    res.json({
      success: true,
      data: { message: 'Cron jobs are running' },
      message: 'Cron job status retrieved successfully'
    });
  } catch (error) {
    console.error('Error getting cron status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get cron job status'
    });
  }
});

// Start all cron jobs (Admin only)
router.post('/start', (req, res) => {
  try {
    cronManager.initializeCronJobs();
    res.json({
      success: true,
      message: 'Cron jobs started successfully'
    });
  } catch (error) {
    console.error('Error starting cron jobs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start cron jobs'
    });
  }
});

// Manually trigger order confirmation emails (Admin only)
router.post('/trigger/confirmation', authenticateAdmin, async (req, res) => {
  try {
    await cronManager.triggerOrderConfirmationEmails();
    res.json({
      success: true,
      message: 'Order confirmation emails triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering confirmation emails:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger confirmation emails'
    });
  }
});

// Manually trigger order processing emails (Admin only)
router.post('/trigger/processing', authenticateAdmin, async (req, res) => {
  try {
    await cronManager.triggerOrderProcessingEmails();
    res.json({
      success: true,
      message: 'Order processing emails triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering processing emails:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger processing emails'
    });
  }
});

// Manually trigger order delivered emails (Admin only)
router.post('/trigger/delivered', authenticateAdmin, async (req, res) => {
  try {
    await cronManager.triggerOrderDeliveredEmails();
    res.json({
      success: true,
      message: 'Order delivered emails triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering delivered emails:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger delivered emails'
    });
  }
});

// Manually trigger order shipped emails (Admin only)
router.post('/trigger/shipped', authenticateAdmin, async (req, res) => {
  try {
    await cronManager.triggerOrderShippedEmails();
    res.json({
      success: true,
      message: 'Order shipped emails triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering shipped emails:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger shipped emails'
    });
  }
});

// Manually trigger order cancelled emails (Admin only)
router.post('/trigger/cancelled', authenticateAdmin, async (req, res) => {
  try {
    await cronManager.triggerOrderCancelledEmails();
    res.json({
      success: true,
      message: 'Order cancelled emails triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering cancelled emails:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger cancelled emails'
    });
  }
});

// Manually trigger order reactivation (Admin only)
router.post('/trigger/reactivation', authenticateAdmin, async (req, res) => {
  try {
    await cronManager.triggerOrderReactivation();
    res.json({
      success: true,
      message: 'Order reactivation triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering order reactivation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger order reactivation'
    });
  }
});

// Manually trigger OTP cleanup (Admin only)
router.post('/trigger/otp-cleanup', authenticateAdmin, async (req, res) => {
  try {
    await cronManager.triggerOTPCleanup();
    res.json({
      success: true,
      message: 'OTP cleanup triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering OTP cleanup:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger OTP cleanup'
    });
  }
});

// Get email configuration status (Admin only)
router.get('/email-config', authenticateAdmin, async (req, res) => {
  try {
    const { getAdminNotificationRecipientCount } = require('../utils/emailService');
    const adminRecipientCount = await getAdminNotificationRecipientCount();
    const config = {
      emailUser: process.env.EMAIL_USER ? 'Configured' : 'Not configured',
      emailPassword: process.env.EMAIL_PASSWORD ? 'Configured' : 'Not configured',
      emailService: 'Gmail SMTP',
      adminRecipients: adminRecipientCount ? 'Configured' : 'Not configured',
      adminRecipientCount,
    };
    return res.json({ success: true, data: config, message: 'Email configuration status retrieved' });
  } catch (error) {
    console.error('Unable to read email configuration:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to read email configuration.' });
  }
});

// Verify DNS, connection, TLS and Gmail SMTP authentication without sending mail.
router.post('/email-config/verify', authenticateAdmin, async (req, res) => {
  try {
    const { verifyEmailConnection } = require('../utils/emailService');
    await verifyEmailConnection();
    return res.json({ success: true, message: 'Gmail SMTP connection verified.' });
  } catch (error) {
    console.error('Gmail SMTP verification failed:', error.message);
    return res.status(502).json({
      success: false,
      message: error.message || 'Gmail SMTP verification failed.',
    });
  }
});

// Send a branded delivery check to active admins across assigned notification areas.
router.post('/email-config/test-admin', authenticateAdmin, async (req, res) => {
  try {
    const { sendAdminEmailTest } = require('../utils/emailService');
    const result = await sendAdminEmailTest();
    if (!result.success) {
      return res.status(502).json({ success: false, message: result.message || 'Admin email delivery check failed.' });
    }
    return res.json({
      success: true,
      message: 'Admin email delivery check accepted by Gmail SMTP.',
      recipientCount: result.recipientCount,
    });
  } catch (error) {
    console.error('Admin email delivery check failed:', error.message);
    return res.status(502).json({ success: false, message: error.message || 'Admin email delivery check failed.' });
  }
});

module.exports = router;
