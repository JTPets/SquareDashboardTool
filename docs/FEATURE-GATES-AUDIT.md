# Feature Gates, Admin Security & User Management Audit
**Date:** 2026-04-06 | **Status:** Pre-beta readiness review

---

## 1. Feature Gate Coverage

| Module | Routes Gated | Pages Gated | requireFeature? | feature-check.js? |
|--------|-------------|-------------|-----------------|-------------------|
| cycle_counts | /api/cycle-counts | cycle-count, cycle-count-history | ✅ server.js:392 | ✅ data-feature-key |
| reorder | /api/analytics, /api/min-max/*, /api/purchase-orders, /api/vendor-*, /api/sales-velocity, /api/reorder-suggestions, /api/labels | reorder, purchase-orders, vendor-dashboard, vendor-catalog, vendor-match-suggestions, sales-velocity, min-max-history, min-max-suppression | ✅ server.js:395-401, 430-433, 514 | ✅ |
| expiry | /api/expiry-discounts, /api/expirations | expiry, expiry-discounts, expiry-audit | ✅ server.js:393-394 | ✅ |
| delivery | /api/delivery, /api/driver | delivery, delivery-route, delivery-history, delivery-settings, driver | ✅ server.js:537 | ✅ |
| loyalty | /api/loyalty, /api/seniors, /api/cart-activity, /api/deleted-items | loyalty, cart-activity, deleted-items | ✅ server.js:402-404, 522, 541 | ✅ |
| ai_tools | /api/ai-autofill | catalog-workflow | ✅ server.js:563 | ✅ |
| gmc | /api/gmc, /api/google | gmc-feed | ⚠️ inline pattern (see §6) | ✅ |

**Scenario — cycle_counts enabled, reorder disabled:**
- `/api/reorder-suggestions` → 403 `FEATURE_REQUIRED` (requireFeature blocks at server.js:400)
- `reorder.html` → feature-check.js fetches `/api/merchant/features` → reorder not in `enabled[]` → lock overlay injected
- Nav card `[data-feature="reorder"]` → feature-gate.js adds `feature-locked` class + lock badge

---

## 2. Admin Security Matrix

| Endpoint | requireAuth | requireAdmin | requirePermission | requireSuperAdmin |
|----------|-------------|--------------|-------------------|-------------------|
| GET /api/admin/merchants | ✅ | ✅ | — | — |
| POST /api/admin/merchants/:id/extend-trial | ✅ | ✅ | — | ✅ |
| GET /api/admin/merchants/:id/payments | ✅ | ✅ | — | ✅ |
| GET /api/admin/merchants/:id/features | ✅ | ✅ | — | ✅ |
| PUT /api/admin/merchants/:id/features/:key | ✅ | ✅ | — | ✅ |
| POST /api/admin/merchants/:id/activate | ✅ | ✅ | — | ✅ |
| GET /api/admin/promo-codes | ✅ | ✅ | — | ✅ |
| POST /api/admin/promo-codes/:id/deactivate | ✅ | ✅ | — | ✅ |
| GET /subscriptions/admin/list | — | — | ✅ subscription/admin | — |
| GET /subscriptions/admin/plans | — | — | ✅ subscription/admin | — |
| POST /subscriptions/admin/setup-plans | ✅ | — | ✅ subscription/admin | ✅ |
| GET /admin/pricing | — | — | ✅ subscription/admin | ✅ |
| PUT /admin/pricing/modules/:key | — | — | ✅ subscription/admin | ✅ |
| PUT /admin/pricing/plans/:key | — | — | ✅ subscription/admin | ✅ |
| GET /webhooks/events | ✅ | ✅ | — | ✅ |

**Notes:**
- `requireAdmin` (auth.js) checks `req.session.user.role === 'admin'` — session-based, users table role
- `requireSuperAdmin` checks email against `SUPER_ADMIN_EMAILS` env var (comma-separated, case-insensitive)
- Routes in subscriptions/admin.js without explicit requireAuth rely on `gateApi('/admin', requirePermission('staff', 'admin'))` at server.js level — requirePermission returns 403 if no merchantContext (which requires auth), but the rejection message is `NO_MERCHANT` not `UNAUTHORIZED` ⚠️

**Can regular merchant access /api/admin?** No — requireAdmin checks session.user.role='admin'.  
**Can staff 'viewer' access admin?** No — requireAdmin blocks; then requirePermission('staff','admin') blocks.  
**Can non-super-admin access /api/admin/promo-codes?** No — requireSuperAdmin checks SUPER_ADMIN_EMAILS.  
**Can non-super-admin access /api/admin/merchants/:id/features?** No — requireSuperAdmin required.

---

## 3. User & Staff Lifecycle

| Step | Mechanism | Works? |
|------|-----------|--------|
| 1. Platform owner created | First Square OAuth → auto-detected (no other merchants) → subscription_status='platform_owner' | ✅ |
| 2. Invite staff | POST /api/staff/invite (owner-only, ADMIN permission) → 7-day SHA-256 token → email | ✅ |
| 3. Staff accepts | GET /api/staff/validate-token (public) → POST /api/staff/accept (public, token-based) → user created + user_merchants row | ✅ |
| 4. Staff logs in | Session created → loadMerchantContext reads user_merchants.role → merchantContext.userRole | ✅ |
| 5. No-permission access | requirePermission returns 403 PERMISSION_DENIED | ✅ |
| 6. Role change effect | Roles loaded from DB per-request (not from session) → immediate effect | ✅ |

**Role matrix summary** (config/permissions.js):

| Role | cycle_counts | reorder | loyalty | ai_tools | delivery | staff mgmt | billing |
|------|-------------|---------|---------|----------|----------|------------|---------|
| owner | read/write/admin | read/write/admin | read/write/admin | read/write/admin | read/write/admin | read/write/admin | read/write/admin |
| manager | read/write/admin | read/write/admin | read/write/admin | read/write/admin | read/write/admin | read only | read only |
| clerk | read/write | read only | none | none | read/write | none | none |
| readonly | none | none | none | none | none | none | none |

**Gaps:**
- `UNIQUE(merchant_id, email)` on staff_invitations — cannot re-invite the same email until previous invite is cancelled/expired (no auto-cleanup)
- Legacy `user` role maps to `clerk` (documented in code); any old sessions with role='user' degrade gracefully
- Staff cannot modify their own role — PATCH /api/staff/:userId/role requires `staff:admin` permission (owner-only)

---

## 4. Payment → Access Chain

**Positive path (subscribe → access):**
```
POST /subscriptions/create
  → subscription-create-service.js: validate plan + promo
  → createSquareCustomerAndCard()
  → processFullSubscription() / processDiscountedPayment()
  → activateMerchantFeatures()
      → activateMerchantSubscription(subscriberId, merchantId)
          → UPDATE merchants SET subscription_status='active'
          → INSERT all getPaidModules() into merchant_features (source='subscription')
  → createUserAccount() → password setup token (24h) emailed

Merchant logs in → loadMerchantContext:
  → SELECT feature_key FROM merchant_features WHERE merchant_id=$1 AND enabled=TRUE
  → merchantContext.features = ['cycle_counts','reorder','expiry','delivery','loyalty','ai_tools','gmc']

GET cycle-count.html → feature-check.js → GET /api/merchant/features
  → cycle_counts in enabled[] → page loads normally

GET /api/cycle-counts → requireFeature('cycle_counts') → features.includes('cycle_counts') → ✅ next()
```

**Negative path (cancel → blocked):**
```
POST /subscriptions/cancel OR Square webhook (subscription.updated → canceled)
  → cancelMerchantSubscription(subscriberId, merchantId)
      → UPDATE merchants SET subscription_status='cancelled'
      → UPDATE merchant_features SET enabled=FALSE WHERE source='subscription'

GET cycle-count.html → feature-check.js → /api/merchant/features
  → cycle_counts NOT in enabled[] → lock overlay shown

GET /api/cycle-counts → requireFeature → features=[] → 403 FEATURE_REQUIRED
```

**Session staleness after cancellation:** Features loaded from DB on every request (not cached in session). Status takes effect immediately on next API call — ✅ no stale-session risk.

**Suspended/expired merchant:** `isSubscriptionValid=false` set in loadMerchantContext; `requireValidSubscription` middleware returns 402 on protected routes.

---

## 5. Per-Module Readiness Assessment

| Capability | Status | Notes |
|-----------|--------|-------|
| merchant_features per-module rows | ✅ Ready | Table supports individual feature_key entries |
| Admin toggle per-module | ✅ Ready | PUT /api/admin/merchants/:id/features/:key + requireSuperAdmin |
| feature-gate.js locked badges | ✅ Ready | [data-feature] cards show lock + price if not enabled |
| feature-check.js page blocking | ✅ Ready | data-feature-key overlay with upgrade link |
| subscription_plans per-module | ❌ Not ready | Only monthly/annual plans; no per-module plan_key |
| activateMerchantSubscription selective | ❌ Not ready | Grants ALL paid modules regardless of plan |
| Self-service module purchase UI | ❌ Not built | upgrade.html exists but no per-module checkout flow |

**Current state:** All-or-nothing subscription model. Admin can manually enable individual modules via super-admin toggle. Upgrade path to per-module billing requires: (1) new subscription_plans rows with module_key, (2) selective activateMerchantSubscription, (3) per-module checkout UI.

---

## 6. Security Holes Found

### HIGH — GMC Feed Endpoints Bypass Auth
**Location:** server.js:527-533
`/api/gmc/feed.tsv` and `/api/gmc/local-inventory-feed.tsv` explicitly skip `requireFeature('gmc')` AND `requirePermission('gmc','read')`. These endpoints return full product catalogs unauthenticated. Intended for Google's crawler but no token/secret protects them.
**Risk:** Any external party can enumerate product catalog + pricing by requesting the feed URLs.

### MEDIUM — subscriptions/admin.js Missing Explicit requireAuth
**Location:** routes/subscriptions/admin.js:61, 72, 102, 114, 137
These routes have requirePermission but no explicit requireAuth. They rely on server.js router-level `gateApi('/admin', requirePermission(...))`. If merchantContext is absent, the rejection code is `NO_MERCHANT` (403) not `UNAUTHORIZED` (401) — misleading but functionally blocks access. Recommend adding explicit requireAuth for clarity and defense-in-depth.

### LOW — Trial Merchant Base Feature Access After Expiry
Trial-expired merchants (status='trial', trial_ends_at in past) have `isSubscriptionValid=false`. `requireValidSubscription` blocks where applied, but base module routes (catalog, sync, inventory) do not use requireValidSubscription by default — only requireMerchant. Expired trial merchants may retain read access to base inventory data.

### LOW — Staff Re-invite Blocked by Unique Constraint
`UNIQUE(merchant_id, email)` on staff_invitations. If an invite expires, the owner must explicitly cancel it before re-inviting. No automated expiry cleanup job exists.

### INFORMATIONAL — requireAdmin Uses Session Role, Not merchantContext Role
`requireAdmin` checks `req.session.user.role === 'admin'` (users table column), while the permission system uses `merchantContext.userRole` (from user_merchants). These are separate concepts. A user with users.role='admin' but no merchant admin role would pass requireAdmin. Currently consistent but worth documenting.

---

## 7. Fix Plan

| Priority | Issue | Fix |
|----------|-------|-----|
| HIGH | GMC feed bypasses auth | Add shared secret param (`?token=`) or IP allowlist for Google crawler; or accept as intentional and document |
| MEDIUM | subscriptions/admin.js implicit auth | Add explicit `requireAuth` to each route for defense-in-depth and correct HTTP 401 responses |
| MEDIUM | Trial base access post-expiry | Apply `requireValidSubscription` globally to all non-public routes in server.js middleware stack |
| LOW | Staff re-invite blocked | Add cron/cleanup job to expire old staff_invitations or handle UNIQUE conflict with upsert |
| FUTURE | Per-module subscription | Add module_key to subscription_plans, selective feature activation, per-module checkout |
