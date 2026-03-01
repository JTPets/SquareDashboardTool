# CLAUDE.md - JTPets Square Dashboard Tool

## Project Overview

Multi-tenant SaaS inventory management system for Square POS. Built for JTPets.ca (pet food/supplies with free local delivery) with goal of SaaS revenue. Running on Raspberry Pi.

## Tech Stack

- **Runtime**: Node.js 18+ with Express.js
- **Database**: PostgreSQL 14+
- **Process Manager**: PM2
- **External APIs**: Square SDK v43.2.1, Google APIs v144
- **Timezone**: America/Toronto

---

## Critical Rules

### Security First
- ALL database queries use parameterized SQL (`$1, $2` - never string concatenation)
- ALL user input validated via express-validator (see `middleware/validators/`)
- ALL routes require authentication unless explicitly public
- Multi-tenant isolation: EVERY query must filter by `merchant_id`
- Tokens encrypted with AES-256-GCM before storage

### Multi-Tenant Pattern
```javascript
const merchantId = req.merchantContext.id;

// EVERY database query must include merchant_id
const result = await db.query(
    'SELECT * FROM items WHERE merchant_id = $1 AND id = $2',
    [merchantId, itemId]
);
```

### Response Format
```javascript
// Success (direct format - most endpoints)
res.json({ count: 5, items: [...] });

// Success (wrapped format - some endpoints)
res.json({ success: true, data: { ... } });

// Error
res.status(4xx).json({ success: false, error: 'message', code: 'ERROR_CODE' });
```

> **Warning**: Response formats are inconsistent. Always check the actual route before writing frontend code.

### Git Rules
- Always start work with: `git checkout main && git pull origin main`
- Then create feature branch from updated main
- When told "do not commit" or "show me before committing", do NOT run `git commit` or `git push`. Show the diff only. Wait for explicit approval before committing.
- This rule has no exceptions. "Not committed, as requested" followed by committing is a violation.

### Code Organization
```
routes/          → API endpoints (thin - validation + call service)
middleware/      → Auth, merchant context, validators, security
services/        → Business logic (loyalty-admin/ has good examples)
utils/           → Shared utilities (database, Square API, logging)
database/        → schema.sql + migrations/
jobs/            → Background jobs and cron tasks
```

### Code Rules

| Rule | Limit |
|------|-------|
| Function length | ≤ 100 lines |
| File length | ≤ 300 lines (split if larger) |
| Service scope | Single responsibility |
| Route logic | Validation + call service only |
| New files | Tests + docs reference required |
| Complexity | Explainable in one sentence |

**Violations require justification.** If any rule must be broken:
1. Add a comment at the top of the file/function explaining WHY
2. Log it in the Approved Violations table below
3. Create a backlog item to refactor if temporary

#### Approved Violations
| Date | File | Rule Broken | Reason |
|------|------|-------------|--------|
| 2026-01-29 | utils/database.js | 2,397 line function | SQL schema definition, not logic |
| 2026-01-29 | server.js | 1,006 lines | Express entry point, already reduced 66% |
| 2026-01-29 | All LOW severity files | >300 lines | Stable code, refactor-on-touch policy |

**Policy**: Files are refactored when modified, not proactively. Touch it = fix it.

---

## Common Patterns

### Error Handling (asyncHandler)
```javascript
const asyncHandler = require('../middleware/async-handler');

router.get('/endpoint', asyncHandler(async (req, res) => {
    // Errors automatically caught and passed to error handler
}));
```

### Transaction Pattern
```javascript
const result = await db.transaction(async (client) => {
    await client.query('INSERT INTO table1...', [a, b]);
    await client.query('UPDATE table2...', [x, id]);
    return result;
});
```

### Batch Operations
```javascript
// Use ANY for batch lookups
const result = await db.query(
    'SELECT * FROM variations WHERE sku = ANY($1) AND merchant_id = $2',
    [skuArray, merchantId]
);
```

### Square API
```javascript
const { getSquareClientForMerchant } = require('../middleware/merchant');
const squareClient = await getSquareClientForMerchant(merchantId);

// Write operations require idempotency key
await squareClient.orders.createOrder({
    idempotencyKey: crypto.randomUUID(),
    order: { ... }
});
```

### Square SDK Method Naming
The Square Node.js SDK in this project uses nested resource patterns, NOT the flat API naming from Square's docs. Always check existing working code before writing Square API calls.

