# Data Refactoring Roadmap: Square → Multi-POS

**Audit Date:** 2026-04-11
**Based on:** SCHEMA_AUDIT.md, CODE_STRUCTURE_AUDIT.md, DEPENDENCIES_AUDIT.md, TEST_AUDIT.md

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Total Tables | 75 |
| Square-Specific Columns | 30 distinct |
| JSONB Columns with Square Data | 40+ |
| Square API Endpoints Called | 30+ unique |
| Service Files Calling Square | 20+ |
| Webhook Event Types (Square) | 28 |
| Cron Jobs Calling Square | 8 |
| Test Coverage | 5,464 tests / 0 failures |

**Core Finding:** SqTools is a well-architected multi-tenant platform with a thin but real service layer. The Square coupling is deep in three specific areas, shallow in the rest. A full refactor to multi-POS can be done incrementally with zero downtime, using the existing multi-tenant pattern as the structural template.

**Estimated effort:** 14–17 weeks across 6 phases (see timeline).

---

## Critical Coupling Map

Before planning work, understanding *where* coupling is structural vs. incidental:

### Level 1 — Structural (hardest to change)
These are architectural decisions where Square's ID *is* the primary key.

| Issue | Tables Affected | Risk |
|-------|----------------|------|
| `catalog_object_id` used as TEXT PK | items, variations, categories, images, inventory_counts | HIGH — PKs referenced throughout codebase |
| `square_merchant_id` is the merchant identity | merchants | HIGH — OAuth/session resolution depends on it |
| Webhook dispatch is Square-specific | webhook-processor.js, 10 handlers | HIGH — all 28 event types are Square terminology |

### Level 2 — Feature (medium effort)
Square IDs are stored alongside internal IDs; replaceable with external_refs pattern.

| Issue | Tables Affected | Risk |
|-------|----------------|------|
| `square_*` ID columns | vendors, locations, delivery_orders, committed_inventory, cart_activity | MEDIUM |
| Loyalty system (8 Square columns) | loyalty_rewards, loyalty_customers, loyalty_redemptions, seniors_discount_config | MEDIUM |
| `square_order_data` JSONB payload | delivery_orders | MEDIUM — delivery uses this for order details |

### Level 3 — Superficial (easiest to change)
These are timestamp/status flags that can be renamed or generalized.

| Issue | Tables Affected | Risk |
|-------|----------------|------|
| `square_updated_at` columns | items, variations, categories, images, inventory_counts | LOW |
| `square_sync_status`, `square_synced_at` | variation_discount_status, loyalty_rewards | LOW |
| `last_catalog_version`, `last_delta_timestamp` | sync_history | LOW |
| `square_token_*` columns | merchants | LOW — isolated in auth layer |

---

## What Does NOT Need Refactoring

These modules have zero Square coupling and will work untouched with any POS:

- `purchase_orders`, `purchase_order_items` — internal reorder system
- `bundle_definitions`, `bundle_components` — internal bundling
- `variation_expiration`, `expiry_discount_tiers` — internal expiry logic
- `delivery_routes`, `delivery_pod`, `delivery_audit_log` — delivery ops
- `brands`, `google_taxonomy`, GMC tables — Google integration
- `subscription_plans`, `promo_codes`, billing tables — internal billing
- `count_sessions`, `count_history`, `count_queue_*` — cycle count system
- `min_stock_audit`, `min_max_audit_log` — stock management audit
- `staff_invitations`, `user_merchants`, `users` — user management
- All `*_audit_log` tables — generic audit trail

---

## Phase 1: Schema Foundation (Weeks 1–3)

**Goal:** Add POS-agnostic identity layer without touching existing columns.
**Risk:** None — purely additive, no existing code breaks.

### 1A. Add `pos_credentials` Table

Replace the 5 Square-specific columns in `merchants` with a dedicated credentials table. The `merchants` table becomes POS-neutral.

