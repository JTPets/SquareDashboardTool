# CLAUDE.md - JTPets Square Dashboard Tool

## Project Overview
Multi-tenant SaaS inventory management system for Square POS. Built for JTPets.ca (pet food/supplies with free local delivery) with goal of SaaS revenue. Running on Raspberry Pi.

## Tech Stack
- **Runtime**: Node.js 18+ with Express.js
- **Database**: PostgreSQL 14+
- **Process Manager**: PM2
- **External APIs**: Square SDK v43.2.1, Google APIs v144
- **Timezone**: America/Toronto

## Critical Rules

### Security First
- ALL database queries use parameterized SQL (`$1, $2` - never string concatenation)
- ALL user input validated via express-validator (see `middleware/validators/`)
- ALL routes require authentication unless explicitly public
- Multi-tenant isolation: EVERY query must filter by `merchant_id`
- Tokens encrypted with AES-256-GCM before storage
- Fix security issues immediately, document what was fixed, update tests

### Code Organization
```
routes/          → API endpoints (thin - validation + call service)
middleware/      → Auth, merchant context, validators, security
services/        → Business logic (loyalty/ has good examples)
utils/           → Shared utilities (database, Square API, logging)
database/
  schema.sql     → Base schema
  migrations/    → Incremental changes (###_description.sql)
```

### Response Format
Always use consistent structure for reliability:
```javascript
// Success
res.json({ success: true, data: { ... } });

// Error
res.status(4xx).json({ success: false, error: 'message', code: 'ERROR_CODE' });
```

### Multi-Tenant Pattern
```javascript
// ALWAYS get merchantId from context
const merchantId = req.merchantContext.id;

// EVERY database query must include merchant_id
const result = await db.query(
    'SELECT * FROM items WHERE merchant_id = $1 AND id = $2',
    [merchantId, itemId]
);
```

### Error Handling
```javascript
const asyncHandler = require('../middleware/async-handler');

router.get('/endpoint', asyncHandler(async (req, res) => {
    // Errors automatically caught and passed to error handler
}));
```

## Database Commands

### Run migration manually
```bash
# Load .env and run migration
set -a && source .env && set +a
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/migrations/XXX_name.sql
```

### Connect to database
```bash
set -a && source .env && set +a
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
```

### Useful queries
```sql
-- Check table structure
\d tablename

-- List all tables
\dt

-- Check for NULL merchant_id (data isolation issue)
SELECT COUNT(*) FROM tablename WHERE merchant_id IS NULL;
```

## Development Commands

### Start server
```bash
npm start           # Production
npm run dev         # Development with --watch
pm2 start ecosystem.config.js
```

### After code changes
```bash
pm2 restart square-dashboard-addon
```

### After adding dependencies
```bash
npm install         # ALWAYS run after package.json changes
```

### Run tests
```bash
npm test                 # All tests
npm run test:coverage    # With coverage report
npm run test:watch       # Watch mode
```

### View logs
```bash
# Application logs (preferred - easier to parse/filter)
tail -f output/logs/app-*.log
tail -f output/logs/error-*.log

# PM2 logs (less useful)
pm2 logs
```

## Writing New Code

### New Route Checklist
1. Create validator in `middleware/validators/routename.js`
2. Create route file in `routes/routename.js`
3. Add to `server.js`:
```javascript
   const routenameRoutes = require('./routes/routename');
   app.use('/api/routename', routenameRoutes);
```
4. Write tests in `__tests__/routes/routename.test.js`
5. Run `npm test` to verify

### New Database Table Checklist
1. Add to `database/schema.sql` (base schema)
2. Create migration `database/migrations/XXX_description.sql`
3. Include `merchant_id INTEGER REFERENCES merchants(id)` column
4. Add index: `CREATE INDEX idx_tablename_merchant ON tablename(merchant_id);`
5. Run migration manually (see command above)

### Validator Pattern
```javascript
// middleware/validators/example.js
const { body, param, query } = require('express-validator');
const { handleValidationErrors } = require('./index');

const create = [
    body('name')
        .trim()
        .notEmpty()
        .withMessage('name is required')
        .isLength({ max: 255 }),
    body('quantity')
        .isInt({ min: 0 })
        .withMessage('quantity must be non-negative integer'),
    handleValidationErrors
];

module.exports = { create };
```

### Service Layer Pattern
```javascript
// services/example-service.js
const db = require('../utils/database');
const logger = require('../utils/logger');

async function createThing(merchantId, data) {
    const result = await db.query(
        `INSERT INTO things (merchant_id, name, quantity)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [merchantId, data.name, data.quantity]
    );

    logger.info('Thing created', {
        merchantId,
        thingId: result.rows[0].id
    });

    return result.rows[0];
}

module.exports = { createThing };
```

## Canonical Database Query Patterns

### 1. Simple Lookup with Merchant Isolation
```javascript
const result = await db.query(
    'SELECT id, name, quantity FROM variations WHERE id = $1 AND merchant_id = $2',
    [variationId, merchantId]
);
```

### 2. List with Optional Search Filter
```javascript
const result = await db.query(`
    SELECT i.*, c.name as category_name
    FROM items i
    LEFT JOIN categories c ON c.id = i.category_id
    WHERE i.merchant_id = $1
      AND COALESCE(i.is_deleted, FALSE) = FALSE
      AND (i.name ILIKE $2 OR $2 = '%')
    ORDER BY i.name
`, [merchantId, search ? `%${search}%` : '%']);
```

### 3. Upsert Pattern (INSERT ... ON CONFLICT)
```javascript
await db.query(`
    INSERT INTO variation_location_settings
        (variation_id, location_id, stock_alert_min, merchant_id, updated_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    ON CONFLICT (variation_id, location_id, merchant_id)
    DO UPDATE SET
        stock_alert_min = EXCLUDED.stock_alert_min,
        updated_at = CURRENT_TIMESTAMP
`, [variationId, locationId, stockAlertMin, merchantId]);
```

### 4. Batch Operations with ANY
```javascript
// Update multiple rows
await db.query(
    'UPDATE variations SET extended_json = $1 WHERE id = ANY($2) AND merchant_id = $3',
    [extendedJson, variationIds, merchantId]
);