Common mistakes:
- `squareClient.ordersApi.retrieveOrder()` → `squareClient.orders.get({ orderId })`
- `squareClient.catalog.deleteObject()` → `squareClient.catalog.object.delete({ objectId })`
- `squareClient.loyalty.searchLoyaltyEvents()` → `squareClient.loyalty.searchEvents()`
- `response.result.order` → `response.order`

**Rule**: Before writing any Square API call, grep the codebase for an existing working example of that endpoint.

### Logging
```javascript
const logger = require('../utils/logger');
logger.info('Operation completed', { merchantId, result });
logger.error('Failed', { error: err.message, stack: err.stack });
```

---

## Commands

```bash
# Development
npm start                    # Production
npm run dev                  # Development with --watch
pm2 restart square-dashboard-addon  # After code changes
npm test                     # Run tests

# View logs
tail -f output/logs/app-*.log
tail -f output/logs/error-*.log

# Database (always source .env first)
set -a && source .env && set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"

# Run migration (always include .env sourcing in one command)
set -a && source .env && set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/migrations/XXX_name.sql
```

---

## Architecture Overview

```
/home/user/SquareDashboardTool/
├── server.js            # Route setup, middleware (~1,000 lines)
├── config/constants.js  # Centralized configuration
├── routes/              # 24 modules, ~257 routes
├── middleware/          # auth, merchant, security, validators/
├── services/            # Business logic
│   ├── webhook-processor.js
│   ├── webhook-handlers/ (8 handlers)
│   ├── loyalty-admin/   # Loyalty program admin (modular - see below)
│   ├── seniors/         # Seniors discount automation
│   ├── catalog/         # Catalog data management
│   └── bundle-calculator.js  # Bundle order optimization
├── jobs/                # Cron tasks
└── utils/               # database, logger, helpers
```

**Middleware Stack**: `Request → requireAuth → loadMerchantContext → requireMerchant → validators.* → Handler`

### Loyalty-Admin Module Structure

The `services/loyalty-admin/` directory contains 21 modular services (61 exports). The legacy monolith and dead modern layer have been fully eliminated.

**Usage**: Always import from the index: `const loyaltyAdmin = require('./services/loyalty-admin');`

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md#loyalty-admin-modules) for module details and dependency rules.

---

## New Code Checklists

### New Route
1. Create validator in `middleware/validators/routename.js`
2. Create route file in `routes/routename.js` using `asyncHandler`
3. Add to `server.js`
4. Write tests in `__tests__/routes/routename.test.js`

### New Database Table
1. Add to `database/schema.sql`
2. Create migration `database/migrations/XXX_description.sql`
3. Include `merchant_id INTEGER REFERENCES merchants(id)` column
4. Add composite index with merchant_id as leading column

---

## Common Issues

| Issue | Solution |
|-------|----------|
| "relation does not exist" | Run missing migration |
| "Cannot find module" | `npm install` |
| "merchant_id cannot be null" | Add `requireMerchant` middleware |
| Session issues after deploy | `pm2 restart square-dashboard-addon` |
| Square API "ITEM_AT_LOCATION not found" | Use `POST /api/catalog-audit/enable-item-at-locations` to enable item at all active locations |

---

## Detailed Documentation

| Document | Contents |
|----------|----------|
| [docs/TECHNICAL_DEBT.md](./docs/TECHNICAL_DEBT.md) | P0/P1/P2/P3 status, roadmap to A++ |
| [docs/SECURITY_AUDIT.md](./docs/SECURITY_AUDIT.md) | Vulnerability history, fixes, security best practices |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Webhook flow, services structure, loyalty-admin modules |
| [docs/CODE_AUDIT_REPORT.md](./docs/CODE_AUDIT_REPORT.md) | Security audit findings and fix status |
| [docs/DEDUP-AUDIT.md](./docs/DEDUP-AUDIT.md) | Codebase deduplication audit (2026-02-17) — 18 findings, 10 fixed |
| [REMEDIATION-PLAN.md](./REMEDIATION-PLAN.md) | Master remediation plan — all packages, backlog items, observation logs |
| [docs/archive/](./docs/archive/) | Completed work: EVENT_DELEGATION, API_OPTIMIZATION_PLAN, API_CACHING_STRATEGY |

---

## Current Status

**Grade**: A+ (All P0 and P1 issues FIXED)
**Last Review**: 2026-02-19

