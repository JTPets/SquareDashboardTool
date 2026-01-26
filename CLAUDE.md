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
| P0 Security | 🟡 3.5/4 | P0-4 (CSP) partial - event-delegation.js created, 11 HTML files remaining |
| P1 Architecture | 🟡 4/5 | P1-1 in progress, P1-2 catalog routes wired (78% reduction), P1-3 nearly complete (1 file left), P1-4, P1-5 done |
| P2 Testing | ✅ 6/6 | All complete (P2-2, P2-5 finished 2026-01-26) |
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

### P0-4: CSP Allows Unsafe Inline 🟡 PARTIAL
**File**: `middleware/security.js:23-35`
**Risk**: XSS protection partially enabled

**Progress (2026-01-26)**:
- ✅ Removed `'unsafe-eval'` - No eval()/new Function()/string setTimeout usage found
- ❌ `'unsafe-inline'` still required - 14 HTML files with ~292 inline event handlers

**Current Code**:
```javascript
scriptSrc: [
    "'self'",
    "'unsafe-inline'",    // ⚠️ Still needed - inline handlers in 14 HTML files
    // 'unsafe-eval' REMOVED - no longer present
    "https://*.cloudflare.com"
]
```

**Remaining Work - Inline Script Migration**:

| Scope | Count |
|-------|-------|
| HTML files with inline handlers | 11 |
| `onclick` handlers | ~202 |
| `onchange` handlers | ~23 |
| Other handlers (onerror, onblur, etc.) | ~30 |

**Migration Steps**:
1. ✅ ~~Remove `'unsafe-eval'`~~ (done 2026-01-26)
2. ✅ ~~Create `/public/js/event-delegation.js`~~ (done 2026-01-26)
3. 🟡 Convert inline handlers to event listeners (11 files remaining, ~202 handlers)
   - ✅ `logs.html` migrated as pattern example
   - ✅ `settings.html` migrated (19 handlers)
   - ✅ `catalog-audit.html` migrated (17 handlers)
   - ✅ `expiry-audit.html` migrated (17 handlers)
   - ✅ `delivery-route.html` migrated (23 handlers)
   - ✅ `purchase-orders.html` migrated (15 handlers)
   - ✅ `sales-velocity.html` migrated (1 handler)
   - ✅ `deleted-items.html` migrated (5 handlers)
   - ✅ `admin-subscriptions.html` migrated (2 handlers)
   - ✅ `cycle-count-history.html` migrated (6 handlers)
   - ✅ `driver.html` migrated (10 handlers)
   - ✅ `index.html` migrated (1 handler)
   - ✅ `delivery-settings.html` migrated (1 handler)
   - ✅ `subscribe.html` migrated (9 handlers)
   - ✅ `merchants.html` migrated (7 handlers)
   - ✅ `expiry.html` migrated (15 handlers)
4. Remove `'unsafe-inline'` from CSP

**Event Delegation Pattern** (from `/public/js/event-delegation.js`):
```html
<!-- BEFORE (requires unsafe-inline): -->
<button onclick="refreshLogs()">Refresh</button>
<select onchange="filterLogs()">

<!-- AFTER (CSP compliant): -->
<button data-action="refreshLogs">Refresh</button>
<select data-change="filterLogs">
```
Global functions are automatically discovered by the event delegation module.

**Why This Still Matters**: `'unsafe-inline'` allows injected script tags to execute. However, with `'unsafe-eval'` removed, attackers cannot dynamically generate code even if they inject content.

---

## P1: Architecture Fixes (HIGH)

### P1-1: Loyalty Service Migration 🟡 IN PROGRESS
**Status**: Modern service built & tested, but NOT wired into production

#### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CURRENT PRODUCTION FLOW                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Webhook Events ──► webhook-processor.js ──► webhook-handlers/          │
│                                               ├── order-handler.js      │
│                                               └── loyalty-handler.js    │
│                                                        │                │
│                                                        ▼                │
│                                        ┌──────────────────────────────┐ │
│                                        │ utils/loyalty-service.js    │ │
│                                        │ (5,476 lines - LEGACY)      │ │
│                                        │                              │ │
│                                        │ • Order processing           │ │
│                                        │ • Customer identification    │ │
│                                        │ • Offer CRUD                 │ │
│                                        │ • Square Customer Groups     │ │
│                                        │ • Refund handling            │ │
│                                        │ • Catchup/backfill           │ │
│                                        │ • Settings & Audit           │ │
│                                        └───────────┬──────────────────┘ │
│                                                    │ uses               │
│                                                    ▼                    │
│                                        ┌──────────────────────────────┐ │
│                                        │ services/loyalty/            │ │
│                                        │   loyaltyLogger (only)       │ │
│                                        └──────────────────────────────┘ │
│                                                                         │
│  routes/loyalty.js ───────────────────► utils/loyalty-service.js       │
│  (Admin API - 35+ function calls)                                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ MODERN SERVICE (Built, Tested, NOT Connected)                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  services/loyalty/                                                      │
│  ├── index.js                 # Public API exports                      │
│  ├── webhook-service.js       # LoyaltyWebhookService (main entry)      │
│  ├── square-client.js         # LoyaltySquareClient + SquareApiError    │
│  ├── customer-service.js      # LoyaltyCustomerService                  │
│  ├── offer-service.js         # LoyaltyOfferService                     │
│  ├── purchase-service.js      # LoyaltyPurchaseService                  │
│  ├── reward-service.js        # LoyaltyRewardService                    │
│  ├── loyalty-logger.js        # Structured logging (USED by legacy)     │
│  ├── loyalty-tracer.js        # Request tracing                         │
│  └── __tests__/               # 2,931 lines of tests ✅                 │
│      ├── webhook-service.test.js    (491 lines)                         │
│      ├── purchase-service.test.js   (524 lines)                         │
│      ├── reward-service.test.js     (520 lines)                         │
│      ├── customer-service.test.js   (294 lines)                         │
│      ├── square-client.test.js      (303 lines)                         │
│      ├── offer-service.test.js      (245 lines)                         │
│      ├── loyalty-tracer.test.js     (241 lines)                         │
│      └── loyalty-logger.test.js     (313 lines)                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### What Modern Service Covers

| Feature | Modern Service | Method |
|---------|----------------|--------|
| Order processing | ✅ | `LoyaltyWebhookService.processOrder()` |
| Customer ID (5 methods) | ✅ | `LoyaltyCustomerService.identifyCustomerFromOrder()` |
| Purchase recording | ✅ | `LoyaltyPurchaseService.recordPurchase()` |
| Reward management | ✅ | `LoyaltyRewardService.*` |
| Offer lookups | ✅ | `LoyaltyOfferService.getActiveOffers()` |
| Square API calls | ✅ | `LoyaltySquareClient.*` |
| Structured logging | ✅ | `loyaltyLogger.*` |
| Request tracing | ✅ | `LoyaltyTracer` |

#### What Stays in Legacy (Admin Features)

| Feature | Used By | Notes |
|---------|---------|-------|
| Offer CRUD | `routes/loyalty.js` | Create/update/delete offers |
| Variation management | `routes/loyalty.js` | Add qualifying variations |
| Settings | `routes/loyalty.js` | Loyalty program settings |
| Audit logs | `routes/loyalty.js` | Query audit history |
| Customer caching | `routes/loyalty.js` | Local customer cache |
| Square Customer Group Discount | `order-handler.js` | Reward delivery mechanism |
| Refund processing | `order-handler.js` | Adjust quantities on refund |
| Catchup/backfill | `loyalty-handler.js` | Process missed orders |

#### Migration Plan

**Phase 1: Wire Up Modern Service (Add Feature Flag)** ✅ COMPLETE
```
Files modified:
  - services/webhook-handlers/order-handler.js
  - services/webhook-handlers/loyalty-handler.js
  - .env.example (added USE_NEW_LOYALTY_SERVICE=false)

Both handlers now check USE_NEW_LOYALTY_SERVICE and call either:
  - Modern: LoyaltyWebhookService.processOrder()
  - Legacy: loyaltyService.processOrderForLoyalty() (default)

Results are normalized to legacy format for backward compatibility.
Other legacy functions (redemption detection, refunds, discounts) still use legacy service.
```