```sql
-- New table: one row per POS connection per merchant
CREATE TABLE pos_credentials (
    id            SERIAL PRIMARY KEY,
    merchant_id   INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    pos_type      VARCHAR(50) NOT NULL,  -- 'square', 'shopify', 'woocommerce'
    pos_merchant_id  VARCHAR(255),       -- Square: square_merchant_id
    access_token  TEXT,                 -- Encrypted (AES-256-GCM, same scheme)
    refresh_token TEXT,                 -- Encrypted
    token_expires_at  TIMESTAMPTZ,
    token_scopes  TEXT,
    is_primary    BOOLEAN DEFAULT false,
    is_active     BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (merchant_id, pos_type)
);
CREATE INDEX idx_pos_credentials_merchant ON pos_credentials(merchant_id);
CREATE INDEX idx_pos_credentials_pos_merchant ON pos_credentials(pos_merchant_id);
```

**Migration strategy:**
```sql
-- Phase 1A: Copy existing data (dual-write begins)
INSERT INTO pos_credentials (merchant_id, pos_type, pos_merchant_id,
    access_token, refresh_token, token_expires_at, token_scopes, is_primary)
SELECT id, 'square', square_merchant_id, square_access_token,
    square_refresh_token, square_token_expires_at, square_token_scopes, true
FROM merchants
WHERE square_merchant_id IS NOT NULL;
```

Old `merchants.square_*` columns retained until Phase 5 cleanup.

---

### 1B. Add `external_refs` to Core Catalog Tables

The deepest coupling is that Square's catalog IDs are the primary keys of `items`, `variations`, `categories`, and `images`. The cleanest fix is to keep the existing TEXT PKs (to avoid a cascade FK rewrite) but add an `external_refs` JSONB column that formalizes the multi-POS identity pattern.

```sql
-- Add to: items, variations, categories, images, locations, vendors,
--         inventory_counts, sales_velocity, delivery_orders, committed_inventory
ALTER TABLE items          ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '{}';
ALTER TABLE variations     ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '{}';
ALTER TABLE categories     ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '{}';
ALTER TABLE images         ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '{}';
ALTER TABLE locations      ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '{}';
ALTER TABLE vendors        ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '{}';

-- Backfill from existing IDs
UPDATE items      SET external_refs = jsonb_build_object('square', jsonb_build_object('catalog_object_id', id));
UPDATE variations SET external_refs = jsonb_build_object('square', jsonb_build_object('catalog_object_id', id));
UPDATE categories SET external_refs = jsonb_build_object('square', jsonb_build_object('catalog_object_id', id));
UPDATE images     SET external_refs = jsonb_build_object('square', jsonb_build_object('catalog_object_id', id));
UPDATE locations  SET external_refs = jsonb_build_object('square', jsonb_build_object('location_id', square_location_id));
UPDATE vendors    SET external_refs = jsonb_build_object('square', jsonb_build_object('vendor_id', square_vendor_id));
```

**Future shape of `external_refs`:**
```json
{
  "square":    { "catalog_object_id": "DPQXG7MC4S..." },
  "shopify":   { "product_id": "7891234", "variant_id": "44123" },
  "woocommerce": { "post_id": "553" }
}
```

---

### 1C. Add `pos_type` to `sync_history`

```sql
ALTER TABLE sync_history
    ADD COLUMN IF NOT EXISTS pos_type VARCHAR(50) NOT NULL DEFAULT 'square',
    ADD COLUMN IF NOT EXISTS sync_cursor JSONB DEFAULT '{}';

-- Backfill cursor from existing columns
UPDATE sync_history
SET sync_cursor = jsonb_build_object(
    'delta_timestamp', last_delta_timestamp,
    'catalog_version', last_catalog_version
)
WHERE last_delta_timestamp IS NOT NULL OR last_catalog_version IS NOT NULL;
```

The `sync_cursor` JSONB replaces `last_delta_timestamp` + `last_catalog_version` and can hold any POS-specific cursor format.

---

### 1D. Add `pos_type` to `merchants`

```sql
ALTER TABLE merchants
    ADD COLUMN IF NOT EXISTS pos_type VARCHAR(50) DEFAULT 'square';

UPDATE merchants SET pos_type = 'square';
```

This is the routing key used by the adapter factory (Phase 2).

---

**Phase 1 Deliverable Checklist:**
- [ ] `pos_credentials` table created and backfilled
- [ ] `external_refs` JSONB added to 6 core tables and backfilled
- [ ] `sync_cursor` JSONB added to `sync_history` and backfilled
- [ ] `pos_type` added to `merchants`
- [ ] All tests still pass (no code changes)
- [ ] Migrations wrapped in `BEGIN`/`COMMIT`

