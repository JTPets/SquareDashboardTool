# Seniors Day Discount Feature

## Overview

Monthly discount program for customers aged 60+ with a Square customer profile. Runs on the 1st of every month, all day, at all locations.

---

## Business Requirements

| Requirement | Details |
|-------------|---------|
| **Eligibility** | Customer must be 60+ years old with DOB on file in Square |
| **Timing** | 1st of every month, all day (12:00 AM - 11:59 PM), all locations |
| **Discount** | 10% off entire order (all items including clearance/sale) |
| **Loyalty Points** | 1% loyalty accrual continues on the discounted total (independent of discount) |
| **Stacking** | Discounts stack — seniors discount + loyalty rewards both apply if earned |
| **Identification** | Staff manually adds DOB to customer profile at POS checkout |

> **Note on Loyalty Membership:** Loyalty membership is **not required** for the seniors discount. Any customer with a Square profile and DOB on file qualifies if they're 60+. However, loyalty membership is **recommended** for accurate tracking across all systems (purchase history, rewards, reporting).

> **Note on Stacking:** For the initial implementation, discounts stack. If a customer is in the seniors group AND has an active loyalty reward, both apply. This keeps the implementation simple. Stacking behavior may be revisited in a future iteration if margin impact is too high.

---

## Technical Approach: Square-Native Implementation

This feature uses the same pattern as the existing loyalty system — **Customer Groups + Catalog Pricing Rules** managed by our automation layer.

### Architecture Components

```
┌──────────────────────────────────────────────────────────────────┐
│                     SENIORS DAY SYSTEM                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐     ┌─────────────────┐                    │
│  │ Square Customer │     │ Catalog Pricing │                    │
│  │ Group: Seniors  │────▶│ Rule: 10% Off   │                    │
│  │ (60+)           │     │ for Seniors Grp │                    │
│  └────────┬────────┘     └────────┬────────┘                    │
│           │                       │                              │
│           │                       │                              │
│           ▼                       ▼                              │
│  ┌─────────────────────────────────────────────┐                │
│  │              Square POS                      │                │
│  │  - Customer identified at checkout           │                │
│  │  - If in Seniors group AND pricing rule      │                │
│  │    is active → 10% auto-applies              │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                     OUR AUTOMATION LAYER                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐     ┌─────────────────┐                    │
│  │ customer.updated│     │ Cron Jobs       │                    │
│  │ Webhook Handler │     │                 │                    │
│  │                 │     │ - 1st: Enable   │                    │
│  │ DOB → Age Check │     │ - 2nd: Disable  │                    │
│  │ → Group Mgmt    │     │ - Monthly: Scan │                    │
│  └─────────────────┘     └─────────────────┘                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Square API Calls Required

### 1. Customer Group Management

**One-time setup:** Create "Seniors (60+)" customer group per merchant.

```javascript
// Create customer group
POST /v2/customers/groups
{
  "idempotency_key": "seniors-group-{merchantId}",
  "group": {
    "name": "Seniors (60+)"
  }
}
// Response: { "group": { "id": "GROUP_ID", "name": "Seniors (60+)" } }
```

**Existing functions to leverage** (`services/loyalty-admin/loyalty-service.js`):
- `createRewardCustomerGroup()` → lines 3500-3567
- `addCustomerToGroup()` → lines 3590-3633
- `removeCustomerFromGroup()` → lines 3657-3700
- `deleteCustomerGroup()` → lines 3723-3766

**Modern equivalents** (`services/loyalty/square-client.js`):
- `createCustomerGroup()` → line 355
- `addCustomerToGroup()` → line 392
- `removeCustomerFromGroup()` → line 406
- `deleteCustomerGroup()` → line 371

### 2. Catalog Discount Object

**One-time setup:** Create 10% discount catalog object.

```javascript
// Create discount object
POST /v2/catalog/object
{
  "idempotency_key": "seniors-discount-{merchantId}",
  "object": {
    "type": "DISCOUNT",
    "id": "#seniors-10-off",
    "discount_data": {
      "name": "Seniors Day (10% Off)",
      "discount_type": "FIXED_PERCENTAGE",
      "percentage": "10"
    }
  }
}
// Response: { "catalog_object": { "id": "DISCOUNT_ID", ... } }
```

**Existing pattern** (`services/expiry/discount-service.js`):
- `upsertSquareDiscount()` → lines 371-483

### 3. Pricing Rule (Enable/Disable)

The pricing rule ties the discount to the customer group. **Enable on 1st, disable on 2nd**.

```javascript
// Create/Enable pricing rule
POST /v2/catalog/batch-upsert
{
  "idempotency_key": "seniors-pricing-rule-{merchantId}",
  "batches": [{
    "objects": [
      {
        "type": "PRODUCT_SET",
        "id": "#seniors-all-items",
        "product_set_data": {
          "name": "seniors-all-items",
          "all_products": true  // Applies to ALL items (including clearance/sale)
        }
      },
      {
        "type": "PRICING_RULE",
        "id": "#seniors-pricing-rule",
        "pricing_rule_data": {
          "name": "seniors-day-discount",
          "discount_id": "{DISCOUNT_ID}",
          "match_products_id": "#seniors-all-items",
          "customer_group_ids_any": ["{SENIORS_GROUP_ID}"],
          "valid_from_date": "2026-02-01",  // Dynamic: 1st of month
          "valid_until_date": "2026-02-01"  // Same day only
        }
      }
    ]
  }]
}
```

**To disable:** Update pricing rule with past dates or delete it.

> ⚠️ **PHASE 2 VALIDATION:** During Phase 2 setup, test with a throwaway pricing rule to confirm that `valid_from_date`/`valid_until_date` AND `customer_group_ids_any` correctly requires **BOTH** conditions (date match AND group membership) before applying the discount. If Square treats them as OR conditions (either date OR group), we fall back to the enable/disable cron approach (create/delete the pricing rule on the 1st/2nd rather than using date constraints). This is not a blocker for starting Phase 2 — it will be validated as part of the Square object setup.

**Existing pattern** (`services/expiry/discount-service.js`):
- `upsertPricingRule()` → lines 948-1107

### 4. Customer Lookup (for DOB)

When customer is updated with DOB, fetch full customer details.

```javascript
// Get customer details including birthday
GET /v2/customers/{customer_id}

