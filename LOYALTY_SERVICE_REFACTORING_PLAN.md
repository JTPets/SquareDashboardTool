# Loyalty Service Layer Refactoring Plan

**Date:** January 22, 2026
**Goal:** Make tracking bugs easier to diagnose through improved observability, testability, and service separation
**Current State:** 5,035 lines in single file, 95% feature complete, tracking bugs exist

---

## Executive Summary

This plan breaks the loyalty service refactoring into **8 phases**, each with:
- Clear deliverables
- Validation criteria (how to confirm it's done correctly)
- Rollback strategy (how to undo if problems arise)
- Zero downtime deployment approach

**Estimated scope:** Each phase is independent and can be deployed separately.

---

## Current Architecture Analysis

### The Monolith Problem

```
utils/loyalty-service.js (5,035 lines)
├── 55 exported functions
├── Direct database access (90% of functions)
├── Direct Square API calls (40% of functions)
├── Mixed concerns (business logic + I/O + orchestration)
└── Limited observability for debugging
```

### Database Tables (9 tables)

| Table | Purpose | Key for Tracking |
|-------|---------|------------------|
| `loyalty_offers` | Defines frequent buyer programs | Offer configuration |
| `loyalty_qualifying_variations` | Maps variations to offers | What qualifies |
| `loyalty_purchase_events` | Records all purchases/refunds | **CRITICAL: Purchase tracking** |
| `loyalty_rewards` | Tracks reward state machine | **CRITICAL: Reward state** |
| `loyalty_redemptions` | Records redemptions | Redemption history |
| `loyalty_audit_logs` | Complete audit trail | **CRITICAL: Debug trail** |
| `loyalty_settings` | Per-merchant config | Feature flags |
| `loyalty_customer_summary` | Denormalized customer state | Performance cache |
| `loyalty_customers` | Customer cache | Lookup performance |

### Current Tracking Gaps (Why Bugs Are Hard to Diagnose)

| Gap | Impact | Example Bug Scenario |
|-----|--------|---------------------|
| No correlation IDs | Can't trace related operations | "Why did this purchase not count?" |
| Square API success not logged | Only see failures | "Did we even call Square?" |
| Customer lookup method not recorded | Don't know which fallback worked | "How did we identify this customer?" |
| No per-line-item logging | Bulk processing is opaque | "Which line item failed?" |
| Async operations fire-and-forget | Lost context on failures | "Why wasn't the discount created?" |
| No timing information | Can't identify slow paths | "Why is backfill so slow?" |

---

## Target Architecture

```
services/loyalty/
├── index.js                    # Re-exports (backward compatible)
├── loyalty-logger.js           # Phase 1: Enhanced logging
├── loyalty-tracer.js           # Phase 2: Correlation ID tracking
├── square-client.js            # Phase 3: Isolated API layer
├── customer-service.js         # Phase 4: Customer identification
├── offer-service.js            # Phase 5: Offer management
├── purchase-service.js         # Phase 6: Purchase processing
├── reward-service.js           # Phase 7: Reward state machine
└── webhook-service.js          # Phase 8: Orchestration layer
```

---

## Phase 1: Enhanced Logging Layer

**Goal:** Add structured logging without changing any business logic
**Risk:** LOW - Additive only
**Validation:** Logs appear in production, no behavior changes

### Step 1.1: Create Logging Utility

Create `services/loyalty/loyalty-logger.js`:

```javascript
// Structured logging with consistent format
const loyaltyLogger = {
  purchase: (data) => logger.info('[LOYALTY:PURCHASE]', data),
  reward: (data) => logger.info('[LOYALTY:REWARD]', data),
  redemption: (data) => logger.info('[LOYALTY:REDEMPTION]', data),
  squareApi: (data) => logger.info('[LOYALTY:SQUARE_API]', data),
  customer: (data) => logger.info('[LOYALTY:CUSTOMER]', data),
  error: (data) => logger.error('[LOYALTY:ERROR]', data),
  debug: (data) => logger.debug('[LOYALTY:DEBUG]', data),
};
```

**Validation Criteria:**
- [ ] File created at `services/loyalty/loyalty-logger.js`
- [ ] Exports `loyaltyLogger` object with all methods
- [ ] Each method prefixes logs with `[LOYALTY:*]`
- [ ] Unit test confirms log format

### Step 1.2: Add Square API Call Logging

Wrap all Square API calls with success logging:

```javascript
// BEFORE (current)
const response = await fetch(url, options);
if (!response.ok) {
  logger.error('Failed to fetch', { status: response.status });
}

// AFTER (enhanced)
const startTime = Date.now();
const response = await fetch(url, options);
const duration = Date.now() - startTime;

loyaltyLogger.squareApi({
  endpoint: url,
  method: options.method,
  status: response.status,
  duration,
  success: response.ok,
  merchantId,
});

if (!response.ok) {
  loyaltyLogger.error({ ... });
}
```

**Locations to update:**
1. `prefetchRecentLoyaltyEvents` - Line 113
2. `getCustomerDetails` - Line 471
3. `lookupCustomerFromLoyalty` - Line 556
4. `createRewardCustomerGroup` - Line 3210
5. `addCustomerToGroup` - Line 3278
6. `removeCustomerFromGroup` - Line 3333
7. `deleteCustomerGroup` - Line 3387
8. `createRewardDiscount` - Line 3460
9. `deleteRewardDiscountObjects` - Line 3660

**Validation Criteria:**
- [ ] All 9 Square API call sites have logging added
- [ ] Logs include: endpoint, method, status, duration, merchantId
- [ ] Run backfill on test merchant - confirm API calls logged
- [ ] Verify no duplicate logging (check log count matches expected)

### Step 1.3: Add Per-Line-Item Logging

In `processOrderForLoyalty`, log each line item decision:

```javascript
// For each line item in order
loyaltyLogger.debug({
  action: 'LINE_ITEM_EVALUATION',
  orderId: order.id,
  lineItemId: lineItem.uid,
  variationId: lineItem.catalog_object_id,
  quantity: lineItem.quantity,
  unitPrice: unitPriceCents,
  totalPrice: totalMoneyCents,
  isFree: isFree,
  qualifyingOffer: offer?.id || null,
  decision: isFree ? 'SKIP_FREE' : offer ? 'QUALIFIES' : 'NO_OFFER',
});
```

**Validation Criteria:**
- [ ] Each line item generates one log entry
- [ ] Log includes decision reason (SKIP_FREE, QUALIFIES, NO_OFFER)
- [ ] Test with order containing: qualifying item, non-qualifying item, free item
- [ ] Verify all three generate correct decision logs

### Step 1.4: Add Customer Lookup Method Logging

Log which customer identification method succeeded:

```javascript
// In getCustomerDetails/lookupCustomer*
loyaltyLogger.customer({
  action: 'CUSTOMER_LOOKUP',
  orderId,
  method: 'ORDER_CUSTOMER_ID' | 'TENDER_CUSTOMER_ID' | 'LOYALTY_API' | 'ORDER_REWARDS' | 'FULFILLMENT_RECIPIENT',
  success: true/false,
  customerId: result?.id || null,
  fallbackUsed: true/false,
});
```

**Validation Criteria:**
- [ ] Each customer lookup attempt logged with method name
- [ ] Final success logged with which method worked
- [ ] Test order with no customer_id - verify fallback chain logged
- [ ] Test order with customer_id - verify direct lookup logged

### Phase 1 Rollback
Remove logging calls - no business logic changed.

### Phase 1 Completion Checklist
- [ ] `services/loyalty/loyalty-logger.js` created and tested
- [ ] 9 Square API locations updated with timing logs
- [ ] Line item evaluation logging added
- [ ] Customer lookup method logging added
- [ ] Deploy to staging, verify logs appear
- [ ] Deploy to production
- [ ] Monitor for 24 hours - no errors introduced

---

## Phase 2: Correlation ID Tracking

**Goal:** Link related operations with a single trace ID
**Risk:** LOW - Additive only
**Validation:** Single trace ID appears across all logs for one order

### Step 2.1: Create Tracer Utility

Create `services/loyalty/loyalty-tracer.js`:

```javascript
const { randomUUID } = require('crypto');

class LoyaltyTracer {
  constructor() {
    this.traceId = null;
    this.spans = [];
  }

  startTrace(context = {}) {
    this.traceId = randomUUID();
    this.spans = [];
    this.context = context;
    return this.traceId;
  }

  span(name, data = {}) {
    const span = {
      traceId: this.traceId,
      spanId: randomUUID(),
      name,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.spans.push(span);
    return span;
  }

  endTrace() {
    const result = {
      traceId: this.traceId,
      context: this.context,
      spans: this.spans,
      duration: this.spans.length > 0
        ? Date.now() - new Date(this.spans[0].timestamp).getTime()
        : 0,
    };
    this.traceId = null;
    this.spans = [];
    return result;
  }
}

// Request-scoped tracer (for webhook processing)
const tracerStore = new Map();

function getTracer(requestId) {
  if (!tracerStore.has(requestId)) {
    tracerStore.set(requestId, new LoyaltyTracer());
  }
  return tracerStore.get(requestId);
}

function cleanupTracer(requestId) {
  tracerStore.delete(requestId);
}

module.exports = { LoyaltyTracer, getTracer, cleanupTracer };
```

**Validation Criteria:**
- [ ] File created at `services/loyalty/loyalty-tracer.js`
- [ ] Unit test: startTrace returns UUID
- [ ] Unit test: span records timestamp and data
- [ ] Unit test: endTrace calculates duration
- [ ] Unit test: getTracer returns same instance for same requestId

### Step 2.2: Add Trace ID to Audit Logs

Modify `logAuditEvent` to include trace_id:

```javascript
// Add column to loyalty_audit_logs if not exists
// ALTER TABLE loyalty_audit_logs ADD COLUMN trace_id UUID;

async function logAuditEvent(event, client = null, traceId = null) {
  // ... existing code ...

  const query = `
    INSERT INTO loyalty_audit_logs
    (merchant_id, action, ..., trace_id)
    VALUES ($1, $2, ..., $N)
  `;

  // Include traceId in values
}
```

**Validation Criteria:**
- [ ] Migration adds `trace_id` column to `loyalty_audit_logs`
- [ ] `logAuditEvent` accepts optional traceId parameter
- [ ] Existing calls still work (traceId defaults to null)
- [ ] Query audit logs by trace_id returns related events

### Step 2.3: Integrate Tracing into Order Processing

Wrap `processOrderForLoyalty` with tracing:

```javascript
async function processOrderForLoyalty(order, merchantId, options = {}) {
  const tracer = new LoyaltyTracer();
  const traceId = tracer.startTrace({
    orderId: order.id,
    merchantId,
    source: options.source || 'WEBHOOK',
  });

  try {
    tracer.span('START_ORDER_PROCESSING', { lineItemCount: order.line_items?.length });

    // ... existing customer lookup ...
    tracer.span('CUSTOMER_IDENTIFIED', { customerId, method: lookupMethod });

    // ... for each line item ...
    tracer.span('LINE_ITEM_PROCESSED', { variationId, decision });

    // ... on reward earned ...
    tracer.span('REWARD_EARNED', { rewardId, offerId });

    const trace = tracer.endTrace();
    loyaltyLogger.debug({ action: 'ORDER_TRACE_COMPLETE', trace });

    return result;
  } catch (error) {
    tracer.span('ERROR', { error: error.message });
    const trace = tracer.endTrace();
    loyaltyLogger.error({ action: 'ORDER_TRACE_FAILED', trace, error: error.message });
    throw error;
  }
}
```

**Validation Criteria:**
- [ ] Each order processing generates one trace with multiple spans
- [ ] Trace ID appears in all related log entries
- [ ] Error cases include trace with ERROR span
- [ ] Query: `SELECT * FROM loyalty_audit_logs WHERE trace_id = ?` returns all related events

### Step 2.4: Add Trace ID to Purchase Events Table

```sql
-- Migration
ALTER TABLE loyalty_purchase_events ADD COLUMN trace_id UUID;
CREATE INDEX idx_purchase_events_trace_id ON loyalty_purchase_events(trace_id);
```

Update `processQualifyingPurchase` to record trace_id.

**Validation Criteria:**
- [ ] Migration applied successfully
- [ ] New purchase events have trace_id populated
- [ ] Can query all purchases from single order processing by trace_id

### Phase 2 Rollback
1. Remove trace_id columns (data loss for new traces only)
2. Remove tracer calls from functions
3. No business logic affected

### Phase 2 Completion Checklist
- [ ] `services/loyalty/loyalty-tracer.js` created and tested
- [ ] Database migration for trace_id columns applied
- [ ] `processOrderForLoyalty` wrapped with tracing
- [ ] `processQualifyingPurchase` records trace_id
- [ ] `logAuditEvent` records trace_id
- [ ] End-to-end test: single order generates traceable path
- [ ] Deploy and verify traces appear in production logs

---

## Phase 3: Square API Client Extraction

**Goal:** Isolate all Square API calls into one mockable module
**Risk:** MEDIUM - Changing call sites
**Validation:** All Square API calls go through client, existing tests pass

### Step 3.1: Create Square Client Module

Create `services/loyalty/square-client.js`:

```javascript
const { decryptToken, isEncryptedToken } = require('../../utils/token-encryption');
const db = require('../../utils/database');
const { loyaltyLogger } = require('./loyalty-logger');

class LoyaltySquareClient {
  constructor(merchantId) {
    this.merchantId = merchantId;
    this.accessToken = null;
    this.baseUrl = 'https://connect.squareup.com/v2';
    this.squareVersion = '2025-01-16';
  }

  async initialize() {
    const result = await db.query(
      'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
      [this.merchantId]
    );

    if (result.rows.length === 0 || !result.rows[0].square_access_token) {
      throw new Error(`No access token for merchant ${this.merchantId}`);
    }

    const rawToken = result.rows[0].square_access_token;
    this.accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;
    return this;
  }

  async request(method, endpoint, body = null, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const startTime = Date.now();

    const fetchOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': this.squareVersion,
      },
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    try {
      const response = await fetchWithTimeout(url, fetchOptions, options.timeout || 15000);
      const duration = Date.now() - startTime;

      loyaltyLogger.squareApi({
        endpoint,
        method,
        status: response.status,
        duration,
        success: response.ok,
        merchantId: this.merchantId,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new SquareApiError(response.status, errorBody, endpoint);
      }

      return await response.json();
    } catch (error) {
      const duration = Date.now() - startTime;
      loyaltyLogger.error({
        action: 'SQUARE_API_ERROR',
        endpoint,
        method,
        duration,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  // Convenience methods
  async getCustomer(customerId) {
    return this.request('GET', `/customers/${customerId}`);
  }

  async searchCustomers(query) {
    return this.request('POST', '/customers/search', query);
  }

  async searchLoyaltyEvents(query) {
    return this.request('POST', '/loyalty/events/search', query);
  }

  async getLoyaltyProgram() {
    return this.request('GET', '/loyalty/programs/main');
  }

  async createCustomerGroup(body) {
    return this.request('POST', '/customers/groups', body);
  }

  async addCustomerToGroup(customerId, groupId) {
    return this.request('PUT', `/customers/${customerId}/groups/${groupId}`);
  }

  async removeCustomerFromGroup(customerId, groupId) {
    return this.request('DELETE', `/customers/${customerId}/groups/${groupId}`);
  }

  async deleteCustomerGroup(groupId) {
    return this.request('DELETE', `/customers/groups/${groupId}`);
  }

  async batchUpsertCatalog(body) {
    return this.request('POST', '/catalog/batch-upsert', body);
  }

  async deleteCatalogObject(objectId) {
    return this.request('DELETE', `/catalog/object/${objectId}`);
  }

  async getOrder(orderId) {
    return this.request('GET', `/orders/${orderId}`);
  }

  async searchOrders(body) {
    return this.request('POST', '/orders/search', body);
  }
}

class SquareApiError extends Error {
  constructor(status, body, endpoint) {
    super(`Square API error ${status} on ${endpoint}: ${body}`);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

module.exports = { LoyaltySquareClient, SquareApiError };
```

**Validation Criteria:**
- [ ] File created at `services/loyalty/square-client.js`
- [ ] Unit tests for each convenience method (mocked fetch)
- [ ] Error handling test: non-200 response throws SquareApiError
- [ ] Timeout test: long request triggers timeout error
- [ ] Logging test: all requests logged with timing

### Step 3.2: Migrate First Function (Low Risk)

Start with `getSquareLoyaltyProgram` - simple, read-only:

```javascript
// BEFORE
async function getSquareLoyaltyProgram(merchantId) {
  const tokenResult = await db.query(...);
  const accessToken = ...;
  const response = await fetch('https://connect.squareup.com/v2/loyalty/programs/main', ...);
  // ... error handling ...
  return data;
}

// AFTER
async function getSquareLoyaltyProgram(merchantId) {
  const client = await new LoyaltySquareClient(merchantId).initialize();
  const data = await client.getLoyaltyProgram();
  return data.program;
}
```

**Validation Criteria:**
- [ ] Function still returns same data structure
- [ ] Manual test: call function, verify response matches previous
- [ ] Error case: invalid merchant returns appropriate error
- [ ] Logs show Square API call through new client

### Step 3.3: Migrate Customer Lookup Functions

Update in order:
1. `getCustomerDetails` (line 431)
2. `lookupCustomerFromLoyalty` (line 516)
3. `lookupCustomerFromOrderRewards` (line 779)

**Validation Criteria per function:**
- [ ] Same return value structure
- [ ] Error handling preserved
- [ ] Logging through new client
- [ ] Existing tests still pass

### Step 3.4: Migrate Customer Group Functions

Update:
1. `createRewardCustomerGroup` (line 3180)
2. `addCustomerToGroup` (line 3258)
3. `removeCustomerFromGroup` (line 3313)
4. `deleteCustomerGroup` (line 3367)

**Validation Criteria:**
- [ ] Group creation still works
- [ ] Customer assignment still works
- [ ] Cleanup operations still work
- [ ] Error handling preserved (especially for "not found" cases)

### Step 3.5: Migrate Catalog Functions

Update:
1. `createRewardDiscount` (line 3421)
2. `deleteRewardDiscountObjects` (line 3631)

**Validation Criteria:**
- [ ] Discount creation produces valid Square catalog objects
- [ ] Deletion removes all related objects
- [ ] Idempotency keys still work

### Phase 3 Rollback
Revert to direct fetch calls - client is a wrapper only.

### Phase 3 Completion Checklist
- [ ] `services/loyalty/square-client.js` created with full test coverage
- [ ] All 12+ Square API call sites migrated to use client
- [ ] No direct `fetch('https://connect.squareup.com/...)` calls remain in loyalty-service.js
- [ ] All existing functionality preserved
- [ ] Client can be mocked for future unit tests
- [ ] Deploy and monitor for Square API errors

---

## Phase 4: Customer Service Extraction

**Goal:** Isolate customer identification logic for easier debugging
**Risk:** MEDIUM - Core tracking functionality
**Validation:** Customer identification works via all 5 methods

### Step 4.1: Create Customer Service Module

Create `services/loyalty/customer-service.js`:

```javascript
const { LoyaltySquareClient } = require('./square-client');
const { loyaltyLogger } = require('./loyalty-logger');
const db = require('../../utils/database');

class LoyaltyCustomerService {
  constructor(merchantId, tracer = null) {
    this.merchantId = merchantId;
    this.tracer = tracer;
    this.squareClient = null;
  }

  async initialize() {
    this.squareClient = await new LoyaltySquareClient(this.merchantId).initialize();
    return this;
  }

  /**
   * Identify customer from order using 5 fallback methods
   * Returns { customerId, method, customer } or null
   */
  async identifyCustomerFromOrder(order, options = {}) {
    const methods = [
      { name: 'ORDER_CUSTOMER_ID', fn: () => this.fromOrderCustomerId(order) },
      { name: 'TENDER_CUSTOMER_ID', fn: () => this.fromTenderCustomerId(order) },
      { name: 'LOYALTY_API', fn: () => this.fromLoyaltyApi(order.id) },
      { name: 'ORDER_REWARDS', fn: () => this.fromOrderRewards(order) },
      { name: 'FULFILLMENT_RECIPIENT', fn: () => this.fromFulfillmentRecipient(order) },
    ];

    for (const method of methods) {
      try {
        this.tracer?.span(`CUSTOMER_LOOKUP_ATTEMPT`, { method: method.name });

        const result = await method.fn();

        if (result?.customerId) {
          loyaltyLogger.customer({
            action: 'CUSTOMER_IDENTIFIED',
            orderId: order.id,
            method: method.name,
            customerId: result.customerId,
            merchantId: this.merchantId,
          });

          this.tracer?.span(`CUSTOMER_LOOKUP_SUCCESS`, {
            method: method.name,
            customerId: result.customerId
          });

          return { ...result, method: method.name };
        }
      } catch (error) {
        loyaltyLogger.debug({
          action: 'CUSTOMER_LOOKUP_FAILED',
          orderId: order.id,
          method: method.name,
          error: error.message,
          merchantId: this.merchantId,
        });
      }
    }

    loyaltyLogger.customer({
      action: 'CUSTOMER_NOT_IDENTIFIED',
      orderId: order.id,
      merchantId: this.merchantId,
    });

    this.tracer?.span(`CUSTOMER_LOOKUP_EXHAUSTED`);
    return null;
  }

  async fromOrderCustomerId(order) {
    if (!order.customer_id) return null;
    const customer = await this.getCustomerDetails(order.customer_id);
    return customer ? { customerId: order.customer_id, customer } : null;
  }

  async fromTenderCustomerId(order) {
    const tenders = order.tenders || [];
    for (const tender of tenders) {
      if (tender.customer_id) {
        const customer = await this.getCustomerDetails(tender.customer_id);
        if (customer) return { customerId: tender.customer_id, customer };
      }
    }
    return null;
  }

  async fromLoyaltyApi(orderId) {
    // Search loyalty events for this order
    const data = await this.squareClient.searchLoyaltyEvents({
      query: {
        filter: {
          order_filter: { order_id: orderId }
        }
      }
    });

    const event = data.events?.[0];
    if (!event?.loyalty_account_id) return null;

    // Get customer from loyalty account
    const accountData = await this.squareClient.request(
      'GET',
      `/loyalty/accounts/${event.loyalty_account_id}`
    );

    const customerId = accountData.loyalty_account?.customer_id;
    if (!customerId) return null;

    const customer = await this.getCustomerDetails(customerId);
    return customer ? { customerId, customer } : null;
  }

  async fromOrderRewards(order) {
    const rewards = order.rewards || [];
    for (const reward of rewards) {
      if (reward.id) {
        try {
          const rewardData = await this.squareClient.request('GET', `/loyalty/rewards/${reward.id}`);
          const accountId = rewardData.reward?.loyalty_account_id;
          if (accountId) {
            const accountData = await this.squareClient.request('GET', `/loyalty/accounts/${accountId}`);
            const customerId = accountData.loyalty_account?.customer_id;
            if (customerId) {
              const customer = await this.getCustomerDetails(customerId);
              if (customer) return { customerId, customer };
            }
          }
        } catch (error) {
          // Continue to next reward
        }
      }
    }
    return null;
  }

  async fromFulfillmentRecipient(order) {
    const fulfillments = order.fulfillments || [];
    for (const fulfillment of fulfillments) {
      const recipient = fulfillment.pickup_details?.recipient ||
                        fulfillment.shipment_details?.recipient;

      if (recipient?.phone_number || recipient?.email_address) {
        const searchQuery = {
          query: {
            filter: {
              phone_number: recipient.phone_number ? { exact: recipient.phone_number } : undefined,
              email_address: recipient.email_address ? { exact: recipient.email_address } : undefined,
            }
          }
        };

        const data = await this.squareClient.searchCustomers(searchQuery);
        const customer = data.customers?.[0];
        if (customer) return { customerId: customer.id, customer };
      }
    }
    return null;
  }

  async getCustomerDetails(customerId) {
    // Check cache first
    const cached = await this.getCachedCustomer(customerId);
    if (cached) return cached;

    // Fetch from Square
    try {
      const data = await this.squareClient.getCustomer(customerId);
      const customer = data.customer;

      if (customer) {
        await this.cacheCustomer(customer);
      }

      return customer;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async getCachedCustomer(customerId) {
    const result = await db.query(
      `SELECT * FROM loyalty_customers
       WHERE square_customer_id = $1 AND merchant_id = $2
       AND updated_at > NOW() - INTERVAL '24 hours'`,
      [customerId, this.merchantId]
    );
    return result.rows[0] || null;
  }

  async cacheCustomer(customer) {
    await db.query(
      `INSERT INTO loyalty_customers (square_customer_id, merchant_id, data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (square_customer_id, merchant_id)
       DO UPDATE SET data = $3, updated_at = NOW()`,
      [customer.id, this.merchantId, JSON.stringify(customer)]
    );
  }

  async searchCustomers(query) {
    // Search cache first, then Square API
    // ... implementation ...
  }
}

module.exports = { LoyaltyCustomerService };
```

**Validation Criteria:**
- [ ] File created at `services/loyalty/customer-service.js`
- [ ] Unit tests for each identification method (mocked Square client)
- [ ] Integration test: order with customer_id identifies correctly
- [ ] Integration test: order without customer_id tries all fallbacks
- [ ] Logging shows which method succeeded
- [ ] Tracer spans recorded for each attempt

### Step 4.2: Update processOrderForLoyalty to Use Customer Service

```javascript
// In loyalty-service.js
async function processOrderForLoyalty(order, merchantId, options = {}) {
  const tracer = new LoyaltyTracer();
  tracer.startTrace({ orderId: order.id, merchantId });

  const customerService = await new LoyaltyCustomerService(merchantId, tracer).initialize();
  const customerResult = await customerService.identifyCustomerFromOrder(order);

  if (!customerResult) {
    tracer.span('NO_CUSTOMER_SKIP');
    return { skipped: true, reason: 'no_customer' };
  }

  const { customerId, customer, method } = customerResult;
  tracer.span('CUSTOMER_RESOLVED', { customerId, method });

  // ... rest of processing ...
}
```

**Validation Criteria:**
- [ ] Customer identification delegated to service
- [ ] Tracer receives spans from service
- [ ] Backward compatible - same return values
- [ ] Logs now show identification method used

### Step 4.3: Add Customer Identification Debugging Endpoint

Add to `routes/loyalty.js`:

```javascript
// Debug endpoint for investigating customer identification issues
router.get('/debug/customer-identification/:orderId',
  requireAuth,
  requireMerchant,
  async (req, res) => {
    const { orderId } = req.params;
    const merchantId = req.merchantContext.merchantId;

    // Fetch order from Square
    const client = await new LoyaltySquareClient(merchantId).initialize();
    const orderData = await client.getOrder(orderId);

    // Run identification with detailed logging
    const customerService = await new LoyaltyCustomerService(merchantId).initialize();
    const debugResults = await customerService.debugIdentification(orderData.order);

    res.json({
      orderId,
      order: {
        customer_id: orderData.order.customer_id,
        tenders: orderData.order.tenders?.map(t => ({ customer_id: t.customer_id })),
        rewards: orderData.order.rewards,
        fulfillments: orderData.order.fulfillments?.length || 0,
      },
      identification: debugResults,
    });
  }
);
```

**Validation Criteria:**
- [ ] Endpoint returns detailed identification attempts
- [ ] Shows which methods were tried and why they failed/succeeded
- [ ] Useful for debugging "why didn't this order get loyalty credit?"

### Phase 4 Rollback
Revert to inline customer lookup code in loyalty-service.js.

### Phase 4 Completion Checklist
- [ ] `services/loyalty/customer-service.js` created with full test coverage
- [ ] All customer lookup logic moved to service
- [ ] `processOrderForLoyalty` uses customer service
- [ ] Debug endpoint added for investigation
- [ ] Logs clearly show identification method
- [ ] Deploy and verify customer identification still works

---

## Phase 5: Offer Service Extraction

**Goal:** Isolate offer CRUD operations
**Risk:** LOW - Simple CRUD, no Square API
**Validation:** Offer management UI still works

### Step 5.1: Create Offer Service Module

Create `services/loyalty/offer-service.js`:

```javascript
const db = require('../../utils/database');
const { loyaltyLogger } = require('./loyalty-logger');

class LoyaltyOfferService {
  constructor(merchantId) {
    this.merchantId = merchantId;
  }

  async createOffer(offerData) {
    // Existing createOffer logic
  }

  async getOffers(options = {}) {
    // Existing getOffers logic
  }

  async getOfferById(offerId) {
    // Existing getOfferById logic
  }

  async updateOffer(offerId, updates, userId = null) {
    // Existing updateOffer logic
  }

  async deleteOffer(offerId, userId = null) {
    // Existing deleteOffer logic
  }

  async addQualifyingVariations(offerId, variations, userId = null) {
    // Existing addQualifyingVariations logic
  }

  async getQualifyingVariations(offerId) {
    // Existing getQualifyingVariations logic
  }

  async checkVariationConflicts(variationIds, excludeOfferId = null) {
    // Existing checkVariationConflicts logic
  }

  async getOfferForVariation(variationId) {
    // Existing getOfferForVariation logic - frequently used
  }
}

module.exports = { LoyaltyOfferService };
```

**Validation Criteria:**
- [ ] All offer CRUD functions extracted
- [ ] Unit tests for each function (mocked db)
- [ ] UI: Create offer still works
- [ ] UI: Edit offer still works
- [ ] UI: Delete offer still works
- [ ] UI: Add variations still works

### Step 5.2: Update Exports for Backward Compatibility

```javascript
// In loyalty-service.js or services/loyalty/index.js
const { LoyaltyOfferService } = require('./offer-service');

// Keep old function signatures working
async function createOffer(offerData) {
  const service = new LoyaltyOfferService(offerData.merchant_id);
  return service.createOffer(offerData);
}

// ... same for other functions ...

module.exports = {
  // Old exports still work
  createOffer,
  getOffers,
  // ...

  // New service also exported
  LoyaltyOfferService,
};
```

**Validation Criteria:**
- [ ] Existing code using old function signatures still works
- [ ] New code can use LoyaltyOfferService directly
- [ ] No breaking changes to routes/loyalty.js

### Phase 5 Completion Checklist
- [ ] `services/loyalty/offer-service.js` created
- [ ] All offer functions moved to service
- [ ] Backward compatible exports maintained
- [ ] UI tested: create, edit, delete, variations
- [ ] Deploy and verify

---

## Phase 6: Purchase Service Extraction

**Goal:** Isolate purchase recording and progress tracking
**Risk:** HIGH - Core tracking logic
**Validation:** Purchases are recorded correctly, rewards earned correctly

### Step 6.1: Create Purchase Service Module

Create `services/loyalty/purchase-service.js`:

```javascript
const db = require('../../utils/database');
const { loyaltyLogger } = require('./loyalty-logger');
const { LoyaltyOfferService } = require('./offer-service');

class LoyaltyPurchaseService {
  constructor(merchantId, tracer = null) {
    this.merchantId = merchantId;
    this.tracer = tracer;
    this.offerService = new LoyaltyOfferService(merchantId);
  }

  /**
   * Record a qualifying purchase and update reward progress
   * Returns { recorded: boolean, rewardStatus: string, rewardId: number|null }
   */
  async recordPurchase(purchaseData) {
    const {
      squareOrderId,
      squareCustomerId,
      variationId,
      quantity,
      unitPriceCents,
      totalPriceCents,
      purchasedAt,
      traceId,
    } = purchaseData;

    // Get qualifying offer
    const offer = await this.offerService.getOfferForVariation(variationId);
    if (!offer) {
      this.tracer?.span('PURCHASE_NO_OFFER', { variationId });
      return { recorded: false, reason: 'no_qualifying_offer' };
    }

    // Generate idempotency key
    const idempotencyKey = `${squareOrderId}:${variationId}:${quantity}`;

    // Check for duplicate
    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      this.tracer?.span('PURCHASE_DUPLICATE', { idempotencyKey });
      return { recorded: false, reason: 'duplicate', existingId: existing.id };
    }

    // Begin transaction
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Insert purchase event
      const insertResult = await client.query(
        `INSERT INTO loyalty_purchase_events
         (merchant_id, square_order_id, square_customer_id, offer_id,
          variation_id, quantity, unit_price_cents, total_price_cents,
          purchased_at, idempotency_key, trace_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         RETURNING id`,
        [this.merchantId, squareOrderId, squareCustomerId, offer.id,
         variationId, quantity, unitPriceCents, totalPriceCents,
         purchasedAt, idempotencyKey, traceId]
      );

      const purchaseEventId = insertResult.rows[0].id;

      this.tracer?.span('PURCHASE_RECORDED', {
        purchaseEventId,
        offerId: offer.id,
        quantity
      });

      // Update reward progress
      const rewardResult = await this.updateRewardProgress(client, {
        squareCustomerId,
        offerId: offer.id,
        offer,
        traceId,
      });

      await client.query('COMMIT');

      loyaltyLogger.purchase({
        action: 'PURCHASE_RECORDED',
        purchaseEventId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity,
        offerId: offer.id,
        rewardStatus: rewardResult.status,
        rewardId: rewardResult.rewardId,
        merchantId: this.merchantId,
      });

      return {
        recorded: true,
        purchaseEventId,
        offerId: offer.id,
        ...rewardResult,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update reward progress based on current purchase totals
   * Implements rolling window logic
   */
  async updateRewardProgress(client, data) {
    const { squareCustomerId, offerId, offer, traceId } = data;

    // Calculate window start
    const windowDays = offer.window_days || 365;
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - windowDays);

    // Get current progress (unlocked purchases only)
    const progressResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) as total_quantity
       FROM loyalty_purchase_events
       WHERE merchant_id = $1
         AND square_customer_id = $2
         AND offer_id = $3
         AND purchased_at >= $4
         AND locked_to_reward_id IS NULL
         AND quantity > 0`,
      [this.merchantId, squareCustomerId, offerId, windowStart]
    );

    const currentQuantity = parseInt(progressResult.rows[0].total_quantity);
    const requiredQuantity = offer.required_quantity;

    this.tracer?.span('REWARD_PROGRESS_CALCULATED', {
      currentQuantity,
      requiredQuantity,
      windowDays,
    });

    // Check for existing in_progress reward
    const existingReward = await client.query(
      `SELECT * FROM loyalty_rewards
       WHERE merchant_id = $1
         AND square_customer_id = $2
         AND offer_id = $3
         AND status = 'in_progress'
       FOR UPDATE`,
      [this.merchantId, squareCustomerId, offerId]
    );

    let rewardId = existingReward.rows[0]?.id;
    let status = 'in_progress';

    if (currentQuantity >= requiredQuantity) {
      // Reward earned!
      if (rewardId) {
        // Update existing to earned
        await client.query(
          `UPDATE loyalty_rewards
           SET status = 'earned', current_quantity = $1, earned_at = NOW(), trace_id = $2
           WHERE id = $3`,
          [currentQuantity, traceId, rewardId]
        );
      } else {
        // Create new earned reward
        const rewardResult = await client.query(
          `INSERT INTO loyalty_rewards
           (merchant_id, square_customer_id, offer_id, status,
            current_quantity, required_quantity, earned_at, trace_id, created_at)
           VALUES ($1, $2, $3, 'earned', $4, $5, NOW(), $6, NOW())
           RETURNING id`,
          [this.merchantId, squareCustomerId, offerId,
           currentQuantity, requiredQuantity, traceId]
        );
        rewardId = rewardResult.rows[0].id;
      }

      // Lock contributing purchases to this reward
      await client.query(
        `UPDATE loyalty_purchase_events
         SET locked_to_reward_id = $1
         WHERE merchant_id = $2
           AND square_customer_id = $3
           AND offer_id = $4
           AND purchased_at >= $5
           AND locked_to_reward_id IS NULL
           AND quantity > 0
         ORDER BY purchased_at
         LIMIT $6`,
        [rewardId, this.merchantId, squareCustomerId, offerId,
         windowStart, requiredQuantity]
      );

      status = 'earned';

      this.tracer?.span('REWARD_EARNED', { rewardId, currentQuantity });

      loyaltyLogger.reward({
        action: 'REWARD_EARNED',
        rewardId,
        squareCustomerId,
        offerId,
        currentQuantity,
        requiredQuantity,
        merchantId: this.merchantId,
      });

    } else if (currentQuantity > 0) {
      // Progress made but not enough for reward
      if (rewardId) {
        await client.query(
          `UPDATE loyalty_rewards
           SET current_quantity = $1, trace_id = $2
           WHERE id = $3`,
          [currentQuantity, traceId, rewardId]
        );
      } else {
        const rewardResult = await client.query(
          `INSERT INTO loyalty_rewards
           (merchant_id, square_customer_id, offer_id, status,
            current_quantity, required_quantity, trace_id, created_at)
           VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, NOW())
           RETURNING id`,
          [this.merchantId, squareCustomerId, offerId,
           currentQuantity, requiredQuantity, traceId]
        );
        rewardId = rewardResult.rows[0].id;
      }

      this.tracer?.span('REWARD_PROGRESS_UPDATED', {
        rewardId,
        currentQuantity,
        requiredQuantity
      });
    }

    // Update customer summary
    await this.updateCustomerSummary(client, squareCustomerId, offerId);

    return { status, rewardId, currentQuantity, requiredQuantity };
  }

  async recordRefund(refundData) {
    // Similar to recordPurchase but with negative quantity
    // May trigger reward revocation
  }

  async findByIdempotencyKey(key) {
    const result = await db.query(
      `SELECT id FROM loyalty_purchase_events WHERE idempotency_key = $1`,
      [key]
    );
    return result.rows[0] || null;
  }

  async updateCustomerSummary(client, squareCustomerId, offerId) {
    // Denormalized summary update
  }
}

