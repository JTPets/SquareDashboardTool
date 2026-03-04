# Sales Velocity Refactor Plan: Inventory Changes as Source of Truth

**Date**: 2026-02-25
**Status**: DRAFT — awaiting review before implementation
**Resolves**: BACKLOG-35 (refunds not subtracted), BACKLOG-36 (phantom velocity rows)

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Risk Assessment](#2-risk-assessment)
3. [Schema: inventory_changes Table](#3-schema-inventory_changes-table)
4. [Backfill Strategy](#4-backfill-strategy)
5. [Webhook Handler Changes](#5-webhook-handler-changes)
6. [Velocity Recalculation Approach](#6-velocity-recalculation-approach)
7. [Transition Plan](#7-transition-plan)
8. [Gaps and Unknowns](#8-gaps-and-unknowns)
9. [Implementation Phases](#9-implementation-phases)

---

## 1. Problem Statement

### Current Architecture

Sales velocity is calculated by fetching COMPLETED orders from the Square Orders API (`POST /v2/orders/search`) for 91/182/365-day windows. Three mechanisms exist:

| Function | File | Trigger | API Calls |
|----------|------|---------|-----------|
| `syncSalesVelocityAllPeriods()` | `services/square/api.js:1768` | Smart sync cron (3h/24h/168h intervals) | ~40 per full sync (200 orders/page) |
| `syncSalesVelocity()` | `services/square/api.js:1572` | Legacy single-period sync | ~37 per 91d period |
| `updateSalesVelocityFromOrder()` | `services/square/api.js:2104` | Webhook (order.created/updated) | 0 (uses webhook data) |

### Three Defects

**Defect 1: Variation ID remapping corrupts historical data.**
Square reassigns `catalog_object_id` values when a seller reorders item variations in POS. A bag of dog food that was `VAR_ABC` yesterday becomes `VAR_XYZ` today. The Orders API returns orders with the *current* variation ID, not the ID at time of sale. But `sales_velocity` rows keyed on the *old* ID become orphans — they never get updated (BACKLOG-36) and the new ID starts from zero with no history. This is a permanent, silent data corruption that worsens over time. BACKLOG-33 added a warning badge, but the root cause persists.

**Defect 2: Refunds not subtracted (BACKLOG-35).**
`syncSalesVelocity*` fetches only COMPLETED orders. Refunded quantities are never decremented. Impact: ~2 refunds/day, velocity slightly inflated on affected items.

**Defect 3: Phantom velocity rows never self-correct (BACKLOG-36).**
`syncSalesVelocity*` only UPSERTs variations that appear in orders. If a variation had sales in period N but zero sales in period N+1, the stale row persists with inflated totals. The daily full rebuild *overwrites* active rows but never deletes rows for variations with zero sales.

### Why This Matters

Velocity data drives:
- **Reorder suggestions** (`routes/analytics.js:95-760`) — incorrect velocity = wrong reorder quantities
- **Days-until-stockout** calculations — used across 4 pages
- **Bundle availability** (`routes/bundles.js:88-257`) — bundle assembly predictions
- **Vendor dashboard** (`services/vendor-dashboard.js`) — vendor reorder value estimates
- **Slow/fast mover classification** — inventory prioritization

### Why Inventory Changes API Is the Fix

Square's Inventory Changes API (`POST /v2/inventory/changes/batch-retrieve`) returns an immutable ledger of `InventoryAdjustment` records. Each adjustment records:
- `catalog_object_id` — the variation at time of change (not remapped retroactively)
- `from_state` / `to_state` — e.g., `IN_STOCK` -> `SOLD` for a sale
- `quantity` — change amount
- `occurred_at` — when it happened
- `location_id` — where
- `id` — unique, immutable Square-generated ID

**Key property**: These records are immutable. Once written, they don't change when variation IDs are remapped in the catalog. A sale recorded as `VAR_ABC` stays `VAR_ABC` in the change history forever, even after the catalog item is reordered in POS.

**Data retention**: Square does not document an expiration period. Historical changes appear to be retained indefinitely and are pageable without time limit.

**Important correction to the task description**: The webhook `inventory.count.updated` does NOT include change reason/type. It only contains the *new count* (quantity, state, catalog_object_id, location_id). To get the actual adjustment with from_state/to_state, we must call the Inventory Changes API. The webhook tells us *something changed*; the Changes API tells us *what kind of change*.

---

## 2. Risk Assessment

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Backfill volume exceeds Square rate limits** | API calls throttled, backfill takes hours/days | Paginate with cursor, respect 429 responses, exponential backoff. Run during off-hours. Estimate: ~50-200 API calls for 1 year of history (1000 changes/page). |
| **Variation ID mismatch between old `sales_velocity` and new `inventory_changes`** | During transition, old velocity rows reference current IDs; new rows reference historical IDs. These may not match for reordered items. | Parallel-run both systems. Don't delete old `sales_velocity` data until new system is validated. Accept that historical data for reordered items will have a discontinuity at the switchover point. |
| **`inventory.count.updated` webhook doesn't include change type** | Cannot determine SALE vs RECEIVE vs ADJUSTMENT from webhook alone. Must make a follow-up API call per webhook event, or batch them. | Use the webhook as a *trigger* to fetch recent changes from the Changes API for that variation. Batch: collect variation IDs over a short window (e.g., 5-10 seconds), then make one `BatchRetrieveInventoryChanges` call. |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Missed webhooks create gaps** | Some inventory changes not captured | Periodic gap-fill job (daily) fetches changes since last known `occurred_at`. Compare local max `occurred_at` vs Square. |
| **Square adjustments from external integrations** | Third-party apps creating non-sale adjustments we'd misclassify | Filter strictly on `from_state=IN_STOCK, to_state=SOLD` for velocity. Other transitions are useful for audit but not velocity. |
| **Concurrent webhook + gap-fill writes** | Duplicate rows if webhook and gap-fill fetch the same change | `square_change_id` UNIQUE constraint prevents duplicates. Use `ON CONFLICT DO NOTHING`. |
| **Performance regression on velocity queries** | Aggregating from raw changes is slower than reading pre-computed `sales_velocity` | Keep `sales_velocity` as a materialized summary. Recompute from `inventory_changes` instead of from Orders API. Index on `(merchant_id, to_state, occurred_at)`. |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Square deprecates Inventory Changes API** | Would need to find another source | Unlikely — it's their core inventory ledger. The deprecated endpoint was replaced by `batch-retrieve`, not removed entirely. |
| **Large data volume over time** | `inventory_changes` table grows indefinitely | Partition by `occurred_at` (monthly). Archive rows older than 2 years. 365-day velocity only needs 1 year of data. |
| **Multi-tenant backfill coordination** | Each merchant needs independent backfill | Backfill is already per-merchant. Add `backfill_completed_at` column to `merchants` table to track progress. |

---

## 3. Schema: `inventory_changes` Table

```sql
-- Immutable append-only log of inventory changes from Square.
-- Source of truth for sales velocity calculations.
-- Each row corresponds to one InventoryAdjustment or InventoryPhysicalCount from Square.
CREATE TABLE inventory_changes (
    id SERIAL PRIMARY KEY,
    square_change_id TEXT NOT NULL,           -- Square's unique adjustment/count ID (immutable)
    change_type TEXT NOT NULL,                -- 'ADJUSTMENT' or 'PHYSICAL_COUNT'
    catalog_object_id TEXT NOT NULL,          -- variation ID at time of change
    location_id TEXT NOT NULL,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    from_state TEXT,                          -- e.g., 'IN_STOCK' (NULL for PHYSICAL_COUNT)
    to_state TEXT,                            -- e.g., 'SOLD' (NULL for PHYSICAL_COUNT)
    quantity DECIMAL(10,5) NOT NULL,          -- change amount (Square supports 5 decimal places)
    occurred_at TIMESTAMPTZ NOT NULL,         -- when the change happened (from Square)
    source_type TEXT,                         -- 'SQUARE_POS', 'EXTERNAL', 'API', etc.
    source_application_id TEXT,               -- which app caused the change
    reference_id TEXT,                        -- optional external reference (order ID, PO ID)
    total_price_money_amount INTEGER,         -- read-only sale price in cents (when available)
    total_price_money_currency TEXT,          -- currency code (e.g., 'CAD')
    created_at TIMESTAMPTZ DEFAULT NOW(),     -- when we stored it locally
    UNIQUE(square_change_id, merchant_id)     -- prevent duplicates across backfill + webhooks
);

-- Primary query: velocity calculation (sales in a time window)
CREATE INDEX idx_inv_changes_velocity
    ON inventory_changes(merchant_id, to_state, occurred_at DESC)
    WHERE to_state = 'SOLD';

-- Lookup by variation for history display
CREATE INDEX idx_inv_changes_variation
    ON inventory_changes(merchant_id, catalog_object_id, occurred_at DESC);

-- Gap-fill: find latest change per merchant
CREATE INDEX idx_inv_changes_latest
    ON inventory_changes(merchant_id, occurred_at DESC);

-- Prevent duplicate inserts during concurrent webhook + gap-fill
-- (covered by UNIQUE constraint above, but explicit index helps ON CONFLICT performance)
CREATE INDEX idx_inv_changes_square_id
    ON inventory_changes(square_change_id, merchant_id);

COMMENT ON TABLE inventory_changes IS 'Immutable append-only log of Square inventory adjustments. Source of truth for sales velocity.';
COMMENT ON COLUMN inventory_changes.square_change_id IS 'Square-generated unique ID for the adjustment or physical count';
COMMENT ON COLUMN inventory_changes.quantity IS 'Absolute quantity changed. For SOLD transitions, this is units sold.';
COMMENT ON COLUMN inventory_changes.from_state IS 'Inventory state before change. IN_STOCK->SOLD = sale. NONE->IN_STOCK = receive.';
COMMENT ON COLUMN inventory_changes.to_state IS 'Inventory state after change. Used to filter: SOLD for sales, IN_STOCK for receives.';
```

### Why Not FK to `variations`?

The `catalog_object_id` column intentionally has NO foreign key to `variations(id)`. Reason: Square may remap variation IDs. A historical change may reference a variation ID that no longer exists in our `variations` table (it was replaced by a new ID when the item was reordered in POS). The whole point of this table is to preserve the original IDs. We JOIN to `variations` at query time and handle NULLs gracefully.

### Estimated Table Size

For a single pet food store (~50-100 SKUs, ~20-40 transactions/day):
- ~800-1600 SOLD changes/month (40 txns * 1-2 line items * 20 business days)
- ~200-400 RECEIVE changes/month (stock receipts)
- **~12,000-24,000 rows/year per merchant**
- At ~200 bytes/row, this is ~2.4-4.8 MB/year. Trivial for PostgreSQL.

---

## 4. Backfill Strategy

### Approach

Use `POST /v2/inventory/changes/batch-retrieve` to pull all historical ADJUSTMENT records for each merchant. Filter for `types: ['ADJUSTMENT']` and page through all results.

### API Call Volume Estimate

Square returns up to **1000 changes per page** (confirmed in API docs). For JTPets:

| Data | Estimate |
|------|----------|
| Active SKUs | ~200 variations |
| Sales/day | ~40 transactions, ~80-120 line items |
| Changes/year | ~24,000 SOLD + ~5,000 RECEIVE + ~2,000 other = ~31,000 |
| Pages needed (1yr) | ~31 API calls |
| Pages needed (2yr) | ~62 API calls |
| At 200ms/call + 100ms delay | ~18 seconds for 1 year |

For a larger multi-tenant merchant (10x volume): ~310 API calls, ~3 minutes. Well within Square's rate limits (which are ~20 requests/second per merchant).

### Backfill Implementation

```
1. For each active merchant:
   a. Query: POST /v2/inventory/changes/batch-retrieve
      - types: ['ADJUSTMENT']
      - location_ids: [all active locations]
      - occurred_at filter: start from 2 years ago (or earliest available)
      - cursor pagination
   b. For each InventoryAdjustment in response:
      - INSERT INTO inventory_changes ... ON CONFLICT (square_change_id, merchant_id) DO NOTHING
   c. Continue until no more cursor
   d. Record backfill_completed_at on merchants table
2. Log summary: total changes imported, date range covered, any errors
```

### Backfill Considerations

- **Run once, idempotent**: The `ON CONFLICT DO NOTHING` on `square_change_id` means re-running is safe.
- **No `occurred_at` write restriction**: The 24-hour restriction only applies to *creating* new adjustments via `batch-create`, not to *reading* historical adjustments.
- **Physical counts**: Also fetch `PHYSICAL_COUNT` type. These are useful for auditing but not for velocity. Store them anyway — they help explain inventory discrepancies.
- **Rate limiting**: Square's standard rate limit is 20 requests/second per access token. With 100ms delay between pages, we'll use ~3 req/sec. No risk of hitting limits.

---

## 5. Webhook Handler Changes

### Current Flow (inventory-handler.js)

```
inventory.count.updated webhook arrives
  → handleInventoryCountUpdated()
    → syncQueue.executeWithQueue('inventory', ...)
      → squareApi.syncInventory()    // refreshes inventory_counts table
    → return result
  (change event data is discarded)
```

### Problem

The `inventory.count.updated` webhook payload contains only the **new count** (quantity, state, catalog_object_id, location_id). It does NOT contain:
- `from_state` / `to_state` (what kind of change)
- `square_change_id` (which specific adjustment)
- Whether it was a SALE, RECEIVE, ADJUSTMENT, etc.

### Proposed Flow

```
inventory.count.updated webhook arrives
  → handleInventoryCountUpdated()
    → [EXISTING] syncQueue.executeWithQueue('inventory', ...) → syncInventory()
    → [NEW] fetchAndStoreRecentChanges(merchantId, catalogObjectId)
      → POST /v2/inventory/changes/batch-retrieve
        - catalog_object_ids: [catalogObjectId from webhook]
        - occurred_at: { start_at: lastKnownChangeTime }
        - types: ['ADJUSTMENT']
      → For each adjustment not already in inventory_changes:
        - INSERT ... ON CONFLICT DO NOTHING
    → return result
```

### Design Decision: Per-Webhook API Call vs Batching

**Option A: Immediate per-webhook fetch** (simpler)
- On each `inventory.count.updated`, fetch recent changes for that variation
- Pro: Simple, real-time
- Con: 1 additional API call per webhook event

**Option B: Batched fetch with debounce** (more efficient)
- Collect variation IDs from webhooks over a 5-10 second window
- Make one batched `BatchRetrieveInventoryChanges` call for all accumulated IDs
- Pro: Fewer API calls during batch inventory updates (e.g., receiving a shipment)
- Con: More complex, slight delay

**Recommendation: Option A for now.** JTPets receives ~40-80 inventory webhooks/day. One extra API call per webhook is ~40-80 calls/day — negligible against Square's rate limits. Optimize to Option B only if multi-tenant volume demands it.

### New API Call Details

```javascript
// Fetch changes for a specific variation since our last known change
const response = await squareClient.inventory.batchRetrieveChanges({
    catalogObjectIds: [catalogObjectId],
    locationIds: activeLocationIds,
    types: ['ADJUSTMENT'],
    occurredAt: {
        startAt: lastKnownOccurredAt  // from most recent inventory_changes row for this variation
    }
});
```

### Files Modified

| File | Change |
|------|--------|
| `services/webhook-handlers/inventory-handler.js` | Add `_fetchAndStoreRecentChanges()` method, call from `handleInventoryCountUpdated()` |
| `services/square/api.js` | Add `fetchInventoryChanges(merchantId, options)` function for the API call |

### Revenue Data

The `InventoryAdjustment` object includes `total_price_money` (read-only) for SOLD transitions. This gives us revenue data without needing the Orders API. However, this field may not always be populated (Square docs say "read-only" but don't guarantee presence). **Fallback**: If `total_price_money` is NULL, look up the variation's current price from `variations.price_money`. This is imperfect (price may have changed since sale) but acceptable for velocity revenue estimates.

---

## 6. Velocity Recalculation Approach

### Current: Orders API Rebuild

```
syncSalesVelocityAllPeriods():
  1. Fetch ALL completed orders for 365 days (~40 API calls)
  2. Aggregate line items by variation:location:period
  3. UPSERT into sales_velocity (full overwrite)
```

### New: Local Aggregation from inventory_changes

```
recalculateVelocityFromChanges(merchantId):
  1. DELETE FROM sales_velocity WHERE merchant_id = $1  (clean slate)
  2. For each period in [91, 182, 365]:
     INSERT INTO sales_velocity (...)
     SELECT
       catalog_object_id AS variation_id,
       location_id,
       $period AS period_days,
       SUM(quantity) AS total_quantity_sold,
       COALESCE(SUM(total_price_money_amount), 0) AS total_revenue_cents,
       (NOW() - INTERVAL '$period days') AS period_start_date,
       NOW() AS period_end_date,
       SUM(quantity) / $period AS daily_avg_quantity,
       COALESCE(SUM(total_price_money_amount), 0) / $period AS daily_avg_revenue_cents,
       SUM(quantity) / ($period / 7.0) AS weekly_avg_quantity,
       SUM(quantity) / ($period / 30.0) AS monthly_avg_quantity,
       $merchantId AS merchant_id
     FROM inventory_changes
     WHERE merchant_id = $1
       AND to_state = 'SOLD'
       AND occurred_at >= NOW() - INTERVAL '$period days'
     GROUP BY catalog_object_id, location_id
     ON CONFLICT (variation_id, location_id, period_days, merchant_id)
     DO UPDATE SET ...
  3. Log: "Velocity recalculated from N local changes, 0 API calls"
```

### Benefits Over Current Approach

| Aspect | Orders API (current) | Inventory Changes (new) |
|--------|---------------------|------------------------|
| API calls per sync | ~40 (365d) | **0** (local query) |
| Handles ID remapping | No (corrupted) | **Yes** (immutable IDs) |
| Handles refunds | No (BACKLOG-35) | **Yes** (`IN_STOCK` -> `SOLD` only; returns are separate state) |
| Phantom rows | Yes (BACKLOG-36) | **No** (DELETE + INSERT, clean slate) |
| Sync time | ~15-30 seconds | **<1 second** (local SQL) |
| Revenue accuracy | Order line item amounts | `total_price_money` from adjustment (may need fallback) |

### What About `updateSalesVelocityFromOrder()`?

The incremental order-based velocity update (`services/square/api.js:2104`) currently runs on every completed order webhook. After migration:

- **Phase 1-2**: Keep it running. It provides real-time velocity updates while we build the new system.
- **Phase 3**: Disable it. Velocity is now driven by `inventory_changes` data.
- **Rationale for removal**: The incremental update only adds, never subtracts. It can't handle the sliding window (orders falling off the 91-day edge). The full recalculation from `inventory_changes` is cheap enough to run frequently (every smart sync cycle).

### Handling Refunds (BACKLOG-35 resolution)

In Square's inventory model:
- **Sale**: `IN_STOCK` -> `SOLD` (quantity decreases from stock)
- **Refund/return**: `SOLD` -> `IN_STOCK` or customer return states

The velocity query filters on `to_state = 'SOLD'`. Returns move items OUT of SOLD state via a separate adjustment. So:
- Sales are captured as positive quantities (IN_STOCK -> SOLD)
- Refunds create a reverse adjustment (some state -> IN_STOCK)

To get net sales: `SUM(quantity) WHERE to_state = 'SOLD'` minus `SUM(quantity) WHERE from_state = 'SOLD'`.

```sql
-- Net sales velocity query
SELECT
    catalog_object_id,
    location_id,
    SUM(CASE WHEN to_state = 'SOLD' THEN quantity ELSE 0 END)
    - SUM(CASE WHEN from_state = 'SOLD' THEN quantity ELSE 0 END)
    AS net_quantity_sold
FROM inventory_changes
WHERE merchant_id = $1
  AND occurred_at >= NOW() - INTERVAL '91 days'
  AND ('SOLD' IN (from_state, to_state))
GROUP BY catalog_object_id, location_id;
```

This natively handles BACKLOG-35 with no additional logic.

### Handling Phantom Rows (BACKLOG-36 resolution)

The new approach uses DELETE + INSERT (or a temp table swap) rather than UPSERT. Any variation with zero net sales in a period simply won't have a row. This natively resolves BACKLOG-36.

### Variation ID Mapping

The `sales_velocity` table has a FK to `variations(id)`. Since `inventory_changes.catalog_object_id` may reference old (remapped) variation IDs, the velocity recalculation needs to handle this:

**Option A: Drop the FK on sales_velocity.variation_id**
- Pro: Simple, allows historical IDs
- Con: Orphan rows possible, breaks existing JOINs

**Option B: Map old IDs to current IDs using a lookup table** (variation_id_map)
- Pro: Clean data, existing queries work
- Con: Requires maintaining the map (complex)

**Option C: Only use inventory_changes IDs that exist in current variations table**
- Pro: No schema changes needed, existing JOINs work
- Con: Sales under old variation IDs are lost (same problem as today, but only for the historical gap)

**Recommendation: Option C for Phase 1.** The backfill will contain mostly current IDs (only recently-reordered items will have old IDs). The critical fix is that *going forward*, new changes are recorded with the correct ID at time of sale, and the immutable record prevents future corruption. For items reordered before backfill, the old velocity data is already wrong — we can't fix the past, but we stop the bleeding.

**Future improvement**: If Square ever exposes a variation ID history/mapping API, we could retroactively fix historical data.

---

## 7. Transition Plan

### Parallel Run Strategy

The old and new systems run simultaneously during transition. The `sales_velocity` table continues to be the single source of truth for all consumers until we explicitly cut over.

```
Timeline:
  [Phase 1]  inventory_changes table created, backfill runs
  [Phase 2]  Webhooks start populating inventory_changes
  [Phase 3]  New velocity recalc function added (writes to SAME sales_velocity table)
  [Phase 4]  Smart sync switches from Orders API to local recalc
  [Phase 5]  Old sync functions deprecated, order-based incremental disabled
```

### What Happens to Existing `sales_velocity` Data

1. **During Phase 1-2**: No change. Old data continues to be used by all consumers.
2. **During Phase 3**: New recalculation function writes to the same `sales_velocity` table using the same schema and UNIQUE constraint. Consumers don't know or care about the source.
3. **At Phase 4 cutover**: The next smart sync run uses the new recalculation. It does a DELETE + INSERT, replacing all rows with data derived from `inventory_changes`. This is a clean break.
4. **After cutover**: Old sync functions (`syncSalesVelocity`, `syncSalesVelocityAllPeriods`) remain in code but are no longer called. Remove in a cleanup pass.

### Consumer Impact

**Zero consumer changes required.** The `sales_velocity` table schema does not change. All 7 SQL reader locations (routes/analytics.js, routes/bundles.js, services/vendor-dashboard.js, services/catalog/inventory-service.js, services/catalog/audit-service.js, routes/sync.js) continue to query the same table with the same columns. The only change is where the data comes from.

### Rollback Plan

If the new system produces incorrect velocity data:
1. Re-enable the old `syncSalesVelocityAllPeriods()` in smart sync
2. Run a full sync (`POST /api/sync-sales`) to overwrite with Orders API data
3. Disable the new recalculation function
4. `inventory_changes` table remains (append-only, no harm in keeping it)

---

## 8. Gaps and Unknowns

### Must Answer Before Implementation

| # | Question | Impact | How to Resolve |
|---|----------|--------|----------------|
| 1 | **Does `total_price_money` reliably appear on SOLD adjustments?** | If not, revenue calculations need a fallback to `variations.price_money`. | Test with a few real API calls against JTPets' Square account. Fetch recent SOLD adjustments and check the field. |
| 2 | **How far back does JTPets' Square inventory history go?** | Determines if we can backfill a full 365 days. If Square only has 6 months, the 365d velocity will be incomplete initially. | Run a test backfill with no `occurred_at` filter and check the earliest `occurred_at` returned. |
| 3 | **Does Square's `BatchRetrieveInventoryChanges` accept `catalog_object_ids` that no longer exist (deleted/remapped)?** | If it silently drops them, we won't get historical data for remapped items even in the backfill. | Test with a known-remapped variation ID. |
| 4 | **What does the adjustment look like for a partial refund?** | Need to confirm that partial refunds create a `SOLD` -> `IN_STOCK` (or similar) adjustment with the partial quantity. | Check Square docs or test with a real partial refund. |
| 5 | **Are there edge cases where Square creates SOLD adjustments without a corresponding order?** (e.g., manual inventory adjustment moving items to SOLD state) | Could inflate velocity with non-sale events. | Filter on `source` field if available. For Phase 1, accept this as a minor inaccuracy. |

### Nice to Know (Non-Blocking)

| # | Question | Notes |
|---|----------|-------|
| 6 | What is the actual page size for `BatchRetrieveInventoryChanges`? | Docs suggest 1000. Verify with real calls. |
| 7 | Does the `source` field on adjustments distinguish POS sales from API-created adjustments? | Useful for filtering out manual adjustments from velocity. |
| 8 | Can we subscribe to a more specific webhook for inventory adjustments (not just count updates)? | Currently only `inventory.count.updated` is available. Square may add adjustment-specific webhooks in the future. |

---

## 9. Implementation Phases

### Phase 1: Schema + Backfill Service (no behavior changes)

**Dependencies**: None
**Risk**: Low (additive only — no existing behavior modified)

**Tasks**:
1. Create migration `database/migrations/XXX_inventory_changes.sql` with table + indexes
2. Add `inventory_changes_backfill_at` column to `merchants` table
3. Create `services/inventory-changes.js` service:
   - `backfillInventoryChanges(merchantId, options)` — paginated fetch from Square Changes API
   - `storeChanges(merchantId, changes)` — batch INSERT ... ON CONFLICT DO NOTHING
   - `getLatestChangeTime(merchantId)` — returns MAX(occurred_at) for gap detection
4. Create `routes/inventory-changes.js` with admin endpoint to trigger backfill
5. Run backfill for JTPets
6. **Validate**: Compare SOLD change counts against known order volumes. Check that `occurred_at` dates look correct. Spot-check a few variations.

**Tests**:
- `storeChanges()` deduplicates on `square_change_id`
- `backfillInventoryChanges()` handles pagination
- `backfillInventoryChanges()` handles empty results
- `backfillInventoryChanges()` respects rate limits (429 retry)

**Files created/modified**:
- `database/migrations/XXX_inventory_changes.sql` (new)
- `database/schema.sql` (add table definition)
- `services/inventory-changes.js` (new, <300 lines)
- `routes/inventory-changes.js` (new, <50 lines — admin backfill trigger)
- `server.js` (register new route)
- `__tests__/services/inventory-changes.test.js` (new)

---

### Phase 2: Webhook Integration (real-time capture)

**Dependencies**: Phase 1 complete (table exists, backfill service works)
**Risk**: Low-Medium (adds an API call per inventory webhook, but non-blocking)

**Tasks**:
1. Add `fetchRecentChanges(merchantId, catalogObjectId)` to `services/inventory-changes.js`
   - Calls `BatchRetrieveInventoryChanges` for the specific variation
   - Filters from `getLatestChangeTime()` for that variation
   - Stores new changes via `storeChanges()`
2. Modify `inventory-handler.js` `handleInventoryCountUpdated()`:
   - After existing `syncInventory()` call, add:
     ```javascript
     // Capture the inventory change details (what kind of change: sale, receive, etc.)
     await inventoryChangesService.fetchRecentChanges(merchantId, catalogObjectId);
     ```
   - This is non-blocking: if it fails, log and continue (inventory sync still works)
3. Add gap-fill job: `jobs/inventory-changes-gap-fill.js`
   - Runs daily (or every 6 hours)
   - For each merchant: fetch changes since `getLatestChangeTime()`
   - Catches any webhooks that were missed or failed
4. **Validate**: After 24-48 hours, compare `inventory_changes` row count growth against known transaction volumes. Check for gaps (missing hours).

**Tests**:
- `fetchRecentChanges()` stores new changes
- `fetchRecentChanges()` skips duplicates
- `handleInventoryCountUpdated()` continues if change fetch fails
- Gap-fill job finds and fills gaps

**Files modified**:
- `services/inventory-changes.js` (add fetchRecentChanges)
- `services/webhook-handlers/inventory-handler.js` (add change capture)
- `jobs/inventory-changes-gap-fill.js` (new)
- `__tests__/services/inventory-changes.test.js` (add tests)
- `__tests__/services/webhook-handlers.test.js` (update tests)

---

### Phase 3: New Velocity Recalculation (parallel mode)

**Dependencies**: Phase 2 complete (inventory_changes table actively populated)
**Risk**: Medium (new calculation logic, but writes to existing table — validation is critical)

**Tasks**:
1. Add `recalculateVelocityFromChanges(merchantId)` to `services/inventory-changes.js`
   - Implements the SQL aggregation query from Section 6
   - Handles net sales (SOLD transitions minus reverse-SOLD transitions)
   - Uses DELETE + INSERT for clean slate (wrapped in transaction)
   - Returns summary: `{ period91: count, period182: count, period365: count }`
2. Add validation endpoint: `POST /api/admin/velocity-compare`
   - Runs BOTH the old Orders API sync and the new inventory_changes recalculation
   - Compares results side-by-side
   - Returns differences: which variations differ, by how much
   - This is the key validation step before cutover
3. **Validate**: Run the comparison for JTPets. Analyze differences:
   - Differences from refund handling (new system is correct, old is wrong)
   - Differences from ID remapping (new system may be incomplete for old IDs)
   - Differences from revenue amounts (total_price_money vs order line item amounts)
   - Acceptable threshold: <5% difference on 91d velocity for items with >10 sales

**Tests**:
- `recalculateVelocityFromChanges()` produces correct daily/weekly/monthly averages
- `recalculateVelocityFromChanges()` handles zero-sale variations (no row created)
- `recalculateVelocityFromChanges()` handles refunds (net calculation)
- `recalculateVelocityFromChanges()` runs in a transaction (atomic)
- Comparison endpoint returns meaningful diffs

**Files modified**:
- `services/inventory-changes.js` (add recalculateVelocityFromChanges)
- `routes/inventory-changes.js` (add comparison endpoint)
- `__tests__/services/inventory-changes.test.js` (add tests)

---

### Phase 4: Cutover (switch source of truth)

**Dependencies**: Phase 3 complete + validation shows acceptable accuracy
**Risk**: Medium (changing the data source for a critical business function)

**Tasks**:
1. Modify smart sync (`routes/sync.js` / `services/square/api.js`):
   - Replace `syncSalesVelocityAllPeriods()` call with `recalculateVelocityFromChanges()`
   - Keep the old function available but not called (rollback path)
2. Disable `updateSalesVelocityFromOrder()` in order-handler.js:
   - Comment out the call sites in `handleOrderCreatedOrUpdated()` and `handleFulfillmentUpdated()`
   - The recalculation from changes handles this now
3. Update sync intervals:
   - Since recalculation is local (no API calls), can run more frequently
   - Suggested: 91d recalc every 1 hour, 182d every 6 hours, 365d every 24 hours
   - Or simplify: recalculate all periods every hour (it's just SQL)
4. Monitor for 1 week:
   - Compare velocity data against actual sales
   - Check reorder suggestions for reasonableness
   - Watch for any consumer errors (FK violations, NULL values)

**Files modified**:
- `routes/sync.js` (switch sync function)
- `services/square/api.js` (deprecation comments on old functions)
- `services/webhook-handlers/order-handler.js` (disable incremental velocity)
- `config/constants.js` or `.env` (new sync interval config)

---

### Phase 5: Cleanup + BACKLOG Closure

**Dependencies**: Phase 4 stable for 1+ weeks
**Risk**: Low

**Tasks**:
1. Remove or deprecate old velocity sync code:
   - Mark `syncSalesVelocity()` as deprecated (don't delete yet — useful for debugging)
   - Mark `syncSalesVelocityAllPeriods()` as deprecated
   - Mark `updateSalesVelocityFromOrder()` as deprecated
2. Close BACKLOG items:
   - BACKLOG-35: Resolved (refunds subtracted via from_state=SOLD query)
   - BACKLOG-36: Resolved (DELETE + INSERT eliminates phantom rows)
   - BACKLOG-34: Partially mitigated (ID remapping no longer corrupts *future* data)
3. Update documentation:
   - CLAUDE.md backlog section
   - ARCHITECTURE.md (new data flow diagram)
   - TECHNICAL_DEBT.md (velocity section)
4. Consider: add inventory changes to the frontend history view (bonus feature)
5. Consider: use `inventory_changes` for stock receive tracking (visibility into when shipments arrived)

---

## Appendix A: Square Inventory State Transitions Reference

| Transition | Meaning | Used for Velocity? |
|-----------|---------|-------------------|
| `IN_STOCK` -> `SOLD` | Regular sale | **Yes** (positive) |
| `SOLD` -> `IN_STOCK` | Refund/return to stock | **Yes** (negative — deducts from sales) |
| `NONE` -> `IN_STOCK` | Initial stock or receive | No (receive, not sale) |
| `IN_STOCK` -> `WASTE` | Damaged/expired | No |
| `IN_STOCK` -> `UNLINKED_RETURN` | Return without matching sale | No |
| `NONE` -> `SOLD` | Oversell (sold more than tracked) | **Yes** (positive) |
| Physical count | Recount/correction | No |

## Appendix B: All Consumers of sales_velocity (unchanged by this refactor)

| Consumer | File:Line | Fields Used |
|----------|-----------|-------------|
| Reorder suggestions SQL | `routes/analytics.js:243-276` | `daily_avg_quantity`, `weekly_avg_quantity` (91d, 182d, 365d) |
| Bundle velocity | `routes/analytics.js:537-542` | `daily_avg_quantity` (91d) |
| Sales velocity page | `routes/analytics.js:47-87` | All fields |
| Bundle availability | `routes/bundles.js:135-147` | `daily_avg_quantity` (91d) |
| Sync status check | `routes/sync.js:279-282` | `COUNT(*)` where `total_quantity_sold > 0` |
| Inventory status | `services/catalog/inventory-service.js:92-96` | `daily_avg_quantity` (91d, 182d, 365d) |
| Catalog audit | `services/catalog/audit-service.js:115-117` | `daily_avg_quantity` (91d, 182d, 365d) |
| Vendor dashboard | `services/vendor-dashboard.js:120-122` | `daily_avg_quantity` (91d) |
| Frontend: sales-velocity.js | `public/js/sales-velocity.js:58` | All fields via API |
| Frontend: reorder.js | `public/js/reorder.js` | velocity columns via API |

**None of these need to change.** They all read from `sales_velocity` which continues to exist with the same schema.
