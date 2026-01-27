# API Caching Strategy: Order Data Persistence & Incremental Sync

**Created**: 2026-01-27
**Status**: PLANNING
**Priority**: HIGH (Cost Reduction)

---

## Executive Summary

### The Problem
Every sales velocity sync fetches ALL orders for the entire period from Square API:

| Period | Orders (20/day avg) | API Calls (50/page) | Frequency | Weekly API Calls |
|--------|---------------------|---------------------|-----------|------------------|
| 91 days | 1,820 | 37 | Every 3h (8x/day) | **2,072** |
| 182 days | 3,640 | 73 | Every 24h | **511** |
| 365 days | 7,300 | 146 | Every 168h | **146** |
| **Total** | - | - | - | **~2,729/week** |

With tiered optimization (fetching 365d covers all periods), this is reduced to ~1,200/week but still fetches the same orders repeatedly.

### The Solution
Store order data locally and only fetch **new orders since last sync**:

| Strategy | API Calls/Week | Reduction |
|----------|----------------|-----------|
| Current (tiered) | ~1,200 | baseline |
| With caching | ~50-100 | **90-95%** |

After initial backfill, daily syncs only fetch orders from the last 3-24 hours.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CURRENT FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Smart Sync Timer ──► Fetch ALL orders (91/182/365 days) ──► Calculate      │
│        │                      │                              Velocity        │
│        │                      │                                              │
│        │                      ▼                                              │
│        │            Square API: POST /v2/orders/search                       │
│        │            (37-146 API calls per sync)                              │
│        │                      │                                              │
│        │                      ▼                                              │
│        │            Process orders in memory ──► Discard raw data            │
│        │                      │                                              │
│        │                      ▼                                              │
│        │            Write aggregates to sales_velocity table                 │
│        │                                                                     │
│  Webhook ───────────► Fetch full order ───────────► Process for loyalty/     │
│  (order.created)      GET /orders/{id}              delivery                 │
│                       (1 API call each)                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           PROPOSED FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Webhook ───────────► Store order in order_cache ───► Update velocity       │
│  (order.created)      (no additional API call)        incrementally          │
│        │                      │                                              │
│        │                      ▼                                              │
│        │              order_cache table                                      │
│        │              (append-only, 400 days TTL)                            │
│        │                      │                                              │
│        │                      ▼                                              │
│  Smart Sync ──────────► Query local order_cache ──► Update velocity         │
│  (backup)               for any date range          (no API calls!)          │
│        │                      │                                              │
│        │                      │                                              │
│  Reconciliation ──────► Fetch only since last_synced_at ──► Backfill gaps   │
│  (daily)                (1-5 API calls max)                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Order Cache Table Design

### 1.1 Core Schema

