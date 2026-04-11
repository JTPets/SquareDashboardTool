# POS Adapter Interface Specification

**Version:** 1.0
**Date:** 2026-04-11
**Status:** Proposed — for implementation in Phase 2 of DATA_REFACTORING_ROADMAP.md

This document is the contract for all current and future POS adapters. Every method listed here must be implemented by any class that extends `BasePosAdapter`. The `SquareAdapter` is the reference implementation.

---

## Design Principles

1. **Narrow interface** — Only methods that differ between POS systems are on the adapter. Pure-DB operations (reorder math, min-max, delivery routing) remain in their own services.
2. **Return normalized models** — All adapter methods return SqTools-internal model shapes, never raw POS API payloads. Raw payloads are stored in `external_refs` / `pos_order_data` for debugging but not propagated.
3. **Stateless calls** — Adapters carry only `merchantId`. No request state, no caching at the adapter level.
4. **Errors throw `PosAdapterError`** — A common error class so callers don't need POS-specific error handling.
5. **Cursors are opaque strings** — Pagination cursors are base64-encoded JSON internally; callers treat them as strings.

---

## Abstract Data Models

### `PosItem`
```javascript
{
  externalId:   string,          // POS-native ID (Square: catalog_object_id)
  name:         string,
  description:  string | null,
  descriptionHtml: string | null,
  categoryExternalId: string | null,
  imageExternalIds: string[],
  taxExternalIds:   string[],
  isDeleted:    boolean,
  posUpdatedAt: Date,
  locationPresence: {
    presentAtAll:     boolean,
    presentAtIds:     string[],
    absentAtIds:      string[],
  },
  modifierListInfo: object | null,  // POS-specific, stored verbatim
  itemOptions:      object | null,  // POS-specific, stored verbatim
  customAttributes: Record<string, string>,
  raw: object                        // Full POS payload (for debugging)
}
```

### `PosVariation`
```javascript
{
  externalId:     string,
  itemExternalId: string,
  name:           string,
  sku:            string | null,
  upc:            string | null,
  priceMoney:     { amount: number, currency: string },  // amount in cents
  pricingType:    'FIXED_PRICING' | 'VARIABLE_PRICING',
  trackInventory: boolean,
  isDeleted:      boolean,
  posUpdatedAt:   Date,
  locationPresence: {
    presentAtAll: boolean,
    presentAtIds: string[],
    absentAtIds:  string[],
  },
  itemOptionValues:  object | null,
  customAttributes:  Record<string, string>,
  taxExternalIds:    string[],
  images:            string[],
  raw: object
}
```

### `PosCategory`
```javascript
{
  externalId:  string,
  name:        string,
  posUpdatedAt: Date,
  raw: object
}
```

### `PosImage`
```javascript
{
  externalId: string,
  name:       string | null,
  url:        string,
  caption:    string | null,
  posUpdatedAt: Date,
  raw: object
}
```

### `PosInventoryCount`
```javascript
{
  variationExternalId: string,
  locationExternalId:  string,
  state:    string,     // 'IN_STOCK', 'SOLD', 'WASTE', etc. (POS-native)
  quantity: number,
  posUpdatedAt: Date
}
```

### `PosInventoryChange`
```javascript
{
  type:                'PHYSICAL_COUNT' | 'ADJUSTMENT',
  variationExternalId: string,
  locationExternalId:  string,
  state:              string,
  quantity:           number,    // Absolute for PHYSICAL_COUNT, delta for ADJUSTMENT
  occurredAt:         Date,
  idempotencyKey:     string
}
```

### `PosLocation`
```javascript
{
  externalId:    string,
  name:          string,
  address:       string | null,
  timezone:      string | null,
  phone:         string | null,
  email:         string | null,
  isActive:      boolean,
  raw: object
}
```

### `PosVendor`
```javascript
{
  externalId:   string,
  name:         string,
  status:       'ACTIVE' | 'INACTIVE',
  contactName:  string | null,
  contactEmail: string | null,
  contactPhone: string | null,
  raw: object
}
```

