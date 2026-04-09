# SqTools — Multi-Tenant Square POS Platform

Custom multi-tenant SaaS platform extending Square POS with loyalty, delivery, vendor management, catalog automation, and business intelligence tools. Built for independent retailers.

**Website:** [sqtools.ca](https://sqtools.ca)

---

## Tech Stack

| Component | Details |
|-----------|---------|
| **Runtime** | Node.js 18+ with Express.js |
| **Database** | PostgreSQL 15 (67 tables, 3 active migrations (66 archived)) |
| **External APIs** | Square SDK v43.2.1, Google APIs v144, Claude API |
| **Auth** | Session-based, bcrypt (12 rounds), AES-256-GCM token encryption |
| **Process Mgmt** | PM2 with clustering support |
| **Infrastructure** | Raspberry Pi 5, Cloudflare Tunnel |
| **Tests** | 5,464 across 268 suites, 0 failures (Jest) |
| **Endpoints** | ~283 across 28 route modules |
| **Frontend** | 35 HTML pages, CSP-compliant (no inline scripts) |

---

## Feature Inventory

### Loyalty Engine
Custom buy-X-get-Y-free programs with state machine, split-row rollover handling, rolling time windows, and Square discount/pricing rule integration. 41 modular services, 630 loyalty-specific tests.

### Delivery System
Automatic order capture from Square webhooks, visual scheduling calendar, geocoded route optimization via OpenRouteService, mobile driver app with proof-of-delivery photos.

### Vendor Management
CSV/XLSX vendor catalog import, price comparison against current costs, per-vendor lead times and reorder thresholds, purchase order lifecycle (Draft → Submit → Partial Receive → Complete).

### Catalog Sync
Bidirectional Square catalog synchronization (full + delta), custom attribute management (brand, case pack, expiry date), inventory tracking across all locations, catalog health monitoring.

### Expiry/Discount Automation
Tier-based expiry discount system (REVIEW → AUTO25 → AUTO50 → EXPIRED) with automatic Square pricing rule creation and daily cron evaluation. Partial-expiry pull workflow for mixed stock.

### Seniors Day Automation
Monthly age-verified discount program (60+) using Square customer groups and pricing rules. Cron-scheduled enable/disable with webhook-driven birthday detection.

### Subscription Management
Trial periods, promo codes, Square payment integration, webhook-driven lifecycle management, subscription enforcement middleware gating all authenticated endpoints.

### Google Merchant Center
Automated product feed generation (TSV), brand and Google taxonomy mapping, direct publish to Google Sheets on schedule. Uses Google Merchant API v1.

### AI-Powered SEO
Claude API integration for generating catalog descriptions and product captions for Square Online Store.

### Cart Activity Tracking
Abandoned cart detection from Square order webhooks, conversion analytics, stale cart cleanup cron.

### Cycle Counts
Daily batch generation prioritized by value and movement, mobile-friendly counting interface, variance reporting, Square inventory sync on submission.

### Bundle Calculator
Bundle vs individual cost optimization — calculates whether buying a bundle or individual items is cheaper based on current inventory and sales velocity.

### Label Generation
ZPL-format label generation for thermal printers with catalog data.

### Webhook Infrastructure
20+ Square event types handled with HMAC-SHA256 signature verification, event deduplication, idempotency, and retry logic. 8 specialized handlers (catalog, inventory, order, customer, loyalty, subscription, invoice, OAuth).

### Sales Velocity & Reorder Intelligence
91/182/365-day velocity windows per variation per location, urgency-ranked reorder suggestions with case-pack rounding and per-vendor lead times.

---

## Architecture

### Multi-Tenant Isolation
Every database query filters by `merchant_id`. OAuth tokens encrypted with AES-256-GCM. Webhook signatures verified with HMAC-SHA256. Subscription enforcement gates all authenticated endpoints.

### Middleware Stack
```
Request → requireAuth → loadMerchantContext → requireMerchant → requireValidSubscription → validators → Handler
```

### Webhook-Driven Event Processing
```
POST /api/webhooks/square → HMAC verify → idempotency check → merchant resolve → route to handler
```

### Project Structure
```
routes/              28 route modules (~283 endpoints)
middleware/          Auth, merchant context, security, 26 validator modules
services/            Business logic (loyalty-admin, catalog, webhooks, reports, square, delivery, expiry, gmc, vendor, seniors, inventory, merchant)
utils/               Database, logging, encryption, Square/Google API helpers
public/              35 HTML frontend pages + JS
database/            Schema (67 tables) + 3 active migrations (66 archived)
jobs/                12 cron tasks (velocity sync, expiry audit, backups, loyalty catchup, etc.)
__tests__/           4,500+ tests (Jest)
```

---

## Test Coverage

| Component | Tests |
|-----------|-------|
| Loyalty-admin | 857+ |
| Security (auth, encryption, validation) | 194 |
| Routes, services, webhooks | ~4,400+ |
| **Total** | **5,464 / 268 suites / 0 failures** |

Core security rated A+ (multi-tenant isolation, auth, injection prevention, data integrity).

---

## Development Workflow

- **Development**: Claude Code on GitHub, feature branches from `main`
- **Review**: Manual merge to `main`
- **Deploy**: `pm2 restart sqtools` on Raspberry Pi 5
- **Access**: Cloudflare Tunnel for external HTTPS

---

## Getting Started

```bash
npm install
cp .env.example .env       # Edit with your credentials
npm run migrate             # Initialize database
npm run dev                 # Start development server
npm test                    # Run tests
```

See [docs/SETUP.md](docs/SETUP.md) for full setup, database initialization, deployment, and Cloudflare Tunnel configuration.

Connect your Square account via OAuth at `/login`, and SqTools handles the rest.

---

## Square Marketplace Compliance

SqTools meets all Square App Marketplace requirements: OAuth 2.0 with CSRF protection, AES-256-GCM token encryption, rate limiting with exponential backoff, cursor-based pagination, HMAC-SHA256 webhook verification, and complete multi-tenant data isolation. See [MARKETPLACE_COMPLIANCE.md](MARKETPLACE_COMPLIANCE.md) for the full checklist.

---

## Documentation

| Document | Contents |
|----------|----------|
| [CLAUDE.md](CLAUDE.md) | Development rules, patterns, code standards |
| [docs/SETUP.md](docs/SETUP.md) | Local dev setup, deployment, infrastructure |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, webhook flow, services structure |
| [docs/BACKLOG.md](docs/BACKLOG.md) | All open work items by priority |
| [docs/DOMAIN-MAP.md](docs/DOMAIN-MAP.md) | Codebase organization and dependencies |
| [docs/CODE-RULES.md](docs/CODE-RULES.md) | Code limits, checklists, PR process |
| [SECURITY.md](SECURITY.md) | Security architecture and controls |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines |
| [MARKETPLACE_COMPLIANCE.md](MARKETPLACE_COMPLIANCE.md) | Square App Marketplace compliance |

---

## License

MIT License — See [LICENSE](LICENSE) for details.
