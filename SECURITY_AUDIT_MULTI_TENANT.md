# Multi-Tenant Security Audit Report

**Date:** 2026-01-03
**Auditor:** Claude Security Audit
**Severity Scale:** CRITICAL > HIGH > MEDIUM > LOW

---

## Executive Summary

This audit identified **13 CRITICAL** and **3 HIGH** severity tenant isolation vulnerabilities in the recently migrated multi-tenant architecture. These vulnerabilities could allow one merchant to view, modify, or corrupt another merchant's data.

**Root Cause:** ON CONFLICT clauses in INSERT/UPSERT statements reference old single-column unique constraints that don't include `merchant_id`, and several database tables were not updated in migration 007 to include `merchant_id` in their unique constraints.

---

## CRITICAL Vulnerabilities

### 1. ON CONFLICT Clauses Missing merchant_id

These queries use ON CONFLICT with constraints that don't include `merchant_id`, meaning one merchant's INSERT could overwrite another merchant's data:

#### server.js

| Line | Table | Constraint Used | Should Be |
|------|-------|-----------------|-----------|
| 1778 | variation_location_settings | `(variation_id, location_id)` | `(variation_id, location_id, merchant_id)` |
| 2176 | variation_expiration | `(variation_id)` | `(variation_id, merchant_id)` |
| 2286 | variation_expiration | `(variation_id)` | `(variation_id, merchant_id)` |
| 4562 | item_brands | `(item_id)` | `(item_id, merchant_id)` |

#### utils/square-api.js

| Line | Table | Constraint Used | Should Be |
|------|-------|-----------------|-----------|
| 840 | variation_location_settings | `(variation_id, location_id)` | `(variation_id, location_id, merchant_id)` |
| 871 | variation_vendors | `(variation_id, vendor_id)` | `(variation_id, vendor_id, merchant_id)` |
| 954 | variation_expiration | `(variation_id)` | `(variation_id, merchant_id)` |
| 1218 | sales_velocity | `(variation_id, location_id, period_days)` | `(variation_id, location_id, period_days, merchant_id)` |
| 2883 | variation_vendors | `(variation_id, vendor_id)` | `(variation_id, vendor_id, merchant_id)` |

#### utils/expiry-discount.js

| Line | Table | Constraint Used | Should Be |
|------|-------|-----------------|-----------|
| 260 | variation_discount_status | `(variation_id)` | `(variation_id, merchant_id)` |

---

### 2. Database Schema Missing Multi-Tenant Constraints

Migration `007_multi_tenant_constraints.sql` updated many tables but **missed the following**:

| Table | Current Constraint | Required Constraint |
|-------|-------------------|---------------------|
| `variation_vendors` | `UNIQUE(variation_id, vendor_id)` | `UNIQUE(variation_id, vendor_id, merchant_id)` |
| `variation_location_settings` | `UNIQUE(variation_id, location_id)` | `UNIQUE(variation_id, location_id, merchant_id)` |
| `sales_velocity` | `UNIQUE(variation_id, location_id, period_days)` | `UNIQUE(variation_id, location_id, period_days, merchant_id)` |
| `variation_expiration` | `PRIMARY KEY(variation_id)` | Need composite key or `UNIQUE(variation_id, merchant_id)` |
| `variation_discount_status` | `PRIMARY KEY(variation_id)` | Need composite key or `UNIQUE(variation_id, merchant_id)` |

---

### 3. utils/gmc-feed.js - Missing Merchant Filtering

**Line 14-21:** `getSettings()` retrieves ALL merchants' GMC settings without filtering:

```javascript
// VULNERABLE - returns ALL merchants' settings
async function getSettings() {
    const result = await db.query('SELECT setting_key, setting_value FROM gmc_settings');
    // ...
}
```

**Line 351:** `importBrands()` inserts brands without merchant_id:

```javascript
// VULNERABLE - no merchant_id, uses old single-column constraint
await db.query(
    'INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
    [name.trim()]
);
```

---

## HIGH Vulnerabilities

### 4. variation_discount_status Table Design

The `variation_discount_status` table uses `variation_id` as PRIMARY KEY without merchant_id:

```sql
CREATE TABLE variation_discount_status (
    variation_id TEXT PRIMARY KEY REFERENCES variations(id) ON DELETE CASCADE,
    -- missing merchant_id column
);
```

This assumes variation IDs are globally unique (they are in Square, but this violates multi-tenant isolation principles).

---

### 5. variation_expiration Table Design

Same issue - `variation_id` is PRIMARY KEY without merchant_id column:

```sql
CREATE TABLE variation_expiration (
    variation_id TEXT PRIMARY KEY REFERENCES variations(id) ON DELETE CASCADE,
    -- missing merchant_id column
);
```

