# SqTools Feature Reference

Complete feature inventory and technical specifications for the SqTools platform.

---

## Feature Modules

### 1. Core Inventory Management

| Feature | Status | Description |
|---------|--------|-------------|
| Square catalog sync | ✅ | Items, variations, categories, images |
| Multi-location inventory | ✅ | Per-location stock levels and alerts |
| Low stock alerts | ✅ | Configurable thresholds per location |
| Soft-delete tracking | ✅ | Monitor removed items, auto-zero inventory |
| Catalog audit | ✅ | Find missing GTINs, images, costs, expiry |

### 2. Sales Velocity & Analytics

| Feature | Status | Description |
|---------|--------|-------------|
| Sales velocity | ✅ | 91, 182, and 365-day period calculations |
| Reorder suggestions | ✅ | Priority-ranked with case pack rounding |
| Supply days | ✅ | Days of stock remaining per variation |
| Demand forecasting | ✅ | Lead time-aware reorder points |

### 3. Purchase Order Management

| Feature | Status | Description |
|---------|--------|-------------|
| PO lifecycle | ✅ | Draft → Submit → Partial Receive → Complete |
| Vendor management | ✅ | Lead times, minimums, payment terms |
| PO export | ✅ | CSV and XLSX formats |
| Vendor catalog import | ✅ | CSV/XLSX price lists with UPC matching |
| Margin calculation | ✅ | Cost vs. selling price analysis |

### 4. Cycle Counting

| Feature | Status | Description |
|---------|--------|-------------|
| Daily batch generation | ✅ | Prioritized by value and movement |
| Count queue | ✅ | Mobile-friendly counting interface |
| Accuracy tracking | ✅ | Variance reporting and history |
| Square sync | ✅ | Push counts to Square inventory |
| Email reports | ✅ | Daily count summaries |

### 5. Expiration Management

| Feature | Status | Description |
|---------|--------|-------------|
| Expiry tracking | ✅ | Per-variation dates in Square custom attributes |
| Automated discounts | ✅ | REVIEW → AUTO25 → AUTO50 → EXPIRED tiers |
| Square discount integration | ✅ | Auto-create and apply discounts |
| Expiry audit | ✅ | Bulk set dates for items missing expiry |
| Review workflow | ✅ | Track reviewed items with timestamps |

### 6. Google Merchant Center

| Feature | Status | Description |
|---------|--------|-------------|
| OAuth integration | ✅ | Secure Google account connection |
| TSV feed generation | ✅ | Automated product feed creation |
| Brand management | ✅ | Map products to brands |
| Taxonomy mapping | ✅ | Google product category assignment |
| Sheets sync | ✅ | Direct publish to Google Sheets |

### 7. Loyalty Rewards Program

| Feature | Status | Description |
|---------|--------|-------------|
| Frequent buyer offers | ✅ | Buy X get 1 free programs |
| Size group targeting | ✅ | Multiple offers per brand by size |
| Progress tracking | ✅ | Real-time customer qualification |
| Rolling windows | ✅ | "Buy 10 in 90 days" style programs |
| Auto-redemption | ✅ | Square discounts created on qualification |
| Webhook tracking | ✅ | Real-time purchase processing |
| Order backfill | ✅ | Import historical orders for existing offers |

### 8. Delivery Management

| Feature | Status | Description |
|---------|--------|-------------|
| Order ingestion | ✅ | Automatic from Square webhooks |
| Scheduling calendar | ✅ | Visual delivery time management |
| Route suggestions | ✅ | Geographic route optimization |
| Driver app | ✅ | Mobile interface with proof of delivery |
| Customer notes | ✅ | Sync delivery instructions from Square |
| Status tracking | ✅ | Real-time fulfillment updates |

### 9. Square Custom Attributes

| Attribute | Type | Purpose |
|-----------|------|---------|
| `case_pack_quantity` | NUMBER | Units per case for reorder rounding |
| `brand` | STRING | Brand assignment for loyalty/GMC |
| `expiration_date` | STRING | Product expiry date tracking |
| `does_not_expire` | BOOLEAN | Flag for non-perishable items |
| `expiry_reviewed_at` | STRING | Last review timestamp |

### 10. Subscription System (SaaS)

| Feature | Status | Description |
|---------|--------|-------------|
| Square Payments | ✅ | Native payment processing |
| Trial periods | ✅ | 30-day free trial |
| Promo codes | ✅ | Discount code support |
| Webhook handling | ✅ | Payment success/failure automation |
| Access gating | ✅ | Middleware subscription validation |

---

## Webhook Events

### Core Events

| Event | Handler |
|-------|---------|
| `order.created` | Delivery ingestion, loyalty tracking |
| `order.updated` | Order changes, delivery updates |
| `order.fulfillment.updated` | Delivery status, sales velocity |
| `catalog.version.updated` | Catalog sync |
| `inventory.count.updated` | Real-time inventory |
| `oauth.authorization.revoked` | Security - app disconnection |