```sql
-- Migration: 029_order_cache.sql

-- Order cache for reducing Square API calls
-- Stores minimal order data needed for sales velocity and loyalty processing
CREATE TABLE order_cache (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),

    -- Square identifiers
    square_order_id TEXT NOT NULL,
    square_location_id TEXT NOT NULL,
    square_customer_id TEXT,  -- nullable for guest orders

    -- Order metadata
    order_state TEXT NOT NULL,  -- COMPLETED, CANCELED, etc.
    closed_at TIMESTAMPTZ NOT NULL,  -- Primary date for queries
    created_at_square TIMESTAMPTZ NOT NULL,  -- Square's created_at

    -- Totals (for potential future analytics)
    total_money_cents INTEGER,
    total_tax_cents INTEGER,
    total_discount_cents INTEGER,

    -- Source tracking
    source TEXT NOT NULL DEFAULT 'api',  -- 'api', 'webhook', 'backfill'
    source_event_id TEXT,  -- webhook event_id if from webhook

    -- Line items stored as JSONB for flexibility
    -- Structure: [{ variation_id, quantity, unit_price_cents, name }]
    line_items JSONB NOT NULL DEFAULT '[]',

    -- Sync metadata
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_order JSONB,  -- Optional: store full order for debugging (can be null to save space)

    -- Multi-tenant constraint
    UNIQUE(merchant_id, square_order_id)
);

-- Performance indexes
CREATE INDEX idx_order_cache_merchant_closed
    ON order_cache(merchant_id, closed_at DESC);

CREATE INDEX idx_order_cache_merchant_state_closed
    ON order_cache(merchant_id, order_state, closed_at DESC)
    WHERE order_state = 'COMPLETED';

CREATE INDEX idx_order_cache_merchant_location
    ON order_cache(merchant_id, square_location_id, closed_at DESC);

CREATE INDEX idx_order_cache_customer
    ON order_cache(merchant_id, square_customer_id)
    WHERE square_customer_id IS NOT NULL;

-- Sync tracking: last successful sync per merchant
CREATE TABLE order_sync_cursor (
    merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id),
    last_synced_at TIMESTAMPTZ NOT NULL,  -- Fetch orders newer than this
    last_sync_order_count INTEGER DEFAULT 0,
    last_sync_api_calls INTEGER DEFAULT 0,
    last_full_reconciliation TIMESTAMPTZ,  -- Last time we did full 365d verify
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comment for documentation
COMMENT ON TABLE order_cache IS 'Local cache of Square orders for reducing API calls. Orders older than 400 days can be purged.';
COMMENT ON COLUMN order_cache.source IS 'How this order was obtained: api (sync), webhook (real-time), backfill (reconciliation)';
```

### 1.2 Line Items Structure

```javascript
// Stored in line_items JSONB column
[
    {
        "variation_id": "ABC123",        // Square catalog_object_id
        "item_id": "ITEM456",            // Parent item ID (optional)
        "quantity": 2,
        "unit_price_cents": 1999,
        "total_money_cents": 3998,
        "name": "Premium Dog Food 30lb"  // For human readability
    },
    // ... more line items
]
```

### 1.3 Storage Estimates

| Metric | Value | Notes |
|--------|-------|-------|
| Orders/day | 20 | Conservative estimate |
| Orders/year | 7,300 | Per merchant |
| Avg line items/order | 3 | |
| Row size (no raw_order) | ~500 bytes | |
| Row size (with raw_order) | ~2KB | |
| Annual storage/merchant | 3.5-14 MB | Depends on raw_order |
| 10 merchants × 2 years | 70-280 MB | Very manageable |

**Recommendation**: Store `raw_order` for first 90 days, then set to NULL to save space.

---

## Phase 2: Incremental Sync Implementation

### 2.1 Webhook-First Strategy

The primary source of new orders should be webhooks - they're already being received.

