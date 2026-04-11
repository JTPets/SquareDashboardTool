# SqTools Code Structure Audit

**Audit Date:** 2026-04-10

---

## Summary

| Metric | Value |
|--------|-------|
| Total Square API Endpoints Called | 30+ unique |
| Files with Square API Calls | 20+ service files |
| Webhook Event Types Handled | 28 |
| Cron Jobs Calling Square | 8 |
| Route Files | 20+ |
| Service Files | 40+ |
| Square Client Patterns | 2 (HTTP client + SDK wrapper) |

---

## Square API Client Infrastructure

### Pattern 1: Low-Level HTTP Client
**File:** `services/square/square-client.js` (~200 lines)

```javascript
// Exports
getMerchantToken(merchantId)    // → Decrypts per-merchant token from DB
makeSquareRequest(endpoint, options)  // → HTTP call with retry, rate-limit handling
```

- Uses `node-fetch` for HTTP calls
- Retry: 3 attempts with exponential backoff (1s base)
- Rate-limit: Respects `Retry-After` header on 429
- Non-retryable: 401, 400, 409, IDEMPOTENCY_KEY_REUSED, VERSION_MISMATCH
- Timeout: 30s per request
- Headers: `Square-Version: 2025-10-16`, `Authorization: Bearer {token}`

### Pattern 2: High-Level SDK Wrapper (Loyalty)
**File:** `services/loyalty-admin/square-api-client.js` (~350 lines)

```javascript
// Class-based convenience wrapper
const client = new SquareApiClient(merchantId);
await client.initialize();  // Loads token
const customer = await client.getCustomer(customerId);
```

- Higher-level abstraction for loyalty-related API calls
- Wraps customer, order, loyalty, and group operations

### Pattern 3: Loyalty Shared Utils
**File:** `services/loyalty-admin/shared-utils.js`

```javascript
squareApiRequest(endpoint, options)  // → Lower-level request handler
getSquareAccessToken(merchantId)     // → Token retrieval
SquareApiError                       // → Custom error class
```

---

## Square API Calls Found (by file)

### Catalog API (6 endpoints)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/catalog/list` | GET | square-catalog-sync.js | 76 | Fetch all items, images, categories |
| `/v2/catalog/search` | POST | square-catalog-sync.js | 413 | Search catalog by type/query |
| `/v2/catalog/search` | POST | catalog-health-service.js | 120 | Audit catalog integrity |
| `/v2/catalog/object/{id}` | GET | square-custom-attributes.js | 147 | Retrieve single object |
| `/v2/catalog/object/{id}` | GET | square-pricing.js | 241 | Get item for price update |
| `/v2/catalog/batch-retrieve` | POST | square-custom-attributes.js | 297 | Batch retrieve objects |
| `/v2/catalog/batch-retrieve` | POST | square-inventory.js | 912 | Batch retrieve for alerts |
| `/v2/catalog/batch-upsert` | POST | square-catalog-sync.js | — | Create/update variations |
| `/v2/catalog/batch-upsert` | POST | square-custom-attributes.js | 344 | Push custom attributes |
| `/v2/catalog/batch-upsert` | POST | square-pricing.js | 125 | Update prices |
| `/v2/catalog/batch-upsert` | POST | square-inventory.js | 964 | Update inventory alerts |

### Inventory API (2 endpoints)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/inventory/counts/batch-retrieve` | POST | square-inventory.js | 101, 177 | Get stock levels |
| `/v2/inventory/changes/batch-create` | POST | square-inventory.js | 243 | Set stock levels (cycle counts) |

### Orders API (2 endpoints)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/orders/search` | POST | square-velocity.js | 92, 401 | Sales velocity calculation |
| `/v2/orders/{id}` | GET | order-handler/order-normalize.js | — | Fetch full order on webhook |

### Customers API (5 endpoints)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/customers` | POST | subscription-create-service.js | 30 | Create customer |
| `/v2/customers/search` | POST | customer-search-service.js | 102 | Find customers |
| `/v2/customers/{id}` | GET | customer-details-service.js | — | Get customer details |
| `/v2/customers/groups` | POST | square-customer-group-service.js | 35 | Create customer group |
| `/v2/customers/{id}/groups/{id}` | PUT/DELETE | square-api-client.js | 159, 172 | Add/remove from group |

