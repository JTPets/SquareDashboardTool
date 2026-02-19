# Technical Debt Status

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Security Audit](./SECURITY_AUDIT.md) | [Architecture](./ARCHITECTURE.md)

**Last Review**: 2026-02-19
**Master Engineering Review**: 2026-01-26
**Current Grade**: A+ (All P0 and P1 security issues FIXED)
**Target Grade**: A++ (Production-ready SaaS)

---

## Grade Criteria

| Grade | Description |
|-------|-------------|
| A++ | Production SaaS-ready: comprehensive tests, scalable architecture, zero security concerns |
| A+ | **Current**: Enterprise-ready: strong tests, good architecture, minor improvements possible |
| A | Solid - good patterns, all security fixes complete, tests comprehensive |
| B+ | Good fundamentals, critical security gaps need fixing |
| B | Functional: works but has significant debt |

## Quick Reference: Grade Requirements

| Grade | P0 | P1 | P2 | P3 |
|-------|----|----|----|----|
| A++ | 7/7 | 9/9 | 6/6 | Optional |
| A+ (Current) | 7/7 | 9/9 | 6/6 | - |
| A | 7/7 | 5/9 | 6/6 | - |
| B+ | 4/7 | 5/9 | 5.5/6 | - |

---

## Roadmap to A++

### Summary

| Priority | Status | Items |
|----------|--------|-------|
| P0 Security | 7/7 | All P0 items complete (P0-5,6,7 fixed 2026-01-26) |
| P1 Architecture | 9/9 | All P1 items complete; P1-1 monolith eliminated (2026-02-05); P1-6,7,8,9 fixed 2026-01-26 |
| P2 Testing | 6/6 | Tests comprehensive (P2-4 implementation gap closed by P0-6) |
| **API Optimization** | 4/4 | All P0-API items fixed (2026-01-27). ~1,000+ API calls/day saved |
| P3 Scalability | Optional | Multi-instance deployment prep |

API optimization complete. Rate limiting issues should be resolved.

---

## P0: Security Fixes (CRITICAL)

These must be fixed before any production deployment or Square partnership discussions.

### P0-1: JSON Body Limit Enables DoS
**File**: `server.js:129`
**Status**: FIXED (2026-01-26)

Reduced JSON body limit from 50mb to 5mb. POD uploads use multer with separate limits.

---

### P0-2: Subscription Check Fails Open
**File**: `middleware/subscription-check.js:139-146`
**Status**: FIXED (2026-01-26)

Changed error handler to fail closed - returns 503 for API requests and redirects HTML requests when subscription status cannot be verified.

---

### P0-3: Error Messages Expose Internal Details
**Status**: FIXED (2026-01-26)

Fixed 3 locations exposing internal error details to clients:
- `routes/subscriptions.js:601-612` - Refund errors now log details server-side, return generic message
- `routes/loyalty.js:1056-1066` - Square API errors now logged, return 502 with generic message
- `routes/google-oauth.js:97-101` - OAuth errors use generic `oauth_failed` code in redirect URL

---

### P0-4: CSP Allows Unsafe Inline
**File**: `middleware/security.js:23-35`
**Status**: FIXED (2026-02-01)

**Phase 1 COMPLETE**: All inline EVENT HANDLERS (`onclick`, `onchange`, etc.) migrated to event delegation pattern using `data-action` attributes.

**Phase 2 COMPLETE**: All inline `<script>` blocks externalized to `/public/js/` directory.

#### Phase 2 Final Status: 29/29 files externalized (100%)

| Status | File | JS Lines | Complexity |
|--------|------|----------|------------|
| Done | support.html → support.js | 1 | A |
| Done | index.html → index.js | 21 | A |
| Done | login.html → login.js | 155 | B |
| Done | set-password.html → set-password.js | 103 | B |
| Done | sales-velocity.html → sales-velocity.js | 108 | A |
| Done | delivery-settings.html → delivery-settings.js | 127 | A |
| Done | logs.html → logs.js | 163 | B |
| Done | deleted-items.html → deleted-items.js | 178 | B |
| Done | cycle-count-history.html → cycle-count-history.js | 191 | B |
| Done | delivery-history.html → delivery-history.js | 211 | A |
| Done | merchants.html → merchants.js | 266 | A |
| Done | admin-subscriptions.html → admin-subscriptions.js | 337 | B |
| Done | dashboard.html → dashboard.js | 393 | B |
| Done | expiry.html → expiry.js | 443 | B |
| Done | inventory.html → inventory.js | 400 | B |
| Done | catalog-audit.html → catalog-audit.js | 350 | B |
| Done | expiry-audit.html → expiry-audit.js | 830 | B |
| Done | cycle-count.html → cycle-count.js | 420 | B |
| Done | expiry-discounts.html → expiry-discounts.js | 450 | B |
| Done | subscribe.html → subscribe.js | 280 | B |
| Done | driver.html → driver.js | 460 | C |
| Done | delivery.html → delivery.js | 487 | C |
| Done | delivery-route.html → delivery-route.js | 785 | C |
| Done | purchase-orders.html → purchase-orders.js | 710 | C |
| Done | settings.html → settings.js | ~850 | C |
| Done | reorder.html → reorder.js | ~1,200 | D |
| Done | vendor-catalog.html → vendor-catalog.js | ~1,400 | D |
| Done | gmc-feed.html → gmc-feed.js | ~1,700 | D |
| Done | loyalty.html → loyalty.js | ~2,200 | D |

**Total externalized**: ~15,219 lines of JavaScript

#### Completion Timeline

1. ~~**Batch 2** (Tier A): delivery-history, merchants~~ COMPLETE (2026-01-27)
2. ~~**Batch 3** (Tier B part 1): admin-subscriptions, dashboard, expiry~~ COMPLETE (2026-01-27)
3. ~~**Batch 4** (Tier B part 2): inventory, catalog-audit, expiry-audit~~ COMPLETE (2026-01-27)
4. ~~**Batch 5** (Tier B part 3): cycle-count, expiry-discounts, subscribe~~ COMPLETE (2026-01-30)
5. ~~**Batch 6** (Tier C part 1): driver, delivery (~947 lines)~~ COMPLETE (2026-01-30)
6. ~~**Batch 7** (Tier C part 2): delivery-route, purchase-orders (~1,495 lines)~~ COMPLETE (2026-01-30)
7. ~~**Batch 8** (Tier C/D): settings, reorder (~2,050 lines)~~ COMPLETE (2026-02-01)
8. ~~**Batch 9** (Tier D): vendor-catalog, gmc-feed, loyalty (~5,300 lines)~~ COMPLETE (2026-02-01)

#### Phase 1 Completed Migration (27 HTML files, ~335 handlers):
- All HTML files have event handlers using `data-*` attributes
- No inline `onclick`, `onchange`, etc. handlers remain

---

### P0-5: Session Cookie Name Mismatch
**Files**: `server.js:172`, `routes/auth.js:191`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#p0-5-session-cookie-name-mismatch) for details.

---

### P0-6: Missing Session Regeneration on Login
**File**: `routes/auth.js:137-186`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#p0-6-missing-session-regeneration-on-login) for details.

---

### P0-7: XSS via Unescaped innerHTML
**Files**: 13 HTML files (all vulnerable locations fixed)
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#p0-7-xss-via-unescaped-innerhtml) for details.

---

## P1: Architecture Fixes (HIGH)

### P1-1: Loyalty Service Migration
**Status**: IN PRODUCTION (2026-01-30)

Modern service running in production with feature flags enabled.

#### Architecture Overview

```
PRODUCTION FLOW (2026-02-05)
────────────────────────────────────────────────────────────────────────
  Webhook Events ──► webhook-processor.js ──► webhook-handlers/
                                              ├── order-handler.js
                                              └── loyalty-handler.js
                                                       │
                                    ┌──────────────────┴──────────────────┐
                                    ▼                                     ▼
                      services/loyalty/              services/loyalty-admin/
                      (DEAD CODE — BACKLOG-31)       (19 modular services)
                      ├── webhook-service.js         ├── index.js (59 exports)
                      ├── square-client.js           ├── purchase-service.js
                      ├── customer-service.js        ├── reward-service.js
                      ├── offer-service.js           ├── webhook-processing-service.js
                      ├── purchase-service.js        ├── square-discount-service.js
                      ├── reward-service.js          ├── backfill-service.js
                      ├── loyalty-logger.js          ├── expiration-service.js
                      └── loyalty-tracer.js          └── ... (9 more modules)

  routes/loyalty.js ───────────────────► services/loyalty-admin/
  (Admin API - 59 exports)
```

