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

## 2. Broken Paths

### BUG-1 (CRITICAL): `POST /api/subscriptions/promo/validate` — 400 for unauthenticated users
**File**: `routes/subscriptions/merchant.js:18-19`
```javascript
const merchantId = req.merchantContext?.id || req.session?.activeMerchantId;
if (!merchantId) return sendError(res, 'Merchant context required', 400);
```
On the subscribe.html page, the user has **no session and no merchant context** — they are signing up for the first time. The route is in `publicPaths` (auth skip) but still requires a `merchantId` to validate against. Result: every promo code attempt on the checkout page returns `400 "Merchant context required"`.

**Fix**: Fall back to platform owner's merchant ID (same pattern as `plans.js:18-26`).

### BUG-2 (CRITICAL): `POST /api/subscriptions/create` — 400 for unauthenticated users
**File**: `routes/subscriptions/merchant.js:34-35`
```javascript
const merchantId = req.session?.activeMerchantId || req.merchantContext?.id;
if (!merchantId) return sendError(res, 'Merchant context required', 400, 'NO_MERCHANT');
```
Same problem — new subscribers have no session. The entire subscription creation flow fails. This means **no new user can complete checkout from subscribe.html**.

**Fix**: A new subscriber does not need an existing `merchantId` — the `createSubscription` service creates the merchant record. Remove the `merchantId` guard from the `create` handler (or derive from platform owner). The `promo/validate` route needs platform owner fallback for unauthenticated callers.

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

### CSP-1: `font-src` missing Square CDN
Square Web Payments SDK loads fonts (Inter, etc.) from `https://web.squarecdn.com`. Without `*.squarecdn.com` in `font-src`, fonts are blocked — card form renders with fallback fonts or shows broken layout.

### CSP-2: `connect-src` missing Square CDN wildcard  
Square SDK makes XHR calls back to `*.squarecdn.com` for initialization and telemetry. These are blocked by current CSP. May manifest as card widget silently failing in some browsers.

---

## 5. Static File Issues

All public pages are served by `express.static('public')` (server.js:243). No 404 issues found:
- `/pricing.html` → `public/pricing.html` ✓ (also in `publicPages` list)
- `/subscribe.html` → `public/subscribe.html` ✓
- `/login.html` → `public/login.html` ✓
- `/set-password.html` → `public/set-password.html` ✓ (in `publicPages`)

Static JS assets (`/js/pricing.js`, `/js/subscribe.js`, `/js/login.js`) served from `public/js/` ✓

---

## 6. Fix Plan

**Priority order — fix BUG-1/2 first (checkout is completely broken):**

1. **`routes/subscriptions/merchant.js` — `promo/validate` handler (line 16-29)**
   - Remove `merchantId` requirement for unauthenticated callers
   - The `validatePromoCode` service should accept no `merchantId` (or use platform owner ID) for public validation
   - Or: move promo check logic to use `checkPublicPromo` (already exists in `public.js`) — subscribe.js should call `/api/public/promo/check` instead of `/api/subscriptions/promo/validate`

2. **`routes/subscriptions/merchant.js` — `create` handler (line 32-56)**
   - Remove the `merchantId` guard entirely — new signups have no merchant yet
   - The `createSubscription` service handles merchant creation; it should not require pre-existing `merchantId`

3. **`middleware/security.js` — CSP `font-src` (line 67)**
   - Add `"https://*.squarecdn.com"` to `fontSrc` array

4. **`middleware/security.js` — CSP `connect-src` (line 69-82)**
   - Add `"https://*.squarecdn.com"` to `connectSrc` array

5. **After fix**: test full flow manually — pricing → promo → subscribe → checkout → password setup → login
