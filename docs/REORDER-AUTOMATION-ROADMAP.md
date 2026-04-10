# Reorder Automation Roadmap

Foundation for vendor automation pipeline. Each tier builds on the previous with no rework.

---

## Section 1: Three-Tier Automation Vision

```
Tier 1 (Beta / Free)      → Smart Checkbox Defaults
Tier 2 (Premium / $14.99) → Auto-PO Generation from Approved Suggestions
Tier 3 (Enterprise)       → Automated Vendor Submission (email, API, FTP, EDI)
```

Each tier extends the same service directory:

```
services/reorder/
├── checkbox-defaults-service.js    ← Tier 1 (THIS TASK)
├── auto-po-generator-service.js    ← Tier 2 (future)
└── vendor-submission-service.js    ← Tier 3 (future)
```

The reorder suggestions response already contains all velocity, expiry, and vendor
priority data. Tier 1 is a pure computation layer on top of what `getReorderSuggestions()`
already returns — except for one missing field (see §2 below).

---

## Section 2: Tier 1 — Smart Checkbox Defaults

### 2.1 Data Availability Audit

All fields needed for checkbox logic come from `getReorderSuggestions()` in
`services/catalog/reorder-service.js`. Status of each required field:

| Field | Source | In Response? | Notes |
|-------|--------|:---:|-------|
| `final_suggested_qty` | `reorder-math.js` | ✓ | Case-pack and PO adjusted |
| `daily_avg_quantity` | `sales_velocity` (91d window) | ✓ | Primary velocity field |
| `weekly_avg_quantity` | `sales_velocity` (91d window) | ✓ | = daily × 7 |
| `current_stock` | `inventory_counts` | ✓ | On-hand quantity |
| `days_until_expiry` | `variation_expiration` (SQL CASE) | ✓ | NULL if no expiry date |
| `does_not_expire` | `variation_expiration` | ✓ | Skips expiry risk check |
| `is_primary_vendor` | LATERAL join on `variation_vendors` | ✓ | False = cheaper elsewhere |
| `active_discount_tier` | `variation_discount_status` | **✗ MISSING** | Needs JOIN added |

**One field requires a SQL change:** `active_discount_tier`.

`variation_discount_status.current_tier_id` exists in the database but is not JOINed
into the reorder query. The fix is a single LEFT JOIN added to `reorder-service.js`:

```sql
-- Add to FROM clause of reorder-service.js main query
LEFT JOIN variation_discount_status vds
    ON vds.variation_id = v.id AND vds.merchant_id = $2

-- Add to SELECT
vds.current_tier_id AS active_discount_tier
```

Then expose it in `processSuggestionRows()`:

```javascript
active_discount_tier: row.active_discount_tier || null,
```

### 2.2 Velocity-Based Expiry Risk Formula

The formula uses fields already in the response:

```
totalStockAfterOrder = current_stock + final_suggested_qty
daysToClear          = totalStockAfterOrder / daily_avg_quantity
expiryRisk           = daysToClear > days_until_expiry
```

**Safe example** → CHECKED:
- `current_stock=22, final_suggested_qty=23, daily_avg=1.0`
- `totalStock=45, daysToClear=45`
- `days_until_expiry=120` → 45 < 120 → safe

**Risky example** → UNCHECKED:
- `current_stock=60, final_suggested_qty=30, daily_avg=1.0`
- `totalStock=90, daysToClear=90`
- `days_until_expiry=100` → 90 < 100 but margin is only 10 days → might not clear

Edge cases:
- `daily_avg_quantity === 0` (new item, no velocity) → treat as safe, return CHECKED
- `does_not_expire === true` → skip expiry check, proceed to default CHECKED
- `days_until_expiry === null` → no expiry data, skip check

### 2.3 Rule Priority Order

Rules are evaluated in this exact order (first match wins):

```
1. active_discount_tier IS NOT NULL  → UNCHECKED  (clearing markdown stock)
2. is_primary_vendor === false       → UNCHECKED  (cheaper at another vendor)
3. expiryRisk === true               → UNCHECKED  (won't sell before expiry)
4. (default)                         → CHECKED
```

### 2.4 Service Architecture

**File:** `services/reorder/checkbox-defaults-service.js`