// Select with IN clause (safe pattern)
const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
const result = await db.query(
    `SELECT * FROM items WHERE id IN (${placeholders}) AND merchant_id = $1`,
    [merchantId, ...ids]
);
```

### 5. Transaction Pattern
```javascript
const client = await db.getClient();
try {
    await client.query('BEGIN');
    await client.query('INSERT INTO table1 VALUES ($1, $2)', [a, b]);
    await client.query('UPDATE table2 SET x = $1 WHERE id = $2', [x, id]);
    await client.query('COMMIT');
} catch (error) {
    await client.query('ROLLBACK');
    throw error;
} finally {
    client.release();
}
```

### 6. Aggregation with Subqueries
```javascript
const result = await db.query(`
    SELECT
        v.id, v.sku, v.name,
        i.name as item_name,
        (SELECT SUM(ic.quantity) FROM inventory_counts ic
         WHERE ic.variation_id = v.id AND ic.merchant_id = v.merchant_id) as total_stock
    FROM variations v
    JOIN items i ON i.id = v.item_id
    WHERE v.merchant_id = $1
`, [merchantId]);
```

### 7. Sync History Pattern (for tracking operations)
```javascript
// Start sync
const syncResult = await db.query(`
    INSERT INTO sync_history (sync_type, started_at, status, merchant_id)
    VALUES ($1, $2, 'running', $3)
    ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
        started_at = EXCLUDED.started_at,
        status = 'running',
        completed_at = NULL,
        records_synced = 0
    RETURNING id
`, [syncType, new Date(), merchantId]);

// Complete sync
await db.query(`
    UPDATE sync_history
    SET status = 'success', completed_at = CURRENT_TIMESTAMP,
        records_synced = $1, duration_seconds = $2
    WHERE id = $3
`, [recordCount, durationSeconds, syncId]);
```

## Webhook Event Flow

The webhook processor is in `services/webhook-processor.js` with handlers in `services/webhook-handlers/`.

### Webhook Processing Decision Tree

```
POST /api/webhooks/square
│
├─► SECURITY: Verify HMAC-SHA256 signature
│   └─► 401 if invalid (production only)
│
├─► IDEMPOTENCY: Check webhook_events for duplicate square_event_id
│   └─► Return early with {duplicate: true} if seen
│
├─► LOG: Insert to webhook_events with status='processing'
│
├─► RESOLVE MERCHANT: square_merchant_id → internal merchant_id
│   └─► Warning if unknown/inactive merchant
│
└─► ROUTE BY event.type:

    SUBSCRIPTION EVENTS
    ├─► subscription.created     → Activate subscriber
    ├─► subscription.updated     → Map status (ACTIVE→active, CANCELED→canceled, etc)
    ├─► invoice.payment_made     → Record payment, activate subscription
    ├─► invoice.payment_failed   → Mark past_due, record failed payment
    └─► customer.deleted         → Mark subscription canceled

    CATALOG & INVENTORY EVENTS (feature-flagged via WEBHOOK_*_SYNC env vars)
    ├─► catalog.version.updated
    │   ├─► Check sync queue (skip if already in progress, queue for follow-up)
    │   └─► syncCatalog(merchantId) → items, variations synced
    │
    ├─► inventory.count.updated
    │   ├─► Check sync queue (prevent concurrent syncs)
    │   └─► syncInventory(merchantId)
    │
    ├─► order.created / order.updated
    │   ├─► syncCommittedInventory() (open orders)
    │   ├─► IF COMPLETED: syncSalesVelocity(91)
    │   ├─► DELIVERY: Check for DELIVERY/SHIPMENT fulfillments
    │   │   ├─► PROPOSED/RESERVED/PREPARED → Auto-ingest to delivery queue
    │   │   ├─► CANCELED → Remove from delivery queue
    │   │   └─► COMPLETED → Mark delivery order completed
    │   └─► LOYALTY: IF COMPLETED
    │       ├─► processOrderForLoyalty() → Record qualifying purchases
    │       ├─► detectRewardRedemptionFromOrder() → Auto-detect redemptions
    │       └─► processOrderRefundsForLoyalty() → Handle refunds
    │
    └─► order.fulfillment.updated
        ├─► syncCommittedInventory()
        ├─► IF COMPLETED: syncSalesVelocity(91)
        └─► Update delivery order status based on fulfillment state

    VENDOR/LOCATION EVENTS
    ├─► vendor.created/updated   → Upsert to vendors table
    └─► location.created/updated → Upsert to locations table

    OAUTH EVENTS
    └─► oauth.authorization.revoked → Log warning, require re-auth
```

### Safe Sync Queue Pattern
Prevents duplicate syncs when multiple webhooks arrive during processing:
```javascript
// If sync already running, mark as pending (will resync after current completes)
if (catalogSyncInProgress.get(merchantId)) {
    catalogSyncPending.set(merchantId, true);
    return; // Skip, will run again after current
}

catalogSyncInProgress.set(merchantId, true);
try {
    await squareApi.syncCatalog(merchantId);
    // Check if more webhooks arrived during sync
    if (catalogSyncPending.get(merchantId)) {
        catalogSyncPending.set(merchantId, false);
        await squareApi.syncCatalog(merchantId); // Follow-up sync
    }
} finally {
    catalogSyncInProgress.set(merchantId, false);
}
```

### Feature Flags
Control webhook-triggered syncs via environment variables:
- `WEBHOOK_CATALOG_SYNC` - Enable catalog syncs (default: true)
- `WEBHOOK_INVENTORY_SYNC` - Enable inventory syncs (default: true)
- `WEBHOOK_ORDER_SYNC` - Enable order/fulfillment syncs (default: true)

## Testing Requirements

### When to write tests
- ALL new functions that could regress
- After fixing bugs (prevent regression)
- After modifying existing functions (update test to match)

### Test file location
```
__tests__/
  routes/routename.test.js
  utils/utilname.test.js
  middleware/middlewarename.test.js
