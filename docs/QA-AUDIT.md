# SqTools QA Audit
Generated: 2026-04-16

---

## Section 1 — Frontend Inventory

> **Note on scope:** The repository does not have a `views/` directory. All HTML pages are flat under `public/`. Pages are grouped by functional area to match the requested grouping.
>
> **Endpoint existence** is verified against `server.js` route mounts and the route files in `routes/`. Relative mount prefixes (e.g. `/api/auth`, `/api/staff`, `/api/subscriptions`) are resolved before checking.

### Group 1 — Auth & Landing

Pages covered: `public/index.html` (landing), `public/login.html`, `public/accept-invite.html`, `public/set-password.html`, `public/subscribe.html`, `public/subscription-expired.html`, `public/upgrade.html`, `public/support.html`.

---

#### `public/index.html` — Marketing landing page

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a>` nav-logo `href="/"` | Static navigation → `/` | ✅ served as `index.html` (default) |
| 2 | `<a href="#features">` nav link | In-page anchor, no HTTP | N/A |
| 3 | `<a href="/support.html">` nav link | Static page load | ✅ `public/support.html` exists |
| 4 | `<a href="/login.html">` "Log In" | Static page load | ✅ `public/login.html` exists |
| 5 | `<a href="/subscribe.html">` "Get Started" | Static page load | ✅ `public/subscribe.html` exists |
| 6 | `<button data-action="navigateToLogin">` mobile menu | JS delegated → `/login.html` | ✅ `public/login.html` exists |
| 7 | `<a href="/subscribe.html">` hero "Start Free Trial" | Static page load | ✅ |
| 8 | `<a href="/login.html">` hero "Sign In" | Static page load | ✅ |
| 9 | `<a href="/subscribe.html">` CTA "Start Your Free Trial" | Static page load | ✅ |
| 10 | `<a href="#features">` footer link | In-page anchor | N/A |
| 11 | `<a href="/support.html">` footer link | Static page load | ✅ |
| 12 | `<a href="/login.html">` footer link | Static page load | ✅ |
| 13 | `<a href="/subscribe.html">` footer link | Static page load | ✅ |
| 14 | `<a href="https://squareup.com/us/en">` external | External (Square) | N/A external |

JS loaded: `js/event-delegation.js`, `js/index.js`. `index.js` does not issue any `fetch` calls (verified — no `/api/*` calls; only sets the year and wires the mobile nav redirect).

---

#### `public/login.html` — Login + Forgot Password

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<form id="login-form">` submit | `POST /api/auth/login` | ✅ `routes/auth/session.js:13` (`/login`, mounted at `/api/auth`) |
| 2 | `<a id="forgot-password-link">` | Toggles forgot form (no HTTP) | N/A |
| 3 | `<a id="back-to-login">` | Toggles back to login (no HTTP) | N/A |
| 4 | `<form id="forgot-form">` submit | `POST /api/auth/forgot-password` | ✅ `routes/auth/password.js:28` |
| 5 | `<a>` "Get started with Square POS" | External link to Square | N/A external |
| 6 | Success redirect | `GET /dashboard.html` (or validated `returnUrl`) | ✅ `public/dashboard.html` exists |

Redirect behaviour: on `?setup=complete` and `?expired=true` query params, the page renders non-blocking banners. Open-redirect protection: `returnUrl` is validated to be a local path (`.startsWith('/')` and not `//`).

---

#### `public/accept-invite.html` — Staff invitation acceptance

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | Page load (no click) | `GET /api/staff/validate-token?token=...` | ✅ `routes/staff.js:89` (mounted at `/api/staff`) |
| 2 | `<button data-action="acceptInvitation">` | `POST /api/staff/accept` | ✅ `routes/staff.js:101` |
| 3 | `<a href="/login.html">` (error state) | Static page load | ✅ |
| 4 | `<a href="/login.html">` (success state) | Static page load | ✅ |

---

#### `public/set-password.html` — New account / password reset

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | Page load (no click) | `GET /api/auth/verify-reset-token?token=...` | ✅ `routes/auth/password.js:46` |
| 2 | `<form id="password-form">` submit | `POST /api/auth/reset-password` | ✅ `routes/auth/password.js:34` |
| 3 | `<a href="/login.html">` (invalid state) | Static page load | ✅ |
| 4 | `<a href="/login.html">` (footer "Back to Login") | Static page load | ✅ |
| 5 | Success redirect | `GET /login.html?setup=complete` | ✅ |

---

#### `public/subscribe.html` — Public signup + checkout

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/">` back link | Static page load | ✅ |
| 2 | Page load | `GET /api/subscriptions/plans` | ✅ `routes/subscriptions/plans.js:16` (mounted at `/api`) |
| 3 | Payment SDK init | `GET /api/square/payment-config` | ✅ `routes/subscriptions/plans.js:8` |
| 4 | `<button data-action="selectPlan" data-action-param="monthly">` | Client state toggle (no HTTP) | N/A |
| 5 | `<button data-action="selectPlan" data-action-param="annual">` | Client state toggle (no HTTP) | N/A |
| 6 | `<button data-action="applyPromoCode">` | `POST /api/subscriptions/promo/validate` | ✅ `routes/subscriptions/merchant.js:17` |
| 7 | `<a data-action="openTermsModal">` (Terms link) | Opens modal (no HTTP) | N/A |
| 8 | `<a data-action="openTermsModal">` (Liability link) | Opens modal (no HTTP) | N/A |
| 9 | `<button data-action="closeTermsModal">` | Closes modal (no HTTP) | N/A |
| 10 | `<button data-action="acceptTerms">` | Closes modal + sets checkbox (no HTTP) | N/A |
| 11 | `<form data-submit="handleSubscribe">` submit | `POST /api/subscriptions/create` | ✅ `routes/subscriptions/merchant.js:40` |
| 12 | `<a href="/support.html">` footer | Static page load | ✅ |
| 13 | `<a href="/dashboard.html">` footer | Static page load | ✅ |

---

#### `public/subscription-expired.html` — Expired/blocked state

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/upgrade.html">` "Upgrade Subscription" | Static page load | ✅ `public/upgrade.html` |
| 2 | `<a href="/support.html">` "Contact Support" | Static page load | ✅ |
| 3 | `<a href="mailto:support@sqtools.ca">` | Mailto link | N/A mailto |

No JS file is loaded for this page — it is a static informational page.

---

#### `public/upgrade.html` — Manage/renew subscription (auth required)

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` back link | Static page load | ✅ |
| 2 | Page load | `GET /api/subscriptions/merchant-status` | ✅ `routes/subscriptions/merchant.js:72` |
| 3 | Payment SDK init | `GET /api/square/payment-config` | ✅ `routes/subscriptions/plans.js:8` |
| 4 | Plan card click (dynamic) | Client state toggle | N/A |
| 5 | `<button id="upgrade-btn">` | `POST /api/subscriptions/create` | ✅ `routes/subscriptions/merchant.js:40` |

---

#### `public/support.html` — Public support page

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/">` back link | Static page load | ✅ |
| 2 | `<a href="mailto:support@sqtools.ca">` | Mailto | N/A |
| 3 | `<a href="/api/health">` system health | `GET /api/health` | ✅ `server.js:627` |
| 4 | `<a href="https://developer.squareup.com/docs">` | External | N/A |
| 5 | `<a href="https://squareup.com/help">` | External (Square) | N/A |
| 6 | `<a href="https://squareup.com/us/en">` referral | External (Square) | N/A |
| 7 | `<a href="/dashboard.html">` footer | Static page load | ✅ |
| 8 | `<a href="/support.html">` footer | Static page load | ✅ (self) |
| 9 | `<a href="/api/health">` footer | `GET /api/health` | ✅ |

`support.js` only sets the copyright year — no `fetch` calls.

---

**Group 1 summary:** 8 pages, ~65 clickable elements. All API endpoints referenced by these pages exist. No broken links or missing endpoints detected.

---

### Group 2 — Vendor & Inventory

Pages covered: `public/vendor-dashboard.html`, `public/vendor-catalog.html`, `public/vendor-match-suggestions.html`, `public/inventory.html`, `public/bundle-manager.html`, `public/catalog-audit.html`, `public/catalog-workflow.html`, `public/deleted-items.html`, `public/cycle-count.html`, `public/cycle-count-history.html`, `public/expiry.html`, `public/expiry-audit.html`, `public/expiry-discounts.html`, `public/sales-velocity.html`.

---

#### `public/vendor-dashboard.html` — Vendors overview

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="reorder.html">` | Static page load | ✅ `public/reorder.html` |
| 2 | `<a href="purchase-orders.html">` | Static page load | ✅ `public/purchase-orders.html` |
| 3 | `<a href="dashboard.html">` | Static page load | ✅ |
| 4 | `<button data-action="setFilterAll">` | Client filter (no HTTP) | N/A |
| 5 | `<button data-action="setFilterAction">` | Client filter (no HTTP) | N/A |
| 6 | Page load | `GET /api/vendor-dashboard` | ✅ `routes/vendor-catalog/vendors.js:17` |
| 7 | Vendor settings save (dynamic) | `PATCH /api/vendors/:id/settings` | ✅ `routes/vendor-catalog/vendors.js:22` |

---

#### `public/vendor-catalog.html` — Vendor catalog import & browse

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/vendor-match-suggestions.html">` | Static page load | ✅ |
| 2 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 3 | `<button data-action="triggerFileInput">` | Opens file picker (no HTTP) | N/A |
| 4 | `<button data-action="resetImport">` | Client reset (no HTTP) | N/A |
| 5 | `<button data-action="confirmImport">` | `POST /api/vendor-catalog/import-mapped` | ✅ `routes/vendor-catalog/import.js:42` |
| 6 | File preview (on file pick) | `POST /api/vendor-catalog/preview` | ✅ `routes/vendor-catalog/import.js:27` |
| 7 | `<button data-action="confirmSuggestedLinks">` | `POST /api/vendor-catalog/confirm-links` | ✅ `routes/vendor-catalog/manage.js:27` |
| 8 | `<button data-action="lookupUPC">` | `GET /api/vendor-catalog/lookup/:upc` | ✅ `routes/vendor-catalog/lookup.js:23` |
| 9 | `<button data-action="searchCatalog">` | `GET /api/vendor-catalog?...` | ✅ `routes/vendor-catalog/lookup.js:11` |
| 10 | `<button data-action="createInSquare">` | `POST /api/vendor-catalog/create-items` | ✅ `routes/vendor-catalog/manage.js:48` |
| 11 | Push price changes (dynamic) | `POST /api/vendor-catalog/push-price-changes` | ✅ `routes/vendor-catalog/manage.js:14` |
| 12 | Field-type dropdown load | `GET /api/vendor-catalog/field-types` | ✅ `routes/vendor-catalog/import.js:63` |
| 13 | Vendor list load | `GET /api/vendors` | ✅ `routes/vendor-catalog/vendors.js:11` |
| 14 | Stats load | `GET /api/vendor-catalog/stats` | ✅ `routes/vendor-catalog/import.js:67` |
| 15 | Batch archive (dynamic) | `POST /api/vendor-catalog/batches/:id/archive` | ✅ `routes/vendor-catalog/manage.js:57` |
| 16 | Batch unarchive (dynamic) | `POST /api/vendor-catalog/batches/:id/unarchive` | ✅ `routes/vendor-catalog/manage.js:64` |
| 17 | Batch delete (dynamic) | `DELETE /api/vendor-catalog/batches/:id` | ✅ `routes/vendor-catalog/manage.js:71` |
| 18 | Batch report (dynamic) | `GET /api/vendor-catalog/batches/:id/report` | ✅ `routes/vendor-catalog/lookup.js:42` |
| 19 | Match suggestions badge | `GET /api/vendor-match-suggestions/count` | ✅ `routes/vendor-match-suggestions.js:36` |
| 20 | `<a href="/api/vendor-catalog" target="_blank">` footer | `GET /api/vendor-catalog` | ✅ (same as #9) |
| 21 | `<a href="/api/vendor-catalog/stats" target="_blank">` footer | `GET /api/vendor-catalog/stats` | ✅ |

---

#### `public/vendor-match-suggestions.html` — Fuzzy vendor↔item match approvals

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/vendor-catalog.html">` | Static page load | ✅ |
| 2 | `<a href="/vendor-dashboard.html">` | Static page load | ✅ |
| 3 | `<button data-action="runBackfill">` | `POST /api/vendor-match-suggestions/backfill` | ✅ `routes/vendor-match-suggestions.js:76` |
| 4 | `<div data-action="switchTab">` × 3 | Triggers list fetch → `GET /api/vendor-match-suggestions?status=...` | ✅ `routes/vendor-match-suggestions.js:47` |
| 5 | `<input data-action="toggleSelectAll">` | Client toggle (no HTTP) | N/A |
| 6 | `<button data-action="confirmBulkApprove">` | `POST /api/vendor-match-suggestions/bulk-approve` | ✅ `routes/vendor-match-suggestions.js:62` |
| 7 | `<button data-action="loadMore">` | Paginates same list endpoint | ✅ |
| 8 | Row "Approve" (dynamic) | `POST /api/vendor-match-suggestions/:id/approve` | ✅ `routes/vendor-match-suggestions.js:86` |
| 9 | Row "Reject" (dynamic) | `POST /api/vendor-match-suggestions/:id/reject` | ✅ `routes/vendor-match-suggestions.js:104` |
| 10 | Page-load count | `GET /api/vendor-match-suggestions/count` | ✅ |

---

#### `public/inventory.html` — Catalog viewer

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="deleted-items.html">` | Static page load | ✅ |
| 2 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 3 | Column toggles / filters | Client-only (no HTTP) | N/A |
| 4 | Page load | `GET /api/variations` | ✅ `routes/catalog.js:84` |

---

#### `public/bundle-manager.html` — Bundle (kit) configuration

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/reorder.html">` | Static page load | ✅ |
| 2 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 3 | `<button data-action="showCreateForm">` | Client state (no HTTP) | N/A |
| 4 | `<button data-action="addComponent">` | Client state (no HTTP) | N/A |
| 5 | `<button data-action="saveBundle">` | `POST /api/bundles` or `PUT /api/bundles/:id` | ✅ `routes/bundles.js:43`, `:51` |
| 6 | `<button data-action="cancelForm">` | Client state (no HTTP) | N/A |
| 7 | Delete bundle (dynamic) | `DELETE /api/bundles/:id` | ✅ `routes/bundles.js:60` |
| 8 | Page load | `GET /api/bundles` | ✅ `routes/bundles.js:26` |
| 9 | Active vendors load | `GET /api/vendors?status=ACTIVE` | ✅ |
| 10 | Component search | `GET /api/variations?search=...` | ✅ |

---

#### `public/catalog-audit.html` — Catalog health & bulk fixes

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | `<button data-action="loadData">` | `GET /api/catalog-audit` | ✅ `routes/catalog.js:301` |
| 3 | `<button data-action="exportCSV">` | Client CSV export (no HTTP) | N/A |
| 4 | `<button data-action="toggleBulkEdits">` | Client UI (no HTTP) | N/A |
| 5 | `<button data-action="fixLocationMismatches">` | `POST /api/catalog-audit/fix-locations` | ✅ `routes/catalog.js:336` |
| 6 | `<button data-action="fixInventoryAlerts">` | `POST /api/catalog-audit/fix-inventory-alerts` | ✅ `routes/catalog.js:358` |
| 7 | `<button data-action="loadDetailData">` | `GET /api/catalog-audit` | ✅ |
| 8 | Column sort headers `data-action="sortTable"` × 8 | Client sort (no HTTP) | N/A |
| 9 | `<button data-action="runHealthCheck">` | `POST /api/admin/catalog-health/check` | ✅ `routes/catalog-health.js:49` (mounted at `/api/admin/catalog-health`) |
| 10 | Health dashboard load | `GET /api/admin/catalog-health` | ✅ `routes/catalog-health.js:33` |

---

#### `public/catalog-workflow.html` — AI autofill workflow

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | `<button data-action="toggleApiKeyVisibility">` | Client UI (no HTTP) | N/A |
| 3 | `<button data-action="saveApiKey">` | `POST /api/ai-autofill/api-key` | ✅ `routes/ai-autofill.js:44` |
| 4 | `<button data-action="clearApiKey">` | `DELETE /api/ai-autofill/api-key` | ✅ `routes/ai-autofill.js:90` |
| 5 | Page load — key status | `GET /api/ai-autofill/api-key/status` | ✅ `routes/ai-autofill.js:72` |
| 6 | Page load — tab status | `GET /api/ai-autofill/status` | ✅ `routes/ai-autofill.js:131` |
| 7 | `<div data-action="switchTab">` × 6 | Client tab + status refresh | ✅ (same `/status`) |
| 8 | `<button data-action="generateDescriptions">` | `POST /api/ai-autofill/generate` | ✅ `routes/ai-autofill.js:158` |
| 9 | `<button data-action="generateSeoTitles">` | `POST /api/ai-autofill/generate` | ✅ |
| 10 | `<button data-action="generateSeoDescriptions">` | `POST /api/ai-autofill/generate` | ✅ |
| 11 | Apply generated content | `POST /api/ai-autofill/apply` | ✅ `routes/ai-autofill.js:261` |

---

#### `public/deleted-items.html` — Deleted & archived items view

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | `<button data-action="loadDeletedItems">` | `GET /api/deleted-items?status=&age_months=` | ✅ `routes/catalog.js:287` |
| 3 | Filter selects (status/age/category) | Client filter (no HTTP) | N/A |

---

#### `public/cycle-count.html` — Cycle count queue

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | `<button data-action="showSendNowModal">` | Client modal (no HTTP) | N/A |
| 3 | `<button data-action="generateBatch">` | `POST /api/cycle-counts/generate-batch` | ✅ `routes/cycle-counts.js:423` |
| 4 | `<button data-action="loadPendingItems">` | `GET /api/cycle-counts/pending` | ✅ `routes/cycle-counts.js:42` |
| 5 | `<a href="/cycle-count-history.html">` | Static page load | ✅ |
| 6 | `<button data-action="closeSendNowModal">` | Client close (no HTTP) | N/A |
| 7 | `<button data-action="submitSendNow">` | `POST /api/cycle-counts/send-now` | ✅ `routes/cycle-counts.js:291` |
| 8 | `<button data-action="closeCountModal">` | Client close (no HTTP) | N/A |
| 9 | `<button data-action="submitCount">` | `POST /api/cycle-counts/:id/complete` then `POST /api/cycle-counts/:id/sync-to-square` | ✅ `routes/cycle-counts.js:139`, `:208` |

---

#### `public/cycle-count-history.html` — Cycle count reports

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/cycle-count.html">` | Static page load | ✅ |
| 2 | `<button data-action="setToday">` / `setLast7Days` / `setLast30Days` | Client date range (no HTTP) | N/A |
| 3 | `<button data-action="loadHistory">` | `GET /api/cycle-counts/history?...` | ✅ `routes/cycle-counts.js:356` |
| 4 | `<button data-action="clearFilters">` | Client reset (no HTTP) | N/A |

---

#### `public/expiry.html` — Expiration tracker

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="expiry-audit.html">` | Static page load | ✅ |
| 2 | `<a href="expiry-discounts.html">` | Static page load | ✅ |
| 3 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 4 | `<button data-action="loadItems">` | `GET /api/expirations?expiry=&category=` | ✅ `routes/catalog.js:188` |
| 5 | `<button data-action="markAllAsReviewed">` | `POST /api/expirations/review` | ✅ `routes/catalog.js:239` |
| 6 | `<button data-action="syncFromSquare">` | `POST /api/sync-smart` | ✅ `routes/sync.js:56` |
| 7 | Save expiration (modal) | `POST /api/expirations` | ✅ `routes/catalog.js:201` |
| 8 | Categories load | `GET /api/categories` | ✅ `routes/catalog.js:61` |
| 9 | `<button data-action="changePage">` prev/next | Client pagination | N/A |

---

#### `public/expiry-audit.html` — Expiry discount tier audit

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<button data-action="navigateTo" data-action-param="/dashboard.html">` | Static page load | ✅ |
| 2 | Nav buttons to `/expiry.html`, `/expiry-discounts.html` | Static page loads | ✅ |
| 3 | `<button data-action="loadItems">` | Parallel loads: `GET /api/expiry-discounts/tiers`, `GET /api/expiry-discounts/variations?tier_code=…` (×4), `GET /api/expirations?expiry=no-expiry` | ✅ `routes/expiry-discounts.js:55`, `:120`; `routes/catalog.js:188` |
| 4 | `<div data-action="filterByTier">` × 6 | Client tab (no HTTP) | N/A |
| 5 | `<button data-action="confirmItem">` | `POST /api/expirations` | ✅ |
| 6 | `<button data-action="updateDate">` | `POST /api/expirations` + `POST /api/expirations/review` | ✅ |
| 7 | `<button data-action="confirmFullPull">` / `submitFullPull` | `POST /api/expirations/pull` | ✅ `routes/catalog.js:223` |
| 8 | `<button data-action="showPartialExpiryForm">` / `submitPartialPull` | `POST /api/expirations/pull` | ✅ |
| 9 | `<button data-action="backToStep1">` / `closeConfirmModal` / `closeUpdateModal` / `closeExpiredPullModal` | Client close (no HTTP) | N/A |

---

#### `public/expiry-discounts.html` — Automated expiry discounts

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="expiry.html">`, `<a href="/dashboard.html">` | Static page loads | ✅ |
| 2 | Tier cards `data-action="filterByTier"` × 5 | Triggers `GET /api/expiry-discounts/variations?...` | ✅ `routes/expiry-discounts.js:120` |
| 3 | `<button data-action="runEvaluation">` | `POST /api/expiry-discounts/evaluate` | ✅ `routes/expiry-discounts.js:233` |
| 4 | `<button data-action="runFullAutomation">` | `POST /api/expiry-discounts/run` (dry=false) | ✅ `routes/expiry-discounts.js:267` |
| 5 | `<button data-action="runFullAutomationDryRun">` | `POST /api/expiry-discounts/run` (dry=true) | ✅ |
| 6 | `<button data-action="initSquareDiscounts">` | `POST /api/expiry-discounts/init-square` | ✅ `routes/expiry-discounts.js:310` |
| 7 | Tabs `data-action="switchTab"` × 5 | Loads: `/flagged`, `/audit-log`, `/settings`, `/tiers` | ✅ `:415`, `:323`, `:339`, `:55` |
| 8 | `<button data-action="saveSettings">` | `PATCH /api/expiry-discounts/settings` | ✅ `routes/expiry-discounts.js:363` |
| 9 | Tier row save (dynamic) | `PATCH /api/expiry-discounts/tiers/:id` | ✅ `routes/expiry-discounts.js:73` |
| 10 | `<button data-action="validateDiscounts">` | `GET /api/expiry-discounts/validate` | ✅ `routes/expiry-discounts.js:381` |
| 11 | `<button data-action="validateDiscountsFix">` | `POST /api/expiry-discounts/validate-and-fix` | ✅ `routes/expiry-discounts.js:394` |
| 12 | Flagged resolve (dynamic) | `POST /api/expiry-discounts/flagged/resolve` | ✅ `routes/expiry-discounts.js:425` |
| 13 | Status load | `GET /api/expiry-discounts/status` | ✅ `routes/expiry-discounts.js:44` |

---

#### `public/sales-velocity.html` — Velocity analytics

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | `<button data-action="loadData">` | `GET /api/sales-velocity?period_days=N` | ✅ `routes/analytics.js:31` |
| 3 | Period selector (91/182/365) | Changes `period_days` param (same endpoint) | ✅ |

---

**Group 2 summary:** 14 pages, ~110 clickable elements. All API endpoints referenced by these pages exist. No broken links or missing endpoints detected.

---

### Group 3 — Orders & Purchasing

Pages covered: `public/purchase-orders.html`, `public/reorder.html`, `public/min-max-history.html`, `public/min-max-suppression.html`, `public/pricing.html`, `public/cart-activity.html`, `public/gmc-feed.html`.

---

#### `public/purchase-orders.html` — Manage purchase orders

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="reorder.html">` | Static page load | ✅ |
| 2 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 3 | `<button data-action="closeModal">` / `closeConfirmModal` | Client close (no HTTP) | N/A |
| 4 | `<button data-action="confirmAction">` | Routes to update / submit / delete PO (see below) | ✅ |
| 5 | Page load | `GET /api/purchase-orders` | ✅ `routes/purchase-orders.js:57` (mounted at `/api/purchase-orders`) |
| 6 | View PO (dynamic) | `GET /api/purchase-orders/:id` | ✅ `routes/purchase-orders.js:65` |
| 7 | Save edits | `PATCH /api/purchase-orders/:id` | ✅ `routes/purchase-orders.js:72` |
| 8 | Delete PO (confirmed) | `DELETE /api/purchase-orders/:id` | ✅ `routes/purchase-orders.js:107` |
| 9 | Submit PO (confirmed) | `POST /api/purchase-orders/:id/submit` | ✅ `routes/purchase-orders.js:85` |
| 10 | Export CSV (from PO view links, if used) | `GET /api/purchase-orders/:po_number/export-csv` | ✅ `routes/purchase-orders.js:118` |
| 11 | Export XLSX | `GET /api/purchase-orders/:po_number/export-xlsx` | ✅ `routes/purchase-orders.js:133` |

Note: `POST /api/purchase-orders/:id/receive` exists on the server but is not invoked from this page — it is called from reorder workflows.

---

#### `public/reorder.html` — Reorder suggestions / create PO

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="purchase-orders.html">` / `<a href="bundle-manager.html">` / `<a href="/dashboard.html">` | Static page loads | ✅ |
| 2 | `<div data-action="toggleReorderSection">` | Client UI toggle | N/A |
| 3 | `<div data-action="toggleOtherItems">` | Client UI toggle | N/A |
| 4 | `<th data-action="sortTable">` × ~16 | Client-side sort | N/A |
| 5 | `<button data-action="createPurchaseOrder">` | `POST /api/purchase-orders` | ✅ `routes/purchase-orders.js:23` |
| 6 | Page load — expiry tiers | `GET /api/expiry-discounts/tiers` | ✅ |
| 7 | Page load — merchant config | `GET /api/config` | ✅ `routes/merchants.js:86` |
| 8 | Page load — locations | `GET /api/locations` | ✅ `routes/catalog.js:51` |
| 9 | Vendor dropdown | `GET /api/vendors?status=ACTIVE` | ✅ |
| 10 | Suggestions load | `GET /api/reorder-suggestions?supply_days=&location_id=&vendor_id=&include_other=true` | ✅ `routes/analytics.js:92` |
| 11 | Inline extended-field edits | `PATCH /api/variations/:id/extended` | ✅ `routes/catalog.js:106` |
| 12 | Inline cost edits | `PATCH /api/variations/:id/cost` | ✅ `routes/catalog.js:146` |
| 13 | Inline min-stock edits | `PATCH /api/variations/:id/min-stock` | ✅ `routes/catalog.js:128` |
| 14 | "Enable at locations" fallback | `POST /api/catalog-audit/enable-item-at-locations` | ✅ `routes/catalog.js:317` |

---

#### `public/min-max-history.html` — Min/max adjustment history

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/min-max-suppression.html">` | Static page load | ✅ |
| 2 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 3 | Page load + filter changes | `GET /api/min-max/history?...` | ✅ `routes/analytics.js:154` |
| 4 | Pin/unpin action (dynamic) | `POST /api/min-max/pin` | ✅ `routes/analytics.js:172` |

---

#### `public/min-max-suppression.html` — Suppression dashboard

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/min-max-history.html">` | Static page load | ✅ |
| 2 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 3 | Suppressed list load | `GET /api/min-max/suppressed` | ✅ `routes/min-max-suppression-routes.js:25` |
| 4 | Audit log tab | `GET /api/min-max/audit-log?limit=50` | ✅ `routes/min-max-suppression-routes.js:38` |
| 5 | Toggle pin (dynamic) | `POST /api/min-max/toggle-pin` | ✅ `routes/min-max-suppression-routes.js:52` |

---

#### `public/pricing.html` — Public pricing page

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/support.html">` (contact) | Static page load | ✅ |
| 2 | `<a href="/login.html">` | Static page load | ✅ |
| 3 | `<a href="/subscribe.html">` | Static page load | ✅ |
| 4 | `<a href="/support.html">` (footer) | Static page load | ✅ |
| 5 | Page load — pricing data | `GET /api/public/pricing` | ✅ `routes/subscriptions/public.js:14` |
| 6 | Promo code check (if implemented) | `GET /api/public/promo/check?code=...` | ✅ `routes/subscriptions/public.js:37` |

This is a public page with no auth required; routes are in the `public` sub-router.

---

#### `public/cart-activity.html` — Abandoned / open cart insights

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="dashboard.html">` | Static page load | ✅ |
| 2 | `<select data-action="filter">` (status) / `<input data-action="filter">` (dates) | `GET /api/cart-activity?...` | ✅ `routes/cart-activity.js:38` (mounted at `/api/cart-activity`) |
| 3 | `<button data-action="prev">` / `data-action="next"` | Paginates same endpoint | ✅ |
| 4 | Page-load stats | `GET /api/cart-activity/stats?days=7` | ✅ `routes/cart-activity.js:76` |

---

#### `public/gmc-feed.html` — Google Merchant Center feed & sync

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | Tab `data-action="switchTab"` (product-feed / local-inventory) | Client tab (no HTTP) | N/A |
| 3 | `<div data-action="toggleApiSettings">` / `toggleFeedSettings` | Client UI | N/A |
| 4 | `<button data-action="saveGmcApiSettings">` | `PUT /api/gmc/api-settings` | ✅ `routes/gmc/settings.js:51` |
| 5 | `<button data-action="testGmcConnection">` | `POST /api/gmc/api/test-connection` | ✅ `routes/gmc/settings.js:56` |
| 6 | `<button data-action="saveFeedSettings">` | `PUT /api/gmc/settings` | ✅ `routes/gmc/settings.js:18` |
| 7 | `<button data-action="syncProductsToGmc">` | `POST /api/gmc/api/sync-products` | ✅ `routes/gmc/settings.js:70` |
| 8 | `<span data-action="openBrandManager">` | Opens modal (no HTTP) | N/A |
| 9 | `<span data-action="openCategoryManager">` | Opens modal (no HTTP) | N/A |
| 10 | `<button data-action="closeBrandManager">` / `closeCategoryManager` | Client close | N/A |
| 11 | `<button data-action="detectBrands">` | `POST /api/gmc/brands/auto-detect` | ✅ `routes/gmc/brands.js:32` |
| 12 | `<button data-action="applyBrands">` | `POST /api/gmc/brands/bulk-assign` | ✅ `routes/gmc/brands.js:38` |
| 13 | `<span data-action="setCategoryFilter">` × 3 | Client filter (no HTTP) | N/A |
| 14 | `<button data-action="importGoogleTaxonomy">` | `GET /api/gmc/taxonomy/fetch-google` | ✅ `routes/gmc/taxonomy.js:19` |
| 15 | `<button data-action="removeCategoryMapping">` | `DELETE /api/gmc/category-taxonomy` | ✅ `routes/gmc/taxonomy.js:43` |
| 16 | `<button data-action="assignTaxonomy">` | `PUT /api/gmc/category-taxonomy` | ✅ `routes/gmc/taxonomy.js:39` |
| 17 | `<button data-action="downloadTsv">` | `GET /api/gmc/feed.tsv` (implied download) | ✅ `routes/gmc/feed.js:62` |
| 18 | `<button data-action="exportCsv">` | Client CSV export | N/A |
| 19 | `<button data-action="prevPage">` / `nextPage` | Client pagination | N/A |
| 20 | `<button data-action="copyLocalFeedUrl">` | Copies URL (no HTTP) | N/A |
| 21 | `<button data-action="downloadLocalInventoryTsv">` | `GET /api/gmc/local-inventory-feed.tsv` | ✅ `routes/gmc/feed.js:102` |
| 22 | Page load — feed URL | `GET /api/gmc/feed-url` | ✅ `routes/gmc/feed.js:72` |
| 23 | Regenerate token | `POST /api/gmc/regenerate-token` | ✅ `routes/gmc/feed.js:79` |
| 24 | Feed products load | `GET /api/gmc/feed?include_products=true` | ✅ `routes/gmc/feed.js:54` |
| 25 | Category mappings load | `GET /api/gmc/category-mappings` | ✅ `routes/gmc/taxonomy.js:35` |
| 26 | Taxonomy load | `GET /api/gmc/taxonomy?limit=10000` | ✅ `routes/gmc/taxonomy.js:11` |
| 27 | Feed settings load | `GET /api/gmc/settings` | ✅ `routes/gmc/settings.js:14` |
| 28 | Local inventory feed URL | `GET /api/gmc/local-inventory-feed-url` | ✅ `routes/gmc/feed.js:88` |
| 29 | API settings load | `GET /api/gmc/api-settings` | ✅ `routes/gmc/settings.js:47` |
| 30 | Sync status polling | `GET /api/gmc/api/sync-status` | ✅ `routes/gmc/settings.js:78` |
| 31 | Location settings list/save | `GET /api/gmc/location-settings`, `PUT /api/gmc/location-settings/:id` | ✅ `routes/gmc/settings.js:24`, `:38` |
| 32 | Local inventory feed JSON | `GET /api/gmc/local-inventory-feed?location_id=&format=json` | ✅ `routes/gmc/feed.js:95` |

---

**Group 3 summary:** 7 pages, ~90 clickable elements. All API endpoints referenced by these pages exist on the server. No broken links or missing endpoints detected.

---

### Group 4 — Loyalty & Delivery

Pages covered: `public/loyalty.html`, `public/delivery.html`, `public/delivery-history.html`, `public/delivery-route.html`, `public/delivery-settings.html`, `public/driver.html`.

---

#### `public/loyalty.html` — Loyalty / frequent-buyer program

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | Tabs `data-action="switchTabFromClick"` × 6 | Client tab + per-tab data load | N/A |
| 3 | `<button data-action="showCreateOfferModal">` | Opens modal | N/A |
| 4 | `<button data-action="searchCustomer">` | `GET /api/loyalty/customers/search?q=...` | ✅ `routes/loyalty/customers.js:156` (mounted at `/api/loyalty`) |
| 5 | `<button data-action="downloadReport" data-action-param="redemptions">` | `GET /api/loyalty/reports/redemptions/csv?...` | ✅ `routes/loyalty/reports.js:124` |
| 6 | `<button data-action="downloadReport" data-action-param="audit">` | `GET /api/loyalty/reports/audit/csv?...` | ✅ `routes/loyalty/reports.js:144` |
| 7 | `<button data-action="downloadReport" data-action-param="summary">` | `GET /api/loyalty/reports/summary/csv` | ✅ `routes/loyalty/reports.js:164` |
| 8 | `<button data-action="downloadReport" data-action-param="customers">` | `GET /api/loyalty/reports/customers/csv` | ✅ `routes/loyalty/reports.js:182` |
| 9 | `<button data-action="saveSettings">` | `PUT /api/loyalty/settings` | ✅ `routes/loyalty/settings.js:33` |
| 10 | `<button data-action="setupSeniorsDiscount">` | `POST /api/seniors/setup` | ✅ `routes/seniors.js:105` |
| 11 | `<button data-action="saveSeniorsConfig">` | `PATCH /api/seniors/config` | ✅ `routes/seniors.js:169` |
| 12 | `<button data-action="syncRewardsToPOS" data-action-param="false">` | `POST /api/loyalty/rewards/sync-to-pos` | ✅ `routes/loyalty/square-integration.js:109` |
| 13 | `<button data-action="syncRewardsToPOS" data-action-param="true">` | `POST /api/loyalty/rewards/sync-to-pos?force=true` | ✅ |
| 14 | `<button data-action="processExpired">` | `POST /api/loyalty/process-expired` | ✅ `routes/loyalty/processing.js:104` |
| 15 | `<button data-action="validateDiscounts" data-action-param="false">` | `GET /api/loyalty/discounts/validate` | ✅ `routes/loyalty/discounts.js:22` |
| 16 | `<button data-action="validateDiscounts" data-action-param="true">` | `POST /api/loyalty/discounts/validate-and-fix` | ✅ `routes/loyalty/discounts.js:36` |
| 17 | `<button data-action="closeModal">` (4 variants) | Client close (no HTTP) | N/A |
| 18 | `<button data-action="saveOffer">` | `POST /api/loyalty/offers` or `PATCH /api/loyalty/offers/:id` | ✅ `routes/loyalty/offers.js:43`, `:92` |
| 19 | `<button data-action="saveVariations">` | `POST /api/loyalty/offers/:id/variations` | ✅ `routes/loyalty/variations.js:25` |
| 20 | `<button data-action="submitRedemption">` | `POST /api/loyalty/rewards/:rewardId/redeem` | ✅ `routes/loyalty/rewards.js:26` |
| 21 | `<button data-action="addSelectedOrdersToLoyalty">` | `POST /api/loyalty/customer/:customerId/add-orders` | ✅ `routes/loyalty/customers.js:137` |
| 22 | Page load — stats | `GET /api/loyalty/stats` | ✅ `routes/loyalty/audit.js:45` |
| 23 | Offers list | `GET /api/loyalty/offers?activeOnly=...` | ✅ `routes/loyalty/offers.js:26` |
| 24 | Offer delete (dynamic) | `DELETE /api/loyalty/offers/:id` | ✅ `routes/loyalty/offers.js:119` |
| 25 | Offer variations / assignments | `GET /api/loyalty/offers/:id/variations`, `GET /api/loyalty/variations/assignments` | ✅ `routes/loyalty/variations.js:49`, `:59` |
| 26 | Customer profile / history / audit | `GET /api/loyalty/customer/:id/profile` · `/history` · `/audit-history` | ✅ `routes/loyalty/customers.js:52`, `:75`, `:104` |
| 27 | Rewards list | `GET /api/loyalty/rewards?...` | ✅ `routes/loyalty/rewards.js:80` |
| 28 | Redemptions list | `GET /api/loyalty/redemptions?...` | ✅ `routes/loyalty/rewards.js:100` |
| 29 | Vendor credit update | `PATCH /api/loyalty/rewards/:rewardId/vendor-credit` | ✅ `routes/loyalty/rewards.js:54` |
| 30 | Pending-sync list | `GET /api/loyalty/rewards/pending-sync` | ✅ `routes/loyalty/square-integration.js:121` |
| 31 | Settings load | `GET /api/loyalty/settings` | ✅ `routes/loyalty/settings.js:23` |
| 32 | Seniors status | `GET /api/seniors/status` | ✅ `routes/seniors.js:31` |
| 33 | Seniors members preview | `GET /api/seniors/members?limit=5` | ✅ `routes/seniors.js:232` |
| 34 | Variations picker | `GET /api/variations` | ✅ |
| 35 | Vendors list | `GET /api/vendors` | ✅ |

---

#### `public/delivery.html` — Delivery scheduler / route prep

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/delivery-route.html">` / `/delivery-history.html` / `/delivery-settings.html` / `/dashboard.html` | Static page loads | ✅ |
| 2 | `<button data-action="showAddOrderModal">` | Opens modal (no HTTP) | N/A |
| 3 | `<button data-action="finishRoute">` | `POST /api/delivery/route/finish` | ✅ `routes/delivery/routes.js:40` (mounted at `/api/delivery`) |
| 4 | `<button data-action="generateRoute">` | `POST /api/delivery/route/generate` | ✅ `routes/delivery/routes.js:14` |
| 5 | `<button data-action="geocodePending">` / `geocodeStartAddress` / `geocodeEndAddress` / `applyManualStart` / `applyManualEnd` | `POST /api/delivery/geocode` | ✅ `routes/delivery/routes.js:45` |
| 6 | `<button data-action="syncFromSquare">` | `POST /api/delivery/sync` | ✅ `routes/delivery/sync.js:14` |
| 7 | `<button data-action="useCurrentLocation">` | Browser Geolocation API (no HTTP) | N/A |
| 8 | `<button data-action="closeModal">` × N | Client close (no HTTP) | N/A |
| 9 | `<form data-submit="submitAddOrder">` | `POST /api/delivery/orders` | ✅ `routes/delivery/orders.js:27` |
| 10 | `<form data-submit="submitEditOrder">` | `PATCH /api/delivery/orders/:id` | ✅ `routes/delivery/orders.js:46` |
| 11 | Delete order (dynamic) | `DELETE /api/delivery/orders/:id` | ✅ `routes/delivery/orders.js:59` |
| 12 | Page load — order lists | `GET /api/delivery/orders?status=...` (×3) | ✅ `routes/delivery/orders.js:13` |
| 13 | Stats load | `GET /api/delivery/stats` | ✅ `routes/delivery/sync.js:39` |
| 14 | Active route load | `GET /api/delivery/route/active` | ✅ `routes/delivery/routes.js:26` |

---

#### `public/delivery-route.html` — Driver view (authenticated)

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/delivery-history.html">` / `/delivery.html` | Static page loads | ✅ |
| 2 | `<a data-action="openShareModal">` | Opens modal (no HTTP) | N/A |
| 3 | `<button data-action="closePodModal">` / `resetPodModal` / `closeNoteModal` / `closeShareModal` | Client close | N/A |
| 4 | `<button data-action="uploadPod">` | `POST /api/delivery/orders/:id/pod` (multipart) | ✅ `routes/delivery/pod.js:23` |
| 5 | `<button data-action="saveCustomerNote">` | `PATCH /api/delivery/orders/:id/customer-note` | ✅ `routes/delivery/orders.js:88` |
| 6 | `<button data-action="generateShareLink">` | `POST /api/delivery/route/:id/share` | ✅ `routes/driver-api.js:66` |
| 7 | `<button data-action="copyShareUrl">` | Copy to clipboard (no HTTP) | N/A |
| 8 | `<button data-action="regenerateShareLink">` | `POST /api/delivery/route/:id/share` (reuse) | ✅ |
| 9 | `<button data-action="revokeShareLink">` | `DELETE /api/delivery/route/:id/token` | ✅ `routes/driver-api.js:109` |
| 10 | Page load — active route | `GET /api/delivery/route/active` | ✅ |
| 11 | Customer-stats tooltip | `GET /api/delivery/orders/:id/customer-stats` | ✅ `routes/delivery/orders.js:101` |
| 12 | Mark complete (dynamic) | `POST /api/delivery/orders/:id/complete` | ✅ `routes/delivery/orders.js:73` |
| 13 | Skip order (dynamic) | `POST /api/delivery/orders/:id/skip` | ✅ `routes/delivery/orders.js:67` |
| 14 | Get current share token | `GET /api/delivery/route/:id/token` | ✅ `routes/driver-api.js:90` |

---

#### `public/delivery-history.html` — Past deliveries

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/delivery.html">` / `/delivery-route.html` / `/dashboard.html` | Static page loads | ✅ |
| 2 | `<button data-action="loadHistory">` | `GET /api/delivery/orders?<range>&status=completed` | ✅ |
| 3 | `<button data-action="setQuickRange" data-action-param="today\|week\|month">` | Client date range (then triggers load) | ✅ |
| 4 | `<div data-action="closePodModalOverlay">` / `closePodModal` | Client close (no HTTP) | N/A |

---

#### `public/delivery-settings.html` — Delivery configuration

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/delivery.html">` | Static page load | ✅ |
| 2 | `<a href="https://openrouteservice.org/...">` | External signup link | N/A external |
| 3 | Page load — settings | `GET /api/delivery/settings` | ✅ `routes/delivery/settings.js:12` |
| 4 | Form submit — save | `PUT /api/delivery/settings` | ✅ `routes/delivery/settings.js:17` |
| 5 | `<button data-action="loadSettings">` | Re-fetches `/api/delivery/settings` | ✅ |

---

#### `public/driver.html` — Public driver view (token-auth)

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<button data-action="finishRoute">` | `POST /api/driver/:token/finish` | ✅ `routes/driver-api.js` (see line 20 docstring) |
| 2 | `<button data-action="closePodModal">` | Client close (no HTTP) | N/A |
| 3 | `<button data-action="uploadPod">` | `POST /api/driver/:token/orders/:orderId/pod` | ✅ `routes/driver-api.js` (line 21) |
| 4 | Page load | `GET /api/driver/:token` | ✅ `routes/driver-api.js:127` |
| 5 | Mark complete (dynamic) | `POST /api/driver/:token/orders/:orderId/complete` | ✅ `routes/driver-api.js:167` |
| 6 | Skip order (dynamic) | `POST /api/driver/:token/orders/:orderId/skip` | ✅ `routes/driver-api.js` (line 20) |

All driver.html endpoints are public (token-based) and mounted at `/api/driver/...`.

---

**Group 4 summary:** 6 pages, ~90 clickable elements. All API endpoints referenced by these pages exist on the server. No broken links or missing endpoints detected.
