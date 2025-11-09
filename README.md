# JTPets Inventory Management System

A comprehensive inventory management system for JTPets pet supply business with Square POS integration. This system provides automated reorder suggestions, sales velocity tracking, cost/margin analysis, and purchase order management.

## Features

- **Square POS Integration**: Sync locations, vendors, catalog, inventory, and sales data
- **Sales Velocity Tracking**: Calculate demand based on 91, 182, and 365-day sales history
- **Intelligent Reorder Suggestions**: Automated calculations considering:
  - Sales velocity and supply days
  - Case pack quantities and reorder multiples
  - Stock alert thresholds
  - Vendor lead times
- **Cost & Margin Analysis**: Track vendor costs and profit margins
- **Purchase Order Management**: Create, edit, submit, and track purchase orders
- **Multi-location Support**: Handle inventory across multiple store locations

## Prerequisites

- **Node.js**: Version 18.0.0 or higher
- **PostgreSQL**: Version 14.0 or higher
- **Square Account**: With API access token
- **Windows 10/11**: For development (will deploy to Raspberry Pi later)

## Installation

### 1. Clone the Repository

```bash
git clone <repository-url>
cd JTPetsClaudeBuildTool
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Database Setup

Create a PostgreSQL database:

```bash
# Using psql command line
psql -U postgres
CREATE DATABASE jtpets_beta;
\q
```

Run the schema to create all tables:

```bash
psql -U postgres -d jtpets_beta -f database/schema.sql
```

### 4. Environment Configuration

Copy the example environment file and configure:

```bash
copy .env.example .env
```

Edit `.env` with your actual values:

```env
SQUARE_ACCESS_TOKEN=your_actual_square_token
DB_PASSWORD=your_postgres_password
```

### 5. Get Your Square Access Token

1. Go to [Square Developer Dashboard](https://developer.squareup.com/apps)
2. Create or select your application
3. Navigate to "Credentials"
4. Copy your **Access Token** (use Production token for live data, Sandbox for testing)
5. Paste into `.env` file

### 6. Start the Server

```bash
npm start
```

For development with auto-restart on file changes:

```bash
npm run dev
```

The server will start on port 5001 (configurable in `.env`).

## Initial Data Sync

After starting the server, perform an initial full sync to import all data from Square:

```bash
curl -X POST http://localhost:5001/api/sync
```

This will:
1. Sync all store locations
2. Sync all vendors
3. Sync complete catalog (categories, images, items, variations)
4. Sync current inventory levels
5. Calculate sales velocity for 91, 182, and 365-day periods

**Note**: Initial sync can take 5-30 minutes depending on catalog size.

## Dashboard

Access the main dashboard at: http://localhost:5001/ or http://localhost:5001/index.html

The dashboard provides:
- **Real-time inventory statistics** - Live counts of items, variations, inventory records, and alerts
- **Quick access to all tools** - Visual cards linking to all system features
- **Smart sync status and controls** - View last sync times and trigger manual syncs
- **API documentation** - Expandable list of all available API endpoints
- **Responsive design** - Works on desktop, tablet, and mobile devices

### Available Pages

Access all pages from the dashboard at http://localhost:5001/

#### Implemented Pages ✅
- **Dashboard** (`/` or `/index.html`) - Central hub with real-time stats and navigation
- **Reorder Suggestions** (`/reorder.html`) - Priority-ranked reorder recommendations with:
  - Supply days filtering (30/45/60/90 days)
  - Priority filtering (Urgent/High/Medium/Low)
  - Location filtering
  - Sortable table with stock levels, alert thresholds, reorder reasons
  - Add to PO draft functionality
  - Export to CSV
  - Auto-refresh every 5 minutes
- **Expiration Tracker** (`/expiry.html`) - Manage product expiration dates with:
  - Expiry filtering (30/60/90/120 days, no expiry, never expires)
  - Category filtering
  - In-line date editing with confirmation
  - "Never expires" checkbox
  - Pagination (25/50/100 items per page)
  - Auto-save on confirmation
  - Sync from Square button

#### Coming Soon 🚧
- **Full Inventory** (`/inventory.html`) - Complete inventory view across locations
- **Purchase Orders** (`/purchase-orders.html`) - PO creation, submission, and receiving
- **Sales Velocity** (`/sales-velocity.html`) - 91/182/365-day sales trend reports
- **Deleted Items** (`/deleted-items.html`) - Soft-deleted items management and cleanup

#### Page Features
All implemented pages include:
- Responsive design (mobile, tablet, desktop)
- Real-time API integration
- Consistent UI/UX matching dashboard design
- Loading states and error handling
- Stats bars showing key metrics

### Dashboard Features:

**Statistics Bar:**
- Total items in catalog
- Total variations (SKUs)
- Total inventory records
- Active reorder alerts (color-coded: red when > 0)
- Total inventory value

**Sync Status:**
- Last sync time for catalog, inventory, and sales data
- Next sync due time
- Manual sync button for on-demand updates
- Auto-refresh every 5 minutes

**Tool Cards:**
- Color-coded by category (Critical, Inventory, Operations, API)
- Priority tags (CRITICAL, HIGH VALUE, NEW)
- Direct links to both HTML pages and raw API endpoints

## API Documentation

### Health & Status

#### `GET /api/health`
Check system health and database connection.

**Response:**
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "version": "1.0.0"
}
```

