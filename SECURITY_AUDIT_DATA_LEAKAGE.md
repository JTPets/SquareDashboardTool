# Security Audit Report: Data Leakage Analysis
**Date:** 2026-01-05
**Auditor Role:** Database Architect and Security Lead
**Target:** sqtools.ca (Square Dashboard Tool)
**Focus:** Financial Data Leakage Risks

---

## Remediation Status (Updated 2026-01-05)

| # | Finding | Risk | Status |
|---|---------|------|--------|
| 1 | Database Export All Merchants | HIGH | **FIXED** - Endpoints removed |
| 2 | Webhook Events No Tenant Filter | MEDIUM | **FIXED** - Super-admin only (SUPER_ADMIN_EMAILS) |
| 3 | Images Table No merchant_id | LOW | Accepted Risk |
| 4 | Vendor ID Not Pre-Validated | MEDIUM | **FIXED** - Pre-validation added |
| 5 | PO Creation IDs Not Pre-Validated | MEDIUM | **FIXED** - Pre-validation added |
| 6 | Location Filter Via JOINs Only | LOW | Accepted Risk |
| 7 | Google Taxonomy Global Access | INFO | By Design |
| 8 | AUTH_DISABLED Removed | RESOLVED | Closed |

---

## Executive Summary

This audit analyzed the codebase for data leakage risks including tenant-less records, vendor isolation issues, "god mode" bypasses, and location/variation scoping vulnerabilities. While the codebase demonstrates strong tenant isolation in most areas with consistent `merchant_id` filtering, several issues were identified that could allow cross-tenant data access.

---

## Findings

### Finding 1: Database Export Exposes All Merchant Data

| Attribute | Value |
|-----------|-------|
| **File** | `server.js:7777-7834` |
| **Risk Level** | **HIGH** |
| **Endpoint** | `GET /api/database/export` |

**Description:**
The database export endpoint uses `requireAdmin` but performs a full `pg_dump` of the entire database, including ALL merchants' data.

**Specific Scenario:**
1. Admin user (who may only be authorized for their own merchant) accesses `/api/database/export`
2. They receive a complete SQL dump containing:
   - All merchants' vendor cost prices
   - All merchants' account numbers and vendor notes
   - All merchants' inventory data and sales velocity
   - All merchants' purchase order history
   - All merchants' API tokens and credentials

**Code:**
```javascript
// server.js:7801 - No merchant filtering, dumps entire database
const command = `${pgDumpCmd} -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} --clean --if-exists`;
```

**Recommendation:**
Either restrict this endpoint to super-admins only (not regular admins), or implement merchant-specific export that filters tables by `merchant_id`.

---

### Finding 2: Webhook Events Admin View Lacks Tenant Filtering

| Attribute | Value |
|-----------|-------|
| **File** | `server.js:8599-8646` |
| **Risk Level** | **MEDIUM** |
| **Endpoint** | `GET /api/webhooks/events` |

**Description:**
The webhook events viewer shows ALL webhook events from ALL merchants without any `merchant_id` filtering.

**Specific Scenario:**
1. Admin user for Merchant A accesses `/api/webhooks/events`
2. They see webhook events from Merchant B, C, D, etc.
3. Event data contains `merchant_id` and potentially sensitive `event_data` JSON

**Code:**
```javascript
// server.js:8603-8609 - No merchant_id filtering
let query = `
    SELECT id, square_event_id, event_type, merchant_id, status,
           received_at, processed_at, processing_time_ms, error_message,
           sync_results
    FROM webhook_events
    WHERE 1=1
`;
```

**Recommendation:**
Add `merchant_id` filtering: `WHERE merchant_id = $1` for the current user's merchant context.

---

### Finding 3: Images Table Has No Tenant Isolation

| Attribute | Value |
|-----------|-------|
| **File** | `server.js:719, 785` |
| **Risk Level** | **LOW** |
| **Table** | `images` |

