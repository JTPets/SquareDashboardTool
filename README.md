# SqTools — Advanced Inventory Management for Square

A production-grade multi-tenant SaaS platform that extends Square POS with intelligent inventory management, automated reordering, expiration tracking, loyalty programs, and vendor management. Built for the Square App Marketplace.

> **Open Source Transparency** — This codebase is public to demonstrate our commitment to security, quality, and transparency. SqTools is a hosted commercial service at [sqtools.ca](https://sqtools.ca).

---

## What SqTools Does

SqTools transforms Square POS from a point-of-sale system into a complete inventory intelligence platform. Connect your Square account in one click and gain immediate visibility into stock levels, sales trends, and reorder timing across all your locations.

### For Retailers & Restaurants
- **Never run out of stock** — Intelligent reorder suggestions based on actual sales velocity
- **Reduce waste** — Automated expiration tracking with discount tiers before products expire
- **Save time on counting** — Prioritized cycle count queues based on value and movement
- **Manage vendors** — Import price lists, track costs, and generate purchase orders

### For Multi-Location Operations
- **Unified view** — See inventory across all locations from one dashboard
- **Per-location alerts** — Custom reorder points for each store
- **Consolidated purchasing** — Roll up needs from multiple locations into single vendor POs

---

## Platform Capabilities

### Core Inventory Intelligence

| Capability | Description |
|------------|-------------|
| **Real-time Square Sync** | Automatic catalog, inventory, and order synchronization via webhooks |
| **Sales Velocity Tracking** | 91, 182, and 365-day demand calculations per variation per location |
| **Intelligent Reorder Suggestions** | Priority-ranked recommendations with case pack rounding and lead time awareness |
| **Multi-location Support** | Per-location inventory tracking, alerts, and vendor assignments |
| **Catalog Audit** | Identify missing GTINs, images, costs, and expiration dates |

### Purchase Order Management

| Capability | Description |
|------------|-------------|
| **Full PO Lifecycle** | Draft → Submit → Receive workflow with partial receiving support |
| **Vendor Management** | Lead times, minimum orders, contact info, and payment terms |
| **Cost Tracking** | Historical cost data with margin calculations |
| **Export Formats** | CSV and XLSX export for vendor communication |

### Expiration Date Management

| Capability | Description |
|------------|-------------|
| **Expiry Tracking** | Per-variation expiration dates synced to Square custom attributes |
| **Automated Discounts** | Configurable tiers (REVIEW → 25% OFF → 50% OFF → EXPIRED) |
| **Square Integration** | Auto-creates and applies discounts in Square POS |
| **Expiry Audit** | Interface to quickly set dates for items missing expiration data |

### Loyalty Rewards Program

| Capability | Description |
|------------|-------------|
| **Frequent Buyer Offers** | Buy X get 1 free programs by brand and size group |
| **Customer Progress Tracking** | Real-time qualification tracking across purchases |
| **Rolling Time Windows** | Support for "buy 10 in 90 days" style promotions |
| **Automatic Redemption** | Square discounts auto-created when customers qualify |
| **Webhook Integration** | Real-time purchase tracking via Square payment webhooks |

### Delivery Management

| Capability | Description |
|------------|-------------|
| **Order Ingestion** | Automatic capture of delivery orders from Square |
| **Scheduling Calendar** | Visual delivery scheduling with route suggestions |
| **Driver Interface** | Mobile-friendly driver app with proof of delivery |
| **Customer Notes Sync** | Delivery instructions pulled from Square customer records |

### Google Merchant Center Integration

| Capability | Description |
|------------|-------------|
| **Product Feed Generation** | Automated TSV feed creation for Google Shopping |
| **Brand & Taxonomy Mapping** | Map Square categories to Google product taxonomy |
| **Google Sheets Sync** | Direct publish to Google Sheets for Merchant Center |
| **Scheduled Updates** | Automatic feed refresh on your schedule |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SqTools Platform                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  Dashboard  │  │  Inventory  │  │   Loyalty   │  │  Delivery   │    │
│  │   30 pages  │  │ Management  │  │   Rewards   │  │ Management  │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │                │            │
│  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐    │
│  │                     Express.js API Layer                        │    │
│  │              238 endpoints across 20 route modules              │    │
│  └─────────────────────────────┬───────────────────────────────────┘    │
│                                │                                         │
│  ┌─────────────────────────────┴───────────────────────────────────┐    │
│  │                    Service & Middleware Layer                    │    │
│  │  • Authentication & Authorization (role-based)                   │    │
│  │  • Multi-tenant isolation (merchant_id filtering)                │    │
│  │  • Input validation (19 validator modules)                       │    │
│  │  • Rate limiting & security headers                              │    │
│  └─────────────────────────────┬───────────────────────────────────┘    │
│                                │                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │  PostgreSQL  │  │  Square API  │  │  Google API  │                   │
│  │   35+ tables │  │   Webhooks   │  │    Sheets    │                   │
│  └──────────────┘  └──────────────┘  └──────────────┘                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Technical Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js 18+ with Express.js |
| **Database** | PostgreSQL 14+ with 35+ tables and 40+ indexes |
| **Authentication** | Session-based with bcrypt (12 rounds), AES-256-GCM token encryption |
| **External APIs** | Square SDK v43.2.1 (API v2024-10-17), Google APIs v144 |
| **Process Management** | PM2 with clustering support |
| **Logging** | Winston with daily rotation, separate error logs |

### Codebase Statistics

| Metric | Value |
|--------|-------|
| API Endpoints | 238 across 20 route modules |
| Frontend Pages | 30 HTML interfaces |
| Database Tables | 35+ with proper indexing |
| Input Validators | 19 modules covering all endpoints |
| Test Coverage | 194 tests on security-critical functions |

---

## Security Architecture

SqTools is built with defense-in-depth security. Every layer is hardened against common attack vectors.

### Authentication & Access Control

| Control | Implementation |
|---------|----------------|
| **Password Security** | bcrypt v6.0.0 with 12 salt rounds |
| **Session Management** | PostgreSQL-backed sessions, HttpOnly cookies, SameSite=Lax |
| **Rate Limiting** | 5 login attempts per 15 minutes, general API limits |
| **Account Lockout** | 30-minute lockout after 5 failed attempts |
| **Role-Based Access** | admin, user, readonly roles with middleware enforcement |
| **Audit Logging** | All auth events tracked with IP addresses |

### Data Protection

| Control | Implementation |
|---------|----------------|
| **SQL Injection** | 100% parameterized queries throughout codebase |
| **XSS Prevention** | Input sanitization, Content Security Policy headers |
| **Token Encryption** | AES-256-GCM for OAuth tokens at rest |
| **CSRF Protection** | State parameter validation on OAuth flows |
| **File Upload Security** | Magic number validation (not just MIME type) |

### Multi-Tenant Isolation

| Control | Implementation |
|---------|----------------|
| **Query Filtering** | All database queries include merchant_id WHERE clause |
| **Ownership Validation** | Explicit validation of location/vendor ownership |
| **Cross-Tenant Prevention** | Middleware enforces merchant context on every request |
| **Subscription Validation** | Access gated by active subscription status |

### API Security

| Control | Implementation |
|---------|----------------|
| **Authentication Required** | All endpoints require valid session (except public driver API) |
| **Input Validation** | express-validator on all 238 endpoints |
| **Security Headers** | Helmet.js with CSP, X-Frame-Options, X-Content-Type-Options |
| **CORS Enforcement** | Strict origin validation in production |
| **Webhook Verification** | HMAC-SHA256 signature validation on Square webhooks |

### Security Testing

| Component | Tests | Coverage |
|-----------|-------|----------|
| Password utilities | 49 | ~96% |
| Token encryption | 51 | 100% |
| Auth middleware | 38 | ~85% |
| Multi-tenant isolation | 27 | ~30% |
| File validation | 30 | 100% |
| **Total** | **194** | Security-critical paths |

**Vulnerability Status:** 0 npm vulnerabilities (dependencies audited regularly)

---

## API Structure

All endpoints require authentication. The API is organized into logical modules:

| Module | Endpoints | Purpose |
|--------|-----------|---------|
| `/api/auth/*` | 12 | Authentication, password reset, user management |
| `/api/square/oauth/*` | 4 | Square OAuth connection flow |
| `/api/google/oauth/*` | 4 | Google Sheets OAuth flow |
| `/api/merchants/*` | 4 | Merchant context switching |
| `/api/sync/*` | 6 | Full sync, smart sync, status |
| `/api/catalog/*` | 16 | Catalog and inventory operations |
| `/api/analytics/*` | 5 | Sales velocity, reorder analytics |
| `/api/purchase-orders/*` | 9 | PO create, submit, receive |
| `/api/subscriptions/*` | 11 | Subscription management |
| `/api/loyalty/*` | 40 | Loyalty program management |
| `/api/delivery/*` | 23 | Delivery order management |
| `/api/gmc/*` | 32 | Google Merchant Center feeds |
| `/api/webhooks/*` | 8 | Webhook subscription management |
| `/api/expiry-discounts/*` | 13 | Expiry discount automation |
| `/api/vendor-catalog/*` | 13 | Vendor catalog import |
| `/api/cycle-count/*` | 9 | Cycle count management |
| `/api/square-attributes/*` | 9 | Custom attribute management |
| `/api/settings/*` | 3 | Merchant settings |
| `/api/logs/*` | 4 | System log viewing (admin) |
| `/api/driver/*` | 8 | Public driver API |

---

## Webhook Integration

SqTools maintains real-time sync with Square through comprehensive webhook handling:

### Real-Time Events Processed

```
Inventory & Catalog          Orders & Fulfillment         Loyalty & Payments
├── catalog.version.updated  ├── order.created            ├── payment.created
├── inventory.count.updated  ├── order.updated            ├── payment.updated
├── vendor.created           ├── order.fulfillment.updated├── refund.created
├── vendor.updated           └── customer.updated         ├── refund.updated
├── location.created                                      └── loyalty.event.created
└── location.updated

Subscriptions                Security
├── subscription.created     └── oauth.authorization.revoked
├── subscription.updated
├── invoice.payment_made
├── invoice.payment_failed
└── customer.deleted
```

All webhooks are verified using HMAC-SHA256 signature validation. Duplicate events are detected and ignored.

---

## Project Structure

```
SquareDashboardTool/
├── routes/                    # 20 route modules (233 endpoints)
│   ├── auth.js               # Authentication (12 endpoints)
│   ├── loyalty.js            # Loyalty program (40 endpoints)
│   ├── delivery.js           # Delivery management (23 endpoints)
│   ├── gmc.js                # Google Merchant Center (32 endpoints)
│   └── ...                   # Additional route modules
├── middleware/
│   ├── auth.js               # Authentication middleware
│   ├── merchant.js           # Multi-tenant context
│   ├── security.js           # Headers, CORS, rate limiting
│   ├── subscription-check.js # Subscription validation
│   └── validators/           # 19 input validation modules
├── services/
│   └── loyalty/              # Modular loyalty service layer (8 modules)
├── utils/
│   ├── square-api.js         # Square API integration (135KB)
│   ├── database.js           # Connection pool, queries (122KB)
│   ├── loyalty-service.js    # Core loyalty logic (204KB)
│   ├── token-encryption.js   # AES-256-GCM encryption
│   └── ...                   # Additional utilities
├── public/                   # 30 HTML frontend pages
├── database/
│   ├── schema.sql            # Complete PostgreSQL schema
│   └── migrations/           # Schema migrations
├── __tests__/                # Jest test suite (194 tests)
├── server.js                 # Main Express application
└── ecosystem.config.js       # PM2 configuration
```

---

## Square Marketplace Compliance

SqTools meets all Square App Marketplace requirements:

- **OAuth 2.0** — Full authorization code flow with state parameter CSRF protection
- **Token Security** — AES-256-GCM encryption, automatic refresh before expiry
- **Rate Limiting** — Exponential backoff with Retry-After header respect
- **Pagination** — Cursor-based pagination on all list endpoints
- **Webhook Security** — HMAC-SHA256 signature verification
- **Data Isolation** — Complete multi-tenant separation
- **Error Handling** — User-friendly messages, internal logging

---

## Pricing

| Plan | Price | Features |
|------|-------|----------|
| **Free Trial** | $0 for 30 days | Full access to all features |
| **Monthly** | $29.99/month | Full access, email support |
| **Annual** | $299.99/year | Full access, priority support, 2 months free |

---

## Support

**Email:** support@sqtools.ca
**Response Time:** 1-2 business days
**Hours:** Monday-Friday, 9am-5pm EST
**Website:** [sqtools.ca](https://sqtools.ca)

---

## License

MIT License — See [LICENSE](LICENSE) for details.

This software is provided as open source for transparency and security review. Commercial use requires a SqTools subscription.

---

**Version:** 2.0.0
**Last Updated:** January 2026
**Platform:** Hosted SaaS (sqtools.ca)