---

### 6. gmc_feed_history Table Missing merchant_id

The `gmc_feed_history` table has no `merchant_id` column at all, making it impossible to track which merchant generated which feed.

---

## Positive Findings

### Properly Secured Areas

1. **API Endpoints:** All data API endpoints properly use `requireMerchant` middleware
2. **No req.body.merchantId:** No instances of trusting user-supplied merchantId found
3. **MerchantDB wrapper:** The `utils/merchant-db.js` class properly enforces tenant isolation for queries using it
4. **Background jobs:** Cron jobs properly iterate per-merchant
5. **Several tables properly migrated:** `inventory_counts`, `count_history`, `brands`, `item_brands`, etc.

---

## Required Fixes

### Database Migration (Priority 1)

Create a new migration `008_complete_multi_tenant.sql`:

```sql
-- 1. Add merchant_id to tables missing it
ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE variation_discount_status ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);
ALTER TABLE gmc_feed_history ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

-- 2. Update unique constraints
ALTER TABLE variation_vendors DROP CONSTRAINT IF EXISTS variation_vendors_variation_id_vendor_id_key;
ALTER TABLE variation_vendors ADD CONSTRAINT variation_vendors_var_vendor_merchant_unique
    UNIQUE(variation_id, vendor_id, merchant_id);

ALTER TABLE variation_location_settings DROP CONSTRAINT IF EXISTS variation_location_settings_variation_id_location_id_key;
ALTER TABLE variation_location_settings ADD CONSTRAINT variation_location_settings_var_loc_merchant_unique
    UNIQUE(variation_id, location_id, merchant_id);

ALTER TABLE sales_velocity DROP CONSTRAINT IF EXISTS sales_velocity_variation_id_location_id_period_days_key;
ALTER TABLE sales_velocity ADD CONSTRAINT sales_velocity_var_loc_period_merchant_unique
    UNIQUE(variation_id, location_id, period_days, merchant_id);

-- 3. variation_expiration needs structural change (was PRIMARY KEY on variation_id)
-- Option A: Add id column and change primary key
ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS id SERIAL;
ALTER TABLE variation_expiration DROP CONSTRAINT IF EXISTS variation_expiration_pkey;
ALTER TABLE variation_expiration ADD PRIMARY KEY (id);
ALTER TABLE variation_expiration ADD CONSTRAINT variation_expiration_var_merchant_unique
    UNIQUE(variation_id, merchant_id);

-- 4. Same for variation_discount_status
ALTER TABLE variation_discount_status ADD COLUMN IF NOT EXISTS id SERIAL;
ALTER TABLE variation_discount_status DROP CONSTRAINT IF EXISTS variation_discount_status_pkey;
ALTER TABLE variation_discount_status ADD PRIMARY KEY (id);
ALTER TABLE variation_discount_status ADD CONSTRAINT variation_discount_status_var_merchant_unique
    UNIQUE(variation_id, merchant_id);
```

### Code Fixes (Priority 1)

Update all ON CONFLICT clauses to include merchant_id. Example fix for server.js:1778:

```javascript
// BEFORE (VULNERABLE)
ON CONFLICT (variation_id, location_id)

// AFTER (FIXED)
ON CONFLICT (variation_id, location_id, merchant_id)
```

### Files Requiring Updates:

1. `server.js` - Lines 1778, 2176, 2286, 4562
2. `utils/square-api.js` - Lines 840, 871, 954, 1218, 2883
3. `utils/expiry-discount.js` - Line 260
4. `utils/gmc-feed.js` - Lines 14-21 (add merchantId parameter), Line 351 (add merchant_id)

---

## Remediation Priority

| Priority | Issue | Effort |
|----------|-------|--------|
| 1 | Create migration 008 for missing constraints | 2 hours |
| 2 | Fix ON CONFLICT clauses in server.js | 1 hour |
| 3 | Fix ON CONFLICT clauses in square-api.js | 1 hour |
| 4 | Fix gmc-feed.js getSettings and importBrands | 30 min |
| 5 | Fix expiry-discount.js | 30 min |
| 6 | Add integration tests for tenant isolation | 4 hours |

---

## Testing Recommendations

After fixes, verify with:

1. Create two test merchants
2. Insert same variation_id (if possible) or similar data for both
3. Verify ON CONFLICT updates correct merchant's data only
4. Verify queries never return other merchant's data
5. Run full sync for both merchants concurrently

---

## Conclusion

The multi-tenant migration is incomplete. Several tables and ON CONFLICT clauses were not updated, creating data leakage and corruption risks between merchants. Immediate remediation is required before production use with multiple merchants.
