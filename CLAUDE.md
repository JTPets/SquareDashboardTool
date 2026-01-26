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

The webhook processor in `server.js` (lines 614-1628) handles all Square webhook events.

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
The `database/migrations/` directory contains incremental migrations (003-025) for:
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
├── server.js                 # Main server (2,981 lines) - webhook processing, route setup
├── package.json              # Dependencies: square@43.2.1, googleapis@144, pg, express
├── database/
│   ├── schema.sql            # Base schema (895 lines, 50+ tables)
│   └── migrations/           # 23 migration files (003-025)
├── routes/                   # 20 route modules
│   ├── catalog.js            # Items, variations, inventory, expirations
│   ├── delivery.js           # Delivery order management
│   ├── loyalty.js            # Loyalty rewards program
│   └── ...
├── middleware/
│   ├── auth.js               # Authentication
│   ├── merchant.js           # Multi-tenant context
│   ├── security.js           # Helmet, rate limiting
│   └── validators/           # 20 validator modules
├── services/
│   └── loyalty/              # Service layer example (8 modules)
│       ├── webhook-service.js
│       ├── customer-service.js
│       └── ...
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
**Overall Grade**: B- (Solid foundation, significant room for improvement)

### Priority Legend
- **P0**: Critical - Fix immediately (performance/reliability impact)
- **P1**: High - Fix soon (maintainability/debugging impact)
- **P2**: Medium - Plan for next sprint (code quality)
- **P3**: Low - Address when touching related code

---

### P0: Critical Performance Issues

#### 1. N+1 Query Problem in Catalog Bulk Updates
**File**: `routes/catalog.js` lines 651-680
**Problem**: Loop executes 3 queries per item (SELECT + UPDATE + Square API call)
**Impact**: 100 items = 300+ queries instead of 3 batch operations

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

#### 2. N+1 Query in Purchase Order Creation
**File**: `routes/purchase-orders.js` lines 100-118
**Problem**: Individual INSERTs in a loop for line items
**Impact**: Creating PO with 50 items = 50 INSERT statements

**Remediation**:
```javascript
// Use multi-row INSERT
const values = items.map((item, i) =>
    `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`
).join(',');
const params = items.flatMap(item => [poId, item.variationId, item.quantity, merchantId]);
await db.query(`INSERT INTO purchase_order_items (...) VALUES ${values}`, params);
```

#### 3. Correlated Subqueries in Purchase Orders List
**File**: `routes/purchase-orders.js` line 143
**Problem**: Subquery `(SELECT COUNT(*) ...)` runs per row

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

#### 4. Missing Composite Indexes for Multi-Tenant Queries
**Problem**: Indexes don't have `merchant_id` as leading column
**Impact**: Full table scans on large tables

**Remediation** - Create migration `026_optimize_indexes.sql`:
```sql
-- Drop single-column indexes that should be composite
DROP INDEX IF EXISTS idx_variations_sku;
DROP INDEX IF EXISTS idx_items_square_id;

-- Create optimized composite indexes (merchant_id first)
CREATE INDEX CONCURRENTLY idx_variations_merchant_sku ON variations(merchant_id, sku);
CREATE INDEX CONCURRENTLY idx_variations_merchant_item ON variations(merchant_id, item_id);
CREATE INDEX CONCURRENTLY idx_items_merchant_square ON items(merchant_id, square_id);
CREATE INDEX CONCURRENTLY idx_inventory_merchant_variation ON inventory_counts(merchant_id, variation_id);
CREATE INDEX CONCURRENTLY idx_sales_velocity_merchant_var ON sales_velocity(merchant_id, variation_id);

-- Covering indexes for common queries
CREATE INDEX CONCURRENTLY idx_variations_merchant_sku_covering
    ON variations(merchant_id, sku) INCLUDE (id, name, item_id);
```

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
- [ ] `routes/catalog.js` (1,608 lines)
- [ ] `routes/loyalty.js` (1,873 lines)
- [ ] `routes/delivery.js`
- [ ] `routes/purchase-orders.js`
- [ ] `routes/analytics.js`
- [ ] `routes/cycle-counts.js`
- [ ] `routes/expiry-discounts.js`
- [ ] `routes/sync.js`
- [ ] `routes/vendors.js`
- [ ] `routes/gmc.js`
- [ ] All remaining routes

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

#### 11. Add Transactions to Multi-Step Operations
**Problem**: Only 2 transactions in entire codebase
**Impact**: Partial failures leave inconsistent data

**Operations needing transactions**:

