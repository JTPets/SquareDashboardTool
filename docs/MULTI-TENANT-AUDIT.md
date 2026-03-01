# Multi-Tenant & Subscription System Audit

**Date**: 2026-03-01
**Auditor**: Claude (requested by John, JT Pets)
**Purpose**: Verify multi-tenant isolation end-to-end and assess subscription system readiness for beta merchant onboarding (2-3 merchants, 6 months free trial)
**Test Baseline**: 59 suites, 1,150 tests, CI green on main

---

## Executive Summary

**Multi-tenant isolation: PASS (A grade)**. The architecture is production-ready for multiple merchants. All database queries use parameterized SQL with `merchant_id` filtering, webhook routing correctly resolves merchants, cron jobs iterate all active merchants, and Square API clients are per-merchant with encrypted tokens.

**Subscription system: TWO DISCONNECTED SYSTEMS exist**. This is the critical finding. The `merchants` table has subscription fields (`subscription_status`, `trial_ends_at`) that are checked by middleware but never populated during onboarding. The `subscribers` table has a fully operational Square-based billing system but has no `merchant_id` link. These two systems need to be bridged for beta launch.

**Minimum viable path to beta**: Set `trial_ends_at` during OAuth onboarding. The middleware already checks it. Estimated effort: 2-4 hours.

---

## Part 1: Multi-Tenant Isolation Findings

### 1.1 OAuth Onboarding Flow

| Check | Status | Evidence |
|-------|--------|----------|
| CSRF protection | PASS | 256-bit state via `crypto.randomBytes(32)`, stored with user_id + 10-min expiry, single-use enforcement (`square-oauth.js:87-176`) |
| Session user verification | PASS | Callback verifies `req.session.user.id === stateRecord.user_id` before proceeding (`square-oauth.js:156`) |
| Session fixation prevention | PASS | Session regenerated after OAuth completion (S-11, `square-oauth.js:269-283`) |
| Open redirect prevention | PASS | `isLocalPath()` rejects absolute URLs, `//`, `://`, control chars (`square-oauth.js:40-45`) |
| Concurrent onboarding safety | PASS | `INSERT...ON CONFLICT (square_merchant_id)` handles race conditions; both tabs end at same merchant |
| Merchant record creation | PASS | `square_merchant_id` UNIQUE constraint prevents duplicates; upsert pattern on reconnect (`square-oauth.js:216-251`) |
| User-merchant linking | PASS | `user_merchants` table with `UNIQUE(user_id, merchant_id)` and ON CONFLICT handling (`square-oauth.js:257-266`) |

### 1.2 Token Storage & Encryption

| Check | Status | Evidence |
|-------|--------|----------|
| Algorithm | PASS | AES-256-GCM (authenticated encryption) — `token-encryption.js:18` |
| Random IV | PASS | `crypto.randomBytes(16)` per encryption — `token-encryption.js:62` |
| Auth tag | PASS | 128-bit GCM auth tag detects tampering — `token-encryption.js:68` |
| Key validation | PASS | Validates 64-char hex (32 bytes), rejects malformed — `token-encryption.js:27-50` |
| Per-merchant tokens | PASS | Each merchant has own encrypted access_token and refresh_token in `merchants` table |
| Proactive refresh | PASS | Tokens refreshed when within 1 hour of expiry — `merchant.js:222-233` |

**Weakness**: No key rotation/versioning strategy. Single `TOKEN_ENCRYPTION_KEY`. If compromised, all tokens exposed. Medium risk — acceptable for beta, should address pre-franchise.

### 1.3 Webhook Routing & Merchant Resolution

| Check | Status | Evidence |
|-------|--------|----------|
| Signature verification | PASS | HMAC-SHA256 with timing-safe comparison, `SQUARE_WEBHOOK_URL` env prevents Host injection (`webhook-processor.js:77-96`) |
| Merchant resolution | PASS | `SELECT id FROM merchants WHERE square_merchant_id = $1 AND is_active = TRUE` (`webhook-processor.js:158-161`) |
| Context isolation | PASS | Resolved `merchantId` passed to all handlers via context object (`webhook-processor.js:187-198`) |
| Duplicate prevention | PASS | In-memory lock (60s TTL) + DB idempotency check (`webhook-processor.js:38-55, 104-113`) |
| Unknown merchant handling | PASS | Returns null, webhook logged but not processed for unknown merchants |
| Per-merchant rate limiting | PASS | Webhook rate limit keyed by `webhook-${merchantId}` (`security.js:256-260`) |