### Synchronization

#### `POST /api/sync`
**Force full synchronization from Square** (ignores sync intervals).

Use this for:
- Initial setup
- Manual syncs
- When you need to force-refresh all data

**Response:**
```json
{
  "status": "success",
  "summary": {
    "locations": 2,
    "vendors": 15,
    "items": 450,
    "variations": 850,
    "categories": 25,
    "images": 320,
    "variation_vendors": 780,
    "inventory_records": 1700,
    "sales_velocity_91d": 650,
    "sales_velocity_182d": 650,
    "sales_velocity_365d": 650
  },
  "errors": []
}
```

#### `POST /api/sync-smart` ⭐ **RECOMMENDED**
**Smart interval-based sync** - Only syncs data types whose configured interval has elapsed.

This is the **recommended endpoint for scheduled/cron jobs**. It intelligently decides what to sync based on configurable intervals, reducing API calls by ~90% while keeping data fresh.

**Configuration** (in `.env`):
```env
SYNC_CATALOG_INTERVAL_HOURS=3        # Sync catalog every 3 hours
SYNC_LOCATIONS_INTERVAL_HOURS=3      # Sync locations every 3 hours
SYNC_SALES_91D_INTERVAL_HOURS=3      # 91-day sales every 3 hours
SYNC_SALES_182D_INTERVAL_HOURS=24    # 182-day sales daily
SYNC_SALES_365D_INTERVAL_HOURS=168   # 365-day sales weekly
SYNC_INVENTORY_INTERVAL_HOURS=3      # Inventory every 3 hours
SYNC_VENDORS_INTERVAL_HOURS=24       # Vendors daily
```

**Sync Order:**
The smart sync follows a specific order to ensure data dependencies are met:
1. **Locations** (synced first - required for inventory and sales)
2. **Vendors**
3. **Catalog**
4. **Inventory** (requires locations)
5. **Sales Velocity** (requires locations)

**Important:** If there are no active locations in the database, the smart sync will **automatically force a location sync** regardless of interval. This ensures inventory and sales velocity syncs always have the required location data.

**Response:**
```json
{
  "status": "success",
  "synced": ["catalog", "inventory", "sales_91d"],
  "skipped": {
    "vendors": "Last synced 2.5h ago, next in 21.5h",
    "sales_182d": "Last synced 10h ago, next in 14h",
    "sales_365d": "Last synced 3 days ago, next in 4 days"
  },
  "summary": {
    "catalog": { "recordsSynced": 850, "durationSeconds": 45 },
    "inventory": { "recordsSynced": 1700, "durationSeconds": 20 },
    "sales_91d": { "recordsSynced": 650, "durationSeconds": 180 }
  }
}
```

**Benefits:**
- **90% fewer API calls** - Only syncs what's needed
- **Faster syncs** - Typically 2-5 minutes instead of 30-60 minutes
- **Configurable intervals** - Tune frequency per data type
- **Automatic tracking** - Logs all syncs to database
- **Safe for frequent runs** - Run every hour via cron, it decides what to sync

#### `GET /api/sync-status`
View the current sync schedule and when each sync type last ran.