The legacy `loyalty-service.js` monolith has been **fully eliminated**. All functions extracted to 19 dedicated modules in `services/loyalty-admin/`. See [ARCHITECTURE.md](./ARCHITECTURE.md#loyalty-admin-modules) for the full module structure.

#### Migration Plan

**Phase 1: Wire Up Modern Service** - COMPLETE
**Phase 2: Test in Production** - COMPLETE (2026-01-30)
**Phase 3: Migrate Remaining Handlers** - COMPLETE
**Phase 4: Extract Admin to Modular Services** - COMPLETE (2026-02-05)

All 179 loyalty tests pass. No circular dependencies remain.

#### Success Criteria

- [x] Feature flag `USE_NEW_LOYALTY_SERVICE` added (in `config/constants.js`)
- [x] Modern service processes orders when flag is `true`
- [x] Legacy service still works when flag is `false`
- [x] Rate limiting handled with retry logic (commit 89b9a85)
- [x] Phase 4 modular extraction complete (2026-02-05)
- [x] Legacy monolith eliminated - all functions in dedicated modules
- [x] All existing tests pass (179 loyalty tests)
- [x] No circular dependencies in module graph

---

### P1-2: Fat Routes Need Service Extraction
**Problem**: Business logic in route handlers instead of services

| Route File | Lines | Service Created | Routes Wired | Status |
|------------|-------|-----------------|--------------|--------|
| `routes/catalog.js` | ~~1,493~~ → **327** | `services/catalog/` | **78% reduction** | COMPLETE |
| `routes/loyalty.js` | 1,645 | `services/loyalty/` | Pending | Blocked by P1-1 |
| `routes/delivery.js` | 1,211 | `services/delivery/` | Already using service | COMPLETE |

**Progress (2026-01-26)**:
- Created `services/catalog/` with 4 service modules:
  - `item-service.js` - Locations, categories, items
  - `variation-service.js` - Variations, costs, bulk updates
  - `inventory-service.js` - Inventory, low stock, expirations
  - `audit-service.js` - Catalog audit, location fixes, enable items at locations
- **Wired routes/catalog.js to use catalog service** (1,493 → 327 lines, 78% reduction)
  - All 17 endpoints now call catalogService methods
  - Zero direct db.query() calls in routes
  - Response format preserved for backward compatibility

**Pattern Applied**:
```javascript
// routes/catalog.js (thin - 327 lines)
router.get('/items', asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { name, category } = req.query;
    const result = await catalogService.getItems(merchantId, { name, category });
    res.json(result);
}));

// services/catalog/item-service.js (business logic)
async function getItems(merchantId, filters) {
    // All business logic here including db queries
}
```

**Remaining Work**:
- Wire routes/loyalty.js to call services/loyalty/ (admin features need extraction first)

**Why**: Routes should be thin controllers. Business logic in routes can't be unit tested without HTTP mocking.

---

### P1-3: Utils Directory Reorganization
**Problem**: 26 files (23,253 lines) mixing utilities, services, and domain logic
**Status**: FIXED (2026-01-26)

**Current Structure**:
```
services/                # Business logic services
├── loyalty/             # Modern service (P1-1)
├── loyalty-admin/       # Modular loyalty admin (19 modules, 59 exports)
├── catalog/             # Catalog data management (P1-2)
├── merchant/            # Settings service
├── delivery/            # Delivery order management
├── expiry/              # Expiry discount automation
├── inventory/           # Cycle count batch generation
├── gmc/                 # Google Merchant Center
├── vendor/              # Vendor catalog import
├── reports/             # Report generation
├── square/              # Square API integration
├── webhook-handlers/    # Already organized
└── webhook-processor.js # Already here

utils/                   # Re-export stubs for backward compatibility
├── delivery-api.js      # → services/delivery/
├── expiry-discount.js   # → services/expiry/
├── cycle-count-utils.js # → services/inventory/
├── gmc-feed.js          # → services/gmc/feed-service.js
├── merchant-center-api.js # → services/gmc/merchant-service.js
├── vendor-catalog.js    # → services/vendor/
├── loyalty-reports.js   # → services/reports/
├── loyalty-service.js   # → services/loyalty-admin/ (monolith eliminated)
├── square-api.js        # → services/square/
├── database.js          # Re-exports getMerchantSettings from services/merchant/
└── ... (remaining true utilities)
```

**Completed Extractions**:
- `cycle-count-utils.js` → `services/inventory/cycle-count-service.js` (349 lines)
- `gmc-feed.js` → `services/gmc/feed-service.js` (589 lines)
- `merchant-center-api.js` → `services/gmc/merchant-service.js` (1,100 lines)
- `vendor-catalog.js` → `services/vendor/catalog-service.js` (1,331 lines)
- `loyalty-reports.js` → `services/reports/loyalty-reports.js` (969 lines)
- `square-api.js` → `services/square/api.js` (3,517 lines)
- `loyalty-service.js` → `services/loyalty-admin/` (15 modular services, monolith eliminated)

---

### P1-4: Helper Function in server.js
**File**: `utils/image-utils.js`
**Status**: FIXED (2026-01-26)

Moved `resolveImageUrls()` from server.js to `utils/image-utils.js` alongside the existing `batchResolveImageUrls()` function.

---

### P1-5: Inconsistent Validator Organization
**Status**: FIXED (2026-01-26)

Created `middleware/validators/auth.js` with validators for all auth endpoints:
- `login` - email and password validation
- `changePassword` - current password + new password strength check
- `createUser` - email, optional name/role/password validation
- `updateUser` - user ID param, optional name/role/is_active validation
- `resetUserPassword` - user ID param, optional password strength check
- `unlockUser` - user ID param validation
- `forgotPassword` - email validation
- `resetPassword` - token + password strength validation
- `verifyResetToken` - token query param validation

Updated `routes/auth.js` to use the new validators middleware.

**Remaining**: `routes/square-oauth.js` uses config validation (optional - low priority)

---

### P1-6: Missing Input Validators
**Files**: `routes/square-attributes.js`, `routes/cycle-counts.js`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#p1-6-missing-input-validators) for details.

---

### P1-7: Password Reset Token Not Invalidated on Failed Attempts
**File**: `routes/auth.js`, `middleware/security.js`, `database/migrations/028_password_reset_attempt_limit.sql`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#p1-7-password-reset-token-not-invalidated-on-failed-attempts) for details.

---

### P1-8: Webhook Endpoint Not Rate Limited
**Files**: `middleware/security.js`, `routes/webhooks/square.js`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#p1-8-webhook-endpoint-not-rate-limited) for details.

---

### P1-9: Error Messages Still Expose Internal Details
**File**: `routes/subscriptions.js`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#p1-9-error-messages-still-expose-internal-details) for details.

---

## P2: Testing Requirements (HIGH)

### P2-1: Multi-Tenant Isolation Tests
**File**: `__tests__/security/multi-tenant-isolation.test.js` (26 tests)
**Status**: COMPLETE (2026-01-26)

**All required tests exist**:
- User A cannot access Merchant B's data
- List endpoints don't leak data across tenants
- Direct merchant_id parameter manipulation rejected
- Merchant context loading with user_merchants verification
- Session activeMerchantId doesn't grant unauthorized access
- Cross-tenant update/delete prevention
- Bulk operations respect merchant boundaries
- Webhook routing by square_merchant_id
- Data leakage prevention in error messages, pagination, search
- Merchant role isolation per-tenant

---

### P2-2: Payment/Refund Flow Tests
**File**: `__tests__/routes/subscriptions.test.js` (59 tests)
**Status**: COMPLETE (2026-01-26)

**All required tests exist**:
- Promo code validation (dates, limits, discounts)
- Subscription creation input validation
- Duplicate email prevention
- Plan validation
- PCI compliance (no card data storage)
- Admin refund authorization
- Generic error messages (no internal details)
- Payment declined handling (CARD_DECLINED, INSUFFICIENT_FUNDS, generic errors)
- Payment decline logging for debugging
- Refund idempotency key generation
- Refund eligibility checks (completed + non-refunded only)
- Refund marking and audit trail
- Square refund API failure handling
- Subscription cancellation after refund

---

### P2-3: Webhook Signature Verification Tests
**File**: `__tests__/security/webhook-signature.test.js` (332 lines)
**Status**: COMPLETE (2026-01-26 review)

**All required tests exist**:
- HMAC-SHA256 signature validation
- Rejects invalid signature
- Rejects tampered payload
- Signature sensitive to URL changes (prevents host injection)
- Signature sensitive to key changes
- Production/development mode handling
- Duplicate event detection (idempotency)
- Merchant isolation
- Security edge cases (missing header, empty header, malformed JSON, large payloads)

---

### P2-4: Authentication Edge Case Tests
**Files**:
- `__tests__/middleware/auth.test.js` (584 lines)
- `__tests__/routes/auth.test.js` (47 tests)
**Status**: COMPLETE (implementation gaps closed by P0-5 and P0-6)

**Tests that exist**:
- requireAuth, requireAuthApi, requireAdmin, requireRole
- requireWriteAccess, optionalAuth, getCurrentUser
- getClientIp (x-forwarded-for, x-real-ip, etc.)
- Session with null/undefined user
- Missing role property
- Case-sensitive role matching
- Session expiry handling
- Session fixation attack prevention (P0-6 FIXED)
- Session ID regeneration on login (P0-6 FIXED)
- Secure session cookie configuration
- Session does not contain sensitive data
- Complete session destruction on logout (P0-5 FIXED)
- Account lockout after failed attempts
- User enumeration prevention

Note: Login rate limiting tested in `security.test.js`

---

### P2-5: OAuth Token Refresh Tests
**File**: `__tests__/security/oauth-csrf.test.js` (41 tests)
**Status**: COMPLETE (2026-01-26)

**All required tests exist**:
- State parameter generation (256 bits entropy)
- State storage with expiry (10 minutes)
- State validation (expired, used, unknown)
- CSRF attack prevention (state tied to user)
- Token encryption before storage
- Tokens not logged in plain text
- OAuth configuration validation
- Proactive token refresh (within 1 hour of expiry)
- Token refresh storage and logging
- Missing refresh token handling
- Square API refresh error handling
- Expired refresh token requiring re-authorization
- Network error handling during refresh
- Authentication error non-retry logic
- Merchant deactivation on permanent refresh failure
- oauth.authorization.revoked webhook handling
- Revocation logging and token clearing
- 401 response for revoked tokens
- Re-authorization flow after revocation

---

### P2-6: Rate Limiter Effectiveness Tests
**File**: `__tests__/middleware/security.test.js` (504 lines)
**Status**: COMPLETE (2026-01-26 review)

**All required tests exist**:
- General rate limit (100/15min default)
- Login rate limit (5/15min)
- Delivery rate limit (30/min)
- Sensitive operation rate limit (5/hour)
- 429 status with RATE_LIMITED code
- Key generation (user ID, IP, merchant ID)
- Health check endpoint skip
- Environment variable overrides
- Logging rate limit violations
- CORS configuration
- Helmet security headers (CSP, clickjacking, HSTS)

---

## API Optimization: Comprehensive Plan

**Status**: COMPLETE (2026-01-27)
**Priority**: CRITICAL - Rate limiting causing service interruptions
**Full Implementation Plan**: See `docs/archive/API_OPTIMIZATION_PLAN.md`

### Executive Summary

**All API optimizations complete!** Rate limit lockouts should be eliminated.

| Issue | API Calls Saved/Day | Status |
|-------|---------------------|--------|
| P0-API-1: Redundant order fetch | ~20 | Fixed (2026-01-27) |
| P0-API-2: Full 91-day sync per order | ~740 | Fixed (2026-01-27) |
| P0-API-3: Fulfillment also triggers 91-day sync | ~100 | Fixed (2026-01-27) |
| P0-API-4: Committed inventory per webhook | ~150 | Fixed (2026-01-27) |
| **TOTAL SAVED** | **~1,010/day** | |

**Result**: 90-95% reduction in webhook-triggered API calls

---

### P0-API-1: Remove Redundant Order Fetch

**File**: `services/webhook-handlers/order-handler.js:172-207`
**Status**: FIXED (2026-01-27)

**Problem**: Every order webhook re-fetched the order from Square API despite the webhook payload containing complete order data.

**Fix Applied**:
- Added `validateWebhookOrder()` to check webhook data completeness
- Only fetch from API as fallback if validation fails (should be extremely rare)
- Renamed `_fetchFullOrder` to `_fetchFullOrderFallback` with warning logs
- Added metrics tracking (directUse vs apiFallback) logged every 100 orders

**Impact**: ~20 API calls/day saved, ~100-200ms latency reduction per webhook

---

### P0-API-2: Incremental Velocity Update

**File**: `services/webhook-handlers/order-handler.js:202-219`, `services/square/api.js:1661-1808`
**Status**: FIXED (2026-01-27)

**Problem**: Every completed order triggered a full 91-day order sync (~37 API calls).

**Fix Applied**:
- Created `updateSalesVelocityFromOrder()` in `services/square/api.js`
- Updated order handler to use incremental update (0 API calls for order webhooks)
- Atomic upsert increments velocity records for 91d, 182d, 365d periods
- Daily smart sync provides reconciliation safety net

**Impact**: ~740 API calls/day saved, webhook processing 10-20x faster

---

### P0-API-3: Fulfillment Handler Also Triggers Full Sync

**File**: `services/webhook-handlers/order-handler.js:489-519`
**Status**: FIXED (2026-01-27)

**Problem**: Fulfillment webhooks also triggered full 91-day sync.

**Fix Applied**:
- Fulfillment handler now fetches only the single order (1 API call)
- Uses `updateSalesVelocityFromOrder()` for incremental update
- Saves ~36 API calls per fulfillment (1 vs 37)

**Impact**: ~100 API calls/day saved

---

### P0-API-4: Committed Inventory Sync Per Webhook

**File**: `services/webhook-handlers/order-handler.js:67-176`
**Status**: FIXED (2026-01-27)

**Problem**: Every order/fulfillment webhook triggered a full committed inventory sync.

**Fix Applied**:
- Added `debouncedSyncCommittedInventory()` function with 60-second debounce window
- Multiple webhooks within the window batch into a single sync
- Added metrics tracking (requested vs executed vs debounced)
- Stats logged every 50 executions showing savings rate

**Example**: 4 webhooks in 10 seconds → 1 sync instead of 4 syncs (~75% reduction)

**Impact**: ~150 API calls/day saved (varies by order volume)

---

### Additional Inefficiencies Identified

| Issue | File | Impact | Fix |
|-------|------|--------|-----|
| Payment webhook fetches order | `order-handler.js:593` | ~15 calls/day | Use cached order |
| Smart sync queries DB 10+ times | `routes/sync.js:144+` | ~168 queries/day | Batch lookup |
| Refund handler uses raw fetch | `order-handler.js:700` | Inconsistent | Use SDK |
| No sync coordination | Multiple handlers | Race conditions | SyncCoordinator |

---

### Order Cache Strategy (After Prerequisites)

**Table**: `order_cache`
```sql
CREATE TABLE order_cache (
    square_order_id TEXT NOT NULL,
    merchant_id INTEGER REFERENCES merchants(id),
    state TEXT NOT NULL,
    closed_at TIMESTAMPTZ,
    line_items JSONB NOT NULL,
    UNIQUE(square_order_id, merchant_id)
);
```

**Population**:
1. Webhook: Cache every order from webhooks
2. Initial: One-time 366-day backfill for new merchants
3. Reconciliation: Daily 2-day fetch to catch misses

**Usage**:
- Sales velocity: Query cache instead of Square API
- Committed inventory: Lookup cached orders by ID
- Loyalty: Use cached order data

---

### Daily Reconciliation (Safety Net)

```
Cron: 3 AM daily
1. Fetch orders from Square where closed_at >= NOW() - 2 days (1 API call)
2. For each order: update velocity incrementally
3. Log: { orders: 40, updated: 38, missed: 2, miss_rate: 5% }
```

Miss rate < 1% for 2+ weeks = webhooks proven reliable.

---

### Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| API calls/day | ~1,060 | <100 | Log `makeSquareRequest` |
| Rate limit incidents/week | 2-5 | 0 | Monitor 429 responses |
| Webhook processing time | 2-5s | <500ms | Log duration |
| Velocity accuracy | Baseline | ±1% | Compare with full sync |

---

## P3: Scalability Prep (OPTIONAL for Single Business)

These are only required if pursuing multi-merchant SaaS revenue.

### P3-1: In-Memory State Doesn't Scale
**File**: `services/sync-queue.js`
**Issue**: Sync state is in-memory + DB, but multiple instances will have different in-memory state
**Target**: TBD

**Fix for Scale**: Use Redis for shared state
```javascript
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

async function getSyncState(merchantId, syncType) {
    return redis.get(`sync:${merchantId}:${syncType}`);
}
```

### P3-2: Cron Jobs Run on Every Instance
**File**: `jobs/cron-scheduler.js`
**Issue**: Each server instance runs all cron jobs
**Target**: TBD

**Fix for Scale**: Use distributed job queue (Bull, Agenda)
```javascript
const Queue = require('bull');
const syncQueue = new Queue('sync', process.env.REDIS_URL);

// Only one worker processes each job
syncQueue.process(async (job) => {
    await runSmartSync(job.data.merchantId);
});
```

### P3-3: No Per-Tenant Rate Limiting for Square API
**Issue**: Square has rate limits (~30 req/sec). Multiple merchants will collide.
**Target**: TBD

**Fix for Scale**: Implement per-merchant request queue with backoff

### P3-4: Single Database Pool for All Tenants
**Issue**: 20 connections shared across all merchants
**Target**: TBD

**Fix for Scale**: Consider tenant-aware pooling or connection limits per merchant

---

## Backlog / Future Investigation

Items identified but not urgent. Return to these when time permits.

### BACKLOG-1: Frontend Polling Causing App-Level Rate Limits
**Identified**: 2026-01-28
**Priority**: Medium (not breaking, but inefficient)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: `delivery.html` makes 4 parallel API calls every 30 seconds via `setInterval`. This can exceed the 100 req/15min rate limit with a single user, worse with multiple tabs/users.

**Files**:
- `public/delivery.html:575-579` - 4 parallel fetch calls in `loadOrders()`
- `public/delivery.html:1030` - `setInterval(loadOrders, 30000)`
- `public/delivery-route.html:1446` - `setInterval(loadRoute, 60000)` + visibility/focus handlers

**Symptoms**:
- "Rate limit exceeded" warnings in logs
- Multiple "API request" + "GTIN enrichment" logs in rapid succession

**Recommended Fixes** (in order of effort):
1. **Quick**: Increase `RATE_LIMIT_MAX_REQUESTS` env var to 200+
2. **Better**: Reduce polling to 60-120 seconds, pause when tab hidden
3. **Best**: Consolidate 4 calls into single `/api/delivery/dashboard` endpoint

**Note**: GTIN enrichment itself is fine (DB-only, no Square API calls).

---

### BACKLOG-2: Delivery Routing System - Webhook Updates
**Identified**: 2026-01-28
**Priority**: Medium-High (needs investigation)
**Status**: COMPLETE (2026-02-12) — investigated, all systems working correctly
**Target**: N/A

**Investigation Results (2026-02-12)**:

Full code audit found the delivery routing webhook sync is production-ready:

| Component | Finding |
|-----------|---------|
| Webhook → delivery ingestion | `_processDeliveryRouting()` in order-handler.js correctly routes DRAFT/OPEN/COMPLETED orders |
| Deduplication | Working at both webhook level (event ID) and ingest level (`getOrderBySquareId` check) |
| Route state transitions | Wrapped in PostgreSQL transactions — no partial states possible |
| Order completion → Square sync | Uses Square version field + idempotency keys for optimistic concurrency |
| Race conditions (webhook vs UI) | None — webhook writes are atomic, UI polls every 60s |
| Customer data extraction | Handles both camelCase (SDK v43+) and snake_case with Square API fallback |
| Geocoding | Non-blocking, does not prevent order creation |

**Files reviewed**:
- `services/webhook-handlers/order-handler.js` — `_processDeliveryRouting()`, `_ingestDeliveryOrder()`
- `services/delivery/delivery-service.js` — `ingestSquareOrder()`, `generateRoute()`
- `routes/delivery.js` — order completion with multi-step Square fulfillment sync
- `services/webhook-processor.js` — event-level deduplication
- `__tests__/routes/delivery-completion.test.js` — test coverage exists

**Conclusion**: No fix needed. The original concern was logged as "needs investigation" — investigation confirms all components are working correctly with proper atomicity, idempotency, and concurrency control.

---

### BACKLOG-3: Response Format Inconsistency
**Identified**: 2026-01-29
**Priority**: Low (causes frontend bugs, but workarounds exist)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: Response formats are inconsistent across routes. Some use `{success, data: {...}}`, others return data directly. This causes silent frontend bugs when accessing response properties.

**Recommended Fix**:
1. Choose one format (recommend: direct data for GETs, wrapped for mutations)
2. Add migration to standardize existing endpoints
3. Update frontend code to match

See [EVENT_DELEGATION.md - API Response Data Wrapper Mismatch](./archive/EVENT_DELEGATION.md#6-api-response-data-wrapper-mismatch) for debugging guidance.

---

### BACKLOG-4: Customer Birthday Sync for Targeted Marketing
**Identified**: 2026-01-30
**Priority**: Medium (feature enhancement)
**Status**: Investigation complete, ready to implement
**Target**: TBD

**Use Case**: Add customers with birthdays to Square Customer Groups for targeted marketing (e.g., birthday month promotions).

#### Current State (Investigation Summary)

| Component | Status | Location |
|-----------|--------|----------|
| `loyalty_customers` table | ✅ Exists | `database/schema.sql` |
| `birthday` column | ✅ Added | `database/migrations/032_seniors_day.sql` |
| `customer.created/updated` webhook | ✅ Exists | `services/webhook-handlers/customer-handler.js` |
| `cacheCustomerDetails()` | ✅ Exists | `services/loyalty-admin/customer-cache-service.js` |
| Customer group CRUD | ✅ Exists | `services/loyalty-admin/square-discount-service.js` |
| Bulk customer sync cron | ❌ Not needed | Only capture on change |

**Square Customer Object** (birthday field):
```javascript
{
  id: "CUSTOMER_ID",
  given_name: "John",
  family_name: "Doe",
  birthday: "1990-05-15",  // YYYY-MM-DD format
  // ... other fields
}
```

#### Implementation Plan

**1. Migration** (`database/migrations/0XX_add_customer_birthday.sql`):
```sql
ALTER TABLE loyalty_customers ADD COLUMN birthday DATE;
CREATE INDEX idx_loyalty_customers_birthday
  ON loyalty_customers(merchant_id, birthday);
```

**2. Extend `cacheCustomerDetails()`** (`services/loyalty-admin/customer-cache-service.js`):
- Add `birthday` to INSERT columns and ON CONFLICT UPDATE
- Extract from Square customer object

**3. Modify `customer.updated` handler** (`services/webhook-handlers/catalog-handler.js:88-147`):
- Fetch full customer record from Square API
- Call `cacheCustomerDetails()` to persist birthday
- Only triggers when customer is updated in Square (no bulk sync needed)

**4. Birthday group management** (future):
- Use existing `addCustomerToGroup()` / `removeCustomerFromGroup()`
- Create cron job to check birthdays and manage group membership

#### Files to Modify

| File | Change |
|------|--------|
| `database/migrations/032_seniors_day.sql` | ✅ Done - birthday column + index added |
| `services/loyalty-admin/customer-cache-service.js` | Update `cacheCustomerDetails()` |
| `services/webhook-handlers/catalog-handler.js` | Fetch customer, cache birthday |

#### Existing Code to Leverage

| Function | Location | Purpose |
|----------|----------|---------|
| `cacheCustomerDetails()` | `services/loyalty-admin/customer-cache-service.js` | Upsert customer to cache |
| `getCustomerDetails()` | `services/loyalty-admin/customer-admin-service.js` | Fetch from Square API |
| `addCustomerToGroup()` | `services/loyalty-admin/square-discount-service.js` | Add customer to group |
| `removeCustomerFromGroup()` | `services/loyalty-admin/square-discount-service.js` | Remove from group |
| `handleCustomerChange()` | `services/webhook-handlers/customer-handler.js` | Webhook handler (handles both `customer.created` and `customer.updated`) |

#### Known Gap: Birthday Removal Ignored

COALESCE in `cacheCustomerDetails()` preserves old birthday when null is received — intentional removal from Square is ignored. Fix requires changes across cache, seniors service, and cron sweep.

---

### BACKLOG-5: Rapid-Fire Webhook Duplicate Processing
**Identified**: 2026-02-01
**Priority**: Low (impact reduced by loyalty_processed_orders fix)
**Status**: Documented, partially mitigated
**Target**: TBD

**Problem**: Same order processed 6+ times in seconds from rapid-fire Square webhooks. The webhook deduplication guard in `services/webhook-processor.js` uses event IDs but doesn't prevent the same *order* from being processed multiple times through the loyalty path when multiple events reference the same order.

**Evidence from production logs (2026-02-01)**:
- Order `K6q28eqJStewbShHVggjfvf5A66YY` processed 6 times at 10:42
- Order `66Sqzx1VGyzYjLHesx4Wtv9I0haZY` processed 7 times at 10:51

**Root Cause**: The webhook processor deduplicates by `event_id` but loyalty processing happens per order. When Square sends multiple webhook events for the same order (e.g., order.updated, order.completed in rapid succession), each event triggers full loyalty processing.

**Current Mitigation** (2026-02-01):
- Added `loyalty_processed_orders` table that tracks all processed orders
- The `ON CONFLICT DO NOTHING` in `recordProcessedOrder()` handles duplicate attempts gracefully
- Non-qualifying orders now recorded, so catchup job won't reprocess them
- Qualifying orders have idempotency via `loyalty_purchase_events` unique constraint

**Impact After Mitigation**:
- First webhook processes the order fully
- Subsequent webhooks detect order already processed via `loyalty_processed_orders`
- No duplicate purchases recorded (idempotency key prevents it)
- Wasted compute processing the same order multiple times, but no data corruption

**Full Fix (Future)**:
Add order-level deduplication to the webhook processor before dispatching to handlers:

```javascript
// In services/webhook-processor.js, before loyalty handler
const orderCacheKey = `order:${orderId}:loyalty`;
const alreadyProcessing = await redis.get(orderCacheKey);
if (alreadyProcessing) {
    logger.debug('Order already being processed for loyalty', { orderId });
    return { skipped: true, reason: 'duplicate_order' };
}
await redis.set(orderCacheKey, '1', 'EX', 60); // 60 second lock
```

**Files involved**:
- `services/webhook-processor.js` - Event-level dedup (works correctly)
- `services/webhook-handlers/order-handler.js` - Order handler
- `services/loyalty/webhook-service.js` - Loyalty processing

---

### BACKLOG-9: In-Memory Global State — PM2 Restart Recovery
**Identified**: 2026-02-11 (from CODE_AUDIT_REPORT HIGH-4)
**Priority**: Low (single instance), High (pre-franchise)
**Status**: Comprehensive investigation complete (2026-02-12)
**Target**: TBD

> **Note**: Previous audit (2026-02-11) referenced `pendingCommittedSyncs` and `committedSyncStats`
> which were removed when BACKLOG-10 (invoice-driven committed inventory) was completed.
> This updated inventory reflects the current codebase.

#### Complete In-Memory State Inventory

**12 stateful items found across 8 files. 0 data corruption risks. 0 HIGH-risk items requiring immediate fix.**

| # | State | File:Line | What It Stores | Populated | Persisted? | Lost on Restart? | Risk |
|---|-------|-----------|---------------|-----------|-----------|-----------------|------|
| 1 | `catalogInProgress` Map | `services/sync-queue.js:29` | Merchants with active catalog sync | During sync | Yes (sync_history) | Restored on startup | **LOW** |
| 2 | `catalogPending` Map | `services/sync-queue.js:30` | Merchants needing follow-up catalog sync | Webhook during active sync | No | Yes | **MEDIUM** |
| 3 | `inventoryInProgress` Map | `services/sync-queue.js:33` | Merchants with active inventory sync | During sync | Yes (sync_history) | Restored on startup | **LOW** |
| 4 | `inventoryPending` Map | `services/sync-queue.js:34` | Merchants needing follow-up inventory sync | Webhook during active sync | No | Yes | **MEDIUM** |
| 5 | `clientCache` Map | `middleware/merchant.js:19` | Authenticated Square SDK clients per merchant | On first request | No (5-min TTL cache) | Yes — recreated on demand | **LOW** |
| 6 | `merchantsWithoutInvoicesScope` Map | `services/square/api.js:35` | Merchants lacking INVOICES_READ scope | On API call failure | No (1-hour TTL cache) | Yes — re-detected on next call | **LOW** |
| 7 | `traceStore` Map | `services/loyalty/loyalty-tracer.js:146` | Active trace contexts for debugging | During order processing | No | Yes — in-flight traces lost | **LOW** |
| 8 | `webhookOrderStats` Object | `services/webhook-handlers/order-handler.js:104` | Direct-use vs API-fallback counters | On each order webhook | No | Yes — metrics reset | **LOW** |
| 9 | `upsertProductState` Object | `services/gmc/merchant-service.js:253` | GMC product sync debug counters | During GMC sync cycle | No | Yes — reset each cycle anyway | **LOW** |
| 10 | `localInventoryState` Object | `services/gmc/merchant-service.js:666` | GMC local inventory debug counters | During GMC sync cycle | No | Yes — reset each cycle anyway | **LOW** |
| 11 | Rate limiter stores (7 instances) | `middleware/security.js:80-285` | Request counts per IP/user/key | On each request | No (in-memory MemoryStore) | Yes — all counters reset | **MEDIUM** |
| 12 | `lastErrorEmail` timestamp | `utils/email-notifier.js:8` | Last critical alert email time | On email send | No | Yes — throttle resets | **LOW** |

#### Items NOT In-Memory State (Confirmed Safe)

| Item | File | Why Safe |
|------|------|----------|
| Session data | `server.js:149` | PostgreSQL-backed via `PgSession` — survives restart |
| Webhook events | `webhook-processor.js` | Stateless class — all state in `webhook_events` DB table |
| Cron job tasks | `jobs/cron-scheduler.js:27` | References lost but re-initialized on startup |
| DB pool | `utils/database.js:14` | New pool created on startup — connections are transient |
| `isShuttingDown` / `activeQueries` | `utils/database.js:10-11` | Shutdown-only state — irrelevant after restart |
| Lazy module refs (`let x = null`) | 4 files | Circular dependency avoidance — re-required on first use |
| `developmentSecret` | `server.js:167` | Only in dev mode; production requires SESSION_SECRET env var |
| `httpServer` / `cronTasks` | `server.js:21-22` | Recreated on startup |
| `tracerInstances` WeakMap | `services/loyalty/loyalty-tracer.js:19` | WeakMap — GC'd with keys, no accumulation |

#### Existing Startup Recovery (Already Working)

The application already has robust recovery for most scenarios:

| Recovery Mechanism | File | What It Does |
|-------------------|------|-------------|
| Stale sync cleanup | `services/sync-queue.js:52-60` | Marks syncs "running" > 30 min as "interrupted" |
| In-progress restoration | `services/sync-queue.js:70-92` | Restores recent running syncs from sync_history table |
| Smart sync on stale data | `server.js:894-978` | Detects stale data per merchant and runs sync on startup |
| Cycle count batch check | `jobs/cycle-count-job.js:95-154` | Generates today's batch if missed |
| Seniors rule verification | `jobs/seniors-day-job.js:275-340` | Auto-corrects pricing rule state after missed schedule |
| Webhook retry processor | `jobs/webhook-retry-job.js` | Retries failed webhooks every minute (exponential backoff, max 5) |
| Committed inventory reconciliation | `jobs/committed-inventory-reconciliation-job.js` | Daily 4 AM full rebuild from Square Invoice API |
| Loyalty catchup job | `jobs/loyalty-catchup-job.js` | Hourly — catches orders missed by webhook race conditions |
| Graceful shutdown | `server.js:1000-1058` | Drains active syncs (30s timeout), closes DB pool cleanly |
| Schema initialization | `utils/database.js:265+` | Ensures all tables/columns exist on every startup |

#### Gap Analysis

**MEDIUM risk — No recovery, but self-healing:**

1. **Sync queue pending state** (`catalogPending`, `inventoryPending`):
   - **Gap**: If a webhook arrives during an active sync and the server restarts before the follow-up sync runs, that pending sync is lost.
   - **Mitigation already in place**: Smart sync cron runs hourly and catches stale data. Webhook retry processor re-sends failed events. The window of exposure is at most ~1 hour.
   - **Data corruption risk**: None. Worst case is a delayed sync.

2. **Rate limiter stores** (7 instances in `middleware/security.js`):
   - **Gap**: All rate limit counters reset to zero on restart. Brief window where limits are unenforced.
   - **Mitigation already in place**: PM2 restarts are infrequent (deploy or crash). Rate limit windows are short (1-15 min for most). The actual risk in the current threat model (single-tenant, Cloudflare-protected) is minimal.
   - **Data corruption risk**: None. Security-only concern.

**LOW risk — Acceptable loss:**

3. **Square client cache** — Recreated transparently on next request. No thundering herd risk for single-tenant (1 merchant at a time).
4. **Invoices scope cache** — Re-detected on next API call. Extra API call, but within rate limits.
5. **Trace store** — Debug-only. In-flight traces logged up to point of crash.
6. **Webhook order stats** — Informational metrics. No business impact.
7. **GMC debug counters** — Reset each sync cycle anyway.
8. **Email throttle** — Worst case: one duplicate alert email after restart.

#### Recommendations

**No immediate action required.** All gaps are covered by existing recovery mechanisms or self-heal within acceptable windows. No data corruption risks found.

**If implementing improvements (ordered by value):**

| Priority | Fix | Complexity | Benefit |
|----------|-----|-----------|---------|
| 1 | **SIGTERM handler**: Flush `webhookOrderStats` to log on graceful shutdown | Low (10 lines) | Metrics not silently lost |
| 2 | **Design decision comments**: Document why in-memory pending state is acceptable in `sync-queue.js` | Low (5 lines) | Future developer clarity |
| 3 | **Startup pending sync**: After restart, set `catalogPending`/`inventoryPending` = true for all active merchants to force one catch-up sync | Low (15 lines) | Eliminates the 1-hour window for missed pending syncs |
| 4 | **Rate limiter persistence**: Move security-critical rate limiters (login, password reset) to PostgreSQL-backed store | Medium (50 lines) | Survives restart; required pre-franchise |

**Pre-franchise (P3 scope, not needed now):**
- Move all rate limiters to shared store (Redis or PostgreSQL)
- Move sync queue state to PostgreSQL advisory locks (see P3-1)
- Add cross-instance cron coordination (see P3-2)

**Audit date**: 2026-02-12

---

### ~~BACKLOG-10: Invoice-Driven Committed Inventory (Replace Order-Triggered Full Resync)~~ COMPLETE
**Identified**: 2026-02-11
**Priority**: ~~High~~ Complete
**Status**: **COMPLETE** (2026-02-19) — All 6 phases implemented
**Target**: N/A

**Problem**: Every `order.created`, `order.updated`, and `order.fulfillment.updated` webhook triggers `syncCommittedInventory()`, which:
1. **DELETEs** all `RESERVED_FOR_SALE` rows for the merchant
2. **Searches** all invoices via Square API (paginated, `POST /v2/invoices/search`)
3. For each open invoice: **GETs** full invoice (1 API call) + **GETs** linked order (1 API call) for line items
4. Rebuilds `RESERVED_FOR_SALE` from scratch

With 5 open invoices = **~11 API calls per sync**. The 60-second debounce (P0-API-4) batches rapid webhooks, but a customer buying dog food at the register has zero bearing on which invoices are open — every order webhook wastes API calls on a full invoice resync.

**Root cause**: Committed inventory is triggered by order webhooks instead of invoice lifecycle events.

**Planned fix — 6 phases**:

**Phase 1: Subscribe to invoice webhooks** (`utils/square-webhooks.js`)
Add to `WEBHOOK_EVENT_TYPES.essential`:
- `invoice.created` — new commitment
- `invoice.updated` — line items or status changed
- `invoice.published` — DRAFT becomes active
- `invoice.canceled` — remove commitment
- `invoice.deleted` — remove commitment (DRAFT only)
- `invoice.refunded` — partial/full refund adjustments
- `invoice.scheduled_charge_failed` — charge failed, commitment stays, alert merchant

Also add `customer.created` to `WEBHOOK_EVENT_TYPES.loyalty` (closes loyalty tracking gap — see BACKLOG-11).

**Phase 2: Create invoice webhook handlers** (`services/webhook-handlers/inventory-handler.js`)
- `handleInvoiceChanged(ctx)` — for `invoice.created`, `invoice.updated`, `invoice.published`
  - Extract `order_id` from webhook payload
  - If status in `[DRAFT, UNPAID, SCHEDULED, PARTIALLY_PAID]`: fetch order (1 API call) for line items, upsert committed quantities
  - If terminal status (`PAID`, `CANCELED`, `REFUNDED`): remove committed quantities for that invoice
- `handleInvoiceClosed(ctx)` — for `invoice.canceled`, `invoice.deleted`
  - Remove committed quantities for that invoice (0 API calls)
- `handleInvoicePaymentMade(ctx)` — for `invoice.payment_made`
  - Check if fully paid → remove commitment (0 API calls)

**Phase 3: Per-invoice tracking table** (`database/migrations/0XX_committed_inventory.sql`)
```sql
CREATE TABLE committed_inventory (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    square_invoice_id TEXT NOT NULL,
    square_order_id TEXT NOT NULL,
    catalog_object_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    invoice_status TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(merchant_id, square_invoice_id, catalog_object_id, location_id)
);
CREATE INDEX idx_committed_inv_merchant ON committed_inventory(merchant_id);
```

After any `committed_inventory` change, rebuild `RESERVED_FOR_SALE` aggregates from local DB (zero API calls):
```sql
DELETE FROM inventory_counts WHERE state = 'RESERVED_FOR_SALE' AND merchant_id = $1;
INSERT INTO inventory_counts (catalog_object_id, location_id, state, quantity, merchant_id)
SELECT catalog_object_id, location_id, 'RESERVED_FOR_SALE', SUM(quantity), merchant_id
FROM committed_inventory
WHERE merchant_id = $1 AND invoice_status IN ('DRAFT','UNPAID','SCHEDULED','PARTIALLY_PAID')
GROUP BY catalog_object_id, location_id, merchant_id;
```

**Phase 4: Remove order webhook trigger** (`services/webhook-handlers/order-handler.js`)
- Remove `debouncedSyncCommittedInventory(merchantId)` calls from `handleOrderCreatedOrUpdated()` and `handleFulfillmentUpdated()`
- Committed inventory now entirely invoice-webhook-driven

**Phase 5: Daily reconciliation safety net** (`jobs/`)
- Keep `syncCommittedInventory()` as daily cron (e.g., 4 AM)
- Catches `FAILED` status (Square sends no webhook for this transition)
- Catches any missed webhooks
- 11 API calls once/day instead of every minute during business hours

**Phase 6: Wire up handler registry** (`services/webhook-handlers/index.js`)
- Register new invoice events → inventory handler methods
- Update `invoice.payment_made` to call both subscription handler AND inventory handler

**API call impact**:

| Scenario | Current | After |
|----------|---------|-------|
| Regular order webhook (~20/day) | 11 calls per debounce fire | **0 calls** |
| Invoice created (few/week) | N/A | **1 call** (fetch order) |
| Invoice paid/canceled | N/A | **0 calls** (local DB) |
| Daily reconciliation | N/A | **~11 calls** (safety net) |
| **Daily total (typical)** | **~100-200 calls** | **~12-15 calls** |

**Edge cases**:

| Edge Case | Handled By |
|-----------|------------|
| Invoice → `FAILED` (no webhook) | Daily reconciliation |
| Line items modified after creation | `invoice.updated` webhook |
| Multiple invoices for same variation | Per-invoice tracking, aggregate SUM |
| Webhook missed | Daily reconciliation |
| First deploy (empty committed_inventory) | Run `syncCommittedInventory()` once to seed |

**Files to modify**:

| File | Change |
|------|--------|
| `database/migrations/0XX_committed_inventory.sql` | New table |
| `utils/square-webhooks.js` | Add 7 invoice event types + `customer.created` |
| `services/webhook-handlers/index.js` | Register invoice → inventory handlers |
| `services/webhook-handlers/inventory-handler.js` | New invoice handler methods |
| `services/webhook-handlers/order-handler.js` | Remove `debouncedSyncCommittedInventory()` calls |
| `jobs/cron-scheduler.js` | Add daily committed inventory reconciliation |

**Relationship to BACKLOG-9**: Once implemented, BACKLOG-9's `pendingCommittedSyncs` debounce Map becomes obsolete — the in-memory timer problem goes away entirely because order webhooks no longer trigger committed inventory sync.

**Audit date**: 2026-02-11

---

### ~~BACKLOG-11: Subscribe to `customer.created` Webhook (Loyalty Gap)~~ COMPLETE
**Identified**: 2026-02-11
**Priority**: ~~Medium~~ Complete
**Status**: **COMPLETE** (2026-02-19) — `customer.created` wired to `customer-handler.js:handleCustomerChange()` in webhook-handlers/index.js
**Target**: N/A

**Problem**: The app subscribes to `customer.updated` and `customer.deleted` but NOT `customer.created`. When a new customer is created and immediately places an order, the loyalty catchup logic that runs on `customer.updated` never fires for that first interaction. The customer's first order may not be attributed until a subsequent update event.

**Fix**: Add `customer.created` to `WEBHOOK_EVENT_TYPES.loyalty` in `utils/square-webhooks.js` and wire to the existing `catalogHandler.handleCustomerUpdated(ctx)` handler (same catchup logic applies).

**Files to modify**:
- `utils/square-webhooks.js` — add `customer.created` to loyalty array
- `services/webhook-handlers/index.js` — add `'customer.created': (ctx) => catalogHandler.handleCustomerUpdated(ctx)`

**Audit date**: 2026-02-11

---

### BACKLOG-12: Driver Share Link Validation Failure
**Identified**: 2026-02-12
**Priority**: Low (intermittent issue)
**Status**: Not investigated yet
**Target**: TBD

**Problem**: Validation fails when generating or accessing driver delivery share links. Root cause unknown — reported as intermittent. Needs investigation of the share link generation flow in the delivery routing system for input validation errors.

**Areas to investigate**:
- Share link generation endpoint and URL construction
- Input validation on share link parameters (delivery ID, route ID, token)
- Whether expired or invalid tokens cause the validation failure
- Edge cases: missing delivery data, incomplete route, unassigned driver

**Files likely involved**:
- `routes/delivery.js` — share link generation and access endpoints
- `middleware/validators/` — delivery-related validators
- `services/delivery/delivery-service.js` — underlying delivery data lookups

**Audit date**: 2026-02-12

### BACKLOG-13: Custom Attribute Initialization on Startup

**Identified**: 2026-02-12
**Priority**: Medium (performance, franchise-blocking)
**Status**: Not started
**Target**: Pre-franchise deployment

**Problem**: Custom attribute initialization runs on every server startup, making 12 Square API calls to update attributes that already exist. These are `ensureCustomAttribute()` / `upsertCustomAttribute()` calls that check-and-create attributes like `expiration_date`, `cost_price`, `vendor_name`, etc. For a single store this adds ~3-5 seconds to boot time. For franchise deployment (N tenants), this becomes 12 × N API calls on every PM2 restart.

**Areas to investigate**:
- `server.js` or startup initialization code that calls custom attribute setup
- `services/square/api.js` — likely where `ensureCustomAttribute()` lives
- Whether attributes can be checked once and cached, or moved to onboarding flow

**Proposed solution**:
- Move custom attribute initialization to tenant onboarding (first-time setup)
- On startup, skip if attributes already exist (check DB flag or cache)
- Fall back to lazy initialization on first use if needed
- Remove the per-boot API calls entirely for existing tenants

**Impact**: Currently acceptable for single-store. Required before franchise deployment — 12 calls × tenant count per restart is unsustainable.

**Audit date**: 2026-02-12

---

### ~~BACKLOG-14: Reorder Formula Duplication (DEDUP-AUDIT R-1)~~ COMPLETE

**Identified**: 2026-02-15
**Priority**: ~~Medium~~ Complete
**Status**: **COMPLETE** (2026-02-17) — Shared `services/catalog/reorder-math.js`, 31 tests. All 3 divergences resolved.
**Target**: N/A

**Problem**: The reorder quantity calculation exists in two places:
- `routes/analytics.js` — JS post-processing (lines ~378-423)
- `services/vendor-dashboard.js` — SQL LATERAL subquery (lines ~92, 215-255)

**Active Divergences** (discovered 2026-02-17 deduplication audit):

| # | Component | `analytics.js` | `vendor-dashboard.js` | Impact |
|---|-----------|----------------|----------------------|--------|
| 1 | **Reorder threshold** | `supplyDays + safetyDays` (no lead time) | `defaultSupplyDays + safetyDays + lead_time_days` | Vendor dashboard orders more than reorder page for items with lead time |
| 2 | **Reorder multiple** | Applied (rounds up to nearest multiple) | **Not applied** | Vendor dashboard may suggest non-case-pack-aligned quantities |
| 3 | **stock_alert_min** | Enforced as floor (`Math.max(qty, stock_alert_min)`) | **Not enforced** | Vendor dashboard may suggest below-minimum quantities |

**Decision needed**: Which behavior is correct for each divergence? Options:
1. analytics.js is correct → update vendor-dashboard.js SQL
2. vendor-dashboard.js is correct → update analytics.js JS
3. Both are intentionally different (different use cases) → document why

**Consolidation options:**
- SQL function (`CREATE FUNCTION calc_reorder_qty`) called by both
- Shared JS service both routes call (fetch raw data, compute in JS)

**Files involved**:
- `routes/analytics.js:378-423` — JS calculation with reorder_multiple and stock_alert_min
- `services/vendor-dashboard.js:92,215-255` — SQL calculation with lead_time_days

**Audit date**: 2026-02-17 (updated from 2026-02-15)

---

### ~~BACKLOG-15: Reward Progress / Threshold Crossing Duplication (DEDUP-AUDIT L-2)~~ **COMPLETE**

**Identified**: 2026-02-17
**Completed**: 2026-02-17
**Priority**: Medium (different algorithms for same business logic)
**Status**: **FIXED** — Split-row rollover logic ported to admin layer

**Fix**: Replaced the admin layer's `LIMIT`-based locking with split-row logic from the loyalty layer. The admin layer (`services/loyalty-admin/purchase-service.js`) now splits crossing rows into locked + unlocked child records, preserves rollover units for the next reward cycle, and handles multi-threshold scenarios. All existing post-threshold actions (audit, Square discount, customer summary) preserved. 8 new unit tests.

**Files changed**:
- `services/loyalty-admin/purchase-service.js` — split-row locking, NOT EXISTS filter
- `__tests__/services/loyalty-admin/purchase-split-row.test.js` — 8 new tests

---

### ~~BACKLOG-16: redeemReward() Name Collision (DEDUP-AUDIT L-3)~~ **COMPLETE**

**Identified**: 2026-02-17
**Priority**: Medium (same name, different signatures and behavior)
**Status**: **COMPLETE** (2026-02-17)

**Fix applied**: Deleted dead `redeemReward()` and `expireRewards()` from `services/loyalty/reward-service.js`. Both had zero production callers — the admin layer versions handle all reward state mutations with full audit logging and Square cleanup. Loyalty layer is now read-only (queries and statistics only). 9 tests removed (6 redeemReward + 3 expireRewards).

**Audit date**: 2026-02-17

---

### BACKLOG-17: Customer Lookup Helpers Duplicated Between Layers (DEDUP-AUDIT L-4)

**Identified**: 2026-02-17
**Priority**: Low (partially mitigated by L-1 fix)
**Status**: Documented, partially mitigated
**Target**: TBD

**Problem**: Three customer lookup functions exist as both class methods in `services/loyalty/customer-service.js` and standalone exports in `services/loyalty-admin/customer-admin-service.js`: Loyalty API lookup, fulfillment recipient lookup, and order rewards lookup. The L-1 fix consolidated webhook-processing-service.js to delegate to the class-based version, but the standalone exports in customer-admin-service.js still exist independently.

**Risk**: Bug fixes or Square API changes applied to one set but not the other.

**Suggested fix**: Have admin-layer standalone functions delegate to the class methods (or vice versa).

**Effort**: M — Straightforward refactor with clear function boundaries.

**Files involved**:
- `services/loyalty/customer-service.js:195-274, 280-361, 367-495`
- `services/loyalty-admin/customer-admin-service.js:110-214, 222-334, 342-413`

**Audit date**: 2026-02-17

---

### ~~BACKLOG-18: Offer/Variation Query Overlap (DEDUP-AUDIT L-5)~~ COMPLETE

**Identified**: 2026-02-17
**Priority**: ~~Low~~ Complete
**Status**: **COMPLETE** (2026-02-19) — Shared `loyalty-queries.js`, fixed 3 missing `is_active` filters
**Target**: N/A

**Problem**: Offer and variation lookup queries exist in both `services/loyalty/offer-service.js` (6 functions) and `services/loyalty-admin/variation-admin-service.js` + `offer-admin-service.js` (5 functions) with similar-but-not-identical SQL (different join conditions, active filters).

**Risk**: SQL differences could cause webhook to qualify a variation the admin UI shows as non-qualifying, or vice versa.

**Suggested fix**: Create shared `loyalty-queries.js` with canonical SQL for offer/variation lookups. Admin-specific queries (CRUD, conflict checks) stay in admin services.

**Effort**: S — Simple SELECT extraction with minimal risk.

**Files involved**:
- `services/loyalty/offer-service.js:30-212`
- `services/loyalty-admin/variation-admin-service.js:164-275`
- `services/loyalty-admin/offer-admin-service.js:110-170`

**Audit date**: 2026-02-17

---

### ~~BACKLOG-19: Dual Square API Client Layers (DEDUP-AUDIT L-6)~~ COMPLETE

**Identified**: 2026-02-17
**Priority**: ~~Low~~ Complete
**Status**: **COMPLETE** (2026-02-19) — Unified `square-api-client.js`, 429 retry ported to admin layer
**Target**: N/A

**Problem**: The loyalty layer has a custom `LoyaltySquareClient` (`services/loyalty/square-client.js:50-496`) with built-in rate-limit retry logic. The admin layer uses `fetchWithTimeout()` + `getSquareAccessToken()` from `services/loyalty-admin/shared-utils.js` or `getSquareClientForMerchant()` from middleware. Rate-limit handling, retry logic, and timeout behavior differ between clients.

**Risk**: If Square changes rate limits, only one client may handle it correctly.

**Suggested fix**: Evaluate whether the custom client's retry adds value over SDK defaults. If so, make it shared. If not, remove it.

**Effort**: M — Requires testing all Square API interactions after migration.

**Files involved**:
- `services/loyalty/square-client.js:50-496`
- `services/loyalty-admin/shared-utils.js:20-66`
- `middleware/merchant.js`

**Audit date**: 2026-02-17

---

### ~~BACKLOG-20: Redemption Detection Asymmetry (DEDUP-AUDIT L-7)~~ COMPLETE

**Identified**: 2026-02-17
**Priority**: ~~Low~~ Complete
**Status**: **COMPLETE** (2026-02-19) — Audit job calls `detectRewardRedemptionFromOrder()` with `dryRun: true`
**Target**: N/A

**Problem**: Full redemption detection logic exists only in admin layer (`services/loyalty-admin/reward-service.js:469-666` with 2 matching methods). The audit job (`jobs/loyalty-audit-job.js:152-178`) has a simplified `orderHasOurDiscount()` that could produce false positives/negatives if detection rules evolve.

**Suggested fix**: If audit job detection needs to evolve, have it call `detectRewardRedemptionFromOrder()` from admin layer instead of its own simplified version.

**Effort**: S — Single call-site change.

**Files involved**:
- `services/loyalty-admin/reward-service.js:469-666`
- `jobs/loyalty-audit-job.js:152-178`

**Audit date**: 2026-02-17

---

### BACKLOG-21: Days-of-Stock Calculation — 5 Implementations (DEDUP-AUDIT R-2)

**Identified**: 2026-02-17
**Priority**: Low (confusing UX but no data corruption)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: "How many days of inventory remain" is calculated in 5 files with variations: `routes/analytics.js` (available qty), `services/vendor-dashboard.js` (available qty), `services/catalog/inventory-service.js` (total on-hand), `services/catalog/audit-service.js` (CTE variable), `routes/bundles.js` + `public/js/reorder.js` (bundle-driven velocity). Different base values (available vs total) mean different pages show different days-of-stock for the same item.

**Suggested fix**: Create SQL VIEW `v_days_of_stock` standardizing on available quantity (`on_hand - committed`). Bundle-specific calculations extend the base.

**Effort**: M — Decide canonical formula and update 5 files.

**Files involved**:
- `routes/analytics.js:218-224`
- `services/vendor-dashboard.js:142-176`
- `services/catalog/inventory-service.js:58-64`
- `services/catalog/audit-service.js:116-121`
- `routes/bundles.js:232-234, 261-263`

**Audit date**: 2026-02-17

---

### BACKLOG-22: Available vs Total Stock Inconsistency (DEDUP-AUDIT R-3)

**Identified**: 2026-02-17
**Priority**: Medium (merchant sees conflicting numbers across pages)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: Reorder and vendor dashboard use `on_hand - committed` (available) for days-of-stock, while inventory-service and audit-service use raw `on_hand` (total). A merchant with 10 on hand and 8 committed sees different days-of-stock on different pages.

**Suggested fix**: Standardize on available quantity (`on_hand - committed`) for all days-of-stock calculations. Update inventory-service.js and audit-service.js.

**Effort**: S — Two SQL query changes.

**Files involved**:
- `services/catalog/inventory-service.js:58-64`
- `services/catalog/audit-service.js:116-121`

**Audit date**: 2026-02-17

---

### BACKLOG-23: Currency Formatting — No Shared Helper (DEDUP-AUDIT G-3)

**Identified**: 2026-02-17
**Priority**: Low (inconsistent display, no data issue)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: Currency formatting (cents to dollars) is implemented inline across 14+ frontend files. Some use `en-CA` locale, some don't specify locale, some use different patterns (`(cents / 100).toFixed(2)` vs `toLocaleString()`). Mixed cent/dollar confusion possible.

**Suggested fix**: Add `formatCurrency(cents)` to `public/js/utils/escape.js` (shared utility). Standardize on `en-CA` locale with 2 decimal places.

**Effort**: S — Extract existing function and replace inline patterns.

**Files involved**:
- `public/js/vendor-dashboard.js:409`, `public/cart-activity.html:365`, `public/js/inventory.js`, `public/js/dashboard.js`, and 10+ others

**Audit date**: 2026-02-17

---

### BACKLOG-24: Order Normalization Boilerplate (DEDUP-AUDIT G-4)

**Identified**: 2026-02-17
**Priority**: Low (single file, no divergence risk)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: `normalizeSquareOrder()` is defined once in `services/webhook-handlers/order-handler.js:47` but the calling pattern (init SDK client → fetch order → normalize) is repeated at 3 call sites within the same file (lines 316, 983, 1202). Each also initializes `getSquareClientForMerchant()` separately.

**Suggested fix**: Extract `fetchAndNormalizeOrder(merchantId, orderId)` helper combining client init + fetch + normalize.

**Effort**: S — Single file refactor.

**Files involved**:
- `services/webhook-handlers/order-handler.js:312-316, 979-983, 1194-1202`

**Audit date**: 2026-02-17

---

### BACKLOG-25: Location Lookup Queries Repeated (DEDUP-AUDIT G-5)

**Identified**: 2026-02-17
**Priority**: Low (simple parameterized queries, minimal risk)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: SQL queries to look up locations by merchant_id are written inline in 6+ route files with slight variations (active filter, ordering, limit).

**Suggested fix**: Create location helper functions: `getLocationById()`, `getActiveLocations()`, `getDefaultLocation()`.

**Effort**: S — Straightforward extraction.

**Files involved**:
- `routes/gmc.js:756, 815`
- `routes/purchase-orders.js:65`
- `routes/delivery.js:83`
- `routes/loyalty.js:1319`
- `routes/cycle-counts.js:231`

**Audit date**: 2026-02-17

---

### BACKLOG-26: Date String Formatting Pattern (DEDUP-AUDIT G-7)

**Identified**: 2026-02-17
**Priority**: Low (common JS idiom, readability improvement only)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: `new Date().toISOString().split('T')[0]` repeated 12 times across 5 frontend files for YYYY-MM-DD date strings.

**Suggested fix**: Add `getToday()` and `getDateString(date)` to shared utility file.

**Effort**: S — Mechanical replacement.

**Files involved**:
- `public/js/delivery.js:102,110`
- `public/js/delivery-history.js:55,63,67`
- `public/js/cycle-count-history.js:11,21,22,30,31`
- `public/js/catalog-audit.js:440`
- `public/js/vendor-catalog.js:1325`

**Audit date**: 2026-02-17

---

### BACKLOG-27: Inconsistent toLocaleString() Usage (DEDUP-AUDIT G-8)

**Identified**: 2026-02-17
**Priority**: Low (display inconsistency, no data issue)
**Status**: Documented, not fixed
**Target**: TBD

**Problem**: `.toLocaleString()` used 60 times across 14 frontend files with inconsistent locale/options. Some specify `en-CA`, some use browser default. Numbers display differently depending on which page and browser.

**Suggested fix**: Create `formatNumber(n)` helper in shared utility that always uses `en-CA` locale. Bundle with BACKLOG-23 currency formatting effort.

**Effort**: S — Mechanical replacement.

**Files involved**:
- `public/js/gmc-feed.js` (11), `public/js/dashboard.js` (10), `public/js/expiry.js` (6), `public/js/vendor-catalog.js` (6), `public/js/inventory.js` (5), and 9 more files

**Audit date**: 2026-02-17

---

### Square Webhook Subscription Audit (2026-02-11)

Full audit of all 140+ Square webhook event types against app features. Categorized into: already subscribed, should subscribe, and not needed.

#### Currently Subscribed (24 events)

| Category | Events | Handler |
|----------|--------|---------|
| Essential (6) | `order.created`, `order.updated`, `order.fulfillment.updated`, `catalog.version.updated`, `inventory.count.updated`, `oauth.authorization.revoked` | order, catalog, inventory, oauth |
| Loyalty (7) | `loyalty.event.created`, `loyalty.account.created`, `loyalty.account.updated`, `payment.created`, `payment.updated`, `customer.updated`, `gift_card.customer_linked` | loyalty, order, catalog |
| Refunds (2) | `refund.created`, `refund.updated` | order |
| Vendors (2) | `vendor.created`, `vendor.updated` | catalog |
| Locations (2) | `location.created`, `location.updated` | catalog |
| Subscriptions (5) | `subscription.created`, `subscription.updated`, `invoice.payment_made`, `invoice.payment_failed`, `customer.deleted` | subscription |
| Committed Inventory (7) | `invoice.created`, `invoice.updated`, `invoice.published`, `invoice.canceled`, `invoice.deleted`, `invoice.refunded`, `invoice.scheduled_charge_failed` | inventory |
| Customer (1) | `customer.created` | customer |

#### ~~Should Subscribe — High Priority (8 events)~~ NOW SUBSCRIBED

All 8 events are now wired (BACKLOG-10 + BACKLOG-11, completed 2026-02-19):

| Event | Handler | Related Backlog |
|-------|---------|----------------|
| `invoice.created` | `inventory-handler.js:handleInvoiceChanged()` | BACKLOG-10 |
| `invoice.updated` | `inventory-handler.js:handleInvoiceChanged()` | BACKLOG-10 |
| `invoice.published` | `inventory-handler.js:handleInvoiceChanged()` | BACKLOG-10 |
| `invoice.canceled` | `inventory-handler.js:handleInvoiceClosed()` | BACKLOG-10 |
| `invoice.deleted` | `inventory-handler.js:handleInvoiceClosed()` | BACKLOG-10 |
| `invoice.refunded` | `inventory-handler.js:handleInvoiceChanged()` | BACKLOG-10 |
| `invoice.scheduled_charge_failed` | `inventory-handler.js:handleInvoiceChanged()` | BACKLOG-10 |
| `customer.created` | `customer-handler.js:handleCustomerChange()` | BACKLOG-11 |

#### Should Subscribe — Medium Priority (5 events)

| Event | Reason | Impact |
|-------|--------|--------|
| `loyalty.promotion.created` | Detect conflicts with custom reward system | Alerting |
| `loyalty.promotion.updated` | Detect promotion activation/deactivation | Alerting |
| `loyalty.account.deleted` | Clean up orphaned loyalty_customer_summary data | Data hygiene |
| `gift_card.activity.created` | Better loyalty attribution for gift card purchases | Coverage |
| `gift_card.created` | Inventory/catalog awareness of new gift cards | Minor |

#### Not Needed — No Matching Feature (100+ events)

| Category | Count | Reason |
|----------|-------|--------|
| Bookings (`booking.*`) | 15 | No booking/appointment feature |
| Labor (`labor.*`) | 9 | No team scheduling |
| Team Members (`team_member.*`) | 3 | No HR/team management |
| Terminals (`terminal.*`) | 6 | No terminal device management |
| Disputes (`dispute.*`) | 6 | No chargeback handling |
| Payouts (`payout.*`) | 3 | No financial reporting |
| Bank Accounts (`bank_account.*`) | 3 | No banking feature |
| Cards (`card.*`) | 5 | Cards only for subscriptions, no lifecycle tracking needed |
| Transfer Orders (`transfer_order.*`) | 3 | No multi-location transfers |
| Online Checkout (`online_checkout.*`) | 2 | No checkout settings management |
| Custom Attributes (`*.custom_attribute*`) | 40+ | Only reads brand from catalog (read-only) |
| Jobs (`job.*`) | 2 | No Square Jobs feature |
| Device Codes (`device.code.paired`) | 1 | No device management |
| Gift Card misc (`gift_card.customer_unlinked`, `gift_card.updated`) | 2 | Extremely rare edge cases |

**Summary**: 8 high-priority events added (BACKLOG-10 + BACKLOG-11, completed 2026-02-19). Consider 5 medium-priority events later. Skip 100+ events — no matching features exist.

---

## Previous Achievements

These items are COMPLETE and should not regress:

| Achievement | Date | Notes |
|-------------|------|-------|
| server.js: 3,057 → 1,023 lines (66% reduction) | 2026-01-26 | Route extraction |
| All 246 routes use asyncHandler | 2026-01-26 | Error handling |
| Webhook processing modularized (8 handlers) | 2026-01-26 | services/webhook-handlers/ |
| Cron jobs extracted to jobs/ directory | 2026-01-26 | cron-scheduler.js |
| Composite indexes added for multi-tenant queries | 2026-01-26 | Performance |
| N+1 queries eliminated | 2026-01-26 | Performance |
| Transactions added to critical operations | 2026-01-26 | Data integrity |
| Sync queue state persisted to database | 2026-01-26 | Reliability |
| API versioning added (/api/v1/*) | 2026-01-26 | Future-proofing |
| pg_dump secured (spawn with env password) | 2026-01-26 | Security |
| Parameterized queries: 100% coverage | 2026-01-26 | SQL injection prevention |
| Token encryption: AES-256-GCM | 2026-01-26 | Security |
| Password hashing: bcrypt with 12 rounds | 2026-01-26 | Security |
| Multi-tenant isolation: merchant_id on all queries | 2026-01-26 | Security |
| Modern loyalty service built with 2,931 lines of tests | 2026-01-26 | services/loyalty/ |
| P0-1, P0-2, P0-3 security fixes applied | 2026-01-26 | Security |
| Bundle reorder system (tables, routes, calculator, UI) | 2026-02-06 | routes/bundles.js, services/bundle-calculator.js |
| Dead webhook alerting + health endpoint stats | 2026-02-06 | utils/webhook-retry.js, server.js |
| Webhook retry infinite loop fixed (2 root causes) | 2026-02-06 | invalid status + merchant_id type mismatch |
| Bundle vendor_id type fixed (INTEGER→TEXT) | 2026-02-06 | migration 043 |

---

## Executive Summary for Non-Technical Stakeholders

### What This Means (Plain English)

**Current State**: All **critical security vulnerabilities (P0) and high-priority architecture issues (P1) have been FIXED** as of 2026-01-26. The application is enterprise-ready for production use with real merchant data.

**Security Checklist - ALL COMPLETE**:
- [x] SQL injection protection (parameterized queries)
- [x] Password encryption (bcrypt, 12 rounds)
- [x] Token encryption (AES-256-GCM)
- [x] Multi-tenant isolation (merchant_id on all queries)
- [x] Session security - Logout properly clears cookies (P0-5 FIXED)
- [x] Session security - Login regenerates session ID (P0-6 FIXED)
- [x] XSS protection - All error messages escaped (P0-7 FIXED)
- [x] Input validation - All routes have validators (P1-6 FIXED)
- [x] Password reset - Token attempt limiting (P1-7 FIXED)
- [x] Webhook security - Rate limiting enabled (P1-8 FIXED)
- [x] Error handling - No internal details exposed (P1-9 FIXED)
- [x] 23 test files with comprehensive coverage

### Remaining Work (P3 - Optional for Scale)

P3 items are only needed for multi-instance SaaS deployment:
- P3-1: Redis for shared state (currently in-memory)
- P3-2: Distributed job queue for cron jobs
- P3-3: Per-tenant Square API rate limiting
- P3-4: Tenant-aware database pooling

**Production Ready**: YES - All P0 and P1 issues resolved. Grade: A+