```javascript
'use strict';

/**
 * Calculate smart checkbox defaults for reorder suggestions.
 * Pure computation — no DB calls.
 *
 * @param {object[]} items - From getReorderSuggestions().suggestions
 * @param {object} [merchantConfig] - Future: per-merchant rule thresholds
 * @returns {object[]} items with default_checked and default_reason added
 */
function calculateCheckboxDefaults(items, merchantConfig = {}) {
    return items.map(item => {
        const { checked, reason } = evaluateRules(item, merchantConfig);
        return { ...item, default_checked: checked, default_reason: reason };
    });
}

function evaluateRules(item, config) {
    if (item.active_discount_tier != null) {
        return { checked: false, reason: 'expiry_discount_active' };
    }
    if (!item.is_primary_vendor) {
        return { checked: false, reason: 'cheaper_vendor_available' };
    }
    if (hasExpiryRisk(item, config)) {
        return { checked: false, reason: 'expiry_risk' };
    }
    return { checked: true, reason: 'default' };
}

function hasExpiryRisk(item, config) {
    if (item.does_not_expire || item.days_until_expiry == null) return false;
    if (!item.daily_avg_quantity || item.daily_avg_quantity <= 0) return false;

    const totalStock = (item.current_stock || 0) + (item.final_suggested_qty || 0);
    const daysToClear = totalStock / item.daily_avg_quantity;
    const buffer = config.expiryRiskBufferDays ?? 0;

    return daysToClear > (item.days_until_expiry - buffer);
}

module.exports = { calculateCheckboxDefaults };
```

**Integration point:** call from `getReorderSuggestions()` before returning, or from
the route handler after receiving suggestions. Route-level is cleaner for Tier 1
because it avoids touching the core service until Tier 2 requires it.

### 2.5 Handling New Items (No Velocity History)

`daily_avg_quantity` will be `0` for new items. The current query only includes items
that appear in `sales_velocity` OR are below `stock_alert_min`. For a new item with
zero velocity:

- Expiry risk check is skipped (`daily_avg_quantity <= 0` guard)
- The item defaults to CHECKED (merchant wants to stock it)
- This is correct — the merchant explicitly added it to the vendor's catalog

---

## Section 3: Tier 2 — Auto-PO Generation (Design Only)

### 3.1 Approval Workflow

```
Merchant opens Reorder page
  → sees suggestions with smart defaults pre-applied
  → reviews, adjusts checkboxes/quantities
  → clicks "Generate Purchase Orders"

System groups checked items by vendor
  → creates one DRAFT PO per vendor per location
  → merchant sees PO review screen ("2 POs ready: Acme $340, PetCorp $180")
  → merchant approves each PO (or edits quantities)

System advances status: DRAFT → SUBMITTED
  → (Tier 3: triggers vendor-submission-service)
```

### 3.2 Batch PO Creation

**File:** `services/reorder/auto-po-generator-service.js` (future)

```javascript
async function generatePOsFromSuggestions(checkedItems, merchantId, locationId) {
    // Group by vendor
    const byVendor = groupBy(checkedItems, 'vendor_name');

    // For each vendor group, create a DRAFT PO
    for (const [vendorId, items] of Object.entries(byVendor)) {
        const poNumber = await generatePoNumber(merchantId);
        await createPurchaseOrder({ merchantId, vendorId, locationId, poNumber, items });
    }
}
```

Reuses existing `purchase_orders` + `purchase_order_items` schema — no migration needed.

### 3.3 Data Requirements Already Met

The existing PO tables already support everything needed:
- `purchase_orders.status = 'DRAFT'` for staging
- `purchase_order_items.quantity_ordered` for suggested qty
- `purchase_order_items.unit_cost_cents` from `variation_vendors.unit_cost_money`
- Pending PO deduction already in `final_suggested_qty` (prevents double-ordering)

---

## Section 4: Tier 3 — Vendor Submission (Research)

### 4.1 Email Automation (CSV/XLSX)

**Already exists:** `services/purchase-orders/po-export-service.js`
- `buildCsvContent(poData)` — 12-column Square-compatible CSV with UTF-8 BOM
- `buildXlsxWorkbook(poData)` — XLSX with metadata header rows

CSV columns: Item Name, Variation Name, SKU, GTIN, Vendor Code, Notes, Qty, Unit
Price, Fee, Price w/ Fee, Amount, Status.

XLSX columns: Item Name, Variation Name, SKU, GTIN, Vendor Code, Notes, Qty, Unit Cost.

**Email delivery:** `vendors.contact_email` already stored. Integration options:
- Resend (`resend` npm package) — recommended, already used in project for other emails
- Attach generated CSV or XLSX buffer directly

**`vendor-submission-service.js` stub (Tier 3):**
```javascript
async function submitViaEmail(po, vendor, format = 'csv') {
    const buffer = format === 'xlsx'
        ? await buildXlsxWorkbook(po)
        : buildCsvContent(po);
    // send via Resend with attachment
}
```

### 4.2 API Integrations (Vendor-Specific)

No standard REST API exists across pet industry vendors. Each requires custom
integration. Pattern to follow:

```javascript
async function submitViaAPI(po, vendor) {
    const handler = API_HANDLERS[vendor.api_type]; // e.g. ' pets_global', 'purina'
    if (!handler) throw new Error(`No API handler for ${vendor.api_type}`);
    return handler.submit(po, vendor.api_credentials);
}
```

Vendor API credentials would need a new `vendor_integrations` table (Tier 3 migration).

**Common pet industry EDI/portal vendors:**
- Pets Global / Zignature — web portal submission
- Fromm / Merrick — distributor portals (no public API)
- Chewy / Amazon — EDI 850 for wholesale

### 4.3 FTP Upload

