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
**Current Grade**: B+ (Good with specific areas needing attention)
**Target Grade**: A++ (Production-ready SaaS)

### Grade Criteria
| Grade | Description |
|-------|-------------|
| A++ | Production SaaS-ready: comprehensive tests, scalable architecture, zero security concerns |
| A+ | Enterprise-ready: strong tests, good architecture, minor improvements possible |
| A | Solid: good patterns, adequate tests, some technical debt |
| B+ | **Current**: Good fundamentals, security gaps, inadequate tests, architectural inconsistencies |
| B | Functional: works but has significant debt |

---

## Roadmap to A++

### Summary

| Priority | Status | Items |
|----------|--------|-------|
| P0 Security | 🟡 3/4 | P0-4 (CSP) remaining |
| P1 Architecture | 🔴 1/5 | Code organization and consistency |
| P2 Testing | 🔴 0/6 | Test coverage for critical paths |
| P3 Scalability | 🟡 Optional | Multi-instance deployment prep |

---

## P0: Security Fixes (CRITICAL)

These must be fixed before any production deployment or Square partnership discussions.

### P0-1: JSON Body Limit Enables DoS ✅
**File**: `server.js:129`
**Status**: FIXED (2026-01-26)

Reduced JSON body limit from 50mb to 5mb. POD uploads use multer with separate limits.

---

### P0-2: Subscription Check Fails Open ✅
**File**: `middleware/subscription-check.js:139-146`
**Status**: FIXED (2026-01-26)

Changed error handler to fail closed - returns 503 for API requests and redirects HTML requests when subscription status cannot be verified.

---

### P0-3: Error Messages Expose Internal Details ✅
**Status**: FIXED (2026-01-26)

Fixed 3 locations exposing internal error details to clients:
- `routes/subscriptions.js:601-612` - Refund errors now log details server-side, return generic message
- `routes/loyalty.js:1056-1066` - Square API errors now logged, return 502 with generic message
- `routes/google-oauth.js:97-101` - OAuth errors use generic `oauth_failed` code in redirect URL

---

### P0-4: CSP Allows Unsafe Inline/Eval ❌
**File**: `middleware/security.js:23-35`
**Risk**: XSS protection is effectively disabled

**Current Code**:
```javascript
scriptSrc: [
    "'self'",
    "'unsafe-inline'",    // ⚠️ Allows inline scripts (XSS vector)
    "'unsafe-eval'",      // ⚠️ Allows eval() (code injection vector)
    "https://*.cloudflare.com"
]
```

**Required Fix**:
```javascript
scriptSrc: [
    "'self'",
    "https://*.cloudflare.com",
    // Use nonces for any required inline scripts
    // See: https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
]
```

**Migration Steps**:
1. Audit `public/` for inline `<script>` tags and `onclick` handlers
2. Move inline scripts to external `.js` files
3. Remove `'unsafe-inline'` and `'unsafe-eval'`
4. If Cloudflare requires inline, use nonce-based CSP

**Why**: `'unsafe-inline'` and `'unsafe-eval'` defeat the entire purpose of CSP. If an attacker can inject HTML, they can execute arbitrary JavaScript.

---

## P1: Architecture Fixes (HIGH)

### P1-1: Duplicate Loyalty Implementations ❌
**Problem**: Two competing implementations exist

| Implementation | Location | Lines | Pattern |
|----------------|----------|-------|---------|
| Legacy | `utils/loyalty-service.js` | 3,349 | Monolithic utility |
| Modern | `services/loyalty/` | ~800 | Service layer with DI |

**Required Action**: Delete `utils/loyalty-service.js` after verifying `services/loyalty/` covers all functionality.

**Verification Steps**:
```bash
# Find all imports of legacy service
grep -r "require.*loyalty-service" routes/ services/ --include="*.js"

# Update each file to use new service
const { LoyaltyWebhookService } = require('../services/loyalty');
```

