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

## Migration Consolidation Status (v1.0)

### Already in schema.sql
- Core tables: users, merchants, user_merchants, oauth_states
- Catalog: locations, categories, items, variations, images, inventory_counts
- Vendors: vendors, variation_vendors, vendor_catalog_items
- Purchase orders: purchase_orders, purchase_order_items
- Analytics: sales_velocity, variation_location_settings
- Cycle counts: count_history, count_queue_priority, count_queue_daily, count_sessions
- Expiration: variation_expiration, expiry_discount_* tables
- GMC: brands, google_taxonomy, category_taxonomy_mapping, item_brands, gmc_settings, gmc_feed_history

### Should be consolidated (for fresh installs)
| Migration | Tables/Changes | Priority |
|-----------|----------------|----------|
| 004_subscriptions | subscribers, subscription_payments, subscription_events, subscription_plans | Medium |
| 008_delivery_scheduler | delivery_orders, delivery_pod, delivery_settings, delivery_routes, delivery_audit_log | High |
| 010_loyalty_program | loyalty_offers, loyalty_qualifying_variations, loyalty_purchase_events, loyalty_rewards, loyalty_redemptions, loyalty_audit_logs, loyalty_settings, loyalty_customer_summary | High |
| 021_delivery_route_tokens | delivery_route_tokens | Medium |

### Keep as migrations (small/additive)
- 005_multi_tenant - Already handled, keep for reference
- 006_promo_codes through 025_* - Small column additions, constraint fixes

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