| Priority | Status |
|----------|--------|
| P0 Security | 7/7 Complete |
| P0-4 CSP Phase 2 | 29/29 Complete (100%) |
| P1 Architecture | 9/9 Complete |
| P2 Testing | 6/6 Complete |
| API Optimization | 4/4 Complete |
| P1-1 Loyalty Migration | Complete (monolith eliminated) |
| Bundle Reorder System | Complete (new feature) |
| P3 Scalability | Optional |

### Backlog — Open Items

| Priority | Item | Description |
|----------|------|-------------|
| High | BACKLOG-39 | Vendor bill-back tracking — track promotional discounts funded by vendors. Need: `vendor_billbacks` table (item, discount_pct, date_range, vendor_id, expected_credit, status), reporting view for claim submission. Revenue recovery feature — independent retailers routinely lose bill-back credits. Auto-log when BACKLOG-38 promotions run with `vendor_billback_flag` = true. |
| Medium | BACKLOG-4 | Customer birthday sync for marketing |
| Medium | BACKLOG-1 | Frontend polling rate limits |
| ~~Medium~~ | ~~BACKLOG-13~~ | ~~Move custom attribute initialization from startup to tenant onboarding~~ **DONE** (2026-02-23) |
| ~~Medium~~ | ~~BACKLOG-22~~ | ~~Available vs total stock inconsistency in days-of-stock (DEDUP R-3)~~ **DONE** (2026-02-23) |
| ~~Medium~~ | ~~BACKLOG-28~~ | ~~Wire vendor dashboard per-vendor config into reorder formula~~ **DONE** (2026-02-24) |
| Low | BACKLOG-3 | Response format standardization |
| ~~Low~~ | ~~BACKLOG-5~~ | ~~Rapid-fire webhook duplicate processing~~ **DONE** (2026-02-19) |
| ~~Low~~ | ~~BACKLOG-7~~ | ~~Loyalty audit job per-event Square API calls (batch optimization)~~ **DONE** (2026-02-19) |
| Low | BACKLOG-8 | Vendor management — pull vendor data from Square |
| Low | BACKLOG-9 | In-memory global state — PM2 restart recovery (HIGH-4) — investigated, no immediate action needed |
| Low | BACKLOG-12 | Driver share link validation failure |
| Low | BACKLOG-17 | Customer lookup helpers duplicated between loyalty layers (DEDUP L-4) |
| ~~Low~~ | ~~BACKLOG-21~~ | ~~Days-of-stock calculation — 5 implementations (DEDUP R-2)~~ **DONE** (2026-02-23) |
| Low | BACKLOG-23 | Currency formatting — no shared helper, 14+ files (DEDUP G-3) |
| ~~Low~~ | ~~BACKLOG-24~~ | ~~Order normalization boilerplate in order-handler.js (DEDUP G-4)~~ **CLOSED** (2026-02-19, intentional — see archive) |
| Low | BACKLOG-25 | Location lookup queries repeated across 6 routes (DEDUP G-5) |
| Low | BACKLOG-26 | Date string formatting pattern repeated 12 times (DEDUP G-7) |
| Low | BACKLOG-27 | Inconsistent toLocaleString() — 60 uses, mixed locales (DEDUP G-8) |
| Low | BACKLOG-29 | Existing tenants missing `invoice.payment_made` webhook subscription |
| ~~Low~~ | ~~BACKLOG-33~~ | ~~New variation velocity warning badge on reorder page~~ **DONE** (2026-02-24) |
| Low | BACKLOG-34 | Documentation: Square reuses variation IDs when POS reorders delete/recreate variations. New variation may inherit historical order data on next velocity sync. Workaround: BACKLOG-33 flag. |
| ~~Low~~ | ~~BACKLOG-32~~ | ~~Frontend hardcoded expiry tier thresholds in reorder.js and expiry-discounts.js~~ **DONE** (2026-02-23) |
| Low | BACKLOG-35 | Sales velocity does not subtract refunds — `syncSalesVelocity` fetches orders only, ignores refunds; net sales should be order qty minus refunded qty; impact low (~2 refunds/day), velocity slightly inflated on refunded items |
| Medium | BACKLOG-36 | Phantom velocity rows never self-correct — `syncSalesVelocity` only upserts variations that appear in orders; variations with 0 sales are never written so stale rows persist forever; fix: DELETE FROM sales_velocity WHERE variation_id NOT IN (processed keys) AND period_days/merchant_id match; affects reorder suggestions and slow-mover flags; Tier 1 — implement next velocity sync touch |
| ~~Medium~~ | ~~BACKLOG-37~~ | ~~Expiry audit assumes all units expired~~ **DONE** (2026-03-01) |
| Medium | BACKLOG-38 | Timed discount automation — apply/remove Square discount objects (pricing rules) on a cron schedule, bypassing Square's broken native timed discount feature (shows "on sale" badge but displays regular price — confirmed bug, reported multiple times, unfixed). SqTools controls the timing, Square handles the display. Base prices never change. Reuse expiry discount cron pattern for scheduling. Need: `promotions` table (items, discount_type, discount_amount, start_date, end_date, vendor_billback_flag), cron job to apply/remove. Support recurring/template promotions (e.g. "March Flyer" — copy previous year, adjust items, auto-schedule). Ties to BACKLOG-39 for vendor bill-back tracking when `vendor_billback_flag` is true. |
| Low | BACKLOG-40 | exceljs pulls deprecated transitive deps (inflight, rimraf, glob, fstream, lodash.isequal) — evaluate replacing with lighter xlsx/csv library before open-source launch; Jest also pulls glob@7 but dev-only |
| Medium | BACKLOG-41 | User access control with roles — manager, clerk, accountant permissions. Per-user action logging. Required for multi-user SaaS deployment. Prerequisite for franchise model. |
| Medium | BACKLOG-42 | Barcode scan-to-count for cycle counts — accept wireless/wired barcode scanner input during cycle count workflow. Existing cycle count system handles the logic, just needs scanner input support on frontend. |
| Low | BACKLOG-43 | Min/Max stock per item per location — may already be partially implemented via Square's inventory alert thresholds. Investigate: how does Square store min/max per location? Does `setSquareInventoryAlertThreshold` already handle this? If so, this may just need reorder logic to respect the max cap when calculating order quantities. Explore before building anything new. |
| Medium | BACKLOG-44 | Purchase order generation with branding — generate printable/emailable POs with merchant logo. Current reorder workflow calculates what to order but doesn't produce a formal PO document. |
| Medium | BACKLOG-45 | Spreadsheet bulk upload — import/update inventory via CSV or Google Sheets. Lowers onboarding barrier for new merchants migrating from manual tracking. |
| Low | BACKLOG-46 | QuickBooks daily sync — auto-sync daily sales summaries and inventory data to QuickBooks Online. Retention feature for SaaS — every independent retailer uses QuickBooks. |
| Low | BACKLOG-47 | Multi-channel inventory sync — Shopify, WooCommerce, BigCommerce integration. Sync inventory across POS + e-commerce. Depends on multi-POS abstraction layer (post api.js split). |
| Low | BACKLOG-48 | Clover POS integration — expand beyond Square. Depends on multi-POS abstraction layer. |
| Low | BACKLOG-49 | Stripe payment integration — alternative payment processor support. |
| High | BACKLOG-50 | Post-trial conversion — $1 first month. When trial expires, offer first month at $1 to verify credit card without friction. Purpose: captures payment method, proves intent, minimal barrier. After $1 month, auto-convert to full price. Need: Square payment integration for SqTools subscriptions (using merchant's OWN Square account to charge them would be weird — need a separate SqTools Square account or Stripe for SaaS billing). This is the "System B" cleanup — current subscribers table has Square billing but disconnected from merchants. Decide: Stripe vs Square for SaaS billing before building this. |

### Backlog — Archive (Completed)

| Item | Description | Completed |
|------|-------------|-----------|
| BACKLOG-2 | Delivery routing webhook sync | 2026-02-12 (investigated — all working correctly) |
| BACKLOG-6 | Consolidate Square discount/pricing rule deletion code | 2026-02-06 (shared `utils/square-catalog-cleanup.js`, 21 tests) |
| BACKLOG-32 | Frontend hardcoded expiry tier thresholds in reorder.js and expiry-discounts.js | 2026-02-23 (reorder.js and expiry-discounts.js now load tier config from API, matching expiry-audit.js pattern) |
| BACKLOG-10 | Invoice-driven committed inventory | 2026-02-19 (invoice webhooks + daily reconciliation) |
| BACKLOG-11 | Subscribe to `customer.created` webhook | 2026-02-19 (handler + config wired) |
| BACKLOG-14 | Reorder formula duplication (DEDUP R-1) | 2026-02-17 (shared `services/catalog/reorder-math.js`, 31 tests) |
| BACKLOG-15 | Reward progress / threshold crossing (DEDUP L-2) | 2026-02-17 (split-row rollover ported to admin layer, 8 tests) |
| BACKLOG-16 | redeemReward() name collision (DEDUP L-3) | 2026-02-17 (dead code removed from loyalty layer) |
| BACKLOG-18 | Offer/variation query overlap (DEDUP L-5) | 2026-02-19 (shared `loyalty-queries.js`, fixed 3 missing `is_active` filters) |
| BACKLOG-19 | Dual Square API client layers (DEDUP L-6) | 2026-02-19 (unified `square-api-client.js`, 429 retry ported) |
| BACKLOG-20 | Redemption detection asymmetry (DEDUP L-7) | 2026-02-19 (audit job uses canonical `detectRewardRedemptionFromOrder()`) |
| BACKLOG-30 | Consolidate order processing paths | 2026-02-19 (`services/loyalty-admin/order-intake.js`, 14 tests) |
| BACKLOG-31 | Remove dead modern loyalty layer | 2026-02-19 (`services/loyalty/` deleted, active code migrated to `loyalty-admin/`) |
| BACKLOG-5 | Rapid-fire webhook duplicate processing | 2026-02-19 (in-memory event lock in webhook-processor.js, 60s auto-expire) |
| BACKLOG-24 | Order normalization boilerplate (DEDUP G-4) | 2026-02-19 (investigated — intentional; 3 call sites in order-handler.js serve different workflows with different pre-checks; `_fetchFullOrder()` already encapsulates common case) |
| BACKLOG-7 | Loyalty audit job batch optimization | 2026-02-19 (`batchFetchSquareOrders()` with concurrency control, no per-event API calls) |
| BACKLOG-13 | Move custom attribute init from startup to onboarding | 2026-02-23 (added `custom_attributes_initialized_at` column; startup skips initialized merchants) |
| BACKLOG-21 | Days-of-stock calculation — 5 implementations (DEDUP R-2) | 2026-02-23 (all 4 pages now subtract RESERVED_FOR_SALE committed inventory) |
| BACKLOG-22 | Available vs total stock inconsistency (DEDUP R-3) | 2026-02-23 (inventory-service, audit-service, bundles now use available_quantity like analytics.js) |
| BACKLOG-28 | Wire vendor per-vendor config into reorder formula | 2026-02-24 (reorder suggestions now pass per-vendor lead_time_days to formula; SQL + JS threshold include lead time; Lead Time column in reorder.html) |
| BACKLOG-33 | New variation velocity warning badge on reorder page | 2026-02-24 (display-only badge next to velocity for variations <7 days old; warns about unreliable velocity from Square ID reassignment) |
| BACKLOG-37 | Expiry audit partial-expiry workflow | 2026-03-01 (expired-pull modal asks "Are ALL units expired?"; full pull zeros inventory via Square API; partial pull updates remaining count + new expiry date; `POST /api/expirations/pull` endpoint; 10 tests) |

#### BACKLOG-8: Vendor Management — Pull Vendor Data from Square

**Context**: Vendor emails and contact info are currently NULL in `loyalty_offers`. The vendor receipt report shows N/A for vendor email because we're relying on a local `vendor_email` column that's never populated. Square is the source of truth for vendor data via the Vendors API.

**Files involved**:
- `services/reports/loyalty-reports.js` (generateVendorReceipt)
- `database/schema.sql` (loyalty_offers table)

**Proposed solution**:
- On offer creation/edit, link to Square vendor ID instead of storing vendor details locally
- When generating reports, fetch vendor contact details (email, company name, rep name) from Square Vendors API
- Fall back to N/A if vendor not set in Square
- Remove `vendor_email` column from `loyalty_offers` once migration is complete

**Audit date**: 2026-02-02

#### ~~BACKLOG-28: Wire Vendor Dashboard Per-Vendor Config Into Reorder Formula~~ (RESOLVED 2026-02-24)

Reorder suggestions endpoint (`routes/analytics.js`) now passes per-vendor `lead_time_days` from the vendors table into `calculateReorderQuantity()`. SQL WHERE clause includes per-vendor lead time in the threshold filter (`$1 + COALESCE(ve.lead_time_days, 0)`). JS-side filtering also uses per-vendor threshold. Response includes `vendor_default_supply_days` for visibility. Frontend `reorder.html` displays a "Lead Time" column showing each item's vendor lead time. Items without a vendor default to 0 lead time (matching vendor dashboard pattern). `reorder-math.js` JSDoc updated to reflect wiring is complete.

#### BACKLOG-29: Existing Tenants Missing `invoice.payment_made` Webhook Subscription

**Context**: `invoice.payment_made` was only in the `subscriptions` webhook event group, not `invoices`. New tenants onboarded via `getRecommendedEventTypes()` (which includes `invoices` but not `subscriptions`) would never receive `invoice.payment_made`, so the committed inventory cleanup fix would be inert. Fixed in code for future tenants — `invoice.payment_made` is now in both groups, and `getAllEventTypes()` dedupes.

**Remaining work**: Existing tenants' Square webhook subscriptions may not include `invoice.payment_made`. Need to re-register webhooks for all active merchants via the webhook management endpoint (or a one-time migration script).

**Files involved**:
- `utils/square-webhooks.js` (event groups — fixed)
- `routes/webhooks.js` (webhook re-registration endpoint)

**Priority**: Low (JTPets already has both groups enabled; affects future multi-tenant only)
**Effort**: S

**Audit date**: 2026-02-19

#### ~~BACKLOG-32: Frontend Hardcoded Expiry Tier Thresholds~~ (RESOLVED 2026-02-23)

Both `reorder.js` and `expiry-discounts.js` now load tier config from `/api/expiry-discounts/tiers` on page init, matching the correct pattern in `expiry-audit.js`. Hardcoded thresholds replaced with `getExpiryTierFromDays()` / `getTierFromDays()` using API-loaded `tierRanges`. Falls back to default thresholds if API call fails.

### Architectural Tech Debt

#### Unified Audit Logging

**Current state**: Audit trails are fragmented across feature-specific tables:
- `webhook_events` (webhook processing)
- `loyalty_audit_logs` (loyalty point changes)
- `loyalty_purchase_events` (purchase-triggered loyalty)
- `delivery_audit_log` (delivery state changes)
- `sync_history` (sync operations)

**Missing coverage**:
- Inventory changes (PO receives, adjustments, corrections)
- Catalog edits (price changes, item creation/deletion)
- Admin actions (manual overrides, settings changes)
- No unified "who, what, when, before/after" trail

**Impact**: Currently acceptable for single-store. Required before franchise deployment — franchisees need auditable change history and central visibility into per-location operations.

**Recommended approach**: Single `audit_log` table with columns for actor, action, entity_type, entity_id, before_value (JSONB), after_value (JSONB), merchant_id, created_at. Retrofit existing feature-specific audit tables as views or migrate data over time.

**Priority**: Low (single store), High (pre-franchise).

#### Subscription System Observations (2026-03-01)

Documented during subscription enforcement implementation. See `docs/MULTI-TENANT-AUDIT.md` for full audit.

| Finding | Status | Notes |
|---------|--------|-------|
| **System A vs System B disconnect** | KNOWN | `merchants` table (System A) and `subscribers` table (System B) are not linked. System A now enforced via `requireValidSubscription`. System B remains active but env-gated (`SUBSCRIPTION_CHECK_ENABLED`). Bridge them when implementing paid billing (BACKLOG-50). |
| **`subscriptionCheck` middleware (System B) is redundant** | KNOWN | Both `subscriptionCheck` (email-based) and `requireValidSubscription` (merchant-based) exist. System B can be removed once System A is fully proven in production. Keep both during beta as belt-and-suspenders. |
| **`merchants.subscription_status` never transitions automatically** | TODO | Status is set to 'trial' at creation but never auto-transitions to 'expired'. The `loadMerchantContext` middleware handles this dynamically by checking `trial_ends_at`, but the column itself stays stale. Consider a cron job to update status for cleaner admin reporting. |
| **Dead subscription UI routes** | LOW | `subscribe.html`, `subscription-expired.html` reference System B flows. May need updating for System A trial expiry UX. |
| **Second merchant connecting today** | SAFE | OAuth flow correctly sets trial_ends_at on INSERT, doesn't overwrite on re-auth. Subscription enforcement middleware grandfathers NULL trial_ends_at. All data queries filter by merchant_id. |

---

## PR Checklist

- [ ] No security vulnerabilities (parameterized queries, no error exposure)
- [ ] asyncHandler used (no manual try/catch in routes)
- [ ] merchant_id filter on ALL database queries
- [ ] Validators in `middleware/validators/`, not inline
- [ ] Business logic in services, not routes
- [ ] Tests added for new functionality
- [ ] Multi-step operations use transactions