**Why**: Two implementations means bugs fixed in one aren't fixed in the other. Technical debt compounds.

---

### P1-2: Fat Routes Need Service Extraction ❌
**Problem**: Business logic in route handlers instead of services

| Route File | Lines | Should Be |
|------------|-------|-----------|
| `routes/loyalty.js` | 1,645 | ~300 (thin controller) |
| `routes/catalog.js` | 1,493 | ~250 |
| `routes/delivery.js` | 1,211 | ~200 |

**Example - Current** (`routes/catalog.js`):
```javascript
router.get('/items', asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    // 50+ lines of business logic here
    // Database queries, transformations, filtering
    // This should be in a service
}));
```

**Example - Required**:
```javascript
// routes/catalog.js (thin)
router.get('/items', asyncHandler(async (req, res) => {
    const result = await catalogService.getItems(req.merchantContext.id, req.query);
    res.json({ success: true, data: result });
}));

// services/catalog/item-service.js (business logic)
class ItemService {
    async getItems(merchantId, filters) {
        // All business logic here
    }
}
```

**Why**: Routes should be thin controllers. Business logic in routes can't be unit tested without HTTP mocking.

---

### P1-3: Utils Directory is Unorganized ❌
**Problem**: 26 files (23,253 lines) mixing utilities, services, and domain logic

**Current Structure**:
```
utils/
├── database.js          # ✅ True utility
├── logger.js            # ✅ True utility
├── loyalty-service.js   # ❌ Service (3,349 lines!)
├── expiry-discount.js   # ❌ Domain logic
├── delivery-api.js      # ❌ Service
└── ... (23 more files)
```

**Required Structure**:
```
utils/                   # Only shared utilities
├── database.js
├── logger.js
├── response-helper.js
├── app-error.js
├── token-encryption.js
└── password.js

services/                # Business logic services
├── loyalty/             # (already exists - good)
├── catalog/
│   ├── index.js
│   ├── item-service.js
│   └── sync-service.js
├── delivery/
│   ├── index.js
│   ├── order-service.js
│   └── route-service.js
└── expiry/
    └── discount-service.js
```

---

### P1-4: Helper Function in server.js ✅
**File**: `utils/image-utils.js`
**Status**: FIXED (2026-01-26)

Moved `resolveImageUrls()` from server.js to `utils/image-utils.js` alongside the existing `batchResolveImageUrls()` function.

---

### P1-5: Inconsistent Validator Organization ❌
**Problem**: Some validators in separate files, some inline in routes

**Current Pattern (Inconsistent)**:
```javascript
// Pattern A: Separate file (good)
const { createOrderValidator } = require('../middleware/validators/delivery');

// Pattern B: Inline (bad) - found in some routes
router.post('/thing', [
    body('field').isString(),
    handleValidationErrors
], asyncHandler(...));
```

**Required Pattern**: All validators in `middleware/validators/` files

---

## P2: Testing Requirements (HIGH)

### P2-1: Multi-Tenant Isolation Tests ❌
**File to create**: `__tests__/security/multi-tenant-isolation.test.js`

**Required Tests**:
```javascript
describe('Multi-tenant isolation', () => {
    it('should not allow User A to access Merchant B items', async () => {
        // Create two merchants with items
        // Authenticate as User A (Merchant A)
        // Attempt to access Merchant B item by ID
        // Expect 404 or 403, NOT the item
    });

    it('should not leak merchant data in list endpoints', async () => {
        // GET /api/items as Merchant A
        // Verify zero items from Merchant B appear
    });

    it('should reject direct merchant_id parameter manipulation', async () => {
        // POST with merchant_id in body different from session
        // Expect rejection
    });
});
```

---

### P2-2: Payment/Refund Flow Tests ❌
**File to create**: `__tests__/routes/subscriptions-payments.test.js`

