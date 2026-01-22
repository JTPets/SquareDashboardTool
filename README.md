# Square Dashboard Addon Tool

A comprehensive multi-tenant inventory management SaaS for Square POS merchants. Built for the Square App Marketplace with full OAuth integration, automated reorder suggestions, expiration tracking, Google Merchant Center feeds, and purchase order management.

## Production Status

| Component | Status |
|-----------|--------|
| Authentication | ✅ Session-based with bcrypt password hashing |
| Authorization | ✅ Role-based (admin, user, readonly) |
| Multi-Tenant | ✅ Full merchant isolation with `merchant_id` filtering |
| Rate Limiting | ✅ Implemented on auth endpoints |
| Square OAuth | ✅ Full OAuth 2.0 flow with encrypted token storage |
| Webhooks | ✅ Real-time sync from Square events |
| HTTPS | ✅ Required for production |
| API Security | ✅ All endpoints require authentication |

## Features

### Core Inventory Management
- **Square POS Integration** - OAuth connection, catalog sync, inventory tracking
- **Sales Velocity Tracking** - 91, 182, and 365-day demand calculations
- **Intelligent Reorder Suggestions** - Priority-ranked with case pack rounding
- **Purchase Order Management** - Create, submit, receive, export to Square CSV
- **Multi-location Support** - Per-location inventory and alerts

### Advanced Features
- **Expiration Date Tracking** - Track product expiry with Square custom attributes
- **Automated Expiry Discounts** - Auto-apply tiered discounts as products near expiry
- **Google Merchant Center** - Generate product feeds, Google Sheets integration
- **Vendor Catalog Import** - Import CSV/XLSX price lists, match to catalog
- **Cycle Count System** - Prioritized counting queues with history tracking
- **Catalog Audit Tool** - Find missing data (GTINs, images, costs, expiry dates)

### Multi-Tenant SaaS
- **Square OAuth** - Merchants connect their own Square accounts
- **Tenant Isolation** - Complete data separation between merchants
- **Subscription System** - Trial periods, payment processing via Square
- **User Management** - Invite team members with role-based access

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js 18+ with Express |
| Database | PostgreSQL 14+ |
| Auth | Session-based with bcrypt |
| Square | OAuth 2.0, API v2024-10-17, Webhooks |
| Google | Sheets API, OAuth 2.0 |
| Email | Nodemailer (SMTP/Gmail) |

## Pages (23 Total)

| Page | Description |
|------|-------------|
| `index.html` | Public landing page |
| `login.html` | User authentication |
| `dashboard.html` | Main user dashboard with tool navigation |
| `merchants.html` | Connect/manage Square accounts |
| `inventory.html` | Full inventory view with search/filter |
| `reorder.html` | Priority-ranked reorder suggestions |
| `purchase-orders.html` | Create, edit, submit, receive POs |
| `sales-velocity.html` | Sales trend analysis |
| `expiry.html` | Expiration date tracker |
| `expiry-discounts.html` | Automated discount tier management |
| `expiry-audit.html` | Audit tool for missing expiry data |
| `cycle-count.html` | Inventory counting interface |
| `cycle-count-history.html` | Count history and audit trail |
| `vendor-catalog.html` | Import vendor price lists |
| `catalog-audit.html` | Find catalog data gaps |
| `gmc-feed.html` | Google Merchant Center feed management |
| `deleted-items.html` | Manage soft-deleted items |
| `settings.html` | User and system settings |
| `logs.html` | System log viewer (admin) |
| `subscribe.html` | Subscription signup |
| `subscription-expired.html` | Expired subscription notice |
| `set-password.html` | Password reset flow |
| `support.html` | Support contact page |

## API Endpoints (238 Total)

All API endpoints require authentication. Endpoints are organized into 20 route files:

| Route File | Endpoints | Description |
|------------|-----------|-------------|
| `/api/auth/*` | 12 | Authentication, password reset, user management |
| `/api/square/oauth/*` | 4 | Square OAuth flow |
| `/api/google/oauth/*` | 4 | Google OAuth flow |
| `/api/driver/*` | 8 | Public driver API |
| `/api/merchants/*` | 4 | Switch merchants, context |
| `/api/settings/*` | 3 | Merchant settings |
| `/api/sync/*` | 6 | Full sync, smart sync, status |
| `/api/catalog/*` | 16 | Catalog/inventory operations |
| `/api/analytics/*` | 5 | Sales/reorder analytics |
| `/api/purchase-orders/*` | 9 | PO CRUD, submit, receive |
| `/api/subscriptions/*` | 11 | Subscription management |
| `/api/loyalty/*` | 40 | Loyalty rewards program |
| `/api/delivery/*` | 23 | Delivery management |
| `/api/gmc/*` | 32 | GMC feeds, Google Sheets |
| `/api/webhooks/*` | 8 | Webhook management |
| `/api/expiry-discounts/*` | 13 | Discount tiers, automation |
| `/api/vendor-catalog/*` | 13 | Import, search, match |
| `/api/cycle-count/*` | 9 | Count queues, sessions |
| `/api/square-attributes/*` | 9 | Square custom attributes |
| `/api/logs/*` | 4 | Log viewer (admin) |

## Quick Start

### 1. Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Square Developer Account

### 2. Installation

```bash
# Clone and install
git clone <repository-url>
cd SquareDashboardTool
npm install

# Create database
psql -U postgres -c "CREATE DATABASE square_dashboard_addon;"
psql -U postgres -d square_dashboard_addon -f database/schema.sql

# Configure environment
cp .env.example .env
# Edit .env with your settings
```