Node.js: `ssh2-sftp-client` (SFTP) or `basic-ftp` (FTP). Pattern:

```javascript
async function submitViaFTP(po, vendor) {
    const sftp = new SftpClient();
    await sftp.connect(vendor.ftp_credentials);
    await sftp.put(csvBuffer, `/orders/${po.po_number}.csv`);
    await sftp.end();
}
```

FTP credentials would also go in `vendor_integrations` table.

### 4.4 EDI Standards (850 Purchase Orders)

EDI 850 (Purchase Order) is the B2B standard used by large distributors. Structure:

```
ISA  ← Interchange header (sender/receiver IDs, date/time)
GS   ← Functional group header
ST   ← Transaction set header (850)
BEG  ← Beginning segment (PO number, date, type)
PO1  ← Line items (qty, unit price, product ID)
CTT  ← Transaction totals
SE   ← Transaction set trailer
GE   ← Functional group trailer
IEA  ← Interchange trailer
```

npm packages: `node-edi-parser` or `edifact`. Requires vendor-specific trading partner
agreements (ISA IDs). High complexity — defer until there is a concrete vendor partner.

---

## Section 5: Feature Gating Strategy

### 5.1 Current Feature Registry

`config/feature-registry.js` already defines the `reorder` module at `$14.99/month`.
The expiry module is a separate `$9.99/month` feature. Feature checks use
`requireFeature('reorder')` middleware on routes.

### 5.2 Proposed Tier Gates

| Tier | Feature Key | Price | Controls |
|------|-------------|-------|----------|
| 1 | `reorder` (existing) | $14.99 | Smart defaults exposed in API response |
| 2 | `auto_po_generation` (new) | $24.99 | Batch PO creation endpoint |
| 3 | `vendor_automation` (new) | $49.99 | Vendor submission endpoints |

Tier 1 is free within the existing `reorder` module — no new feature key needed.
Add keys to `feature-registry.js` when Tier 2 work begins.

### 5.3 Merchant Config Extensibility

Future `merchant_reorder_config` table for per-merchant rule thresholds:

```sql
CREATE TABLE merchant_reorder_config (
    merchant_id       INTEGER PRIMARY KEY REFERENCES merchants(id),
    expiry_buffer_days INTEGER DEFAULT 0,
    -- Future: aggressive ordering threshold, custom rule weights
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);
```

`calculateCheckboxDefaults(items, merchantConfig)` already accepts a `merchantConfig`
object. When this table is created, load it and pass it in. No refactor needed.

---

## Section 6: Tier 1 Implementation Plan

### Step 1 — Add `active_discount_tier` to Reorder Response

**File:** `services/catalog/reorder-service.js`

Add to the main SQL SELECT (after `EXTRACT(DAY...) as variation_age_days`):

```sql
vds.current_tier_id AS active_discount_tier
```

Add to FROM clause (after existing `variation_expiration` LEFT JOIN):

```sql
LEFT JOIN variation_discount_status vds
    ON vds.variation_id = v.id AND vds.merchant_id = $2
```

Add to `processSuggestionRows()` return object:

```javascript
active_discount_tier: row.active_discount_tier || null,
```

### Step 2 — Create `services/reorder/` Directory and Service

Create `services/reorder/checkbox-defaults-service.js` (see §2.4 above).
Directory is new — no other files needed yet.

### Step 3 — Integrate into Route

In `routes/analytics.js`, after receiving suggestions from `getReorderSuggestions()`:

```javascript
const { calculateCheckboxDefaults } = require('../services/reorder/checkbox-defaults-service');

// After existing suggestions call:
const merchantConfig = {}; // extensible, empty for now
result.suggestions = calculateCheckboxDefaults(result.suggestions, merchantConfig);
```

### Step 4 — Tests

Required tests (`tests/services/reorder/checkbox-defaults-service.test.js`):
- Rule 1: active discount tier → unchecked
- Rule 2: non-primary vendor → unchecked
- Rule 3: expiry risk (risky and safe examples from §2.2)
- Rule 4: default → checked
- Edge: zero velocity → checked (no expiry risk calculation)
- Edge: does_not_expire → skips expiry check
- Edge: null days_until_expiry → skips expiry check
- Priority: rule 1 beats rule 2, rule 2 beats rule 3

### Step 5 — Frontend

Reorder page (`public/reorder.html` / associated JS):
- Pre-set each row checkbox to `default_checked`
- Show tooltip/icon for `default_reason` (e.g. "Expiry discount active")
- No new backend work beyond steps 1-3

### Dependencies

| Dependency | Status |
|------------|--------|
| `variation_discount_status` table | ✓ Exists |
| `variation_expiration` in reorder query | ✓ Already JOINed |
| `is_primary_vendor` in response | ✓ Already computed |
| `final_suggested_qty` in response | ✓ Already computed |
| `active_discount_tier` in response | ✗ One JOIN needed (Step 1) |
| `services/reorder/` directory | ✗ Create (Step 2) |