**Response:**
```json
{
  "catalog": {
    "last_sync": "2025-11-09T00:30:00Z",
    "next_sync_due": "2025-11-09T03:30:00Z",
    "interval_hours": 3,
    "needs_sync": false,
    "hours_since_last_sync": "1.2",
    "last_status": "success",
    "last_records_synced": 850,
    "last_duration_seconds": 45
  },
  "sales_365d": {
    "last_sync": "2025-11-06T00:00:00Z",
    "next_sync_due": "2025-11-13T00:00:00Z",
    "interval_hours": 168,
    "needs_sync": false,
    "hours_since_last_sync": "72.0",
    "last_status": "success",
    "last_records_synced": 650,
    "last_duration_seconds": 240
  }
}
```

#### `GET /api/sync-history`
View recent sync history with status and duration.

**Query Parameters:**
- `limit` - Number of records to return (default: 20)

**Response:**
```json
{
  "count": 20,
  "history": [
    {
      "id": 42,
      "sync_type": "sales_91d",
      "started_at": "2025-11-09T01:00:00Z",
      "completed_at": "2025-11-09T01:03:15Z",
      "status": "success",
      "records_synced": 650,
      "duration_seconds": 195
    }
  ]
}
```

#### `POST /api/sync-sales`
Sync only sales velocity data for all periods (91, 182, 365 days).

**Note:** `POST /api/sync-smart` is now preferred as it syncs each period on its own schedule.

**Response:**
```json
{
  "status": "success",
  "periods": [91, 182, 365],
  "variations_updated": {
    "91d": 650,
    "182d": 650,
    "365d": 650
  }
}
```

### Catalog

#### `GET /api/items`
List all items with optional filtering.

**Query Parameters:**
- `name` - Filter by item name (partial match)
- `category` - Filter by category name (partial match)

**Example:**
```bash
curl "http://localhost:5001/api/items?name=dog%20food"
```

#### `GET /api/variations`
List all variations (SKUs).

**Query Parameters:**
- `item_id` - Filter by item ID
- `sku` - Filter by SKU (partial match)
- `has_cost` - Only variations with vendor costs (true/false)

**Example:**
```bash
curl "http://localhost:5001/api/variations?has_cost=true"
```

#### `GET /api/variations-with-costs`
Get variations with cost and margin calculations.

**Response includes:**
- SKU, item name, variation name
- Retail price and cost (in cents)
- Margin percentage
- Profit amount
- Vendor name and code

#### `PATCH /api/variations/:id/extended`
Update JTPets custom fields for a variation.

**Updateable Fields:**
- `case_pack_quantity` - Units per case
- `stock_alert_min` - Minimum stock threshold
- `stock_alert_max` - Maximum stock level
- `preferred_stock_level` - Target stock level
- `shelf_location` - Physical shelf location
- `bin_location` - Storage bin location
- `reorder_multiple` - Order quantity constraint
- `discontinued` - Discontinued flag
- `notes` - Custom notes

**Example:**
```bash
curl -X PATCH http://localhost:5001/api/variations/VARIATION_ID/extended \
  -H "Content-Type: application/json" \
  -d '{
    "case_pack_quantity": 12,
    "stock_alert_min": 24,
    "stock_alert_max": 96,
    "shelf_location": "A-12-3"
  }'
```

#### `POST /api/variations/bulk-update-extended`
Bulk update custom fields by SKU.

**Body:**
```json
[
  {
    "sku": "DOG-FOOD-001",
    "case_pack_quantity": 12,
    "stock_alert_min": 24,
    "shelf_location": "A-12-3"
  },
  {
    "sku": "CAT-LITTER-002",
    "case_pack_quantity": 6,
    "stock_alert_min": 12
  }
]
```

### Inventory

#### `GET /api/inventory`
Get current inventory levels.

**Query Parameters:**
- `location_id` - Filter by location
- `low_stock` - Only items below minimum (true/false)

#### `GET /api/low-stock`
Get all items currently below minimum stock threshold.

**Response includes:**
- Current stock vs minimum threshold
- Units below minimum
- Location information

### Vendors

#### `GET /api/vendors`
List all vendors.

**Query Parameters:**
- `status` - Filter by status (ACTIVE/INACTIVE)

### Sales Velocity

#### `GET /api/sales-velocity`
Get sales velocity data.

**Query Parameters:**
- `variation_id` - Filter by variation
- `location_id` - Filter by location
- `period_days` - Filter by period (91, 182, or 365)

**Response includes:**
- Total quantity sold in period
- Total revenue in period
- Daily, weekly, monthly averages

### Reorder Suggestions