### `PosOrder`
```javascript
{
  externalId:        string,
  locationExternalId: string,
  customerExternalId: string | null,
  state:             'OPEN' | 'COMPLETED' | 'CANCELED' | 'DRAFT',
  lineItems: Array<{
    variationExternalId: string | null,
    name:                string,
    quantity:            number,
    basePriceMoney:      { amount: number, currency: string },
    totalMoney:          { amount: number, currency: string },
  }>,
  totalMoney:    { amount: number, currency: string },
  createdAt:     Date,
  updatedAt:     Date,
  closedAt:      Date | null,
  deliveryAddress: string | null,
  raw: object
}
```

### `PosCustomer`
```javascript
{
  externalId:  string,
  givenName:   string | null,
  familyName:  string | null,
  email:       string | null,
  phone:       string | null,
  groupExternalIds: string[],
  createdAt:   Date,
  updatedAt:   Date,
  raw: object
}
```

### `PosEvent` (normalized webhook event)
```javascript
{
  posType:           string,          // 'square', 'shopify', ...
  eventId:           string,          // POS-native event ID (for dedup)
  eventType:         PosEventType,    // Normalized type enum (see below)
  merchantExternalId: string,
  entityId:          string | null,   // The affected entity's external ID
  locationExternalId: string | null,
  occurredAt:        Date,
  raw: object                         // Original POS payload
}
```

### `PosEventType` Enum
```javascript
const PosEventType = {
  // Catalog
  CATALOG_UPDATED:      'catalog.updated',

  // Inventory
  INVENTORY_UPDATED:    'inventory.updated',

  // Orders
  ORDER_CREATED:        'order.created',
  ORDER_UPDATED:        'order.updated',
  ORDER_COMPLETED:      'order.completed',
  ORDER_CANCELED:       'order.canceled',
  PAYMENT_CREATED:      'payment.created',
  PAYMENT_UPDATED:      'payment.updated',
  REFUND_CREATED:       'refund.created',
  REFUND_UPDATED:       'refund.updated',

  // Customers
  CUSTOMER_CREATED:     'customer.created',
  CUSTOMER_UPDATED:     'customer.updated',

  // Locations
  LOCATION_CREATED:     'location.created',
  LOCATION_UPDATED:     'location.updated',

  // Vendors
  VENDOR_CREATED:       'vendor.created',
  VENDOR_UPDATED:       'vendor.updated',

  // Loyalty (POS-specific — adapters may not support all)
  LOYALTY_EVENT_CREATED:   'loyalty.event.created',
  LOYALTY_ACCOUNT_CREATED: 'loyalty.account.created',
  LOYALTY_ACCOUNT_UPDATED: 'loyalty.account.updated',

  // Invoices
  INVOICE_CREATED:      'invoice.created',
  INVOICE_UPDATED:      'invoice.updated',
  INVOICE_PUBLISHED:    'invoice.published',
  INVOICE_CANCELED:     'invoice.canceled',
  INVOICE_PAYMENT_MADE: 'invoice.payment_made',

  // Auth
  OAUTH_REVOKED:        'oauth.revoked',

  // Subscriptions
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_UPDATED: 'subscription.updated',
};
```

### `PosSyncCursor`
```javascript
// Opaque to callers — adapters encode/decode internally
// Stored in sync_history.sync_cursor JSONB
{
  square: {
    deltaTimestamp: string,   // ISO timestamp for incremental catalog sync
    catalogVersion: number    // For webhook dedup
  }
}
```

---

## `BasePosAdapter` Interface

**File:** `services/pos-adapters/base-adapter.js`

All methods must be implemented. Methods that a POS genuinely does not support should throw `PosAdapterError` with `code: 'NOT_SUPPORTED'`.