// Response includes:
{
  "customer": {
    "id": "CUSTOMER_ID",
    "given_name": "John",
    "family_name": "Doe",
    "birthday": "1960-05-15"  // YYYY-MM-DD format
  }
}
```

---

## Database Schema

### New Migration: `database/migrations/032_seniors_day.sql`

```sql
-- ========================================
-- MIGRATION: Seniors Day Discount Feature
-- ========================================
-- Manages age-based discount eligibility via Square Customer Groups.
-- Usage: psql -d your_database -f database/migrations/032_seniors_day.sql

BEGIN;

-- ----------------------------------------
-- 1. Add birthday to loyalty_customers
-- ----------------------------------------
-- Square provides birthday in YYYY-MM-DD format
-- We cache it locally for efficient age calculations

ALTER TABLE loyalty_customers
ADD COLUMN IF NOT EXISTS birthday DATE;

CREATE INDEX IF NOT EXISTS idx_loyalty_customers_birthday
ON loyalty_customers(merchant_id, birthday)
WHERE birthday IS NOT NULL;

COMMENT ON COLUMN loyalty_customers.birthday IS 'Customer birthday from Square (YYYY-MM-DD), used for seniors discount eligibility';

-- ----------------------------------------
-- 2. Seniors discount configuration table
-- ----------------------------------------
-- Tracks the Square objects created for each merchant's seniors discount