#### `GET /api/reorder-suggestions`
Get intelligent reorder suggestions based on sales velocity.

**Query Parameters:**
- `vendor_id` - Filter by vendor (optional)
- `supply_days` - Target days of supply (default: 45)
- `location_id` - Filter by location (optional)
- `min_cost` - Minimum order cost filter (optional)

**Response includes:**
- Current stock level
- Daily/weekly average sales
- Days until stockout
- Suggested order quantity (with case pack adjustments)
- Order cost
- Priority flags (below minimum, urgent)

**Example:**
```bash
curl "http://localhost:5001/api/reorder-suggestions?vendor_id=VENDOR_123&supply_days=60"
```

**Business Logic:**
1. Uses 91-day sales velocity for calculations
2. Calculates: `base_qty = daily_avg * supply_days`
3. Adjusts for current stock: `needed = base_qty - current_stock`
4. Rounds up to case pack multiples
5. Applies reorder multiple constraints
6. Respects min/max stock thresholds
7. Prioritizes items by urgency level

**Priority System:**

The system assigns priority levels to each reorder suggestion based on stock levels and Square's inventory alert thresholds:

- **URGENT** - Stock ≤ 0 days (out of stock with active sales)
- **HIGH** - Below Square alert threshold OR < 7 days of stock
- **MEDIUM** - < 14 days of stock remaining
- **LOW** - < 30 days of stock remaining

Priority thresholds are configurable via environment variables:
```env
REORDER_PRIORITY_URGENT_DAYS=0
REORDER_PRIORITY_HIGH_DAYS=7
REORDER_PRIORITY_MEDIUM_DAYS=14
REORDER_PRIORITY_LOW_DAYS=30
```

**Square Location-Specific Alert Thresholds:**

Square allows you to set location-specific low stock alerts for each product variation. These alerts are synced to the `variation_location_settings` table and take precedence in reorder calculations:

- Any item below its Square alert threshold automatically gets **HIGH** priority
- Suggested quantity is calculated to bring stock above the threshold
- Alert thresholds are **location-specific** - different locations can have different thresholds
- This ensures Square's business rules are respected per location

To set location-specific alert thresholds in Square:
1. Go to Items & Orders → Item Library
2. Edit a variation
3. Click on a specific location
4. Set "Low stock alert" for that location under inventory settings
5. The system will sync this to `variation_location_settings.stock_alert_min`

**How Syncing Works:**
- During catalog sync, location overrides are extracted from Square API
- Each location's alert threshold is stored in `variation_location_settings`
- Reorder suggestions query JOINs with this table to get location-specific alerts
- Multiple locations may have different alerts for the same product

**Response Fields:**
- `priority` - Priority level (URGENT, HIGH, MEDIUM, LOW)
- `reorder_reason` - Human-readable explanation including location name if applicable
- `location_id` - ID of the location where stock needs reordering
- `location_name` - Name of the location (e.g., "Main Store", "Warehouse")
- `location_stock_alert_min` - Location-specific low stock alert threshold (if set)
- All other fields remain the same

**Example Response:**
```json
{
  "priority": "HIGH",
  "reorder_reason": "Below stock alert threshold (24 units) at Main Store",
  "location_id": "LOC123",
  "location_name": "Main Store",
  "location_stock_alert_min": 24,
  "current_stock": 18,
  "final_suggested_qty": 30
}
```

### Purchase Orders

#### `POST /api/purchase-orders`
Create a new purchase order.

**Body:**
```json
{
  "vendor_id": "VENDOR_123",
  "location_id": "LOCATION_456",
  "supply_days_override": 60,
  "notes": "Regular monthly order",
  "created_by": "manager@jtpets.com",
  "items": [
    {
      "variation_id": "VAR_001",
      "quantity_ordered": 24,
      "unit_cost_cents": 1299
    },
    {
      "variation_id": "VAR_002",
      "quantity_ordered": 12,
      "unit_cost_cents": 2499
    }
  ]
}
```

**Response:**
- Auto-generated PO number (format: PO-YYYYMMDD-XXX)
- Status: DRAFT
- Calculated totals

#### `GET /api/purchase-orders`
List purchase orders.

**Query Parameters:**
- `status` - Filter by status (DRAFT, SUBMITTED, PARTIAL, RECEIVED)
- `vendor_id` - Filter by vendor

#### `GET /api/purchase-orders/:id`
Get single purchase order with all line items.

