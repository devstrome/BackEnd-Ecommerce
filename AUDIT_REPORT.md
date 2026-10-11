# BELORELLA Website Audit

**Audit date:** 2026-10-09  
**Scope:** Broad frontend and backend source review covering admin/customer authentication, user management, route authorization, product/catalog and variant flows, cart/checkout/orders, inventory/POS/finance, courier, chat/presence, email/PDF, SEO, uploads, request validation, and dependencies across `BackEnd-Ecommerce` and `NextFrontend-Ecommerce`.  
**Status:** Broad static audit and targeted fixes completed; production verification is incomplete.

## Executive summary

This is not a full production sign-off. I reviewed the major customer and admin paths in both workspaces, including backend routes/controllers and frontend API consumers, and applied fixes for verified issues. I ran local unit, lint, parse, dependency, and production-build checks. I did not connect to a live database or external providers, exercise every path in a real browser/device matrix, or validate email/courier/OAuth behavior with provider credentials.

The frontend findings, route coverage, build/lint results, and remaining frontend work are documented separately in [FRONTEND_AUDIT.md](../NextFrontend-Ecommerce/FRONTEND_AUDIT.md).

The most important remaining risks are checkout stock reservation (orders can race before staff assign inventory), finance reports loading whole date ranges into application memory, unpaginated admin user/cart loading, unresolved frontend dependency advisories, and missing production-level integration/performance/security checks.

## Coverage of the requested audit brief

| Brief sections | Coverage in this pass | Remaining verification or implementation |
|---|---|---|
| 1–8: codebase, APIs, data, variants, product view, cart, checkout | Broad static review of the main backend routes/controllers, schemas, frontend state/API consumers, and variant snapshots. Focused tests cover data normalization and ownership helpers. | This was not a line-by-line review of every component. Checkout inventory reservation and real customer journey tests remain open. |
| 9–11: homepage, performance, state management | Frontend production build and route compilation pass; current cart/order state and catalog paths were reviewed. | No browser/device visual pass, bundle profiling, Core Web Vitals, or load test. |
| 12–26: SEO, indexing, URLs, admin SEO, data quality | Metadata, robots, sitemap, product/variant SEO, and admin SEO code were reviewed; blog sitemap pagination was fixed. SEO generation now uses deterministic product data and has no AI provider dependency. | Product canonical URLs still use IDs; IndexNow, category/brand sitemap coverage, crawl tests, and complete approval/data-quality workflows are not implemented or verified. |
| 27–38: security, courier, chat, OAuth, images, POS, email, cache, API, pagination, observability, tests | Auth/ownership, ban handling, literal search, upload adapter, HTML sanitization, security headers/rate limits, chat, variant/order/POS/email snapshots, and available tests were reviewed; additional source fixes are recorded below. | No live Google/courier/SMTP/Cloudinary integration; in-process rate limits are not shared across multiple server instances; comprehensive observability and admin user-list pagination remain open. |
| 39–47: real-world performance, responsive UX, crawler script, automation, failure isolation, production sign-off, deliverable | Build/lint/unit/static checks and this report are the local deliverables. | No real-world performance run, mobile/tablet browser pass, SEO crawler script run, production config review, or production sign-off. |
| Finance/accounting brief | Variant-level revenue/cost/refund snapshots, date filters, and CSV formula safety received targeted review and unit coverage. | Finance still filters/paginates large order sets in application memory; XLSX/PDF exports and reconciliation against live historical records remain open. |

This matrix is the boundary of the claim: the work is a broad source audit with local verification, not a complete production audit.

## Fixes applied

### Authentication and authorization

- Order listing now derives the customer filter from the authenticated identity; a customer-provided `userId` cannot select another account's orders.
- Customer order reads require authentication and verify ownership. Customer cancellation also verifies ownership.
- Admin order details use a separate authenticated admin endpoint. The admin order screen and order-confirmation flow were updated to use the appropriate endpoints/credentials.
- Banned admins are rejected by authentication, login, and refresh-token flows. Admin access-token records are removed before exposing the admin object to controllers.
- Admin account list/detail operations are superadmin-only, and admin registration now passes through admin authentication.
- Admin token verification now checks that an access/refresh token is still active and belongs to an unbanned account.
- Socket.IO tokens are checked against signed, active access tokens and the current banned state. Customer/admin room joins and presence updates are constrained to the authenticated identity.
- Customer REST authentication now loads the active-token list for revocation checks, then removes it before attaching the user to the request. This fixes a query/projection bug that could reject otherwise valid customer sessions.
- Customer chat REST operations now verify that the authenticated customer owns the room before reading or changing it (room lookup, messages, reactions, read receipts, and online status). A customer ID in the room URL can no longer be used to create or mutate another customer's chat.
- The admin Axios interceptor now reads the current stored token for each request, scopes it to the configured API origin, retries expired sessions with the stored refresh token, and clears the UI session after a banned response. This supports admin screens that make direct Axios calls without their own header.
- User registration/login/profile/payment-method responses now strip password hashes, refresh/access tokens, and device/network identifiers. User profile updates accept only name, username, and phone fields, preventing self-service changes to security or ban state.
- Public product-review responses no longer include reviewer email addresses; the frontend receives display names and avatars only.
- Admin user updates now whitelist editable profile fields and reject arbitrary account/security fields; duplicate email/username edits return a conflict. Admin API and socket clients no longer use refresh/customer tokens as admin access tokens.
- Ban IP matching now uses Express's resolved `req.ip` (which honors the configured trusted-proxy chain) instead of trusting the raw `X-Forwarded-For` header.
- Product, blog, contact, region, inventory, order, coupon, and POS search inputs are escaped as literal text before regex use. Product, inventory, and order list inputs validate scalar types, page sizes, search lengths, date filters, and sort fields; product batches cap at 500 and inventory pages cap at 100 while pagination remains available.

