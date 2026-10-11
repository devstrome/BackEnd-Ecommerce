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
  SITE_HOST: 'belorella.com',
  // Public image URLs used in customer email HTML. The shared Google Photos
  // pages are resolved to their direct googleusercontent image URLs.
  LOGO_URL: 'https://lh3.googleusercontent.com/pw/AP1GczO_CK4GD4Ulx1zmv_Zpm9X1Wnfh3pmlFEqstk7sSRGmQV_fiEiPxdGK-GGCAKIM7TNsB_bcuCgakfTZLuA_l9GHbvHINoCF4smZCtpCAyAoC92jjg=s512',
  SIGNATURE_URL: process.env.BRAND_SIGNATURE_URL || 'https://lh3.googleusercontent.com/pw/AP1GczMWqjpzZ0wAdy0OK1n5B799q4zVTpYRF0hhccHlpuCcuFRbHwuH5ZlqVGIzRZBI2-qkRVM74y-qKKHcNIHgHQOxIaz_iu-bgKj1to11PxeWHZDjAw=s800',
  SEAL_URL: process.env.BRAND_SEAL_URL || 'https://lh3.googleusercontent.com/pw/AP1GczNRLrc-AvN9B-QDFy1akycL7Ah_yMwNjp5JJHhff0HO3cDvDqQZfQ_-b9yjYSCEO91T9Q5PDnu4zVObSI7pXJpB-A0LQSUkXqiqNyktGVPErAvRZA=s800'
});

// Email links must always point at the public storefront. Convert configured
// local development URLs to the production origin while preserving their path.
const PUBLIC_SITE_ORIGIN = 'https://belorella.com';
const publicSiteUrl = (urlOrPath = '') => {
  const value = String(urlOrPath || '').trim();
  let pathname = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      pathname = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      pathname = '/';
    }
  }
  if (!pathname || pathname === '/') return PUBLIC_SITE_ORIGIN;
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return `${PUBLIC_SITE_ORIGIN}${pathname}`;
};

// RFC-style from header: "BELORELLA" <user@host>
const brandFrom = () => `"${BRAND.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`;

// Standard copyright footer block (plain text line for emails)
const brandFooter = (year = new Date().getFullYear()) =>
  `© ${year} ${BRAND.NAME}. All rights reserved.`;

module.exports = { BRAND, brandFrom, brandFooter, publicSiteUrl };
