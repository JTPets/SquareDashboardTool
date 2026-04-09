# Subscription System Audit — Pre-Beta Readiness
**Date**: 2026-04-05 | **Ref**: BACKLOG-122 | **Grade**: NOT BETA-READY

---

## 1. Files in Scope

| File | Lines |
|------|-------|
| `services/subscriptions/subscription-create-service.js` | 321 |
| `services/subscriptions/subscription-bridge.js` | 254 |
| `services/subscriptions/promo-validation.js` | 146 |
| `routes/subscriptions/index.js` | 10 |
| `routes/subscriptions/public.js` | 35 |
| `routes/subscriptions/plans.js` | 24 |
| `routes/subscriptions/merchant.js` | 86 |
| `routes/subscriptions/admin.js` | 93 |
| `routes/subscriptions/webhooks.js` | 44 |
| `middleware/feature-gate.js` | 66 |
| `middleware/merchant.js` | 352 |
| `config/feature-registry.js` | 273 |
| `utils/square-subscriptions.js` | 436 |
| `utils/subscription-handler.js` | 479 |
| `services/webhook-handlers/subscription-handler.js` | 296 |
| `jobs/trial-expiry-job.js` | 168 |

---

## 2. Flow Traces

**1. Trial start** — OAuth merchant onboarding sets `merchants.subscription_status = 'trial'` with `trial_ends_at = NOW() + 30 days`. `middleware/merchant.js` computes `isSubscriptionValid` by comparing `trial_ends_at` to now. `trial-expiry-job.js` runs daily, auto-transitions expired trials to `'expired'` and sends email alerts. No feature unlock happens — trial merchants rely on `isSubscriptionValid = true` passing `requireMerchant`, not `merchant_features`.

