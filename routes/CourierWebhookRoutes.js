const express = require('express');
const router = express.Router();
const { steadfastWebhook } = require('../controller/CourierWebhookController');

// Public endpoint — Steadfast signs the raw body (X-Signature), no JWT auth.
// express.raw gives us the untouched bytes for HMAC verification.
router.post('/steadfast', express.raw({ type: 'application/json' }), steadfastWebhook);

module.exports = router;