**Description:**
The `images` table has no `merchant_id` column. Queries fetch images by ID without tenant filtering.

**Specific Scenario:**
If Merchant A somehow discovers an image ID belonging to Merchant B, they could theoretically reference it. However, image IDs are Square-assigned UUIDs, making enumeration difficult.

**Code:**
```javascript
// server.js:719 - No merchant_id in WHERE clause
`SELECT id, url FROM images WHERE id IN (${placeholders}) AND url IS NOT NULL`
```

**Mitigating Factor:**
Images are fetched through variation/item relationships which ARE tenant-filtered. The Square API provides its own tenant isolation for image IDs.

**Recommendation:**
Consider adding `merchant_id` to the `images` table for defense-in-depth, or document that this table intentionally relies on Square's tenant isolation.

---

### Finding 4: Vendor ID Not Explicitly Validated in Cost Update

| Attribute | Value |
|-----------|-------|
| **File** | `server.js:1814-1857` |
| **Risk Level** | **MEDIUM** |
| **Endpoint** | `PATCH /api/variations/:id/cost` |

**Description:**
The `vendor_id` from request body is used without explicit validation that the vendor belongs to the current merchant.

**Specific Scenario:**
1. Merchant A knows Vendor ID "V123" belongs to Merchant B
2. Merchant A calls `PATCH /api/variations/their-var-id/cost` with `{ cost_cents: 100, vendor_id: "V123" }`
3. The system may attempt to update using Merchant B's vendor
4. The Square API call `squareApi.updateVariationCost()` receives the cross-tenant vendor ID

**Code:**
```javascript
// server.js:1814,1845 - vendor_id from request used without validation
const { cost_cents, vendor_id } = req.body;
const targetVendorId = vendor_id || variation.vendor_id;
// targetVendorId is then used directly in Square API call
```

**Recommendation:**
Add explicit vendor ownership validation before use:
```javascript
if (vendor_id) {
    const vendorCheck = await db.query(
        'SELECT id FROM vendors WHERE id = $1 AND merchant_id = $2',
        [vendor_id, merchantId]
    );
    if (vendorCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Vendor not found or unauthorized' });
    }
}
```

---

### Finding 5: Purchase Order Creation - Location/Vendor Pre-Validation Missing

| Attribute | Value |
|-----------|-------|
| **File** | `server.js:6977-7017` |
| **Risk Level** | **MEDIUM** |
| **Endpoint** | `POST /api/purchase-orders` |

**Description:**
The `vendor_id` and `location_id` from request body are used directly in the INSERT statement without explicit pre-validation that they belong to the current merchant.

**Specific Scenario:**
1. Merchant A discovers Location ID "L456" belongs to Merchant B
2. Merchant A creates a purchase order with `{ vendor_id: "their-vendor", location_id: "L456", items: [...] }`
3. The INSERT succeeds with Merchant A's `merchant_id` but referencing Merchant B's location
4. Subsequent JOINs may fail, but the orphaned record exists

**Code:**
```javascript
// server.js:7010-7017 - IDs used directly without pre-validation
const poResult = await db.query(`
    INSERT INTO purchase_orders (
        po_number, vendor_id, location_id, status, ...
    )
    VALUES ($1, $2, $3, 'DRAFT', ...)
`, [poNumber, vendor_id, location_id, ...]);
```

**Recommendation:**
Add explicit ownership validation before INSERT:
```javascript
// Validate vendor belongs to merchant
const vendorCheck = await db.query(
    'SELECT id FROM vendors WHERE id = $1 AND merchant_id = $2',
    [vendor_id, merchantId]
);
if (vendorCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Invalid vendor' });
}

// Validate location belongs to merchant
const locationCheck = await db.query(
    'SELECT id FROM locations WHERE id = $1 AND merchant_id = $2',
    [location_id, merchantId]
);
if (locationCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Invalid location' });
}
```

---

### Finding 6: Location ID Filtering Via JOINs Only