```javascript
class BasePosAdapter {

    // ─── Identity ───────────────────────────────────────────────────────────

    /**
     * Returns the POS platform identifier.
     * @returns {string}  e.g. 'square', 'shopify'
     */
    getPosType() { throw new Error('Not implemented'); }

    /**
     * Returns the external merchant ID for this adapter instance.
     * Square: the square_merchant_id
     * @returns {Promise<string>}
     */
    async getMerchantExternalId() { throw new Error('Not implemented'); }


    // ─── Catalog: Read from POS ──────────────────────────────────────────────

    /**
     * Lists all items (catalog objects of type ITEM).
     * Supports pagination via cursor.
     * @param {string|null} cursor   Opaque pagination cursor from previous call
     * @returns {Promise<{ items: PosItem[], cursor: string|null }>}
     */
    async listItems(cursor = null) { throw new Error('Not implemented'); }

    /**
     * Lists all variations (catalog objects of type ITEM_VARIATION).
     * @param {string|null} cursor
     * @returns {Promise<{ variations: PosVariation[], cursor: string|null }>}
     */
    async listVariations(cursor = null) { throw new Error('Not implemented'); }

    /**
     * Lists all categories.
     * @param {string|null} cursor
     * @returns {Promise<{ categories: PosCategory[], cursor: string|null }>}
     */
    async listCategories(cursor = null) { throw new Error('Not implemented'); }

    /**
     * Lists all images.
     * @param {string|null} cursor
     * @returns {Promise<{ images: PosImage[], cursor: string|null }>}
     */
    async listImages(cursor = null) { throw new Error('Not implemented'); }

    /**
     * Performs an incremental (delta) catalog sync since the last cursor.
     * Returns only objects changed after the cursor timestamp.
     * @param {PosSyncCursor|null} cursor
     * @returns {Promise<{
     *   items:       PosItem[],
     *   variations:  PosVariation[],
     *   categories:  PosCategory[],
     *   images:      PosImage[],
     *   deletedIds:  string[],
     *   nextCursor:  PosSyncCursor
     * }>}
     */
    async deltaSyncCatalog(cursor = null) { throw new Error('Not implemented'); }


    // ─── Catalog: Push to POS ────────────────────────────────────────────────

    /**
     * Pushes an update to a variation on the POS.
     * Used for price, cost, and field updates.
     * @param {string}  variationExternalId
     * @param {object}  fields   e.g. { priceMoney: { amount: 1999, currency: 'CAD' } }
     * @returns {Promise<PosVariation>}
     */
    async pushVariationUpdate(variationExternalId, fields) { throw new Error('Not implemented'); }

    /**
     * Pushes a custom attribute value to a catalog object.
     * @param {string} objectExternalId
     * @param {string} attributeKey       e.g. 'case_pack_quantity', 'brand', 'expiry_date'
     * @param {string} value
     * @returns {Promise<void>}
     */
    async pushCustomAttribute(objectExternalId, attributeKey, value) { throw new Error('Not implemented'); }

    /**
     * Pushes an inventory alert threshold (min stock) to the POS if supported.
     * @param {string} variationExternalId
     * @param {string} locationExternalId
     * @param {number} alertThreshold
     * @returns {Promise<void>}
     */
    async pushInventoryAlert(variationExternalId, locationExternalId, alertThreshold) {
        throw new Error('Not implemented');
    }


    // ─── Inventory ───────────────────────────────────────────────────────────

    /**
     * Retrieves current inventory counts for a batch of variations.
     * @param {string[]} variationExternalIds
     * @param {string}   locationExternalId
     * @returns {Promise<PosInventoryCount[]>}
     */
    async batchGetInventory(variationExternalIds, locationExternalId) {
        throw new Error('Not implemented');
    }

    /**
     * Pushes inventory changes (cycle count results) to the POS.
     * @param {PosInventoryChange[]} changes
     * @returns {Promise<{ accepted: number, rejected: number, errors: object[] }>}
     */
    async pushInventoryChanges(changes) { throw new Error('Not implemented'); }


    // ─── Orders ──────────────────────────────────────────────────────────────

    /**
     * Retrieves a single order by external ID.
     * @param {string} orderExternalId
     * @returns {Promise<PosOrder>}
     */
    async getOrder(orderExternalId) { throw new Error('Not implemented'); }

    /**
     * Searches orders by location and date range.
     * Returns orders for sales velocity calculation.
     * @param {string}   locationExternalId
     * @param {object}   dateRange   { startAt: Date, endAt: Date }
     * @param {string|null} cursor
     * @returns {Promise<{ orders: PosOrder[], cursor: string|null }>}
     */
    async searchOrders(locationExternalId, dateRange, cursor = null) {
        throw new Error('Not implemented');
    }


    // ─── Customers ───────────────────────────────────────────────────────────

    /**
     * Retrieves a single customer by external ID.
     * @param {string} customerExternalId
     * @returns {Promise<PosCustomer>}
     */
    async getCustomer(customerExternalId) { throw new Error('Not implemented'); }

    /**
     * Searches for customers by query string.
     * @param {string} query   Phone number, email, or name fragment
     * @param {string|null} cursor
     * @returns {Promise<{ customers: PosCustomer[], cursor: string|null }>}
     */
    async searchCustomers(query, cursor = null) { throw new Error('Not implemented'); }

    /**
     * Creates a new customer on the POS.
     * @param {{ givenName, familyName, email, phone }} data
     * @returns {Promise<PosCustomer>}
     */
    async createCustomer(data) { throw new Error('Not implemented'); }

    /**
     * Adds a customer to a POS customer group.
     * @param {string} customerExternalId
     * @param {string} groupExternalId
     * @returns {Promise<void>}
     */
    async addCustomerToGroup(customerExternalId, groupExternalId) {
        throw new Error('Not implemented');
    }

    /**
     * Removes a customer from a POS customer group.
     * @param {string} customerExternalId
     * @param {string} groupExternalId
     * @returns {Promise<void>}
     */
    async removeCustomerFromGroup(customerExternalId, groupExternalId) {
        throw new Error('Not implemented');
    }


    // ─── Locations ───────────────────────────────────────────────────────────

    /**
     * Lists all store locations.
     * @returns {Promise<PosLocation[]>}
     */
    async listLocations() { throw new Error('Not implemented'); }


    // ─── Vendors ─────────────────────────────────────────────────────────────

    /**
     * Lists all vendors.
     * @param {string|null} cursor
     * @returns {Promise<{ vendors: PosVendor[], cursor: string|null }>}
     */
    async listVendors(cursor = null) { throw new Error('Not implemented'); }

    /**
     * Retrieves a single vendor by external ID.
     * @param {string} vendorExternalId
     * @returns {Promise<PosVendor>}
     */
    async getVendor(vendorExternalId) { throw new Error('Not implemented'); }


    // ─── Webhooks ────────────────────────────────────────────────────────────

    /**
     * Verifies the webhook request signature.
     * Must be called BEFORE processing the event body.
     * @param {object} headers    Raw HTTP headers
     * @param {Buffer} rawBody    Raw (unparsed) request body
     * @returns {boolean}
     */
    verifyWebhookSignature(headers, rawBody) { throw new Error('Not implemented'); }

    /**
     * Normalizes a raw POS webhook payload into a PosEvent.
     * @param {object} rawPayload   The parsed request body
     * @returns {PosEvent}
     */
    normalizeWebhookEvent(rawPayload) { throw new Error('Not implemented'); }

    /**
     * Returns the list of event types this adapter supports.
     * Used for webhook subscription registration.
     * @returns {PosEventType[]}
     */
    getSupportedEventTypes() { throw new Error('Not implemented'); }


    // ─── Sync Cursors ────────────────────────────────────────────────────────

    /**
     * Returns the initial sync cursor (for a fresh install / full sync).
     * @returns {PosSyncCursor}
     */
    getInitialSyncCursor() { throw new Error('Not implemented'); }

    /**
     * Builds the next cursor from the result of the last sync.
     * @param {object} lastSyncResult   Result from deltaSyncCatalog()
     * @returns {PosSyncCursor}
     */
    buildSyncCursor(lastSyncResult) { throw new Error('Not implemented'); }


    // ─── Loyalty (Optional — throw NOT_SUPPORTED if unavailable) ─────────────

    /**
     * Returns the POS loyalty program definition.
     * Not all POS systems have built-in loyalty.
     * @returns {Promise<object>}  POS-specific loyalty program shape
     */
    async getLoyaltyProgram() {
        throw new PosAdapterError('Loyalty not supported by this POS', 'NOT_SUPPORTED');
    }

    /**
     * Searches loyalty events for a date range.
     * @param {object} dateRange  { startAt: Date, endAt: Date }
     * @param {string|null} cursor
     * @returns {Promise<{ events: object[], cursor: string|null }>}
     */
    async searchLoyaltyEvents(dateRange, cursor = null) {
        throw new PosAdapterError('Loyalty not supported by this POS', 'NOT_SUPPORTED');
    }

    /**
     * Retrieves a loyalty account by customer external ID.
     * @param {string} customerExternalId
     * @returns {Promise<object>}  POS-specific loyalty account
     */
    async getLoyaltyAccount(customerExternalId) {
        throw new PosAdapterError('Loyalty not supported by this POS', 'NOT_SUPPORTED');
    }
}
```

