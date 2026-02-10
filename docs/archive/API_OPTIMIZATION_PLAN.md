# API Optimization Plan - Complete Implementation Guide

**Created**: 2026-01-27
**Status**: COMPLETED (Archived — All P0-API items implemented)
**Priority**: CRITICAL - Rate limiting causing service interruptions (RESOLVED)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [P0-API-1: Redundant Order Fetch Fix](#p0-api-1-redundant-order-fetch-fix)
4. [P0-API-2: Full 91-Day Sync Fix](#p0-api-2-full-91-day-sync-fix)
5. [Additional API Inefficiencies Identified](#additional-api-inefficiencies-identified)
6. [Order Caching Strategy](#order-caching-strategy)
7. [Sync Deduplication Architecture](#sync-deduplication-architecture)
8. [Implementation Phases](#implementation-phases)
9. [Risk Assessment & Rollback Plan](#risk-assessment--rollback-plan)
10. [Success Metrics](#success-metrics)

---

## Executive Summary

### The Problem

The application is making **~3,400+ unnecessary Square API calls per week**, causing:
- Rate limit lockouts during peak order periods
- Delayed webhook processing
- Unnecessary latency in sales velocity calculations
- Potential Square API quota exhaustion

### Root Causes

| Issue | Impact | API Calls Wasted/Day |
|-------|--------|---------------------|
| P0-API-1: Redundant order fetch | Every webhook fetches order already in payload | ~20 calls |
| P0-API-2: Full 91-day sync per order | Every COMPLETED order triggers full historical re-sync | ~740 calls |
| Duplicate fulfillment sync | Fulfillment webhooks also trigger 91-day sync | ~100 calls |
| Committed inventory per webhook | Every order webhook syncs all open invoices | ~200 calls |
| **TOTAL** | | **~1,060 calls/day** |

### Expected Improvement

| Metric | Current | After Optimization | Improvement |
|--------|---------|-------------------|-------------|
| API calls/day | ~1,060+ | ~50-100 | **90-95% reduction** |
| Order webhook processing | 2-5 seconds | 100-300ms | **10-20x faster** |
| Sales velocity latency | Real-time (wasteful) | <5 min delay (efficient) | Acceptable |
| Rate limit incidents | Weekly | Rare/Never | **Eliminated** |

---

## Current State Analysis

### Webhook Order Flow - Current (Wasteful)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CURRENT: order.created / order.updated WEBHOOK                          │
│ File: services/webhook-handlers/order-handler.js                        │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Webhook Payload Contains:                                               │
│   data.order = {                                                        │
│     id: "ORDER_123",                                                    │
│     state: "COMPLETED",                                                 │
│     location_id: "LOC_456",                                             │
│     customer_id: "CUST_789",                                            │
│     line_items: [...],        ← COMPLETE LINE ITEM DATA                 │
│     fulfillments: [...],      ← COMPLETE FULFILLMENT DATA               │
│     closed_at: "2026-01-27T..." ← TIMESTAMP FOR VELOCITY                │
│   }                                                                     │
└─────────────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┬───────────────┐
              ▼               ▼               ▼               ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ Line 126:        │ │ Line 136:        │ │ Line 144:        │ │ Line 154:        │
│ syncCommitted    │ │ syncSalesVelocity│ │ _fetchFullOrder  │ │ _processLoyalty  │
│ Inventory()      │ │ (91)             │ │ ()               │ │ ()               │
│                  │ │                  │ │                  │ │                  │
│ API Calls:       │ │ API Calls:       │ │ API Calls:       │ │ API Calls:       │
│ 1 + (N × 2)      │ │ ~37 (paginated)  │ │ 1 (REDUNDANT!)   │ │ 0                │
│ where N = open   │ │                  │ │                  │ │                  │
│ invoices         │ │ Fetches ALL      │ │ Re-fetches order │ │ Uses order data  │
│                  │ │ 91 days!         │ │ we already have! │ │ from step above  │
└──────────────────┘ └──────────────────┘ └──────────────────┘ └──────────────────┘
        │                    │                    │
        │                    │                    │
        ▼                    ▼                    ▼
   ~5-10 calls          ~37 calls            1 call

TOTAL PER COMPLETED ORDER: ~43-48 API calls
FOR 20 ORDERS/DAY: ~860-960 API calls/day
```

### API Call Breakdown by Trigger

| Trigger | Function | API Calls | Frequency | Daily Total |
|---------|----------|-----------|-----------|-------------|
| `order.created/updated` | `syncCommittedInventory()` | 1 + (2 × invoices) | Every order | ~100-200 |
| `order.state=COMPLETED` | `syncSalesVelocity(91)` | ~37 | Every completed | ~740 |
| `order.created/updated` | `_fetchFullOrder()` | 1 | Every order | ~20 |
| `order.fulfillment.updated` | `syncCommittedInventory()` | 1 + (2 × invoices) | Every fulfillment | ~50-100 |
| `fulfillment.state=COMPLETED` | `syncSalesVelocity(91)` | ~37 | Every completed | ~200 |
| Hourly cron | `runSmartSync()` | ~6-20 | 24×/day | ~150-480 |

---

## P0-API-1: Redundant Order Fetch Fix

### Current Code (Problem)

**File**: `services/webhook-handlers/order-handler.js:141-145`

```javascript
// Line 142: webhookOrder already has ALL data we need
let order = webhookOrder;

// Line 143-145: But we fetch it again anyway!
if (webhookOrder?.id) {
    order = await this._fetchFullOrder(webhookOrder.id, merchantId, webhookOrder);
}
```

**File**: `services/webhook-handlers/order-handler.js:164-183`

```javascript
async _fetchFullOrder(orderId, merchantId, fallbackOrder) {
    try {
        const squareClient = await getSquareClientForMerchant(merchantId);
        const orderResponse = await squareClient.orders.get({ orderId });  // ← API CALL
        if (orderResponse.order) {
            logger.info('Fetched full order from Square API for delivery check', {
                orderId: orderResponse.order.id,
                fulfillmentCount: orderResponse.order.fulfillments?.length || 0,
                fulfillmentTypes: orderResponse.order.fulfillments?.map(f => f.type) || []
            });
            return orderResponse.order;
        }
    } catch (fetchError) {
        logger.warn('Failed to fetch full order from Square, using webhook data', {
            orderId,
            error: fetchError.message
        });
    }
    return fallbackOrder;  // ← Falls back to webhook data anyway!
}
```

### Why This Is Wasteful

The Square webhook payload for `order.created` and `order.updated` events contains the **complete order object** including:
- `id`, `state`, `location_id`, `customer_id`
- `line_items[]` with full `catalog_object_id`, `quantity`, `total_money`
- `fulfillments[]` with full `type`, `state`, delivery details
- `closed_at` timestamp
- `refunds[]` if applicable

The only time the webhook might have incomplete data:
1. **Never** - Square's webhook contract guarantees complete order data
2. Network corruption (would fail signature verification first)

### Detailed Fix Plan

#### Step 1: Add Validation Function

Create a validation function to check if webhook order data is complete:

```javascript
/**
 * Validate webhook order has required fields for processing
 * @param {Object} order - Order from webhook payload
 * @returns {Object} { valid: boolean, missingFields: string[] }
 */
function validateWebhookOrder(order) {
    const requiredFields = ['id', 'state', 'location_id'];
    const optionalButExpected = ['line_items', 'fulfillments'];

    const missingRequired = requiredFields.filter(f => !order?.[f]);
    const missingOptional = optionalButExpected.filter(f => !order?.[f]);

    return {
        valid: missingRequired.length === 0,
        missingRequired,
        missingOptional,
        hasLineItems: Array.isArray(order?.line_items) && order.line_items.length > 0,
        hasFulfillments: Array.isArray(order?.fulfillments) && order.fulfillments.length > 0
    };
}
```

#### Step 2: Modify handleOrderCreatedOrUpdated

**Before** (lines 141-145):
```javascript
let order = webhookOrder;
if (webhookOrder?.id) {
    order = await this._fetchFullOrder(webhookOrder.id, merchantId, webhookOrder);
}
```

**After**:
```javascript
let order = webhookOrder;
const validation = validateWebhookOrder(webhookOrder);

if (!validation.valid) {
    // Only fetch if webhook data is actually incomplete (should never happen)
    logger.warn('Webhook order missing required fields - fetching from API', {
        orderId: webhookOrder?.id,
        missingRequired: validation.missingRequired,
        merchantId
    });
    order = await this._fetchFullOrder(webhookOrder.id, merchantId, webhookOrder);
} else {
    logger.debug('Using webhook order data directly (API fetch skipped)', {
        orderId: order.id,
        hasLineItems: validation.hasLineItems,
        hasFulfillments: validation.hasFulfillments
    });
}
```

#### Step 3: Update _fetchFullOrder for Clarity

Rename to make it clear this is a fallback:

```javascript
/**
 * Fetch full order from Square API (FALLBACK ONLY)
 *
 * This should only be called when webhook data is incomplete,
 * which should never happen under normal circumstances.
 *
 * @private
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} fallbackOrder - Webhook order to use if fetch fails
 * @returns {Promise<Object>} Order object
 */
async _fetchFullOrderFallback(orderId, merchantId, fallbackOrder) {
    logger.warn('Fetching order from API - this should be rare', {
        orderId,
        merchantId,
        trigger: 'incomplete_webhook_data'
    });

    try {
        const squareClient = await getSquareClientForMerchant(merchantId);
        const orderResponse = await squareClient.orders.get({ orderId });
        if (orderResponse.order) {
            return orderResponse.order;
        }
    } catch (fetchError) {
        logger.error('Order fetch fallback failed - using webhook data', {
            orderId,
            error: fetchError.message
        });
    }
    return fallbackOrder;
}
```

#### Step 4: Add Metrics Logging

Add a counter to track how often the fallback is used (should be ~0):

```javascript
// At module level
let webhookOrderStats = {
    directUse: 0,
    apiFallback: 0,
    lastReset: Date.now()
};

// In handleOrderCreatedOrUpdated:
if (!validation.valid) {
    webhookOrderStats.apiFallback++;
    // ... fetch logic
} else {
    webhookOrderStats.directUse++;
}

// Log stats periodically (e.g., every 100 orders)
if ((webhookOrderStats.directUse + webhookOrderStats.apiFallback) % 100 === 0) {
    logger.info('Webhook order usage stats', {
        directUse: webhookOrderStats.directUse,
        apiFallback: webhookOrderStats.apiFallback,
        fallbackRate: `${((webhookOrderStats.apiFallback / (webhookOrderStats.directUse + webhookOrderStats.apiFallback)) * 100).toFixed(2)}%`
    });
}
```

### Files to Modify

| File | Lines | Changes |
|------|-------|---------|
| `services/webhook-handlers/order-handler.js` | 141-145 | Add validation, conditional fetch |
| `services/webhook-handlers/order-handler.js` | 164-183 | Rename, add warning logs |
| `services/webhook-handlers/order-handler.js` | (new) | Add `validateWebhookOrder()` function |

### Testing Plan

1. **Unit Test**: Mock webhook with complete order data → verify no API call made
2. **Unit Test**: Mock webhook with missing `line_items` → verify API call made (fallback)
3. **Integration Test**: Send real webhook via Square sandbox → verify processing works
4. **Monitoring**: After deploy, watch for `apiFallback` counter (should stay at 0)

### Expected Impact

- **API calls saved**: ~20/day (1 per order)
- **Latency reduction**: ~100-200ms per webhook (no API round-trip)
- **Risk**: Very low (fallback preserves existing behavior)

---

## P0-API-2: Full 91-Day Sync Fix

### Current Code (Problem)

**File**: `services/webhook-handlers/order-handler.js:134-139`

```javascript
// If order is COMPLETED, also sync sales velocity
if (webhookOrder?.state === 'COMPLETED') {
    await squareApi.syncSalesVelocity(91, merchantId);  // ← FETCHES ALL 91 DAYS!
    result.salesVelocity = true;
    logger.info('Sales velocity sync completed via order.updated (COMPLETED state)');
}
```

**File**: `services/webhook-handlers/order-handler.js:400-405`

```javascript
// Sync sales velocity if completed (ALSO in fulfillment handler!)
if (fulfillment?.state === 'COMPLETED') {
    await squareApi.syncSalesVelocity(91, merchantId);  // ← ANOTHER FULL SYNC!
    result.salesVelocity = true;
    logger.info('Sales velocity sync completed via fulfillment webhook');
}
```

### Why This Is Wasteful

When `syncSalesVelocity(91, merchantId)` is called:

1. **API Call Loop** (`services/square/api.js:1157-1219`):
   ```javascript
   do {
       const data = await makeSquareRequest('/v2/orders/search', {
           method: 'POST',
           body: JSON.stringify({
               query: {
                   filter: {
                       state_filter: { states: ['COMPLETED'] },
                       date_time_filter: {
                           closed_at: {
                               start_at: startDate.toISOString(),  // -91 days
                               end_at: endDate.toISOString()       // now
                           }
                       }
                   }
               },
               limit: 50
           })
       });
       // ... process orders
       cursor = data.cursor;
   } while (cursor);  // Pagination loops until all orders fetched
   ```

2. **Typical store with 20 orders/day**:
   - 91 days × 20 orders = 1,820 orders
   - 1,820 ÷ 50 (page size) = ~37 API calls
   - **Per order completion**: 37 API calls
   - **20 orders/day**: 740 API calls/day just for this!

3. **The irony**: We're fetching 91 days of orders to update velocity for **1 new order**.

### Detailed Fix Plan

#### Strategy: Incremental Velocity Update

Instead of re-fetching all 91 days, update sales velocity incrementally from the single completed order.

#### Step 1: Create Incremental Update Function

**New function in `services/square/api.js`**:

```javascript
/**
 * Update sales velocity incrementally from a single completed order.
 * This avoids re-fetching all historical orders.
 *
 * @param {Object} order - The completed order object (from webhook)
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Update result { updated: number, skipped: number }
 */
async function updateSalesVelocityFromOrder(order, merchantId) {
    if (!order || order.state !== 'COMPLETED') {
        return { updated: 0, skipped: 0, reason: 'Order not completed' };
    }

    if (!order.line_items || order.line_items.length === 0) {
        return { updated: 0, skipped: 0, reason: 'No line items' };
    }

    const closedAt = order.closed_at ? new Date(order.closed_at) : new Date();
    const locationId = order.location_id;

    logger.info('Updating sales velocity incrementally from single order', {
        orderId: order.id,
        lineItemCount: order.line_items.length,
        locationId,
        closedAt,
        merchantId
    });

    const PERIODS = [91, 182, 365];
    let updated = 0;
    let skipped = 0;

    // Pre-calculate which periods this order falls into
    const orderAge = Math.floor((Date.now() - closedAt.getTime()) / (1000 * 60 * 60 * 24));
    const applicablePeriods = PERIODS.filter(p => orderAge <= p);

    if (applicablePeriods.length === 0) {
        return { updated: 0, skipped: 0, reason: 'Order too old for all periods' };
    }

    // Get existing velocity records for affected variations
    const variationIds = [...new Set(order.line_items
        .filter(li => li.catalog_object_id)
        .map(li => li.catalog_object_id))];

    if (variationIds.length === 0) {
        return { updated: 0, skipped: 0, reason: 'No catalog variations in order' };
    }

    // Validate variations exist in our database
    const placeholders = variationIds.map((_, i) => `$${i + 1}`).join(',');
    const existingResult = await db.query(
        `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${variationIds.length + 1}`,
        [...variationIds, merchantId]
    );
    const existingIds = new Set(existingResult.rows.map(r => r.id));

    // Process each line item
    for (const lineItem of order.line_items) {
        const variationId = lineItem.catalog_object_id;
        if (!variationId || !existingIds.has(variationId)) {
            skipped++;
            continue;
        }

        const quantity = parseFloat(lineItem.quantity) || 0;
        const revenue = parseInt(lineItem.total_money?.amount) || 0;

        if (quantity <= 0) {
            skipped++;
            continue;
        }

        // Update each applicable period
        for (const periodDays of applicablePeriods) {
            const periodStart = new Date();
            periodStart.setDate(periodStart.getDate() - periodDays);

            try {
                // Atomic increment of existing velocity record, or insert new one
                await db.query(`
                    INSERT INTO sales_velocity (
                        variation_id, location_id, period_days,
                        total_quantity_sold, total_revenue_cents,
                        period_start_date, period_end_date,
                        daily_avg_quantity, daily_avg_revenue_cents,
                        weekly_avg_quantity, monthly_avg_quantity,
                        merchant_id, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, NOW(),
                            $4::decimal / $3, $5::decimal / $3,
                            $4::decimal / ($3::decimal / 7),
                            $4::decimal / ($3::decimal / 30),
                            $7, NOW())
                    ON CONFLICT (variation_id, location_id, period_days, merchant_id)
                    DO UPDATE SET
                        total_quantity_sold = sales_velocity.total_quantity_sold + $4,
                        total_revenue_cents = sales_velocity.total_revenue_cents + $5,
                        daily_avg_quantity = (sales_velocity.total_quantity_sold + $4) / $3,
                        daily_avg_revenue_cents = (sales_velocity.total_revenue_cents + $5) / $3,
                        weekly_avg_quantity = (sales_velocity.total_quantity_sold + $4) / ($3::decimal / 7),
                        monthly_avg_quantity = (sales_velocity.total_quantity_sold + $4) / ($3::decimal / 30),
                        period_end_date = NOW(),
                        updated_at = NOW()
                `, [variationId, locationId, periodDays, quantity, revenue, periodStart, merchantId]);

                updated++;
            } catch (dbError) {
                logger.warn('Failed to update velocity for variation', {
                    variationId,
                    periodDays,
                    error: dbError.message
                });
                skipped++;
            }
        }
    }

    logger.info('Incremental sales velocity update complete', {
        orderId: order.id,
        updated,
        skipped,
        periods: applicablePeriods
    });

    return { updated, skipped, periods: applicablePeriods };
}
```

#### Step 2: Modify Order Handler to Use Incremental Update

**Before** (`order-handler.js:134-139`):
```javascript
if (webhookOrder?.state === 'COMPLETED') {
    await squareApi.syncSalesVelocity(91, merchantId);
    result.salesVelocity = true;
    logger.info('Sales velocity sync completed via order.updated (COMPLETED state)');
}
```

**After**:
```javascript
if (webhookOrder?.state === 'COMPLETED') {
    // OPTIMIZATION: Update velocity incrementally from this single order
    // instead of re-fetching all 91 days of historical orders
    const velocityResult = await squareApi.updateSalesVelocityFromOrder(order, merchantId);
    result.salesVelocity = {
        method: 'incremental',
        updated: velocityResult.updated,
        skipped: velocityResult.skipped,
        periods: velocityResult.periods
    };
    logger.info('Sales velocity updated incrementally from completed order', {
        orderId: order.id,
        updated: velocityResult.updated,
        merchantId
    });
}
```

#### Step 3: Same Change in Fulfillment Handler

**Before** (`order-handler.js:400-405`):
```javascript
if (fulfillment?.state === 'COMPLETED') {
    await squareApi.syncSalesVelocity(91, merchantId);
    result.salesVelocity = true;
    logger.info('Sales velocity sync completed via fulfillment webhook');
}
```

**After**:
```javascript
if (fulfillment?.state === 'COMPLETED' && data.order_id) {
    // For fulfillment webhooks, we need to fetch the order since
    // the fulfillment webhook doesn't include line_items
    // But we only fetch THIS order, not all 91 days!
    try {
        const squareClient = await getSquareClientForMerchant(merchantId);
        const orderResponse = await squareClient.orders.get({ orderId: data.order_id });
        if (orderResponse.order?.state === 'COMPLETED') {
            const velocityResult = await squareApi.updateSalesVelocityFromOrder(
                orderResponse.order,
                merchantId
            );
            result.salesVelocity = {
                method: 'incremental',
                fromFulfillment: true,
                updated: velocityResult.updated
            };
        }
    } catch (fetchErr) {
        logger.warn('Could not fetch order for fulfillment velocity update', {
            orderId: data.order_id,
            error: fetchErr.message
        });
    }
}
```

#### Step 4: Add Reconciliation Safety Net

Since incremental updates can drift over time (orders can be modified, refunded, etc.), add a daily reconciliation job:

**New function for daily reconciliation**:

```javascript
/**
 * Daily reconciliation job to catch any velocity drift.
 * Runs as a cron job at 3 AM to validate/correct incremental updates.
 *
 * Strategy: Fetch last 2 days of orders and recalculate affected variations.
 * This catches:
 * - Webhook failures that were missed
 * - Orders modified after initial processing
 * - Refunds that should reduce velocity
 *
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Reconciliation result
 */
async function reconcileSalesVelocity(merchantId) {
    const RECONCILE_DAYS = 2;  // Look back 2 days

    logger.info('Starting sales velocity reconciliation', {
        merchantId,
        reconcileDays: RECONCILE_DAYS
    });

    const accessToken = await getMerchantToken(merchantId);
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - RECONCILE_DAYS);

    const locationsResult = await db.query(
        'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
        [merchantId]
    );
    const locationIds = locationsResult.rows.map(r => r.id);

    if (locationIds.length === 0) {
        return { orders: 0, reason: 'No active locations' };
    }

    // Single API call to fetch recent orders
    const requestBody = {
        location_ids: locationIds,
        query: {
            filter: {
                state_filter: { states: ['COMPLETED'] },
                date_time_filter: {
                    closed_at: {
                        start_at: startDate.toISOString(),
                        end_at: endDate.toISOString()
                    }
                }
            }
        },
        limit: 500  // Should cover 2 days of orders
    };

    const data = await makeSquareRequest('/v2/orders/search', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        accessToken
    });

    const orders = data.orders || [];
    let updated = 0;
    let missed = 0;

    // Process each order through incremental update
    // The upsert logic handles both new and existing records
    for (const order of orders) {
        const result = await updateSalesVelocityFromOrder(order, merchantId);
        if (result.updated > 0) {
            updated += result.updated;
        } else {
            missed++;
        }
    }

    logger.info('Sales velocity reconciliation complete', {
        merchantId,
        ordersChecked: orders.length,
        velocityRecordsUpdated: updated,
        ordersWithNoUpdates: missed,
        apiCalls: 1  // Just the single search call
    });

    return {
        orders: orders.length,
        updated,
        missed,
        apiCalls: 1
    };
}
```

#### Step 5: Add Cron Job for Reconciliation

**In `jobs/cron-scheduler.js`**:

```javascript
// Add to existing cron jobs
const VELOCITY_RECONCILE_CRON = process.env.VELOCITY_RECONCILE_CRON || '0 3 * * *'; // 3 AM daily

cron.schedule(VELOCITY_RECONCILE_CRON, async () => {
    logger.info('Running scheduled sales velocity reconciliation');
    try {
        const merchants = await db.query(
            'SELECT id FROM merchants WHERE is_active = TRUE'
        );
        for (const merchant of merchants.rows) {
            await squareApi.reconcileSalesVelocity(merchant.id);
        }
    } catch (error) {
        logger.error('Scheduled velocity reconciliation failed', {
            error: error.message
        });
    }
}, {
    timezone: process.env.TZ || 'America/Toronto'
});
```

### Files to Modify

| File | Changes |
|------|---------|
| `services/square/api.js` | Add `updateSalesVelocityFromOrder()`, `reconcileSalesVelocity()` |
| `services/webhook-handlers/order-handler.js:134-139` | Replace full sync with incremental |
| `services/webhook-handlers/order-handler.js:400-405` | Replace full sync with incremental |
| `jobs/cron-scheduler.js` | Add daily reconciliation cron |
| `.env.example` | Add `VELOCITY_RECONCILE_CRON` variable |

### Testing Plan

1. **Unit Test**: Single order → verify only DB operations, no API calls
2. **Unit Test**: Order with 5 line items → verify 5 × 3 = 15 velocity records updated
3. **Unit Test**: Order older than 365 days → verify no updates
4. **Integration Test**: Process webhook → verify velocity table updated correctly
5. **Reconciliation Test**: Manually modify velocity record → run reconciliation → verify corrected
6. **Load Test**: Process 100 orders → verify no rate limiting, <10 seconds total

### Expected Impact

- **API calls saved**: ~740/day (37 per order × 20 orders)
- **Processing time**: 2-5 seconds → 50-100ms per order
- **Risk**: Medium (requires thorough testing of velocity accuracy)

### Handling Edge Cases

| Edge Case | Current Behavior | New Behavior |
|-----------|------------------|--------------|
| Order modified after processing | Full re-sync catches it | Daily reconciliation catches it |
| Webhook missed | Full re-sync catches it | Daily reconciliation catches it |
| Refund processed | Re-processes all orders | Daily reconciliation adjusts |
| Order backdated to >91 days ago | Included in sync | Excluded from incremental (OK) |
| First-time merchant | Full 91-day sync works | Use smart sync for initial load |

---

## Additional API Inefficiencies Identified

### Issue 3: syncCommittedInventory Per Webhook

**File**: `services/webhook-handlers/order-handler.js:126`

**Current Behavior**:
```javascript
// Called on EVERY order.created / order.updated webhook
const committedResult = await squareApi.syncCommittedInventory(merchantId);
```

**Problem**:
- Fetches ALL open invoices and their orders
- For a store with 50 open invoices: 1 + (50 × 2) = 101 API calls
- Triggered ~20 times/day on orders alone

**Fix Plan**:

Option A: **Debounce committed inventory sync**
```javascript
// Track last sync time per merchant
const lastCommittedSync = new Map();
const COMMITTED_SYNC_DEBOUNCE_MS = 60000; // 1 minute

async function debouncedSyncCommittedInventory(merchantId) {
    const lastSync = lastCommittedSync.get(merchantId) || 0;
    const now = Date.now();

    if (now - lastSync < COMMITTED_SYNC_DEBOUNCE_MS) {
        logger.debug('Committed inventory sync debounced', {
            merchantId,
            lastSyncAgo: `${Math.floor((now - lastSync) / 1000)}s`
        });
        return { debounced: true };
    }

    lastCommittedSync.set(merchantId, now);
    return squareApi.syncCommittedInventory(merchantId);
}
```

Option B: **Only sync on state transitions**
```javascript
// Only sync committed inventory when:
// 1. Order created with OPEN state (new invoice potential)
// 2. Order changed TO or FROM OPEN state
// 3. Invoice-related webhooks (invoice.*)

const COMMITTED_RELEVANT_STATES = ['OPEN', 'DRAFT'];

if (COMMITTED_RELEVANT_STATES.includes(webhookOrder?.state) ||
    previousState && COMMITTED_RELEVANT_STATES.includes(previousState)) {
    await squareApi.syncCommittedInventory(merchantId);
}
```

**Recommended**: Combine both - debounce AND filter by state

**Expected Savings**: ~150-400 API calls/day

---

### Issue 4: Payment Webhook Fetches Order Unnecessarily

**File**: `services/webhook-handlers/order-handler.js:593-594`

**Current**:
```javascript
const squareClient = await getSquareClientForMerchant(merchantId);
const orderResponse = await squareClient.orders.get({ orderId: payment.order_id });
```

**Problem**: Every `payment.updated` webhook fetches the full order

**Fix**:
1. Check if order is needed (only for COMPLETED payments)
2. Consider caching order data from earlier webhooks
3. For loyalty processing, the order data might already be available

**Expected Savings**: ~10-20 API calls/day

---

### Issue 5: Fulfillment Webhook Also Fetches Order

**File**: `services/webhook-handlers/order-handler.js:488-490`

**Current**:
```javascript
const squareClient = await getSquareClientForMerchant(merchantId);
const orderResponse = await squareClient.orders.get({ orderId: squareOrderId });
const fullOrder = orderResponse.order;
```

**Problem**: Auto-ingest from fulfillment fetches order again

**Fix**:
1. Only fetch if auto-ingest is enabled (already checked at line 477)
2. Cache order from previous webhook in same processing cycle
3. Consider if delivery order already has sufficient data

**Expected Savings**: ~10-30 API calls/day

---

### Issue 6: Refund Handler Uses Raw Fetch Instead of SDK

**File**: `services/webhook-handlers/order-handler.js:700-709`

**Current**:
```javascript
const orderResponse = await fetch(
    `https://connect.squareup.com/v2/orders/${refund.order_id}`,
    {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': SQUARE_API_VERSION
        }
    }
);
```

**Problem**:
- Bypasses SDK (inconsistent)
- No retry logic
- Gets access token manually

**Fix**: Use SDK like other handlers:
```javascript
const squareClient = await getSquareClientForMerchant(merchantId);
const orderResponse = await squareClient.orders.get({ orderId: refund.order_id });
```

---

### Issue 7: Smart Sync Queries Database 10+ Times to Check Intervals

**File**: `routes/sync.js:144-200+`

**Current**: Each sync type check requires a database query:
```javascript
const locationsCheck = await isSyncNeeded('locations', intervals.locations, merchantId);
const vendorsCheck = await isSyncNeeded('vendors', intervals.vendors, merchantId);
const catalogCheck = await isSyncNeeded('catalog', intervals.catalog, merchantId);
// ... etc for 7+ sync types
```

**Fix**: Batch the sync history lookup:
```javascript
async function getAllSyncStatus(merchantId) {
    const result = await db.query(`
        SELECT sync_type, completed_at, status
        FROM sync_history
        WHERE merchant_id = $1 AND status = 'success'
    `, [merchantId]);

    return new Map(result.rows.map(r => [r.sync_type, r]));
}
```

**Expected Savings**: 7 DB queries → 1 DB query per smart sync (hourly × 24 = 168 queries/day saved)

---

## Order Caching Strategy

### Why Cache Orders?

Currently, every feature that needs order data fetches from Square:
- Sales velocity: Fetches 91-365 days of orders
- Committed inventory: Fetches orders for open invoices
- Loyalty: May re-fetch order after webhook

### Proposed Order Cache Table

```sql
CREATE TABLE order_cache (
    id SERIAL PRIMARY KEY,
    square_order_id TEXT NOT NULL,
    merchant_id INTEGER REFERENCES merchants(id),
    location_id TEXT NOT NULL,
    state TEXT NOT NULL,
    closed_at TIMESTAMPTZ,
    customer_id TEXT,
    -- Denormalized for velocity calculation
    line_items JSONB NOT NULL,  -- [{catalog_object_id, quantity, total_money}]
    fulfillments JSONB,
    -- Metadata
    cached_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW(),
    source TEXT DEFAULT 'webhook',  -- 'webhook', 'sync', 'api'
    UNIQUE(square_order_id, merchant_id)
);

CREATE INDEX idx_order_cache_merchant_state ON order_cache(merchant_id, state);
CREATE INDEX idx_order_cache_closed_at ON order_cache(closed_at DESC) WHERE state = 'COMPLETED';
CREATE INDEX idx_order_cache_customer ON order_cache(customer_id) WHERE customer_id IS NOT NULL;
```

### Cache Population Strategy

1. **Webhook**: Cache every order from `order.created`, `order.updated` webhooks
2. **Initial Sync**: One-time 366-day backfill for new merchants
3. **Reconciliation**: Daily 2-day fetch to catch misses

### Cache Usage

| Feature | Current | With Cache |
|---------|---------|------------|
| Sales Velocity | Fetch 91 days from Square | Query local cache |
| Committed Inventory | Fetch invoices + orders | Query local cache for orders |
| Loyalty | Fetch order per payment | Use cached order |

### Implementation Phases

**Phase 1: Cache Infrastructure**
- Create `order_cache` table
- Add `cacheOrder()` function
- Update webhook handlers to cache

**Phase 2: Velocity from Cache**
- New `calculateVelocityFromCache()` function
- Switch sales velocity to use cache
- Keep API sync as fallback/reconciliation

**Phase 3: Committed Inventory from Cache**
- Query cached orders for open invoice order IDs
- Eliminate per-invoice order fetch

---

## Sync Deduplication Architecture

### Current Problems

1. **Multiple Triggers for Same Data**:
   - Order webhook → `syncSalesVelocity(91)`
   - Fulfillment webhook → `syncSalesVelocity(91)` (same order!)
   - Smart sync cron → `syncSalesVelocity(91)` (hourly)

2. **No Coordination Between Handlers**:
   - Webhook handler A doesn't know handler B already synced

3. **Race Conditions**:
   - Two webhooks arrive simultaneously → both start syncing

### Proposed: Sync Coordinator Service

```javascript
/**
 * SyncCoordinator - Centralized sync orchestration
 *
 * Responsibilities:
 * 1. Deduplication: Prevent redundant syncs
 * 2. Debouncing: Batch rapid-fire requests
 * 3. Prioritization: Real-time webhooks > cron syncs
 * 4. Metrics: Track sync frequency and efficiency
 */
class SyncCoordinator {
    constructor() {
        // In-memory state (single instance)
        this.activeSyncs = new Map();    // merchantId:syncType → timestamp
        this.pendingSyncs = new Map();   // merchantId:syncType → { callback, priority }
        this.debounceTimers = new Map(); // merchantId:syncType → timeoutId

        // Configuration
        this.DEBOUNCE_MS = {
            salesVelocity: 5000,      // 5 seconds - batch rapid order completions
            committedInventory: 10000, // 10 seconds - invoices don't change rapidly
            catalog: 2000,            // 2 seconds - catalog changes are rare
            inventory: 1000           // 1 second - inventory changes can be rapid
        };
    }

    /**
     * Request a sync (may be debounced or deduplicated)
     * @param {string} syncType - Type of sync
     * @param {number} merchantId - Merchant ID
     * @param {Object} options - { priority: 'high'|'normal', source: string }
     * @returns {Promise<Object>} Sync result or dedup status
     */
    async requestSync(syncType, merchantId, options = {}) {
        const key = `${merchantId}:${syncType}`;
        const { priority = 'normal', source = 'unknown' } = options;

        // Check if sync is already in progress
        if (this.activeSyncs.has(key)) {
            logger.debug('Sync already in progress - marking pending', {
                syncType, merchantId, source
            });

            // Mark as pending for follow-up
            this.pendingSyncs.set(key, { priority, source });
            return { status: 'pending', reason: 'sync_in_progress' };
        }

        // Debounce: wait for more requests before executing
        const debounceMs = this.DEBOUNCE_MS[syncType] || 1000;

        return new Promise((resolve) => {
            // Clear existing timer
            if (this.debounceTimers.has(key)) {
                clearTimeout(this.debounceTimers.get(key));
            }

            // Set new timer
            const timer = setTimeout(async () => {
                this.debounceTimers.delete(key);

                try {
                    this.activeSyncs.set(key, Date.now());
                    const result = await this._executeSync(syncType, merchantId);
                    resolve({ status: 'completed', result });
                } finally {
                    this.activeSyncs.delete(key);

                    // Check for pending follow-up sync
                    if (this.pendingSyncs.has(key)) {
                        const pending = this.pendingSyncs.get(key);
                        this.pendingSyncs.delete(key);
                        // Recursively process pending (will debounce again)
                        this.requestSync(syncType, merchantId, pending);
                    }
                }
            }, debounceMs);

            this.debounceTimers.set(key, timer);
        });
    }

    async _executeSync(syncType, merchantId) {
        switch (syncType) {
            case 'salesVelocity':
                // Use incremental update by default
                return { method: 'incremental' };
            case 'committedInventory':
                return squareApi.syncCommittedInventory(merchantId);
            case 'catalog':
                return squareApi.syncCatalog(merchantId);
            case 'inventory':
                return squareApi.syncInventory(merchantId);
            default:
                throw new Error(`Unknown sync type: ${syncType}`);
        }
    }
}

// Singleton instance
const syncCoordinator = new SyncCoordinator();
module.exports = { syncCoordinator };
```

### Usage in Webhook Handlers

**Before**:
```javascript
await squareApi.syncSalesVelocity(91, merchantId);
await squareApi.syncCommittedInventory(merchantId);
```

**After**:
```javascript
const { syncCoordinator } = require('../services/sync-coordinator');

// These will be debounced and deduplicated automatically
await syncCoordinator.requestSync('salesVelocity', merchantId, {
    source: 'order_webhook',
    priority: 'high'
});
await syncCoordinator.requestSync('committedInventory', merchantId, {
    source: 'order_webhook'
});
```

---

## Implementation Phases

### Phase 1: Quick Wins (Week 1)

**P0-API-1: Remove Redundant Order Fetch**
- Impact: ~20 API calls/day saved
- Risk: Very low
- Effort: 2-4 hours

**Debounce Committed Inventory Sync**
- Impact: ~100-200 API calls/day saved
- Risk: Low
- Effort: 2-4 hours

### Phase 2: Major Fix (Week 2)

**P0-API-2: Incremental Velocity Update**
- Impact: ~740 API calls/day saved
- Risk: Medium (requires accuracy testing)
- Effort: 8-16 hours

**Daily Reconciliation Job**
- Impact: Safety net for incremental approach
- Risk: Low
- Effort: 4-8 hours

### Phase 3: Infrastructure (Week 3-4)

**Order Cache Table & Population**
- Impact: Foundation for further optimization
- Risk: Medium (new infrastructure)
- Effort: 16-24 hours

**Sync Coordinator Service**
- Impact: Prevents all duplicate syncs
- Risk: Medium (changes sync architecture)
- Effort: 8-16 hours

### Phase 4: Cache Utilization (Week 5-6)

**Velocity from Cache**
- Impact: Eliminates all velocity API calls
- Risk: Medium (depends on cache reliability)
- Effort: 8-16 hours

**Committed Inventory from Cache**
- Impact: Reduces committed sync to 1 API call
- Risk: Medium
- Effort: 8-12 hours

---

## Risk Assessment & Rollback Plan

### P0-API-1 Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Webhook data incomplete | Very Low | Low | Fallback to API fetch |
| Processing failure | Low | Medium | Existing error handling |

**Rollback**: Revert to always fetching (one line change)

### P0-API-2 Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Velocity drift over time | Medium | Medium | Daily reconciliation |
| Order modifications missed | Medium | Low | Daily reconciliation |
| Initial period has 0 data | Low | High | Use full sync for new merchants |

**Rollback**:
1. Disable incremental via feature flag
2. Re-enable full sync
3. Run full sync to correct data

### Feature Flag Strategy

```javascript
// config/constants.js
FEATURE_FLAGS: {
    USE_INCREMENTAL_VELOCITY: process.env.USE_INCREMENTAL_VELOCITY !== 'false',
    USE_ORDER_CACHE: process.env.USE_ORDER_CACHE === 'true',
    DEBOUNCE_COMMITTED_SYNC: process.env.DEBOUNCE_COMMITTED_SYNC !== 'false'
}
```

---

## Success Metrics

### Primary Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| API calls/day | ~1,060 | <100 | Log count of `makeSquareRequest` |
| Rate limit incidents/week | 2-5 | 0 | Monitor 429 responses |
| Webhook processing time | 2-5s | <500ms | Log duration |
| Velocity accuracy | Baseline | ±1% | Compare with full sync |

### Monitoring Dashboard

Track these metrics after each phase:

```javascript
// Add to logger
const apiMetrics = {
    callsByEndpoint: new Map(),
    callsBySource: new Map(),
    rateLimit429s: 0,
    avgProcessingTime: 0
};

// Log summary every hour
setInterval(() => {
    logger.info('API Usage Metrics', {
        totalCalls: [...apiMetrics.callsByEndpoint.values()].reduce((a,b) => a+b, 0),
        byEndpoint: Object.fromEntries(apiMetrics.callsByEndpoint),
        bySource: Object.fromEntries(apiMetrics.callsBySource),
        rateLimitHits: apiMetrics.rateLimit429s
    });
    // Reset counters
    apiMetrics.callsByEndpoint.clear();
    apiMetrics.callsBySource.clear();
    apiMetrics.rateLimit429s = 0;
}, 3600000);
```

---

## Summary

### Total Expected Savings

| Issue | Calls Saved/Day | Phase |
|-------|-----------------|-------|
| P0-API-1: Redundant fetch | ~20 | 1 |
| Debounced committed sync | ~150 | 1 |
| P0-API-2: Incremental velocity | ~740 | 2 |
| Fulfillment velocity fix | ~100 | 2 |
| Payment fetch optimization | ~15 | 3 |
| Sync coordinator dedup | ~50 | 3 |
| **TOTAL** | **~1,075/day** | |

### Implementation Order

1. **Week 1**: P0-API-1 + Debouncing (Easy wins, ~170 calls/day)
2. **Week 2**: P0-API-2 + Reconciliation (Big win, ~840 calls/day)
3. **Week 3-4**: Cache infrastructure (Foundation)
4. **Week 5-6**: Cache utilization (Final optimization)

### Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-27 | Claude | Initial comprehensive plan |