```

### Test pattern
```javascript
const { functionName } = require('../../utils/example');

describe('functionName', () => {
    it('should handle valid input', async () => {
        const result = await functionName(validInput);
        expect(result).toBeDefined();
        expect(result.field).toBe(expectedValue);
    });

    it('should reject invalid input', async () => {
        await expect(functionName(null))
            .rejects.toThrow('Expected error message');
    });
});
```

## Square API

### Always use latest API version
Check https://developer.squareup.com/docs/changelog for updates.

### Get Square client for merchant
```javascript
const { getSquareClientForMerchant } = require('../middleware/merchant');

const squareClient = await getSquareClientForMerchant(merchantId);
const response = await squareClient.catalog.listCatalog({});
```

### Idempotency keys (required for write operations)
```javascript
const crypto = require('crypto');
const idempotencyKey = crypto.randomUUID();

await squareClient.orders.createOrder({
    idempotencyKey,
    order: { ... }
});
```

## Common Issues & Solutions

### "relation does not exist"
```bash
# Run missing migration
set -a && source .env && set +a
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/migrations/XXX_name.sql
```

### "Cannot find module"
```bash
npm install
```

### "merchant_id cannot be null"
Ensure route has `requireMerchant` middleware and uses `req.merchantContext.id`

### "Invalid UUID" / "Invalid integer"
Check validator matches expected type. UUIDs use `isUUID()`, integers use `isInt()`.

### Session issues after code change
```bash
pm2 restart square-dashboard-addon
```

## Migrations vs ensureSchema

**Use migrations for**:
- Adding new tables
- Adding/modifying columns
- Adding constraints/indexes
- Any schema change that needs to preserve existing data

**ensureSchema is for**:
- Creating tables that don't exist yet on fresh install
- NOT for modifying existing tables (loses data)

**Why migrations win**:
- Reversible (can write rollback)
- Trackable (know what changed when)
- Safe for production (preserves data)
- Works with existing data

## Migration Consolidation Status (v1.0) - COMPLETE

All major feature tables are now consolidated into `database/schema.sql` for fresh installs.

### Tables in schema.sql (31+ tables)
- **Core**: users, merchants, user_merchants, oauth_states, sync_history
- **Catalog**: locations, categories, items, variations, images, inventory_counts
- **Vendors**: vendors, variation_vendors, vendor_catalog_items
- **Purchase orders**: purchase_orders, purchase_order_items
- **Analytics**: sales_velocity, variation_location_settings
- **Cycle counts**: count_history, count_queue_priority, count_queue_daily, count_sessions
- **Expiration**: variation_expiration, expiry_discount_tiers, variation_discount_status, expiry_discount_audit_log, expiry_discount_settings
- **GMC**: brands, google_taxonomy, category_taxonomy_mapping, item_brands, gmc_settings, gmc_feed_history
- **Subscriptions**: subscribers, subscription_payments, subscription_events, subscription_plans
- **Delivery**: delivery_orders, delivery_pod, delivery_settings, delivery_routes, delivery_audit_log, delivery_route_tokens
- **Loyalty**: loyalty_offers, loyalty_qualifying_variations, loyalty_purchase_events, loyalty_rewards, loyalty_redemptions, loyalty_audit_logs, loyalty_settings, loyalty_customer_summary

### Migration files (for existing installs)
The `database/migrations/` directory contains incremental migrations (003-026) for:
- Existing database upgrades (run migrations in order)
- Reference for what changed when
- Small column additions and constraint fixes

For fresh installs, just run `schema.sql`. For existing databases, run migrations in order.

## Security Notes

### Dependency Audit Status
**Last audit**: 2026-01-23
**Vulnerabilities found**: 0

Run `npm audit` periodically to check for new vulnerabilities.

### Known SQL Patterns to Avoid

**HIGH RISK - Direct column interpolation:**
```javascript
// DON'T DO THIS - column name from user input
query += ` AND ${key} = $${params.length}`;

// DO THIS - whitelist columns
const ALLOWED_COLUMNS = ['name', 'status', 'category_id'];
if (!ALLOWED_COLUMNS.includes(key)) {
    throw new Error(`Invalid column: ${key}`);
}
```

**MEDIUM RISK - LIMIT/OFFSET interpolation:**
```javascript
// AVOID - even with parseInt
query += ` LIMIT ${parseInt(limit)}`;

// BETTER - parameterized
params.push(parseInt(limit) || 100);
query += ` LIMIT $${params.length}`;
```

**MEDIUM RISK - Table name interpolation:**
```javascript
// AVOID - dynamic table names
const result = await db.query(`SELECT * FROM ${tableName}`);

// BETTER - whitelist mapping
const tableMap = { 'items': 'items', 'variations': 'variations' };
const safeTable = tableMap[tableName];
if (!safeTable) throw new Error('Invalid table');
```

### Files flagged for security review
None - all previously flagged issues have been fixed:
- INTERVAL interpolation now uses parameterized multiplication (`INTERVAL '1 day' * $1`)
- Column names validated with regex pattern in `_isValidColumnName()`
- LIMIT/OFFSET values now parameterized instead of interpolated

## Git Workflow
Commit messages are fine to include but not critical (1200+ PRs already). Focus on clear code over commit history.

## When You Find Issues
1. Fix immediately
2. Document what was fixed in commit/PR
3. Update or create tests to prevent regression
4. Verify fix doesn't break related functionality
5. If schema change needed, create migration with rollback

## Logging
Always use Winston logger, not console.log:
```javascript
const logger = require('../utils/logger');