---

## `PosAdapterError`

**File:** `services/pos-adapters/pos-adapter-error.js`

```javascript
class PosAdapterError extends Error {
    /**
     * @param {string} message      Human-readable description
     * @param {string} code         Machine-readable code
     * @param {number} [httpStatus] Original HTTP status from POS API (if applicable)
     * @param {object} [raw]        Raw POS error response
     */
    constructor(message, code, httpStatus = null, raw = null) {
        super(message);
        this.name = 'PosAdapterError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.raw = raw;
    }
}

// Standard codes
PosAdapterError.CODES = {
    NOT_FOUND:        'NOT_FOUND',
    UNAUTHORIZED:     'UNAUTHORIZED',
    RATE_LIMITED:     'RATE_LIMITED',
    INVALID_REQUEST:  'INVALID_REQUEST',
    NOT_SUPPORTED:    'NOT_SUPPORTED',   // Method not available for this POS
    CONFLICT:         'CONFLICT',        // Idempotency key reused, version mismatch
    TIMEOUT:          'TIMEOUT',
    UNKNOWN:          'UNKNOWN',
};

module.exports = PosAdapterError;
```

---

## `AdapterFactory`

**File:** `services/pos-adapters/adapter-factory.js`

```javascript
const db = require('../../utils/database');
const { SquareAdapter } = require('./square');
const PosAdapterError = require('./pos-adapter-error');

// Cache: merchantId → { adapter, expiresAt }
const adapterCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes (matches Square client cache)

async function getAdapterForMerchant(merchantId) {
    const cached = adapterCache.get(merchantId);
    if (cached && cached.expiresAt > Date.now()) return cached.adapter;

    const result = await db.query(
        'SELECT pos_type FROM merchants WHERE id = $1 AND is_active = true',
        [merchantId]
    );

    if (!result.rows.length) {
        throw new PosAdapterError(`Merchant ${merchantId} not found`, 'NOT_FOUND');
    }

    const posType = result.rows[0].pos_type || 'square';
    const adapter = createAdapter(posType, merchantId);

    adapterCache.set(merchantId, { adapter, expiresAt: Date.now() + CACHE_TTL_MS });
    return adapter;
}

function createAdapter(posType, merchantId) {
    switch (posType) {
        case 'square':   return new SquareAdapter(merchantId);
        // case 'shopify':  return new ShopifyAdapter(merchantId);
        default:
            throw new PosAdapterError(`Unknown POS type: ${posType}`, 'NOT_SUPPORTED');
    }
}

function invalidateCache(merchantId) {
    adapterCache.delete(merchantId);
}

module.exports = { getAdapterForMerchant, invalidateCache };
```

