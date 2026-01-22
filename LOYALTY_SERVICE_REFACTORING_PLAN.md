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

## Execution Prerequisites

### Environment Setup

Before starting any phase, ensure the following prerequisites are met:

```bash
# 1. Verify you're on the correct branch
git checkout -b feature/loyalty-refactor  # or your feature branch
git pull origin main

# 2. Ensure all dependencies are installed
npm install

# 3. Verify database connection
npm run db:check  # or: node -e "require('./utils/database').query('SELECT 1')"

# 4. Ensure test suite passes before changes
npm test

# 5. Create services/loyalty directory if it doesn't exist
mkdir -p services/loyalty
```

### File Location Reference

| Current File | Line Count | Purpose |
|--------------|------------|---------|
| `utils/loyalty-service.js` | 5,035 | Monolith to be refactored |
| `routes/loyalty.js` | ~800 | API routes (consumers) |
| `routes/webhooks.js` | ~400 | Webhook handlers (consumers) |

### Database Pre-Check

Run these queries to understand current state:

```sql
-- Check table counts before starting
SELECT 'loyalty_offers' as table_name, COUNT(*) as count FROM loyalty_offers
UNION ALL SELECT 'loyalty_qualifying_variations', COUNT(*) FROM loyalty_qualifying_variations
UNION ALL SELECT 'loyalty_purchase_events', COUNT(*) FROM loyalty_purchase_events
UNION ALL SELECT 'loyalty_rewards', COUNT(*) FROM loyalty_rewards
UNION ALL SELECT 'loyalty_redemptions', COUNT(*) FROM loyalty_redemptions
UNION ALL SELECT 'loyalty_audit_logs', COUNT(*) FROM loyalty_audit_logs;
```

### Dependency Graph

```
Phase 1 (Logging) ──────────────────────────────────────┐
                                                        │
Phase 2 (Tracing) ─────────────────────────────────────┤
                                                        │
Phase 3 (Square Client) ─────┬─────────────────────────┤
                             │                          │
                             v                          │
Phase 4 (Customer Service) ──┼─────────────────────────┤
                             │                          │
                             v                          │
Phase 5 (Offer Service) ─────┼─────────────────────────┤
                             │                          │
                             v                          │
Phase 6 (Purchase Service) ──┼─────────────────────────┤
                             │                          │
                             v                          │
Phase 7 (Reward Service) ────┼─────────────────────────┤
                             │                          │
                             v                          v
                        Phase 8 (Webhook Service Orchestration)
```

**Critical Dependencies:**
- Phase 3 MUST complete before Phase 4 (customer service uses square client)
- Phase 5 MUST complete before Phase 6 (purchase service uses offer service)
- Phase 6 MUST complete before Phase 7 (reward service depends on purchase tracking)
- Phases 1-2 can be done in parallel with Phase 3

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
**Estimated Complexity:** Low (2-3 hours)
**Dependencies:** None (can start immediately)

### Pre-Execution Checklist

```bash
# Verify logger utility exists
ls utils/logger.js  # Should exist; this is the base logger we'll wrap

# Verify target directory
mkdir -p services/loyalty

# Check current logging patterns in loyalty-service.js
grep -n "logger\." utils/loyalty-service.js | head -20
```

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

**Execution Commands:**

```bash
# 1. Create the file (copy the code above into this file)
touch services/loyalty/loyalty-logger.js

# 2. Verify file exports correctly
node -e "const { loyaltyLogger } = require('./services/loyalty/loyalty-logger'); console.log(Object.keys(loyaltyLogger));"
# Expected output: [ 'purchase', 'reward', 'redemption', 'squareApi', 'customer', 'error', 'debug' ]

# 3. Create unit test file
touch services/loyalty/__tests__/loyalty-logger.test.js

# 4. Run the test
npm test -- --testPathPattern="loyalty-logger"
```

**Unit Test Template (`services/loyalty/__tests__/loyalty-logger.test.js`):**

```javascript
const { loyaltyLogger } = require('../loyalty-logger');

describe('loyaltyLogger', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('purchase logs with correct prefix', () => {
    loyaltyLogger.purchase({ orderId: 'test-123' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LOYALTY:PURCHASE]'),
      expect.objectContaining({ orderId: 'test-123' })
    );
  });

  test('all log methods are defined', () => {
    expect(typeof loyaltyLogger.purchase).toBe('function');
    expect(typeof loyaltyLogger.reward).toBe('function');
    expect(typeof loyaltyLogger.redemption).toBe('function');
    expect(typeof loyaltyLogger.squareApi).toBe('function');
    expect(typeof loyaltyLogger.customer).toBe('function');
    expect(typeof loyaltyLogger.error).toBe('function');
    expect(typeof loyaltyLogger.debug).toBe('function');
  });
});
```

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

**Execution Commands:**

```bash
# 1. Find all fetch calls in loyalty-service.js that call Square API
grep -n "fetch.*squareup.com" utils/loyalty-service.js

# 2. Find all fetch calls with connect.squareup pattern
grep -n "connect.squareup" utils/loyalty-service.js

# 3. Add the import at the top of loyalty-service.js
# Add after existing requires:
# const { loyaltyLogger } = require('../services/loyalty/loyalty-logger');
```

**Step-by-Step Modification Pattern:**

For each of the 9 locations, apply this transformation:

```javascript
// FIND this pattern (example from line ~113):
const response = await fetch(url, {
  method: 'POST',
  headers: { ... },
  body: JSON.stringify(body),
});

// REPLACE with:
const startTime = Date.now();
const response = await fetch(url, {
  method: 'POST',
  headers: { ... },
  body: JSON.stringify(body),
});
const duration = Date.now() - startTime;

loyaltyLogger.squareApi({
  endpoint: url.replace('https://connect.squareup.com/v2', ''),
  method: 'POST',
  status: response.status,
  duration,
  success: response.ok,
  merchantId,
});
```

**Locations Checklist (update utils/loyalty-service.js):**

| # | Function | Approx Line | HTTP Method | Endpoint |
|---|----------|-------------|-------------|----------|
| 1 | `prefetchRecentLoyaltyEvents` | ~113 | POST | /loyalty/events/search |
| 2 | `getCustomerDetails` | ~471 | GET | /customers/{id} |
| 3 | `lookupCustomerFromLoyalty` | ~556 | POST | /loyalty/events/search |
| 4 | `createRewardCustomerGroup` | ~3210 | POST | /customers/groups |
| 5 | `addCustomerToGroup` | ~3278 | PUT | /customers/{id}/groups/{id} |
| 6 | `removeCustomerFromGroup` | ~3333 | DELETE | /customers/{id}/groups/{id} |
| 7 | `deleteCustomerGroup` | ~3387 | DELETE | /customers/groups/{id} |
| 8 | `createRewardDiscount` | ~3460 | POST | /catalog/batch-upsert |
| 9 | `deleteRewardDiscountObjects` | ~3660 | DELETE | /catalog/object/{id} |

**Verification:**

```bash
# Count logging calls added
grep -c "loyaltyLogger.squareApi" utils/loyalty-service.js
# Expected: 9

# Verify import added
grep "loyaltyLogger" utils/loyalty-service.js | head -5

# Run tests to ensure nothing broke
npm test -- --testPathPattern="loyalty"
```

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

**Execution Commands:**

```bash
# 1. Find processOrderForLoyalty function
grep -n "async function processOrderForLoyalty" utils/loyalty-service.js

# 2. Find the line item iteration loop (look for "line_items" or "lineItem")
grep -n "line_items\|lineItem" utils/loyalty-service.js | head -20

# 3. Find where item qualification decisions are made
grep -n "qualif\|isFree\|decision" utils/loyalty-service.js
```

**Insert Location:**

