# Feature Packaging + Plan-to-Feature Mapping Audit

**Date**: 2026-04-05  
**Status**: All-or-nothing backend. Per-module UI is a broken promise.

---

## 1. Current Architecture (How It Actually Works)

**subscription_plans** table has two rows: `monthly` ($29.99/mo) and `annual` ($299.99/yr).  
No columns reference modules. No `plan_features` mapping table exists.

**merchant_features** table stores per-merchant feature flags with a `source` column  
(`subscription` | `admin_override`). feature-gate.js reads `req.merchantContext.features`  
(loaded from this table) to allow or deny route access.

**feature-registry.js** defines 8 modules (1 free `base` + 7 paid) and 1 bundle (`full_suite`).  
The 7 paid modules have individual prices ($9.99–$19.99). The bundle is $59.99/mo.  
**None of these prices or module keys appear in the billing flow.**

---

## 2. Plan → Feature Mapping (Exact Trace)

```
subscribe.html (monthly/annual only)
  → POST /api/subscriptions/create  { plan: 'monthly' | 'annual' }
  → subscription-create-service.js::createSubscription()
  → subscriptionBridge.activateMerchantSubscription()
  → getPaidModules()  ← returns ALL 7 paid modules
  → INSERT INTO merchant_features (ALL modules, source='subscription')
```

**Result**: Every subscriber — monthly OR annual — gets all 7 modules enabled simultaneously.  
The `plan` parameter is used only for Square billing; it has zero effect on which features are granted.

**Cancellation**: `cancelMerchantSubscription()` disables rows where `source = 'subscription'`.  
`admin_override` rows survive cancellation correctly.

**Suspension**: `suspendMerchantSubscription()` sets merchant status to `suspended` but does  
**not** disable any `merchant_features` rows. Feature gate still passes if rows exist.

---

## 3. UI vs Backend Alignment

| Surface | What It Shows | What Backend Does |
|---------|--------------|-------------------|
| `pricing.html` | Per-module prices ($9.99–$59.99), individual CTAs | All CTAs link to `/subscribe.html` — no module param passed |
| `subscribe.html` | Monthly vs Annual plan selection only | Enables ALL modules on subscribe |
| `upgrade.html` | Monthly vs Annual plan cards | Same — no module granularity |
| `feature-registry.js` | 7 individual prices + full_suite bundle | Bundle key never used in any billing path |

**pricing.js comment** (line ~50) explicitly notes: *"module keys (e.g. 'cycle_counts') are not  
valid plan keys"* — confirming the disconnect is known at the JS layer.

---

## 4. What Works

- **Feature gate enforcement** (`feature-gate.js`): correctly reads `merchant_features` per-module  
  and blocks unpaid routes with proper error codes including `price_cents`.
- **Admin override UI**: admin can toggle individual features; `source='admin_override'` rows  
  survive plan cancellation (correct behavior).
- **Platform owner bypass**: `platform_owner` status skips all feature checks.
- **All-or-nothing for beta**: current subscriber base gets everything — zero support friction.
- **Cancellation cleanup**: only wipes `source='subscription'` rows, preserving admin grants.

---

## 5. What's Broken or Missing

1. **Broken promise on pricing.html**: page advertises per-module pricing with individual "Get  
   Started" CTAs. Clicking any CTA goes to subscribe.html which only offers monthly/annual.  
   A merchant cannot buy only `cycle_counts` for $9.99.

2. **full_suite bundle is dead code**: defined in feature-registry.js with $59.99 price, rendered  
   on pricing.html, but no billing path accepts `bundle_key`. It's display-only.

3. **No plan_features mapping**: `subscription_plans` has no `features` column. No  
   `plan_module_map` or join table exists. Plan granularity is structurally impossible today.

4. ~~**Suspension gap**~~: **FIXED** (2026-04-09 verified). `subscription-bridge.js:100-105` now  
   disables `merchant_features` rows on suspension (mirrors cancel behaviour).

5. **Upgrade/downgrade is undefined**: no code path changes which features are enabled  
   when a merchant switches monthly → annual or vice versa (not a current issue since both  
   grant identical access, but will matter post-per-module).

---

## 6. Recommended Fix Plan

### Immediate (beta-safe, no user impact)

| Fix | Effort |
|-----|--------|
| ~~Fix suspension gap~~ | **FIXED** (`subscription-bridge.js:100-105`) |
| Reword pricing.html CTAs: "Subscribe for full access" instead of per-module "Get Started" | 1h |
| Add note to pricing.html: "Per-module billing coming soon" | 30m |

### Pre-launch (required before per-module billing)

| Fix | Effort |
|-----|--------|
| Add `plan_module_map` table: `(plan_key, module_key)` or `features TEXT[]` column on `subscription_plans` | 2h |
| Update `activateMerchantSubscription()` to grant only modules in the purchased plan | 2h |
| Update `subscribe.html` to support module selection (checkboxes + dynamic price total) | 1d |
| Update `upgrade.html` to show add-on module selection | 1d |
| Wire `full_suite` bundle key to a real `subscription_plans` row or remove from registry | 2h |
| Add plan-change handler: diff old vs new module set, enable/disable accordingly | 4h |

**Architecture note**: the cleanest path is a `plan_features TEXT[]` column on  
`subscription_plans`. Seeding it with `'{cycle_counts,reorder,...}'` for monthly/annual  
preserves current behavior while enabling per-module plans. No new join table required.