---

## `SquareAdapter` Implementation Notes

**File:** `services/pos-adapters/square/index.js`

The SquareAdapter is extracted from existing services. The key implementation decisions:

### Catalog Sync
```javascript
async deltaSyncCatalog(cursor) {
    // Delegates to services/square/square-catalog-sync.js
    // cursor.square.deltaTimestamp → Square's begin_time parameter
    // cursor.square.catalogVersion → dedup check against sync_history
    const result = await squareCatalogSync.deltaSyncCatalog(
        this.merchantId,
        cursor?.square?.deltaTimestamp ?? null
    );
    return {
        items:      result.items.map(mapSquareItemToPosItem),
        variations: result.variations.map(mapSquareVariationToPosVariation),
        // ...
        nextCursor: this.buildSyncCursor(result)
    };
}
```

### Webhook Normalization
Square uses 28 distinct event type strings. The normalization maps them to `PosEventType`:

```javascript
const SQUARE_EVENT_MAP = {
    'catalog.version.updated':        PosEventType.CATALOG_UPDATED,
    'inventory.count.updated':        PosEventType.INVENTORY_UPDATED,
    'order.created':                  PosEventType.ORDER_CREATED,
    'order.updated':                  PosEventType.ORDER_UPDATED,
    'order.fulfillment.updated':      PosEventType.ORDER_UPDATED,
    'payment.created':                PosEventType.PAYMENT_CREATED,
    'payment.updated':                PosEventType.PAYMENT_UPDATED,
    'refund.created':                 PosEventType.REFUND_CREATED,
    'refund.updated':                 PosEventType.REFUND_UPDATED,
    'customer.created':               PosEventType.CUSTOMER_CREATED,
    'customer.updated':               PosEventType.CUSTOMER_UPDATED,
    'location.created':               PosEventType.LOCATION_CREATED,
    'location.updated':               PosEventType.LOCATION_UPDATED,
    'vendor.created':                 PosEventType.VENDOR_CREATED,
    'vendor.updated':                 PosEventType.VENDOR_UPDATED,
    'loyalty.event.created':          PosEventType.LOYALTY_EVENT_CREATED,
    'loyalty.account.created':        PosEventType.LOYALTY_ACCOUNT_CREATED,
    'loyalty.account.updated':        PosEventType.LOYALTY_ACCOUNT_UPDATED,
    'invoice.created':                PosEventType.INVOICE_CREATED,
    'invoice.updated':                PosEventType.INVOICE_UPDATED,
    'invoice.published':              PosEventType.INVOICE_PUBLISHED,
    'invoice.canceled':               PosEventType.INVOICE_CANCELED,
    'invoice.payment_made':           PosEventType.INVOICE_PAYMENT_MADE,
    'oauth.authorization.revoked':    PosEventType.OAUTH_REVOKED,
    'subscription.created':           PosEventType.SUBSCRIPTION_CREATED,
    'subscription.updated':           PosEventType.SUBSCRIPTION_UPDATED,
};
```