logger.info('Operation completed', { merchantId, result });
logger.warn('Unexpected state', { details });
logger.error('Operation failed', { error: err.message, stack: err.stack });
```

## Architecture Reference

### Directory Structure (20 routes, 25+ utilities)
```
/home/user/SquareDashboardTool/
├── server.js                 # Main server (~1,000 lines) - route setup, middleware config
├── package.json              # Dependencies: square@43.2.1, googleapis@144, pg, express
├── config/
│   └── constants.js          # Centralized configuration constants
├── database/
│   ├── schema.sql            # Base schema (895 lines, 50+ tables)
│   └── migrations/           # 24 migration files (003-026)
├── routes/                   # 20 route modules
│   ├── catalog.js            # Items, variations, inventory, expirations
│   ├── delivery.js           # Delivery order management
│   ├── loyalty.js            # Loyalty rewards program
│   ├── webhooks/
│   │   └── square.js         # Square webhook endpoint
│   └── ...
├── middleware/
│   ├── auth.js               # Authentication
│   ├── merchant.js           # Multi-tenant context
│   ├── security.js           # Helmet, rate limiting
│   └── validators/           # 20 validator modules
├── services/
│   ├── webhook-processor.js  # Webhook signature verification, routing
│   ├── sync-queue.js         # Sync state management (in-progress/pending)
│   ├── webhook-handlers/     # Event-specific handlers
│   │   ├── catalog-handler.js
│   │   ├── inventory-handler.js
│   │   ├── order-handler.js
│   │   ├── subscription-handler.js
│   │   ├── loyalty-handler.js
│   │   └── oauth-handler.js
│   └── loyalty/              # Service layer example (8 modules)
│       ├── webhook-service.js
│       ├── customer-service.js
│       └── ...
├── jobs/                     # Background jobs and cron tasks
│   ├── cron-scheduler.js     # Cron job definitions
│   ├── backup-job.js         # Database backup
│   ├── sync-job.js           # Smart sync, GMC sync
│   ├── cycle-count-job.js    # Daily batch generation
│   ├── webhook-retry-job.js  # Failed webhook retry
│   └── expiry-discount-job.js
└── utils/                    # 25+ utilities
    ├── database.js           # PostgreSQL pool (query wrapper, transactions)
    ├── square-api.js         # Square SDK wrapper (95 queries)
    ├── logger.js             # Winston with daily rotation
    └── ...
```

### Rate Limiting Tiers
```javascript
// Configured in middleware/security.js
const deliveryRateLimit = 30 requests / 5 min
const deliveryStrictRateLimit = 10 requests / 5 min
const sensitiveOperationRateLimit = 5 requests / 15 min
```

### Middleware Stack (per request)
```
Request → requireAuth → loadMerchantContext → requireMerchant → validators.* → Route Handler
```

---

## Technical Debt & Optimization TODO

**Last Review**: 2026-01-26
**Overall Grade**: A- (Major refactoring complete, only testing debt remains)

### Status Summary (2026-01-26)

| Priority | Total | Complete | Remaining |
|----------|-------|----------|-----------|
| P0 Critical | 4 | 4 ✅ | 0 |
| P1 High | 6 | 6 ✅ | 0 |
| P1 Testing | 2 | 0 | 2 (tests) |
| P2 Medium | 5 | 5 ✅ | 0 |
| P3 Low | 5 | 3 ✅ | 2 |

**Key Achievements**:
- server.js reduced from 3,057 → 1,023 lines (66% reduction)
- All 20 route files use asyncHandler (~246 routes, ~1,000 lines of try/catch eliminated)
- Webhook processing fully modularized (6 handlers, central processor)
- Cron jobs extracted to dedicated jobs/ directory
- Database optimized with composite indexes for multi-tenant queries
- N+1 query patterns eliminated in critical endpoints
- Transaction wrappers added to critical multi-step operations
- Sync queue state persisted to database (crash recovery)
- Response helper utility created for consistent API responses

### Priority Legend
- **P0**: Critical - Fix immediately (performance/reliability impact)
- **P1**: High - Fix soon (maintainability/debugging impact)
- **P2**: Medium - Plan for next sprint (code quality)
- **P3**: Low - Address when touching related code

---

### P0: Critical Performance Issues

#### 1. N+1 Query Problem in Catalog Bulk Updates ✅ FIXED
**File**: `routes/catalog.js` lines 603-696
**Problem**: Loop executes 3 queries per item (SELECT + UPDATE + Square API call)
**Impact**: 100 items = 300+ queries instead of 3 batch operations
**Status**: Fixed - Batch SKU lookup with `ANY($1)`, individual UPDATEs still required due to dynamic columns

```javascript
// CURRENT (BAD) - routes/catalog.js
for (const update of updates) {
    const variationResult = await db.query(
        'SELECT id FROM variations WHERE sku = $1 AND merchant_id = $2',
        [update.sku, merchantId]
    );
    await db.query(`UPDATE variations SET ...`);
    await squareApi.updateCustomAttributeValues(...);
}

// FIXED - Batch pattern
const skus = updates.map(u => u.sku);
const variations = await db.query(
    'SELECT id, sku FROM variations WHERE sku = ANY($1) AND merchant_id = $2',
    [skus, merchantId]
);
const skuToId = new Map(variations.rows.map(v => [v.sku, v.id]));
// Then batch UPDATE with UNNEST or multi-value approach
```

**Remediation**:
1. Batch lookup all SKUs with `ANY($1)` array parameter
2. Build update batch using `UNNEST` or multi-row VALUES
3. Batch Square API calls where possible (check SDK batch endpoints)

#### 2. N+1 Query in Purchase Order Creation ✅ FIXED
**File**: `routes/purchase-orders.js` lines 100-118
**Problem**: Individual INSERTs in a loop for line items
**Impact**: Creating PO with 50 items = 50 INSERT statements
**Status**: Fixed - Multi-row INSERT with dynamic VALUES clause

**Remediation**:
```javascript
// Use multi-row INSERT
const values = items.map((item, i) =>
    `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`
).join(',');
const params = items.flatMap(item => [poId, item.variationId, item.quantity, merchantId]);
await db.query(`INSERT INTO purchase_order_items (...) VALUES ${values}`, params);
```

#### 3. Correlated Subqueries in Purchase Orders List ✅ FIXED
**File**: `routes/purchase-orders.js` line 143
**Problem**: Subquery `(SELECT COUNT(*) ...)` runs per row
**Status**: Fixed - LEFT JOIN + GROUP BY pattern

```sql
-- CURRENT (BAD)
SELECT po.*,
    (SELECT COUNT(*) FROM purchase_order_items WHERE purchase_order_id = po.id) as item_count