**Phase 2: Test in Production**
```bash
# .env - Enable for testing
USE_NEW_LOYALTY_SERVICE=true

# Monitor logs for [LOYALTY:*] entries
tail -f output/logs/app-*.log | grep LOYALTY
```

**Phase 3: Migrate Remaining Handlers**
- `services/webhook-handlers/loyalty-handler.js` - Use modern for order processing
- Keep legacy calls for: `runLoyaltyCatchup`, `isOrderAlreadyProcessedForLoyalty`

**Phase 4: Decide on Admin Features**
Options:
1. Add to modern service (`LoyaltyOfferService.createOffer()`, etc.)
2. Keep legacy as "admin service" separate from webhook processing
3. Extract to new `services/loyalty-admin/` module

#### Files to Modify

| File | Changes |
|------|---------|
| `services/webhook-handlers/order-handler.js` | Add feature flag for modern service |
| `services/webhook-handlers/loyalty-handler.js` | Add feature flag for modern service |
| `.env.example` | Add `USE_NEW_LOYALTY_SERVICE=false` |
| `config/constants.js` | Add feature flag constant |

#### Success Criteria

- [ ] Feature flag `USE_NEW_LOYALTY_SERVICE` added
- [ ] Modern service processes orders when flag is `true`
- [ ] Legacy service still works when flag is `false`
- [ ] No regression in loyalty tracking (compare results)
- [ ] Tracing shows full order processing pipeline
- [ ] All existing tests pass

---

### P1-2: Fat Routes Need Service Extraction 🟡 IN PROGRESS
**Problem**: Business logic in route handlers instead of services

| Route File | Lines | Service Created | Routes Wired | Status |
|------------|-------|-----------------|--------------|--------|
| `routes/catalog.js` | ~~1,493~~ → **327** | `services/catalog/` | ✅ **78% reduction** | ✅ COMPLETE |
| `routes/loyalty.js` | 1,645 | `services/loyalty/` | ❌ Pending | 🟡 Service exists (P1-1) |
| `routes/delivery.js` | 1,211 | `services/delivery/` | ✅ Already using service | ✅ COMPLETE |

**Progress (2026-01-26)**:
- ✅ Created `services/catalog/` with 4 service modules:
  - `item-service.js` - Locations, categories, items
  - `variation-service.js` - Variations, costs, bulk updates
  - `inventory-service.js` - Inventory, low stock, expirations
  - `audit-service.js` - Catalog audit, location fixes
- ✅ **Wired routes/catalog.js to use catalog service** (1,493 → 327 lines, 78% reduction)
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

### P1-3: Utils Directory Reorganization 🟡 IN PROGRESS
**Problem**: 26 files (23,253 lines) mixing utilities, services, and domain logic

**Progress (2026-01-26)**:
- ✅ Created `services/merchant/` with settings-service.js (extracted from database.js)
- ✅ Created `services/delivery/` with delivery-service.js (moved from utils/)
- ✅ Created `services/expiry/` with discount-service.js (moved from utils/)
- ✅ Created `services/inventory/` with cycle-count-service.js (moved from utils/)
- ✅ Created `services/gmc/` with feed-service.js and merchant-service.js (moved from utils/)
- ✅ Created `services/vendor/` with catalog-service.js (moved from utils/)
- ✅ Created `services/reports/` with loyalty-reports.js (moved from utils/)
- ✅ Created `services/square/` with api.js (moved from utils/)
- ✅ Re-export stubs in utils/ maintain backward compatibility
- ❌ Remaining: loyalty-service.js (5,475 lines)