CREATE TABLE IF NOT EXISTS seniors_discount_config (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),

    -- Square object IDs
    square_group_id TEXT,              -- Customer Group: "Seniors (60+)"
    square_discount_id TEXT,           -- Catalog Discount: 10% off
    square_product_set_id TEXT,        -- Product Set: all items
    square_pricing_rule_id TEXT,       -- Pricing Rule: ties it together

    -- Configuration
    discount_percent INTEGER NOT NULL DEFAULT 10,
    min_age INTEGER NOT NULL DEFAULT 60,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    -- Timestamps
    last_enabled_at TIMESTAMPTZ,       -- Last time pricing rule was enabled
    last_disabled_at TIMESTAMPTZ,      -- Last time pricing rule was disabled
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT seniors_discount_config_merchant_unique UNIQUE(merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_seniors_config_merchant
ON seniors_discount_config(merchant_id);

COMMENT ON TABLE seniors_discount_config IS 'Seniors Day discount configuration per merchant - stores Square object IDs and settings';

-- ----------------------------------------
-- 3. Seniors group membership tracking
-- ----------------------------------------
-- Tracks which customers are in the seniors group (denormalized for queries)

CREATE TABLE IF NOT EXISTS seniors_group_members (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    square_customer_id TEXT NOT NULL,
    birthday DATE NOT NULL,
    age_at_last_check INTEGER NOT NULL,
    added_to_group_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_from_group_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT seniors_group_members_unique UNIQUE(merchant_id, square_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_seniors_members_merchant_active
ON seniors_group_members(merchant_id, is_active)
WHERE is_active = TRUE;

COMMENT ON TABLE seniors_group_members IS 'Tracks customers in the Seniors (60+) customer group';

-- ----------------------------------------
-- 4. Seniors discount audit log
-- ----------------------------------------
-- Tracks all changes for debugging and compliance

CREATE TABLE IF NOT EXISTS seniors_discount_audit_log (
    id SERIAL PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id),
    action TEXT NOT NULL,              -- 'PRICING_RULE_ENABLED', 'PRICING_RULE_DISABLED',
                                       -- 'CUSTOMER_ADDED', 'CUSTOMER_REMOVED', 'AGE_SWEEP'
    square_customer_id TEXT,
    details JSONB,                     -- Additional context
    triggered_by TEXT NOT NULL,        -- 'CRON', 'WEBHOOK', 'MANUAL', 'BACKFILL'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seniors_audit_merchant_date
ON seniors_discount_audit_log(merchant_id, created_at DESC);

COMMENT ON TABLE seniors_discount_audit_log IS 'Audit trail for seniors discount actions';

-- ----------------------------------------
-- Success message
-- ----------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Seniors Day migration completed successfully!';
    RAISE NOTICE 'Tables created/modified:';
    RAISE NOTICE '  - loyalty_customers.birthday column added';
    RAISE NOTICE '  - seniors_discount_config (Square object IDs)';
    RAISE NOTICE '  - seniors_group_members (membership tracking)';
    RAISE NOTICE '  - seniors_discount_audit_log (audit trail)';
END $$;

COMMIT;
```

---

## Cron Jobs

### 1. Enable Pricing Rule (1st of Month)

**Schedule:** `0 6 * * *` (6:00 AM daily) — checks if today is the 1st

```javascript
// jobs/seniors-day-job.js

/**
 * Check if today is the 1st and enable seniors pricing rule
 * Runs daily at 6 AM (before store opens)
 */
async function runSeniorsDiscountCheck() {
    const today = new Date();
    const dayOfMonth = today.getDate();

    if (dayOfMonth === 1) {
        await enableSeniorsPricingRule();
    } else if (dayOfMonth === 2) {
        await disableSeniorsPricingRule();
    }
}
```

**Alternative:** Two separate cron jobs

```
// Enable: 1st at 5:00 AM
0 5 1 * *  → enableSeniorsPricingRule()

// Disable: 2nd at 5:00 AM
0 5 2 * *  → disableSeniorsPricingRule()
```

### 2. Monthly Age Sweep

**Schedule:** `0 4 1 * *` (4:00 AM on 1st of month, before enable)

Scans all customers with DOB on file to add anyone who turned 60 since last month.

```javascript
/**
 * Monthly sweep to find customers who turned 60
 * Runs at 4 AM on 1st before the pricing rule is enabled
 */
async function runMonthlyAgeSweep() {
    // 1. Query all customers with birthday set
    // 2. Calculate age as of today
    // 3. For age >= 60 and not in group → add to group
    // 4. For age < 60 and in group → remove from group (edge case)
}
```

### Cron Scheduler Integration

Add to `jobs/cron-scheduler.js`:

```javascript
const { runScheduledSeniorsDiscount } = require('./seniors-day-job');

// Seniors Day discount management
// Runs daily to check if pricing rule should be enabled/disabled
const seniorsSchedule = process.env.SENIORS_DISCOUNT_CRON || '0 6 * * *';
cronTasks.push(cron.schedule(seniorsSchedule, runScheduledSeniorsDiscount, {
    timezone: 'America/Toronto'
}));
logger.info('Seniors discount cron job scheduled', {
    schedule: seniorsSchedule,
    timezone: 'America/Toronto'
});
```

---

## Webhook Handler: customer.updated

### Current Handler Location

`services/webhook-handlers/catalog-handler.js:94-147`

### Webhook Payload (VALIDATED)

The `customer.updated` webhook does **NOT** include the birthday field in the payload — only the entity ID. The handler must re-fetch the customer via Square API to get the birthday.

```javascript
// customer.updated webhook → extract entity ID → re-fetch customer
const customer = await squareClient.customers.get({ customerId: entityId });
const birthday = customer.customer.birthday; // "YYYY-MM-DD" or undefined
```

### Required Extension

When `customer.updated` fires, re-fetch the customer and check for birthday. If present, calculate age and manage group membership.

```javascript
// Extended handleCustomerUpdated in catalog-handler.js

async handleCustomerUpdated(context) {
    const { data, merchantId, entityId } = context;
    const result = { handled: true };

    if (!merchantId) {
        return result;
    }

    const customerId = entityId || data?.customer?.id;
    if (!customerId) {
        return result;
    }

    // Existing: Sync customer notes to delivery orders
    // ... (existing code) ...

    // Existing: Run loyalty catchup
    // ... (existing code) ...

    // NEW: Handle birthday/seniors eligibility
    // Must re-fetch customer to get birthday (not included in webhook payload)
    try {
        const squareClient = await getSquareClientForMerchant(merchantId);
        const customerResponse = await squareClient.customers.get({ customerId });
        const birthday = customerResponse.customer?.birthday;

        if (birthday) {
            const seniorsResult = await seniorsService.handleCustomerBirthdayUpdate({
                merchantId,
                squareCustomerId: customerId,
                birthday  // "YYYY-MM-DD" format
            });

            if (seniorsResult.groupChanged) {
                result.seniorsDiscount = seniorsResult;
            }
        }
    } catch (error) {
        logger.warn('Failed to check seniors eligibility', {
            customerId,
            merchantId,
            error: error.message
        });
        // Non-blocking: don't fail the webhook for seniors check
    }

    return result;
}
```

### Birthday Update Flow

```
┌─────────────────────────────────────────────────────────────────┐
│              customer.updated Webhook Flow                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. Extract customer ID from webhook payload                      │
│    customerId = entityId || data.customer.id                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Re-fetch customer from Square API (birthday not in webhook)  │
│    customer = await squareClient.customers.get({ customerId })  │
│    birthday = customer.customer.birthday  // "YYYY-MM-DD"       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Cache birthday to loyalty_customers table                     │
│    UPDATE loyalty_customers SET birthday = $1                    │
│    WHERE square_customer_id = $2 AND merchant_id = $3           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Calculate age                                                 │
│    age = calculateAge("1960-05-15") → 65                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────┐        │        ┌────────────────────────┐
│  age >= 60?        │────YES─┼───────▶│ Add to Seniors Group   │
│                    │        │        │ PUT /customers/{id}/   │
│                    │        │        │     groups/{groupId}   │
└────────────────────┘        │        └────────────────────────┘
         │                    │
         NO                   │
         │                    │
         ▼                    │
┌────────────────────────────┐│
│ Check if in group          ││
│ (shouldn't be, but verify) ││
└────────────────────────────┘│
         │                    │
         ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Log to seniors_discount_audit_log                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## New Files to Create

| File | Purpose |
|------|---------|
| `services/seniors/index.js` | Service entry point, exports public API |
| `services/seniors/seniors-service.js` | Core business logic for seniors discount |
| `services/seniors/age-calculator.js` | Age calculation utilities |
| `jobs/seniors-day-job.js` | Cron job handlers for enable/disable/sweep |
| `database/migrations/032_seniors_day.sql` | Database schema changes |
| `middleware/validators/seniors.js` | Validation rules for admin routes |
| `routes/seniors.js` | Admin API endpoints |
| `public/seniors.html` | Admin UI page (standalone, not a loyalty tab) |
| `public/js/seniors.js` | Admin UI frontend logic |

---

## Existing Files to Modify

| File | Change |
|------|--------|
| `services/webhook-handlers/catalog-handler.js` | Extend `handleCustomerUpdated()` to check birthday |
| `jobs/cron-scheduler.js` | Add seniors discount cron job registration |
| `config/constants.js` | Add `SENIORS_DISCOUNT` configuration namespace |
| `.env.example` | Add `SENIORS_DISCOUNT_CRON` schedule variable |

---

## Service Architecture

Following the patterns established in `services/loyalty/` and `services/expiry/`:

```
services/seniors/
├── index.js                    # Public API exports
├── seniors-service.js          # Main orchestration service
│   ├── initialize()            # Create Square objects (one-time setup)
│   ├── enablePricingRule()     # Called on 1st of month
│   ├── disablePricingRule()    # Called on 2nd of month
│   ├── handleCustomerBirthdayUpdate()  # Webhook handler
│   ├── runMonthlyAgeSweep()    # Monthly scan for new seniors
│   └── backfillExistingCustomers()     # One-time backfill
└── age-calculator.js           # Pure utility functions
    ├── calculateAge()          # Birthday → age
    ├── isSenior()              # Age >= 60 check
    └── getNextBirthday()       # For future features
```

### Service Initialization Pattern

```javascript
// services/seniors/seniors-service.js

const logger = require('../../utils/logger');
const db = require('../../utils/database');

class SeniorsService {
    constructor(merchantId) {
        this.merchantId = merchantId;
        this.squareClient = null;  // Lazy-loaded
        this.config = null;        // Cached config
    }

    async initialize() {
        // Ensure Square objects exist for this merchant
        // Called on first access or by setup script
    }

    async handleCustomerBirthdayUpdate({ squareCustomerId, birthday }) {
        // Process birthday update from webhook
    }
}

module.exports = SeniorsService;
```

---

## Configuration Constants

Add to `config/constants.js`:

```javascript
// Seniors Day discount configuration
SENIORS_DISCOUNT: {
    MIN_AGE: 60,
    DISCOUNT_PERCENT: 10,
    GROUP_NAME: 'Seniors (60+)',
    DISCOUNT_NAME: 'Seniors Day (10% Off)',
    DAY_OF_MONTH: 1,  // 1st of every month
},
```

---

## Admin UI (Phase 6)

Standalone admin page at `/seniors.html` for operational visibility and manual controls. **Not a tab on the loyalty page** — this is a separate feature with its own UI.

### Page Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  Seniors Day Discount - Admin                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Configuration                                            │   │
│  │ ─────────────────────────────────────────────────────── │   │
│  │ Status: ● Enabled / ○ Disabled    [Enable] [Disable]    │   │
│  │ Discount: 10%       Min Age: 60                         │   │
│  │ Square Group ID: GRP_xxx...       Last Enabled: Feb 1   │   │
│  │ Pricing Rule ID: RULE_xxx...      Last Disabled: Feb 2  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Group Members (147 customers)           [Run Backfill]  │   │
│  │ ─────────────────────────────────────────────────────── │   │
│  │ Name              Birthday      Age   Added             │   │
│  │ John Smith        1960-05-15    65    2026-01-15        │   │
│  │ Mary Jones        1958-12-03    67    2026-01-20        │   │
│  │ ...                                                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Audit Log                                                │   │
│  │ ─────────────────────────────────────────────────────── │   │
│  │ 2026-02-01 06:00  PRICING_RULE_ENABLED    CRON          │   │
│  │ 2026-01-31 14:22  CUSTOMER_ADDED          WEBHOOK       │   │
│  │ 2026-01-15 09:00  AGE_SWEEP               CRON          │   │
│  │ ...                                                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### API Endpoints (`routes/seniors.js`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/seniors/config` | Get current configuration and Square object IDs |
| POST | `/api/seniors/enable` | Manually enable pricing rule (outside normal schedule) |
| POST | `/api/seniors/disable` | Manually disable pricing rule |
| GET | `/api/seniors/members` | List customers in the seniors group (paginated) |
| POST | `/api/seniors/backfill` | Trigger backfill of existing customers with DOB |
| GET | `/api/seniors/audit` | Get audit log entries (paginated) |

### Features

1. **View Config** — Display current settings, Square object IDs, and status
2. **View Group Members** — Paginated list of customers in the seniors group with name, birthday, age, and add date
3. **Manual Enable/Disable** — Override the cron schedule for testing or emergencies (logs as `MANUAL` trigger)
4. **Backfill Trigger** — Run the age sweep on-demand for existing customers
5. **Audit Log** — Searchable/filterable log of all actions (enables, disables, customer adds/removes)

---

## Implementation Phases

### Phase 1: Plan & Document ✅ (This Document)
- [x] Create implementation plan
- [x] Document Square API calls
- [x] Document cron jobs
- [x] Document webhook flow
- [x] Identify files to create/modify

### Phase 2: Data Layer
- [x] **VALIDATED:** customer.updated webhook requires re-fetch for birthday (confirmed)
- [ ] **VALIDATE DURING SETUP:** Test pricing rule date+group behavior with throwaway rule
- [ ] Create migration `032_seniors_day.sql`
- [ ] Run migration on database
- [ ] Create Square customer group (one-time per merchant)
- [ ] Create Square discount object (one-time per merchant)

### Phase 3: Core Service
- [ ] Create `services/seniors/` directory
- [ ] Implement `seniors-service.js` with core functions
- [ ] Implement `age-calculator.js` utilities
- [ ] Write unit tests for age calculation

### Phase 4: Automation
- [ ] Extend `catalog-handler.js` with birthday handling
- [ ] Create `jobs/seniors-day-job.js`
- [ ] Register cron jobs in `cron-scheduler.js`
- [ ] Implement monthly age sweep

### Phase 5: Backfill & Testing
- [ ] Create backfill script for existing customers
- [ ] Test full flow in development
- [ ] Test Square POS discount application
- [ ] Document edge cases

### Phase 6: Admin UI
- [ ] Create `public/seniors.html` (standalone page, not a loyalty tab)
- [ ] Create `public/js/seniors.js` (frontend logic)
- [ ] Create `routes/seniors.js` (API endpoints)
- [ ] Implement view config feature
- [ ] Implement view group members feature
- [ ] Implement manual enable/disable toggle
- [ ] Implement backfill trigger button
- [ ] Implement audit log viewer

> **Note:** Phase 6 is for operational visibility and manual controls. Automation (Phases 2-5) should be completed first — the admin UI is for monitoring and troubleshooting, not the primary workflow.

---

## Edge Cases to Handle

| Case | Handling |
|------|----------|
| Customer removes birthday | Keep in group if previously 60+ (data correction is rare) |
| Birthday format variations | Square standardizes to YYYY-MM-DD |
| Customer turns 60 mid-month | Added to group immediately, discount applies next 1st |
| Customer in multiple groups | Square handles gracefully, all applicable discounts apply |
| Pricing rule already exists | Upsert pattern handles updates |
| Webhook arrives twice | Idempotent operations (check before add) |
| Customer has loyalty reward + seniors | Both discounts apply (stacking allowed in v1) |
| Customer not in loyalty program | Still qualifies for seniors discount if 60+ with DOB on file |

---

## Testing Checklist

- [ ] Unit tests for age calculation
- [ ] Unit tests for service methods
- [ ] Integration test: customer.updated webhook with birthday
- [ ] Integration test: Cron job enables pricing rule on 1st
- [ ] Integration test: Cron job disables pricing rule on 2nd
- [ ] Manual test: Verify discount appears at Square POS
- [ ] Manual test: Verify loyalty points accrue on discounted total

---

## Monitoring & Alerting

Leverage existing email notification pattern from `jobs/expiry-discount-job.js`:

```javascript
// Send daily summary if any changes occurred
if (customersAdded > 0 || customersRemoved > 0 || pricingRuleChanged) {
    await emailNotifier.sendAlert(
        `Seniors Day Report - ${businessName}`,
        `Summary:\n- Customers added to group: ${customersAdded}\n- ...`
    );
}
```

---

## Rollout Plan

1. **Development**: Test full flow with test merchant
2. **Staging**: Verify with real Square sandbox
3. **Production**:
   - Run migration
   - Initialize Square objects for JTPets
   - Backfill existing customers with DOB
   - Enable cron jobs
4. **Monitor**: Watch first Seniors Day (1st of next month)

---

## Open Questions

1. **Multi-location:** Does the discount apply to all locations, or should it be configurable per location?
   - **Assumed:** All locations (simplest approach)

2. **Manual override:** Should staff be able to manually add someone to the seniors group without DOB verification?
   - **Assumed:** No, age verification via DOB only

---

## References

- Existing customer group pattern: `services/loyalty-admin/loyalty-service.js:3500-3766`
- Existing pricing rule pattern: `services/expiry/discount-service.js:948-1107`
- Existing webhook handler: `services/webhook-handlers/catalog-handler.js:94-147`
- Existing cron job pattern: `jobs/expiry-discount-job.js`
- Birthday sync backlog item: `docs/TECHNICAL_DEBT.md:839-909` (BACKLOG-4)