### Payments API (2 endpoints)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/cards` | POST | subscription-create-service.js | 47 | Create payment card |
| `/v2/payments` | POST | subscription-create-service.js | 78 | Process payment |

### Locations API (1 endpoint)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/locations` | GET | square-locations.js | 28 | Fetch store locations |

### Vendors API (2 endpoints)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/vendors/search` | POST | square-vendors.js | 146 | Search vendors |
| `/v2/vendors/{id}` | GET | square-vendors.js | 245 | Get single vendor |

### Invoices API (2 endpoints)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/invoices/search` | POST | square-inventory.js | 528 | Find open invoices |
| `/v2/invoices/{id}` | GET | square-inventory.js | 615 | Get invoice details |

### Loyalty API (3 endpoints)

| Endpoint | Method | File | Line | Purpose |
|----------|--------|------|------|---------|
| `/v2/loyalty/programs/main` | GET | square-discount-service.js | 50 | Get loyalty program |
| `/v2/loyalty/events/search` | POST | square-api-client.js | 192 | Search loyalty events |
| `/v2/loyalty/accounts/{id}` | GET | square-api-client.js | 84 | Get loyalty account |

---

## API Routes That Need Refactoring

### Catalog Routes (`routes/catalog.js`)
| Route | Handler | Square Dependency |
|-------|---------|-------------------|
| `GET /api/locations` | `catalogService.getLocations()` | Reads from DB (synced from Square) |
| `GET /api/categories` | `catalogService.getCategories()` | Reads from DB |
| `GET /api/items` | `catalogService.getItems()` | Reads from DB |
| `GET /api/variations` | `catalogService.getVariations()` | Reads from DB |
| `GET /api/variations-with-costs` | `catalogService.getVariationsWithCosts()` | Reads from DB |
| `PATCH /api/variations/:id/extended` | `catalogService.updateExtendedFields()` | **Syncs case_pack to Square** |
| `PATCH /api/variations/:id/min-stock` | `catalogService.updateMinStock()` | **Syncs to Square** |
| `PATCH /api/variations/:id/cost` | `catalogService.updateCost()` | **Syncs vendor cost to Square** |
| `GET /api/inventory` | `catalogService.getInventory()` | Reads from DB |
| `GET /api/low-stock` | `catalogService.getLowStock()` | Reads from DB |
| `POST /api/catalog-audit/fix-locations` | `catalogService.fixLocationMismatches()` | **Calls Square API** |
| `POST /api/catalog-audit/fix-inventory-alerts` | `catalogService.fixInventoryAlerts()` | **Calls Square API** |

### Sync Routes (`routes/sync.js`)
| Route | Handler | Square Dependency |
|-------|---------|-------------------|
| `POST /api/sync` | `squareApi.fullSync()` | **Full sync: all Square APIs** |
| `POST /api/sync-sales` | `squareApi.syncSalesVelocityAllPeriods()` | **Orders search API** |
| `POST /api/sync-smart` | `runSmartSync()` | **Selective Square sync** |
| `GET /api/sync-history` | `getSyncHistory()` | Reads from DB |
| `GET /api/sync-status` | `getSyncStatus()` | Reads from DB |

### Loyalty Routes (`routes/loyalty/square-integration.js`)
| Route | Handler | Square Dependency |
|-------|---------|-------------------|
| `GET /api/loyalty/square-program` | `loyaltyService.getSquareLoyaltyProgram()` | **Loyalty program API** |
| `PUT /api/loyalty/offers/:id/square-tier` | `loyaltyService.linkOfferToSquareTier()` | **Links to Square tier** |
| `POST /api/loyalty/rewards/:id/create-square-reward` | `loyaltyService.createSquareReward()` | **Creates Square reward** |
| `POST /api/loyalty/rewards/sync-to-pos` | `loyaltyService.syncRewardsToPOS()` | **Batch sync to Square** |

### Cycle Count Routes (`routes/cycle-counts.js`)
| Route | Square Dependency |
|-------|-------------------|
| `POST /api/cycle-counts/:id/sync-to-square` | **Pushes counts to Square inventory API** |
| `POST /api/cycle-counts/send-now` | **Batch sync to Square** |

### Expiry Discount Routes (`routes/expiry-discounts.js`)
| Route | Square Dependency |
|-------|-------------------|
| `POST /api/expiry-discounts/apply` | **Creates Square discounts** |
| `POST /api/expiry-discounts/run` | **Automated sync** |