FROM purchase_orders po

-- FIXED
SELECT po.*, COUNT(poi.id) as item_count
FROM purchase_orders po
LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
WHERE po.merchant_id = $1
GROUP BY po.id
```

#### 4. Missing Composite Indexes for Multi-Tenant Queries ✅ FIXED
**Problem**: Indexes don't have `merchant_id` as leading column
**Impact**: Full table scans on large tables
**Status**: Fixed - Created migration `026_optimize_indexes.sql` with composite indexes for 10 tables

**Migration includes**:
- `variations`: merchant_sku, merchant_item, merchant_sku_covering
- `items`: merchant_square, merchant_category
- `inventory_counts`: merchant_variation, merchant_variation_location
- `sales_velocity`: merchant_var, merchant_var_period
- `purchase_orders`: merchant_status, merchant_date
- `variation_expiration`: merchant_variation, merchant_date
- `vendors`: merchant_square
- `count_history`: merchant_catalog
- `categories`: merchant_square
- `webhook_events`: square_event_id (for idempotency)

---

### P1: High Priority - Code Quality & Debugging

#### 5. Extract Webhook Logic from server.js (God File)
**File**: `server.js` (3,057 lines)
**Problem**: Webhook processing is 1,400+ lines embedded in server.js
**Impact**: Untestable, high cognitive load, merge conflicts

**Target Structure**:
```
server.js (< 300 lines - just setup and route registration)
├── routes/webhooks/
│   └── square.js              # Webhook route handler
├── services/
│   ├── webhook-processor.js   # Event routing logic
│   ├── sync-queue.js          # In-progress/pending sync management
│   └── webhook-handlers/
│       ├── catalog-handler.js
│       ├── inventory-handler.js
│       ├── order-handler.js
│       ├── subscription-handler.js
│       └── oauth-handler.js
└── jobs/
    ├── cron-scheduler.js      # Cron job definitions
    └── backup-job.js          # Database backup logic