---

## Phase 2: POS Adapter Interface (Weeks 4–5)

**Goal:** Define the adapter contract and implement `SquareAdapter` by extracting existing service code. No routes change yet.

### 2A. Directory Structure

```
services/
  pos-adapters/
    base-adapter.js          ← Abstract base class (documents the interface)
    adapter-factory.js       ← Returns correct adapter for a merchant
    square/
      index.js               ← SquareAdapter (implements base-adapter)
      catalog.js             ← Extracted from square-catalog-sync.js
      inventory.js           ← Extracted from square-inventory.js
      orders.js              ← Extracted from square-velocity.js + order-handler
      customers.js           ← Extracted from loyalty-admin/customer-*
      locations.js           ← Extracted from square-locations.js
      vendors.js             ← Extracted from square-vendors.js
      webhooks.js            ← Extracted from webhook-processor.js
      auth.js                ← Extracted from square-oauth.js + merchant.js
```

### 2B. Base Adapter Contract

See `POS_ADAPTER_SPEC.md` for the full interface definition. Summary:

```javascript
// services/pos-adapters/base-adapter.js
class BasePosAdapter {
    // Identity
    async getMerchantProfile() {}

    // Catalog (read from POS)
    async listItems(cursor)  {}
    async listVariations(cursor) {}
    async listCategories(cursor) {}
    async listImages(cursor) {}

    // Catalog (push to POS)
    async pushItemUpdate(externalId, fields) {}
    async pushVariationUpdate(externalId, fields) {}
    async pushCustomAttribute(externalId, key, value) {}

    // Inventory (read from POS)
    async batchGetInventory(externalIds, locationId) {}

    // Inventory (push to POS)
    async pushInventoryAdjustment(changes) {}

    // Orders
    async getOrder(externalId) {}
    async searchOrders(locationId, dateRange, cursor) {}

    // Customers
    async getCustomer(externalId) {}
    async searchCustomers(query) {}
    async createCustomer(data) {}

    // Locations
    async listLocations() {}

    // Vendors
    async listVendors(cursor) {}
    async getVendor(externalId) {}

    // Webhooks
    verifyWebhookSignature(headers, rawBody) {}
    normalizeWebhookEvent(rawEvent) {}   // → PosEvent (standard format)

    // Sync cursors
    getInitialSyncCursor() {}
    buildSyncCursor(lastResult) {}
}
```

### 2C. Adapter Factory

```javascript
// services/pos-adapters/adapter-factory.js
const { SquareAdapter } = require('./square');

async function getAdapterForMerchant(merchantId) {
    const cred = await db.query(
        'SELECT pos_type FROM merchants WHERE id = $1', [merchantId]
    );
    switch (cred.rows[0].pos_type) {
        case 'square': return new SquareAdapter(merchantId);
        default: throw new Error(`Unknown POS type: ${cred.rows[0].pos_type}`);
    }
}

module.exports = { getAdapterForMerchant };
```

### 2D. SquareAdapter Implementation

Extract *without changing* the underlying service logic — just wrap it:

```javascript
// services/pos-adapters/square/index.js
const squareCatalog = require('../../square/square-catalog-sync');
const squareInventory = require('../../square/square-inventory');
const squareVelocity = require('../../square/square-velocity');
// ...

class SquareAdapter extends BasePosAdapter {
    constructor(merchantId) {
        super();
        this.merchantId = merchantId;
    }

    async listItems(cursor) {
        // Delegate to existing service — no logic change
        return squareCatalog.deltaSyncCatalog(this.merchantId, cursor);
    }

    async batchGetInventory(externalIds, locationId) {
        return squareInventory.batchRetrieveCounts(this.merchantId, externalIds, locationId);
    }

    verifyWebhookSignature(headers, rawBody) {
        return squareWebhooks.verifySignature(headers, rawBody);
    }

    normalizeWebhookEvent(rawEvent) {
        return {
            eventType: mapSquareEventType(rawEvent.type),  // e.g. 'catalog.updated'
            entityId:  rawEvent.data?.object?.id,
            merchantExternalId: rawEvent.merchant_id,
            occurredAt: rawEvent.created_at,
            raw: rawEvent
        };
    }
}
```