**Current Structure**:
```
services/                # Business logic services
├── loyalty/             # ✅ Modern service (P1-1)
├── catalog/             # ✅ NEW - Catalog data management (P1-2)
│   ├── index.js
│   ├── item-service.js      # Locations, categories, items
│   ├── variation-service.js # Variations, costs, bulk updates
│   ├── inventory-service.js # Inventory, low stock, expirations
│   └── audit-service.js     # Catalog audit, location fixes
├── merchant/            # ✅ Settings service
│   ├── index.js
│   └── settings-service.js
├── delivery/            # ✅ Delivery order management
│   ├── index.js
│   └── delivery-service.js
├── expiry/              # ✅ Expiry discount automation
│   ├── index.js
│   └── discount-service.js
├── inventory/           # ✅ Cycle count batch generation
│   ├── index.js
│   └── cycle-count-service.js
├── gmc/                 # ✅ Google Merchant Center
│   ├── index.js
│   ├── feed-service.js      # TSV feed generation
│   └── merchant-service.js  # GMC API sync
├── vendor/              # ✅ Vendor catalog import
│   ├── index.js
│   └── catalog-service.js   # CSV/XLSX import, price comparison
├── reports/             # ✅ Report generation
│   ├── index.js
│   └── loyalty-reports.js   # Vendor receipts, audit exports
├── square/              # ✅ Square API integration
│   ├── index.js
│   └── api.js               # Sync, inventory, custom attributes, prices
├── webhook-handlers/    # ✅ Already organized
└── webhook-processor.js # ✅ Already here

utils/                   # Re-export stubs for backward compatibility
├── delivery-api.js      # → services/delivery/
├── expiry-discount.js   # → services/expiry/
├── cycle-count-utils.js # → services/inventory/
├── gmc-feed.js          # → services/gmc/feed-service.js
├── merchant-center-api.js # → services/gmc/merchant-service.js
├── vendor-catalog.js    # → services/vendor/
├── loyalty-reports.js   # → services/reports/
├── square-api.js        # → services/square/
├── database.js          # Re-exports getMerchantSettings from services/merchant/
└── ... (remaining true utilities)
```

**Remaining Work**:
```
utils/                   # Files still needing extraction
└── loyalty-service.js   # ❌ Large service (5,475 lines - migrate to services/loyalty-admin/)
```

**Completed Extractions (this session)**:
- ✅ `cycle-count-utils.js` → `services/inventory/cycle-count-service.js` (349 lines)
- ✅ `gmc-feed.js` → `services/gmc/feed-service.js` (589 lines)
- ✅ `merchant-center-api.js` → `services/gmc/merchant-service.js` (1,100 lines)
- ✅ `vendor-catalog.js` → `services/vendor/catalog-service.js` (1,331 lines)
- ✅ `loyalty-reports.js` → `services/reports/loyalty-reports.js` (969 lines)
- ✅ `square-api.js` → `services/square/api.js` (3,517 lines)

---

### P1-4: Helper Function in server.js ✅
**File**: `utils/image-utils.js`
**Status**: FIXED (2026-01-26)

Moved `resolveImageUrls()` from server.js to `utils/image-utils.js` alongside the existing `batchResolveImageUrls()` function.

---

### P1-5: Inconsistent Validator Organization ✅ COMPLETE
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

## P2: Testing Requirements (HIGH)

### P2-1: Multi-Tenant Isolation Tests ✅ COMPLETE
**File**: `__tests__/security/multi-tenant-isolation.test.js` (26 tests)
**Status**: COMPLETE (2026-01-26)

**All required tests exist**:
- ✅ User A cannot access Merchant B's data
- ✅ List endpoints don't leak data across tenants
- ✅ Direct merchant_id parameter manipulation rejected
- ✅ Merchant context loading with user_merchants verification
- ✅ Session activeMerchantId doesn't grant unauthorized access
- ✅ Cross-tenant update/delete prevention
- ✅ Bulk operations respect merchant boundaries
- ✅ Webhook routing by square_merchant_id
- ✅ Data leakage prevention in error messages, pagination, search
- ✅ Merchant role isolation per-tenant

---

### P2-2: Payment/Refund Flow Tests ✅ COMPLETE
**File**: `__tests__/routes/subscriptions.test.js` (59 tests)
**Status**: COMPLETE (2026-01-26)

**All required tests exist**:
- ✅ Promo code validation (dates, limits, discounts)
- ✅ Subscription creation input validation
- ✅ Duplicate email prevention
- ✅ Plan validation
- ✅ PCI compliance (no card data storage)
- ✅ Admin refund authorization
- ✅ Generic error messages (no internal details)
- ✅ Payment declined handling (CARD_DECLINED, INSUFFICIENT_FUNDS, generic errors)
- ✅ Payment decline logging for debugging
- ✅ Refund idempotency key generation
- ✅ Refund eligibility checks (completed + non-refunded only)
- ✅ Refund marking and audit trail
- ✅ Square refund API failure handling
- ✅ Subscription cancellation after refund