### 1.4 Data Isolation by Domain

| Domain | Status | Evidence |
|--------|--------|----------|
| Catalog (items, variations, categories) | PASS | All queries include `WHERE merchant_id = $N`; verified across `routes/catalog.js`, `services/square/square-catalog-sync.js` |
| Inventory | PASS | `inventory_counts`, `committed_inventory` all filtered by merchant_id; `RESERVED_FOR_SALE` rebuild scoped to merchant (`inventory-handler.js:395-420`) |
| Orders | PASS | Order processing requires merchantId parameter; explicit check: `if (!merchantId) throw new Error('merchantId is required - tenant isolation required')` (`order-intake.js:43`) |
| Loyalty | PASS | All loyalty tables use composite keys with merchant_id; `loyalty_processed_orders(merchant_id, square_order_id)` |
| Delivery | PASS | 100% of delivery queries include `dord.merchant_id = $N`; verified across `delivery-service.js` (15+ queries) |
| Vendors | PASS | `WHERE merchant_id = $1` on all vendor queries |
| Expiry discounts | PASS | Per-merchant settings, per-merchant automation |
| Seniors discount | PASS | Per-merchant configuration and pricing rules |
| Purchase orders | PASS | merchant_id on all PO queries |

### 1.5 Cron Jobs — Multi-Merchant Iteration

| Job | Iterates All Merchants? | Evidence |
|-----|------------------------|----------|
| Smart Sync | YES | `SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE` then loops (`sync-job.js:25-27`) |
| GMC Sync | YES | Same merchant query pattern (`sync-job.js:121-124`) |
| Expiry Discount | YES | Same pattern, per-merchant settings check (`expiry-discount-job.js:108-110`) |
| Loyalty Catchup | YES | Queries merchants with active loyalty offers (`loyalty-catchup-job.js:34-42`) |
| Loyalty Audit | YES | Same merchant+loyalty join pattern (`loyalty-audit-job.js`) |
| Seniors Discount | YES | Per-merchant config (`seniors-day-job.js`) |
| Committed Inventory Reconciliation | YES | Per-merchant reconciliation (`committed-inventory-reconciliation-job.js`) |
| Webhook Retry | YES | Processes failed webhooks with stored merchant_id |
| Cycle Count | YES | Per-merchant batch generation |

All jobs use error isolation per merchant — one merchant's failure doesn't stop others.

### 1.6 Shared Resources & Contention

| Resource | Isolation | Evidence |
|----------|-----------|----------|
| Square API clients | Per-merchant cache | `clientCache` Map keyed by `merchantId`, 5-min TTL, FIFO eviction at 100 (`merchant.js:19-20`) |
| Database connections | Shared pool | Single PostgreSQL pool. Acceptable — queries are fast, pool handles concurrency |
| Sync queue | Per-merchant keys | `catalogInProgress`, `inventoryInProgress` Maps keyed by merchantId (`sync-queue.js:29-34`) |
| Webhook dedup | Per-process | In-memory `_processingEvents` Map (event_id key). DB check is authoritative. PM2 cluster would need Redis |
| Rate limiting | Per-merchant | Webhook + sensitive ops keyed by `merchant-${merchantId}` (`security.js`) |
| Logs | Shared (by design) | Single log stream with merchantId in structured logs. Acceptable for audit trail |
| File system | No tenant files | No per-tenant file storage |

### 1.7 Hardcoded Merchant IDs

**Result: NONE in production code.** All `merchant_id = 1` references are in test fixtures or migration backfill scripts only.

### 1.8 Database Schema Concerns

| Issue | Severity | Details |
|-------|----------|---------|
| **merchant_id nullable on 14+ core tables** | MEDIUM | `locations`, `categories`, `items`, `variations`, `images`, `inventory_counts`, `vendors`, `variation_vendors`, `vendor_catalog_items`, `purchase_orders`, `purchase_order_items`, `sales_velocity`, `count_history`, `sync_history` — all have `merchant_id INTEGER REFERENCES merchants(id)` WITHOUT `NOT NULL`. Migration 005 noted this would be added later; never done. |
| **No ON DELETE CASCADE on 14 core tables** | LOW | If a merchant is deleted, child rows become orphans. Newer tables (loyalty, delivery, etc.) properly use `ON DELETE CASCADE`. |
| **Unique constraints updated** | PASS | Migration 007 updated 10 unique constraints to include merchant_id (brands, inventory_counts, etc.) |