### Loyalty Events

| Event | Handler |
|-------|---------|
| `loyalty.event.created` | Late-linked orders via loyalty card |
| `payment.created` | Payment tracking |
| `payment.updated` | Payment completion triggers |
| `refund.created` | Refund processing |
| `refund.updated` | Refund status changes |

### Vendor & Location Events

| Event | Handler |
|-------|---------|
| `vendor.created` | New vendor sync |
| `vendor.updated` | Vendor changes |
| `location.created` | New location sync |
| `location.updated` | Location changes |

### Subscription Events

| Event | Handler |
|-------|---------|
| `subscription.created` | Create subscriber record |
| `subscription.updated` | Update status |
| `invoice.payment_made` | Activate subscription |
| `invoice.payment_failed` | Mark past_due |
| `customer.deleted` | Cancel subscriptions |

---

## API Endpoints Summary

| Module | Endpoints | Key Operations |
|--------|-----------|----------------|
| Authentication | 12 | Login, logout, password reset, user CRUD |
| Square OAuth | 4 | Connect, callback, revoke, status |
| Google OAuth | 4 | Connect, callback, disconnect, status |
| Merchants | 4 | List, switch, create, settings |
| Sync | 6 | Full sync, smart sync, catalog, inventory, sales |
| Catalog | 16 | Items, variations, inventory, search |
| Analytics | 5 | Velocity, reorder, supply days |
| Purchase Orders | 9 | CRUD, submit, receive, export |
| Subscriptions | 11 | Plans, checkout, status, cancel, refund |
| Loyalty | 40 | Offers, progress, redemptions, backfill |
| Delivery | 23 | Orders, schedule, routes, driver, POD |
| GMC | 32 | Feed, brands, taxonomy, sheets, settings |
| Webhooks | 8 | Subscriptions, register, test |
| Expiry Discounts | 13 | Tiers, rules, apply, audit |
| Vendor Catalog | 13 | Import, search, match, pricing |
| Cycle Count | 9 | Queue, sessions, submit, history |
| Square Attributes | 9 | CRUD, sync, initialize |
| Settings | 3 | Get, update, reset |
| Logs | 4 | View, filter, export |
| Driver API | 8 | Public endpoints for driver app |

**Total: 238 endpoints**

---

## Frontend Pages

| Page | Purpose |
|------|---------|
| `index.html` | Landing page |
| `login.html` | Authentication |
| `dashboard.html` | Main navigation hub |
| `inventory.html` | Full inventory view |
| `reorder.html` | Reorder suggestions |
| `purchase-orders.html` | PO management |
| `sales-velocity.html` | Sales analytics |
| `cycle-count.html` | Daily counting |
| `cycle-count-history.html` | Count history |
| `expiry.html` | Expiration tracking |
| `expiry-audit.html` | Bulk expiry entry |
| `expiry-discounts.html` | Discount tiers |
| `gmc-feed.html` | Google Merchant |
| `vendor-catalog.html` | Vendor imports |
| `catalog-audit.html` | Data quality |
| `deleted-items.html` | Soft-deleted items |
| `loyalty.html` | Loyalty program |
| `delivery.html` | Delivery orders |
| `delivery-route.html` | Route planning |
| `delivery-history.html` | Delivery history |
| `driver.html` | Driver mobile app |
| `merchants.html` | Square connections |
| `settings.html` | Configuration |
| `logs.html` | System logs |
| `subscribe.html` | Subscription signup |
| `subscription-expired.html` | Renewal prompt |
| `set-password.html` | Password reset |
| `support.html` | Help/FAQ |
| `admin-subscriptions.html` | Admin panel |

**Total: 30 pages**

---

## Technical Specifications

### Database Schema

- **35+ tables** with proper normalization
- **40+ indexes** for query performance
- Foreign key constraints for referential integrity
- Audit columns (created_at, updated_at) on all tables

### Key Tables

| Table | Purpose |
|-------|---------|
| `users` | Authentication and user management |
| `merchants` | Multi-tenant accounts, OAuth tokens |
| `locations` | Square locations per merchant |
| `items` | Catalog items |
| `variations` | Item variations (SKUs) |
| `inventory_counts` | Per-location stock levels |
| `sales_velocity` | Calculated demand data |
| `purchase_orders` | PO headers |
| `purchase_order_items` | PO line items |
| `vendors` | Vendor master data |
| `variation_expiration` | Expiry dates |
| `loyalty_offers` | Frequent buyer programs |
| `loyalty_progress` | Customer qualification |
| `delivery_orders` | Delivery management |
| `count_sessions` | Cycle count tracking |

---

*Last Updated: January 2026*