#### `PATCH /api/purchase-orders/:id`
Update a draft purchase order (only DRAFT status can be edited).

**Body:**
```json
{
  "supply_days_override": 45,
  "notes": "Updated order notes",
  "items": [
    {
      "variation_id": "VAR_001",
      "quantity_ordered": 36,
      "unit_cost_cents": 1299
    }
  ]
}
```

#### `POST /api/purchase-orders/:id/submit`
Submit a purchase order (change from DRAFT to SUBMITTED).

**Effects:**
- Locks PO from editing
- Sets order date to current date
- Calculates expected delivery date (order date + vendor lead time)

#### `POST /api/purchase-orders/:id/receive`
Record received quantities for PO items.

**Body:**
```json
{
  "items": [
    {
      "id": 123,
      "received_quantity": 24
    },
    {
      "id": 124,
      "received_quantity": 12
    }
  ]
}
```

**Effects:**
- Updates received quantities
- Changes status to PARTIAL if some items received
- Changes status to RECEIVED if all items fully received
- Sets actual delivery date

## Sync Workflow Recommendations

### Initial Setup
1. **One-time full sync**: `POST /api/sync`
   ```bash
   curl -X POST http://localhost:5001/api/sync
   ```
2. Configure custom fields for key products (case packs, min/max stock)
3. Set up automated sync (see below)

### Automated Sync Strategy (RECOMMENDED) ⭐

Set up a **cron job or scheduled task** to run `/api/sync-smart` every hour:

**Linux/Mac (crontab):**
```bash
0 * * * * curl -X POST http://localhost:5001/api/sync-smart
```

**Windows (Task Scheduler):**
- Create new task
- Trigger: Hourly
- Action: `curl -X POST http://localhost:5001/api/sync-smart`

**What happens:**
- Runs every hour
- Smart sync checks intervals and only syncs what's needed
- Typical execution:
  - **Hours 1-2**: Skips everything (too soon)
  - **Hour 3**: Syncs catalog, inventory, sales_91d (~3-5 min)
  - **Hour 24**: Also syncs vendors, sales_182d (~5-7 min)
  - **Hour 168**: Also syncs sales_365d (~10-15 min)

**Benefits:**
- Set it and forget it
- Automatic data freshness
- 90% reduction in API calls vs old method
- No manual intervention needed

### Daily Operations

#### Morning Routine
Check sync status and low stock:
```bash
# Check what was synced overnight
curl http://localhost:5001/api/sync-status

# Review items needing reorder
curl http://localhost:5001/api/low-stock
```

#### Generate Reorder Suggestions
For each vendor:
```bash
curl "http://localhost:5001/api/reorder-suggestions?vendor_id=VENDOR_ID&supply_days=45"
```

### Manual Sync (When Needed)

**Force immediate sync of everything:**
```bash
curl -X POST http://localhost:5001/api/sync
```

Use when:
- Adding new products in Square
- Major catalog changes
- Troubleshooting data issues

### Monitoring Sync Health

**View sync history:**
```bash
curl http://localhost:5001/api/sync-history?limit=10
```

**Check sync schedule:**
```bash
curl http://localhost:5001/api/sync-status
```

## Example Workflow: Creating a Purchase Order

### 1. Get Reorder Suggestions
```bash
curl "http://localhost:5001/api/reorder-suggestions?vendor_id=V123&supply_days=45"
```

### 2. Create Draft PO from Suggestions
```bash
curl -X POST http://localhost:5001/api/purchase-orders \
  -H "Content-Type: application/json" \
  -d '{
    "vendor_id": "V123",
    "location_id": "L456",
    "supply_days_override": 45,
    "created_by": "manager",
    "items": [
      {"variation_id": "VAR001", "quantity_ordered": 24, "unit_cost_cents": 1299},
      {"variation_id": "VAR002", "quantity_ordered": 36, "unit_cost_cents": 899}
    ]
  }'
```

### 3. Review PO
```bash
curl http://localhost:5001/api/purchase-orders/1
```

### 4. Submit PO
```bash
curl -X POST http://localhost:5001/api/purchase-orders/1/submit
```

### 5. Record Receipt
```bash
curl -X POST http://localhost:5001/api/purchase-orders/1/receive \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"id": 1, "received_quantity": 24},
      {"id": 2, "received_quantity": 36}
    ]
  }'
```

## Troubleshooting

### Database Connection Failed

