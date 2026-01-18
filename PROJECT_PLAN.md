# Square Dashboard Addon - Project Plan

## Current System Overview

### Tech Stack
- **Backend:** Node.js 18+, Express.js
- **Database:** PostgreSQL 14+
- **Frontend:** Vanilla HTML/JS (no framework)
- **Process Manager:** PM2
- **External APIs:** Square, Google Sheets/OAuth

---

## Feature Modules

### 1. Core Inventory Management
| Status | Feature |
|--------|---------|
| ✅ | Square catalog sync (items, variations, categories) |
| ✅ | Multi-location inventory tracking |
| ✅ | Low stock alerts with configurable thresholds |
| ✅ | Soft-delete tracking for removed items |
| ✅ | Catalog audit and consistency checks |

### 2. Sales & Analytics
| Status | Feature |
|--------|---------|
| ✅ | Sales velocity (91/182/365 day periods) |
| ✅ | Intelligent reorder suggestions |
| ✅ | Supply days calculation |

### 3. Purchasing
| Status | Feature |
|--------|---------|
| ✅ | Purchase order creation/management |
| ✅ | Vendor management |
| ✅ | PO export (CSV/XLSX) |
| ⚠️ | PO receiving (doesn't update Square inventory) |

### 4. Cycle Counting
| Status | Feature |
|--------|---------|
| ✅ | Daily batch generation |
| ✅ | Count queue management |
| ✅ | Accuracy tracking |
| ✅ | Sync counts to Square |
| ✅ | Email reports |

### 5. Expiration Management
| Status | Feature |
|--------|---------|
| ✅ | Expiration date tracking |
| ✅ | Automatic discount tiers (REVIEW, AUTO25, AUTO50, EXPIRED) |
| ✅ | Square discount integration |
| ✅ | Expiry audit interface |
| ✅ | Review tracking with Square sync |

### 6. Google Merchant Center
| Status | Feature |
|--------|---------|
| ✅ | OAuth integration |
| ✅ | TSV feed generation |
| ✅ | Brand management |
| ✅ | Google taxonomy mapping |
| ✅ | Google Sheets sync |

### 7. Vendor Catalogs
| Status | Feature |
|--------|---------|
| ✅ | CSV/XLSX import |
| ✅ | UPC matching |
| ✅ | Margin calculation |
| ✅ | Batch management |

### 8. Square Custom Attributes
| Status | Feature |
|--------|---------|
| ✅ | case_pack_quantity |
| ✅ | brand |
| ✅ | expiration_date |
| ✅ | does_not_expire |
| ✅ | expiry_reviewed_at |
| ✅ | Auto-initialization on startup |

### 9. Subscriptions (SaaS)
| Status | Feature |
|--------|---------|
| ✅ | Square Payments integration |
| ✅ | Trial periods |
| ✅ | Webhook handling (payments, cancellations) |
| ✅ | Subscription middleware |

### 10. System Infrastructure
| Status | Feature |
|--------|---------|
| ✅ | Scheduled cron jobs (sync, backup, cycle counts) |
| ✅ | Email notifications |
| ✅ | Database backup/restore |
| ✅ | Comprehensive logging |
| ❌ | User authentication/authorization |
| ❌ | Rate limiting |

---

## Database Tables (27 total)

### Core
- `sync_history`, `locations`, `categories`, `images`, `items`, `variations`
- `variation_vendors`, `variation_location_settings`

### Inventory & Analytics
- `inventory_counts`, `sales_velocity`
- `count_history`, `count_queue_priority`, `count_queue_daily`, `count_sessions`

### Purchasing
- `vendors`, `purchase_orders`, `purchase_order_items`

### Expiration
- `variation_expiration`, `expiry_discount_tiers`, `variation_discount_status`
- `expiry_discount_audit_log`, `expiry_discount_settings`

### GMC
- `brands`, `google_taxonomy`, `category_taxonomy_mapping`, `item_brands`
- `gmc_settings`, `gmc_feed_history`, `google_oauth_tokens`

### Vendor Catalog
- `vendor_catalog_items`

### Subscriptions
- `subscribers`, `subscription_payments`, `subscription_plans`, `subscription_events`

---

## Webhooks - Current vs Planned

### Currently Implemented ✅
```
POST /api/webhooks/square (21 event types handled)

ESSENTIAL - Core Features:
├── order.created              → Delivery ingestion, loyalty tracking, committed inventory
├── order.updated              → Order changes, delivery updates, loyalty
├── order.fulfillment.updated  → Delivery status sync, sales velocity
├── catalog.version.updated    → Catalog sync (items, prices, variations)
├── inventory.count.updated    → Real-time inventory updates
└── oauth.authorization.revoked → Security - app disconnection

LOYALTY - Frequent Buyer:
├── loyalty.event.created      → Late-linked orders via loyalty card
├── payment.created            → Payment tracking for loyalty
└── payment.updated            → Payment completion triggers loyalty

REFUNDS:
├── refund.created             → Refund processing for loyalty
└── refund.updated             → Refund status changes

VENDORS & LOCATIONS:
├── vendor.created             → New vendors
├── vendor.updated             → Vendor changes
├── location.created           → New locations
└── location.updated           → Location changes

SUBSCRIPTIONS:
├── subscription.created       → Create subscriber record
├── subscription.updated       → Update subscription status
├── invoice.payment_made       → Record payment, activate subscription
├── invoice.payment_failed     → Mark past_due, log failure
└── customer.deleted           → Cancel subscriptions

CUSTOMERS:
└── customer.updated           → Sync notes to delivery orders
```

### Previously Planned (Now Implemented)
```
catalog.version.updated     ✅ Triggers catalog sync
inventory.count.updated     ✅ Updates local inventory
order.created               ✅ Updates sales data, delivery, loyalty
order.fulfilled             ✅ Updates sales velocity
```

### Implementation Risk Assessment

| Addition | Risk | Reason |
|----------|------|--------|
| `catalog.version.updated` | **LOW** | Calls existing `syncCatalog()` function |
| `inventory.count.updated` | **LOW** | Calls existing `syncInventory()` function |
| `order.created` | **LOW** | Calls existing sales sync functions |
| `order.fulfilled` | **LOW** | Same as above |

**Why Low Risk:**
1. Webhook endpoint already exists with signature verification
2. Event handling pattern established (switch statement)
3. Only calling existing, tested sync functions
4. Graceful error handling already in place
5. Can be enabled/disabled via environment variable

---

## Webhook Implementation Plan

### Phase 1: Add Event Handlers (30 min)
Add cases to existing switch statement in `server.js:7227`:

```javascript
case 'catalog.version.updated':
    if (process.env.WEBHOOK_CATALOG_SYNC !== 'false') {
        await squareApi.syncCatalog();
    }
    break;

case 'inventory.count.updated':
    if (process.env.WEBHOOK_INVENTORY_SYNC !== 'false') {
        // Can do targeted sync for specific variation
        const variationId = data.inventory_count?.catalog_object_id;
        await squareApi.syncInventory();
    }
    break;

case 'order.created':
case 'order.updated':
case 'order.fulfilled':
    if (process.env.WEBHOOK_SALES_SYNC !== 'false') {
        await squareApi.syncSalesData();
    }
    break;
```

### Phase 2: Webhook Registration Endpoint ✅ IMPLEMENTED
Webhook registration and management is now available via the following endpoints:

```javascript
// List all webhook subscriptions
GET /api/webhooks/subscriptions

// Audit current configuration against recommended event types
GET /api/webhooks/subscriptions/audit

// Get available event types and categories
GET /api/webhooks/event-types

// Register a new webhook subscription
POST /api/webhooks/register
// Body: { notificationUrl, eventTypes?, name? }

// Ensure subscription exists (create if missing)
POST /api/webhooks/ensure
// Body: { notificationUrl, eventTypes?, updateIfExists? }

// Update a subscription
PUT /api/webhooks/subscriptions/:subscriptionId
// Body: { enabled?, eventTypes?, notificationUrl?, name? }

// Delete a subscription
DELETE /api/webhooks/subscriptions/:subscriptionId

// Test a subscription
POST /api/webhooks/subscriptions/:subscriptionId/test
```

Utility module: `utils/square-webhooks.js`

### Phase 3: Add Admin UI (Optional)
- Settings page to enable/disable webhook types
- View webhook history
- Test webhook connectivity

---

## Environment Variables

### Current
```bash
# Square API
SQUARE_ACCESS_TOKEN=
SQUARE_ENVIRONMENT=production
SQUARE_WEBHOOK_SIGNATURE_KEY=

# Database
DB_USER=
DB_HOST=
DB_NAME=
DB_PASSWORD=
DB_PORT=5432

# Email
EMAIL_ENABLED=true
EMAIL_HOST=
EMAIL_PORT=
EMAIL_USER=
EMAIL_PASS=

# Cron Schedules
SYNC_CRON_SCHEDULE=0 * * * *
BACKUP_CRON_SCHEDULE=0 2 * * 0
CYCLE_COUNT_CRON=0 1 * * *
EXPIRY_DISCOUNT_CRON=0 6 * * *

# Features
SUBSCRIPTION_CHECK_ENABLED=false
DAILY_COUNT_TARGET=50
DEFAULT_SUPPLY_DAYS=30
```

### Proposed Additions (for webhooks)
```bash
# Webhook Feature Flags
WEBHOOK_CATALOG_SYNC=true
WEBHOOK_INVENTORY_SYNC=true
WEBHOOK_SALES_SYNC=true
```

---

## API Endpoint Count by Category

| Category | Count |
|----------|-------|
| Health & Logs | 6 |
| Settings | 5 |
| Sync | 4 |
| Catalog & Inventory | 12 |
| Expirations | 14 |
| Custom Attributes | 8 |
| Sales & Reorder | 2 |
| Cycle Counting | 8 |
| Purchase Orders | 9 |
| Vendors & Locations | 2 |
| Vendor Catalog | 11 |
| Google/GMC | 20 |
| Database | 3 |
| Subscriptions | 6 |
| Webhooks | 1 |
| **Total** | **~111** |

---

## Frontend Pages (18 total)

| Page | Purpose |
|------|---------|
| index.html | Dashboard home |
| inventory.html | Inventory management |
| reorder.html | Reorder suggestions |
| purchase-orders.html | PO management |
| sales-velocity.html | Sales analytics |
| cycle-count.html | Daily counting |
| cycle-count-history.html | Count history |
| expiry.html | Expiration dates |
| expiry-audit.html | Expiry verification |
| expiry-discounts.html | Discount tiers |
| gmc-feed.html | Google Merchant |
| vendor-catalog.html | Vendor imports |
| settings.html | Configuration |
| logs.html | System logs |
| subscribe.html | Subscription signup |
| support.html | Help/FAQ |

---

## Not Implemented (Future Considerations)

1. **Authentication/Authorization** - Currently open access
2. **Rate Limiting** - No API rate limits
3. **User Roles** - No permission system
4. **Multi-tenant** - Single business only
5. **Audit Logging** - Partial (expiry only)
6. **Real-time Updates** - No WebSocket/SSE

---

## Quick Reference: Key Files

| File | Purpose | Size |
|------|---------|------|
| server.js | Main Express app, all routes | ~300KB |
| utils/square-api.js | Square API wrapper | ~80KB |
| utils/database.js | DB connection, ensureSchema | ~25KB |
| utils/expiry-discount.js | Discount automation | ~15KB |
| utils/email-notifier.js | Email sending | ~8KB |

---

*Last Updated: December 2024*