Find the loop that iterates over `order.line_items` in `processOrderForLoyalty`. After the line item is evaluated (checking if it qualifies for an offer), add:

```javascript
// Add INSIDE the for-loop, after determining qualification
loyaltyLogger.debug({
  action: 'LINE_ITEM_EVALUATION',
  orderId: order.id,
  lineItemId: lineItem.uid,
  variationId: lineItem.catalog_object_id,
  quantity: parseInt(lineItem.quantity) || 0,
  unitPrice: Number(lineItem.base_price_money?.amount || 0),
  totalPrice: Number(lineItem.total_money?.amount || 0),
  isFree: isFree,  // variable from existing code
  qualifyingOffer: offer?.id || null,
  decision: isFree ? 'SKIP_FREE' : offer ? 'QUALIFIES' : 'NO_OFFER',
  merchantId,
});
```

**Test Verification:**

```bash
# Create a test script to verify line item logging
cat > /tmp/test-line-item-logging.js << 'EOF'
const { processOrderForLoyalty } = require('./utils/loyalty-service');

const testOrder = {
  id: 'TEST-ORDER-001',
  line_items: [
    { uid: 'li1', catalog_object_id: 'var1', quantity: '2', base_price_money: { amount: 1000 }, total_money: { amount: 2000 } },
    { uid: 'li2', catalog_object_id: 'var2', quantity: '1', base_price_money: { amount: 500 }, total_money: { amount: 0 } },  // free
    { uid: 'li3', catalog_object_id: 'var3', quantity: '1', base_price_money: { amount: 750 }, total_money: { amount: 750 } },
  ],
  created_at: new Date().toISOString(),
};

// Run with a test merchant (use actual test merchant ID)
// processOrderForLoyalty(testOrder, 'test-merchant-id', { dryRun: true });
console.log('Test order prepared - run manually with valid merchant ID');
EOF
```

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

**Execution Commands:**

```bash
# 1. Find all customer lookup functions
grep -n "async function.*[Cc]ustomer\|async function.*lookup" utils/loyalty-service.js

# 2. Find the customer identification fallback chain
grep -n "customer_id\|tender.*customer\|fulfillment.*recipient" utils/loyalty-service.js | head -30
```

**Customer Lookup Functions to Update:**

| Function | Approx Line | Method Name for Logging |
|----------|-------------|------------------------|
| `getCustomerDetails` | ~431 | 'ORDER_CUSTOMER_ID' or 'DIRECT_LOOKUP' |
| `lookupCustomerFromLoyalty` | ~516 | 'LOYALTY_API' |
| `lookupCustomerFromOrderRewards` | ~779 | 'ORDER_REWARDS' |
| Customer search by phone/email | ~varies | 'FULFILLMENT_RECIPIENT' |

**Insert Pattern:**

```javascript
// At the START of each lookup function
loyaltyLogger.customer({
  action: 'CUSTOMER_LOOKUP_ATTEMPT',
  orderId: orderId || null,
  method: 'METHOD_NAME',  // Replace with appropriate method
  merchantId,
});

// At the END (on success)
loyaltyLogger.customer({
  action: 'CUSTOMER_LOOKUP_SUCCESS',
  orderId: orderId || null,
  method: 'METHOD_NAME',
  customerId: customer?.id || result?.id,
  merchantId,
});

// On failure/not found (in catch block or if null)
loyaltyLogger.customer({
  action: 'CUSTOMER_LOOKUP_FAILED',
  orderId: orderId || null,
  method: 'METHOD_NAME',
  reason: error?.message || 'not_found',
  merchantId,
});
```

### Phase 1 Rollback

**If issues arise, execute these rollback steps:**

```bash
# 1. Revert loyalty-service.js changes
git checkout HEAD -- utils/loyalty-service.js

# 2. Optionally keep or remove the logger file
# (keeping it is safe - it's not imported if loyalty-service.js is reverted)
rm -f services/loyalty/loyalty-logger.js
rm -f services/loyalty/__tests__/loyalty-logger.test.js

# 3. Verify tests pass
npm test

# 4. Deploy rollback
npm run deploy  # or your deployment command
```

### Phase 1 Completion Checklist

**Files Modified:**
- [ ] `services/loyalty/loyalty-logger.js` - Created (new file)
- [ ] `services/loyalty/__tests__/loyalty-logger.test.js` - Created (new file)
- [ ] `utils/loyalty-service.js` - Modified (import + 9 API logs + line item logs + customer logs)

**Verification Commands:**

```bash
# 1. Verify logger file exists and exports correctly
node -e "const { loyaltyLogger } = require('./services/loyalty/loyalty-logger'); console.log('Logger OK:', Object.keys(loyaltyLogger).length === 7);"

# 2. Count Square API logging calls (should be 9)
grep -c "loyaltyLogger.squareApi" utils/loyalty-service.js

# 3. Verify line item logging exists
grep -c "LINE_ITEM_EVALUATION" utils/loyalty-service.js

# 4. Verify customer logging exists
grep -c "CUSTOMER_LOOKUP" utils/loyalty-service.js

# 5. Run full test suite
npm test

# 6. Run application locally and trigger a test order
npm run dev
# Then process a test order and check logs

# 7. Search logs for new prefixes (after deployment)
# grep "\[LOYALTY:" /var/log/app.log | head -20
```

**Sign-Off Checklist:**
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] Code review completed
- [ ] Deployed to staging
- [ ] Staging logs show `[LOYALTY:*]` prefixes
- [ ] No errors in staging for 2+ hours
- [ ] Deployed to production
- [ ] Production logs show expected entries
- [ ] Monitored for 24 hours - no regressions

---

## Phase 2: Correlation ID Tracking

**Goal:** Link related operations with a single trace ID
**Risk:** LOW - Additive only
**Validation:** Single trace ID appears across all logs for one order
**Estimated Complexity:** Medium (3-4 hours)
**Dependencies:** Phase 1 (loyalty-logger.js must exist)

### Pre-Execution Checklist

```bash
# 1. Verify Phase 1 is complete
test -f services/loyalty/loyalty-logger.js && echo "✓ Logger exists" || echo "✗ Logger missing"

# 2. Verify database access
node -e "require('./utils/database').query('SELECT 1').then(() => console.log('✓ DB OK'))"

# 3. Check current audit log table structure
# Run in psql:
# \d loyalty_audit_logs
# \d loyalty_purchase_events
```

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

**Execution Commands:**

```bash
# 1. Create the tracer file
touch services/loyalty/loyalty-tracer.js
# Copy the code from above into this file

# 2. Verify file exports correctly
node -e "
const { LoyaltyTracer, getTracer, cleanupTracer } = require('./services/loyalty/loyalty-tracer');
const t = new LoyaltyTracer();
const id = t.startTrace({ test: true });
console.log('UUID format:', /^[0-9a-f-]{36}$/.test(id) ? '✓ Valid' : '✗ Invalid');
t.span('TEST_SPAN', { data: 123 });
const result = t.endTrace();
console.log('Duration calculated:', result.duration >= 0 ? '✓ OK' : '✗ Failed');
console.log('Spans recorded:', result.spans.length === 1 ? '✓ OK' : '✗ Failed');
"

# 3. Create unit test
touch services/loyalty/__tests__/loyalty-tracer.test.js
```

**Unit Test Template (`services/loyalty/__tests__/loyalty-tracer.test.js`):**