### Error Mapping
```javascript
function mapSquareError(squareError) {
    const status = squareError.status ?? squareError.httpStatus;
    if (status === 404) return new PosAdapterError(squareError.message, 'NOT_FOUND', status, squareError);
    if (status === 401) return new PosAdapterError(squareError.message, 'UNAUTHORIZED', status, squareError);
    if (status === 429) return new PosAdapterError(squareError.message, 'RATE_LIMITED', status, squareError);
    if (status === 409) return new PosAdapterError(squareError.message, 'CONFLICT', status, squareError);
    return new PosAdapterError(squareError.message, 'UNKNOWN', status, squareError);
}
```

---

## Contract Tests

Every adapter implementation (current and future) must pass the adapter contract test suite.

**File:** `__tests__/services/pos-adapters/base-adapter-contract.test.js`

```javascript
// Contract test template — run against any adapter implementation
function runAdapterContractTests(AdapterClass, mockConfig) {
    describe(`${AdapterClass.name} contract`, () => {
        let adapter;

        beforeEach(() => {
            adapter = new AdapterClass(TEST_MERCHANT_ID);
        });

        test('getPosType() returns a non-empty string', () => {
            expect(typeof adapter.getPosType()).toBe('string');
            expect(adapter.getPosType().length).toBeGreaterThan(0);
        });

        test('normalizeWebhookEvent() returns PosEvent shape', () => {
            const event = adapter.normalizeWebhookEvent(mockConfig.sampleWebhookPayload);
            expect(event).toHaveProperty('eventId');
            expect(event).toHaveProperty('eventType');
            expect(event).toHaveProperty('merchantExternalId');
            expect(event).toHaveProperty('occurredAt');
            expect(Object.values(PosEventType)).toContain(event.eventType);
        });

        test('getInitialSyncCursor() returns a PosSyncCursor', () => {
            const cursor = adapter.getInitialSyncCursor();
            expect(typeof cursor).toBe('object');
        });

        test('getSupportedEventTypes() returns an array of PosEventTypes', () => {
            const types = adapter.getSupportedEventTypes();
            expect(Array.isArray(types)).toBe(true);
            types.forEach(t => {
                expect(Object.values(PosEventType)).toContain(t);
            });
        });
    });
}

// Usage:
runAdapterContractTests(SquareAdapter, { sampleWebhookPayload: squareSamplePayload });
```