**Risk of nullable merchant_id**: If application code ever inserts a row without merchant_id, it becomes invisible to all tenants (orphaned) or, worse, visible if a query omits the merchant_id filter. The middleware consistently provides merchant_id, so this is a defense-in-depth concern, not an active vulnerability.

**Recommendation**: Add `NOT NULL` constraints in a future migration after verifying no NULL rows exist.

### 1.9 Key Questions Answered

**Can two merchants connect simultaneously without data leaking?**
> YES. OAuth state is user-specific. Merchant records keyed by `square_merchant_id` (UNIQUE). All queries parameterized with merchant_id. ON CONFLICT clauses handle races. No cross-tenant leakage vectors found.

**Are there any hardcoded merchant IDs or single-tenant assumptions?**
> NO. Zero hardcoded merchant IDs in production code. All merchant references come from session context or database lookups. Code handles multiple merchants per user and multiple users per merchant.

**What happens if merchant B's Square token expires while merchant A is active?**
> Nothing happens to merchant A. Token refresh is per-merchant (`getSquareClientForMerchant` checks expiry per merchant_id). If B's refresh fails, only B's requests fail. A is unaffected. B would need to re-authorize via OAuth.

**Are there any shared resources that could cause contention?**
> The database connection pool is shared but this is standard and acceptable. All in-memory caches (Square clients, sync queue, webhook dedup) are keyed by merchant_id. No cross-tenant contention.

---

## Part 2: Subscription System Audit

### 2.1 The Two Systems Problem

The codebase has **two independent subscription systems** that are not connected:

#### System A: Merchant Subscriptions (`merchants` table)

```
merchants.subscription_status  — DEFAULT 'trial' (CHECK: trial, active, cancelled, expired, suspended)
merchants.trial_ends_at        — TIMESTAMPTZ, nullable
merchants.subscription_ends_at — TIMESTAMPTZ, nullable
merchants.subscription_plan_id — INTEGER, nullable
```

**Checked by**: `loadMerchantContext` middleware (`merchant.js:106-112`):
```javascript
if (m.subscription_status === 'expired' || m.subscription_status === 'suspended') {
    req.merchantContext.isSubscriptionValid = false;
} else if (m.subscription_status === 'trial' && m.trial_ends_at) {
    req.merchantContext.isSubscriptionValid = new Date(m.trial_ends_at) > new Date();
} else {
    req.merchantContext.isSubscriptionValid = true;  // active, cancelled = still valid
}
```

**Enforced by**: `requireValidSubscription` middleware (`merchant.js:146-167`) — returns 402 if invalid.

**Current state**: `subscription_status` defaults to `'trial'` on merchant creation. `trial_ends_at` is **NEVER SET** during OAuth onboarding. So `isSubscriptionValid` evaluates to `true` (the `else` branch — status is 'trial' but `trial_ends_at` is null). **Every merchant currently has unlimited free access.**

**Is `requireValidSubscription` actually used on routes?** It's **imported** in `server.js` but grep shows it's not applied to any route middleware chain in production. It's only tested. This means subscription enforcement is **not active** on any route today.

#### System B: SaaS Subscriber Billing (`subscribers` table)

```
subscribers.email              — TEXT UNIQUE (lookup key)
subscribers.subscription_status — DEFAULT 'trial' (trial, active, past_due, canceled, expired)
subscribers.trial_end_date     — 30 days from creation
subscribers.square_customer_id — Square Payments API customer
subscribers.square_subscription_id — Square Subscriptions API subscription
subscribers.card_id            — Square card on file
```

**Checked by**: `subscriptionCheck` middleware (`subscription-check.js:83-149`) — looks up by email in `subscribers` table.

**Applied globally**: `app.use(subscriptionCheck)` in `server.js:317`.

**Payment processor**: Square Subscriptions API — **fully operational, real payments, not a placeholder**.

