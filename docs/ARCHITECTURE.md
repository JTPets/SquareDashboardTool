# Architecture Reference

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Security Audit](./SECURITY_AUDIT.md)

---

## Directory Structure

```
/home/user/SquareDashboardTool/
├── server.js                 # ~1,000 lines - route setup, middleware
├── config/constants.js       # Centralized configuration
├── database/
│   ├── schema.sql            # 51 tables
│   └── migrations/           # 003-046
├── routes/                   # 24 route modules (~257 routes total)
├── middleware/
│   ├── auth.js               # Authentication middleware
│   ├── merchant.js           # Multi-tenant context
│   ├── security.js           # Rate limiting, CORS, CSP
│   └── validators/           # 24 validator modules
├── services/
│   ├── webhook-processor.js  # Webhook routing
│   ├── sync-queue.js         # Sync state (persisted to DB)
│   ├── webhook-handlers/     # 6 event handlers
│   ├── loyalty/              # Modern service layer
│   ├── loyalty-admin/        # Modular loyalty admin (15 modules)
│   ├── catalog/              # Catalog data management
│   ├── merchant/             # Settings service
│   ├── delivery/             # Delivery order management
│   ├── expiry/               # Expiry discount automation
│   ├── inventory/            # Cycle count batch generation
│   ├── gmc/                  # Google Merchant Center
│   ├── vendor/               # Vendor catalog import
│   ├── reports/              # Report generation
│   ├── square/               # Square API integration
│   └── bundle-calculator.js  # Bundle order optimization
├── jobs/                     # Cron tasks
│   ├── cron-scheduler.js     # Job scheduling
│   ├── backup-job.js         # Database backups
│   ├── sync-job.js           # Smart sync
│   ├── cycle-count-job.js    # Inventory counts
│   ├── webhook-retry-job.js  # Failed webhook retry
│   └── expiry-discount-job.js # Discount automation
├── utils/
│   ├── database.js           # Pool with getPoolStats(), transaction()
│   ├── logger.js             # Winston with daily rotation
│   └── response-helper.js    # sendSuccess/sendError helpers
└── public/
    ├── js/
    │   └── event-delegation.js # CSP-compliant event handling
    └── *.html                # Frontend pages
```

---

## Middleware Stack

```
Request → requireAuth → loadMerchantContext → requireMerchant → validators.* → Route Handler
```

### Middleware Functions

| Middleware | File | Purpose |
|------------|------|---------|
| `requireAuth` | `middleware/auth.js` | Verifies session authentication |
| `requireAuthApi` | `middleware/auth.js` | API-specific auth (returns JSON errors) |
| `requireAdmin` | `middleware/auth.js` | Requires admin role |
| `requireRole(role)` | `middleware/auth.js` | Requires specific role |
| `requireWriteAccess` | `middleware/auth.js` | Requires write permission |
| `optionalAuth` | `middleware/auth.js` | Auth optional, adds user if present |
| `loadMerchantContext` | `middleware/merchant.js` | Loads merchant from session |
| `requireMerchant` | `middleware/merchant.js` | Ensures merchant context exists |
| `validators.*` | `middleware/validators/` | Input validation per route |

---

## Rate Limiting

Configured in `middleware/security.js`:

| Limiter | Rate | Applied To |
|---------|------|------------|
| General | 100/15min | All routes |
| Login | 5/15min | `/api/auth/login` |
| Delivery | 30/5min | Delivery endpoints |
| Delivery Strict | 10/5min | Sensitive delivery ops |
| Sensitive Operation | 5/15min | Password changes, etc. |
| Password Reset | 5/15min per token | `/reset-password` |
| Webhook | 100/min per merchant | `/api/webhooks/square` |

---

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

---

## Square Webhook Payload Structure

**Critical**: Square's webhook structure places entity IDs at `event.data.id`, NOT inside `event.data.object`.

```json
{
  "type": "order.created",
  "merchant_id": "MERCHANT_ID",
  "event_id": "EVENT_ID",
  "data": {
    "type": "order",
    "id": "ORDER_ID",          // <-- ENTITY ID IS HERE (event.data.id)
    "object": {
      "order_created": {       // <-- Wrapper with entity details (often minimal)
        "created_at": "...",
        "state": "OPEN"
      }
    }
  }
}
```

### Common Pitfall

The webhook processor passes `event.data.object` as `context.data` to handlers. This means:
- `context.data` = `{ order_created: {...} }` (the wrapper object)
- The entity ID at `event.data.id` is NOT in `context.data`

**When writing webhook handlers**, always use `context.entityId` for the canonical entity ID:

```javascript
// CORRECT - Use context.entityId (extracted by webhook-processor from event.data.id)
const { data, merchantId, event, entityId } = context;
const orderId = entityId || data.some_wrapper?.id || data?.id;

// WRONG - Only checking context.data locations (may miss the ID)
const orderId = data.some_wrapper?.id || data?.id;  // <-- Misses event.data.id
```

This applies to all webhook types: orders, payments, customers, inventory, etc.

---

## Services Directory Structure