---

## Adding a New POS Adapter

Checklist for implementing a second POS (e.g. Shopify):

1. **Create** `services/pos-adapters/shopify/index.js` extending `BasePosAdapter`
2. **Implement** all non-optional methods (throw `NOT_SUPPORTED` for loyalty if unavailable)
3. **Write** mapping functions for Shopify → normalized models
4. **Add** `'shopify'` case to `adapter-factory.js`
5. **Add** `SHOPIFY_API_KEY`, `SHOPIFY_SHOP_DOMAIN`, etc. to `.env.example`
6. **Create** `routes/pos-oauth/shopify.js` for the Shopify OAuth flow
7. **Run** `runAdapterContractTests(ShopifyAdapter, ...)` to verify contract compliance
8. **Populate** `pos_credentials` with `pos_type = 'shopify'` during onboarding

No other existing files need to change.

---

## Mapping Reference: Square API → PosItem

For completeness, the specific field mappings for the `SquareAdapter`:

| Square Field | PosItem Field | Notes |
|-------------|---------------|-------|
| `id` | `externalId` | Square catalog object ID |
| `item_data.name` | `name` | |
| `item_data.description` | `description` | |
| `item_data.description_html` | `descriptionHtml` | |
| `item_data.category_id` | `categoryExternalId` | |
| `item_data.image_ids` | `imageExternalIds` | |
| `item_data.tax_ids` | `taxExternalIds` | |
| `is_deleted` | `isDeleted` | |
| `updated_at` | `posUpdatedAt` | |
| `present_at_all_locations` | `locationPresence.presentAtAll` | |
| `present_at_location_ids` | `locationPresence.presentAtIds` | |
| `absent_at_location_ids` | `locationPresence.absentAtIds` | |
| `item_data.modifier_list_info` | `modifierListInfo` | Stored verbatim |
| `item_data.variations` | — | Returned separately via listVariations() |
| `item_data.item_options` | `itemOptions` | Stored verbatim |
| `custom_attribute_values` | `customAttributes` | Flattened to key:value |
| (entire object) | `raw` | |

| Square Field | PosVariation Field | Notes |
|-------------|-------------------|-------|
| `id` | `externalId` | |
| `item_variation_data.item_id` | `itemExternalId` | |
| `item_variation_data.name` | `name` | |
| `item_variation_data.sku` | `sku` | |
| `item_variation_data.upc` | `upc` | |
| `item_variation_data.price_money` | `priceMoney` | `{ amount, currency }` |
| `item_variation_data.pricing_type` | `pricingType` | |
| `item_variation_data.track_inventory` | `trackInventory` | |
| `is_deleted` | `isDeleted` | |
| `updated_at` | `posUpdatedAt` | |
