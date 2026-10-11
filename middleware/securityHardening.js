'use strict';

const { rateLimit } = require('express-rate-limit');

function createLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ success: false, message }),
  });
}

// These in-process limits protect a single Node instance. If the app is scaled
// to multiple instances, configure express-rate-limit with a shared store.
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
});

const otpLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  message: 'Too many verification requests. Please wait 15 minutes and try again.',
});

const contactLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: 'Too many contact requests. Please wait before submitting again.',
});

const subscriberLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: 'Too many subscription requests. Please try again later.',
});

const newsletterSendLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 2,
  message: 'Newsletter sending is limited to two launches per hour.',
});

const chatMessageLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  message: 'You are sending messages too quickly. Please wait a moment.',
});

module.exports = {
  authLimiter,
  otpLimiter,
  contactLimiter,
  subscriberLimiter,
  newsletterSendLimiter,
  chatMessageLimiter,
};
