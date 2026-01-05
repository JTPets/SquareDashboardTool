# Implementation Plan: Multi-Tenant Security Fixes

## Overview

This plan addresses 13 CRITICAL vulnerabilities identified in the security audit. Changes are organized to minimize risk of breaking existing functionality.

## Key Insight

The `variation_expiration` table already has `merchant_id` column (added in migration 005), but:
1. The PRIMARY KEY is still just `(variation_id)`
2. ON CONFLICT clauses reference `(variation_id)` not `(variation_id, merchant_id)`

Same issue for `variation_discount_status`.

---

## Phase 1: Database Schema Changes (ensureSchema in database.js)

### 1.1 Tables Needing Unique Constraint Updates (Simple)

These tables have regular UNIQUE constraints that need merchant_id added:

| Table | Old Constraint | New Constraint Name |
|-------|---------------|---------------------|
| `variation_vendors` | `UNIQUE(variation_id, vendor_id)` | `variation_vendors_var_vendor_merchant_unique` |
| `variation_location_settings` | `UNIQUE(variation_id, location_id)` | `variation_location_settings_var_loc_merchant_unique` |
| `sales_velocity` | `UNIQUE(variation_id, location_id, period_days)` | `sales_velocity_var_loc_period_merchant_unique` |

**Pattern:** Same as existing migrations - drop old, add new.

### 1.2 Tables Needing Primary Key Restructure (Complex)

These tables use `variation_id` as PRIMARY KEY, which prevents adding merchant_id to the uniqueness:

| Table | Current PK | Solution |
|-------|-----------|----------|
| `variation_expiration` | `variation_id` | Add `id SERIAL`, change PK, add unique constraint |
| `variation_discount_status` | `variation_id` | Add `id SERIAL`, change PK, add unique constraint |

**Migration Steps for each:**
1. Check if `id` column exists (already migrated)
2. If not:
   - Add `id SERIAL` column
   - Drop PRIMARY KEY constraint on `variation_id`
   - Add PRIMARY KEY on `id`
   - Add UNIQUE constraint on `(variation_id, merchant_id)`
3. Backfill merchant_id from variations table for any NULL values

---

## Phase 2: Code Changes (ON CONFLICT Clauses)

### 2.1 server.js Changes

| Line | Table | Current | Change To |
|------|-------|---------|-----------|
| 1778 | variation_location_settings | `ON CONFLICT (variation_id, location_id)` | `ON CONFLICT (variation_id, location_id, merchant_id)` |
| 2176 | variation_expiration | `ON CONFLICT (variation_id)` | `ON CONFLICT (variation_id, merchant_id)` |
| 2286 | variation_expiration | `ON CONFLICT (variation_id)` | `ON CONFLICT (variation_id, merchant_id)` |
| 4562 | item_brands | `ON CONFLICT (item_id)` | `ON CONFLICT (item_id, merchant_id)` |

### 2.2 utils/square-api.js Changes

| Line | Table | Current | Change To |
|------|-------|---------|-----------|
| 840 | variation_location_settings | `ON CONFLICT (variation_id, location_id)` | `ON CONFLICT (variation_id, location_id, merchant_id)` |
| 871 | variation_vendors | `ON CONFLICT (variation_id, vendor_id)` | `ON CONFLICT (variation_id, vendor_id, merchant_id)` |
| 954 | variation_expiration | `ON CONFLICT (variation_id)` | `ON CONFLICT (variation_id, merchant_id)` |
| 1218 | sales_velocity | `ON CONFLICT (variation_id, location_id, period_days)` | `ON CONFLICT (variation_id, location_id, period_days, merchant_id)` |
| 2883 | variation_vendors | `ON CONFLICT (variation_id, vendor_id)` | `ON CONFLICT (variation_id, vendor_id, merchant_id)` |

### 2.3 utils/expiry-discount.js Changes

| Line | Table | Current | Change To |
|------|-------|---------|-----------|
| 260 | variation_discount_status | `ON CONFLICT (variation_id)` | `ON CONFLICT (variation_id, merchant_id)` |

**Note:** This also requires adding `merchant_id` to the INSERT column list and VALUES.

### 2.4 utils/gmc-feed.js Changes

| Line | Function | Issue | Fix |
|------|----------|-------|-----|
| 14-21 | `getSettings()` | No merchant_id filter | Add merchantId parameter, filter query |
| 351 | `importBrands()` | No merchant_id | Add merchantId parameter (BUT: this function may be unused/admin-only - verify) |

---

## Phase 3: Implementation Order

**Critical principle:** Schema changes MUST happen before code changes, otherwise ON CONFLICT will fail.

### Step 1: Update ensureSchema() in database.js
Add migrations for the 5 missing tables in this order:
1. `variation_location_settings` (simple constraint update)
2. `variation_vendors` (simple constraint update)
3. `sales_velocity` (simple constraint update)
4. `variation_expiration` (PK restructure)
5. `variation_discount_status` (PK restructure + add merchant_id column)

### Step 2: Update ON CONFLICT clauses
Only after schema changes are in place:
1. server.js (4 changes)
2. utils/square-api.js (5 changes)
3. utils/expiry-discount.js (1 change + add merchant_id to INSERT)

### Step 3: Fix gmc-feed.js
1. Update getSettings() to accept merchantId
2. Verify importBrands() usage and fix if needed

---

## Risk Mitigation

1. **Each schema change wrapped in try/catch** - won't crash on failure
2. **Check before modify** - only alter if old constraint exists OR new doesn't
3. **Idempotent** - running ensureSchema multiple times is safe
4. **Backward compatible** - existing data preserved

---

## Testing Checklist

After implementation:
- [ ] Server starts without errors
- [ ] Sync completes for existing merchant
- [ ] Expiration updates work
- [ ] Min stock updates work
- [ ] GMC feed generates correctly
- [ ] No console errors about constraint violations