**The disconnect**: `subscribers` table has **no `merchant_id` column**. There is no foreign key or link between who is paying (subscribers) and what tenant they're managing (merchants). The subscription check uses email-based lookup against `subscribers`, while data access uses merchant_id from `merchants`.

### 2.2 Subscription State Machine (System B — Active)

```
CREATION (POST /api/subscriptions/create)
    │
    ▼
┌──────────┐
│  TRIAL   │  30 days, auto-checked on each request
│          │  (checkSubscriptionStatus lazily updates to expired)
└────┬─────┘
     │
     ├── trial_end_date passes ──► EXPIRED (access denied)
     │
     └── payment received ──────► ACTIVE
                                     │
                                     ├── payment fails ──► PAST_DUE (access denied)
                                     │
                                     ├── user cancels ──► CANCELED (access denied)
                                     │
                                     └── subscription_end_date passes ──► EXPIRED
```

### 2.3 What Works Today

| Feature | Status | Location |
|---------|--------|----------|
| Subscription plan listing | WORKING | `GET /api/subscriptions/plans` |
| Promo code validation | WORKING | `POST /api/subscriptions/promo/validate` — percent & fixed discounts, usage limits, date ranges |
| Subscription creation with Square payment | WORKING | `POST /api/subscriptions/create` — creates Square customer + card + subscription |
| Trial period (30 days) | WORKING | Auto-tracked via `trial_end_date`, checked on each request |
| Recurring billing | WORKING | Square handles automatic charges, sends webhooks |
| Subscription cancellation | WORKING | `POST /api/subscriptions/cancel` — local + Square sync |
| Refund processing | WORKING | `POST /api/subscriptions/refund` — admin only |
| Webhook event handling | WORKING | 5 subscription webhook types handled (`subscription-handler.js` in webhook-handlers) |
| Admin subscriber management | WORKING | `GET /api/subscriptions/admin/list` |
| PCI compliance | WORKING | Zero card data stored locally — only Square IDs |
| Subscription status enforcement | WORKING | `subscriptionCheck` middleware blocks expired/canceled users |

### 2.4 What's Missing / Broken

| Issue | Severity | Details |
|-------|----------|---------|
| **No link between subscribers and merchants** | HIGH | `subscribers` table has no `merchant_id`. Can't map "who pays" to "what tenant". |
| **`merchants.trial_ends_at` never set** | HIGH | OAuth onboarding creates merchant with `subscription_status = 'trial'` but never sets `trial_ends_at`. Result: unlimited free access. |
| **`requireValidSubscription` not applied to routes** | HIGH | Middleware exists and works but isn't wired into any route chain. |
| **`merchants.subscription_status` never updated** | MEDIUM | Set to 'trial' at creation, never transitions. No cron job or webhook updates it. |
| **Dual subscription check redundancy** | MEDIUM | Both `subscriptionCheck` (email-based, System B) and `requireValidSubscription` (merchant-based, System A) exist. Only System B is active. |
| **No upgrade/downgrade** | LOW | Can only cancel and re-subscribe |
| **No dunning emails** | LOW | `past_due` status set but no automated recovery emails |
| **TRIAL_DAYS hardcoded to 30** | LOW | `utils/subscription-handler.js:10` — not configurable per merchant |

### 2.5 After 6 Months — What Happens?

**Today**: Nothing. `merchants.trial_ends_at` is null, so the trial check in `loadMerchantContext` falls through to `isSubscriptionValid = true`. Access continues indefinitely.

**If System B is the gate**: `subscribers.trial_end_date` is set to 30 days from creation. After 30 days, `checkSubscriptionStatus` lazily flips status to `expired` and blocks access. But this only applies if the merchant also has a `subscribers` record (linked by email).

**Bottom line**: Without changes, beta merchants will have unlimited free access because the merchant-level subscription fields are never populated.

---

## Part 3: Beta Onboarding Implementation Plan

### Recommended Approach: Use System A (Merchant-Level Subscriptions)

The simplest path is to populate the existing `merchants` table fields during OAuth onboarding. The middleware already checks them. No new tables, no new middleware, no billing integration needed for free trials.

### Step 1: Set trial_ends_at During OAuth Onboarding

**File**: `routes/square-oauth.js` (~line 229)
**Change**: After `INSERT INTO merchants`, set `trial_ends_at = NOW() + 6 months`