```javascript
const { LoyaltyTracer, getTracer, cleanupTracer } = require('../loyalty-tracer');

describe('LoyaltyTracer', () => {
  test('startTrace returns valid UUID', () => {
    const tracer = new LoyaltyTracer();
    const traceId = tracer.startTrace({ orderId: 'test' });
    expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('span records data with timestamp', () => {
    const tracer = new LoyaltyTracer();
    tracer.startTrace();
    const span = tracer.span('TEST_OPERATION', { key: 'value' });

    expect(span.name).toBe('TEST_OPERATION');
    expect(span.key).toBe('value');
    expect(span.timestamp).toBeDefined();
    expect(span.spanId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('endTrace calculates duration', async () => {
    const tracer = new LoyaltyTracer();
    tracer.startTrace();
    tracer.span('START');
    await new Promise(r => setTimeout(r, 10)); // 10ms delay
    tracer.span('END');
    const result = tracer.endTrace();

    expect(result.duration).toBeGreaterThanOrEqual(10);
    expect(result.spans).toHaveLength(2);
  });

  test('getTracer returns same instance for same requestId', () => {
    const tracer1 = getTracer('req-123');
    const tracer2 = getTracer('req-123');
    expect(tracer1).toBe(tracer2);
    cleanupTracer('req-123');
  });

  test('getTracer returns different instance for different requestId', () => {
    const tracer1 = getTracer('req-123');
    const tracer2 = getTracer('req-456');
    expect(tracer1).not.toBe(tracer2);
    cleanupTracer('req-123');
    cleanupTracer('req-456');
  });
});
```

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

**Execution Commands:**

```bash
# 1. Create migration file
TIMESTAMP=$(date +%Y%m%d%H%M%S)
touch migrations/${TIMESTAMP}_add_trace_id_to_audit_logs.sql
```

**Migration SQL (`migrations/YYYYMMDDHHMMSS_add_trace_id_to_audit_logs.sql`):**

```sql
-- Migration: Add trace_id column to loyalty_audit_logs
-- Purpose: Enable correlation of related audit events

-- Add column (nullable to preserve existing data)
ALTER TABLE loyalty_audit_logs
ADD COLUMN IF NOT EXISTS trace_id UUID;

-- Create index for efficient trace lookups
CREATE INDEX IF NOT EXISTS idx_loyalty_audit_logs_trace_id
ON loyalty_audit_logs(trace_id)
WHERE trace_id IS NOT NULL;

-- Verify column exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'loyalty_audit_logs' AND column_name = 'trace_id'
  ) THEN
    RAISE EXCEPTION 'Migration failed: trace_id column not created';
  END IF;
END $$;
```

**Run Migration:**

```bash
# Run migration (adjust command for your migration tool)
npm run migrate
# OR manually:
# psql $DATABASE_URL -f migrations/${TIMESTAMP}_add_trace_id_to_audit_logs.sql

# Verify migration
psql $DATABASE_URL -c "\d loyalty_audit_logs" | grep trace_id
# Expected: trace_id | uuid |
```

**Find and Update logAuditEvent Function:**

```bash
# 1. Find the function
grep -n "async function logAuditEvent\|function logAuditEvent" utils/loyalty-service.js

# 2. Find the INSERT query in that function
grep -n "INSERT INTO loyalty_audit_logs" utils/loyalty-service.js
```

**Modification Pattern:**

```javascript
// BEFORE (find this signature)
async function logAuditEvent(event, client = null) {

// AFTER (add traceId parameter with default)
async function logAuditEvent(event, client = null, traceId = null) {

// BEFORE (find the INSERT query columns)
INSERT INTO loyalty_audit_logs
(merchant_id, action, ...)
VALUES ($1, $2, ...)

// AFTER (add trace_id column and parameter)
INSERT INTO loyalty_audit_logs
(merchant_id, action, ..., trace_id)
VALUES ($1, $2, ..., $N)
// Add traceId to the values array
```

**Verification Query:**

```sql
-- After deploying, verify trace_id is being recorded
SELECT trace_id, action, created_at
FROM loyalty_audit_logs
WHERE trace_id IS NOT NULL
ORDER BY created_at DESC
LIMIT 10;
```

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

**Execution Commands:**

```bash
# 1. Find processOrderForLoyalty function
grep -n "async function processOrderForLoyalty" utils/loyalty-service.js

# 2. Add import at top of file (if not already added)
# const { LoyaltyTracer } = require('../services/loyalty/loyalty-tracer');
```

**Modification Steps:**

1. Add import at top of `utils/loyalty-service.js`:
```javascript
const { LoyaltyTracer } = require('../services/loyalty/loyalty-tracer');
```

2. Wrap the function body (find approximate line from grep):
```javascript
async function processOrderForLoyalty(order, merchantId, options = {}) {
  // ADD: Create tracer at start
  const tracer = new LoyaltyTracer();
  const traceId = tracer.startTrace({
    orderId: order.id,
    merchantId,
    source: options.source || 'WEBHOOK',
  });

  try {
    // ADD: First span
    tracer.span('START_ORDER_PROCESSING', {
      lineItemCount: order.line_items?.length || 0,
      hasCustomerId: !!order.customer_id,
    });

    // ... existing code ...
    // ADD spans at key points (customer lookup, line item processing, etc.)

    // ADD: Before return
    const trace = tracer.endTrace();
    loyaltyLogger.debug({ action: 'ORDER_TRACE_COMPLETE', trace });

    return result;

  } catch (error) {
    // ADD: Error span
    tracer.span('ERROR', { error: error.message, stack: error.stack?.slice(0, 500) });
    const trace = tracer.endTrace();
    loyaltyLogger.error({ action: 'ORDER_TRACE_FAILED', trace, error: error.message });
    throw error;
  }
}
```

**Key Span Insertion Points:**

| Location | Span Name | Data to Include |
|----------|-----------|-----------------|
| After customer identification | `CUSTOMER_IDENTIFIED` | `{ customerId, method }` |
| For each line item (in loop) | `LINE_ITEM_PROCESSED` | `{ variationId, decision, quantity }` |
| When purchase is recorded | `PURCHASE_RECORDED` | `{ purchaseEventId, offerId }` |
| When reward is earned | `REWARD_EARNED` | `{ rewardId, offerId, currentQuantity }` |
| On discount creation | `DISCOUNT_CREATED` | `{ discountId }` |

**Verification:**

```bash
# Test trace generation
node -e "
const { LoyaltyTracer } = require('./services/loyalty/loyalty-tracer');
const t = new LoyaltyTracer();
t.startTrace({ test: true });
t.span('A');
t.span('B');
t.span('C');
console.log(JSON.stringify(t.endTrace(), null, 2));
"
```

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

**Execution Commands:**

```bash
# 1. Create migration file
TIMESTAMP=$(date +%Y%m%d%H%M%S)
touch migrations/${TIMESTAMP}_add_trace_id_to_purchase_events.sql
```

**Migration SQL (`migrations/YYYYMMDDHHMMSS_add_trace_id_to_purchase_events.sql`):**

```sql
-- Migration: Add trace_id column to loyalty_purchase_events
-- Purpose: Enable tracing of purchase processing

ALTER TABLE loyalty_purchase_events
ADD COLUMN IF NOT EXISTS trace_id UUID;

CREATE INDEX IF NOT EXISTS idx_loyalty_purchase_events_trace_id
ON loyalty_purchase_events(trace_id)
WHERE trace_id IS NOT NULL;

-- Also add to loyalty_rewards for complete tracing
ALTER TABLE loyalty_rewards
ADD COLUMN IF NOT EXISTS trace_id UUID;

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_trace_id
ON loyalty_rewards(trace_id)
WHERE trace_id IS NOT NULL;
```

**Find and Update Purchase Recording:**

```bash
# Find where purchases are inserted
grep -n "INSERT INTO loyalty_purchase_events" utils/loyalty-service.js
```

Add `trace_id` to the INSERT column list and values.

### Phase 2 Rollback

**If issues arise, execute these rollback steps:**