| Attribute | Value |
|-----------|-------|
| **File** | `server.js:2818-2821, 5615-5618` |
| **Risk Level** | **LOW** |
| **Endpoints** | `GET /api/inventory`, `GET /api/reorder-suggestions` |

**Description:**
When `location_id` is provided in query parameters, it's added to WHERE clauses but ownership is verified only via JOIN conditions rather than explicit pre-validation.

**Specific Scenario:**
1. Merchant A supplies `?location_id=L789` (belonging to Merchant B)
2. The query adds `AND ic.location_id = $N` to the WHERE clause
3. The JOIN `JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $1` filters out the invalid location
4. Result: Empty result set, no data leakage

**Assessment:**
This is defense-in-depth, not a vulnerability. The JOIN-based filtering works correctly. However, explicit pre-validation would provide clearer error messages and earlier rejection.

---

### Finding 7: Google Taxonomy Access Without Merchant Context

| Attribute | Value |
|-----------|-------|
| **File** | `server.js:4551-4574` |
| **Risk Level** | **INFO** |
| **Endpoint** | `GET /api/gmc/taxonomy` |

**Description:**
The Google Taxonomy endpoint uses `requireAuth` but not `requireMerchant`. The `google_taxonomy` table is intentionally global (shared reference data).

**Assessment:**
This is **BY DESIGN**. The Google Product Taxonomy is a standardized, public taxonomy used for Google Merchant Center feeds. It's not merchant-specific data and should be accessible to all authenticated users.

---

### Finding 8: AUTH_DISABLED Bypass Removed (POSITIVE)

| Attribute | Value |
|-----------|-------|
| **File** | `server.js:151, 200` |
| **Risk Level** | **RESOLVED** |

**Description:**
Comments indicate that `AUTH_DISABLED` bypass was removed on 2026-01-05. No remaining bypass flags or "god mode" mechanisms were found.

**Code:**
```javascript
// server.js:151
// NOTE: AUTH_DISABLED bypass removed for security (2026-01-05)

// server.js:200
// Protect all API routes - auth is always enabled (AUTH_DISABLED bypass removed 2026-01-05)
```

---

## Summary Table

| # | Finding | File | Risk | Status |
|---|---------|------|------|--------|
| 1 | Database Export All Merchants | server.js:7777 | HIGH | Open |
| 2 | Webhook Events No Tenant Filter | server.js:8599 | MEDIUM | Open |
| 3 | Images Table No merchant_id | server.js:719 | LOW | Accept Risk |
| 4 | Vendor ID Not Pre-Validated | server.js:1814 | MEDIUM | Open |
| 5 | PO Creation IDs Not Pre-Validated | server.js:6977 | MEDIUM | Open |
| 6 | Location Filter Via JOINs Only | server.js:2818 | LOW | Accept Risk |
| 7 | Google Taxonomy Global Access | server.js:4551 | INFO | By Design |
| 8 | AUTH_DISABLED Removed | server.js:151 | RESOLVED | Closed |

---

## Recommendations Priority

### Immediate (High Priority)
1. **Restrict database export** to super-admin role or implement merchant-specific export
2. **Add merchant_id filter** to webhook events query

### Short-term (Medium Priority)
3. **Add explicit vendor_id validation** in cost update endpoint
4. **Add explicit location_id and vendor_id validation** in purchase order creation

### Long-term (Low Priority)
5. **Consider adding merchant_id** to images table for defense-in-depth
6. **Document intentional design decisions** for global tables (google_taxonomy, images)

---

## Positive Findings

- Strong `merchant_id` filtering across catalog, inventory, vendors, and sales data
- JOIN-based tenant isolation provides effective protection in read operations
- Authentication bypass (`AUTH_DISABLED`) has been removed
- Most write operations properly include `merchant_id` in INSERT statements
- Admin endpoints properly use `requireAdmin` middleware

---

*Report generated as part of deep-system hardening audit for sqtools.ca*
