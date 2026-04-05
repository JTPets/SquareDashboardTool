# Subscription + Feature Management UI Audit
**Date**: 2026-04-05 | **Scope**: All merchant-facing and admin-facing subscription/feature UI

See also: [SUBSCRIPTION-AUDIT.md](./SUBSCRIPTION-AUDIT.md) for backend/API audit.

---

## 1. Merchant UI Coverage

| Flow | Page | Status |
|------|------|--------|
| View current plan + status | `upgrade.html` — billing section shows plan, card, next billing date | EXISTS (partial — only shown during upgrade flow, not as a standalone "My Subscription" view) |
| Subscribe / upgrade | `subscribe.html` — full checkout with plan selection, Square card, promo, ToS modal | EXISTS ✓ |
| Upgrade (existing user) | `upgrade.html` — plan cards + Square card form + billing info | EXISTS ✓ |
| Enter promo code | `pricing.html` → promo field → `?promo=` param carries to `subscribe.html` checkout | EXISTS ✓ (end-to-end) |
| Subscription expired | `subscription-expired.html` — status box + "Upgrade" CTA | EXISTS ✓ |
| See which features are unlocked | `feature-gate.js` adds lock badges to dashboard cards; `feature-check.js` shows full-page overlay | EXISTS ✓ |
| Locked feature redirect | Lock badge links to `/upgrade.html?feature=KEY`; overlay has "Upgrade Now" button | EXISTS ✓ |
| Cancel subscription | API: `POST /api/subscriptions/cancel` | **MISSING** — no cancel button anywhere in UI |
| View billing history | — | **MISSING** — no payment history page exists |
| Trial countdown | — | **MISSING** — no "X days remaining" indicator on any merchant-facing page |

**Missing merchant pages**: 3 flows have no UI at all.

---

## 2. Admin UI Coverage

| Flow | Page | Status |
|------|------|--------|
| View all subscribers | `admin-subscriptions.html` — Recent Subscribers table (email, plan, status, next billing, actions) | EXISTS (partial — "recent" only, no pagination/filtering) |
| Setup plans in Square | `admin-subscriptions.html` — "Setup Plans in Square" button | EXISTS ✓ |
| View Square config status | `admin-subscriptions.html` — config card (SQUARE_LOCATION_ID, token status) | EXISTS ✓ |
| Create promo codes | API: `POST /api/admin/promo-codes` | **MISSING** — API only, no admin UI form |
| View promo code usage / list | — | **MISSING** — no promo dashboard |
| Manually activate/deactivate features per merchant | — | **MISSING** — no feature toggle UI |
| Extend trial / override subscription | — | **MISSING** — no admin override controls |
| View merchant feature status | — | **MISSING** — no per-merchant feature view |
| Create/manage plans (CRUD) | `admin-subscriptions.html` loads plan list but has no edit/delete | **PARTIAL** — read-only list, no CRUD |

**Missing admin pages**: 5 flows have no UI; 1 is read-only when writes are needed.

---

## 3. Feature Gating Behavior

**`public/js/feature-gate.js`** (42 lines — dashboard-level):
- Fetches `GET /api/merchant/features` → `{ enabled[], available[], is_platform_owner }`
- For every `[data-feature]` card on the dashboard: adds `.feature-locked` class + a lock badge if the feature key is not in `enabled[]`
- Lock badge links to `/upgrade.html?feature=KEY`
- Silent fail (progressive enhancement — dashboard loads normally if API unavailable)
- Platform owners bypass all locks

**`public/js/feature-check.js`** (56 lines — page-level):
- Reads `data-feature-key` from its own `<script>` tag (e.g. `data-feature-key="cycle_counts"`)
- Fetches `/api/merchant/features`; if feature is disabled, replaces page body with a full-page lock overlay
- Overlay shows: module name, price, "Upgrade Now" → `/upgrade.html?feature=KEY`
- Fails open (page loads normally if fetch fails)

**`config/feature-registry.js`** (274 lines):
- 8 modules: `base` (free), `cycle_counts` ($9.99), `reorder` ($14.99), `expiry` ($9.99), `delivery` ($14.99), `loyalty` ($19.99), `ai_tools` ($9.99), `gmc` ($9.99)
- 1 bundle: `full_suite` ($59.99)
- Each module maps to specific routes[] and pages[]
- Helper functions: `getModuleForRoute()`, `getModuleForPage()`, `getModulePrice()`
- Base module includes all infrastructure pages (dashboard, settings, subscribe, upgrade, etc.)

---

## 4. Gaps — Prioritized

| # | Missing UI | Effort | Notes |
|---|-----------|--------|-------|
| 1 | **Trial countdown** on merchant dashboard/settings | S | Read `trial_ends_at` from merchant-status API; add banner to dashboard.html |
| 2 | **Cancel subscription** button | S | API already exists (`POST /api/subscriptions/cancel`); needs confirmation modal + button in upgrade.html or settings |
| 3 | **Admin: Create promo code** form | S | API exists (`POST /api/admin/promo-codes`); add form to admin-subscriptions.html |
| 4 | **Admin: Promo code list + usage** | M | Needs new API (`GET /api/admin/promo-codes`) + table in admin-subscriptions.html |
| 5 | **Billing history** page | M | Needs API to expose past payments; new page or section in upgrade.html |
| 6 | **Standalone "My Subscription"** page | M | Currently buried in upgrade.html; merchant has no clear view of plan status without initiating an upgrade |
| 7 | **Admin: Per-merchant feature toggle** | L | Needs new API + UI; would let admin unlock/lock individual features without a plan change |
| 8 | **Admin: Extend trial / override** | L | Needs new API + admin action in subscriber table |
| 9 | **Admin: Subscriber list with pagination/search** | M | Current table shows "recent" only; no filter by status, no full list |

---

## 5. Existing Page Descriptions

- **`subscribe.html`** (753 lines): Primary onboarding flow. Pricing cards (monthly/annual), Square Web Payments card form, promo code input with live validation, order summary with discount row, Terms of Service modal. Handles new-account password setup redirect.
- **`pricing.html`** (65 lines): Public marketing page. Promo code check field (pre-filled from `?promo=` URL param). Dynamically renders module and bundle cards from `/api/public/pricing`. Each card links to `/subscribe.html?promo=CODE`.
- **`upgrade.html`** (173 lines): Existing-user upgrade/renewal page. Status banner (trial/expired/active). Plan selection cards. Square card form. Billing details section (current plan, card, next billing date).
- **`settings.html`** (670 lines): System settings with tab UI. Super admin only: link to `admin-subscriptions.html`. No subscription management for regular merchants.
- **`admin-subscriptions.html`** (198 lines): Super-admin dashboard. Square config status card. Stats grid (subscriber count, active plans). "Setup Plans in Square" button. Plan list. Recent subscribers table with per-row actions.
- **`subscription-expired.html`** (156 lines): Shown when subscription lapses. Red status box, feature reminder list, "Upgrade Subscription" → `upgrade.html`, contact support link.