```javascript
// In the INSERT...ON CONFLICT query, add:
subscription_status = 'trial',
trial_ends_at = NOW() + INTERVAL '6 months'
```

**Effort**: 30 minutes
**Risk**: LOW — only affects new merchants. Existing JTPets merchant is unaffected (already 'active' or has no trial_ends_at).

### Step 2: Wire requireValidSubscription Into Route Chain

**File**: `server.js`
**Change**: Add `requireValidSubscription` to the API auth middleware chain, after `loadMerchantContext` and `requireMerchant`.

**Effort**: 1 hour (including testing)
**Risk**: MEDIUM — need to verify JTPets' merchant record has `subscription_status = 'active'` (not 'trial') or set `trial_ends_at` far in the future. Otherwise John gets locked out.

**Safeguard**: Update JTPets' merchant record first:
```sql
UPDATE merchants SET subscription_status = 'active' WHERE id = 1;
```

### Step 3: Admin Endpoint to Manage Trials

**File**: `routes/merchants.js` (new endpoint)
**Change**: Add `POST /api/merchants/:id/subscription` (admin-only) to:
- Extend trial: `UPDATE merchants SET trial_ends_at = $1 WHERE id = $2`
- Activate: `UPDATE merchants SET subscription_status = 'active' WHERE id = $1`
- Suspend: `UPDATE merchants SET subscription_status = 'suspended' WHERE id = $1`

**Effort**: 2 hours (endpoint + validator + tests)
**Risk**: LOW

### Step 4: Trial Expiry Notification (Optional but Recommended)

**File**: New cron job or addition to existing job
**Change**: Daily check for merchants where `trial_ends_at` is within 30/14/7/1 days. Send email notification.

**Effort**: 3-4 hours
**Risk**: LOW

### Implementation Summary

| Step | Description | Effort | Priority |
|------|-------------|--------|----------|
| 0 | Set JTPets merchant to `subscription_status = 'active'` | 5 min (SQL) | CRITICAL (do first) |
| 1 | Set `trial_ends_at` during OAuth onboarding | 30 min | CRITICAL |
| 2 | Wire `requireValidSubscription` into route chain | 1 hour | CRITICAL |
| 3 | Admin endpoint to manage trials | 2 hours | HIGH |
| 4 | Trial expiry email notifications | 3-4 hours | MEDIUM |
| **Total** | | **~7 hours** | |

### What This Gives You

1. New merchant connects via Square OAuth → account created with 6-month free trial
2. All features accessible during trial (same as today)
3. After 6 months → `loadMerchantContext` sets `isSubscriptionValid = false` → `requireValidSubscription` returns 402
4. John can manually extend via admin endpoint or direct SQL
5. No payment required during beta — billing (System B) remains available for future paid launch

### Future: Bridging Systems A and B

When you're ready for paid subscriptions, the path is:
1. Add `merchant_id` column to `subscribers` table
2. During paid onboarding: create subscriber + link to merchant
3. Webhook handlers update `merchants.subscription_status` based on payment events
4. Remove `subscriptionCheck` middleware (System B), rely solely on `requireValidSubscription` (System A)

This is a larger effort (~2-3 days) but not needed for beta.

---

## Part 4: Test Coverage Gaps

### 4.1 Multi-Tenant Isolation Tests

| Area | Covered? | Details | Risk if Untested |
|------|----------|---------|-----------------|
| Cross-tenant data access prevention | YES (36 tests) | `__tests__/security/multi-tenant-isolation.test.js` — verifies merchant A can't see merchant B's data, parameter manipulation, bulk operations | LOW |
| OAuth onboarding flow | YES (54 tests) | `__tests__/security/oauth-csrf.test.js` — state entropy, expiry, single-use, user binding | LOW |
| OAuth open redirect | YES (22 tests) | `__tests__/security/open-redirect.test.js` | LOW |
| Webhook routing to correct merchant | YES (37 tests) | `__tests__/services/webhook-processor.test.js` — merchant lookup, signature verification, duplicate detection | LOW |
| Token encryption/decryption | YES (72 tests) | `__tests__/utils/token-encryption.test.js` — roundtrip, tampering, format, key validation | LOW |
| Merchant context & role isolation | YES (34 tests) | `__tests__/middleware/merchant.test.js` — role-based access, subscription validity | LOW |