```javascript
// services/webhook-handlers/order-handler.js

async function handleOrderCreatedOrUpdated(event, merchantId) {
    const order = event.data.object.order;

    // Skip if not completed
    if (order.state !== 'COMPLETED') {
        return { action: 'skipped', reason: 'not_completed' };
    }

    // Cache the order (upsert)
    await cacheOrder(merchantId, order, 'webhook', event.event_id);

    // Update incremental sales velocity
    if (order.state === 'COMPLETED' && order.closed_at) {
        await updateSalesVelocityIncremental(merchantId, order);
    }

    // Existing loyalty/delivery processing...
    // NOTE: No need to fetch full order - webhook has all data!
}

async function cacheOrder(merchantId, order, source, sourceEventId = null) {
    const lineItems = (order.line_items || []).map(li => ({
        variation_id: li.catalog_object_id,
        item_id: li.catalog_version,
        quantity: parseFloat(li.quantity),
        unit_price_cents: parseInt(li.base_price_money?.amount || 0),
        total_money_cents: parseInt(li.total_money?.amount || 0),
        name: li.name
    }));

    await db.query(`
        INSERT INTO order_cache (
            merchant_id, square_order_id, square_location_id, square_customer_id,
            order_state, closed_at, created_at_square,
            total_money_cents, total_tax_cents, total_discount_cents,
            source, source_event_id, line_items, raw_order
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (merchant_id, square_order_id) DO UPDATE SET
            order_state = EXCLUDED.order_state,
            closed_at = EXCLUDED.closed_at,
            total_money_cents = EXCLUDED.total_money_cents,
            total_tax_cents = EXCLUDED.total_tax_cents,
            total_discount_cents = EXCLUDED.total_discount_cents,
            line_items = EXCLUDED.line_items,
            raw_order = COALESCE(EXCLUDED.raw_order, order_cache.raw_order),
            cached_at = NOW()
    `, [
        merchantId,
        order.id,
        order.location_id,
        order.customer_id,
        order.state,
        order.closed_at,
        order.created_at,
        parseInt(order.total_money?.amount || 0),
        parseInt(order.total_tax_money?.amount || 0),
        parseInt(order.total_discount_money?.amount || 0),
        source,
        sourceEventId,
        JSON.stringify(lineItems),
        JSON.stringify(order)  // Store raw for debugging
    ]);
}
```

### 2.2 Incremental Sales Velocity Update

Instead of recalculating everything, update aggregates incrementally:

```javascript
// services/square/api.js - new function

async function updateSalesVelocityIncremental(merchantId, order) {
    const orderDate = new Date(order.closed_at);
    const now = new Date();

    // Determine which periods this order affects
    const affectedPeriods = [];
    if (daysBetween(orderDate, now) <= 91) affectedPeriods.push(91);
    if (daysBetween(orderDate, now) <= 182) affectedPeriods.push(182);
    if (daysBetween(orderDate, now) <= 365) affectedPeriods.push(365);

    if (affectedPeriods.length === 0) return;

    // Process each line item
    for (const lineItem of order.line_items || []) {
        const variationId = lineItem.catalog_object_id;
        const locationId = order.location_id;
        const quantity = parseFloat(lineItem.quantity) || 0;
        const revenue = parseInt(lineItem.total_money?.amount) || 0;

        if (!variationId || !locationId) continue;

        for (const periodDays of affectedPeriods) {
            await db.query(`
                INSERT INTO sales_velocity (
                    variation_id, location_id, period_days, merchant_id,
                    total_quantity_sold, total_revenue_cents,
                    period_start_date, period_end_date,
                    daily_avg_quantity, daily_avg_revenue_cents,
                    weekly_avg_quantity, monthly_avg_quantity,
                    updated_at
                ) VALUES (
                    $1, $2, $3, $4,
                    $5, $6,
                    NOW() - INTERVAL '1 day' * $3, NOW(),
                    $5 / $3::decimal, $6 / $3::decimal,
                    $5 / ($3 / 7.0), $5 / ($3 / 30.0),
                    NOW()
                )
                ON CONFLICT (variation_id, location_id, period_days, merchant_id)
                DO UPDATE SET
                    total_quantity_sold = sales_velocity.total_quantity_sold + $5,
                    total_revenue_cents = sales_velocity.total_revenue_cents + $6,
                    daily_avg_quantity = (sales_velocity.total_quantity_sold + $5) / $3::decimal,
                    daily_avg_revenue_cents = (sales_velocity.total_revenue_cents + $6) / $3::decimal,
                    weekly_avg_quantity = (sales_velocity.total_quantity_sold + $5) / ($3 / 7.0),
                    monthly_avg_quantity = (sales_velocity.total_quantity_sold + $5) / ($3 / 30.0),
                    updated_at = NOW()
            `, [variationId, locationId, periodDays, merchantId, quantity, revenue]);
        }
    }
}
```

### 2.3 Catch-Up Sync (Gap Fill)

For orders that might be missed by webhooks (webhook failures, downtime):

```javascript
// services/square/api.js - new function

async function syncOrdersIncremental(merchantId) {
    const squareClient = await getSquareClientForMerchant(merchantId);

    // Get last sync cursor
    const cursorResult = await db.query(
        'SELECT last_synced_at FROM order_sync_cursor WHERE merchant_id = $1',
        [merchantId]
    );

    // Default to 24 hours ago if no cursor (first run after migration)
    const lastSyncedAt = cursorResult.rows[0]?.last_synced_at
        || new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Fetch only orders since last sync
    // Add 1 minute buffer to avoid edge cases
    const startDate = new Date(lastSyncedAt.getTime() - 60000).toISOString();

    let cursor = null;
    let ordersProcessed = 0;
    let apiCalls = 0;
    let newOrdersCached = 0;

    do {
        const requestBody = {
            location_ids: await getActiveLocationIds(merchantId),
            query: {
                filter: {
                    state_filter: { states: ['COMPLETED'] },
                    date_time_filter: {
                        closed_at: {
                            start_at: startDate
                        }
                    }
                },
                sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' }
            },
            limit: 50
        };

        if (cursor) requestBody.cursor = cursor;

        const data = await makeSquareRequest('/v2/orders/search', {
            method: 'POST',
            body: JSON.stringify(requestBody),
            accessToken: squareClient.accessToken
        });
        apiCalls++;

        for (const order of data.orders || []) {
            // Check if we already have this order
            const existing = await db.query(
                'SELECT 1 FROM order_cache WHERE merchant_id = $1 AND square_order_id = $2',
                [merchantId, order.id]
            );

            if (existing.rows.length === 0) {
                await cacheOrder(merchantId, order, 'api');
                await updateSalesVelocityIncremental(merchantId, order);
                newOrdersCached++;
            }

            ordersProcessed++;
        }

        cursor = data.cursor;
    } while (cursor);

    // Update cursor
    await db.query(`
        INSERT INTO order_sync_cursor (merchant_id, last_synced_at, last_sync_order_count, last_sync_api_calls, updated_at)
        VALUES ($1, NOW(), $2, $3, NOW())
        ON CONFLICT (merchant_id) DO UPDATE SET
            last_synced_at = NOW(),
            last_sync_order_count = $2,
            last_sync_api_calls = $3,
            updated_at = NOW()
    `, [merchantId, ordersProcessed, apiCalls]);

    logger.info('Incremental order sync complete', {
        merchantId,
        ordersProcessed,
        newOrdersCached,
        apiCalls,
        syncedFrom: startDate
    });

    return { ordersProcessed, newOrdersCached, apiCalls };
}
```

---

## Phase 3: Full Reconciliation (Weekly Validation)

Even with webhooks + incremental sync, we need periodic validation:

### 3.1 Reconciliation Strategy

```javascript
// services/order-cache/reconciliation.js

async function reconcileOrderCache(merchantId, periodDays = 365) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Step 1: Get order counts from Square
    const squareCount = await getSquareOrderCount(merchantId, startDate);

    // Step 2: Get order count from local cache
    const localCount = await db.query(`
        SELECT COUNT(*) as count
        FROM order_cache
        WHERE merchant_id = $1
          AND closed_at >= $2
          AND order_state = 'COMPLETED'
    `, [merchantId, startDate]);

    const discrepancy = squareCount - parseInt(localCount.rows[0].count);

    logger.info('Order cache reconciliation check', {
        merchantId,
        periodDays,
        squareCount,
        localCount: localCount.rows[0].count,
        discrepancy
    });

    // Step 3: If significant discrepancy, trigger full backfill
    const discrepancyThreshold = Math.max(10, squareCount * 0.01); // 1% or 10

    if (Math.abs(discrepancy) > discrepancyThreshold) {
        logger.warn('Order cache discrepancy detected, triggering backfill', {
            merchantId,
            discrepancy,
            threshold: discrepancyThreshold
        });

        return await fullBackfill(merchantId, periodDays);
    }

    // Step 4: Update reconciliation timestamp
    await db.query(`
        UPDATE order_sync_cursor
        SET last_full_reconciliation = NOW()
        WHERE merchant_id = $1
    `, [merchantId]);

    return { status: 'ok', discrepancy };
}

async function fullBackfill(merchantId, periodDays) {
    // This is the expensive operation - only run when needed
    // Fetches ALL orders for period and upserts into cache

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    let cursor = null;
    let ordersProcessed = 0;
    let apiCalls = 0;

    do {
        const data = await fetchOrdersPage(merchantId, startDate, cursor);
        apiCalls++;

        for (const order of data.orders || []) {
            await cacheOrder(merchantId, order, 'backfill');
            ordersProcessed++;
        }

        cursor = data.cursor;

        // Progress logging
        if (ordersProcessed % 500 === 0) {
            logger.info('Backfill progress', { merchantId, ordersProcessed, apiCalls });
        }
    } while (cursor);

    // After backfill, recalculate sales velocity from cache
    await recalculateSalesVelocityFromCache(merchantId);

    return { ordersProcessed, apiCalls };
}
```

### 3.2 Sales Velocity from Cache

New function to calculate sales velocity entirely from local cache:

```javascript
// services/square/api.js

async function calculateSalesVelocityFromCache(merchantId, periodDays) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Single database query replaces 50+ API calls
    const result = await db.query(`
        WITH line_item_sales AS (
            SELECT
                li->>'variation_id' as variation_id,
                oc.square_location_id as location_id,
                SUM((li->>'quantity')::decimal) as total_quantity,
                SUM((li->>'total_money_cents')::integer) as total_revenue
            FROM order_cache oc,
                 jsonb_array_elements(oc.line_items) as li
            WHERE oc.merchant_id = $1
              AND oc.closed_at >= $2
              AND oc.order_state = 'COMPLETED'
              AND li->>'variation_id' IS NOT NULL
            GROUP BY li->>'variation_id', oc.square_location_id
        )
        SELECT
            variation_id,
            location_id,
            total_quantity,
            total_revenue,
            total_quantity / $3::decimal as daily_avg_quantity,
            total_revenue / $3::decimal as daily_avg_revenue,
            total_quantity / ($3 / 7.0) as weekly_avg,
            total_quantity / ($3 / 30.0) as monthly_avg
        FROM line_item_sales
        WHERE variation_id IS NOT NULL
    `, [merchantId, startDate, periodDays]);

    // Upsert into sales_velocity
    for (const row of result.rows) {
        await db.query(`
            INSERT INTO sales_velocity (
                variation_id, location_id, period_days, merchant_id,
                total_quantity_sold, total_revenue_cents,
                period_start_date, period_end_date,
                daily_avg_quantity, daily_avg_revenue_cents,
                weekly_avg_quantity, monthly_avg_quantity,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, NOW())
            ON CONFLICT (variation_id, location_id, period_days, merchant_id)
            DO UPDATE SET
                total_quantity_sold = $5,
                total_revenue_cents = $6,
                period_start_date = $7,
                period_end_date = NOW(),
                daily_avg_quantity = $8,
                daily_avg_revenue_cents = $9,
                weekly_avg_quantity = $10,
                monthly_avg_quantity = $11,
                updated_at = NOW()
        `, [
            row.variation_id, row.location_id, periodDays, merchantId,
            row.total_quantity, row.total_revenue,
            startDate,
            row.daily_avg_quantity, row.daily_avg_revenue,
            row.weekly_avg, row.monthly_avg
        ]);
    }

    return result.rows.length;
}
```

---

## Phase 4: Handling Edge Cases

### 4.1 Order Updates and Cancellations

Orders can be modified after creation (refunds, cancellations):

```javascript
// services/webhook-handlers/order-handler.js

async function handleOrderUpdated(event, merchantId) {
    const order = event.data.object.order;

    // Get previous state from cache
    const previous = await db.query(
        'SELECT order_state, line_items FROM order_cache WHERE merchant_id = $1 AND square_order_id = $2',
        [merchantId, order.id]
    );

    const wasCompleted = previous.rows[0]?.order_state === 'COMPLETED';
    const isCompleted = order.state === 'COMPLETED';

    // Update cache
    await cacheOrder(merchantId, order, 'webhook', event.event_id);

    // Handle state transitions
    if (wasCompleted && !isCompleted) {
        // Order was un-completed (rare but possible) - subtract from velocity
        await reverseSalesVelocityForOrder(merchantId, previous.rows[0]);
    } else if (!wasCompleted && isCompleted) {
        // Order newly completed - add to velocity
        await updateSalesVelocityIncremental(merchantId, order);
    } else if (wasCompleted && isCompleted) {
        // Order modified while completed - need to diff line items
        await reconcileSalesVelocityForOrderUpdate(merchantId, previous.rows[0], order);
    }
}

async function handleRefund(event, merchantId) {
    const refund = event.data.object.refund;
    const orderId = refund.order_id;

    // For partial refunds, we need to update the cached order
    // Full order fetch may be needed here since refund webhook doesn't include full order
    const fullOrder = await fetchOrderFromSquare(merchantId, orderId);
    await cacheOrder(merchantId, fullOrder, 'webhook', event.event_id);

    // Recalculate velocity for this order's items
    // (complex: need to track original quantities vs refunded quantities)
}
```

### 4.2 Timezone Handling

Sales velocity periods must use merchant's timezone:

```javascript
// services/order-cache/utils.js

function getPeriodBoundary(merchantId, periodDays) {
    // Get merchant timezone (default America/Toronto per CLAUDE.md)
    const timezone = getMerchantTimezone(merchantId) || 'America/Toronto';

    // Calculate start of day in merchant's timezone, then go back periodDays
    const now = moment().tz(timezone);
    const startOfToday = now.clone().startOf('day');
    const periodStart = startOfToday.subtract(periodDays - 1, 'days');

    return periodStart.toDate();
}
```

### 4.3 Multi-Location Aggregation

Some features need cross-location totals:

```javascript
// Already handled by grouping in SQL queries
// The cache stores location_id per order, aggregation happens at query time
```

---

## Phase 5: Migration Plan

### 5.1 Phased Rollout

| Phase | Duration | Description | Risk |
|-------|----------|-------------|------|
| 0 | Day 1 | Deploy migration, create tables | None |
| 1 | Week 1 | Backfill cache, keep old sync | None |
| 2 | Week 2 | Enable webhook caching (shadow) | Low |
| 3 | Week 3 | Switch to cache-based velocity | Medium |
| 4 | Week 4 | Disable old full-sync | Low |

### 5.2 Migration Script

```sql
-- database/migrations/029_order_cache.sql

-- Phase 0: Create tables (run immediately)
BEGIN;

-- Tables as defined in Phase 1...

-- Feature flag (defaults to old behavior)
INSERT INTO feature_flags (key, value, description)
VALUES ('USE_ORDER_CACHE', 'false', 'Use local order cache instead of Square API for sales velocity')
ON CONFLICT (key) DO NOTHING;

COMMIT;
```

### 5.3 Backfill Script

```javascript
// scripts/backfill-order-cache.js
// Run once after migration to populate initial cache

async function backfillAllMerchants() {
    const merchants = await db.query(
        'SELECT id FROM merchants WHERE active = true'
    );

    for (const merchant of merchants.rows) {
        console.log(`Backfilling merchant ${merchant.id}...`);

        try {
            // Fetch 400 days to cover 365-day period plus buffer
            const result = await fullBackfill(merchant.id, 400);

            console.log(`  Merchant ${merchant.id}: ${result.ordersProcessed} orders, ${result.apiCalls} API calls`);

            // Rate limit: wait 2 seconds between merchants
            await sleep(2000);
        } catch (error) {
            console.error(`  Merchant ${merchant.id} failed:`, error.message);
        }
    }
}
```

### 5.4 Feature Flag Integration

```javascript
// services/square/api.js

async function syncSalesVelocityAllPeriods(merchantId, maxPeriod) {
    const useCache = await getFeatureFlag('USE_ORDER_CACHE', merchantId);

    if (useCache) {
        // New path: calculate from local cache
        return await calculateSalesVelocityFromCacheAllPeriods(merchantId, maxPeriod);
    } else {
        // Old path: fetch from Square API
        return await syncSalesVelocityAllPeriodsFromApi(merchantId, maxPeriod);
    }
}
```

---

## Phase 6: Monitoring & Observability

### 6.1 Key Metrics

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| `order_cache.sync_lag_seconds` | `NOW() - last_synced_at` | > 3600 (1 hour) |
| `order_cache.discrepancy_percent` | Reconciliation | > 5% |
| `order_cache.api_calls_daily` | Counter | > 500 (indicates cache miss) |
| `order_cache.cache_hit_rate` | Counter | < 90% |
| `sales_velocity.calculation_source` | Tag: cache/api | < 95% cache |

### 6.2 Logging

```javascript
// Add structured logging for cache operations
logger.info('Order cached', {
    merchantId,
    orderId: order.id,
    source: 'webhook',  // or 'api', 'backfill'
    cacheHit: false,
    processingTimeMs: elapsed
});

logger.info('Sales velocity calculated', {
    merchantId,
    source: 'cache',  // or 'api'
    periodDays: 365,
    variationsUpdated: count,
    durationMs: elapsed
});
```

### 6.3 Dashboard Queries

```sql
-- API calls saved today (compare to baseline)
SELECT
    DATE(cached_at) as date,
    COUNT(*) as orders_from_cache,
    COUNT(*) * 0.02 as estimated_api_calls_saved  -- 1 order ≈ 0.02 API calls
FROM order_cache
WHERE cached_at >= CURRENT_DATE
GROUP BY DATE(cached_at);

-- Cache freshness by merchant
SELECT
    m.name,
    osc.last_synced_at,
    EXTRACT(EPOCH FROM NOW() - osc.last_synced_at) / 60 as minutes_stale,
    osc.last_sync_order_count
FROM order_sync_cursor osc
JOIN merchants m ON m.id = osc.merchant_id
ORDER BY minutes_stale DESC;

-- Discrepancy detection
SELECT
    oc.merchant_id,
    COUNT(*) as cached_orders,
    sv.expected_orders,
    ABS(COUNT(*) - sv.expected_orders) as discrepancy
FROM order_cache oc
LEFT JOIN (
    SELECT merchant_id, SUM(total_quantity_sold) as expected_orders
    FROM sales_velocity
    WHERE period_days = 365
    GROUP BY merchant_id
) sv ON sv.merchant_id = oc.merchant_id
WHERE oc.closed_at >= NOW() - INTERVAL '365 days'
GROUP BY oc.merchant_id, sv.expected_orders;
```

---

## Phase 7: Data Lifecycle & Cleanup

### 7.1 Retention Policy

| Data | Retention | Rationale |
|------|-----------|-----------|
| `order_cache` rows | 400 days | Covers 365-day period + buffer |
| `raw_order` column | 90 days | Full data for recent orders, NULL for older |
| `sales_velocity` | Indefinite | Small, valuable aggregates |
| `order_sync_cursor` | Indefinite | Single row per merchant |

### 7.2 Cleanup Job

```javascript
// jobs/order-cache-cleanup.js

async function cleanupOrderCache() {
    const retentionDays = 400;

    // Delete orders older than retention period
    const deleted = await db.query(`
        DELETE FROM order_cache
        WHERE closed_at < NOW() - INTERVAL '1 day' * $1
        RETURNING id
    `, [retentionDays]);

    logger.info('Order cache cleanup complete', {
        deletedRows: deleted.rowCount,
        retentionDays
    });

    // Clear raw_order for orders older than 90 days
    const cleared = await db.query(`
        UPDATE order_cache
        SET raw_order = NULL
        WHERE closed_at < NOW() - INTERVAL '90 days'
          AND raw_order IS NOT NULL
        RETURNING id
    `);

    logger.info('Raw order data cleared', {
        clearedRows: cleared.rowCount
    });
}

// Schedule: Run daily at 3 AM
cron.schedule('0 3 * * *', cleanupOrderCache);
```

---

## Implementation Checklist

### Database

- [ ] Create migration `029_order_cache.sql`
- [ ] Run migration on dev/staging
- [ ] Run backfill script
- [ ] Verify data integrity

### Backend Services

- [ ] Create `services/order-cache/` module
  - [ ] `cache-service.js` - CRUD operations
  - [ ] `reconciliation.js` - validation logic
  - [ ] `utils.js` - helpers
- [ ] Update `services/webhook-handlers/order-handler.js`
  - [ ] Cache orders on webhook
  - [ ] Remove redundant `fetchFullOrder` call
- [ ] Update `services/square/api.js`
  - [ ] Add `calculateSalesVelocityFromCache()`
  - [ ] Add feature flag check
  - [ ] Keep old functions as fallback

### Sync Flow

- [ ] Update `routes/sync.js` smart sync
- [ ] Add incremental sync option
- [ ] Add reconciliation to weekly sync
- [ ] Update sync-status endpoint

### Jobs

- [ ] Create `jobs/order-cache-cleanup.js`
- [ ] Add to cron scheduler
- [ ] Add reconciliation to weekly job

### Testing

- [ ] Unit tests for cache service
- [ ] Integration tests for webhook→cache flow
- [ ] Performance comparison (API vs cache)
- [ ] Reconciliation accuracy tests

### Monitoring

- [ ] Add Prometheus metrics
- [ ] Create Grafana dashboard
- [ ] Set up alerts

---

## Rollback Plan

If issues are discovered after enabling cache:

1. **Immediate**: Set feature flag `USE_ORDER_CACHE=false`
2. **Verify**: Old sync path resumes automatically
3. **Investigate**: Check logs for cache-related errors
4. **Fix**: Address issues while old sync continues
5. **Re-enable**: Set `USE_ORDER_CACHE=true` after fix

The cache is additive - old code paths remain functional, just unused when cache is enabled.

---

## Expected Results

### API Call Reduction

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| 91-day sync (8x/day) | 2,072/week | 0 | 100% |
| 182-day sync (7x/week) | 511/week | 0 | 100% |
| 365-day sync (1x/week) | 146/week | 0 | 100% |
| Webhook order fetches | ~700/week | 0 | 100% |
| Incremental catch-up | 0 | ~50/week | N/A |
| Weekly reconciliation | 0 | ~150/week | N/A |
| **Total** | **~3,429/week** | **~200/week** | **94%** |

### Cost Impact

- Square API is free, but rate limits apply (30 req/sec)
- Reduced risk of hitting rate limits during peak
- Faster sync operations (local DB vs API latency)
- Lower network bandwidth usage

### Performance Improvement

| Operation | Before | After |
|-----------|--------|-------|
| 365-day sales velocity | 30-60 seconds | 2-5 seconds |
| 91-day sales velocity | 10-20 seconds | <1 second |
| Smart sync total | 2-5 minutes | 10-30 seconds |

---

## Questions for Review

1. **Storage**: Should we store `raw_order` at all, or just extracted fields?
2. **Reconciliation frequency**: Weekly is proposed - should it be daily?
3. **Backfill strategy**: Run during off-hours? Throttle per merchant?
4. **Multi-instance**: With P3 scalability, should order_cache sync across Redis?
5. **Historical data**: Should we backfill beyond 400 days for historical analysis?
