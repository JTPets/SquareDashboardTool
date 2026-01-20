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
| ✅ | Vendor management with lead times |
| ✅ | PO export (CSV/XLSX) |
| ✅ | Vendor catalog imports (CSV/XLSX) |
| ✅ | UPC matching and margin calculation |

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

### 7. Loyalty Rewards Program
| Status | Feature |
|--------|---------|
| ✅ | Frequent buyer offers (buy X get 1 free) |
| ✅ | Multiple offers per brand (by size group) |
| ✅ | Variation-level qualification tracking |
| ✅ | Rolling time window support |
| ✅ | Customer progress tracking |
| ✅ | Square discount auto-creation for redemptions |
| ✅ | Webhook-based purchase tracking |
| ✅ | Manual order history backfill |

### 8. Delivery Management
| Status | Feature |
|--------|---------|
| ✅ | Order ingestion from Square webhooks |
| ✅ | Delivery scheduling calendar |
| ✅ | Route optimization suggestions |
| ✅ | Customer notes sync |
| ✅ | Fulfillment status tracking |

### 9. Square Custom Attributes
| Status | Feature |
|--------|---------|
| ✅ | case_pack_quantity |
| ✅ | brand |
| ✅ | expiration_date |
| ✅ | does_not_expire |
| ✅ | expiry_reviewed_at |
| ✅ | Auto-initialization on startup |

### 10. Subscriptions (SaaS)
| Status | Feature |
|--------|---------|
| ✅ | Square Payments integration |
| ✅ | Trial periods |
| ✅ | Promo codes |
| ✅ | Webhook handling (payments, cancellations) |
| ✅ | Subscription middleware |

### 11. System Infrastructure
| Status | Feature |
|--------|---------|
| ✅ | User authentication (bcrypt, sessions) |
| ✅ | Role-based authorization (admin, user, readonly) |
| ✅ | Multi-tenant architecture (merchant isolation) |
| ✅ | Rate limiting |
| ✅ | Scheduled cron jobs (sync, backup, cycle counts) |
| ✅ | Email notifications |
| ✅ | Database backup/restore |
| ✅ | Comprehensive logging |
| ✅ | Webhook signature verification |

---

## Webhooks - Implemented

```
POST /api/webhooks/square (21+ event types handled)

ESSENTIAL - Core Features:
├── order.created              → Delivery ingestion, loyalty tracking
├── order.updated              → Order changes, delivery updates
├── order.fulfillment.updated  → Delivery status sync, sales velocity
├── catalog.version.updated    → Catalog sync (items, prices, variations)
├── inventory.count.updated    → Real-time inventory updates
└── oauth.authorization.revoked → Security - app disconnection

LOYALTY - Frequent Buyer:
├── loyalty.event.created      → Late-linked orders via loyalty card
├── payment.created            → Payment tracking for loyalty
├── payment.updated            → Payment completion triggers loyalty
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

### Webhook Management Endpoints
```
GET  /api/webhooks/subscriptions           → List all webhook subscriptions
GET  /api/webhooks/subscriptions/audit     → Audit configuration
GET  /api/webhooks/event-types             → Available event types
POST /api/webhooks/register                → Register new subscription
POST /api/webhooks/ensure                  → Ensure subscription exists
PUT  /api/webhooks/subscriptions/:id       → Update subscription
DELETE /api/webhooks/subscriptions/:id     → Delete subscription
POST /api/webhooks/subscriptions/:id/test  → Test subscription
```

---

## Environment Variables

```bash
# Square API
SQUARE_APPLICATION_ID=
SQUARE_APPLICATION_SECRET=
SQUARE_ENVIRONMENT=production
SQUARE_WEBHOOK_SIGNATURE_KEY=

# Token Encryption
TOKEN_ENCRYPTION_KEY=

# Database
DB_USER=
DB_HOST=
DB_NAME=
DB_PASSWORD=
DB_PORT=5432

# Session
SESSION_SECRET=

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
SUBSCRIPTION_CHECK_ENABLED=true
DAILY_COUNT_TARGET=50
DEFAULT_SUPPLY_DAYS=30
```

---

## Frontend Pages (20+)

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
| loyalty.html | Loyalty rewards program |
| delivery.html | Delivery management |
| merchants.html | Square OAuth connections |
| settings.html | Configuration |
| logs.html | System logs |
| subscribe.html | Subscription signup |
| support.html | Help/FAQ |
| login.html | User authentication |

---

## Quick Reference: Key Files

| File | Purpose |
|------|---------|
| server.js | Main Express app, all routes |
| utils/square-api.js | Square API wrapper |
| utils/database.js | DB connection, ensureSchema |
| utils/loyalty-service.js | Loyalty program logic |
| utils/expiry-discount.js | Discount automation |
| utils/email-notifier.js | Email sending |
| middleware/auth.js | Authentication |
| middleware/merchant.js | Multi-tenant context |

---

*Last Updated: January 2026*