**Phase 2 Deliverable Checklist:**
- [ ] `base-adapter.js` created with full method stubs
- [ ] `adapter-factory.js` created
- [ ] `SquareAdapter` created (thin wrappers, delegates to existing services)
- [ ] `SquareAdapter` unit tests added (mock existing services)
- [ ] No existing tests broken

---

## Phase 3: Service Layer Migration (Weeks 6–8)

**Goal:** Update services to call `posAdapter.*` instead of Square services directly. Route files do not change. This is the largest phase.

### 3A. Update Sync Orchestrator

**File:** `services/square/square-sync-orchestrator.js`

```javascript
// BEFORE
async function fullSync(merchantId) {
    await syncLocations(merchantId);
    await syncVendors(merchantId);
    await syncCatalog(merchantId);
    await syncInventory(merchantId);
    // ...
}

// AFTER
async function fullSync(merchantId) {
    const adapter = await getAdapterForMerchant(merchantId);
    await syncLocations(merchantId, adapter);
    await syncVendors(merchantId, adapter);
    await syncCatalog(merchantId, adapter);
    await syncInventory(merchantId, adapter);
    // ...
}
```

### 3B. Update Catalog Sync Service

The catalog sync service writes Square IDs into `external_refs` instead of (or in addition to) `catalog_object_id`.

```javascript
// BEFORE (square-catalog-sync.js)
await db.query(
    'INSERT INTO items (id, name, merchant_id, ...) VALUES ($1, $2, $3, ...)',
    [squareCatalogObjectId, name, merchantId, ...]
);

// AFTER
await db.query(
    `INSERT INTO items (id, name, merchant_id, external_refs, ...)
     VALUES ($1, $2, $3, $4, ...)
     ON CONFLICT (id) DO UPDATE SET
       external_refs = EXCLUDED.external_refs,
       name = EXCLUDED.name`,
    [squareCatalogObjectId, name, merchantId,
     JSON.stringify({ square: { catalog_object_id: squareCatalogObjectId } }), ...]
);
```

During Phase 3, Square IDs remain as PKs. The `external_refs` column is populated in parallel. No downstream breakage.

### 3C. Update Inventory Service

**File:** `services/square/square-inventory.js`
- Replace direct `makeSquareRequest('/v2/inventory/counts/batch-retrieve')` with `adapter.batchGetInventory()`
- Existing logic (dedup, upsert, alert checking) stays the same

### 3D. Update Webhook Processor

**File:** `services/webhook-handlers/webhook-processor.js`

```javascript
// BEFORE
const sig = req.headers['x-square-hmacsha256-signature'];
if (!verifySquareSignature(sig, rawBody)) return res.status(401).end();

// AFTER
const adapter = await getAdapterForMerchant(merchantId);
if (!adapter.verifyWebhookSignature(req.headers, rawBody)) return res.status(401).end();
const event = adapter.normalizeWebhookEvent(req.body);
// Route by normalized event.eventType instead of Square-specific type string
```

### 3E. Files to Update (full list)

| File | Change |
|------|--------|
| `services/square/square-sync-orchestrator.js` | Pass adapter, call adapter methods |
| `services/square/square-catalog-sync.js` | Use adapter.listItems(), write external_refs |
| `services/square/square-inventory.js` | Use adapter.batchGetInventory(), adapter.pushInventoryAdjustment() |
| `services/square/square-velocity.js` | Use adapter.searchOrders() |
| `services/square/square-vendors.js` | Use adapter.listVendors(), adapter.getVendor() |
| `services/square/square-locations.js` | Use adapter.listLocations() |
| `services/square/square-pricing.js` | Use adapter.pushVariationUpdate() |
| `services/square/square-custom-attributes.js` | Use adapter.pushCustomAttribute() |
| `services/square/square-diagnostics.js` | Use adapter.* for fix operations |
| `services/webhook-handlers/webhook-processor.js` | Use adapter.verifyWebhookSignature() + normalizeWebhookEvent() |
| `services/webhook-handlers/index.js` | Route on normalized event types |
| `services/webhook-handlers/order-handler/` | Use adapter.getOrder() |
| `services/loyalty-admin/shared-utils.js` | Use adapter.* for customer/loyalty calls |
| `services/loyalty-admin/square-api-client.js` | Replace with adapter.customers.*, adapter.loyalty.* |
| `services/delivery/delivery-square.js` | Use adapter.getOrder() |