```bash
# 1. Revert code changes
git checkout HEAD -- utils/loyalty-service.js

# 2. Remove tracer file (optional - harmless to keep)
rm -f services/loyalty/loyalty-tracer.js
rm -f services/loyalty/__tests__/loyalty-tracer.test.js

# 3. Database columns can remain (nullable, no impact)
# Or remove with:
# ALTER TABLE loyalty_audit_logs DROP COLUMN IF EXISTS trace_id;
# ALTER TABLE loyalty_purchase_events DROP COLUMN IF EXISTS trace_id;
# ALTER TABLE loyalty_rewards DROP COLUMN IF EXISTS trace_id;

# 4. Verify tests pass
npm test

# 5. Deploy
npm run deploy
```

### Phase 2 Completion Checklist

**Files Created:**
- [ ] `services/loyalty/loyalty-tracer.js`
- [ ] `services/loyalty/__tests__/loyalty-tracer.test.js`
- [ ] `migrations/YYYYMMDDHHMMSS_add_trace_id_to_audit_logs.sql`
- [ ] `migrations/YYYYMMDDHHMMSS_add_trace_id_to_purchase_events.sql`

**Files Modified:**
- [ ] `utils/loyalty-service.js` (import + tracer integration)

**Verification Commands:**

```bash
# 1. Verify tracer file
node -e "const { LoyaltyTracer } = require('./services/loyalty/loyalty-tracer'); console.log('✓ Tracer OK');"

# 2. Verify database columns exist
psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'loyalty_audit_logs' AND column_name = 'trace_id';"
psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'loyalty_purchase_events' AND column_name = 'trace_id';"

# 3. Run tests
npm test

# 4. After deployment, verify traces are recorded
psql $DATABASE_URL -c "SELECT COUNT(*) as traced_audits FROM loyalty_audit_logs WHERE trace_id IS NOT NULL;"
psql $DATABASE_URL -c "SELECT COUNT(*) as traced_purchases FROM loyalty_purchase_events WHERE trace_id IS NOT NULL;"
```

**End-to-End Trace Verification Query:**

```sql
-- Given a trace_id, see all related records
WITH trace AS (SELECT 'your-trace-id-here'::uuid as id)
SELECT 'audit_logs' as source, action as event, created_at
FROM loyalty_audit_logs, trace WHERE trace_id = trace.id
UNION ALL
SELECT 'purchase_events', 'purchase_recorded', created_at
FROM loyalty_purchase_events, trace WHERE trace_id = trace.id
UNION ALL
SELECT 'rewards', status, created_at
FROM loyalty_rewards, trace WHERE trace_id = trace.id
ORDER BY created_at;
```

**Sign-Off Checklist:**
- [ ] All unit tests pass
- [ ] Migrations applied successfully
- [ ] Tracer spans appear in logs
- [ ] trace_id columns populated
- [ ] Can query complete order trace by trace_id
- [ ] Deployed to production
- [ ] Monitored for 24 hours

---

## Phase 3: Square API Client Extraction

**Goal:** Isolate all Square API calls into one mockable module
**Risk:** MEDIUM - Changing call sites
**Validation:** All Square API calls go through client, existing tests pass
**Estimated Complexity:** Medium-High (4-6 hours)
**Dependencies:** Phase 1 (loyalty-logger.js must exist)

### Pre-Execution Checklist

```bash
# 1. Verify Phase 1 is complete
test -f services/loyalty/loyalty-logger.js && echo "✓ Logger exists" || echo "✗ Complete Phase 1 first"

# 2. Identify all Square API calls to migrate
grep -n "connect.squareup.com" utils/loyalty-service.js | wc -l
# Note the count - this is how many call sites need migration

# 3. Verify token encryption utilities exist
grep -l "decryptToken\|isEncryptedToken" utils/*.js

# 4. Check current Square API version being used
grep -n "Square-Version" utils/loyalty-service.js | head -5
```

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

**Execution Commands:**

```bash
# 1. Create the file
touch services/loyalty/square-client.js
# Copy the code from above

# 2. Verify fetchWithTimeout exists or add it
grep -n "fetchWithTimeout\|function fetchWithTimeout" utils/*.js
# If not found, add to the square-client.js:
```

**Add fetchWithTimeout if needed:**

```javascript
// Add at top of square-client.js if not importing from elsewhere
async function fetchWithTimeout(url, options, timeout = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

**Verification:**

```bash
# 3. Verify file exports correctly
node -e "
const { LoyaltySquareClient, SquareApiError } = require('./services/loyalty/square-client');
console.log('LoyaltySquareClient:', typeof LoyaltySquareClient === 'function' ? '✓' : '✗');
console.log('SquareApiError:', typeof SquareApiError === 'function' ? '✓' : '✗');
const client = new LoyaltySquareClient('test-merchant');
console.log('Methods:', Object.getOwnPropertyNames(LoyaltySquareClient.prototype).filter(m => m !== 'constructor').join(', '));
"
```

**Unit Test Template (`services/loyalty/__tests__/square-client.test.js`):**

```javascript
const { LoyaltySquareClient, SquareApiError } = require('../square-client');

// Mock fetch globally
global.fetch = jest.fn();

// Mock database
jest.mock('../../../utils/database', () => ({
  query: jest.fn().mockResolvedValue({
    rows: [{ square_access_token: 'test-token' }]
  })
}));

