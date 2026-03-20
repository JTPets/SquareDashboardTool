# Architecture Reference

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Priorities](./PRIORITIES.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Roadmap](./ROADMAP.md)
>
> **Last Updated**: 2026-03-20

---

## Directory Structure

```
/home/user/SquareDashboardTool/
├── server.js                 # ~1,112 lines - route setup, middleware
├── config/constants.js       # Centralized configuration
├── database/
│   ├── schema.sql            # 67 tables
│   └── migrations/           # 001-002
├── routes/                   # 28 route modules (~283 routes total)
├── middleware/
│   ├── auth.js               # Authentication middleware
│   ├── merchant.js           # Multi-tenant context + subscription enforcement
│   ├── security.js           # Rate limiting, CORS, CSP
│   └── validators/           # 28 validator modules
├── services/
│   ├── webhook-processor.js  # Webhook routing
│   ├── sync-queue.js         # Sync state (persisted to DB)
│   ├── webhook-handlers/     # 8 event handlers
│   ├── loyalty-admin/        # Modular loyalty admin (41 modules, 110 exports)
│   ├── seniors/              # Seniors discount automation
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
├── jobs/                     # Cron tasks (16 files)
│   ├── cron-scheduler.js     # Job scheduling
│   ├── index.js              # Job exports
│   ├── backup-job.js         # Database backups
│   ├── sync-job.js           # Smart sync
│   ├── cycle-count-job.js    # Inventory counts
│   ├── webhook-retry-job.js  # Failed webhook retry
│   ├── expiry-discount-job.js # Discount automation
│   ├── committed-inventory-reconciliation-job.js # Daily committed inventory rebuild
│   ├── loyalty-catchup-job.js # Hourly order catchup
│   ├── loyalty-audit-job.js  # Loyalty event audit
│   ├── seniors-day-job.js    # Seniors discount pricing rules
│   └── cart-activity-cleanup-job.js # Stale cart cleanup
├── utils/
│   ├── database.js           # Pool with getPoolStats(), transaction()
│   ├── logger.js             # Winston with daily rotation
│   └── response-helper.js    # sendSuccess/sendError helpers
└── public/
    ├── js/
    │   ├── event-delegation.js  # CSP-compliant event handling
    │   └── utils/               # Shared frontend utilities
    │       ├── escape.js        # HTML entity escaping
    │       ├── date-format.js   # formatDate, formatDateTime
    │       ├── format-currency.js # formatCurrency, formatDollars, formatNumber
    │       └── toast.js         # Toast notifications
    └── *.html                   # 35 frontend pages
```

---

## Middleware Stack

```
Request → requireAuth → loadMerchantContext → requireMerchant → requireValidSubscription → validators.* → Route Handler
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
| `requireValidSubscription` | `middleware/merchant.js` | Checks trial/subscription status — redirects expired merchants to upgrade page |
| `validators.*` | `middleware/validators/` | Input validation per route |

### Subscription Enforcement (added 2026-03-01)

`requireValidSubscription` checks `merchants.subscription_status` and `trial_ends_at`:
- **active**: Full access
- **trial**: Access if `trial_ends_at > NOW()`; expired trials redirect to `/upgrade.html`
- **expired/canceled**: Redirect to `/upgrade.html`
- NULL `trial_ends_at`: Grandfathered (full access — pre-trial merchants)

`services/subscription-bridge.js` syncs payment events from the `subscribers` table (System B) to `merchants.subscription_status` (System A). Webhook handlers update both tables on subscription lifecycle events.

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
    ├─► subscription-handler.js (subscription.*, invoice.payment_made/failed)
    ├─► catalog-handler.js (catalog.*, vendor.*, location.*)
    ├─► customer-handler.js (customer.created, customer.updated)
    ├─► inventory-handler.js (inventory.count.updated, invoice.* for committed inventory)
    ├─► order-handler.js (order.*, payment.*, refund.*)
    ├─► loyalty-handler.js (loyalty.*, gift_card.*)
    └─► oauth-handler.js (oauth.authorization.revoked)
```

Feature flags: `WEBHOOK_CATALOG_SYNC`, `WEBHOOK_INVENTORY_SYNC`, `WEBHOOK_ORDER_SYNC` (webhook processing only)

### Webhook Subscription Configuration

Managed in `utils/square-webhooks.js`. Full audit completed 2026-02-11.

**Currently subscribed**: 32 events across 8 categories (essential, loyalty, refunds, vendors, locations, subscriptions, committed inventory, customer).

**Added in BACKLOG-10/11** (2026-02-19):
- 7 invoice lifecycle events for committed inventory (`invoice.created/updated/published/canceled/deleted/refunded/scheduled_charge_failed`)
- `customer.created` for loyalty catchup gap