### Account and request handling

- Environment configuration loads before controllers and middleware capture secret values at import time (`index.js`).
- Account emails no longer include plaintext passwords; account-provided email/link values are escaped.
- JSON request bodies are limited to 2 MB; uploaded files are limited to 10 MB.
- Helmet and route-specific request throttles are enabled. `TRUST_PROXY_HOPS` is configurable and must match the deployed proxy chain; use a shared limiter store when running more than one backend instance.
- User-authored catalog/blog HTML is sanitized with a restricted allowlist before storage/rendering. PDF image fetches now accept only Cloudinary or the exact configured frontend origin, block redirects, cap bytes/time, and request PNG-formatted Cloudinary assets so WebP product images can render in PDFKit.

### Catalog, orders, checkout, and operations

- Variant/region data is carried through the existing product, cart, order, inventory, POS, and email presentation paths, including SKU, measure, color, region, and variant image where the saved record has that data.
- Product list sorting operates on the current filtered collection; it no longer sorts a potentially frozen Redux array in place (`NextFrontend-Ecommerce/src/views/Products.jsx`).
- Order detail formatting uses the shared `formatMeasureLine` helper.
- Browser chat notifications no longer request unsupported non-persistent notification actions; construction failures are caught in the customer chat context.
- The checkout rule engine recalculates delivery and fees on the server. The free-delivery threshold is evaluated against the merchandise amount, and the invoice/POS email paths use the server-computed order records.
- Invoice normalization and PDF generation share the order snapshots and recover variant details/images and inventory codes when present. PDF layout has unit coverage for large code rows/page capacity. Online invoice email and POS receipt email can attach generated PDFs.
- Follow-up on 2026-10-11: order/POS PDF product images and names are aligned; the POS A4 print includes product photos plus QR/barcodes from actual assigned items. Online and POS invoice PDFs no longer invent scannable codes from SKUs or database IDs; unavailable code values remain blank. Legacy orders derive digital-item visibility from the catalog flag, manual code/login/password/access URL/expiry/serial details remain encrypted at rest, digital-only orders hide courier dispatch, and mixed parcels include physical items only.
- The refund-order lookup now returns a chainable Mongoose query, and order status writes use `withTransaction` to retry transient MongoDB write conflicts. Admin and customer order email layouts are separate.
- Finance rows preserve variant and per-unit cost snapshots; refund allocations and CSV formula escaping have unit coverage.
- The blog sitemap now requests all published pages in batches instead of asking for a single oversized page that the API silently capped.
- Cloudinary uploads now use a small local Multer storage adapter with the existing `path`/`filename` contract. The vulnerable legacy storage package was removed and the Cloudinary SDK was upgraded to 2.11.0. Nodemailer was upgraded to 10.0.16, and the backend declares Node.js >=20. Swiper was upgraded to 14.3.0.

These changes are in the current worktree and have not been deployed.

## Findings still requiring work