**2. Trial → Paid** — No dedicated conversion endpoint. Merchant visits `/subscribe`, submits card via `POST /subscriptions/create`. The create flow immediately creates a Square customer + card + subscription. No "link existing trial merchant" step exists other than `merchantId` from session. After payment, `activateMerchantSubscription()` sets `merchants.subscription_status = 'active'`. **`merchant_features` is never populated** (see §4 Blocking Issue #1).

**3. Promo code apply** — `POST /subscriptions/promo/validate` → `validatePromoCode()` → DB query with platform-owner fallback → plan restriction + minimum purchase checks → discount returned. On create, promo is re-validated inside `createSubscription()`. Usage recorded in `promo_code_uses` + `promo_codes.times_used` incremented. Race condition possible: two simultaneous signups with a `max_uses = 1` code could both pass validation before either records usage.

**4. Fixed price promo ($0.99 beta)** — `discount_type = 'fixed_price'` → `finalPrice = fixed_price_cents (99)`. Since `discountCents > 0` and `finalPriceCents > 0`, `processDiscountedPayment()` is called: charges $0.99 via `/v2/payments`, then creates a Square subscription starting next billing cycle. **Real Square API is called — charge IS wired.** However, `duration_months` is stored on the promo record but **never enforced**; $0.99 continues indefinitely.

**5. Feature gating** — `requireFeature(key)` checks `req.merchantContext.features` (loaded from `merchant_features` WHERE `enabled = TRUE`). Platform owners bypass. Free modules always pass. Paid modules require the feature key in `merchant_features`. **Nothing in the subscription create/activate path populates `merchant_features`** — every paid feature gate will return 403 for new subscribers.

**6. Cancellation** — `POST /subscriptions/cancel` (auth required): calls `squareSubscriptions.cancelSubscription()` (real API, best-effort), then `cancelSubscription()` in DB sets `subscribers.subscription_status = 'canceled'`, then `cancelMerchantSubscription()` sets `merchants.subscription_status = 'cancelled'` (note spelling difference). **Bug**: `middleware/merchant.js` only checks `'expired'` and `'suspended'` for `isSubscriptionValid = false`; `'cancelled'` falls to `else { isSubscriptionValid = true }` — **cancelled merchants retain full access**.

**7. Renewal** — Square sends `invoice.payment_made` webhook → `handleInvoicePaymentMade()` → `activateSubscription()` + `recordPayment()` + bridge activates merchant. `subscription.updated` (status `ACTIVE`) → `handleUpdated()` → re-activates merchant. Webhook path is fully wired. If a webhook is missed, no fallback polling or expiry job exists for paid subscriptions — they stay `active` indefinitely.

**8. Expiry** — Trial: `trial-expiry-job.js` auto-transitions → `expired`. Paid: only via `invoice.payment_failed` webhook → `suspendMerchantSubscription()` → `'suspended'`. No cron job sweeps past-due paid subscriptions. No grace period logic exists.

**9. Upgrade/downgrade** — **Not implemented.** No endpoint, no service logic, no DB support for plan changes. Merchant would have to cancel and re-subscribe.

---

## 3. Hardcoded Values Found

| Location | Value | Issue |
|----------|-------|-------|
| `utils/subscription-handler.js:44-46` | `priceCents = plan === 'annual' ? 9999 : 999` | Fallback prices differ from DB-seeded values ($99.99/mo, $299.99/yr); if plan lookup fails, charges wrong amount |
| `utils/subscription-handler.js:10` | `TRIAL_DAYS = 30` | Not configurable; acceptable but should be env var |
| `database/schema.sql:1264-1265` | `price_cents: 2999` (monthly), `29999` (annual) | Seeded directly; consistent with subscription-handler fallback mismatch |

All `process.env` references (`SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_APPLICATION_ID`, `SQUARE_ENVIRONMENT`) have entries in `.env.example`. No hardcoded merchant IDs or emails found in subscription code.

---

## 4. Broken/Incomplete Paths

1. ~~**`merchant_features` never populated on subscription activation**~~ — **FIXED.** `subscription-bridge.js:46-52` now INSERTs all paid modules.

2. ~~**`'cancelled'` status does not lock access**~~ — **FIXED.** `middleware/merchant.js:145` checks `['expired','suspended','cancelled']`.

3. **`duration_months` not enforced** — `promo_expires_at` is now stored on creation (`subscription-create-service.js:292-296`) and `promo-expiry-job.js` detects expired promos weekly. **But the job only logs warnings — no auto-revert of billing.** A $0.99/month beta code still lasts forever.

4. ~~**No promo race condition protection**~~ — **FIXED.** Atomic `UPDATE...WHERE times_used < max_uses RETURNING id` in `subscription-create-service.js:186-197`.

5. **Subscriber starts as `'trial'` then immediately overwritten** — Cosmetically harmless but semantically confusing. Low priority.

6. **Upgrade/downgrade**: Not implemented. No path to change plans without full cancel + re-subscribe.

7. **No renewal polling fallback**: If Square doesn't deliver `invoice.payment_made`, paid subscription never expires.

---

## 5. Test Coverage Gaps

**Covered:**
- `subscription-create-service.test.js` — three payment paths, promo application
- `promo-validation.test.js` — discount types, plan restrictions, platform-owner fallback
- `subscription-bridge.test.js` — activate/suspend/cancel/resolveMerchantId
- `webhook-handlers/subscription-handler.test.js` — all 5 event types
- `trial-expiry-job.test.js` — notification and auto-transition logic
- `subscription-enforcement.test.js` — requireMerchant gating
- `feature-gate.test.js` — requireFeature logic

**Not covered / gaps:**
- `duration_months` auto-revert (detection exists, billing revert does not)
- Upgrade/downgrade (not implemented)

---

## 6. Blocking Issues Before Beta

| # | Issue | Risk | Status |
|---|-------|------|--------|
| ~~**B1**~~ | ~~`merchant_features` not populated on activation~~ | ~~CRITICAL~~ | **FIXED** — `subscription-bridge.js:46-52` INSERTs all `getPaidModules()` on activation |
| ~~**B2**~~ | ~~`'cancelled'` status → `isSubscriptionValid = true`~~ | ~~HIGH~~ | **FIXED** — `middleware/merchant.js:145` checks `['expired','suspended','cancelled']` |
| **B3** | `duration_months` not enforced on `fixed_price` promos | HIGH | **PARTIALLY FIXED** — `promo_expires_at` stored, `promo-expiry-job.js` detects, but only logs warnings. No auto-revert of billing. |
| ~~**B4**~~ | ~~Promo `max_uses` race condition~~ | ~~MEDIUM~~ | **FIXED** — `subscription-create-service.js:186-197` atomic `UPDATE...WHERE times_used < max_uses RETURNING id` |
| ~~**B5**~~ | ~~Hardcoded fallback prices differ from DB~~ | ~~MEDIUM~~ | **FIXED** — `subscription-handler.js:33-46` DB lookup only, throws on missing plan |

---

## 7. Remaining Fix

**B3** — The `promo-expiry-job.js` detects expired promos weekly but only logs warnings. Needs: (1) auto-update `discount_applied_cents = 0`, (2) Square API call to update subscription to full price, (3) merchant notification.