**Required Tests**:
```javascript
describe('Payment flows', () => {
    it('should handle successful subscription creation');
    it('should handle payment declined gracefully');
    it('should process refunds idempotently');
    it('should not expose payment details in errors');
    it('should validate subscription status before operations');
});
```

---

### P2-3: Webhook Signature Verification Tests ❌
**File to create**: `__tests__/security/webhook-signature.test.js`

**Required Tests**:
```javascript
describe('Webhook signature verification', () => {
    it('should reject missing signature header');
    it('should reject invalid signature');
    it('should reject tampered payload');
    it('should accept valid signature');
    it('should prevent replay attacks via idempotency');
});
```

---

### P2-4: Authentication Edge Case Tests ❌
**Required Tests**:
```javascript
describe('Authentication edge cases', () => {
    it('should handle session expiry gracefully');
    it('should prevent session fixation attacks');
    it('should rate limit login attempts correctly');
    it('should lock account after failed attempts');
    it('should not enumerate valid emails');
});
```

---

### P2-5: OAuth Token Refresh Tests ❌
**Required Tests**:
```javascript
describe('OAuth token management', () => {
    it('should refresh token before expiry');
    it('should handle refresh token failure');
    it('should encrypt tokens before storage');
    it('should handle revoked tokens');
});
```

---

### P2-6: Rate Limiter Effectiveness Tests ❌
**Required Tests**:
```javascript
describe('Rate limiting', () => {
    it('should block after limit exceeded');
    it('should return correct retry-after header');
    it('should track by correct key (user/IP/merchant)');
    it('should reset after window expires');
});
```

---

## P3: Scalability Prep (OPTIONAL for Single Business)

These are only required if pursuing multi-merchant SaaS revenue.

### P3-1: In-Memory State Doesn't Scale
**File**: `services/sync-queue.js`
**Issue**: Sync state is in-memory + DB, but multiple instances will have different in-memory state

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

**Fix for Scale**: Implement per-merchant request queue with backoff

### P3-4: Single Database Pool for All Tenants
**Issue**: 20 connections shared across all merchants

**Fix for Scale**: Consider tenant-aware pooling or connection limits per merchant

---

## Previous Achievements (2026-01-26)

These items are COMPLETE and should not regress:

- ✅ server.js: 3,057 → 1,023 lines (66% reduction)
- ✅ All 246 routes use asyncHandler
- ✅ Webhook processing modularized (6 handlers)
- ✅ Cron jobs extracted to jobs/ directory
- ✅ Composite indexes added for multi-tenant queries
- ✅ N+1 queries eliminated
- ✅ Transactions added to critical operations
- ✅ Sync queue state persisted to database
- ✅ API versioning added (/api/v1/*)
- ✅ pg_dump secured (spawn with env password)
- ✅ Parameterized queries: 100% coverage
- ✅ Token encryption: AES-256-GCM
- ✅ Password hashing: bcrypt with 12 rounds
- ✅ Multi-tenant isolation: merchant_id on all queries

---

## PR Checklist

Before merging any PR:

- [ ] No new security vulnerabilities (P0 items)
- [ ] No N+1 queries introduced
- [ ] asyncHandler used (no manual try/catch in routes)
- [ ] Error logs include stack traces (server-side only)
- [ ] Error responses don't expose internal details
- [ ] Multi-step operations use transactions
- [ ] Tests added for new functionality
- [ ] Validators in `middleware/validators/`, not inline
- [ ] Business logic in services, not routes
- [ ] merchant_id filter on ALL database queries

---

## Quick Reference: Grade Requirements

| Grade | P0 | P1 | P2 | P3 |
|-------|----|----|----|----|
| A++ | 4/4 ✅ | 5/5 ✅ | 6/6 ✅ | Optional |
| A+ | 4/4 ✅ | 5/5 ✅ | 4/6 ✅ | - |
| A | 4/4 ✅ | 3/5 ✅ | 2/6 ✅ | - |
| B+ (Current) | 0/4 | 0/5 | 0/6 | - |