```
services/                     # Business logic services
├── webhook-processor.js      # Webhook routing and signature verification
├── sync-queue.js             # Sync state management (persisted to DB)
│
├── webhook-handlers/         # Event handlers for Square webhooks
│   ├── subscription-handler.js
│   ├── catalog-handler.js
│   ├── inventory-handler.js
│   ├── order-handler.js
│   ├── loyalty-handler.js
│   └── oauth-handler.js
│
├── loyalty/                  # Modern loyalty service (P1-1)
│   ├── index.js              # Public API exports
│   ├── webhook-service.js    # LoyaltyWebhookService (main entry)
│   ├── square-client.js      # LoyaltySquareClient + SquareApiError
│   ├── customer-service.js   # LoyaltyCustomerService
│   ├── offer-service.js      # LoyaltyOfferService
│   ├── purchase-service.js   # LoyaltyPurchaseService
│   ├── reward-service.js     # LoyaltyRewardService
│   ├── loyalty-logger.js     # Structured logging
│   ├── loyalty-tracer.js     # Request tracing
│   └── __tests__/            # 2,931 lines of tests
│
├── loyalty-admin/            # Modular loyalty admin (15 modules, 53 exports)
│   ├── index.js              # Public API (re-exports all modules)
│   ├── constants.js          # RewardStatus, AuditActions, RedemptionTypes
│   ├── shared-utils.js       # fetchWithTimeout, getSquareAccessToken
│   ├── audit-service.js      # logAuditEvent, getAuditLogs
│   ├── settings-service.js   # getSetting, updateSetting, initializeDefaults
│   ├── offer-admin-service.js      # Offer CRUD
│   ├── variation-admin-service.js  # Qualifying variation management
│   ├── customer-cache-service.js   # Local customer cache
│   ├── customer-admin-service.js   # Customer lookups, status, history
│   ├── purchase-service.js         # Purchase processing, refunds
│   ├── reward-service.js           # Reward redemption, progress tracking
│   ├── webhook-processing-service.js  # Webhook order processing
│   ├── square-discount-service.js  # Square Customer Group Discount ops
│   ├── backfill-service.js         # Catchup, order history backfill
│   └── expiration-service.js       # Reward/offer expiration processing
│
├── catalog/                  # Catalog data management (P1-2)
│   ├── index.js
│   ├── item-service.js       # Locations, categories, items
│   ├── variation-service.js  # Variations, costs, bulk updates
│   ├── inventory-service.js  # Inventory, low stock, expirations
│   └── audit-service.js      # Catalog audit, location fixes
│
├── merchant/                 # Merchant settings
│   ├── index.js
│   └── settings-service.js
│
├── delivery/                 # Delivery order management
│   ├── index.js
│   └── delivery-service.js
│
├── expiry/                   # Expiry discount automation
│   ├── index.js
│   └── discount-service.js
│
├── inventory/                # Cycle count batch generation
│   ├── index.js
│   └── cycle-count-service.js
│
├── gmc/                      # Google Merchant Center
│   ├── index.js
│   ├── feed-service.js       # TSV feed generation
│   └── merchant-service.js   # GMC API sync
│
├── vendor/                   # Vendor catalog import
│   ├── index.js
│   └── catalog-service.js    # CSV/XLSX import, price comparison
│
├── reports/                  # Report generation
│   ├── index.js
│   └── loyalty-reports.js    # Vendor receipts, audit exports
│
├── square/                   # Square API integration
│   ├── index.js
│   └── api.js                # Sync, inventory, custom attributes, prices
│
└── bundle-calculator.js      # Bundle order optimization (individual vs bundle cost)
```

---

## Loyalty Admin Modules

The `services/loyalty-admin/` directory contains 15 modular services (53 exports) for loyalty program administration. The legacy monolith has been fully eliminated.

**Import rule**: Always import from `services/loyalty-admin` (index.js):
```javascript
const loyaltyAdmin = require('./services/loyalty-admin');
await loyaltyAdmin.processOrderForLoyalty(order, merchantId);
```

### Module Categories

| Category | Modules | Purpose |
|----------|---------|---------|
| Foundation | `constants.js`, `shared-utils.js` | Enums, shared helpers (no service dependencies) |
| Core Admin | `audit-service.js`, `settings-service.js`, `offer-admin-service.js`, `variation-admin-service.js` | CRUD and configuration |
| Customer | `customer-cache-service.js`, `customer-admin-service.js` | Customer data and caching |
| Processing | `purchase-service.js`, `reward-service.js`, `webhook-processing-service.js` | Order/reward processing |
| Integration | `square-discount-service.js`, `expiration-service.js`, `backfill-service.js` | Square API, cleanup, catchup |

### Dependency Rules

- No circular dependencies in the module graph
- Internal modules import directly from siblings, never through index.js
- All dependency arrows are one-way (e.g., `purchase-service` → `square-discount-service`)

---

## Square API Integration

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

### Key Files

| File | Purpose |
|------|---------|
| `middleware/merchant.js` | `getSquareClientForMerchant()` - Creates authenticated client |
| `services/square/api.js` | High-level Square API operations |
| `services/webhook-processor.js` | Webhook signature verification |

---

## Database Patterns

### Multi-Tenant Pattern

```javascript
const merchantId = req.merchantContext.id;

// EVERY database query must include merchant_id
const result = await db.query(
    'SELECT * FROM items WHERE merchant_id = $1 AND id = $2',
    [merchantId, itemId]
);
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

---

## Logging

```javascript
const logger = require('../utils/logger');
logger.info('Operation completed', { merchantId, result });
logger.error('Failed', { error: err.message, stack: err.stack });
```

Log files are in `output/logs/`:
- `app-*.log` - Application logs
- `error-*.log` - Error logs only

---

## Cron Jobs

Scheduled in `jobs/cron-scheduler.js`:

| Job | Schedule | Purpose |
|-----|----------|---------|
| `sync-job.js` | Hourly | Smart sync with Square |
| `backup-job.js` | Daily 2 AM | Database backup |
| `cycle-count-job.js` | Daily 6 AM | Generate count batches |
| `webhook-retry-job.js` | Every 5 min | Retry failed webhooks |
| `expiry-discount-job.js` | Daily 5 AM | Apply expiry discounts |