describe('LoyaltySquareClient', () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  describe('initialize', () => {
    test('fetches and stores access token', async () => {
      const client = new LoyaltySquareClient('merchant-123');
      await client.initialize();
      expect(client.accessToken).toBe('test-token');
    });
  });

  describe('request', () => {
    test('makes authenticated request with correct headers', async () => {
      fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'test' }),
      });

      const client = new LoyaltySquareClient('merchant-123');
      client.accessToken = 'test-token';

      await client.request('GET', '/test/endpoint');

      expect(fetch).toHaveBeenCalledWith(
        'https://connect.squareup.com/v2/test/endpoint',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
          }),
        })
      );
    });

    test('throws SquareApiError on non-200 response', async () => {
      fetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      const client = new LoyaltySquareClient('merchant-123');
      client.accessToken = 'test-token';

      await expect(client.request('GET', '/test')).rejects.toThrow(SquareApiError);
    });

    test('logs all requests with timing', async () => {
      // Test that loyaltyLogger.squareApi is called
    });
  });

  describe('convenience methods', () => {
    let client;

    beforeEach(async () => {
      client = new LoyaltySquareClient('merchant-123');
      client.accessToken = 'test-token';
      fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    test('getCustomer calls correct endpoint', async () => {
      await client.getCustomer('cust-123');
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/customers/cust-123'),
        expect.any(Object)
      );
    });

    test('searchCustomers uses POST', async () => {
      await client.searchCustomers({ query: {} });
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});
```

```bash
# 4. Run tests
npm test -- --testPathPattern="square-client"
```

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

**If issues arise, execute these rollback steps:**

```bash
# 1. Revert loyalty-service.js to restore direct fetch calls
git checkout HEAD -- utils/loyalty-service.js

# 2. The square-client.js can remain (unused if loyalty-service.js is reverted)
# Or remove it:
rm -f services/loyalty/square-client.js
rm -f services/loyalty/__tests__/square-client.test.js

# 3. Verify tests pass
npm test

# 4. Deploy
npm run deploy
```

### Phase 3 Completion Checklist

**Files Created:**
- [ ] `services/loyalty/square-client.js`
- [ ] `services/loyalty/__tests__/square-client.test.js`

**Files Modified:**
- [ ] `utils/loyalty-service.js` (import + all fetch calls replaced)

**Migration Verification:**

```bash
# 1. Verify NO direct Square API calls remain
grep -c "fetch.*connect.squareup.com" utils/loyalty-service.js
# Expected: 0

# 2. Verify client is imported
grep "LoyaltySquareClient" utils/loyalty-service.js | head -3

# 3. Count client usages (should match original fetch count)
grep -c "squareClient\.\|client\." utils/loyalty-service.js
# Expected: 9+ (one for each migrated call site)

# 4. Run full test suite
npm test

# 5. Test specific Square API functionality manually
node -e "
const { LoyaltySquareClient } = require('./services/loyalty/square-client');
// Use a test merchant ID
const client = new LoyaltySquareClient('YOUR_TEST_MERCHANT_ID');
client.initialize()
  .then(() => client.getLoyaltyProgram())
  .then(result => console.log('✓ Loyalty program fetch works:', !!result))
  .catch(err => console.error('✗ Error:', err.message));
"
```

**Function Migration Verification Table:**

| Function | File Location | Migrated | Tested |
|----------|---------------|----------|--------|
| `getSquareLoyaltyProgram` | ~line varies | [ ] | [ ] |
| `getCustomerDetails` | ~line 431 | [ ] | [ ] |
| `lookupCustomerFromLoyalty` | ~line 516 | [ ] | [ ] |
| `lookupCustomerFromOrderRewards` | ~line 779 | [ ] | [ ] |
| `createRewardCustomerGroup` | ~line 3180 | [ ] | [ ] |
| `addCustomerToGroup` | ~line 3258 | [ ] | [ ] |
| `removeCustomerFromGroup` | ~line 3313 | [ ] | [ ] |
| `deleteCustomerGroup` | ~line 3367 | [ ] | [ ] |
| `createRewardDiscount` | ~line 3421 | [ ] | [ ] |
| `deleteRewardDiscountObjects` | ~line 3631 | [ ] | [ ] |
| `prefetchRecentLoyaltyEvents` | ~line 113 | [ ] | [ ] |
| Other Square API calls | varies | [ ] | [ ] |

**Sign-Off Checklist:**
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] Manual test: customer lookup works
- [ ] Manual test: discount creation works
- [ ] Manual test: group management works
- [ ] Deployed to staging
- [ ] Staging functionality verified
- [ ] Deployed to production
- [ ] Production Square API calls logged correctly
- [ ] Monitored for 24 hours

---

## Phase 4: Customer Service Extraction

**Goal:** Isolate customer identification logic for easier debugging
**Risk:** MEDIUM - Core tracking functionality
**Validation:** Customer identification works via all 5 methods
**Estimated Complexity:** Medium-High (4-5 hours)
**Dependencies:** Phase 3 (square-client.js must exist)

### Pre-Execution Checklist

```bash
# 1. Verify Phase 3 is complete
test -f services/loyalty/square-client.js && echo "✓ Square client exists" || echo "✗ Complete Phase 3 first"

# 2. Verify Phase 1 and 2 are complete
test -f services/loyalty/loyalty-logger.js && echo "✓ Logger exists" || echo "✗ Complete Phase 1 first"
test -f services/loyalty/loyalty-tracer.js && echo "✓ Tracer exists" || echo "✗ Complete Phase 2 first"

# 3. Identify customer identification code locations
grep -n "customer_id\|getCustomerDetails\|lookupCustomer" utils/loyalty-service.js | head -30

# 4. Count customer lookup methods to migrate
grep -n "async function.*[Cc]ustomer\|async function.*lookup" utils/loyalty-service.js
```

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

**If issues arise, execute these rollback steps:**

```bash
# 1. Revert loyalty-service.js to restore inline customer lookup
git checkout HEAD -- utils/loyalty-service.js

# 2. Revert routes if debug endpoint was added
git checkout HEAD -- routes/loyalty.js

# 3. The customer-service.js can remain (unused if loyalty-service.js is reverted)
rm -f services/loyalty/customer-service.js
rm -f services/loyalty/__tests__/customer-service.test.js

# 4. Verify tests pass
npm test

# 5. Deploy
npm run deploy
```

### Phase 4 Completion Checklist

**Files Created:**
- [ ] `services/loyalty/customer-service.js`
- [ ] `services/loyalty/__tests__/customer-service.test.js`

**Files Modified:**
- [ ] `utils/loyalty-service.js` (import + customer identification delegated)
- [ ] `routes/loyalty.js` (debug endpoint added)

**Verification Commands:**

```bash
# 1. Verify customer service file exports
node -e "
const { LoyaltyCustomerService } = require('./services/loyalty/customer-service');
console.log('LoyaltyCustomerService:', typeof LoyaltyCustomerService === 'function' ? '✓' : '✗');
console.log('Methods:', Object.getOwnPropertyNames(LoyaltyCustomerService.prototype).filter(m => m !== 'constructor').join(', '));
"

# 2. Run tests
npm test -- --testPathPattern="customer-service"

# 3. Test debug endpoint (after deployment)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/loyalty/debug/customer-identification/ORDER_ID_HERE"
```

**Customer Identification Test Matrix:**

| Test Case | Method Expected | Verified |
|-----------|-----------------|----------|
| Order with `customer_id` | ORDER_CUSTOMER_ID | [ ] |
| Order with tender `customer_id` | TENDER_CUSTOMER_ID | [ ] |
| Order with loyalty events | LOYALTY_API | [ ] |
| Order with rewards array | ORDER_REWARDS | [ ] |
| Order with fulfillment recipient | FULFILLMENT_RECIPIENT | [ ] |
| Order with no customer info | No identification (null) | [ ] |

**Sign-Off Checklist:**
- [ ] All 5 identification methods implemented
- [ ] Each method logged with method name
- [ ] Fallback chain works correctly
- [ ] Debug endpoint returns useful information
- [ ] Unit tests cover all methods
- [ ] Integration test passes
- [ ] Deployed to staging
- [ ] Staging verification complete
- [ ] Deployed to production
- [ ] Monitored for 24 hours

---

## Phase 5: Offer Service Extraction

**Goal:** Isolate offer CRUD operations
**Risk:** LOW - Simple CRUD, no Square API
**Validation:** Offer management UI still works
**Estimated Complexity:** Low-Medium (2-3 hours)
**Dependencies:** Phase 1 (loyalty-logger.js)

### Pre-Execution Checklist

```bash
# 1. Verify Phase 1 is complete
test -f services/loyalty/loyalty-logger.js && echo "✓ Logger exists" || echo "✗ Complete Phase 1 first"

# 2. Find all offer-related functions
grep -n "async function.*[Oo]ffer\|function.*[Oo]ffer" utils/loyalty-service.js

# 3. Count functions to migrate
grep -c "async function.*[Oo]ffer" utils/loyalty-service.js

# 4. Check offer table structure
# psql $DATABASE_URL -c "\d loyalty_offers"
# psql $DATABASE_URL -c "\d loyalty_qualifying_variations"
```

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

### Phase 5 Rollback

```bash
# 1. Revert to inline offer functions
git checkout HEAD -- utils/loyalty-service.js

# 2. Remove service file
rm -f services/loyalty/offer-service.js
rm -f services/loyalty/__tests__/offer-service.test.js

# 3. Verify and deploy
npm test && npm run deploy
```

### Phase 5 Completion Checklist

**Files Created:**
- [ ] `services/loyalty/offer-service.js`
- [ ] `services/loyalty/__tests__/offer-service.test.js`

**Files Modified:**
- [ ] `utils/loyalty-service.js` (backward-compatible wrappers)

**Verification Commands:**

```bash
# 1. Verify offer service exports
node -e "
const { LoyaltyOfferService } = require('./services/loyalty/offer-service');
console.log('LoyaltyOfferService:', typeof LoyaltyOfferService === 'function' ? '✓' : '✗');
"

# 2. Run tests
npm test -- --testPathPattern="offer-service"

# 3. Verify backward compatibility (old function signatures still work)
node -e "
const { createOffer, getOffers, getOfferById } = require('./utils/loyalty-service');
console.log('createOffer:', typeof createOffer === 'function' ? '✓' : '✗');
console.log('getOffers:', typeof getOffers === 'function' ? '✓' : '✗');
console.log('getOfferById:', typeof getOfferById === 'function' ? '✓' : '✗');
"
```

**UI Verification Checklist:**
- [ ] Create new offer works
- [ ] Edit offer works
- [ ] Delete offer works
- [ ] Add qualifying variations works
- [ ] Remove qualifying variations works
- [ ] Offer list displays correctly

**Sign-Off Checklist:**
- [ ] All offer CRUD functions migrated
- [ ] Backward compatible exports work
- [ ] UI fully functional
- [ ] Unit tests pass
- [ ] Deployed and verified

---

## Phase 6: Purchase Service Extraction

**Goal:** Isolate purchase recording and progress tracking
**Risk:** HIGH - Core tracking logic
**Validation:** Purchases are recorded correctly, rewards earned correctly
**Estimated Complexity:** High (5-7 hours)
**Dependencies:** Phase 5 (offer-service.js must exist), Phase 1-2

### Pre-Execution Checklist

```bash
# 1. Verify all dependencies are complete
test -f services/loyalty/loyalty-logger.js && echo "✓ Logger exists" || echo "✗ Missing"
test -f services/loyalty/loyalty-tracer.js && echo "✓ Tracer exists" || echo "✗ Missing"
test -f services/loyalty/offer-service.js && echo "✓ Offer service exists" || echo "✗ Complete Phase 5 first"

# 2. Find purchase-related functions
grep -n "async function.*[Pp]urchase\|recordPurchase\|processQualifying" utils/loyalty-service.js

# 3. Find reward progress calculation logic
grep -n "updateRewardProgress\|current_quantity\|required_quantity" utils/loyalty-service.js | head -20

# 4. Check purchase events table structure
# psql $DATABASE_URL -c "\d loyalty_purchase_events"

# 5. Check rewards table structure
# psql $DATABASE_URL -c "\d loyalty_rewards"
```

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

### Phase 6 Rollback

**CRITICAL: This phase has HIGH risk. Follow these steps carefully:**

```bash
# 1. Immediately revert if purchase recording fails
git checkout HEAD -- utils/loyalty-service.js

# 2. Remove service files
rm -f services/loyalty/purchase-service.js
rm -f services/loyalty/__tests__/purchase-service.test.js

# 3. Revert routes if debug endpoint was added
git checkout HEAD -- routes/loyalty.js

# 4. Verify tests pass
npm test

# 5. Deploy IMMEDIATELY
npm run deploy

# 6. Verify purchases are being recorded again
# Check recent purchase events in database
```

### Phase 6 Completion Checklist

**Files Created:**
- [ ] `services/loyalty/purchase-service.js`
- [ ] `services/loyalty/__tests__/purchase-service.test.js`

**Files Modified:**
- [ ] `utils/loyalty-service.js` (purchase logic delegated)
- [ ] `routes/loyalty.js` (debug endpoint)

**Verification Commands:**

```bash
# 1. Verify purchase service exports
node -e "
const { LoyaltyPurchaseService } = require('./services/loyalty/purchase-service');
console.log('LoyaltyPurchaseService:', typeof LoyaltyPurchaseService === 'function' ? '✓' : '✗');
"

# 2. Run tests
npm test -- --testPathPattern="purchase-service"

# 3. Test debug endpoint
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/loyalty/debug/purchase-trace/TRACE_ID_HERE"
```

**Critical Test Cases:**

| Test Case | Expected Behavior | Verified |
|-----------|-------------------|----------|
| New purchase with qualifying variation | Purchase recorded, progress updated | [ ] |
| Purchase reaching reward threshold | Reward status changed to 'earned' | [ ] |
| Duplicate purchase (same idempotency key) | Not recorded, returns existing ID | [ ] |
| Purchase outside rolling window | Not counted toward current progress | [ ] |
| Refund of qualifying purchase | Negative quantity recorded, progress decreased | [ ] |
| Refund causing earned reward to revert | Reward status changed appropriately | [ ] |
| Transaction rollback on error | No partial data saved | [ ] |

**Database Verification Queries:**

```sql
-- After deployment, verify purchases are being recorded
SELECT COUNT(*) as new_purchases
FROM loyalty_purchase_events
WHERE created_at > NOW() - INTERVAL '1 hour';

-- Verify trace_id is populated
SELECT COUNT(*) as traced,
       COUNT(*) FILTER (WHERE trace_id IS NOT NULL) as with_trace
FROM loyalty_purchase_events
WHERE created_at > NOW() - INTERVAL '1 hour';

-- Verify reward progress is updating
SELECT status, COUNT(*)
FROM loyalty_rewards
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY status;
```

**Sign-Off Checklist:**
- [ ] recordPurchase works correctly
- [ ] updateRewardProgress calculates correctly
- [ ] Rolling window logic works
- [ ] Idempotency prevents duplicates
- [ ] Refunds work correctly
- [ ] Transaction rollback works on errors
- [ ] Debug endpoint returns complete trace
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] Deployed to staging
- [ ] Staging verification: process test order, verify purchase recorded
- [ ] Deployed to production
- [ ] Production verification: monitor for 2 hours
- [ ] Monitored for 24 hours - no purchase recording issues

---

## Phase 7: Reward Service Extraction

**Goal:** Isolate reward redemption and Square discount management
**Risk:** MEDIUM - Involves Square API cleanup
**Validation:** Rewards can be redeemed, discounts cleaned up
**Estimated Complexity:** Medium-High (4-5 hours)
**Dependencies:** Phase 3 (square-client.js), Phase 6 (purchase tracking)

### Pre-Execution Checklist

```bash
# 1. Verify dependencies
test -f services/loyalty/square-client.js && echo "✓ Square client exists" || echo "✗ Missing"
test -f services/loyalty/loyalty-logger.js && echo "✓ Logger exists" || echo "✗ Missing"
test -f services/loyalty/purchase-service.js && echo "✓ Purchase service exists" || echo "✗ Complete Phase 6 first"

# 2. Find reward-related functions
grep -n "async function.*[Rr]eward\|redeemReward\|createRewardDiscount" utils/loyalty-service.js

# 3. Find Square discount management functions
grep -n "createRewardCustomerGroup\|deleteRewardDiscount\|addCustomerToGroup" utils/loyalty-service.js

# 4. Check rewards table structure
# psql $DATABASE_URL -c "\d loyalty_rewards"
# psql $DATABASE_URL -c "\d loyalty_redemptions"
```

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

### Phase 7 Rollback

```bash
# 1. Revert to inline reward functions
git checkout HEAD -- utils/loyalty-service.js

# 2. Remove service files
rm -f services/loyalty/reward-service.js
rm -f services/loyalty/__tests__/reward-service.test.js

# 3. Verify and deploy
npm test && npm run deploy
```

### Phase 7 Completion Checklist

**Files Created:**
- [ ] `services/loyalty/reward-service.js`
- [ ] `services/loyalty/__tests__/reward-service.test.js`

**Files Modified:**
- [ ] `utils/loyalty-service.js` (reward logic delegated)

**Verification Commands:**

```bash
# 1. Verify reward service exports
node -e "
const { LoyaltyRewardService } = require('./services/loyalty/reward-service');
console.log('LoyaltyRewardService:', typeof LoyaltyRewardService === 'function' ? '✓' : '✗');
"

# 2. Run tests
npm test -- --testPathPattern="reward-service"
```

**Critical Test Cases:**

| Test Case | Expected Behavior | Verified |
|-----------|-------------------|----------|
| Redeem earned reward | Status changes to 'redeemed' | [ ] |
| Redeem non-earned reward | Error thrown | [ ] |
| Redeem already redeemed reward | Error thrown | [ ] |
| Square discount created on reward earn | Customer group + pricing rule created | [ ] |
| Square discount cleaned up on redemption | Group and discount deleted | [ ] |
| getEarnedRewards returns correct list | Only 'earned' status rewards | [ ] |

**Sign-Off Checklist:**
- [ ] redeemReward works correctly
- [ ] createSquareDiscount works correctly
- [ ] cleanupSquareDiscount works correctly
- [ ] All unit tests pass
- [ ] Deployed to staging
- [ ] Staging: redeem a test reward
- [ ] Deployed to production
- [ ] Monitored for 24 hours

---

## Phase 8: Webhook Service Orchestration

**Goal:** Create clean entry point for order processing
**Risk:** LOW - Orchestration only (uses all previously created services)
**Validation:** Webhooks process orders correctly
**Estimated Complexity:** Medium (3-4 hours)
**Dependencies:** ALL previous phases (1-7)

### Pre-Execution Checklist

```bash
# Verify ALL dependencies are complete
echo "Checking all service files..."
test -f services/loyalty/loyalty-logger.js && echo "✓ Phase 1: Logger" || echo "✗ Phase 1 incomplete"
test -f services/loyalty/loyalty-tracer.js && echo "✓ Phase 2: Tracer" || echo "✗ Phase 2 incomplete"
test -f services/loyalty/square-client.js && echo "✓ Phase 3: Square Client" || echo "✗ Phase 3 incomplete"
test -f services/loyalty/customer-service.js && echo "✓ Phase 4: Customer Service" || echo "✗ Phase 4 incomplete"
test -f services/loyalty/offer-service.js && echo "✓ Phase 5: Offer Service" || echo "✗ Phase 5 incomplete"
test -f services/loyalty/purchase-service.js && echo "✓ Phase 6: Purchase Service" || echo "✗ Phase 6 incomplete"
test -f services/loyalty/reward-service.js && echo "✓ Phase 7: Reward Service" || echo "✗ Phase 7 incomplete"

# Find current webhook entry point
grep -n "processOrderForLoyalty" routes/webhooks.js
```

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

### Phase 8 Rollback

```bash
# 1. Revert to legacy processOrderForLoyalty
git checkout HEAD -- utils/loyalty-service.js

# 2. Remove orchestration files
rm -f services/loyalty/webhook-service.js
rm -f services/loyalty/index.js
rm -f services/loyalty/__tests__/webhook-service.test.js

# 3. Verify and deploy
npm test && npm run deploy
```

### Phase 8 Completion Checklist

**Files Created:**
- [ ] `services/loyalty/webhook-service.js`
- [ ] `services/loyalty/index.js`
- [ ] `services/loyalty/__tests__/webhook-service.test.js`

**Files Modified:**
- [ ] `utils/loyalty-service.js` (processOrderForLoyalty delegates to webhook service)

**Verification Commands:**

```bash
# 1. Verify all services can be imported from index
node -e "
const loyalty = require('./services/loyalty');
console.log('Exports:', Object.keys(loyalty).length);
console.log('LoyaltyWebhookService:', typeof loyalty.LoyaltyWebhookService === 'function' ? '✓' : '✗');
console.log('LoyaltySquareClient:', typeof loyalty.LoyaltySquareClient === 'function' ? '✓' : '✗');
console.log('LoyaltyCustomerService:', typeof loyalty.LoyaltyCustomerService === 'function' ? '✓' : '✗');
console.log('LoyaltyOfferService:', typeof loyalty.LoyaltyOfferService === 'function' ? '✓' : '✗');
console.log('LoyaltyPurchaseService:', typeof loyalty.LoyaltyPurchaseService === 'function' ? '✓' : '✗');
console.log('LoyaltyRewardService:', typeof loyalty.LoyaltyRewardService === 'function' ? '✓' : '✗');
console.log('loyaltyLogger:', typeof loyalty.loyaltyLogger === 'object' ? '✓' : '✗');
console.log('LoyaltyTracer:', typeof loyalty.LoyaltyTracer === 'function' ? '✓' : '✗');
"

# 2. Run full test suite
npm test

# 3. Test webhook processing
node -e "
const { LoyaltyWebhookService } = require('./services/loyalty');
const testOrder = {
  id: 'test-order-001',
  line_items: [
    { uid: 'li1', catalog_object_id: 'var1', quantity: '1', base_price_money: { amount: 1000 } }
  ],
  created_at: new Date().toISOString()
};
console.log('WebhookService initialized:', !!new LoyaltyWebhookService('test-merchant'));
"
```

**End-to-End Integration Test:**

```bash
# Create integration test script
cat > /tmp/test-webhook-flow.js << 'EOF'
const { LoyaltyWebhookService } = require('./services/loyalty');

async function testWebhookFlow() {
  // Use actual test merchant and order IDs
  const merchantId = process.env.TEST_MERCHANT_ID;
  const testOrder = {
    id: 'TEST-' + Date.now(),
    customer_id: process.env.TEST_CUSTOMER_ID,
    line_items: [
      {
        uid: 'li-1',
        catalog_object_id: process.env.TEST_VARIATION_ID, // Must be qualifying
        quantity: '1',
        base_price_money: { amount: 1000 },
        total_money: { amount: 1000 },
      }
    ],
    created_at: new Date().toISOString(),
  };

  const service = new LoyaltyWebhookService(merchantId);
  const result = await service.processOrder(testOrder, { source: 'TEST' });

  console.log('Result:', JSON.stringify(result, null, 2));
  console.log('Trace ID:', result.traceId);
  console.log('Processed:', result.processed);
  console.log('Customer ID:', result.customerId);
  console.log('Identification Method:', result.identificationMethod);
}

testWebhookFlow().catch(console.error);
EOF

# Run with test credentials
TEST_MERCHANT_ID=xxx TEST_CUSTOMER_ID=xxx TEST_VARIATION_ID=xxx node /tmp/test-webhook-flow.js
```

**Sign-Off Checklist:**
- [ ] Webhook service orchestrates all other services
- [ ] processOrderForLoyalty backward compatible
- [ ] Trace IDs flow through entire process
- [ ] Customer identification uses customer-service
- [ ] Purchase recording uses purchase-service
- [ ] Reward creation uses reward-service
- [ ] All logging prefixed with [LOYALTY:*]
- [ ] Unit tests pass
- [ ] Integration test passes
- [ ] Deployed to staging
- [ ] Staging: process test order via webhook
- [ ] Deployed to production
- [ ] Production: verify webhook processing works
- [ ] Monitored for 48 hours (longer due to orchestration role)

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

## Troubleshooting Guide

### Common Issues and Solutions

#### Issue: Module Import Errors

**Symptom:** `Cannot find module './services/loyalty/...'`

**Solution:**
```bash
# 1. Verify file exists
ls -la services/loyalty/

# 2. Check for typos in require path
grep -r "require.*loyalty" utils/loyalty-service.js

# 3. Ensure directory exists
mkdir -p services/loyalty

# 4. Check Node.js module resolution
node -e "console.log(require.resolve('./services/loyalty/loyalty-logger'))"
```

#### Issue: Database Migration Failures

**Symptom:** `column "trace_id" already exists` or migration errors

**Solution:**
```bash
# 1. Check current column state
psql $DATABASE_URL -c "\d loyalty_audit_logs"

# 2. Use IF NOT EXISTS in migrations (already in our SQL)
# 3. If needed, manually check and add:
psql $DATABASE_URL -c "
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'loyalty_audit_logs' AND column_name = 'trace_id')
    THEN
      ALTER TABLE loyalty_audit_logs ADD COLUMN trace_id UUID;
    END IF;
  END \$\$;
"
```

#### Issue: Square API 401 Unauthorized

**Symptom:** `Square API error 401 on /...`

**Solution:**
```bash
# 1. Verify merchant has valid token
psql $DATABASE_URL -c "SELECT id, square_access_token IS NOT NULL as has_token FROM merchants WHERE id = 'MERCHANT_ID';"

# 2. Check token encryption
node -e "
const { isEncryptedToken, decryptToken } = require('./utils/token-encryption');
// Verify encryption/decryption works
"

# 3. Verify token hasn't expired (refresh if OAuth)
```

#### Issue: Purchases Not Being Recorded

**Symptom:** Orders processed but no entries in `loyalty_purchase_events`

**Diagnosis:**
```sql
-- 1. Check recent orders in audit logs
SELECT * FROM loyalty_audit_logs
WHERE action LIKE '%PURCHASE%' OR action LIKE '%ORDER%'
ORDER BY created_at DESC LIMIT 20;

-- 2. Check if variation is qualifying
SELECT lqv.* FROM loyalty_qualifying_variations lqv
JOIN loyalty_offers lo ON lqv.offer_id = lo.id
WHERE lqv.variation_id = 'YOUR_VARIATION_ID';

-- 3. Check if customer was identified
SELECT * FROM loyalty_audit_logs
WHERE action LIKE '%CUSTOMER%'
ORDER BY created_at DESC LIMIT 10;
```

**Common Causes:**
1. Variation not added to any offer
2. Customer identification failed (all 5 methods)
3. Item was free (total_money = 0)
4. Duplicate purchase (idempotency key exists)

#### Issue: Rewards Not Being Earned

**Symptom:** Customer has enough purchases but reward status is 'in_progress'

**Diagnosis:**
```sql
-- 1. Check current progress
SELECT lo.name, lo.required_quantity,
       COALESCE(SUM(lpe.quantity), 0) as current_quantity
FROM loyalty_offers lo
LEFT JOIN loyalty_purchase_events lpe
  ON lpe.offer_id = lo.id
  AND lpe.square_customer_id = 'CUSTOMER_ID'
  AND lpe.purchased_at >= NOW() - INTERVAL '365 days'
  AND lpe.locked_to_reward_id IS NULL
  AND lpe.quantity > 0
WHERE lo.merchant_id = 'MERCHANT_ID'
GROUP BY lo.id, lo.name, lo.required_quantity;

-- 2. Check for locked purchases (already counted toward previous reward)
SELECT COUNT(*) as locked_purchases
FROM loyalty_purchase_events
WHERE square_customer_id = 'CUSTOMER_ID'
AND locked_to_reward_id IS NOT NULL;

-- 3. Check rolling window
SELECT * FROM loyalty_purchase_events
WHERE square_customer_id = 'CUSTOMER_ID'
AND purchased_at < NOW() - INTERVAL '365 days';
```

**Common Causes:**
1. Rolling window: older purchases expired
2. Purchases locked to previous reward
3. Refunds decreased quantity below threshold

#### Issue: Trace ID Not Appearing in Logs

**Symptom:** Logs exist but trace_id is null

**Solution:**
```bash
# 1. Verify tracer is imported and used
grep -n "LoyaltyTracer\|tracer.startTrace" utils/loyalty-service.js

# 2. Verify traceId is passed to logAuditEvent
grep -n "logAuditEvent.*traceId\|logAuditEvent.*trace" utils/loyalty-service.js

# 3. Check if tracer.endTrace() is called (might be missing on error paths)
grep -n "tracer.endTrace\|endTrace()" utils/loyalty-service.js
```

#### Issue: Square Discount Not Created

**Symptom:** Reward earned but no discount visible in Square

**Diagnosis:**
```sql
-- Check audit logs for discount creation
SELECT * FROM loyalty_audit_logs
WHERE action LIKE '%DISCOUNT%' OR action LIKE '%GROUP%'
AND merchant_id = 'MERCHANT_ID'
ORDER BY created_at DESC LIMIT 20;
```

**Common Causes:**
1. Async discount creation failed silently
2. Square API rate limiting
3. Invalid pricing rule configuration

**Solution:**
```bash
# Check error logs for discount creation failures
grep "DISCOUNT_CREATION_FAILED" /var/log/app.log | tail -20

# Manually trigger discount creation for testing
node -e "
const { LoyaltyRewardService } = require('./services/loyalty');
const service = new LoyaltyRewardService('MERCHANT_ID');
service.initialize()
  .then(() => service.createSquareDiscount({
    rewardId: REWARD_ID,
    customerId: 'CUSTOMER_ID',
    offerId: OFFER_ID
  }))
  .then(r => console.log('Created:', r))
  .catch(e => console.error('Failed:', e));
"
```

### Performance Troubleshooting

#### Slow Order Processing

**Diagnosis:**
```bash
# Check trace durations in logs
grep "ORDER_TRACE_COMPLETE" /var/log/app.log | \
  jq -r '.duration' | \
  awk '{sum+=$1; count++} END {print "Avg:", sum/count, "ms"}'
```

**Common Causes:**
1. Too many Square API calls per order
2. Database queries not using indexes
3. Large number of line items

**Solutions:**
```sql
-- Verify indexes exist
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename LIKE 'loyalty%';

-- Add missing indexes
CREATE INDEX IF NOT EXISTS idx_lpe_customer_offer
ON loyalty_purchase_events(square_customer_id, offer_id);
```

### Emergency Procedures

#### Complete Feature Flag Rollback

If critical issues arise, use feature flags to instantly disable new code:

```bash
# Set environment variable to disable new services
export LOYALTY_NEW_SERVICES=false

# Restart application
npm restart

# Verify old code path is active
grep "USE_NEW" /var/log/app.log | tail -5
```

#### Database Recovery

If data corruption occurs:

```sql
-- 1. Stop processing new orders
-- 2. Identify affected records by trace_id
SELECT * FROM loyalty_purchase_events
WHERE trace_id = 'PROBLEMATIC_TRACE_ID';

-- 3. Delete corrupted records
BEGIN;
DELETE FROM loyalty_purchase_events WHERE trace_id = 'PROBLEMATIC_TRACE_ID';
DELETE FROM loyalty_rewards WHERE trace_id = 'PROBLEMATIC_TRACE_ID';
-- ONLY COMMIT after verification
COMMIT;

-- 4. Reprocess affected orders via backfill
```

---

## Quick Reference Commands

```bash
# Check all service files exist
ls -la services/loyalty/*.js

# Run all loyalty tests
npm test -- --testPathPattern="loyalty"

# Check recent loyalty logs
grep "\[LOYALTY:" /var/log/app.log | tail -50

# Check recent errors
grep "\[LOYALTY:ERROR\]" /var/log/app.log | tail -20

# Verify database connectivity
psql $DATABASE_URL -c "SELECT COUNT(*) FROM loyalty_offers;"

# Check Square API connectivity
node -e "
const { LoyaltySquareClient } = require('./services/loyalty/square-client');
new LoyaltySquareClient('MERCHANT_ID').initialize()
  .then(c => c.getLoyaltyProgram())
  .then(() => console.log('✓ Square API OK'))
  .catch(e => console.error('✗ Square API Error:', e.message));
"

# Monitor webhook processing in real-time
tail -f /var/log/app.log | grep "\[LOYALTY:"
```

---

*Document created: January 22, 2026*
*Last updated: January 22, 2026*
*Target completion: Phased rollout over multiple deployments*