**Phase 3 Deliverable Checklist:**
- [ ] All sync services use `adapter.*` calls
- [ ] Webhook processor uses `adapter.verifyWebhookSignature()` and `adapter.normalizeWebhookEvent()`
- [ ] `external_refs` populated on every catalog upsert
- [ ] All 5,464 existing tests still pass
- [ ] New tests for adapter usage added to existing service tests

---

## Phase 4: Deep Feature Refactoring (Weeks 9–12)

These features have Square IDs in their core tables. They require dedicated attention.

### 4A. Loyalty System

The loyalty system has 8 Square-specific columns in `loyalty_rewards` and 4 in related tables. These cannot be abstracted to a generic interface because loyalty program structures differ radically between POS systems. The recommended approach:

**Option A (Recommended): POS-specific loyalty tables**
Keep the Square-specific columns but isolate them inside the adapter pattern. The loyalty *business logic* (points, offers, qualifying items) is POS-neutral; only the sync mechanism is Square-specific.

```sql
-- New: pos-agnostic loyalty sync state
ALTER TABLE loyalty_rewards
    ADD COLUMN IF NOT EXISTS pos_sync_state JSONB DEFAULT '{}';

-- Backfill Square sync state into JSONB
UPDATE loyalty_rewards
SET pos_sync_state = jsonb_build_object(
    'square', jsonb_build_object(
        'reward_tier_id',  square_reward_tier_id,
        'reward_id',       square_reward_id,
        'group_id',        square_group_id,
        'discount_id',     square_discount_id,
        'product_set_id',  square_product_set_id,
        'pricing_rule_id', square_pricing_rule_id,
        'pos_synced_at',   square_pos_synced_at,
        'sync_status',     square_sync_status
    )
);
```

Services: `services/loyalty-admin/square-reward-service.js` → `services/loyalty-admin/pos-reward-sync-service.js` with adapter injection.

**Option B:** Full loyalty abstraction (out of scope for v1 multi-POS).

### 4B. Delivery Orders

`delivery_orders.square_order_data` stores the full Square order JSON payload. With a new POS, the payload schema will differ.

```sql
ALTER TABLE delivery_orders
    ADD COLUMN IF NOT EXISTS pos_order_data JSONB DEFAULT '{}';

-- Backfill
UPDATE delivery_orders
SET pos_order_data = jsonb_build_object('square', square_order_data)
WHERE square_order_data IS NOT NULL;
```

Update `delivery-square.js` to write to `pos_order_data` keyed by POS type.

### 4C. OAuth & Merchant Auth

The OAuth flow in `routes/square-oauth.js` is entirely Square-specific. For multi-POS:

1. Create `routes/pos-oauth/square.js` — move Square OAuth here
2. Create `routes/pos-oauth/shopify.js` — new OAuth when needed
3. Create shared `routes/pos-oauth/index.js` — routes to correct OAuth by `pos_type`
4. Update `middleware/merchant.js:getSquareClientForMerchant()` → `getPosClientForMerchant()`, reads from `pos_credentials` table

### 4D. Seniors Discount

```sql
ALTER TABLE seniors_discount_config
    ADD COLUMN IF NOT EXISTS pos_config JSONB DEFAULT '{}';

UPDATE seniors_discount_config
SET pos_config = jsonb_build_object('square', jsonb_build_object(
    'group_id', square_group_id,
    'discount_id', square_discount_id
));
```

**Phase 4 Deliverable Checklist:**
- [ ] Loyalty `pos_sync_state` column added and backfilled
- [ ] `loyalty_rewards` sync services refactored to use adapter
- [ ] `delivery_orders.pos_order_data` added and backfilled
- [ ] OAuth flow reorganized into `routes/pos-oauth/`
- [ ] `merchants.pos_type` used for adapter selection in middleware
- [ ] `seniors_discount_config.pos_config` added
- [ ] All existing tests pass

---

## Phase 5: Merchant Onboarding for Multi-POS (Weeks 13–14)