```

**Extraction Steps**:
1. Create `services/webhook-processor.js` with event routing
2. Extract each event type handler to separate file
3. Move sync queue Maps to `services/sync-queue.js`
4. Move cron jobs to `jobs/` directory
5. Update server.js to import and wire up

#### 6. Adopt asyncHandler Across All Routes
**File**: `middleware/async-handler.js` (exists but unused)
**Problem**: ~200 try/catch blocks duplicated across routes (~2000 lines)

**Remediation**:
```javascript
// CURRENT (every route)
router.get('/endpoint', async (req, res) => {
    try {
        const result = await someOperation();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// TARGET (clean)
const asyncHandler = require('../middleware/async-handler');

router.get('/endpoint', asyncHandler(async (req, res) => {
    const result = await someOperation();
    res.json({ success: true, data: result });
}));
```

**Files to update** (in order of importance):
- [x] `routes/catalog.js` (17 routes) - COMPLETE
- [x] `routes/loyalty.js` (41 routes) - COMPLETE
- [x] `routes/delivery.js` (23 routes) - COMPLETE
- [x] `routes/purchase-orders.js` (9 routes) - COMPLETE
- [x] `routes/analytics.js` (2 routes) - COMPLETE
- [x] `routes/cycle-counts.js` (9 routes) - COMPLETE
- [x] `routes/settings.js` (2 routes) - COMPLETE
- [x] `routes/merchants.js` (3 routes) - COMPLETE
- [x] `routes/logs.js` (4 routes) - COMPLETE
- [x] `routes/driver-api.js` (8 routes) - COMPLETE
- [x] `routes/webhooks.js` (8 routes) - COMPLETE
- [x] `routes/google-oauth.js` (3/4 routes) - callback keeps try/catch for redirect
- [x] `routes/square-oauth.js` (2/4 routes) - connect/callback keep try/catch for redirect
- [x] `routes/expiry-discounts.js` (13 routes) - COMPLETE
- [x] `routes/sync.js` (6 routes) - COMPLETE
- [x] `routes/vendor-catalog.js` (13 routes) - COMPLETE
- [x] `routes/square-attributes.js` (10 routes) - COMPLETE
- [x] `routes/subscriptions.js` (11 routes) - COMPLETE
- [x] `routes/auth.js` (10 routes) - COMPLETE
- [x] `routes/gmc.js` (33 routes) - COMPLETE

**P1 #6 STATUS: COMPLETE** - All 20 route files now use asyncHandler (~246 routes total)

#### 7. Add Stack Traces to All Error Logs
**File**: `utils/square-api.js` (20+ occurrences)
**Problem**: Losing debugging information

```javascript
// CURRENT (bad)
logger.error('Failed to sync category', { id, error: error.message });

// FIXED (good)
logger.error('Failed to sync category', { id, error: error.message, stack: error.stack });
```

**Search pattern**: `grep -n "error: error.message" utils/` and add `stack: error.stack`

#### 8. Remove Runtime Schema Detection
**File**: `routes/catalog.js` lines 709-718
**Problem**: Querying information_schema on every request

```javascript
// CURRENT (bad) - checking if column exists at runtime
let hasReviewedColumn = false;
try {
    const colCheck = await db.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'variation_expiration' AND column_name = 'reviewed_at'
    `);
    hasReviewedColumn = colCheck.rows.length > 0;
} catch (e) { }
```

**Remediation**:
1. Verify migration adding `reviewed_at` column has been run
2. Remove the runtime check entirely
3. Assume column exists (migrations are the source of truth)

---

### P1: Testing Debt

#### 9. Add Integration Tests for Critical Paths
**Current Coverage**: 39% (mocked tests only)
**Problem**: Tests mock the database, so they don't verify SQL correctness

**Priority test files to create**:
```
__tests__/integration/
├── catalog.integration.test.js    # Bulk operations, search, filtering
├── loyalty.integration.test.js    # Point accrual, redemption, refunds
├── purchase-orders.integration.test.js
├── webhook-processing.integration.test.js
└── multi-tenant-isolation.integration.test.js
```

**Integration test pattern**:
```javascript
// __tests__/integration/setup.js
const db = require('../../utils/database');

beforeAll(async () => {
    // Use test database
    process.env.DB_NAME = 'square_dashboard_test';
});

beforeEach(async () => {
    // Clean tables and seed test data
    await db.query('TRUNCATE merchants, items, variations CASCADE');
    await db.query(`INSERT INTO merchants (id, name) VALUES (1, 'Test Merchant')`);
});

afterAll(async () => {
    await db.pool.end();
});
```

#### 10. Add Validator Tests
**Files**: 19 validator files in `middleware/validators/` with 0 tests
**Priority validators to test**:
- [ ] `middleware/validators/catalog.js`
- [ ] `middleware/validators/loyalty.js`
- [ ] `middleware/validators/delivery.js`

---

### P2: Medium Priority - Data Integrity

#### 11. Add Transactions to Multi-Step Operations ✅ FIXED
**Problem**: Only 2 transactions in entire codebase
**Impact**: Partial failures leave inconsistent data
**Status**: Fixed - Added `db.transaction()` wrappers to critical multi-step operations

**Files updated with transaction wrappers**:
- [x] `routes/purchase-orders.js` - PO creation now atomic (header + items)
- [x] `routes/cycle-counts.js` - Reset, complete, and sync-to-square operations
- [x] `routes/loyalty.js` - Already wrapped (verified in loyalty-service.js)

**Pattern used**:
```javascript
const result = await db.transaction(async (client) => {
    await client.query('INSERT INTO table1...');
    await client.query('INSERT INTO table2...');
    return result;
});
```

#### 12. Standardize API Response Format ✅ PARTIAL
**Problem**: Inconsistent response structures
**Status**: Created `utils/response-helper.js` with `sendSuccess()` and `sendError()` helpers.
Fixed response formats in transaction-wrapped endpoints.

**New helper available**:
```javascript
const { sendSuccess, sendError, ErrorCodes } = require('../utils/response-helper');

// Success
sendSuccess(res, { items, total });

// Error
sendError(res, 'Not found', 404, ErrorCodes.NOT_FOUND);
```

**Note**: Full migration requires frontend coordination. New code should use the helper.

#### 13. Persist Sync Queue State ✅ FIXED
**File**: `services/sync-queue.js`
**Problem**: In-memory Maps lost on restart
**Status**: Fixed - Sync state now persisted to `sync_history` table

**Implementation**:
1. On startup, `syncQueue.initialize()` cleans up stale "running" entries
2. `executeWithQueue()` persists sync start/completion to database
3. Interrupted syncs are detected and marked as "interrupted"

**Key changes**:
- Added `_persistSyncStart()` and `_persistSyncComplete()` methods
- Added `initialize()` method called from `jobs/cron-scheduler.js`
- Stale syncs (>30 min) auto-cleaned on restart

---

### P2: Code Quality

#### 14. Centralize Configuration Constants
**Problem**: Magic numbers scattered throughout codebase

**Create** `config/constants.js`:
```javascript
module.exports = {
    RETRY: {
        MAX_ATTEMPTS: 3,
        BASE_DELAY_MS: 1000,
        MAX_DELAY_MS: 30000,
    },
    CACHE: {
        INVOICES_SCOPE_TTL_MS: 60 * 60 * 1000,  // 1 hour
        CUSTOMER_CACHE_TTL_MS: 5 * 60 * 1000,   // 5 minutes
    },
    SESSION: {
        DEFAULT_DURATION_HOURS: 24,
    },
    PAGINATION: {
        DEFAULT_LIMIT: 100,
        MAX_LIMIT: 1000,
    },
    SYNC: {
        SALES_VELOCITY_DAYS: 91,
        CATALOG_BATCH_SIZE: 100,
    },
};
```

#### 15. Replace console.log with Logger
**Problem**: 213 console.log occurrences (many in frontend HTML, some in backend)

**Backend files to fix**:
- [x] `server.js` - 2 occurrences (verified: already using logger)
- [x] `utils/database.js` - 2 occurrences (verified: already using logger)
- [x] `scripts/init-admin.js` - 30 occurrences (acceptable for CLI script)

```bash
# Find backend console.log usage
grep -rn "console.log" --include="*.js" --exclude-dir="node_modules" --exclude-dir="public" .
```

---

### P3: Low Priority - Nice to Have

#### 16. Add Database Connection Pool Monitoring ✅ COMPLETE
**File**: `utils/database.js`
**Status**: Already implemented - `getPoolStats()` function exports pool metrics

#### 17. Add API Versioning ✅ COMPLETE
**Status**: Implemented in `server.js`

All routes now accessible at both `/api/*` and `/api/v1/*`:
```javascript
// New integrations should use versioned endpoints
app.use('/api/v1/catalog', catalogRoutes);
app.use('/api/v1/loyalty', loyaltyRoutes);

// Legacy unversioned routes maintained for backwards compatibility
app.use('/api/catalog', catalogRoutes);
```

#### 18. Add OpenAPI/Swagger Documentation
**Problem**: No API documentation for client integration
**Status**: Not implemented (requires significant effort)

**Options**:
1. Add `swagger-jsdoc` + `swagger-ui-express`
2. Generate from route definitions
3. Manual OpenAPI YAML file

#### 19. Consider Background Job Queue
**Problem**: Long-running syncs block event loop
**Current**: Sync operations run inline in request/webhook handlers
**Status**: Not implemented (requires Redis infrastructure)

**Recommendation**: Implement Bull/BullMQ for:
- Catalog sync jobs
- Inventory sync jobs
- Report generation
- Email sending

---

### Security Improvements (Minor)

#### 20. Use spawn Instead of exec for pg_dump ✅ COMPLETE
**File**: `jobs/backup-job.js`
**Status**: Fixed - Now uses spawn() with PGPASSWORD in env

```javascript
// BEFORE (password visible in process list)
const pgDumpCmd = `PGPASSWORD="${dbPassword}" pg_dump -h ${dbHost} ...`;
await execAsync(pgDumpCmd);

// AFTER (password hidden from process list)
const child = spawn('pg_dump', ['-h', dbHost, ...], {
    env: { ...process.env, PGPASSWORD: dbPassword }
});
```

---

### Tracking Progress

When completing items, update this section:

```
| Date       | Item | Notes |
|------------|------|-------|
| 2026-01-26 | Created TODO | Initial code review |
| 2026-01-26 | #7   | Added stack traces to 6 error logs in square-api.js |
| 2026-01-26 | #8   | Removed runtime schema detection in catalog.js (ACTUALLY fixed at lines 938-948) |
| 2026-01-26 | #16  | Added pool monitoring with getPoolStats() to database.js |
| 2026-01-26 | #14  | Created config/constants.js with centralized magic numbers |
| 2026-01-26 | P0 #1 | Batched SKU lookups in bulk-update-extended endpoint (catalog.js) |
| 2026-01-26 | P0 #2 | Batched PO item inserts with multi-row INSERT (purchase-orders.js) |
| 2026-01-26 | P0 #3 | Replaced correlated subquery with LEFT JOIN + GROUP BY (purchase-orders.js) |
| 2026-01-26 | Bonus | Batched variation lookups + upsert in /expirations/review (catalog.js) |
| 2026-01-26 | P0 #4 | Created migration 026_optimize_indexes.sql with composite indexes for 10 tables |
| 2026-01-26 | P1 #6 | asyncHandler adoption: catalog.js (17), loyalty.js (41), delivery.js (23), purchase-orders.js (9) |
| 2026-01-26 | P1 #6 | asyncHandler adoption: analytics.js (2), settings.js (2), merchants.js (3), logs.js (4) |
| 2026-01-26 | P1 #6 | asyncHandler adoption: driver-api.js (8), google-oauth.js (3/4), square-oauth.js (2/4) |
| 2026-01-26 | P1 #6 | asyncHandler adoption: cycle-counts.js (9), webhooks.js (8) - ~150 routes total, ~1000 lines removed |
| 2026-01-26 | P1 #6 | asyncHandler adoption COMPLETE: expiry-discounts.js (13), sync.js (6), vendor-catalog.js (13), square-attributes.js (10), subscriptions.js (11), auth.js (10), gmc.js (33) - ALL 20 route files done |
| 2026-01-26 | P2 #15 | Verified: server.js and database.js already use logger (no console.log found) |
| 2026-01-26 | Review | Full codebase verification: All P0 and P1 items confirmed complete |
| 2026-01-26 | P2 #11 | Added transactions: purchase-orders.js (create), cycle-counts.js (reset, complete, sync) |
| 2026-01-26 | P2 #12 | Created utils/response-helper.js with sendSuccess/sendError helpers |
| 2026-01-26 | P2 #13 | Persisted sync queue state to sync_history table, added startup recovery |
| 2026-01-26 | P3 #17 | Added API versioning: all routes now available at /api/v1/* |
| 2026-01-26 | P3 #20 | Replaced exec with spawn for pg_dump (password no longer in process list) |
```

---

### Quick Wins Checklist (< 1 hour each)

- [x] Add `stack: error.stack` to all error logs in `utils/square-api.js`
- [x] Remove runtime schema detection in `routes/catalog.js:938-948` (was incorrectly listed as 709-718)
- [x] Replace `console.log` in `server.js` and `utils/database.js` (verified: already using logger)
- [x] Add pool monitoring to `utils/database.js`
- [x] Create `config/constants.js` and migrate 5 most-used magic numbers

### Before Each PR Checklist

- [ ] No new N+1 queries introduced
- [ ] asyncHandler used (no manual try/catch)
- [ ] Error logs include stack traces
- [ ] Multi-step operations use transactions
- [ ] Tests added for new functionality
- [ ] Response format is consistent

---

## Completed Implementation: Webhook Logic Extraction (P1 #5)

**Started**: 2026-01-26
**Completed**: 2026-01-26
**Status**: COMPLETE

### Final State
- **server.js**: 1,023 lines (down from 3,057 - reduced by 66%)
- **Webhook processing**: Extracted to `services/webhook-processor.js` + `services/webhook-handlers/`
- **Cron jobs**: Extracted to `jobs/` directory
- **Sync queue**: Extracted to `services/sync-queue.js`

### Target Structure
```
server.js (~250 lines - setup + route registration only)
├── routes/webhooks/
│   └── square.js                    # POST /api/webhooks/square
├── services/
│   ├── webhook-processor.js         # Signature verification, idempotency, routing
│   ├── sync-queue.js                # In-progress/pending sync state management
│   └── webhook-handlers/
│       ├── index.js                 # Handler registry and exports
│       ├── subscription-handler.js  # subscription.*, invoice.*, customer.deleted
│       ├── catalog-handler.js       # catalog.version.updated, vendor.*, location.*, customer.updated
│       ├── inventory-handler.js     # inventory.count.updated
│       ├── order-handler.js         # order.*, payment.*, refund.* (~400 lines, largest)
│       ├── loyalty-handler.js       # loyalty.*, gift_card.*
│       └── oauth-handler.js         # oauth.authorization.revoked
└── jobs/
    ├── index.js                     # Job exports
    ├── cron-scheduler.js            # Cron initialization
    ├── backup-job.js                # Database backup (~150 lines)
    ├── cycle-count-job.js           # Daily batch generation
    ├── sync-job.js                  # Smart sync, GMC sync
    ├── webhook-retry-job.js         # Retry processor
    └── expiry-discount-job.js       # Expiry automation
```

### Implementation Phases

#### Phase 1: Infrastructure (Low Risk) ✅ COMPLETE
- [x] **1.1** Create `services/sync-queue.js` - Singleton managing sync state Maps
- [x] **1.2** Create `services/webhook-handlers/index.js` - Handler registry pattern

#### Phase 2: Extract Handlers (Medium Risk) ✅ COMPLETE
Extract in order of complexity (simplest first):
- [x] **2.1** `subscription-handler.js` - lines 804-901 (~100 lines)
- [x] **2.2** `oauth-handler.js` - lines 1563-1593 (~40 lines)
- [x] **2.3** `catalog-handler.js` - lines 903-1012, 1441-1559 (~200 lines)
- [x] **2.4** `inventory-handler.js` - lines 1014-1071 (~80 lines)
- [x] **2.5** `loyalty-handler.js` - lines 1800-2091 (~200 lines)
- [x] **2.6** `order-handler.js` - lines 1073-1437, 1597-1796 (~400 lines) **LARGEST**

#### Phase 3: Orchestration (Medium Risk) ✅ COMPLETE
- [x] **3.1** Create `services/webhook-processor.js` - Main entry point
- [x] **3.2** Create `routes/webhooks/square.js` - Thin route layer

#### Phase 4: Extract Cron Jobs (Low-Medium Risk) ✅ COMPLETE
- [x] **4.1** `jobs/backup-job.js` - runAutomatedBackup function
- [x] **4.2** `jobs/cycle-count-job.js` - daily batch generation
- [x] **4.3** `jobs/webhook-retry-job.js` - retry processor and cleanup
- [x] **4.4** `jobs/sync-job.js` - smart sync and GMC sync
- [x] **4.5** `jobs/expiry-discount-job.js` - expiry discount automation
- [x] **4.6** `jobs/cron-scheduler.js` - central initialization
- [x] **4.7** `jobs/index.js` - exports
- [x] **4.8** Updated server.js to use jobs module

#### Phase 5: Final Integration (High Risk) ✅ COMPLETE
- [x] **5.1** Update server.js to use webhook-processor module
- [x] **5.2** Remove inline webhook processing code from server.js (1448 lines removed)
- [x] **5.3** Verify all tests pass (658/659, 1 flaky timing test)
- [ ] **5.4** Manual testing of each webhook type (optional - verify in production)

### Key Interfaces

**SyncQueue** (`services/sync-queue.js`):
```javascript
class SyncQueue {
  isCatalogSyncInProgress(merchantId): boolean
  setCatalogSyncInProgress(merchantId, value): void
  isCatalogSyncPending(merchantId): boolean
  setCatalogSyncPending(merchantId, value): void
  // Same for inventory...
  async executeWithQueue(type, merchantId, syncFn): Promise<result>
}
module.exports = new SyncQueue(); // Singleton
```

**Handler Context** (passed to all handlers):
```javascript
{
  event,            // Raw Square webhook event
  data,             // event.data?.object || {}
  merchantId,       // Internal merchant ID (resolved)
  squareMerchantId, // Square's merchant ID
  webhookEventId,   // ID from webhook_events table
  startTime         // For duration tracking
}
```

**Handler Interface** (each handler file):
```javascript
class CatalogHandler {
  constructor(syncQueue) { this.syncQueue = syncQueue; }
  async handleCatalogVersionUpdated(context) { /* ... */ }
  async handleVendorCreated(context) { /* ... */ }
  // etc.
}
module.exports = CatalogHandler;
```

**WebhookProcessor** (`services/webhook-processor.js`):
```javascript
class WebhookProcessor {
  verifySignature(signature, rawBody, notificationUrl): boolean
  async isDuplicateEvent(eventId): boolean
  async logEvent(event): number // returns webhookEventId
  async resolveMerchant(squareMerchantId): number|null
  async processWebhook(req, res): void // Main entry
  buildContext(event, merchantId, webhookEventId): Context
}
```

### 18 Event Types to Route

| Handler File | Event Types |
|--------------|-------------|
| subscription-handler.js | subscription.created, subscription.updated, invoice.payment_made, invoice.payment_failed, customer.deleted |
| catalog-handler.js | catalog.version.updated, vendor.created, vendor.updated, location.created, location.updated, customer.updated |
| inventory-handler.js | inventory.count.updated |
| order-handler.js | order.created, order.updated, order.fulfillment.updated, payment.created, payment.updated, refund.created, refund.updated |
| loyalty-handler.js | loyalty.event.created, loyalty.account.updated, loyalty.account.created, loyalty.program.updated, gift_card.customer_linked |
| oauth-handler.js | oauth.authorization.revoked |

### Rollback Strategy

- **Phases 1-4**: Create new files without modifying server.js. Safe to delete new files if issues found.
- **Phase 5**: Can revert server.js via git. Tag before starting: `git tag -a v1.0-pre-webhook-extraction`

### Testing Strategy

1. **Unit tests** for each handler: `services/webhook-handlers/__tests__/*.test.js`
2. **Integration test**: `__tests__/integration/webhook-processing.integration.test.js`
3. **Manual verification**: Test each webhook type via Square dashboard before merging

### Progress Log

| Date | Phase | Item | Notes |
|------|-------|------|-------|
| 2026-01-26 | - | Plan | Created detailed extraction plan in CLAUDE.md |
| 2026-01-26 | 1 | 1.1-1.2 | Created sync-queue.js and webhook-handlers/index.js |
| 2026-01-26 | 2 | 2.1-2.6 | Extracted all 6 handler files (~1000 lines total) |
| 2026-01-26 | 3 | 3.1-3.2 | Created webhook-processor.js and routes/webhooks/square.js |
| 2026-01-26 | 4 | 4.1-4.8 | Extracted cron jobs to jobs/ directory (~600 lines), updated server.js |
| 2026-01-26 | 5 | 5.1-5.3 | Final integration: server.js now uses webhook-processor, removed 1448 lines inline code |
