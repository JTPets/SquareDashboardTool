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
Perform full synchronization from Square (locations, vendors, catalog, inventory, sales).

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

#### `POST /api/sync-sales`
Sync only sales velocity data (faster, recommended to run every 3 hours).

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
7. Prioritizes items below minimum or approaching stockout

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
1. Run full sync: `POST /api/sync`
2. Configure custom fields for key products (case packs, min/max stock)

### Daily Operations
- **Morning**: Run sales sync to get latest velocity data
  ```bash
  curl -X POST http://localhost:5001/api/sync-sales
  ```

- **Check low stock**: Review items needing reorder
  ```bash
  curl http://localhost:5001/api/low-stock
  ```

- **Generate reorder suggestions**: For each vendor
  ```bash
  curl "http://localhost:5001/api/reorder-suggestions?vendor_id=VENDOR_ID&supply_days=45"
  ```

### Weekly Operations
- Full catalog sync to catch new products: `POST /api/sync`
- Review and submit pending purchase orders

### Every 3 Hours (Automated)
- Sales velocity sync: `POST /api/sync-sales`
- Can set up a scheduled task or cron job

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
1. Run sync during off-hours
2. Use `POST /api/sync-sales` for frequent updates (faster)
3. Check internet connection speed
4. Consider increasing `max` pool size in `utils/database.js`

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
