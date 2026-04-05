# Subscriptions Route Extraction Plan

`routes/subscriptions.js` — 870 lines, 14 endpoints.
Existing services: `services/subscriptions/subscription-bridge.js` (192 lines), `services/subscriptions/promo-validation.js` (101 lines).

---

## Endpoints & Handler Classification

| Method | Path | Handler | Where inline logic should go |
|--------|------|---------|------------------------------|
| GET | `/public/pricing` | Inline: featureRegistry map (~15 lines) | Thin enough; stays in route |
| GET | `/public/promo/check` | Inline: DB query + discount display (~40 lines) | `promo-validation.js` → add `checkPublicPromo(code)` |
| GET | `/square/payment-config` | Inline: reads 3 env vars (~5 lines) | Stays in route |
| GET | `/subscriptions/plans` | Thin → `subscriptionHandler.getPlans()` | — |
| POST | `/subscriptions/promo/validate` | Thin → `validatePromoCode()` | — |
| POST | `/subscriptions/create` | **Inline: 365 lines** (Square customer+card, 3 payment paths, user account creation, promo recording) | New `subscription-create-service.js` |
| GET | `/subscriptions/status` | Thin → `subscriptionHandler.checkSubscriptionStatus()` | — |
| GET | `/subscriptions/merchant-status` | Inline: assembles System A context + subscriber billing (~35 lines) | Add `getMerchantStatusSummary()` to `subscription-bridge.js` |
| POST | `/subscriptions/cancel` | Inline: Square cancel + bridge + logEvent (~45 lines) | Move Square cancel call to `subscription-bridge.js` as `cancelWithSquare()` |
| POST | `/subscriptions/refund` | Inline: Square refund API + processRefund + logEvent (~55 lines) | New `subscription-refund-service.js` or extend `subscription-bridge.js` |
| GET | `/subscriptions/admin/list` | Thin → `subscriptionHandler.getAllSubscribers()` | — |
| GET | `/subscriptions/admin/plans` | Thin → `squareSubscriptions.listPlans()` | — |
| POST | `/subscriptions/admin/setup-plans` | Thin → `squareSubscriptions.setupSubscriptionPlans()` (super-admin guard inline) | Guard could move to middleware |
| GET | `/webhooks/events` | Inline: dynamic SQL + stats query (~50 lines) | `subscriptionHandler` or new `webhook-events-service.js` |

---

## Key Findings

**Single biggest target:** `POST /subscriptions/create` contains 365 lines across three payment branches (discounted first-payment + schedule, 100%-free, full Square-managed). Extracting to `subscription-create-service.js` would bring the route file from 870 → ~500 lines and the handler from 365 → ~15 lines.

**Existing services are clean and small.** `subscription-bridge.js` and `promo-validation.js` were recently moved to `services/subscriptions/` (BACKLOG-74). Both have room (108+ lines of headroom to 300) to absorb adjacent logic:
- `promo-validation.js`: add `checkPublicPromo()` for `/public/promo/check`
- `subscription-bridge.js`: add `getMerchantStatusSummary()` and `cancelWithSquare()`

**Super-admin guard duplicated** in `admin/setup-plans` and `webhooks/events` — candidate for a `requireSuperAdmin` middleware.

---

## Test Coverage

**Covered** (4 test files, ~29 tests):
`POST /subscriptions/create`, `POST /subscriptions/promo/validate`, `GET /subscriptions/status`, `POST /subscriptions/cancel`, `POST /subscriptions/refund`, `GET /subscriptions/admin/list`, `GET /subscriptions/admin/setup-plans` — via `subscriptions.test.js`, `subscription-status-security.test.js`, `subscription-tenant-isolation.test.js`, `subscription-rate-limit.test.js`.

**Not tested (5 endpoints):**
- `GET /public/pricing` — no test file
- `GET /public/promo/check` — no test file
- `GET /square/payment-config` — no test file
- `GET /subscriptions/merchant-status` — no test file
- `GET /webhooks/events` — no test file

---

## Test Plan

**Existing tests:** ~29 across 4 files (all pass).

**Estimated new tests needed: ~18**
- `/public/pricing`: 2 (modules listed, bundles listed)
- `/public/promo/check`: 5 (valid code, expired, invalid, rate-limited, discountDisplay formatting per type)
- `/square/payment-config`: 2 (env vars present, env vars absent)
- `/subscriptions/merchant-status`: 5 (active, trial countdown, suspended, no subscriber, no merchant)
- `/webhooks/events`: 4 (super-admin gate, status filter, event_type filter, stats shape)

**Highest risk untested:**
1. `/public/promo/check` — public endpoint with DB query, discount calculation, and no coverage
2. `/subscriptions/merchant-status` — combines System A + B data; trial countdown math untested
3. `/webhooks/events` — super-admin gate logic duplicated from `admin/setup-plans` and untested here