### Subscription Routes (`routes/subscriptions/index.js`)
| Route | Square Dependency |
|-------|-------------------|
| `POST /api/subscriptions/subscribe` | **Creates Square customer, card, payment** |

---

## Data Flow Patterns

### Items: Square → Sync → Database
```
POST /api/sync (manual) OR cron (hourly smart sync)
  → squareApi.fullSync(merchantId)
    → syncLocations()      → GET /v2/locations          → INSERT locations
    → syncVendors()        → POST /v2/vendors/search     → UPSERT vendors
    → syncCatalog()        → GET /v2/catalog/list         → UPSERT items, variations, images, categories
    → syncInventory()      → POST /v2/inventory/counts    → UPSERT inventory_counts
    → syncCommittedInv()   → POST /v2/invoices/search     → UPSERT committed_inventory
    → syncVelocity()       → POST /v2/orders/search       → UPSERT sales_velocity
```

### Items: Database → Push → Square
```
PATCH /api/variations/:id/cost
  → catalogService.updateCost()
    → UPDATE variations SET cost = $1
    → squarePricing.pushPriceToSquare()  → POST /v2/catalog/batch-upsert
```

### Orders: Square → Webhook → Database
```
Square sends webhook: order.created
  → POST /api/webhooks/square
    → webhookProcessor.processWebhook()
      1. Verify HMAC-SHA256 signature
      2. Check idempotency (square_event_id)
      3. Log to webhook_events table
      4. Resolve merchant_id from square_merchant_id
      5. Route to OrderHandler
        → Fetch full order: GET /v2/orders/{id}
        → Update sales_velocity
        → Process loyalty points
        → Ingest delivery orders
        → Track cart activity
```

### Customers: Square → Webhook → Database
```
Square sends webhook: customer.created/updated
  → CustomerHandler.handle()
    → Log event (no persistent customer table — used on-demand via API)
    → Loyalty: customer data cached in loyalty_customers table
```

### Inventory: Square → Webhook → Database
```
Square sends webhook: inventory.count.updated
  → InventoryHandler.handle()
    → UPDATE inventory_counts SET quantity = $1
```

---

## Webhook Event Types Handled (28)

| Category | Events | Handler |
|----------|--------|---------|
| Orders | order.created, order.updated, order.fulfillment.updated | OrderHandler |
| Payments | payment.created, payment.updated | OrderHandler |
| Refunds | refund.created, refund.updated | OrderHandler |
| Catalog | catalog.version.updated | CatalogHandler |
| Vendors | vendor.created, vendor.updated | CatalogHandler |
| Locations | location.created, location.updated | CatalogHandler |
| Inventory | inventory.count.updated | InventoryHandler |
| Invoices | invoice.created, .updated, .published, .canceled, .deleted, .payment_made, .payment_failed | InventoryHandler + SubscriptionHandler |
| Customers | customer.created, customer.updated | CustomerHandler |
| Loyalty | loyalty.event.created, loyalty.account.created, loyalty.account.updated, loyalty.program.updated | LoyaltyHandler |
| Gift Cards | gift_card.customer_linked | LoyaltyHandler |
| OAuth | oauth.authorization.revoked | OAuthHandler |
| Subscriptions | subscription.created, subscription.updated | SubscriptionHandler |

---

## Cron Jobs That Call Square (8)

| Job | Schedule | Square APIs Used |
|-----|----------|-----------------|
| Smart sync | Hourly | All catalog/inventory APIs |
| Sales velocity sync | Configured | Orders search |
| Cycle count batch | 3 AM daily | Inventory batch-create |
| Expiry discount | 5 AM daily | Catalog batch-upsert (discounts) |
| Loyalty catchup | Every 30 min | Orders search, loyalty events |
| Loyalty audit | 2 AM daily | Loyalty events search |
| Committed inventory reconciliation | Every 2 hours | Invoices search |
| Loyalty sync retry | Every 15 min | Retries failed loyalty syncs |

---

## Services Directory Structure