**Not subscribed** (100+ events): No matching features for bookings, labor, terminals, disputes, payouts, bank accounts, cards, transfer orders, custom attributes, etc.

See [archived TECHNICAL_DEBT.md](./archive/TECHNICAL_DEBT.md#square-webhook-subscription-audit-2026-02-11) for the full webhook subscription audit (2026-02-11).

### Committed Inventory Architecture (COMPLETE — BACKLOG-10)

**Implementation**: Invoice webhooks → per-invoice `committed_inventory` table → local DB aggregate rebuild (0-1 API calls per event)

```
PRODUCTION FLOW (2026-02-19):
invoice.created/updated → inventory-handler.js → fetch order (1 API call) → upsert committed_inventory → rebuild aggregate
invoice.canceled/deleted → inventory-handler.js → delete from committed_inventory → rebuild aggregate (0 API calls)
invoice.payment_made → check if fully paid → delete if PAID → rebuild aggregate (0 API calls)
Daily 4 AM cron → committed-inventory-reconciliation-job.js → full reconciliation (~11 API calls once/day)
```

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
│   ├── index.js              # Handler registry (event → handler mapping)
│   ├── subscription-handler.js
│   ├── catalog-handler.js
│   ├── customer-handler.js   # Customer sync, loyalty catchup, seniors birthday
│   ├── inventory-handler.js  # Inventory counts + invoice-driven committed inventory
│   ├── order-handler.js
│   ├── loyalty-handler.js
│   └── oauth-handler.js
│
├── loyalty-admin/            # Modular loyalty admin (41 modules, 110 exports)
│   ├── index.js              # Public API (re-exports all modules)
│   ├── constants.js          # RewardStatus, AuditActions, RedemptionTypes
│   ├── shared-utils.js       # fetchWithTimeout, getSquareAccessToken, squareApiRequest, SquareApiError
│   ├── square-api-client.js  # SquareApiClient class (unified, with 429 retry)
│   ├── loyalty-queries.js    # Shared canonical SQL for offer/variation lookups
│   ├── audit-service.js      # logAuditEvent, getAuditLogs
│   ├── audit-stats-service.js      # Audit statistics and analysis
│   ├── settings-service.js   # getSetting, updateSetting, initializeDefaults
│   ├── offer-admin-service.js      # Offer CRUD
│   ├── variation-admin-service.js  # Qualifying variation management
│   ├── customer-cache-service.js   # Local customer cache
│   ├── customer-admin-service.js   # Customer lookups, status, history
│   ├── customer-details-service.js # Customer detail views
│   ├── customer-refresh-service.js # Customer data refresh from Square
│   ├── customer-search-service.js  # Customer search functionality
│   ├── customer-summary-service.js # Customer summary/aggregate data
│   ├── purchase-service.js         # Purchase processing, split-row rollover
│   ├── refund-service.js           # Refund processing
│   ├── reward-service.js           # Reward redemption, progress tracking, detection
│   ├── reward-progress-service.js  # Reward progress calculations
│   ├── reward-split-service.js     # Multi-reward split handling
│   ├── redemption-audit-service.js # Redemption audit logging and analysis
│   ├── redemption-query-service.js # Redemption queries
│   ├── order-intake.js             # Consolidated order processing entry point
│   ├── order-processing-service.js # Order processing logic
│   ├── order-history-audit-service.js # Order history auditing
│   ├── line-item-filter.js         # Line item filtering logic
│   ├── webhook-processing-service.js  # Webhook order processing (legacy — prefer order-intake)
│   ├── discount-validation-service.js # Discount validity checks
│   ├── square-discount-service.js  # Square Customer Group Discount ops
│   ├── square-discount-catalog-service.js # Square discount catalog management
│   ├── square-customer-group-service.js # Square customer group ops
│   ├── square-reward-service.js    # Square reward API interactions
│   ├── square-sync-service.js      # Square sync for loyalty data
│   ├── square-sync-retry-service.js # Square sync retry logic
│   ├── loyalty-event-prefetch-service.js # Loyalty event prefetching
│   ├── manual-entry-service.js     # Manual loyalty entry processing
│   ├── backfill-service.js         # Catchup, order history backfill
│   ├── backfill-orchestration-service.js # Backfill orchestration
│   ├── customer-identification-service.js  # 6-method customer ID from orders
│   └── expiration-service.js       # Reward/offer expiration processing
│
├── catalog/                  # Catalog data management (P1-2)
│   ├── index.js
│   ├── item-service.js       # Locations, categories, items
│   ├── variation-service.js  # Variations, costs, bulk updates
│   ├── inventory-service.js  # Inventory, low stock, expirations
│   ├── audit-service.js      # Catalog audit, location fixes, enable items at locations
│   ├── catalog-health-service.js  # Catalog health checks
│   ├── location-health-service.js # Location health monitoring
│   ├── location-service.js   # Shared location lookups (BACKLOG-25)
│   └── reorder-math.js       # Reorder calculation utilities
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
├── seniors/                  # Seniors discount automation
│   ├── index.js
│   ├── seniors-service.js    # Seniors discount pricing rule management
│   └── age-calculator.js     # Age calculation from birthday
│
├── square/                   # Square API integration (split from monolith 2026-02-28)
│   ├── index.js              # Facade — re-exports all modules
│   ├── api.js                # Backward-compat shim (107 lines)
│   ├── square-client.js      # Shared infra: getMerchantToken, makeSquareRequest, retry
│   ├── square-catalog-sync.js    # Full + delta catalog sync
│   ├── square-inventory.js       # Inventory counts, alerts, committed inventory
│   ├── square-velocity.js        # Sales velocity sync + incremental updates
│   ├── square-vendors.js         # Vendor sync + reconciliation
│   ├── square-locations.js       # Location sync
│   ├── square-custom-attributes.js  # Custom attribute CRUD + push helpers
│   ├── square-pricing.js        # Price + cost updates, catalog content
│   ├── square-diagnostics.js    # Fix location mismatches, alerts, enable items
│   └── square-sync-orchestrator.js  # fullSync orchestration
│
├── subscription-bridge.js    # Syncs payment events to merchants.subscription_status
│
└── bundle-calculator.js      # Bundle order optimization (individual vs bundle cost)
```

---

## Loyalty Admin Modules

The `services/loyalty-admin/` directory contains 41 modules (110 exports) for loyalty program administration. The legacy monolith and dead modern layer (`services/loyalty/`) have been fully eliminated (BACKLOG-31).

**Import rule**: Always import from `services/loyalty-admin` (index.js):
```javascript
const loyaltyAdmin = require('./services/loyalty-admin');
await loyaltyAdmin.processLoyaltyOrder({ order, merchantId, squareCustomerId, source: 'webhook' });
```

### Order Processing — Single Entry Point

All order processing for loyalty MUST go through `processLoyaltyOrder()` in `order-intake.js`. This function:
- Writes **both** `loyalty_processed_orders` and `loyalty_purchase_events` atomically (same transaction)
- Is idempotent (safe to call twice for the same order)
- Accepts a source tag (`webhook`, `catchup`, `backfill`, `audit`) for debugging

Entry points that call `processLoyaltyOrder()`:
1. `services/webhook-handlers/order-handler.js` — `_processLoyalty()` and `_processPaymentForLoyalty()`
2. `services/webhook-handlers/loyalty-handler.js` — `_processLoyaltyEventWithOrder()`
3. `jobs/loyalty-catchup-job.js` — `processMerchantCatchup()`
4. `services/loyalty-admin/backfill-service.js` — `addOrdersToLoyaltyTracking()`, `runLoyaltyCatchup()`, `processOrderForLoyaltyIfNeeded()`

**Separate concerns** (not part of order intake):
- Refund processing: `processRefund()` in `purchase-service.js` (writes negative-quantity rows to `loyalty_purchase_events`)
- Redemption detection: `detectRewardRedemptionFromOrder()` in `reward-service.js`

### Module Categories

| Category | Modules | Purpose |
|----------|---------|---------|
| Foundation | `constants.js`, `shared-utils.js`, `square-api-client.js`, `loyalty-queries.js` | Enums, shared helpers, Square API client with 429 retry, canonical SQL queries |
| Core Admin | `audit-service.js`, `settings-service.js`, `offer-admin-service.js`, `variation-admin-service.js` | CRUD and configuration |
| Customer | `customer-cache-service.js`, `customer-admin-service.js`, `customer-identification-service.js` | Customer data, caching, and order identification |
| Order Intake | `order-intake.js` | Single entry point for all order → loyalty processing |
| Processing | `purchase-service.js`, `reward-service.js`, `redemption-audit-service.js`, `webhook-processing-service.js` | Per-item purchase recording, rewards, detection audit, refunds |
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
| `middleware/merchant.js` | `getSquareClientForMerchant()` — Creates authenticated SDK client (for SDK methods) |
| `services/loyalty-admin/square-api-client.js` | `SquareApiClient` — Direct HTTP with 429 retry (for loyalty/webhook handlers) |
| `services/square/square-client.js` | Shared infra: `getMerchantToken`, `makeSquareRequest` with retry/rate-limit |
| `services/square/index.js` | Facade — re-exports all 10 split modules (see Services Directory above) |
| `services/webhook-processor.js` | Webhook signature verification |

### Square Variation ID Reuse on POS Reorder (BACKLOG-34)

When a merchant reorders (rearranges) item variations in Square POS or Dashboard, Square **deletes the existing variations and recreates them with new catalog object IDs**. This is not documented in Square's API reference but is confirmed behavior.

**Impact on SqTools**:
- Historical `loyalty_purchase_events`, `sales_velocity`, and `order` records reference the old variation IDs
- Lookups by variation ID against current catalog return no results for pre-reorder data
- `variation_discount_status` and `variation_expiration` rows become orphaned (FK CASCADE deletes them when the variation row is removed during catalog sync)

**Current mitigations**:
- Delta catalog sync (`square-catalog-sync.js`) detects deleted variations and marks them `is_deleted = TRUE` rather than hard-deleting, preserving historical references
- Sales velocity reporting uses the Inventory Changes API (daily full sync) which aggregates by item, not variation, reducing the impact of ID churn
- The `deleted-items.html` page surfaces deleted/recreated items for manual review

**Future mitigation** (Roadmap):
- Sales velocity refactor to use Inventory Changes API as primary source (eliminates variation ID dependency for velocity data)
- Consider storing a stable `item_id + variation_ordinal` composite key for historical joins

**Recommendation**: Do not build features that require long-lived variation ID stability for historical analysis. Prefer item-level aggregation or snapshot-based approaches.

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
| `committed-inventory-reconciliation-job.js` | Daily 4 AM | Full committed inventory rebuild (safety net) |
| `loyalty-catchup-job.js` | Hourly | Catch orders missed by webhook race conditions |
| `loyalty-audit-job.js` | Daily | Audit loyalty events vs redemption records |
| `seniors-day-job.js` | Daily | Manage seniors discount pricing rules |
| `cart-activity-cleanup-job.js` | Daily | Clean up stale cart activity records |
| `catalog-health-job.js` | Periodic | Catalog health checks |
| `catalog-location-health-job.js` | Periodic | Location health monitoring |
| `loyalty-sync-retry-job.js` | Periodic | Retry failed loyalty syncs |
| `trial-expiry-job.js` | Daily | Handle trial expiration |

---

## Frontend Pages

35 HTML pages in `public/`. All application pages load `event-delegation.js` and `utils/escape.js` for CSP compliance.

| Page | Description |
|------|-------------|
| `index.html` | Landing page — inventory management overview |
| `login.html` | Authentication login form |
| `set-password.html` | Set password for new/invited users |
| `dashboard.html` | Main dashboard — stats, alerts, inventory summary |
| `inventory.html` | Full inventory list with search and filtering |
| `reorder.html` | Reorder suggestions based on sales velocity and stock |
| `sales-velocity.html` | Sales velocity reports — fast/slow movers |
| `cycle-count.html` | Active cycle count — scan and count inventory |
| `cycle-count-history.html` | Cycle count history — accuracy and variance |
| `expiry.html` | Expiration tracker — items with expiry data |
| `expiry-discounts.html` | Expiry discount manager — automated discount rules |
| `expiry-audit.html` | Expiry audit — discount application history |
| `catalog-audit.html` | Catalog audit — detect and fix catalog issues |
| `catalog-workflow.html` | Catalog workflow — AI content autofill for items |
| `deleted-items.html` | Deleted and archived items from Square |
| `bundle-manager.html` | Bundle manager — create/manage product bundles |
| `loyalty.html` | Loyalty program manager — offers, customers, rewards |
| `delivery.html` | Delivery scheduler — manage delivery orders |
| `delivery-route.html` | Driver route — optimized delivery route view |
| `delivery-history.html` | Delivery history — completed deliveries |
| `delivery-settings.html` | Delivery settings — zones, fees, scheduling |
| `driver.html` | Driver view — mobile-friendly route for drivers |
| `cart-activity.html` | Cart activity — abandoned and active carts |
| `purchase-orders.html` | Purchase orders — create and manage POs |
| `vendor-dashboard.html` | Vendor dashboard — vendor overview and PO status |
| `vendor-catalog.html` | Vendor catalog import — CSV/XLSX price comparison |
| `gmc-feed.html` | Google Merchant Center feed — product and local inventory |
| `settings.html` | Account settings — users, preferences |
| `merchants.html` | Manage Square accounts (admin/platform owner) |
| `admin-subscriptions.html` | Subscription management (admin) |
| `logs.html` | System logs viewer |
| `subscribe.html` | Subscription signup page |
| `subscription-expired.html` | Subscription expired notice |
| `upgrade.html` | Upgrade subscription — trial/expired redirect target |
| `support.html` | Support page — help and contact |
