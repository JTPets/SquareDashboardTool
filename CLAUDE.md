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

### Code Organization
```
routes/          → API endpoints (thin - validation + call service)
middleware/      → Auth, merchant context, validators, security
services/        → Business logic (loyalty/ has good examples)
utils/           → Shared utilities (database, Square API, logging)
database/
  schema.sql     → Base schema
  migrations/    → Incremental changes (###_description.sql)
jobs/            → Background jobs and cron tasks
```

### Response Format
```javascript
// Success
res.json({ success: true, data: { ... } });

// Error
res.status(4xx).json({ success: false, error: 'message', code: 'ERROR_CODE' });

// Helper available: utils/response-helper.js
const { sendSuccess, sendError, ErrorCodes } = require('../utils/response-helper');
```

### Multi-Tenant Pattern
```javascript
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

```bash
# Run migration
set -a && source .env && set +a
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/migrations/XXX_name.sql

# Connect to database
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
```

## Development Commands

```bash
npm start                    # Production
npm run dev                  # Development with --watch
pm2 restart square-dashboard-addon  # After code changes
npm test                     # Run tests

# View logs
tail -f output/logs/app-*.log
tail -f output/logs/error-*.log
```

## Writing New Code

### New Route Checklist
1. Create validator in `middleware/validators/routename.js`
2. Create route file in `routes/routename.js` using `asyncHandler`
3. Add to `server.js`
4. Write tests in `__tests__/routes/routename.test.js`

### New Database Table Checklist
1. Add to `database/schema.sql`
2. Create migration `database/migrations/XXX_description.sql`
3. Include `merchant_id INTEGER REFERENCES merchants(id)` column
4. Add composite index with merchant_id as leading column

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

## Webhook Event Flow

Webhook processor: `services/webhook-processor.js`
Handlers: `services/webhook-handlers/`

```
POST /api/webhooks/square
├─► Verify HMAC-SHA256 signature
├─► Check idempotency (webhook_events table)
├─► Resolve merchant_id from square_merchant_id
└─► Route to handler by event.type:
    ├─► subscription-handler.js (subscription.*, invoice.*)
    ├─► catalog-handler.js (catalog.*, vendor.*, location.*)
    ├─► inventory-handler.js (inventory.count.updated)
    ├─► order-handler.js (order.*, payment.*, refund.*)
    ├─► loyalty-handler.js (loyalty.*, gift_card.*)
    └─► oauth-handler.js (oauth.authorization.revoked)
```

Feature flags: `WEBHOOK_CATALOG_SYNC`, `WEBHOOK_INVENTORY_SYNC`, `WEBHOOK_ORDER_SYNC`

## Square API

```javascript
const { getSquareClientForMerchant } = require('../middleware/merchant');
const squareClient = await getSquareClientForMerchant(merchantId);

// Write operations require idempotency key
const crypto = require('crypto');
await squareClient.orders.createOrder({
    idempotencyKey: crypto.randomUUID(),
    order: { ... }
});
```

## Architecture Reference

```
/home/user/SquareDashboardTool/
├── server.js                 # ~1,000 lines - route setup, middleware
├── config/constants.js       # Centralized configuration
├── database/
│   ├── schema.sql            # 50+ tables
│   └── migrations/           # 003-027
├── routes/                   # 20 route modules (~246 routes total)
├── middleware/
│   ├── auth.js, merchant.js, security.js
│   └── validators/           # 20 validator modules
├── services/
│   ├── webhook-processor.js  # Webhook routing
│   ├── sync-queue.js         # Sync state (persisted to DB)
│   ├── webhook-handlers/     # 6 event handlers
│   └── loyalty/              # Service layer example
├── jobs/                     # Cron tasks
│   ├── cron-scheduler.js, backup-job.js, sync-job.js
│   ├── cycle-count-job.js, webhook-retry-job.js
│   └── expiry-discount-job.js
└── utils/
    ├── database.js           # Pool with getPoolStats(), transaction()
    ├── square-api.js         # Square SDK wrapper
    ├── logger.js             # Winston with daily rotation
    └── response-helper.js    # sendSuccess/sendError helpers
```

### Middleware Stack
```
Request → requireAuth → loadMerchantContext → requireMerchant → validators.* → Route Handler
```

### Rate Limiting (middleware/security.js)
- deliveryRateLimit: 30/5min
- deliveryStrictRateLimit: 10/5min
- sensitiveOperationRateLimit: 5/15min

## Logging
```javascript
const logger = require('../utils/logger');
logger.info('Operation completed', { merchantId, result });
logger.error('Failed', { error: err.message, stack: err.stack });
```

## Common Issues

| Issue | Solution |
|-------|----------|
| "relation does not exist" | Run missing migration |
| "Cannot find module" | `npm install` |
| "merchant_id cannot be null" | Add `requireMerchant` middleware |
| Session issues after deploy | `pm2 restart square-dashboard-addon` |

---

## Technical Debt Status

**Last Review**: 2026-01-26
**Grade**: A (All actionable items complete)

| Priority | Complete |
|----------|----------|
| P0 Critical | 4/4 ✅ |
| P1 High | 6/6 ✅ |
| P2 Medium | 5/5 ✅ |
| P3 Low | 5/5 ✅ (2 N/A) |

### Key Achievements (2026-01-26)
- server.js: 3,057 → 1,023 lines (66% reduction)
- All 246 routes use asyncHandler
- Webhook processing modularized (6 handlers)
- Cron jobs extracted to jobs/ directory
- Composite indexes added for multi-tenant queries
- N+1 queries eliminated
- Transactions added to critical operations
- Sync queue state persisted to database
- API versioning added (/api/v1/*)
- pg_dump secured (spawn with env password)

### Remaining (Optional)
- Integration tests for critical paths
- Validator unit tests

### PR Checklist
- [ ] No new N+1 queries
- [ ] asyncHandler used (no manual try/catch)
- [ ] Error logs include stack traces
- [ ] Multi-step operations use transactions
- [ ] Tests added for new functionality
