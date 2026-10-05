// Central brand configuration — single source of truth for customer-facing identity.
// Usage: const { BRAND, brandFrom, brandFooter } = require('./brand');
// NOTE: Do NOT blindly rename URLs/color tokens (e.g. barvella.com image paths,
// maybelline-* tailwind tokens) — only display names/from-names come from here.

const BRAND = Object.freeze({
  NAME: 'BELORELLA',
  TAGLINE: 'Premium Fashion & Lifestyle',
  // From-name used on every outgoing email
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'BELORELLA',
  // Public site host (used in email footers/links)
  SITE_HOST: process.env.SITE_HOST || 'belorella.com',
  // Logo asset URL (host is a technical value — keep as-is unless it changes)
  LOGO_URL: process.env.BRAND_LOGO_URL || 'https://barvella.com/Barvella.png'
});

// RFC-style from header: "BELORELLA" <user@host>
const brandFrom = () => `"${BRAND.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`;

// Standard copyright footer block (plain text line for emails)
const brandFooter = (year = new Date().getFullYear()) =>
  `© ${year} ${BRAND.NAME}. All rights reserved.`;

module.exports = { BRAND, brandFrom, brandFooter };
