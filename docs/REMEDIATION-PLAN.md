# Remediation Plan

**Created**: 2026-02-27
**Source**: CODEBASE_AUDIT_2026-02-25.md, production incident logs

---

## Package 6: Webhook Handlers

### P-10: Duplicate Delivery Orders from Racing Webhooks

**Severity**: HIGH (production impact — duplicate orders appearing in driver view)
**Status**: FIXED (2026-02-27)

**Root Cause**: Multiple `order.updated` webhooks for the same Square order can arrive in rapid succession. Each webhook gets a different `event_id`, so the in-memory event dedup (BACKLOG-5) doesn't catch them. Both webhooks race through the `getOrderBySquareId()` SELECT check simultaneously, both see no existing row, and both INSERT — creating duplicate `delivery_orders` rows.

**Evidence**: 2026-02-26 logs: two delivery orders (`6fa83def`, `e5f591b5`) for same Square order `qyuUdnnGxyDLayHyH7rG64AWgwZZY`.

**Fix Applied**:

| # | Change | File | Effort |
|---|--------|------|--------|
| 1 | UNIQUE partial index on `(square_order_id, merchant_id) WHERE square_order_id IS NOT NULL` | `database/migrations/058_delivery_orders_unique_square_order.sql` | S |
| 2 | `INSERT ... ON CONFLICT DO UPDATE` in `createOrder()` — updates enrichable fields (customer name, phone, order data) on conflict, returns existing row | `services/delivery/delivery-service.js` | S |
| 3 | One-time cleanup script to deduplicate existing rows (keep earliest, delete rest) | `scripts/cleanup-duplicate-deliveries.sql` | S |
| 4 | 10 tests covering ON CONFLICT behavior, race simulation, separate order IDs | `__tests__/services/delivery-dedup.test.js` | S |

**Deployment Steps**:
1. Run `scripts/cleanup-duplicate-deliveries.sql` to remove existing duplicates
2. Run migration `058_delivery_orders_unique_square_order.sql` to add UNIQUE index
3. Deploy code changes (createOrder ON CONFLICT)

**ON CONFLICT behavior**: When a duplicate `square_order_id + merchant_id` INSERT is attempted:
- `customer_name`: Keeps existing name unless it's "Unknown Customer" (then accepts new name)
- `phone`, `square_customer_id`, `address`: COALESCE — keeps existing value if new is NULL
- `square_order_data`, `square_order_state`: COALESCE — enriches with latest data
- `needs_customer_refresh`: Always takes the new value (latest webhook knows best)
- `status`, `notes`, `customer_note`, `geocoded_at`: NOT updated (preserves driver-side state)

### P-11: Webhook Handlers Untested (T-2 from audit)

**Severity**: HIGH (risk, not production incident)
**Status**: DEFERRED (L effort — not in scope for Pkg 6)

**Detail**: 7 of 8 webhook handlers have zero test coverage. `order-handler.js` (1,316 lines) is the highest risk. The P-10 fix adds delivery dedup tests but does not address the broader gap.

**Recommendation**: Prioritize order-handler.js and loyalty-handler.js tests in a future package.

---

## Observation Log

Issues found during P-10 work. Not fixed — documented only.

| # | Observation | File:Line | Severity | Notes |
|---|-------------|-----------|----------|-------|
| O-1 | `ingestSquareOrder()` does a SELECT-then-INSERT (TOCTOU race). The new ON CONFLICT in `createOrder()` is the authoritative guard, but the redundant SELECT adds ~1ms per call. Could be removed in future to simplify, but harmless. | `services/delivery/delivery-service.js:1243-1276` | LOW | The SELECT still serves a useful purpose: it can do a richer update (status, backfill order data) on existing rows, which the ON CONFLICT DO UPDATE doesn't cover (e.g., status transitions). Keep as-is. |
| O-2 | `_autoIngestFromFulfillment` re-fetches the full order from Square API (`squareClient.orders.get`). If both `order.updated` and `order.fulfillment.updated` fire for the same event, this doubles the Square API calls. Not a bug — just inefficiency. | `services/webhook-handlers/order-handler.js:1061-1063` | LOW | Could deduplicate by caching recently fetched orders in-memory for 5s. |
| O-3 | `delivery-service.js` is 1,918 lines — exceeds 300-line rule (CLAUDE.md). Functions are well-scoped but file is monolithic. | `services/delivery/delivery-service.js` | LOW | Refactor-on-touch policy applies. Could split into `delivery-orders.js`, `delivery-routes.js`, `delivery-square.js`. |
| O-4 | The existing non-unique index `idx_delivery_orders_square_order` used `(merchant_id, square_order_id)` column order. The new UNIQUE index uses `(square_order_id, merchant_id)` per task spec. Both orders work for the ON CONFLICT clause and existing queries. The `getOrderBySquareId` query filters by `square_order_id = $1 AND merchant_id = $2` which works with either order. | `database/schema.sql` | INFO | No action needed. |