module.exports = { LoyaltyPurchaseService };
```

**Validation Criteria:**
- [ ] File created at `services/loyalty/purchase-service.js`
- [ ] Unit tests for recordPurchase (mocked db)
- [ ] Unit tests for updateRewardProgress with various quantities
- [ ] Integration test: purchase -> progress -> earned flow
- [ ] Integration test: refund -> revocation flow
- [ ] Idempotency test: same purchase twice only records once
- [ ] Rolling window test: old purchases don't count

### Step 6.2: Add Purchase Debugging Endpoint

```javascript
// In routes/loyalty.js
router.get('/debug/purchase-trace/:traceId',
  requireAuth,
  requireMerchant,
  async (req, res) => {
    const { traceId } = req.params;
    const merchantId = req.merchantContext.merchantId;

    // Get all events with this trace ID
    const purchases = await db.query(
      `SELECT * FROM loyalty_purchase_events WHERE trace_id = $1 AND merchant_id = $2`,
      [traceId, merchantId]
    );

    const rewards = await db.query(
      `SELECT * FROM loyalty_rewards WHERE trace_id = $1 AND merchant_id = $2`,
      [traceId, merchantId]
    );

    const auditLogs = await db.query(
      `SELECT * FROM loyalty_audit_logs WHERE trace_id = $1 AND merchant_id = $2 ORDER BY created_at`,
      [traceId, merchantId]
    );

    res.json({
      traceId,
      purchases: purchases.rows,
      rewards: rewards.rows,
      auditLogs: auditLogs.rows,
    });
  }
);
```

**Validation Criteria:**
- [ ] Endpoint returns complete trace of all related records
- [ ] Useful for debugging "what happened during this order processing?"

### Phase 6 Completion Checklist
- [ ] `services/loyalty/purchase-service.js` created with full test coverage
- [ ] recordPurchase function tested and working
- [ ] updateRewardProgress function tested with edge cases
- [ ] recordRefund function tested including revocation
- [ ] Debug endpoint added for tracing
- [ ] All existing tests still pass
- [ ] Deploy and verify purchases are recorded correctly

---

## Phase 7: Reward Service Extraction

**Goal:** Isolate reward redemption and Square discount management
**Risk:** MEDIUM - Involves Square API cleanup
**Validation:** Rewards can be redeemed, discounts cleaned up

### Step 7.1: Create Reward Service Module

Create `services/loyalty/reward-service.js`:

```javascript
const db = require('../../utils/database');
const { loyaltyLogger } = require('./loyalty-logger');
const { LoyaltySquareClient } = require('./square-client');