### 3. Required Environment Variables

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=square_dashboard_addon
DB_USER=postgres
DB_PASSWORD=your_password

# Session Security (generate with: openssl rand -hex 32)
SESSION_SECRET=your_session_secret

# Token Encryption (generate with: openssl rand -hex 32)
TOKEN_ENCRYPTION_KEY=your_encryption_key

# Square OAuth (from developer.squareup.com)
SQUARE_APPLICATION_ID=your_app_id
SQUARE_APPLICATION_SECRET=your_app_secret
SQUARE_ENVIRONMENT=production  # or sandbox

# Base URL (for OAuth callbacks)
BASE_URL=https://yourdomain.com
```

### 4. Start Server

```bash
# Development
node server.js

# Production with PM2
pm2 start ecosystem.config.js
```

### 5. Create Admin User

```bash
node scripts/init-admin.js --email admin@example.com
```

### 6. Connect Square Account

1. Log in at `https://yourdomain.com/login.html`
2. Go to Merchants page
3. Click "Connect Square Account"
4. Authorize the OAuth connection
5. Initial sync runs automatically

## Webhooks

The system receives real-time updates from Square:

| Event | Action |
|-------|--------|
| `catalog.version.updated` | Sync catalog changes |
| `inventory.count.updated` | Sync inventory counts |
| `order.created/updated` | Update committed inventory |
| `order.fulfillment.updated` | Update sales velocity |
| `oauth.authorization.revoked` | Deactivate merchant |

Configure webhook URL in Square Developer Dashboard:
```
https://yourdomain.com/api/webhooks/square
```

## Scheduled Syncs

Use cron or PM2 to run smart sync hourly:

```bash
# Crontab
0 * * * * curl -X POST https://yourdomain.com/api/sync-smart

# Or configure in ecosystem.config.js for PM2
```

Smart sync respects intervals:
- Catalog: Every 3 hours
- Inventory: Every 3 hours
- Sales (91d): Every 3 hours
- Sales (182d): Daily
- Sales (365d): Weekly

## Security

### Authentication
- Session-based authentication with PostgreSQL session store
- Bcrypt password hashing with configurable rounds
- Rate limiting on login endpoints (5 attempts per 15 minutes)
- Password reset with secure tokens

### Multi-Tenant Isolation
- All database queries include `merchant_id` filtering
- Explicit validation of location/vendor ownership
- No cross-tenant data access possible

### Token Security
- Square OAuth tokens encrypted with AES-256-GCM
- Encryption key required in environment variables
- Tokens never logged or exposed in errors

### Admin Controls
- Super-admin access via `SUPER_ADMIN_EMAILS` env var
- Admin-only endpoints for user management, logs, settings

## Project Structure

```
SquareDashboardTool/
├── database/
│   ├── schema.sql              # Complete database schema
│   └── migrations/             # Migration files
├── middleware/
│   ├── auth.js                 # Authentication middleware
│   ├── merchant.js             # Multi-tenant middleware
│   ├── security.js             # Security headers, rate limiting
│   └── validators/             # Input validation (19 files)
├── routes/                     # 20 route files (233 endpoints)
│   ├── auth.js                 # Authentication routes
│   ├── square-oauth.js         # Square OAuth flow
│   ├── google-oauth.js         # Google OAuth flow
│   ├── loyalty.js              # Loyalty program (40 endpoints)
│   ├── delivery.js             # Delivery management
│   ├── gmc.js                  # Google Merchant Center
│   └── ...                     # Additional route files
├── services/
│   └── loyalty/                # Modular loyalty service layer
│       ├── purchase-service.js # Purchase tracking
│       ├── reward-service.js   # Reward state machine
│       └── ...                 # Additional services
├── utils/
│   ├── database.js             # Database connection pool
│   ├── square-api.js           # Square API integration
│   ├── loyalty-service.js      # Core loyalty logic
│   ├── token-encryption.js     # AES-256-GCM encryption
│   ├── expiry-discount.js      # Discount automation
│   └── logger.js               # Winston logging
├── public/                     # 23 HTML pages
├── scripts/
│   ├── init-admin.js           # Create admin user
│   └── get-locations.js        # Debug utility
├── output/
│   ├── logs/                   # Application logs
│   ├── feeds/                  # GMC feed files
│   └── temp/                   # Temporary files
├── server.js                   # Main Express server (5 endpoints remaining)
├── ecosystem.config.js         # PM2 configuration
└── .env.example                # Environment template
```

## Troubleshooting

### Database Connection Failed
```bash
# Check PostgreSQL is running
pg_isready

# Verify credentials in .env
psql -U postgres -h localhost -d square_dashboard_addon
```

### Square OAuth Errors
- Verify `SQUARE_APPLICATION_ID` and `SQUARE_APPLICATION_SECRET`
- Check redirect URI matches exactly in Square dashboard
- Ensure `BASE_URL` is correct (include https://)

### Webhook Failures
- Check webhook signature key in Square dashboard
- Verify endpoint is accessible from internet
- Check `/api/webhooks/events` for error logs (super-admin only)

### Token Encryption Errors
- Ensure `TOKEN_ENCRYPTION_KEY` is 64 hex characters
- Same key must be used across restarts
- Never change key after tokens are stored

## License

MIT License - See LICENSE file for details.

## Support

For issues or questions: https://sqtools.ca/support

---

**Version:** 2.0.0
**Last Updated:** January 2026
**Platform:** Cross-platform (Windows, Linux, macOS)
