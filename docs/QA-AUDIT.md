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