class LoyaltyRewardService {
  constructor(merchantId, tracer = null) {
    this.merchantId = merchantId;
    this.tracer = tracer;
    this.squareClient = null;
  }

  async initialize() {
    this.squareClient = await new LoyaltySquareClient(this.merchantId).initialize();
    return this;
  }

  async redeemReward(redemptionData) {
    const { rewardId, userId, redemptionType = 'MANUAL' } = redemptionData;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Lock and fetch reward
      const rewardResult = await client.query(
        `SELECT * FROM loyalty_rewards
         WHERE id = $1 AND merchant_id = $2
         FOR UPDATE`,
        [rewardId, this.merchantId]
      );

      const reward = rewardResult.rows[0];
      if (!reward) {
        throw new Error(`Reward ${rewardId} not found`);
      }

      if (reward.status !== 'earned') {
        throw new Error(`Reward ${rewardId} is not in earned status (current: ${reward.status})`);
      }

      // Record redemption
      await client.query(
        `INSERT INTO loyalty_redemptions
         (merchant_id, reward_id, square_customer_id, offer_id,
          redemption_type, redeemed_by_user_id, redeemed_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [this.merchantId, rewardId, reward.square_customer_id,
         reward.offer_id, redemptionType, userId]
      );

      // Update reward status
      await client.query(
        `UPDATE loyalty_rewards
         SET status = 'redeemed', redeemed_at = NOW()
         WHERE id = $1`,
        [rewardId]
      );

      await client.query('COMMIT');

      this.tracer?.span('REWARD_REDEEMED', { rewardId });

      loyaltyLogger.redemption({
        action: 'REWARD_REDEEMED',
        rewardId,
        squareCustomerId: reward.square_customer_id,
        offerId: reward.offer_id,
        redemptionType,
        userId,
        merchantId: this.merchantId,
      });

      // Cleanup Square discount (outside transaction, non-critical)
      this.cleanupSquareDiscount(reward).catch(error => {
        loyaltyLogger.error({
          action: 'DISCOUNT_CLEANUP_FAILED',
          rewardId,
          error: error.message,
          merchantId: this.merchantId,
        });
      });

      return { success: true, rewardId };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupSquareDiscount(reward) {
    // Remove customer from group
    // Delete discount objects
    // Delete customer group
  }

  async createSquareDiscount(rewardData) {
    // Create customer group
    // Create pricing rule
    // Add customer to group
  }

  async getEarnedRewards(squareCustomerId) {
    // Fetch all earned rewards for customer
  }

  async validateDiscounts(options = {}) {
    // Check Square discounts match database state
  }
}

module.exports = { LoyaltyRewardService };
```

**Validation Criteria:**
- [ ] File created at `services/loyalty/reward-service.js`
- [ ] Unit tests for redeemReward (mocked db)
- [ ] Integration test: earned reward can be redeemed
- [ ] Integration test: non-earned reward cannot be redeemed
- [ ] Square discount cleanup works
- [ ] Audit log records redemption

### Phase 7 Completion Checklist
- [ ] `services/loyalty/reward-service.js` created
- [ ] Redemption flow tested end-to-end
- [ ] Square discount management tested
- [ ] Validation endpoint works
- [ ] Deploy and verify redemptions work

---

## Phase 8: Webhook Service Orchestration

**Goal:** Create clean entry point for order processing
**Risk:** LOW - Orchestration only
**Validation:** Webhooks process orders correctly

### Step 8.1: Create Webhook Service Module

Create `services/loyalty/webhook-service.js`:

```javascript
const { LoyaltyTracer } = require('./loyalty-tracer');
const { loyaltyLogger } = require('./loyalty-logger');
const { LoyaltyCustomerService } = require('./customer-service');
const { LoyaltyPurchaseService } = require('./purchase-service');
const { LoyaltyRewardService } = require('./reward-service');
const { LoyaltySquareClient } = require('./square-client');

class LoyaltyWebhookService {
  constructor(merchantId) {
    this.merchantId = merchantId;
  }

  async processOrder(order, options = {}) {
    const tracer = new LoyaltyTracer();
    const traceId = tracer.startTrace({
      orderId: order.id,
      merchantId: this.merchantId,
      source: options.source || 'WEBHOOK',
    });

    try {
      loyaltyLogger.debug({
        action: 'ORDER_PROCESSING_START',
        orderId: order.id,
        traceId,
        lineItemCount: order.line_items?.length || 0,
        merchantId: this.merchantId,
      });

      // Step 1: Identify customer
      const customerService = await new LoyaltyCustomerService(
        this.merchantId,
        tracer
      ).initialize();

      const customerResult = await customerService.identifyCustomerFromOrder(order);

      if (!customerResult) {
        tracer.span('SKIP_NO_CUSTOMER');
        const trace = tracer.endTrace();

        loyaltyLogger.debug({
          action: 'ORDER_SKIPPED',
          reason: 'no_customer_identified',
          orderId: order.id,
          traceId,
          trace,
          merchantId: this.merchantId,
        });

        return { processed: false, reason: 'no_customer', traceId };
      }

      const { customerId, method: identificationMethod } = customerResult;
      tracer.span('CUSTOMER_IDENTIFIED', { customerId, method: identificationMethod });

      // Step 2: Process each line item
      const purchaseService = new LoyaltyPurchaseService(this.merchantId, tracer);
      const results = [];

      for (const lineItem of (order.line_items || [])) {
        const result = await this.processLineItem(
          lineItem,
          order,
          customerId,
          purchaseService,
          traceId
        );
        results.push(result);
      }

      // Step 3: Handle any earned rewards (async discount creation)
      const earnedRewards = results.filter(r => r.status === 'earned');
      if (earnedRewards.length > 0) {
        const rewardService = await new LoyaltyRewardService(
          this.merchantId,
          tracer
        ).initialize();

        for (const earned of earnedRewards) {
          // Fire-and-forget discount creation
          rewardService.createSquareDiscount({
            rewardId: earned.rewardId,
            customerId,
            offerId: earned.offerId,
          }).catch(error => {
            loyaltyLogger.error({
              action: 'DISCOUNT_CREATION_FAILED',
              rewardId: earned.rewardId,
              error: error.message,
              traceId,
              merchantId: this.merchantId,
            });
          });
        }
      }

      const trace = tracer.endTrace();

      loyaltyLogger.debug({
        action: 'ORDER_PROCESSING_COMPLETE',
        orderId: order.id,
        traceId,
        customerId,
        identificationMethod,
        lineItemsProcessed: results.length,
        purchasesRecorded: results.filter(r => r.recorded).length,
        rewardsEarned: earnedRewards.length,
        duration: trace.duration,
        merchantId: this.merchantId,
      });

      return {
        processed: true,
        traceId,
        customerId,
        identificationMethod,
        results,
        duration: trace.duration,
      };

    } catch (error) {
      tracer.span('ERROR', { error: error.message });
      const trace = tracer.endTrace();

      loyaltyLogger.error({
        action: 'ORDER_PROCESSING_FAILED',
        orderId: order.id,
        traceId,
        error: error.message,
        stack: error.stack,
        trace,
        merchantId: this.merchantId,
      });

      throw error;
    }
  }

  async processLineItem(lineItem, order, customerId, purchaseService, traceId) {
    const variationId = lineItem.catalog_object_id;
    const quantity = parseInt(lineItem.quantity) || 0;
    const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);

    // Check if item is free (100% discounted)
    const rawTotalMoney = lineItem.total_money?.amount;
    const totalPriceCents = rawTotalMoney != null ? Number(rawTotalMoney) : unitPriceCents;
    const isFree = unitPriceCents > 0 && totalPriceCents === 0;

    if (isFree) {
      loyaltyLogger.debug({
        action: 'LINE_ITEM_SKIPPED',
        reason: 'free_item',
        orderId: order.id,
        lineItemId: lineItem.uid,
        variationId,
        traceId,
        merchantId: this.merchantId,
      });

      return {
        recorded: false,
        reason: 'free_item',
        variationId,
        lineItemId: lineItem.uid,
      };
    }

    if (quantity <= 0) {
      return {
        recorded: false,
        reason: 'zero_quantity',
        variationId,
        lineItemId: lineItem.uid,
      };
    }

    // Record purchase
    return purchaseService.recordPurchase({
      squareOrderId: order.id,
      squareCustomerId: customerId,
      variationId,
      quantity,
      unitPriceCents,
      totalPriceCents,
      purchasedAt: order.created_at || new Date().toISOString(),
      traceId,
    });
  }

  async processRefunds(order) {
    // Process refunds from order
  }
}

module.exports = { LoyaltyWebhookService };
```

**Validation Criteria:**
- [ ] File created at `services/loyalty/webhook-service.js`
- [ ] Integration test: full order processing flow
- [ ] Trace ID appears in all related logs
- [ ] Customer identification logged with method
- [ ] Each line item decision logged
- [ ] Earned rewards trigger discount creation
- [ ] Errors include full trace

### Step 8.2: Update Main Entry Points

Update `loyalty-service.js` to use webhook service:

```javascript
// Backward compatible wrapper
async function processOrderForLoyalty(order, merchantId, options = {}) {
  const service = new LoyaltyWebhookService(merchantId);
  return service.processOrder(order, options);
}
```

**Validation Criteria:**
- [ ] Existing webhook calls still work
- [ ] Routes using processOrderForLoyalty unchanged
- [ ] All tests pass

### Step 8.3: Create Service Index File

Create `services/loyalty/index.js`:

```javascript
// Re-export all services
const { LoyaltySquareClient, SquareApiError } = require('./square-client');
const { LoyaltyCustomerService } = require('./customer-service');
const { LoyaltyOfferService } = require('./offer-service');
const { LoyaltyPurchaseService } = require('./purchase-service');
const { LoyaltyRewardService } = require('./reward-service');
const { LoyaltyWebhookService } = require('./webhook-service');
const { LoyaltyTracer, getTracer, cleanupTracer } = require('./loyalty-tracer');
const { loyaltyLogger } = require('./loyalty-logger');

// Re-export for backward compatibility
const legacyExports = require('../../utils/loyalty-service');

module.exports = {
  // New services
  LoyaltySquareClient,
  SquareApiError,
  LoyaltyCustomerService,
  LoyaltyOfferService,
  LoyaltyPurchaseService,
  LoyaltyRewardService,
  LoyaltyWebhookService,
  LoyaltyTracer,
  getTracer,
  cleanupTracer,
  loyaltyLogger,

  // Legacy exports (backward compatible)
  ...legacyExports,
};
```

### Phase 8 Completion Checklist
- [ ] `services/loyalty/webhook-service.js` created
- [ ] `services/loyalty/index.js` created with all exports
- [ ] processOrderForLoyalty uses new service
- [ ] Full integration test passes
- [ ] Trace IDs work end-to-end
- [ ] Deploy and verify webhook processing works

---

## Final Validation Checklist

After all phases complete:

### Functional Tests
- [ ] Create new loyalty offer via UI
- [ ] Add qualifying variations to offer
- [ ] Process order with qualifying items → purchase recorded
- [ ] Process enough orders to earn reward → reward earned
- [ ] Redeem reward via UI → redemption recorded
- [ ] Process refund → quantities adjusted
- [ ] Backfill orders → catches missed purchases

### Debugging Tests
- [ ] Query logs by trace ID → complete processing history
- [ ] Debug endpoint shows customer identification attempts
- [ ] Debug endpoint shows purchase trace
- [ ] Square API calls logged with timing
- [ ] Errors include full context

### Performance Tests
- [ ] Order processing time unchanged
- [ ] Backfill performance acceptable
- [ ] No increase in database queries

---

## Migration Strategy

### Deployment Order
1. Phase 1 (Logging) - Deploy independently
2. Phase 2 (Tracing) - Deploy with migration
3. Phase 3 (Square Client) - Deploy independently
4. Phase 4-8 - Can be deployed together or separately

### Feature Flags (Optional)
```javascript
const USE_NEW_CUSTOMER_SERVICE = process.env.LOYALTY_NEW_CUSTOMER_SERVICE === 'true';
const USE_NEW_PURCHASE_SERVICE = process.env.LOYALTY_NEW_PURCHASE_SERVICE === 'true';

async function processOrderForLoyalty(order, merchantId, options = {}) {
  if (USE_NEW_PURCHASE_SERVICE) {
    const service = new LoyaltyWebhookService(merchantId);
    return service.processOrder(order, options);
  }
  // Legacy code path
  return processOrderForLoyaltyLegacy(order, merchantId, options);
}
```

### Rollback Plan
Each phase can be rolled back independently:
1. Revert code changes
2. Feature flags allow instant rollback
3. Database migrations are additive (trace_id columns)

---

## Success Metrics

After refactoring, you should be able to:

1. **Answer "Why didn't this order get loyalty credit?"**
   - Query by trace ID to see full processing path
   - See which customer identification method was tried
   - See each line item decision

2. **Answer "Why didn't this customer earn their reward?"**
   - Query purchase events by customer + offer
   - See current progress vs required
   - Check rolling window dates

3. **Answer "Did we call Square API for this reward?"**
   - Logs show all Square API calls with timing
   - Success and failure both logged

4. **Debug any tracking issue within 5 minutes**
   - Instead of reading 5,000 lines of code
   - Query structured logs and debug endpoints

---

*Document created: January 22, 2026*
*Target completion: Phased rollout over multiple deployments*
