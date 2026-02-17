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

### Code Organization
```
routes/          → API endpoints (thin - validation + call service)
middleware/      → Auth, merchant context, validators, security
services/        → Business logic (loyalty/ has good examples)
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
│   ├── webhook-handlers/ (7 handlers)
│   ├── loyalty/         # Loyalty event logging
│   ├── loyalty-admin/   # Loyalty program admin (modular - see below)
│   ├── catalog/         # Catalog data management
│   └── bundle-calculator.js  # Bundle order optimization
├── jobs/                # Cron tasks
└── utils/               # database, logger, helpers
```

**Middleware Stack**: `Request → requireAuth → loadMerchantContext → requireMerchant → validators.* → Handler`

### Loyalty-Admin Module Structure

The `services/loyalty-admin/` directory contains 15 modular services (53 exports). The legacy monolith has been fully eliminated.

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
| [docs/archive/](./docs/archive/) | Completed work: EVENT_DELEGATION, API_OPTIMIZATION_PLAN, API_CACHING_STRATEGY |

---

## Current Status

**Grade**: A+ (All P0 and P1 issues FIXED)
**Last Review**: 2026-02-06

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

### Backlog (Target: TBD)

| Priority | Item | Description |
|----------|------|-------------|
| ~~High~~ | ~~BACKLOG-10~~ | ~~Invoice-driven committed inventory~~ **COMPLETE** (invoice webhooks + daily reconciliation) |
| ~~Medium-High~~ | ~~BACKLOG-2~~ | ~~Delivery routing webhook sync~~ **COMPLETE** (investigated 2026-02-12 — webhook→delivery ingestion, deduplication, route transactions, Square sync all working correctly) |
| ~~Medium~~ | ~~BACKLOG-11~~ | ~~Subscribe to `customer.created` webhook~~ **COMPLETE** (handler + config already wired) |
| Medium | BACKLOG-4 | Customer birthday sync for marketing |
| Medium | BACKLOG-1 | Frontend polling rate limits |
| ~~Medium~~ | ~~BACKLOG-6~~ | ~~Consolidate Square discount/pricing rule deletion code~~ **COMPLETE** (shared `utils/square-catalog-cleanup.js`, 21 tests) |
| Low | BACKLOG-3 | Response format standardization |
| Low | BACKLOG-5 | Rapid-fire webhook duplicate processing |
| Low | BACKLOG-7 | Loyalty audit job per-event Square API calls |
| Low | BACKLOG-8 | Vendor management — pull vendor data from Square |
| Low | BACKLOG-9 | In-memory global state — PM2 restart recovery (HIGH-4) — **investigated 2026-02-12**, no immediate action needed (see TECHNICAL_DEBT.md) |
| Low | BACKLOG-12 | Driver share link validation failure |
| Medium | BACKLOG-13 | Move custom attribute initialization from startup to tenant onboarding |
| Medium | BACKLOG-14 | Reorder formula duplication between analytics.js and vendor-dashboard.js |

#### BACKLOG-7: Loyalty Audit Job Per-Event Square API Calls

**Context**: `orderHasOurDiscount()` in `jobs/loyalty-audit-job.js` fetches the full order via Square API for every `REDEEM_REWARD` event to check if it's our custom discount. At current volume (2-5 events per 48h window) this is fine, but a backfill audit over weeks/months would hit Square API rate limits.

**Files involved**:
- `jobs/loyalty-audit-job.js:orderHasOurDiscount()` (lines 152-178)

**Proposed solution**: Batch fetch orders using Square's `BatchRetrieveOrders` endpoint (up to 100 per call) instead of individual gets. Collect all order IDs from events first, batch fetch, then check discounts in memory.

**Audit date**: 2026-02-02

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

---

## PR Checklist

- [ ] No security vulnerabilities (parameterized queries, no error exposure)
- [ ] asyncHandler used (no manual try/catch in routes)
- [ ] merchant_id filter on ALL database queries
- [ ] Validators in `middleware/validators/`, not inline
- [ ] Business logic in services, not routes
- [ ] Tests added for new functionality
- [ ] Multi-step operations use transactions