```javascript
// Purchase order creation (routes/purchase-orders.js)
const client = await db.getClient();
try {
    await client.query('BEGIN');
    const po = await client.query('INSERT INTO purchase_orders...');
    for (const item of items) {
        await client.query('INSERT INTO purchase_order_items...');
    }
    await client.query('COMMIT');
    return po.rows[0];
} catch (error) {
    await client.query('ROLLBACK');
    throw error;
} finally {
    client.release();
}
```

**Files needing transaction wrappers**:
- [ ] `routes/purchase-orders.js` - PO creation with line items
- [ ] `routes/catalog.js` - Bulk catalog updates
- [ ] `routes/loyalty.js` - Reward redemption
- [ ] `routes/cycle-counts.js` - Count session completion
- [ ] `utils/square-api.js` - Sync operations that update multiple tables

#### 12. Standardize API Response Format
**Problem**: Inconsistent response structures

```javascript
// Most routes (correct)
res.json({ success: true, data: { ... } });

// Some routes (inconsistent)
res.json({ status: 'success', updated_count: 5 });  // catalog.js line 686
res.json({ message: 'Updated successfully' });       // various
```

**Remediation**: Audit all routes, standardize to:
```javascript
// Success
res.json({ success: true, data: { ... } });
res.json({ success: true, data: { updated_count: 5 } });

// Error
res.status(4xx).json({ success: false, error: 'message', code: 'ERROR_CODE' });
```

#### 13. Persist Sync Queue State
**File**: `server.js` (sync queue Maps)
**Problem**: In-memory Maps lost on restart

```javascript
// CURRENT - lost on restart
const catalogSyncInProgress = new Map();
const catalogSyncPending = new Map();
```

**Options**:
1. **Simple**: Use database table `sync_queue_state`
2. **Better**: Use Redis for distributed state
3. **Best**: Use proper job queue (Bull/BullMQ)

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
- [ ] `server.js` - 2 occurrences
- [ ] `utils/database.js` - 2 occurrences
- [ ] `scripts/init-admin.js` - 30 occurrences (acceptable for CLI script)

```bash
# Find backend console.log usage
grep -rn "console.log" --include="*.js" --exclude-dir="node_modules" --exclude-dir="public" .
```

---

### P3: Low Priority - Nice to Have

#### 16. Add Database Connection Pool Monitoring
**File**: `utils/database.js`

```javascript
// Add pool metrics
const pool = new Pool(config);

pool.on('connect', () => {
    logger.debug('New client connected to pool', {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
    });
});

pool.on('error', (err) => {
    logger.error('Unexpected pool error', { error: err.message, stack: err.stack });
});

// Export metrics for monitoring
function getPoolStats() {
    return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
    };
}
```

#### 17. Add API Versioning
**Problem**: No versioning strategy for breaking changes

**Remediation**:
```javascript
// server.js
app.use('/api/v1/catalog', catalogRoutes);
app.use('/api/v1/loyalty', loyaltyRoutes);

// Keep unversioned for backwards compatibility (deprecate later)
app.use('/api/catalog', catalogRoutes);
```

#### 18. Add OpenAPI/Swagger Documentation
**Problem**: No API documentation for client integration

**Options**:
1. Add `swagger-jsdoc` + `swagger-ui-express`
2. Generate from route definitions
3. Manual OpenAPI YAML file

#### 19. Consider Background Job Queue
**Problem**: Long-running syncs block event loop
**Current**: Sync operations run inline in request/webhook handlers

**Recommendation**: Implement Bull/BullMQ for:
- Catalog sync jobs
- Inventory sync jobs
- Report generation
- Email sending

---

### Security Improvements (Minor)

#### 20. Use spawn Instead of exec for pg_dump
**File**: `server.js` line 571
**Risk**: LOW (password visible in process list)

```javascript
// CURRENT
const pgDumpCmd = `PGPASSWORD="${dbPassword}" pg_dump -h ${dbHost} ...`;
const { stdout } = await execAsync(pgDumpCmd);

// BETTER
const { spawn } = require('child_process');
const child = spawn('pg_dump', ['-h', dbHost, '-p', dbPort, ...], {
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
| YYYY-MM-DD | #X   | Description of fix |
```

---

### Quick Wins Checklist (< 1 hour each)

- [ ] Add `stack: error.stack` to all error logs in `utils/square-api.js`
- [ ] Remove runtime schema detection in `routes/catalog.js:709-718`
- [ ] Replace `console.log` in `server.js` and `utils/database.js`
- [ ] Add pool monitoring to `utils/database.js`
- [ ] Create `config/constants.js` and migrate 5 most-used magic numbers

### Before Each PR Checklist

- [ ] No new N+1 queries introduced
- [ ] asyncHandler used (no manual try/catch)
- [ ] Error logs include stack traces
- [ ] Multi-step operations use transactions
- [ ] Tests added for new functionality
- [ ] Response format is consistent
