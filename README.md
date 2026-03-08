# SqTools — Inventory Intelligence for Square POS

SqTools turns Square into a complete inventory management platform. Connect your Square account in one click and get automated reorder suggestions, expiration tracking, loyalty programs, vendor management, delivery coordination, and more — across all your locations.

Built solo by a pet store owner who needed better tools. No CS degree, no VC funding, no team. Just a Raspberry Pi, Node.js, and 1,827 tests.

---

## What It Does

### Inventory Intelligence
- **Reorder suggestions** ranked by urgency, with case-pack rounding and per-vendor lead times
- **Sales velocity tracking** across 91, 182, and 365-day windows per variation per location
- **Cycle count queues** prioritized by value and movement — count what matters first
- **Catalog audit** to catch missing GTINs, images, costs, and expiration dates

### Expiration Date Management
- Track expiry dates per variation, synced to Square custom attributes
- Automated discount tiers (REVIEW > 25% OFF > 50% OFF > EXPIRED) applied directly in Square POS
- Partial-expiry workflow: pull only the expired units, update remaining count and date

### Loyalty Rewards
- Frequent buyer programs by brand and size group (buy X, get 1 free)
- Real-time purchase tracking via Square webhooks
- Rolling time windows, automatic redemption via Square discounts
- Full audit trail with order-level purchase event logging

### Vendor Management
- Import vendor price lists, track costs, manage lead times
- Per-vendor reorder thresholds with lead time awareness
- Purchase order lifecycle: Draft > Submit > Receive with partial receiving

### Delivery Management
- Automatic capture of delivery orders from Square
- Visual scheduling calendar with route suggestions
- Mobile-friendly driver app with proof-of-delivery photos

### Google Merchant Center
- Automated product feed generation for Google Shopping
- Brand and taxonomy mapping to Google product categories
- Direct publish to Google Sheets on a schedule

### Seniors Day Automation
- Monthly 60+ discount program with automatic Square pricing rules
- Age verification via Square customer profiles
- Runs on schedule with no staff intervention required

---

## Technical Overview

| Component | Details |
|-----------|---------|
| **Runtime** | Node.js 18+ with Express.js |
| **Database** | PostgreSQL 14+ (51 tables, 40+ indexes) |
| **External APIs** | Square SDK v43.2.1, Google APIs v144 |
| **Auth** | Session-based, bcrypt (12 rounds), AES-256-GCM token encryption |
| **Process Mgmt** | PM2 with clustering support |
| **Tests** | 1,827 across security, services, routes, and webhooks |
| **Endpoints** | 257 across 24 route modules |
| **Frontend** | 33 HTML pages, CSP-compliant (no inline scripts) |

### Multi-Tenant Architecture

Every query filters by `merchant_id`. Tokens are encrypted at rest. OAuth flows use CSRF state validation. Webhook signatures are verified with HMAC-SHA256. Subscription enforcement gates all authenticated endpoints.

### Real-Time Square Sync

Webhooks keep inventory, catalog, orders, loyalty, and payments in sync automatically. 20+ event types handled with deduplication, idempotency, and retry logic.

---

## Project Structure

```
routes/              24 route modules (257 endpoints)
middleware/          Auth, merchant context, security, 24 validator modules
services/            Business logic (loyalty-admin, catalog, webhooks, reports)
utils/               Database, logging, encryption, Square/Google API helpers
public/              33 HTML frontend pages
database/            Schema (51 tables) + migrations
jobs/                Cron tasks (velocity sync, expiry audit, backups)
__tests__/           1,827 tests (Jest)
```

---

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your PostgreSQL and Square credentials

# Initialize database
set -a && source .env && set +a && \
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/schema.sql

# Start development server
npm run dev

# Run tests
npm test
```

Connect your Square account via OAuth at `/login`, and SqTools handles the rest.

---

## Square Marketplace Compliance

SqTools meets all Square App Marketplace requirements: OAuth 2.0 with CSRF protection, AES-256-GCM token encryption, rate limiting with exponential backoff, cursor-based pagination, HMAC-SHA256 webhook verification, and complete multi-tenant data isolation.

---

## License

MIT License — See [LICENSE](LICENSE) for details.

---

**Website:** [sqtools.ca](https://sqtools.ca)