---

### P2-3: Webhook Signature Verification Tests ✅ COMPLETE
**File**: `__tests__/security/webhook-signature.test.js` (332 lines)
**Status**: COMPLETE (2026-01-26 review)

**All required tests exist**:
- ✅ HMAC-SHA256 signature validation
- ✅ Rejects invalid signature
- ✅ Rejects tampered payload
- ✅ Signature sensitive to URL changes (prevents host injection)
- ✅ Signature sensitive to key changes
- ✅ Production/development mode handling
- ✅ Duplicate event detection (idempotency)
- ✅ Merchant isolation
- ✅ Security edge cases (missing header, empty header, malformed JSON, large payloads)

---

### P2-4: Authentication Edge Case Tests ✅ COMPLETE
**Files**:
- `__tests__/middleware/auth.test.js` (584 lines)
- `__tests__/routes/auth.test.js` (47 tests)
**Status**: COMPLETE (2026-01-26)

**All required tests exist**:
- ✅ requireAuth, requireAuthApi, requireAdmin, requireRole
- ✅ requireWriteAccess, optionalAuth, getCurrentUser
- ✅ getClientIp (x-forwarded-for, x-real-ip, etc.)
- ✅ Session with null/undefined user
- ✅ Missing role property
- ✅ Case-sensitive role matching
- ✅ Session expiry handling (auth.test.js)
- ✅ Session fixation attack prevention (auth.test.js)
- ✅ Session ID regeneration on login (auth.test.js)
- ✅ Secure session cookie configuration (auth.test.js)
- ✅ Session does not contain sensitive data (auth.test.js)
- ✅ Complete session destruction on logout (auth.test.js)
- ✅ Account lockout after failed attempts (auth.test.js)
- ✅ User enumeration prevention (auth.test.js)

Note: Login rate limiting tested in `security.test.js`

---

### P2-5: OAuth Token Refresh Tests ✅ COMPLETE
**File**: `__tests__/security/oauth-csrf.test.js` (41 tests)
**Status**: COMPLETE (2026-01-26)

**All required tests exist**:
- ✅ State parameter generation (256 bits entropy)
- ✅ State storage with expiry (10 minutes)
- ✅ State validation (expired, used, unknown)
- ✅ CSRF attack prevention (state tied to user)
- ✅ Token encryption before storage
- ✅ Tokens not logged in plain text
- ✅ OAuth configuration validation
- ✅ Proactive token refresh (within 1 hour of expiry)
- ✅ Token refresh storage and logging
- ✅ Missing refresh token handling
- ✅ Square API refresh error handling
- ✅ Expired refresh token requiring re-authorization
- ✅ Network error handling during refresh
- ✅ Authentication error non-retry logic
- ✅ Merchant deactivation on permanent refresh failure
- ✅ oauth.authorization.revoked webhook handling
- ✅ Revocation logging and token clearing
- ✅ 401 response for revoked tokens
- ✅ Re-authorization flow after revocation

---

### P2-6: Rate Limiter Effectiveness Tests ✅ COMPLETE
**File**: `__tests__/middleware/security.test.js` (504 lines)
**Status**: COMPLETE (2026-01-26 review)

**All required tests exist**:
- ✅ General rate limit (100/15min default)
- ✅ Login rate limit (5/15min)
- ✅ Delivery rate limit (30/min)
- ✅ Sensitive operation rate limit (5/hour)
- ✅ 429 status with RATE_LIMITED code
- ✅ Key generation (user ID, IP, merchant ID)
- ✅ Health check endpoint skip
- ✅ Environment variable overrides
- ✅ Logging rate limit violations
- ✅ CORS configuration
- ✅ Helmet security headers (CSP, clickjacking, HSTS)

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
- ✅ Modern loyalty service built (`services/loyalty/`) with 2,931 lines of tests
- ✅ P0-1, P0-2, P0-3 security fixes applied

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
| B+ (Current) | 3/4 🟡 | 3/5 🟡 | 6/6 ✅ | - |