### 4.2 Missing Multi-Tenant Tests

| What's Missing | File Needing Tests | Risk Level |
|----------------|-------------------|------------|
| **Cron jobs iterate ALL merchants** | `jobs/sync-job.js`, `jobs/expiry-discount-job.js`, `jobs/loyalty-catchup-job.js`, `jobs/loyalty-audit-job.js`, `jobs/committed-inventory-reconciliation-job.js` | **HIGH** — Tests only verify scheduling, not execution scope. Should verify each job queries all active merchants and processes each independently. |
| **Cron job error isolation** — one merchant fails, others continue | Same files as above | **HIGH** — A merchant-specific error could potentially abort the entire job loop. |
| **Concurrent OAuth callback race condition** | `routes/square-oauth.js` | **MEDIUM** — ON CONFLICT clauses handle it, but no stress test verifies 10+ simultaneous callbacks. |
| **Token refresh failure → user experience** | `middleware/merchant.js`, `utils/square-token.js` | **MEDIUM** — No test verifies user gets re-auth redirect when refresh fails. |
| **Webhook with unknown/missing merchant_id** | `services/webhook-processor.js` | **MEDIUM** — Edge case where Square sends webhook for merchant not in our DB. |

### 4.3 Subscription Tests

| Area | Covered? | Details | Risk if Untested |
|------|----------|---------|-----------------|
| Subscription-check middleware | YES (25 tests) | `__tests__/middleware/subscription-check.test.js` — email extraction, spoofing prevention, public routes, status validation | LOW |
| Subscription creation validation | YES (81 tests) | `__tests__/routes/subscriptions.test.js` — input validation, promo codes, plan validation, PCI compliance | LOW |
| Payment declined handling | YES | Card declined, insufficient funds, invalid card tested | LOW |
| Refund processing | YES | Idempotency, eligibility, audit logging tested | LOW |

### 4.4 Missing Subscription Tests

| What's Missing | File Needing Tests | Risk Level |
|----------------|-------------------|------------|
| **Trial → expired transition** (System B) | `utils/subscription-handler.js` | **HIGH** — `checkSubscriptionStatus` lazily updates trial to expired, but no test verifies the full lifecycle including the DB update. |
| **Payment failure → past_due → recovery** | `services/webhook-handlers/subscription-handler.js` | **HIGH** — No test for the subscription reactivation flow after a failed payment is retried. |
| **Merchant-level subscription enforcement** (System A) | `middleware/merchant.js` (`requireValidSubscription`) | **HIGH** — Middleware is tested in isolation but never wired into route chain. No integration test. |
| **Subscription-merchant linking** | `routes/subscriptions.js` | **MEDIUM** — No test verifies that a subscriber's data is tied to the correct merchant. |
| **Trial expiry at exact boundary** | `utils/subscription-handler.js` | **MEDIUM** — Timezone edge cases at midnight. |
| **Subscription webhook status sync** | `services/webhook-handlers/subscription-handler.js` | **MEDIUM** — Webhook updates `subscribers` but not `merchants`. No test verifies this gap. |
| **Multiple payment methods per subscriber** | `utils/subscription-handler.js` | **LOW** — Card switching may break subscription. |
| **Subscription plan upgrade/downgrade** | Not implemented | **LOW** — Feature doesn't exist yet. |

### 4.5 Test Coverage Summary

| Category | Tests | Coverage |
|----------|-------|----------|
| Security (OAuth, isolation, XSS, injection) | ~350 | EXCELLENT |
| Middleware (auth, merchant, subscription-check) | ~109 | EXCELLENT |
| Subscription routes | ~81 | GOOD (creation/validation covered, lifecycle gaps) |
| Webhook processor | ~37 | GOOD |
| Token encryption | ~72 | EXCELLENT |
| Cron job scheduling | ~22 | PARTIAL (scheduling only, not execution scope) |
| **Cron job multi-merchant execution** | **0** | **CRITICAL GAP** |
| **Subscription lifecycle (trial→active→expired)** | **0** | **CRITICAL GAP** |
| **Merchant-level subscription enforcement** | **0 integration** | **CRITICAL GAP** |

### 4.6 Recommended Test Priorities