**Goal:** Allow a merchant to connect a second POS or onboard with a non-Square POS.

### 5A. Merchant Settings UI Update

- Add "Connected Platforms" card to merchant settings
- Allow connecting/disconnecting POS via OAuth
- Display `pos_credentials` records per merchant

### 5B. Subscription Abstraction

Currently `subscribers.square_subscription_id` and `subscription_payments.square_payment_id` assume Square billing. For multi-POS SaaS billing, add:

```sql
ALTER TABLE subscribers        ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '{}';
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '{}';

UPDATE subscribers
SET external_refs = jsonb_build_object('square', jsonb_build_object(
    'subscription_id', square_subscription_id,
    'customer_id', square_customer_id
));
```

### 5C. Webhook Registration

Update `utils/square-webhooks.js` → `utils/pos-webhooks.js`:
- Per-POS signature verification (dispatches to adapter)
- Endpoint registration per POS type

### 5D. Environment Variables

Add POS-type-aware env vars:
```
POS_TYPE=square                           # Default for new installs
SQUARE_APPLICATION_ID=...                 # Square-specific
SHOPIFY_API_KEY=...                       # Shopify-specific (future)
```

---

## Phase 6: Cleanup (Weeks 15–17)

**Prerequisite:** Production running stably on adapter layer for ≥30 days with dual-write validated.

### 6A. Schema Cleanup

Only after all reads have moved off old columns:

```sql
-- Remove Square columns from merchants (replaced by pos_credentials)
ALTER TABLE merchants
    DROP COLUMN square_merchant_id,
    DROP COLUMN square_access_token,
    DROP COLUMN square_refresh_token,
    DROP COLUMN square_token_expires_at,
    DROP COLUMN square_token_scopes;

-- Remove Square sync columns (replaced by sync_cursor JSONB)
ALTER TABLE sync_history
    DROP COLUMN last_delta_timestamp,
    DROP COLUMN last_catalog_version;

-- Remove individual Square ID columns replaced by external_refs
ALTER TABLE locations DROP COLUMN square_location_id;
ALTER TABLE vendors   DROP COLUMN square_vendor_id;

-- Remove Square order/customer ID columns in delivery (replaced by external_refs)
ALTER TABLE delivery_orders
    DROP COLUMN square_order_id,
    DROP COLUMN square_customer_id,
    DROP COLUMN square_order_state,
    DROP COLUMN square_order_data;

-- Rename square_updated_at → pos_updated_at on catalog tables
ALTER TABLE items       RENAME COLUMN square_updated_at TO pos_updated_at;
ALTER TABLE variations  RENAME COLUMN square_updated_at TO pos_updated_at;
ALTER TABLE categories  RENAME COLUMN square_updated_at TO pos_updated_at;
ALTER TABLE images      RENAME COLUMN square_updated_at TO pos_updated_at;
ALTER TABLE inventory_counts RENAME COLUMN square_updated_at TO pos_updated_at;
```

**Do NOT drop in Phase 6:**
- `catalog_object_id` as PK in items/variations — this TEXT PK is referenced by 100+ queries. Rename only if a full PK migration is done (future v2 work).
- Loyalty `square_*` columns — keep until a second loyalty adapter is implemented.

### 6B. Service Cleanup

- Delete `services/square/square-client.js` original once all callers use adapter
- Remove duplicate client patterns (`services/loyalty-admin/square-api-client.js`, `shared-utils.js`)
- Consolidate into `services/pos-adapters/square/client.js`

### 6C. Test Updates

- Remove Square-specific test mocks from files that now test adapter
- Add `adapter-factory.test.js` with per-POS type tests
- Add contract tests: any new adapter must pass `base-adapter-contract.test.js`

---

## Migration Risk Matrix

| Phase | Risk | Mitigation |
|-------|------|-----------|
| Phase 1 (schema) | Low — additive only | Run in BEGIN/COMMIT, test with existing suite |
| Phase 2 (adapter interface) | Low — no logic change | SquareAdapter wraps existing code exactly |
| Phase 3 (service migration) | Medium — many files | One service at a time, test after each |
| Phase 4 (loyalty/delivery) | High — deep coupling | Dual-write period mandatory before removing old columns |
| Phase 5 (onboarding) | Medium — new user flows | Feature flag behind `MULTI_POS_ENABLED` env var |
| Phase 6 (cleanup) | Medium — column drops are irreversible | 30-day production validation gate |