| Severity | Area | Finding | Recommended next action |
|---|---|---|---|
| High | Stock / checkout / POS | Checkout validates product option stock but does not reserve/decrement it when creating an order. Product stock is adjusted later during manual inventory assignment, leaving a race where separate orders can pass against the same stock. POS and serialized inventory also need a single tested stock-consistency rule. | Design and implement atomic stock reservations with matching release/fulfillment/refund/POS behavior, then add concurrent checkout and lifecycle integration tests against a replica-set test database. |
| High | Finance scalability | Finance currently loads matching online and POS orders and performs filtering/pagination in application memory. Large date ranges can consume substantial memory and response time. | Move date/status/category filters, aggregation, and pagination into MongoDB aggregation pipelines; add indexes from measured query plans. |
| Medium | Finance exports | The audited finance routes expose CSV export; XLSX and PDF finance exports requested in the accounting brief were not found. | Add XLSX/PDF only after defining consistent totals and variant-level cost/refund fields; verify exported totals against the dashboard. |
| High | Test coverage | Backend unit tests do not exercise authentication middleware, checkout transactions, order lifecycle, inventory assignment/refunds, courier callbacks, or database migrations end to end. | Add isolated integration tests with a disposable replica-set database and stubbed providers. |
| Medium | API hardening | Rate limits are currently held in process memory, so separate backend instances do not share counters. Incorrect proxy-hop configuration can also affect client IP handling. | Set `TRUST_PROXY_HOPS` to the exact deployment topology and use a shared rate-limit store (for example Redis) before horizontally scaling. |
| Medium | Admin user management | The user list still loads every user, every cart, and populated cart products in one response; the UI filters all users in memory. The bans endpoint is also fetched as a full list. | Add server-side search/pagination and return counts for the admin summary; join cart/ban data only for the visible page. |
| Medium | Browser token storage | User and admin access/refresh tokens are stored in browser local storage. A successful same-origin script injection could read them. | Move refresh credentials to secure, HttpOnly, SameSite cookies and reduce access-token exposure; coordinate this with CSRF protection and all existing auth clients. |
| Medium | Admin onboarding | Passwords are no longer emailed, which closes plaintext credential delivery. The admin invitation path still needs a secure password-setup/reset token flow so recipients can activate accounts without relying on credentials sent through another channel. | Add expiring, single-use setup links and invalidate them after use. |
| Medium | SEO | Product URL generation still relies on IDs rather than a canonical product slug. No IndexNow integration or Python SEO service was found. Category/brand sitemap coverage and social share previews also need end-to-end verification. | Decide canonical slug and IndexNow requirements, expand sitemap coverage, then validate crawler and social-platform previews using deployed URLs. |
| Medium | Variant migrations | A migration script exists for product configurations, but it was not run against any database in this audit. Historical catalog/order/finance records may still lack normalized region/variant snapshots. | Back up production data, run the migration in staging, compare before/after counts and samples, then schedule production migration. |
| Medium | Invoice and email | Local PDF generation has unit coverage, but print dialogs, multi-page output, barcode/QR readability, image loading, and email provider attachments were not validated in a browser or against a live SMTP provider. | Exercise representative one-page and multi-page orders in Chrome/Edge, inspect printed A4 and thermal output, and send test attachments through a non-production mail account. |
| High | Dependency audit | Backend production dependencies report zero vulnerabilities after SDK updates. Frontend `npm audit` still reports 11 advisories (8 high, 3 moderate), including Next.js/PostCSS and Tailwind's build-time dependency tree. npm's suggested Next.js 16 and Tailwind 4 fixes are major migrations and were not applied without full compatibility/visual verification. The current [braces advisory](https://github.com/advisories/ghsa-vfj7-8cjw-p6xm) lists no patched version. | Plan and validate the Next.js/Tailwind major migration; rerun dependency audit after the upstream `braces` fix is available. Keep build dependencies current in the meantime. |
| Low | Frontend quality | Lint and production build pass, but lint reports existing hook dependency and `<img>` optimization warnings; `next lint` is deprecated in the installed Next.js version. | Triage hook warnings and migrate to the supported ESLint CLI. |

## Verification performed

- Backend `npm test`: **22 passed, 0 failed**. The configured suite covers finance calculations/export safety, invoice normalization/PDF output and page capacity, order access, user payload safety, chat-room ownership, regex escaping, ban IP resolution, and the Cloudinary Multer adapter contract.
- Backend JavaScript parse check: **159 files parsed successfully** with `node --check`.
- Backend source `git diff --check` (excluding the vendored `node_modules` tree): completed without whitespace errors.
- Frontend `npm run lint`: **exit 0**, with existing warnings noted above.
- Frontend `npm run build`: **exit 0** after the Swiper upgrade; Next.js production compilation and route generation completed.
- Backend `npm audit --omit=dev`: **0 vulnerabilities**. Frontend `npm audit`: **11 remaining advisories** (8 high, 3 moderate); major framework/CSS-tool migrations require separate compatibility work.
- Cloudinary SDK upload-stream API presence was checked locally; the adapter unit tests use a fake uploader and do not contact Cloudinary.
- An earlier broad test command invoked the configured test-email script and sent its configured test message. The final focused `npm test` suite does not send email; no provider delivery was tested in this pass.
- The 2026-10-11 follow-up edits described above were reviewed statically only; no build, lint, or tests were run after those incremental changes.

## Not verified in this audit

- Production/staging database behavior, transactions, concurrency, historical-data quality, or the migration script.
- Live authentication providers (Google OAuth), Cloudinary uploads, courier webhooks/labels, SMTP delivery, payment integrations, or external SEO/social crawlers.
- Browser interaction and print rendering on physical A4/thermal printers, mobile breakpoints, accessibility, real Core Web Vitals, or load testing.
- Deployment secrets, TLS/proxy configuration, CDN/cache rules, backups/restore, monitoring/alerting, and production rollback procedures.

## Audit conclusion

The codebase received a broad static review and several high-impact authorization, input-handling, upload, and dependency fixes. Current unit tests and the frontend production build pass. The site should **not** be described as fully audited or production-ready until the stock reservation, finance scalability, user-list pagination, remaining frontend dependency advisories, and live-environment checks above are addressed.
