# Signup Flow End-to-End Audit
**Date**: 2026-04-05 | **Method**: Traced every browser fetch() to its route handler

---

## 1. Every Fetch URL Mapped to Route

| Page | JS File | fetch() URL | Route File | In publicPaths? | Auth Required? | Works? |
|------|---------|-------------|------------|-----------------|----------------|--------|
| pricing.html | pricing.js:9 | GET `/api/public/pricing` | subscriptions/public.js:11 | YES | No | ✓ |
| pricing.html | pricing.js:126 | GET `/api/public/promo/check?code=X` | subscriptions/public.js:27 | YES | No | ✓ |
| subscribe.html | subscribe.js:24 | GET `/api/subscriptions/plans` | subscriptions/plans.js:16 | YES | No | ✓ fallback to platform owner |
| subscribe.html | subscribe.js:195 | GET `/api/square/payment-config` | subscriptions/plans.js:8 | YES | No | ✓ |
| subscribe.html | subscribe.js:108 | POST `/api/subscriptions/promo/validate` | subscriptions/merchant.js:16 | YES | No | **BROKEN** — see §2 |
| subscribe.html | subscribe.js:315 | POST `/api/subscriptions/create` | subscriptions/merchant.js:32 | YES | No | **BROKEN** — see §2 |
| login.html | login.js:38 | POST `/api/auth/login` | routes/auth.js | YES | No | ✓ |
| login.html | login.js:117 | POST `/api/auth/forgot-password` | routes/auth.js | YES | No | ✓ |
| dashboard.html | feature-gate.js:14 | GET `/api/merchant/features` | server.js:460 | NO | YES (requireMerchant) | ✓ |
| dashboard.html | feature-check.js:19 | GET `/api/merchant/features` | server.js:460 | NO | YES (requireMerchant) | ✓ |
| settings.html | settings.js:245 | GET `/api/subscriptions/admin/plans` | subscriptions/admin.js:70 | NO | YES (subscription:admin) | ✓ |
| settings.html | settings.js:655 | GET `/api/subscriptions/merchant-status` | subscriptions/merchant.js:64 | NO | YES (requireAuth) | ✓ |
| settings.html | settings.js:656 | GET `/api/merchant/features` | server.js:460 | NO | YES (requireMerchant) | ✓ |
| settings.html | settings.js:788 | POST `/api/subscriptions/cancel` | subscriptions/merchant.js:70 | NO | YES (requireAuth) | ✓ |

---

## 2. Broken Paths — ALL FIXED

### ~~BUG-1 (CRITICAL): `POST /api/subscriptions/promo/validate` — 400 for unauthenticated users~~
**FIXED** (2026-04-09 verified). `merchant.js:19-27` now falls back to platform owner's merchant ID when `merchantId` is null (unauthenticated callers).

### ~~BUG-2 (CRITICAL): `POST /api/subscriptions/create` — 400 for unauthenticated users~~
**FIXED** (2026-04-09 verified). `merchant.js:43` now allows `merchantId = null` for public signups. The `createSubscription` service handles merchant creation without requiring a pre-existing merchant.

---

## 3. Auth Issues

### AUTH-1: `POST /api/subscriptions/promo/validate` and `POST /api/subscriptions/create`
- Listed in `apiAuthMiddleware.publicPaths` (server.js:293-294) — auth check is skipped ✓
- Listed in `subscriptionExcludedPaths` (server.js:336) — subscription enforcement skipped ✓
- Listed in feature gate's local `publicPaths` (server.js:444) — permission check skipped ✓
- **But route handlers themselves enforce `merchantId`** — unauthenticated call still fails at business logic layer

No other auth path issues found. All public HTML pages are correctly listed in `publicPages` (server.js:223): `pricing.html`, `subscribe.html`, `login.html`, `set-password.html`, `subscription-expired.html`.

---

## 4. CSP Issues

**Helmet config**: `middleware/security.js:40-100`

| Directive | Values | Issue |
|-----------|--------|-------|
| `script-src` | `'self'`, `*.cloudflare.com`, `web.squarecdn.com`, `*.squarecdn.com` | ✓ Covers sandbox (`sandbox.web.squarecdn.com`) via wildcard |
| `style-src` | `'self'`, `'unsafe-inline'`, `fonts.googleapis.com`, `*.squarecdn.com` | ✓ |
| `font-src` | `'self'`, `fonts.gstatic.com` | **MISSING `*.squarecdn.com`** — Square card form loads fonts from its CDN; blocked fonts cause broken card field UI |
| `connect-src` | `'self'`, `connect.squareup.com`, `connect.squareupsandbox.com`, `pci-connect.squareup.com`, `*.ingest.sentry.io`, `*.cloudflareinsights.com`, `127.0.0.1:9100/9101` | **MISSING `*.squarecdn.com`** — Square SDK makes XHR to its own CDN for telemetry/frame init |
| `frame-src` | `'self'`, `challenges.cloudflare.com`, `pci-connect.squareup.com`, `*.squarecdn.com` | ✓ Card iframe allowed |

### ~~CSP-1: `font-src` missing Square CDN~~
**FIXED** (2026-04-09 verified). `security.js:70` now includes `https://*.squarecdn.com` in `fontSrc`.

### ~~CSP-2: `connect-src` missing Square CDN wildcard~~
**FIXED** (2026-04-09 verified). `security.js:83` now includes `https://*.squarecdn.com` in `connectSrc`.

---

## 5. Static File Issues

All public pages are served by `express.static('public')` (server.js:243). No 404 issues found:
- `/pricing.html` → `public/pricing.html` ✓ (also in `publicPages` list)
- `/subscribe.html` → `public/subscribe.html` ✓
- `/login.html` → `public/login.html` ✓
- `/set-password.html` → `public/set-password.html` ✓ (in `publicPages`)

Static JS assets (`/js/pricing.js`, `/js/subscribe.js`, `/js/login.js`) served from `public/js/` ✓

---

## 6. Fix Plan — ALL COMPLETE

All 4 issues identified in this audit have been fixed:

1. ~~**BUG-1** — promo/validate merchantId guard~~ — **FIXED** (platform-owner fallback)
2. ~~**BUG-2** — create merchantId guard~~ — **FIXED** (null merchantId allowed)
3. ~~**CSP-1** — font-src missing Square CDN~~ — **FIXED** (`security.js:70`)
4. ~~**CSP-2** — connect-src missing Square CDN~~ — **FIXED** (`security.js:83`)

Full signup flow (pricing → promo → subscribe → checkout → password setup → login) is now functional.