---

## Item-by-Item Refactoring Checklist

### Tables Requiring Schema Changes

| Table | Change Type | Phase |
|-------|-------------|-------|
| `merchants` | Add `pos_type`; migrate 5 square_* cols → `pos_credentials` | 1, 6 |
| `pos_credentials` | New table | 1 |
| `sync_history` | Add `pos_type`, `sync_cursor`; drop old cursor cols | 1, 6 |
| `items` | Add `external_refs` | 1 |
| `variations` | Add `external_refs` | 1 |
| `categories` | Add `external_refs` | 1 |
| `images` | Add `external_refs` | 1 |
| `locations` | Add `external_refs`; drop `square_location_id` | 1, 6 |
| `vendors` | Add `external_refs`; drop `square_vendor_id` | 1, 6 |
| `inventory_counts` | Rename `square_updated_at` → `pos_updated_at` | 6 |
| `delivery_orders` | Add `external_refs`, `pos_order_data`; drop 4 square_* cols | 4, 6 |
| `loyalty_rewards` | Add `pos_sync_state`; keep square_* until loyalty v2 | 4 |
| `loyalty_customers` | Add `external_refs`; alias `square_customer_id` | 4 |
| `seniors_discount_config` | Add `pos_config` | 4 |
| `subscribers` | Add `external_refs` | 5 |
| `subscription_payments` | Add `external_refs` | 5 |
| `committed_inventory` | Add `external_refs` | 3 |
| `cart_activity` | Add `external_refs` | 3 |
| `webhook_events` | Add `pos_type` | 3 |

### Services Requiring Code Changes

| File | Change | Phase |
|------|--------|-------|
| `services/square/square-sync-orchestrator.js` | Inject adapter | 3 |
| `services/square/square-catalog-sync.js` | Use adapter, write external_refs | 3 |
| `services/square/square-inventory.js` | Use adapter | 3 |
| `services/square/square-velocity.js` | Use adapter.searchOrders() | 3 |
| `services/square/square-locations.js` | Use adapter.listLocations() | 3 |
| `services/square/square-vendors.js` | Use adapter | 3 |
| `services/square/square-pricing.js` | Use adapter.pushVariationUpdate() | 3 |
| `services/square/square-custom-attributes.js` | Use adapter.pushCustomAttribute() | 3 |
| `services/webhook-handlers/webhook-processor.js` | Adapter-based signature + dispatch | 3 |
| `services/webhook-handlers/index.js` | Route on normalized event types | 3 |
| `services/loyalty-admin/square-api-client.js` | Replace with adapter delegation | 4 |
| `services/loyalty-admin/shared-utils.js` | Replace with adapter | 4 |
| `services/loyalty-admin/square-reward-service.js` | Use adapter for POS sync | 4 |
| `services/delivery/delivery-square.js` | Use adapter.getOrder() | 4 |
| `middleware/merchant.js` | `getSquareClientForMerchant` → `getPosClientForMerchant` | 5 |
| `routes/square-oauth.js` | Move to `routes/pos-oauth/square.js` | 5 |
| `utils/square-webhooks.js` | Generalize to `utils/pos-webhooks.js` | 5 |

---

## Timeline Summary

| Phase | Name | Duration | Dependency |
|-------|------|----------|-----------|
| 1 | Schema Foundation | 3 weeks | None — start immediately |
| 2 | POS Adapter Interface | 2 weeks | After Phase 1 merged |
| 3 | Service Layer Migration | 3 weeks | After Phase 2 merged |
| 4 | Deep Feature Refactoring | 4 weeks | After Phase 3 stable |
| 5 | Multi-POS Onboarding | 2 weeks | After Phase 4 merged |
| 6 | Cleanup | 3 weeks | 30 days production stability |
| **Total** | | **14–17 weeks** | |

---

## What This Unlocks

After completing through Phase 3 (8 weeks), a new POS adapter can be built by:
1. Implementing `BasePosAdapter` for the new POS
2. Adding a new row to `pos_credentials`
3. Adding the new POS type to `adapter-factory.js`

No routes, no schema, no business logic needs to change for POS #2.