**Error:** `Database connection failed: password authentication failed`

**Solution:**
1. Check `.env` file has correct `DB_PASSWORD`
2. Verify PostgreSQL is running: `pg_isready`
3. Check PostgreSQL is accepting connections on port 5432

### Square API Authentication Failed

**Error:** `Square API authentication failed. Check your access token.`

**Solution:**
1. Verify `SQUARE_ACCESS_TOKEN` in `.env`
2. Check token hasn't expired
3. Verify token has correct permissions (read catalog, inventory, orders)
4. Ensure using correct token (Production vs Sandbox)

### Port Already in Use

**Error:** `EADDRINUSE: address already in use :::5001`

**Solution:**
1. Change `PORT` in `.env` to different value (e.g., 5002)
2. Or stop other service using port 5001

### Slow Sync Performance

**Issue:** Full sync takes very long time

**Solutions:**
1. **Switch to smart sync**: Use `POST /api/sync-smart` instead of `POST /api/sync`
2. Smart sync typically takes 2-5 minutes vs 30-60 minutes for full sync
3. Only use full sync for initial setup or when forcing a complete refresh
4. Check internet connection speed
5. Consider increasing `max` pool size in `utils/database.js`

### Smart Sync Not Working

**Issue:** `POST /api/sync-smart` returns "skipped" for everything

**Cause:** Intervals haven't elapsed yet since last sync

**Solutions:**
1. Check sync status: `GET /api/sync-status`
2. Review interval configuration in `.env`
3. Wait for intervals to elapse, or
4. Use `POST /api/sync` to force immediate sync

### Missing Sales Velocity Data

**Issue:** `GET /api/sales-velocity` returns no data

**Solutions:**
1. Ensure `POST /api/sync-sales` has been run
2. Verify you have COMPLETED orders in Square
3. Check date range - you need sales within the period (91/182/365 days)

### Reorder Suggestions Empty

**Issue:** `GET /api/reorder-suggestions` returns no suggestions

**Checklist:**
1. Sales velocity data exists (`GET /api/sales-velocity`)
2. Products have `stock_alert_min` set
3. Products are not discontinued
4. Products have vendor information with costs
5. Current stock is below threshold or approaching stockout

## Project Structure

```
JTPetsClaudeBuildTool/
├── database/
│   └── schema.sql          # Complete database schema
├── utils/
│   ├── database.js         # Database connection pool
│   └── square-api.js       # Square API integration
├── public/
│   └── index.html          # Main dashboard (HTML/CSS/JS)
├── server.js               # Main Express server
├── package.json            # Dependencies
├── .env.example            # Environment template
├── .gitignore              # Git ignore rules
└── README.md               # This file
```

## Technology Stack

- **Backend**: Node.js with Express
- **Database**: PostgreSQL 14+
- **Square Integration**: Square API v2024-10-17
- **Dependencies**:
  - `express` - Web framework
  - `pg` - PostgreSQL client
  - `node-fetch` - HTTP requests to Square API
  - `dotenv` - Environment configuration
  - `cors` - CORS middleware

## Business Rules

### Reorder Calculation
- **Supply Days**: Target days of inventory to maintain (default: 45)
- **Safety Days**: Buffer before stockout triggers reorder (default: 7)
- **Case Packs**: Orders rounded up to full cases
- **Reorder Multiples**: Enforces order quantity constraints
- **Lead Time**: Vendor delivery time added to urgency calculations

### Sales Velocity Periods
- **91 days**: Primary calculation for reorders (3 months)
- **182 days**: Trend analysis (6 months)
- **365 days**: Seasonal patterns (1 year)

### Stock Thresholds
- **stock_alert_min**: Triggers low stock warnings
- **stock_alert_max**: Prevents overstocking
- **preferred_stock_level**: Target inventory level

## Future Enhancements

- [ ] Automated expiration date tracking and discounting
- [ ] Email notifications for low stock alerts
- [ ] Purchase order export to PDF
- [ ] Barcode scanning integration
- [ ] Mobile app for inventory counts
- [ ] Multi-currency support for international vendors
- [ ] Advanced analytics dashboard
- [ ] Integration with accounting software

## License

Proprietary - JTPets Internal Use Only

## Support

For issues or questions, contact: support@jtpets.com

---

**Version**: 1.0.0
**Last Updated**: 2024
**Platform**: Windows (Development) / Raspberry Pi (Production)