### Square Core (`services/square/` — 9 files)
| File | Lines | Key Exports |
|------|-------|-------------|
| `square-client.js` | ~200 | `getMerchantToken`, `makeSquareRequest` |
| `square-catalog-sync.js` | ~600 | `syncCatalog`, `deltaSyncCatalog` |
| `square-inventory.js` | ~1000 | `syncInventory`, `syncCommittedInventory`, `pushInventoryToSquare` |
| `square-velocity.js` | ~400 | `syncSalesVelocity`, `updateSalesVelocityFromOrder` |
| `square-custom-attributes.js` | ~850 | `pushCasePackToSquare`, `pushBrandsToSquare`, `pushExpiryDatesToSquare` |
| `square-pricing.js` | ~250 | `pushPriceToSquare`, `pushCostToSquare` |
| `square-locations.js` | ~100 | `syncLocations` |
| `square-vendors.js` | ~250 | `syncVendors`, `getVendor` |
| `square-diagnostics.js` | ~200 | `fixLocationMismatches`, `fixInventoryAlerts` |
| `square-sync-orchestrator.js` | ~100 | `fullSync` |

### Webhook Handlers (`services/webhook-handlers/`)
| File | Handles |
|------|---------|
| `webhook-processor.js` | Signature verification, routing, idempotency |
| `index.js` | Handler registry (200+ lines) |
| `order-handler/index.js` | Order, payment, refund events |
| `order-handler/order-normalize.js` | Order data normalization |
| `catalog-handler.js` | Catalog, vendor, location events |
| `inventory-handler.js` | Inventory, invoice events |
| `customer-handler.js` | Customer events |
| `loyalty-handler.js` | Loyalty, gift card events |
| `oauth-handler.js` | OAuth revocation |
| `subscription-handler.js` | Subscription, invoice payment events |

### Loyalty Admin (`services/loyalty-admin/` — 38 test files)
| File | Purpose |
|------|---------|
| `square-api-client.js` | SDK wrapper class |
| `shared-utils.js` | Core request handler |
| `square-discount-service.js` | Discount/pricing rule operations |
| `square-reward-service.js` | Reward creation and sync |
| `customer-search-service.js` | Customer search |
| `customer-details-service.js` | Customer info retrieval |
| `square-customer-group-service.js` | Customer group management |
| `square-discount-catalog-service.js` | Discount catalog operations |

### Catalog Services (`services/catalog/`)
| File | Purpose |
|------|---------|
| `item-service.js` | Item CRUD (DB reads + Square sync on write) |
| `variation-service.js` | Variation CRUD |
| `inventory-service.js` | Stock level management |
| `catalog-health-service.js` | Audit catalog integrity |
| `location-health-service.js` | Audit location mismatches |

---

## Existing Abstraction Layers

### Service Layer — YES (partial)
- Routes are thin: validation + call service
- Services contain business logic
- But services directly call Square APIs — **no adapter pattern**

### Multi-Tenant Pattern — YES (strong)
- `req.merchantContext.id` used throughout
- Every DB query filters by `merchant_id`
- Every Square API call uses per-merchant token

### Adapter Pattern — NO
- No `PosAdapter` interface exists
- Square API calls are embedded directly in service functions
- Two separate client implementations (HTTP + SDK wrapper) with no shared interface
- Custom attributes, pricing, inventory sync are all Square-specific implementations

---

## Middleware Stack (Request Processing Order)

```
1. Trust proxy (Cloudflare)
2. Helmet security headers
3. Request correlation ID
4. Rate limiting (9 limiters)
5. CORS
6. Body parsing (JSON, 5MB) + raw body for webhooks
7. Session management (connect-pg-simple)
8. Page auth redirect
9. Static files
10. Request logging
11. Auth routes (/api/auth) — no merchant needed
12. Square OAuth routes (/api/square/oauth) — no merchant needed
13. Merchant context loading (loadMerchantContext)
14. API authentication (requireAuth)
15. Subscription enforcement (requireValidSubscription)
16. Feature gating + permissions
17. Route handlers
```

---

## Custom Attributes Pushed to Square

| Attribute | Square Key | Source | File |
|-----------|-----------|--------|------|
| Case Pack Quantity | `case_pack_quantity` | variations.case_pack | square-custom-attributes.js |
| Brand | `brand` | variations.brand | square-custom-attributes.js |
| Expiry Date | `expiry_date` | variation_expiration | square-custom-attributes.js |
| Min Stock Threshold | Location override | variation_location_settings | square-inventory.js |
