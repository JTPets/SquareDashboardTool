# CLAUDE.md - JTPets Square Dashboard Tool

## Project Overview

Multi-tenant SaaS inventory management system for Square POS. Built for JTPets.ca (pet food/supplies with free local delivery) with goal of SaaS revenue. Running on Raspberry Pi.

## Tech Stack

- **Runtime**: Node.js 18+ with Express.js
- **Database**: PostgreSQL 15
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
const { sendSuccess, sendError, sendPaginated } = require('../utils/response-helper');

// Success — flat-merges data with { success: true }
sendSuccess(res, { count: 5, items: [...] });
// → { success: true, count: 5, items: [...] }

// Error
sendError(res, 'message', 400, 'ERROR_CODE');
// → { success: false, error: 'message', code: 'ERROR_CODE' }

// Paginated
sendPaginated(res, { items: [...], total: 100, limit: 20, offset: 0 });
// → { success: true, items: [...], total: 100, limit: 20, offset: 0 }
```

> All routes use `utils/response-helper.js`. Do not use raw `res.json()` for new endpoints.

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
| New features | Tests required in same commit — no exceptions |
| Complexity | Explainable in one sentence |
| Dependencies | `npm install --save` or `--save-dev` only — never manually edit package.json. Commit package.json and package-lock.json together in the same commit as the code requiring the new dependency. |
| Env vars | Any new `process.env.X` reference MUST have a corresponding entry in `.env.example` with a placeholder value and descriptive comment. |
| HTML pages | Every new HTML page MUST include shared utility scripts before page-specific scripts. Only include utilities the page's JS actually uses. Required order: `escape.js` → `toast.js` → `format-currency.js` → `date-format.js` → `your-page.js`. The test in `__tests__/frontend/utility-script-tags.test.js` enforces this — `npm test` will fail if a utility function is called but the script tag is missing. |

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

#### Refactor-on-Touch: Files Over 500 Lines
Before modifying any file over 500 lines, produce a **module breakdown map** (filename, responsibility, line range, dependencies, extraction risk) and include it in the PR description or commit message. This ensures refactoring is planned, not ad-hoc. The map does not require immediate extraction — it documents the path for future work.

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
├── routes/              # 28 modules, ~260 routes
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

The `services/loyalty-admin/` directory contains 41 modular services. The legacy monolith and dead modern layer have been fully eliminated.

**Usage**: Always import from the index: `const loyaltyAdmin = require('./services/loyalty-admin');`

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md#loyalty-admin-modules) for module details and dependency rules.

---

## New Code Checklists

### New Route
1. Create validator in `middleware/validators/routename.js`
2. Create route file in `routes/routename.js` using `asyncHandler`
3. Add to `server.js`
4. **Write tests in `__tests__/routes/routename.test.js` — mandatory, must be in the same commit**

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
| [docs/TECHNICAL_DEBT.md](./docs/TECHNICAL_DEBT.md) | Known issues, observations, deferred work |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Webhook flow, services structure, loyalty-admin modules |
| [docs/PRIORITIES.md](./docs/PRIORITIES.md) | Active HIGH/MEDIUM/LOW priority work items |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Future initiatives and planned features |
| [docs/WORK-ITEMS.md](./docs/WORK-ITEMS.md) | Consolidated master work list (all open items) |

---

## Current Status

**Grade**: A+ (All P0 and P1 issues FIXED)
**Last Review**: 2026-03-15

| Priority | Status |
|----------|--------|
| P0 Security | 7/7 Complete |
| P0-4 CSP Phase 2 | 29/29 Complete (100%) |
| P1 Architecture | 9/9 Complete |
| P2 Testing | 6/6 Complete |
| API Optimization | 4/4 Complete |
| P1-1 Loyalty Migration | Complete (monolith eliminated) |
| Bundle Reorder System | Complete (new feature) |
| Total Test Coverage | 4,035 tests / 187 suites / 0 failures (2026-03-15) |
| Loyalty-Admin Test Coverage | 857+ tests (2026-03-15) |
| P3 Scalability | Optional |

### Backlog — Open Items

See [docs/WORK-ITEMS.md](docs/WORK-ITEMS.md) for the complete consolidated work list with all open items from all sources.

| Priority | Item | Description |
|----------|------|-------------|
| High | BACKLOG-50 | Post-trial conversion — $1 first month. Decide Stripe vs Square for SaaS billing |
| High | BACKLOG-39 | Vendor bill-back tracking — `vendor_billbacks` table, reporting for claim submission |
| High | BACKLOG-61 | GMC v1beta → v1 migration — Google Shopping feed broken since Feb 28 2026. **P0** |
| Medium | BACKLOG-38 | Timed discount automation — cron-scheduled Square pricing rules |
| Medium | BACKLOG-41 | User access control with roles — manager, clerk, accountant. Prerequisite for franchise |
| Medium | BACKLOG-42 | Barcode scan-to-count for cycle counts |
| Medium | BACKLOG-44 | Purchase order generation with branding |
| Medium | BACKLOG-45 | Spreadsheet bulk upload — CSV/Google Sheets inventory import |
| Medium | BACKLOG-51 | Demo account — read-only dashboard view for sales demos |
| Medium | BACKLOG-55 | VIP customer auto-discounts via Square customer groups |
| Medium | BACKLOG-63 | Caption auto-generation for Square Online product images (Claude API) |
| Medium | BACKLOG-53 | Employee KPI coaching dashboard |
| Medium | BACKLOG-54 | Employee auto-discounts via Square pricing rules |
| Medium | BACKLOG-64 | Audit Square `sold_out` flag vs inventory = 0 |
| Medium | BACKLOG-65 | Sync Square Online Store category assignments |
| Medium | BACKLOG-69 | Extract duplicate discount fix pattern in discount-validation-service.js |
| Medium | BACKLOG-71 | Extract `_analyzeOrders` from order-history-audit-service.js |
| Medium | BACKLOG-73 | Vendor receipt display bug — multi-redemption same order |
| Medium | BACKLOG-4 | Customer birthday sync for marketing |
| Medium | BACKLOG-1 | Frontend polling rate limits |
| Low | BACKLOG-3 | Response format standardization |
| Low | BACKLOG-8 | Vendor management — pull vendor data from Square Vendors API |
| Low | BACKLOG-9 | In-memory global state — PM2 restart recovery |
| Low | BACKLOG-12 | Driver share link validation failure |
| Low | BACKLOG-17 | Customer lookup helpers duplicated (DEDUP L-4) |
| ~~Low~~ | ~~BACKLOG-23~~ | ~~Currency formatting — no shared helper (DEDUP G-3)~~ **FIXED** |
| ~~Low~~ | ~~BACKLOG-25~~ | ~~Location lookup queries repeated across 6 routes (DEDUP G-5)~~ **FIXED** |
| ~~Low~~ | ~~BACKLOG-26~~ | ~~Date string formatting repeated 12 times (DEDUP G-7)~~ **FIXED** |
| ~~Low~~ | ~~BACKLOG-27~~ | ~~Inconsistent toLocaleString() — 60 uses (DEDUP G-8)~~ **FIXED** |
| Low | BACKLOG-29 | Existing tenants missing `invoice.payment_made` webhook |
| Low | BACKLOG-34 | Doc: Square reuses variation IDs on POS reorder |
| Low | BACKLOG-40 | exceljs deprecated transitive deps — evaluate lighter library |
| Low | BACKLOG-43 | Min/Max stock per item per location |
| Low | BACKLOG-46 | QuickBooks daily sync |
| Low | BACKLOG-47 | Multi-channel inventory sync (Shopify, WooCommerce, BigCommerce) |
| Low | BACKLOG-48 | Clover POS integration |
| Low | BACKLOG-49 | Stripe payment integration |
| ~~Low~~ | ~~BACKLOG-57~~ | ~~Expiry discount daily re-apply noise~~ **FIXED** |
| ~~Low~~ | ~~BACKLOG-58~~ | ~~Inventory increase should trigger expiry re-verification~~ **FIXED** |
| Low | BACKLOG-66 | Customer email bounce tracking |
| Low | BACKLOG-70 | `syncRewardDiscountPrices` only updates upward |

### Architectural Tech Debt

#### Unified Audit Logging (Pre-Franchise)

Audit trails fragmented across `webhook_events`, `loyalty_audit_logs`, `delivery_audit_log`, `sync_history`. Missing: inventory changes, catalog edits, admin actions. Need single `audit_log` table. Low priority (single store), High (pre-franchise).

---

## PR Checklist

- [ ] No security vulnerabilities (parameterized queries, no error exposure)
- [ ] asyncHandler used (no manual try/catch in routes)
- [ ] merchant_id filter on ALL database queries
- [ ] Validators in `middleware/validators/`, not inline
- [ ] Business logic in services, not routes
- [ ] Tests added for new functionality
- [ ] Multi-step operations use transactions