**Priority 1 — Before Beta Launch (8-12 hours)**
1. Cron job multi-merchant tests: verify each job loops all merchants, error isolation per merchant
2. Merchant-level subscription enforcement integration test: wire `requireValidSubscription`, verify trial expiry blocks access
3. Trial lifecycle test: create trial → time passes → verify expired → verify blocked

**Priority 2 — Next Sprint (5-8 hours)**
1. Payment failure → recovery webhook flow
2. Subscription-merchant linking verification
3. Token refresh failure → user redirect

**Priority 3 — Nice to Have (3-4 hours)**
1. Concurrent OAuth callback stress test
2. Webhook edge cases (unknown merchant, malformed payload)
3. Trial expiry timezone boundary

---

## Appendix A: Files Analyzed

| File | Lines | Purpose |
|------|-------|---------|
| `routes/square-oauth.js` | 487 | OAuth connect/callback/revoke/refresh |
| `middleware/merchant.js` | 333 | Merchant context loading, Square client cache, subscription check |
| `middleware/subscription-check.js` | 211 | Email-based subscription enforcement (System B) |
| `middleware/auth.js` | 185 | Session authentication |
| `utils/subscription-handler.js` | 452 | Subscriber CRUD, status checking, payment recording |
| `utils/token-encryption.js` | 182 | AES-256-GCM token encryption |
| `utils/square-token.js` | 82 | Token refresh |
| `routes/subscriptions.js` | 792 | Subscription CRUD, promo codes, admin endpoints |
| `services/webhook-processor.js` | 378 | Webhook signature verification, merchant resolution, routing |
| `services/webhook-handlers/index.js` | ~180 | Handler registry and fan-out dispatch |
| `jobs/cron-scheduler.js` | 182 | Central cron initialization (12 jobs) |
| `jobs/sync-job.js` | 217 | Multi-merchant sync |
| `jobs/expiry-discount-job.js` | 167 | Multi-merchant expiry automation |
| `jobs/loyalty-catchup-job.js` | 358 | Multi-merchant loyalty catchup |
| `database/migrations/004_subscriptions.sql` | 117 | Subscribers, payments, events, plans tables |
| `database/migrations/005_multi_tenant.sql` | 417 | Merchants, user_merchants, oauth_states tables |
| `database/migrations/007_multi_tenant_constraints.sql` | 189 | Unique constraints updated for multi-tenant |
| `database/schema.sql` | ~1,900 | Full schema |
| `__tests__/security/multi-tenant-isolation.test.js` | 709 | 36 isolation tests |
| `__tests__/security/oauth-csrf.test.js` | 739 | 54 OAuth security tests |
| `__tests__/middleware/subscription-check.test.js` | 294 | 25 subscription middleware tests |
| `__tests__/middleware/merchant.test.js` | 466 | 34 merchant middleware tests |
| `__tests__/utils/token-encryption.test.js` | 370 | 72 encryption tests |
| `__tests__/services/webhook-processor.test.js` | 466 | 37 webhook tests |
| `__tests__/routes/subscriptions.test.js` | 850 | 81 subscription route tests |

## Appendix B: Schema — Nullable merchant_id Tables

These 14 tables have `merchant_id INTEGER REFERENCES merchants(id)` **without NOT NULL**:

```
locations, categories, items, variations, images, inventory_counts,
vendors, variation_vendors, vendor_catalog_items,
purchase_orders, purchase_order_items,
sales_velocity, variation_location_settings,
count_history, count_queue_priority, count_queue_daily, count_sessions,
variation_expiration, expiry_discount_tiers, variation_discount_status,
expiry_discount_audit_log, expiry_discount_settings,
brands, category_taxonomy_mapping, item_brands, gmc_settings, gmc_feed_history,
sync_history
```

Newer tables (loyalty, delivery, cart_activity, committed_inventory, bundles) properly use `merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE`.

**Recommendation**: Migration to add `NOT NULL` after verifying no NULL rows:
```sql
-- Verify first:
SELECT table_name, count(*) FROM (
    SELECT 'locations' as table_name FROM locations WHERE merchant_id IS NULL
    UNION ALL SELECT 'items' FROM items WHERE merchant_id IS NULL
    -- ... etc
) t GROUP BY table_name;

-- Then for each table:
ALTER TABLE locations ALTER COLUMN merchant_id SET NOT NULL;
```
