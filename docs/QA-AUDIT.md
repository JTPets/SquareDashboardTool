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

---

### Group 5 — Admin & Settings

Pages covered: `public/dashboard.html`, `public/admin-subscriptions.html`, `public/merchants.html`, `public/staff.html`, `public/settings.html`, `public/logs.html`.

(These are the final pages under `public/` that were not scanned in Groups 1–4.)

---

#### `public/dashboard.html` — Main dashboard

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/">` logo | Static page load | ✅ |
| 2 | `<a href="merchants.html">` (manage accounts) | Static page load | ✅ |
| 3 | `<button data-action="logout">` | `POST /api/auth/logout` | ✅ `routes/auth/session.js:25` |
| 4 | `<a href="/subscribe.html">` | Static page load | ✅ |
| 5 | Navigation tile links (`vendor-dashboard.html`, `reorder.html`, `purchase-orders.html`, `expiry-audit.html`, `expiry.html`, `inventory.html`, `sales-velocity.html`, `min-max-history.html`, `cycle-count.html`, `cycle-count-history.html`, `vendor-catalog.html`, `catalog-audit.html`, `gmc-feed.html`, `catalog-workflow.html`, `delivery.html`, `delivery-route.html`, `delivery-settings.html`, `loyalty.html`, `cart-activity.html`, `staff.html`) | Static page loads | ✅ All exist in `public/` |
| 6 | `<div data-action="navigate">` stat tiles (×2) | Client navigate | ✅ |
| 7 | API reference links `<a href="/api/…" target="_blank">` (≈20 GET links) | `GET /api/...` | ✅ All verified in Groups 2–5 route scans |
| 8 | `<a data-action="showApiInfo">` informational links (≈15) | Client info modal (no HTTP) | N/A |
| 9 | `<a data-action="toggleApiList">` / `showHealthModal` / `hideHealthModal` | Client UI toggles | N/A |
| 10 | `<button data-action="connectSquare">` | `GET /api/square/oauth/connect?redirect=...` | ✅ `routes/square-oauth.js:89` (mounted at `/api/square/oauth`) |
| 11 | Page load — health | `GET /api/health` | ✅ |
| 12 | Page load — config | `GET /api/config` | ✅ `routes/merchants.js:86` |
| 13 | Page load — parallel (inventory/expirations/reorder/cycle-counts) | `GET /api/inventory`, `GET /api/expirations`, `GET /api/reorder-suggestions?supply_days=...`, `GET /api/cycle-counts/pending` | ✅ |
| 14 | Sync status poll | `GET /api/sync-status` | ✅ `routes/sync.js:86` |
| 15 | Manual sync | `POST /api/sync-smart` | ✅ `routes/sync.js:56` |
| 16 | Current user fetch | `GET /api/auth/me` | ✅ `routes/auth/session.js:34` |
| 17 | Merchants list | `GET /api/merchants` | ✅ `routes/merchants.js:33` |

---

#### `public/admin-subscriptions.html` — Admin subscription & pricing management

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/settings.html">` | Static page load | ✅ |
| 2 | `<button data-action="loadStats">` | `GET /api/subscriptions/admin/list` + `GET /api/subscriptions/admin/plans` | ✅ `routes/subscriptions/admin.js:61`, `:72` |
| 3 | `<button data-action="setupPlans">` | `POST /api/subscriptions/admin/setup-plans` | ✅ `routes/subscriptions/admin.js:78` |
| 4 | `<button data-action="loadPricing">` | `GET /api/admin/pricing` | ✅ `routes/subscriptions/admin.js:102` |
| 5 | Pricing save — modules | `PUT /api/admin/pricing/modules/:key` | ✅ `routes/subscriptions/admin.js:114` |
| 6 | Pricing save — plans | `PUT /api/admin/pricing/plans/:key` | ✅ `routes/subscriptions/admin.js:137` |
| 7 | `<select data-action="onPromoTypeChange">` | Client toggle (no HTTP) | N/A |
| 8 | `<button data-action="createPromoCode">` | `POST /api/admin/promo-codes` | ✅ `routes/admin.js:177` |
| 9 | Promo list load | `GET /api/admin/promo-codes` | ✅ `routes/admin.js:228` |
| 10 | Promo deactivate (dynamic) | `POST /api/admin/promo-codes/:id/deactivate` | ✅ `routes/admin.js:252` |
| 11 | `<button data-action="reloadSubscribers">` / search / filter | `GET /api/subscriptions/admin/list?...` | ✅ |
| 12 | `<button data-action="prevPage">` / `nextPage` | Client pagination | N/A |
| 13 | `<button data-action="hideFeaturesModal">` / `hideExtendTrialModal` / `hideActivateModal` / `hideBillingModal` | Client close (no HTTP) | N/A |
| 14 | `<button data-action="confirmExtendTrial">` | `POST /api/admin/merchants/:id/extend-trial` | ✅ `routes/admin.js:59` |
| 15 | `<button data-action="confirmActivate">` | `POST /api/admin/merchants/:id/activate` | ✅ `routes/admin.js:388` |
| 16 | Billing modal load | `GET /api/admin/merchants/:id/payments` | ✅ `routes/admin.js:287` |
| 17 | Features modal load | `GET /api/admin/merchants/:id/features` | ✅ `routes/admin.js:321` |
| 18 | Feature toggle | `PUT /api/admin/merchants/:id/features/:featureKey` | ✅ `routes/admin.js:356` |

---

#### `public/merchants.html` — Multi-merchant switcher

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/">` logo | Static page load | ✅ |
| 2 | `<a href="settings.html">` / `dashboard.html` / `support.html` | Static page loads | ✅ |
| 3 | `<button data-action="connectSquare">` | `GET /api/square/oauth/connect?...` | ✅ |
| 4 | `<button data-action="copyReferralLink">` | Copies to clipboard (no HTTP) | N/A |
| 5 | `<button data-action="closeDisconnectModal">` | Client close (no HTTP) | N/A |
| 6 | `<button data-action="confirmDisconnect">` | `POST /api/square/oauth/revoke` | ✅ `routes/square-oauth.js:414` |
| 7 | Page load — merchants list | `GET /api/merchants` | ✅ `routes/merchants.js:33` |
| 8 | Switch merchant (dynamic) | `POST /api/merchants/switch` | ✅ `routes/merchants.js:47` |

---

#### `public/staff.html` — Staff & invitations

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | `<button data-action="showInviteModal">` / `hideInviteModal` | Client UI (no HTTP) | N/A |
| 3 | `<button data-action="copyInviteUrl">` | Copies invite URL (no HTTP) | N/A |
| 4 | `<button data-action="submitInvite">` | `POST /api/staff/invite` | ✅ `routes/staff.js:48` (mounted at `/api/staff`) |
| 5 | `<button data-action="hideRemoveModal">` | Client close (no HTTP) | N/A |
| 6 | `<button data-action="confirmRemove">` | `DELETE /api/staff/:userId` | ✅ `routes/staff.js:142` |
| 7 | Page load — staff list | `GET /api/staff` | ✅ `routes/staff.js:38` |
| 8 | Role change (dynamic) | `PATCH /api/staff/:userId/role` | ✅ `routes/staff.js:162` |
| 9 | Cancel invitation (dynamic) | `DELETE /api/staff/invitations/:id` | ✅ `routes/staff.js:123` |
| 10 | Current user fetch | `GET /api/auth/me` | ✅ |

---

#### `public/settings.html` — Account / business rules / integrations

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | `<button data-action="testSquareConnection">` | `GET /api/health` (checks Square status field) | ✅ |
| 3 | `<button data-action="testDatabaseConnection">` | `GET /api/health` | ✅ |
| 4 | `<button data-action="testEmailConnection">` | `POST /api/test-email` | ✅ `server.js:728` |
| 5 | `<button data-action="resetMerchantSettingsToDefaults">` | `GET /api/settings/merchant/defaults` | ✅ `routes/settings.js:96` |
| 6 | `<button data-action="saveMerchantSettings">` | `PUT /api/settings/merchant` | ✅ `routes/settings.js:47` |
| 7 | `<button data-action="showChangePasswordModal">` / `hide...` | Client UI (no HTTP) | N/A |
| 8 | `<button data-action="changePassword">` | `POST /api/auth/change-password` | ✅ `routes/auth/password.js:13` |
| 9 | `<button data-action="logoutUser">` | `POST /api/auth/logout` | ✅ |
| 10 | `<button data-action="showCreateUserModal">` / `hide...` | Client UI | N/A |
| 11 | `<button data-action="createUser">` | `POST /api/auth/users` | ✅ `routes/auth/users.js:20` |
| 12 | Unlock user (dynamic) | `POST /api/auth/users/:id/unlock` | ✅ `routes/auth/users.js:83` |
| 13 | Reset user password (dynamic) | `POST /api/auth/users/:id/reset-password` | ✅ `routes/auth/users.js:60` |
| 14 | Update user (dynamic) | `PUT /api/auth/users/:id` | ✅ `routes/auth/users.js:42` |
| 15 | `<a href="/admin-subscriptions.html">` / `/merchants.html` / `/logs.html` | Static page loads | ✅ |
| 16 | `<a href="/subscribe.html">` / `/upgrade.html` | Static page loads | ✅ |
| 17 | `<button data-action="showCancelSubscriptionModal">` / `hide...` | Client UI (no HTTP) | N/A |
| 18 | `<button data-action="confirmCancelSubscription">` | `POST /api/subscriptions/cancel` | ✅ `routes/subscriptions/merchant.js:78` |
| 19 | `<button data-action="discardChanges">` / `saveChanges` (dirty-state bar) | Client (save uses `PUT /api/settings/merchant`) | ✅ |
| 20 | Page load — locations | `GET /api/locations` | ✅ |
| 21 | Page load — Google status | `GET /api/google/status` | ✅ `routes/google-oauth.js:41` |
| 22 | Google disconnect | `POST /api/google/disconnect` | ✅ `routes/google-oauth.js:121` |
| 23 | Page load — config | `GET /api/config` | ✅ |
| 24 | Sync intervals | `GET /api/sync-intervals` | ✅ `routes/sync.js:70` |
| 25 | Current user | `GET /api/auth/me` | ✅ |
| 26 | Subscription plans (admin view) | `GET /api/subscriptions/admin/plans` | ✅ |
| 27 | User list | `GET /api/auth/users` | ✅ `routes/auth/users.js:12` |
| 28 | Merchant settings load | `GET /api/settings/merchant` | ✅ `routes/settings.js:31` |
| 29 | Merchant status + features | `GET /api/subscriptions/merchant-status`, `GET /api/merchant/features` | ✅ `routes/subscriptions/merchant.js:72`, `server.js:470` |

---

#### `public/logs.html` — System logs & location health

| # | Clickable element | Action / endpoint | Endpoint exists? |
|---|---|---|---|
| 1 | `<a href="/dashboard.html">` | Static page load | ✅ |
| 2 | Tabs `data-action="switchTab"` (logs / location-health) | Client tab (no HTTP) | N/A |
| 3 | `<button data-action="refreshLogs">` | `GET /api/logs?limit=` + `GET /api/logs/errors?...` + `GET /api/logs/stats` | ✅ `routes/logs.js:123`, `:154`, `:199` |
| 4 | `<a href="/api/logs/download" download>` | `GET /api/logs/download` | ✅ `routes/logs.js:187` |
| 5 | `<button data-action="testEmail">` | `POST /api/test-email` | ✅ |
| 6 | `<button data-action="runHealthCheck">` | `POST /api/admin/catalog-health/check` | ✅ `routes/catalog-health.js:49` |
| 7 | `<button data-action="refreshLocationHealth">` | `GET /api/admin/catalog-health` | ✅ `routes/catalog-health.js:33` |
| 8 | Page load — dates | `GET /api/logs/dates` | ✅ `routes/logs.js:177` |

---

**Group 5 summary:** 6 pages, ~110 clickable elements (dashboard alone has ~70 navigational/API reference links). All API endpoints referenced by these pages exist on the server. No broken links or missing endpoints detected.

---

## Section 1 — Final Inventory Summary

| Group | Pages | Clickable elements (approx.) | Missing endpoints |
|---|---|---|---|
| 1. Auth & Landing | 8 | ~65 | 0 |
| 2. Vendor & Inventory | 14 | ~110 | 0 |
| 3. Orders & Purchasing | 7 | ~90 | 0 |
| 4. Loyalty & Delivery | 6 | ~90 | 0 |
| 5. Admin & Settings | 6 | ~110 | 0 |
| **Total** | **41** | **~465** | **0** |

All 41 HTML pages under `public/` were scanned. Every page-initiated API call was cross-referenced against the mounted Express routes in `server.js` and the route files in `routes/`. No broken internal links or missing endpoints were found during the Section 1 scan.

---

## Section 2 — Route & Middleware Inventory

> **File-scope note:** The task references `routes/auth.js` and `routes/subscriptions.js` — both are directories (`routes/auth/`, `routes/subscriptions/`) composed via index barrel files. All sub-files within each directory are included in the relevant group. `routes/inventory.js` (Group 2) and `routes/reorder.js` (Group 3) do not exist; those endpoints live in `routes/catalog.js` and `routes/analytics.js` respectively — noted in the scope notes for each group.
>
> **Global middleware** applied to every non-public `/api/*` request (from `server.js`):
> 1. `configureRateLimit()` — global IP-based rate limit (line 160)
> 2. `loadMerchantContext` — populates `req.merchantContext` (line 289)
> 3. `apiAuthMiddleware` → `requireAuth` for all non-public paths (line 329)
> 4. `subscriptionEnforcementMiddleware` — blocks expired/suspended merchants; excludes `/auth/`, `/subscriptions/`, `/admin/`, `/merchants`, `/config`, etc. (line 385)
> 5. Feature/permission gates via `gateApi()` — applied per path prefix (lines 401–422)
>
> Route-level middleware documented below is **in addition** to the above global chain.

---

### Group 1 — Auth & Subscriptions

Files scanned: `routes/auth/session.js`, `routes/auth/password.js`, `routes/auth/users.js`, `routes/subscriptions/plans.js`, `routes/subscriptions/merchant.js`, `routes/subscriptions/admin.js`, `routes/subscriptions/public.js`, `routes/subscriptions/webhooks.js`, `routes/merchants.js`.

Mount points: `routes/auth/*` → `/api/auth`; `routes/subscriptions/*` → `/api`; `routes/merchants.js` → `/api`.

---

#### `routes/auth/session.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/auth/login` | `loginRateLimit`, `validators.login` | `sessionService.loginUser` | Y | — |
| POST | `/api/auth/logout` | _(public path — apiAuthMiddleware skips auth)_ | `sessionService.logoutUser` | Y | — |
| GET | `/api/auth/me` | _(global apiAuthMiddleware applies requireAuth; inline session guard as well)_ | inline session check | Y | — |

---

#### `routes/auth/password.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/auth/change-password` | `requireAuth`, `validators.changePassword` | `passwordService.changePassword` | Y | — |
| POST | `/api/auth/forgot-password` | `validators.forgotPassword` | `passwordService.forgotPassword` | Y | ⚠️ **Missing rate limit** — `passwordResetRateLimit` is declared in this file but not applied to this handler; unlimited password-reset emails can be triggered per IP |
| POST | `/api/auth/reset-password` | `passwordResetRateLimit`, `validators.resetPassword` | `passwordService.resetPassword` | Y | — |
| GET | `/api/auth/verify-reset-token` | `validators.verifyResetToken` _(public path)_ | `passwordService.verifyResetToken` | Y | — |

---

#### `routes/auth/users.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/auth/users` | `requireAuth`, `requireAdmin` | `accountService.listUsers` | Y | — |
| POST | `/api/auth/users` | `requireAuth`, `requireAdmin`, `validators.createUser` | `accountService.createUser` | Y | — |
| PUT | `/api/auth/users/:id` | `requireAuth`, `requireAdmin`, `validators.updateUser` | `accountService.updateUser` | Y | — |
| POST | `/api/auth/users/:id/reset-password` | `requireAuth`, `requireAdmin`, `validators.resetUserPassword` | `accountService.adminResetPassword` | Y | — |
| POST | `/api/auth/users/:id/unlock` | `requireAuth`, `requireAdmin`, `validators.unlockUser` | `accountService.unlockUser` | Y | — |

---

#### `routes/subscriptions/plans.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/square/payment-config` | _(public; no auth)_ | inline env read | Y | — |
| GET | `/api/subscriptions/plans` | _(public; no auth)_ | `subscriptionHandler.getPlans` | Y | — |

---

#### `routes/subscriptions/merchant.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/subscriptions/promo/validate` | `promoRateLimit` (aliased to loginRateLimit), `validators.validatePromo` | `validatePromoCode` | Y | — |
| POST | `/api/subscriptions/create` | `subscriptionRateLimit`, `validators.createSubscription` | `createSubscription` | Y | — |
| GET | `/api/subscriptions/status` | `subscriptionRateLimit`, `validators.checkStatus` _(public path)_ | `subscriptionHandler.checkSubscriptionStatus` | Y | — |
| GET | `/api/subscriptions/merchant-status` | `requireAuth` | `subscriptionBridge.getMerchantStatusSummary` | Y | — |
| POST | `/api/subscriptions/cancel` | `requireAuth`, `validators.cancelSubscription` | `subscriptionHandler.cancelSubscription` | Y | — |

---

#### `routes/subscriptions/admin.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/subscriptions/refund` | `requireAdmin` | `subscriptionHandler.processRefund` | Y | ⚠️ No explicit `requireAuth` before `requireAdmin`; relies solely on global apiAuthMiddleware — recommend explicit chain |
| GET | `/api/subscriptions/admin/list` | `requireAuth`, `requirePermission('subscription','admin')`, `validators.listSubscribers` | `subscriptionHandler.getAllSubscribers` | Y | — |
| GET | `/api/subscriptions/admin/plans` | `requireAuth`, `requirePermission('subscription','admin')` | `squareSubscriptions.listPlans` | Y | — |
| POST | `/api/subscriptions/admin/setup-plans` | `requireAuth`, `requirePermission('subscription','admin')`, `requireSuperAdmin` | `squareSubscriptions.setupSubscriptionPlans` | Y | — |
| GET | `/api/admin/pricing` | `requireAuth`, `requirePermission('subscription','admin')`, `requireSuperAdmin` | `pricingService.getAllModulePricing` + `getPlatformPlanPricing` | Y | — |
| PUT | `/api/admin/pricing/modules/:key` | `requireAuth`, `requirePermission('subscription','admin')`, `requireSuperAdmin`, `validators.updatePricingItem` | `pricingService.updateModulePrice` | Y | — |
| PUT | `/api/admin/pricing/plans/:key` | `requireAuth`, `requirePermission('subscription','admin')`, `requireSuperAdmin`, `validators.updatePricingItem` | `pricingService.updatePlatformPlanPrice` | Y | — |

---

#### `routes/subscriptions/public.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/public/pricing` | _(public; no auth)_ | `pricingService.getAllModulePricing` + `getPlatformPlanPricing` | Y | — |
| GET | `/api/public/promo/check` | `promoRateLimit` | `checkPublicPromo` | Y | — |

---

#### `routes/subscriptions/webhooks.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/webhooks/events` | `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `validators.listWebhookEvents` | inline DB query | N | ⚠️ No test coverage — `__tests__/routes/webhooks.test.js` covers Square inbound processing only, not this admin view endpoint |

---

#### `routes/merchants.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/merchants` | `requireAuth`, `validators.list` | `getUserMerchants` | Y | — |
| POST | `/api/merchants/switch` | `requireAuth`, `validators.switch` | `switchActiveMerchant` | Y | — |
| GET | `/api/merchants/context` | `requireAuth`, `validators.context` | inline | Y | — |
| GET | `/api/config` | `requireAuth`, `validators.config` | inline (merchant settings + env vars) | Y | — |

---

**Group 1 flag summary:**

| # | Severity | Route | Issue |
|---|----------|-------|-------|
| 1 | HIGH | `POST /api/auth/forgot-password` | Missing rate limit — `passwordResetRateLimit` declared in file but not applied; unlimited password-reset emails can be triggered per IP |
| 2 | LOW | `POST /api/subscriptions/refund` | No explicit `requireAuth` in route chain; relies on global apiAuthMiddleware — recommend adding for clarity and defense-in-depth |
| 3 | LOW | `GET /api/webhooks/events` | No test coverage for this admin endpoint |

---

### Group 2 — Catalog & Inventory

Files scanned: `routes/catalog.js`, `routes/catalog-health.js`.

> **Scope note:** `routes/inventory.js` does not exist. The `/api/inventory` and `/api/low-stock` endpoints are defined in `routes/catalog.js` and are included below.

Mount points: `routes/catalog.js` → `/api`; `routes/catalog-health.js` → `/api/admin/catalog-health`.

Additional global gates from `server.js` `gateApi()` calls:
- `/expirations` → `requireFeature('expiry')`, `requirePermission('expiry', 'read')`
- `/deleted-items` → `requireFeature('loyalty')`, `requirePermission('loyalty', 'read')`
- `/catalog-audit` → `requirePermission('base', 'read')`

---

#### `routes/catalog.js`

| Method | Path | Middleware chain (route-level + feature gate) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/locations` | `requireAuth`, `requireMerchant` | `catalogService.getLocations` | Y | — |
| GET | `/api/categories` | `requireAuth`, `requireMerchant`, `validators.getCategories` | `catalogService.getCategories` | Y | — |
| GET | `/api/items` | `requireAuth`, `requireMerchant`, `validators.getItems` | `catalogService.getItems` | Y | — |
| GET | `/api/variations` | `requireAuth`, `requireMerchant`, `validators.getVariations` | `catalogService.getVariations` | Y | — |
| GET | `/api/variations-with-costs` | `requireAuth`, `requireMerchant`, `validators.getVariationsWithCosts` | `catalogService.getVariationsWithCosts` | Y | — |
| PATCH | `/api/variations/:id/extended` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.updateVariationExtended` | `catalogService.updateExtendedFields` | Y | — |
| PATCH | `/api/variations/:id/min-stock` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.updateMinStock` | `catalogService.updateMinStock` | Y | — |
| PATCH | `/api/variations/:id/cost` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.updateCost` | `catalogService.updateCost` | Y | — |
| POST | `/api/variations/bulk-update-extended` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.bulkUpdateExtended` | `catalogService.bulkUpdateExtendedFields` | Y | — |
| GET | `/api/expirations` | `requireAuth`, `requireMerchant`, `validators.getExpirations` + feat:expiry, perm:expiry/read | `catalogService.getExpirations` | Y | — |
| POST | `/api/expirations` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.saveExpirations` + feat:expiry, perm:expiry/read | `catalogService.saveExpirations` | Y | — |
| POST | `/api/expirations/pull` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.pullExpired` + feat:expiry, perm:expiry/read | `catalogService.handleExpiredPull` | Y | — |
| POST | `/api/expirations/review` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.reviewExpirations` + feat:expiry, perm:expiry/read | `catalogService.markExpirationsReviewed` | Y | — |
| GET | `/api/inventory` | `requireAuth`, `requireMerchant`, `validators.getInventory` | `catalogService.getInventory` | Y | — |
| GET | `/api/low-stock` | `requireAuth`, `requireMerchant`, `validators.getLowStock` | `catalogService.getLowStock` | Y | — |
| GET | `/api/deleted-items` | `requireAuth`, `requireMerchant`, `validators.getDeletedItems` + feat:loyalty, perm:loyalty/read | `catalogService.getDeletedItems` | Y | — |
| GET | `/api/catalog-audit` | `requireAuth`, `requireMerchant`, `validators.getCatalogAudit` + perm:base/read | `catalogService.getCatalogAudit` | Y | — |
| POST | `/api/catalog-audit/enable-item-at-locations` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.enableItemAtLocations` + perm:base/read | `catalogService.enableItemAtAllLocations` | Y | — |
| POST | `/api/catalog-audit/fix-locations` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.fixLocations` + perm:base/read | `catalogService.fixLocationMismatches` | Y | ⚠️ Bulk destructive Square catalog write; no admin/superAdmin gate beyond `requireWriteAccess` |
| POST | `/api/catalog-audit/fix-inventory-alerts` | `requireAuth`, `requireWriteAccess`, `requireMerchant`, `validators.fixInventoryAlerts` + perm:base/read | `catalogService.fixInventoryAlerts` | Y | ⚠️ Same — bulk Square write with no elevated-role guard |

---

#### `routes/catalog-health.js`

Mounted at `/api/admin/catalog-health`.

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/admin/catalog-health` | `requireAuth`, `requireAdmin`, `validators.getHealth` | `getHealthHistory`, `getOpenIssues` | Y | ⚠️ Hard-coded `DEBUG_MERCHANT_ID = 3` — always runs against merchant 3 regardless of caller; breaks multi-tenant design |
| POST | `/api/admin/catalog-health/check` | `requireAuth`, `requireAdmin`, `validators.runCheck` | `runFullHealthCheck` | Y | ⚠️ Same hard-coded `DEBUG_MERCHANT_ID = 3` issue |

---

**Group 2 flag summary:**

| # | Severity | Route | Issue |
|---|----------|-------|-------|
| 1 | HIGH | `GET /api/admin/catalog-health`, `POST /api/admin/catalog-health/check` | Hard-coded `DEBUG_MERCHANT_ID = 3` — health check always targets merchant 3 regardless of authenticated caller; violates multi-tenant isolation |
| 2 | MEDIUM | `POST /api/catalog-audit/fix-locations` | Bulk destructive Square catalog operation; only `requireWriteAccess` guards it — no admin or superAdmin role required |
| 3 | MEDIUM | `POST /api/catalog-audit/fix-inventory-alerts` | Same — bulk Square write with no elevated-role gate |
| 4 | INFO | — | `routes/inventory.js` referenced in task scope does not exist; `/api/inventory` and `/api/low-stock` are in `routes/catalog.js` |

---

### Group 3 — Purchasing & Counts

Files scanned: `routes/purchase-orders.js`, `routes/cycle-counts.js`.

> **Scope note:** `routes/reorder.js` does not exist. Reorder suggestion endpoints (`GET /api/reorder-suggestions`) live in `routes/analytics.js`, which is gated by `requireFeature('reorder')` and `requirePermission('reorder', 'read')` via `server.js` — those routes are outside the task scope for this group.

Mount points: `routes/purchase-orders.js` → `/api/purchase-orders` (with `requireFeature('reorder')`, `requirePermission('reorder', 'read')` applied at mount); `routes/cycle-counts.js` → `/api` (with `requireFeature('cycle_counts')`, `requirePermission('cycle_counts', 'read')` on `/cycle-counts` via `gateApi`).

---

#### `routes/purchase-orders.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/purchase-orders` | `requireAuth`, `requireMerchant`, `validators.createPurchaseOrder` | `poService.createPurchaseOrder` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/purchase-orders` | `requireAuth`, `requireMerchant`, `validators.listPurchaseOrders` | `poService.listPurchaseOrders` | Y | — |
| GET | `/api/purchase-orders/:id` | `requireAuth`, `requireMerchant`, `validators.getPurchaseOrder` | `poService.getPurchaseOrder` | Y | — |
| PATCH | `/api/purchase-orders/:id` | `requireAuth`, `requireMerchant`, `validators.updatePurchaseOrder` | `poService.updatePurchaseOrder` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/purchase-orders/:id/submit` | `requireAuth`, `requireMerchant`, `validators.submitPurchaseOrder` | `poService.submitPurchaseOrder` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/purchase-orders/:id/receive` | `requireAuth`, `requireMerchant`, `validators.receivePurchaseOrder` | `poReceiveService.receiveItems` | Y | ⚠️ Missing `requireWriteAccess` — records received inventory |
| DELETE | `/api/purchase-orders/:id` | `requireAuth`, `requireMerchant`, `validators.deletePurchaseOrder` | `poService.deletePurchaseOrder` | Y | ⚠️ Missing `requireWriteAccess` — read-only users can delete POs |
| GET | `/api/purchase-orders/:po_number/export-csv` | `requireAuth`, `requireMerchant`, `validators.exportPurchaseOrderCsv` | `poExportService.getPurchaseOrderForExport` + `buildCsvContent` | Y | — |
| GET | `/api/purchase-orders/:po_number/export-xlsx` | `requireAuth`, `requireMerchant`, `validators.exportPurchaseOrderXlsx` | `poExportService.getPurchaseOrderForExport` + `buildXlsxWorkbook` | Y | — |

---

#### `routes/cycle-counts.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/cycle-counts/pending` | `requireAuth`, `requireMerchant` | inline DB query + `batchResolveImageUrls` | Y | — |
| POST | `/api/cycle-counts/:id/complete` | `requireAuth`, `requireMerchant`, `validators.complete` | inline DB transaction (count_history, queue updates) | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/cycle-counts/:id/sync-to-square` | `requireAuth`, `requireMerchant`, `validators.syncToSquare` | `squareApi.setSquareInventoryCount` + DB update | Y | ⚠️ Missing `requireWriteAccess` — pushes inventory adjustment to Square |
| POST | `/api/cycle-counts/send-now` | `requireAuth`, `requireMerchant`, `validators.sendNow` | inline DB insert (count_queue_priority) | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/cycle-counts/stats` | `requireAuth`, `requireMerchant`, `validators.getStats` | inline DB query | Y | — |
| GET | `/api/cycle-counts/history` | `requireAuth`, `requireMerchant`, `validators.getHistory` | inline DB query | Y | — |
| POST | `/api/cycle-counts/email-report` | `requireAuth`, `requireMerchant`, `validators.emailReport` | `sendCycleCountReport` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/cycle-counts/generate-batch` | `requireAuth`, `requireMerchant`, `validators.generateBatch` | `generateDailyBatch` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/cycle-counts/reset` | `requireAuth`, `requireMerchant`, `validators.reset` | inline DB delete + insert (can wipe all count history) | Y | ⚠️ Missing `requireWriteAccess`; no admin gate on a destructive full-wipe operation |

---

**Group 3 flag summary:**

| # | Severity | Route | Issue |
|---|----------|-------|-------|
| 1 | HIGH | `DELETE /api/purchase-orders/:id` | Missing `requireWriteAccess` — read-only role can delete POs |
| 2 | MEDIUM | `POST /api/purchase-orders` | Missing `requireWriteAccess` — read-only role can create POs |
| 3 | MEDIUM | `PATCH /api/purchase-orders/:id` | Missing `requireWriteAccess` |
| 4 | MEDIUM | `POST /api/purchase-orders/:id/submit` | Missing `requireWriteAccess` |
| 5 | MEDIUM | `POST /api/purchase-orders/:id/receive` | Missing `requireWriteAccess` — records received inventory without write-role check |
| 6 | HIGH | `POST /api/cycle-counts/reset` | Missing `requireWriteAccess` AND no admin gate; can irrecoverably wipe all count history |
| 7 | MEDIUM | `POST /api/cycle-counts/:id/complete` | Missing `requireWriteAccess` |
| 8 | MEDIUM | `POST /api/cycle-counts/:id/sync-to-square` | Missing `requireWriteAccess` — pushes inventory adjustments to Square |
| 9 | MEDIUM | `POST /api/cycle-counts/send-now` | Missing `requireWriteAccess` |
| 10 | MEDIUM | `POST /api/cycle-counts/email-report` | Missing `requireWriteAccess` |
| 11 | MEDIUM | `POST /api/cycle-counts/generate-batch` | Missing `requireWriteAccess` |
| 12 | INFO | — | `routes/reorder.js` referenced in task scope does not exist; reorder suggestions are in `routes/analytics.js` |

---

### Group 4 — Loyalty & Seniors

Files scanned: `routes/loyalty/` (10 sub-modules via `routes/loyalty.js` facade), `routes/seniors.js`.

Mount points:
- `routes/loyalty.js` → `/api/loyalty` (and `/api/v1/loyalty`); server.js applies `requireFeature('loyalty')`, `requirePermission('loyalty', 'read')` at mount; `routes/loyalty/index.js` mounts all 10 sub-routers flat.
- `routes/seniors.js` → `/api`; server.js applies `gateApi('/seniors', requireFeature('loyalty'), requirePermission('loyalty', 'read'))`.

All routes below carry the feature/permission gate noted in the mount summary. "feat:loyalty + perm:loyalty/read" is omitted from individual rows for brevity — it applies to every route in this group.

---

#### `routes/loyalty/offers.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/loyalty/offers` | `requireAuth`, `requireMerchant`, `validators.listOffers` | `loyaltyService.getOffers` | Y | — |
| POST | `/api/loyalty/offers` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.createOffer` | `loyaltyService.createOffer` | Y | — |
| GET | `/api/loyalty/offers/:id` | `requireAuth`, `requireMerchant`, `validators.getOffer` | `loyaltyService.getOfferById` + `getQualifyingVariations` | Y | — |
| PATCH | `/api/loyalty/offers/:id` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.updateOffer` | `loyaltyService.updateOffer` | Y | — |
| DELETE | `/api/loyalty/offers/:id` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.deleteOffer` | `loyaltyService.deleteOffer` | Y | — |

---

#### `routes/loyalty/variations.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/loyalty/offers/:id/variations` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.addVariations` | `loyaltyService.addQualifyingVariations` | Y | — |
| GET | `/api/loyalty/offers/:id/variations` | `requireAuth`, `requireMerchant`, `validators.getOfferVariations` | `loyaltyService.getQualifyingVariations` | Y | — |
| GET | `/api/loyalty/variations/assignments` | `requireAuth`, `requireMerchant` | `loyaltyService.getVariationAssignments` | Y | — |
| DELETE | `/api/loyalty/offers/:offerId/variations/:variationId` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.removeVariation` | `loyaltyService.removeQualifyingVariation` | Y | — |

---

#### `routes/loyalty/customers.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/loyalty/customer/:customerId` | `requireAuth`, `requireMerchant`, `validators.getCustomer` | `loyaltyService.getCustomerDetails` + `getCustomerLoyaltyStatus` | Y | — |
| GET | `/api/loyalty/customer/:customerId/profile` | `requireAuth`, `requireMerchant`, `validators.getCustomer` | `loyaltyService.getCustomerDetails` + `getCustomerOfferProgress` | Y | — |
| GET | `/api/loyalty/customer/:customerId/history` | `requireAuth`, `requireMerchant`, `validators.getCustomerHistory` | `loyaltyService.getCustomerLoyaltyHistory` | Y | — |
| GET | `/api/loyalty/customer/:customerId/rewards` | `requireAuth`, `requireMerchant`, `validators.getCustomer` | `loyaltyService.getCustomerEarnedRewards` | Y | — |
| GET | `/api/loyalty/customer/:customerId/audit-history` | `requireAuth`, `requireMerchant`, `validators.getCustomerAuditHistory` | `loyaltyService.getCustomerOrderHistoryForAudit` | Y | — |
| POST | `/api/loyalty/customer/:customerId/add-orders` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.addOrders` | `loyaltyService.addOrdersToLoyaltyTracking` | Y | — |
| GET | `/api/loyalty/customers/search` | `requireAuth`, `requireMerchant`, `validators.searchCustomers` | `searchCustomers` | Y | — |

---

#### `routes/loyalty/rewards.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/loyalty/rewards/:rewardId/redeem` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.redeemReward` | `loyaltyService.redeemReward` | Y | — |
| PATCH | `/api/loyalty/rewards/:rewardId/vendor-credit` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.updateVendorCredit` | `loyaltyService.updateVendorCreditStatus` | Y | — |
| GET | `/api/loyalty/rewards` | `requireAuth`, `requireMerchant`, `validators.listRewards` | `loyaltyService.getRewards` | Y | — |
| GET | `/api/loyalty/redemptions` | `requireAuth`, `requireMerchant`, `validators.listRedemptions` | `loyaltyService.getRedemptions` | Y | — |

---

#### `routes/loyalty/square-integration.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/loyalty/square-program` | `requireAuth`, `requireMerchant` | `loyaltyService.getSquareLoyaltyProgram` | Y | — |
| PUT | `/api/loyalty/offers/:id/square-tier` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.linkSquareTier` | `loyaltyService.linkOfferToSquareTier` | Y | — |
| POST | `/api/loyalty/rewards/:id/create-square-reward` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.createSquareReward` | `loyaltyService.createSquareReward` | Y | — |
| POST | `/api/loyalty/rewards/sync-to-pos` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.syncToPOS` | `loyaltyService.syncRewardsToPOS` | Y | — |
| GET | `/api/loyalty/rewards/pending-sync` | `requireAuth`, `requireMerchant` | `loyaltyService.getPendingSyncCounts` | Y | — |

---

#### `routes/loyalty/processing.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/loyalty/process-order/:orderId` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.processOrder` | `loyaltyService.processOrderManually` | Y | — |
| POST | `/api/loyalty/backfill` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.backfill` | `loyaltyService.runBackfill` | Y | ⚠️ No rate limit on expensive backfill operation |
| POST | `/api/loyalty/catchup` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.catchup` | `loyaltyService.runLoyaltyCatchup` | Y | ⚠️ No rate limit — can initiate large Square API fan-out |
| POST | `/api/loyalty/refresh-customers` | `requireAuth`, `requireMerchant`, `requireWriteAccess` | `loyaltyService.refreshCustomersWithMissingData` | Y | ⚠️ No rate limit — unbounded Square customer fetch |
| POST | `/api/loyalty/manual-entry` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.manualEntry` | `loyaltyService.processManualEntry` | Y | — |
| POST | `/api/loyalty/process-expired` | `requireAuth`, `requireMerchant`, `requireWriteAccess` | `loyaltyService.processExpiredWindowEntries` + `processExpiredEarnedRewards` | Y | — |

---

#### `routes/loyalty/audit.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/loyalty/audit` | `requireAuth`, `requireMerchant`, `validators.listAudit` | `loyaltyService.getAuditLogs` | Y | — |
| GET | `/api/loyalty/stats` | `requireAuth`, `requireMerchant` | `loyaltyService.getLoyaltyStats` | Y | — |
| GET | `/api/loyalty/audit-findings` | `requireAuth`, `requireMerchant`, `validators.listAuditFindings` | `loyaltyService.getAuditFindings` | Y | — |
| POST | `/api/loyalty/audit-findings/resolve/:id` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.resolveAuditFinding` | `loyaltyService.resolveAuditFinding` | Y | — |
| POST | `/api/loyalty/audit-missed-redemptions` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.auditMissedRedemptions` | `loyaltyService.auditMissedRedemptions` | Y | — |

---

#### `routes/loyalty/reports.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/loyalty/reports` | `requireAuth`, `requireMerchant` | inline (endpoint index) | Y | — |
| GET | `/api/loyalty/reports/vendor-receipt/:rewardId` | `requireAuth`, `requireMerchant`, `validators.getVendorReceipt` | `loyaltyReports.generateVendorReceipt` | Y | — |
| GET | `/api/loyalty/reports/brand-redemptions` | `requireAuth`, `requireMerchant`, `validators.getBrandRedemptions` | `brandRedemptionReport.buildBrandRedemptionReport` / `generateBrandRedemptionHTML` / `generateBrandRedemptionCSV` | Y | — |
| GET | `/api/loyalty/reports/redemptions/csv` | `requireAuth`, `requireMerchant`, `validators.exportRedemptionsCSV` | `loyaltyReports.generateRedemptionsCSV` | Y | — |
| GET | `/api/loyalty/reports/audit/csv` | `requireAuth`, `requireMerchant`, `validators.exportAuditCSV` | `loyaltyReports.generateAuditCSV` | Y | — |
| GET | `/api/loyalty/reports/summary/csv` | `requireAuth`, `requireMerchant`, `validators.exportSummaryCSV` | `loyaltyReports.generateSummaryCSV` | Y | — |
| GET | `/api/loyalty/reports/customers/csv` | `requireAuth`, `requireMerchant`, `validators.exportCustomersCSV` | `loyaltyReports.generateCustomerActivityCSV` | Y | — |
| GET | `/api/loyalty/reports/redemption/:rewardId` | `requireAuth`, `requireMerchant`, `validators.getRedemptionDetails` | `loyaltyReports.getRedemptionDetails` | Y | — |

---

#### `routes/loyalty/settings.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/loyalty/settings` | `requireAuth`, `requireMerchant` | `loyaltyService.getSettings` | Y | — |
| PUT | `/api/loyalty/settings` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.updateSettings` | `loyaltyService.updateSetting` | Y | — |

---

#### `routes/loyalty/discounts.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/loyalty/discounts/validate` | `requireAuth`, `requireMerchant` | `loyaltyService.validateEarnedRewardsDiscounts({fixIssues: false})` | Y | — |
| POST | `/api/loyalty/discounts/validate-and-fix` | `requireAuth`, `requireMerchant`, `requireWriteAccess` | `loyaltyService.validateEarnedRewardsDiscounts({fixIssues: true})` | Y | — |

---

#### `routes/seniors.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/seniors/status` | `requireAuth`, `requireMerchant` | inline DB + `SeniorsService.verifyPricingRuleState` | Y | — |
| POST | `/api/seniors/setup` | `requireAuth`, `requireMerchant`, `requireWriteAccess` | `SeniorsService.setupSquareObjects` | Y | — |
| GET | `/api/seniors/config` | `requireAuth`, `requireMerchant` | inline DB | Y | — |
| PATCH | `/api/seniors/config` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.updateConfig` | inline DB | Y | — |
| GET | `/api/seniors/members` | `requireAuth`, `requireMerchant`, `validators.listMembers` | inline DB | Y | — |
| GET | `/api/seniors/audit-log` | `requireAuth`, `requireMerchant`, `validators.listAuditLog` | inline DB | Y | — |

---

**Group 4 flag summary:**

| # | Severity | Route | Issue |
|---|----------|-------|-------|
| 1 | MEDIUM | `POST /api/loyalty/backfill` | No rate limit — can trigger unbounded Square order fetch (expensive API fan-out) |
| 2 | MEDIUM | `POST /api/loyalty/catchup` | No rate limit — reverse-lookup can fan out across many customers and Square API calls |
| 3 | LOW | `POST /api/loyalty/refresh-customers` | No rate limit — fetches Square customer data for all customers with missing phone numbers |

---

### Group 5 — Delivery & Vendors

Files scanned: `routes/delivery/` (5 sub-modules via `routes/delivery/index.js`), `routes/vendor-catalog/` (4 sub-modules via `routes/vendor-catalog/index.js`).

> **Scope note:** `routes/vendors.js` does not exist as a standalone file. Vendor listing and management are split across `routes/vendor-catalog/vendors.js`, `routes/vendor-catalog/import.js`, `routes/vendor-catalog/lookup.js`, and `routes/vendor-catalog/manage.js`.

Mount points:
- `routes/delivery/` → `/api/delivery` (and `/api/v1/delivery`); server.js applies `requireFeature('delivery')`, `requirePermission('delivery', 'read')` at mount; `routes/delivery/index.js` applies `requireAuth`, `requireMerchant` globally for all sub-routes.
- `routes/vendor-catalog/` → `/api` (and `/api/v1`); server.js `gateApi` applies `requireFeature('reorder')`, `requirePermission('reorder', 'read')` on `/vendors` and `/vendor-catalog` prefixes.

**Important:** `routes/delivery/index.js` applies `requireAuth` and `requireMerchant` at router level — these are inherited by all sub-routes and omitted from individual rows for clarity. `requireWriteAccess` is absent from every delivery sub-router; write operations are protected only by rate limiting.

---

#### `routes/delivery/orders.js`

_(All routes inherit `requireAuth`, `requireMerchant` from parent router.)_

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/delivery/orders` | `validators.listOrders` | `deliveryApi.getOrders` | Y | — |
| POST | `/api/delivery/orders` | `deliveryRateLimit`, `validators.createOrder` | `deliveryApi.createOrder` + `geocodeAndPatchOrder` + `logAuditEvent` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/delivery/orders/:id` | `validators.getOrder` | `deliveryApi.getOrderById` | Y | — |
| PATCH | `/api/delivery/orders/:id` | `deliveryRateLimit`, `validators.updateOrder` | `deliveryApi.updateOrder` + `geocodeAndPatchOrder` | Y | ⚠️ Missing `requireWriteAccess` |
| DELETE | `/api/delivery/orders/:id` | `deliveryRateLimit`, `validators.deleteOrder` | `deliveryApi.deleteOrder` + `logAuditEvent` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/delivery/orders/:id/skip` | `deliveryRateLimit`, `validators.skipOrder` | `deliveryApi.skipOrder` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/delivery/orders/:id/complete` | `deliveryRateLimit`, `validators.completeOrder` | `deliveryApi.completeDeliveryInSquare` + `deliveryApi.completeOrder` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/delivery/orders/:id/customer` | `validators.getOrder` | `deliveryStats.getCustomerInfo` | Y | — |
| PATCH | `/api/delivery/orders/:id/customer-note` | `deliveryRateLimit`, `validators.updateCustomerNote` | `deliveryStats.updateCustomerNote` | Y | ⚠️ Missing `requireWriteAccess` |
| PATCH | `/api/delivery/orders/:id/notes` | `deliveryRateLimit`, `validators.updateOrderNotes` | `deliveryApi.updateOrderNotes` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/delivery/orders/:id/customer-stats` | `validators.getOrder` | `deliveryStats.getCustomerStats` | Y | — |

---

#### `routes/delivery/pod.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/delivery/orders/:id/pod` | `deliveryRateLimit`, `podUpload.single('photo')`, `validateUploadedImage('photo')`, `validators.uploadPod` | `deliveryApi.savePodPhoto` + `logAuditEvent` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/delivery/pod/:id` | `validators.getPod` | `deliveryApi.getPodPhoto` + `res.sendFile` | Y | — |

---

#### `routes/delivery/routes.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/delivery/route/generate` | `deliveryStrictRateLimit`, `validators.generateRoute` | `deliveryApi.generateRoute` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/delivery/route/active` | `validators.getActiveRoute` | `deliveryApi.getActiveRouteWithOrders` | Y | — |
| GET | `/api/delivery/route/:id` | `validators.getRoute` | `deliveryApi.getRouteWithOrders` | Y | — |
| POST | `/api/delivery/route/finish` | `deliveryRateLimit`, `validators.finishRoute` | `deliveryApi.finishRoute` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/delivery/geocode` | `deliveryStrictRateLimit`, `validators.geocode` | `deliveryApi.geocodePendingOrders` | Y | ⚠️ Missing `requireWriteAccess` — triggers external geocoding API calls |

---

#### `routes/delivery/settings.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/delivery/settings` | _(none at route level)_ | `deliveryApi.getSettingsWithDefaults` | Y | — |
| PUT | `/api/delivery/settings` | `deliveryRateLimit`, `validators.updateSettings` | `deliveryApi.updateSettingsWithGeocode` + `logAuditEvent` | Y | ⚠️ Missing `requireWriteAccess` |

---

#### `routes/delivery/sync.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/delivery/sync` | `deliveryStrictRateLimit`, `validators.syncOrders` | `deliveryApi.syncSquareOrders` | Y | ⚠️ Missing `requireWriteAccess` — triggers full Square order sync |
| POST | `/api/delivery/backfill-customers` | `deliveryStrictRateLimit`, `validators.backfillCustomers` | `deliveryApi.backfillUnknownCustomers` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/delivery/audit` | `validators.getAudit` | `deliveryApi.getAuditLog` | Y | — |
| GET | `/api/delivery/stats` | _(none at route level)_ | `deliveryStats.getDashboardStats` | Y | — |

---

#### `routes/vendor-catalog/vendors.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/vendors` | `requireAuth`, `requireMerchant`, `validators.getVendors` | `vendorQuery.listVendors` | Y | — |
| GET | `/api/vendor-dashboard` | `requireAuth`, `requireMerchant` | `vendorDashboard.getVendorDashboard` | Y | — |
| PATCH | `/api/vendors/:id/settings` | `requireAuth`, `requireMerchant`, `validators.updateVendorSettings` | `vendorDashboard.updateVendorSettings` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/vendor-catalog/merchant-taxes` | `requireAuth`, `requireMerchant` | `vendorQuery.getMerchantTaxes` | Y | — |

---

#### `routes/vendor-catalog/import.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/vendor-catalog/import` | `requireAuth`, `requireMerchant`, `validators.importCatalog` | `vendorCatalog.importVendorCatalog` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/vendor-catalog/preview` | `requireAuth`, `requireMerchant`, `validators.previewFile` | `vendorCatalog.previewFile` | Y | — |
| POST | `/api/vendor-catalog/import-mapped` | `requireAuth`, `requireMerchant`, `validators.importMapped` | `vendorCatalog.importWithMappings` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/vendor-catalog/field-types` | `requireAuth` _(no `requireMerchant`)_ | `vendorCatalog.FIELD_TYPES` (inline) | Y | ⚠️ Missing `requireMerchant` — field-types is read-only catalog metadata, but pattern inconsistency |
| GET | `/api/vendor-catalog/stats` | `requireAuth`, `requireMerchant` | `vendorCatalog.getStats` | Y | — |

---

#### `routes/vendor-catalog/lookup.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/vendor-catalog` | `requireAuth`, `requireMerchant`, `validators.searchCatalog` | `vendorCatalog.searchVendorCatalog` | Y | — |
| GET | `/api/vendor-catalog/lookup/:upc` | `requireAuth`, `requireMerchant`, `validators.lookupUpc` | `vendorCatalog.lookupByUPC` + `vendorQuery.lookupOurItemByUPC` | Y | — |
| GET | `/api/vendor-catalog/batches` | `requireAuth`, `requireMerchant`, `validators.getBatches` | `vendorCatalog.getImportBatches` | Y | — |
| GET | `/api/vendor-catalog/batches/:batchId/report` | `requireAuth`, `requireMerchant`, `validators.batchAction` | `vendorCatalog.regeneratePriceReport` | Y | — |

---

#### `routes/vendor-catalog/manage.js`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/vendor-catalog/push-price-changes` | `requireAuth`, `requireMerchant`, `validators.pushPriceChanges` | `vendorQuery.verifyVariationsBelongToMerchant` + `squareApi.batchUpdateVariationPrices` | Y | ⚠️ Missing `requireWriteAccess` — bulk Square price updates |
| POST | `/api/vendor-catalog/confirm-links` | `requireAuth`, `requireMerchant`, `validators.confirmLinks` | `vendorQuery.confirmVendorLinks` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/vendor-catalog/deduplicate` | `requireAuth`, `requireMerchant`, `validators.deduplicate` | `vendorCatalog.deduplicateVendorCatalog` | Y | ⚠️ Missing `requireWriteAccess` — destructive DB deduplication |
| POST | `/api/vendor-catalog/create-items` | `requireAuth`, `requireMerchant`, `validators.createItems` | `bulkCreateSquareItems` | Y | ⚠️ Missing `requireWriteAccess` — bulk Square catalog item creation |
| POST | `/api/vendor-catalog/batches/:batchId/archive` | `requireAuth`, `requireMerchant`, `validators.batchAction` | `vendorCatalog.archiveImportBatch` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/vendor-catalog/batches/:batchId/unarchive` | `requireAuth`, `requireMerchant`, `validators.batchAction` | `vendorCatalog.unarchiveImportBatch` | Y | ⚠️ Missing `requireWriteAccess` |
| DELETE | `/api/vendor-catalog/batches/:batchId` | `requireAuth`, `requireMerchant`, `validators.batchAction` | `vendorCatalog.deleteImportBatch` | Y | ⚠️ Missing `requireWriteAccess` — permanent batch deletion |

---

**Group 5 flag summary:**

| # | Severity | Route | Issue |
|---|----------|-------|-------|
| 1 | HIGH | All delivery write endpoints (POST/PATCH/DELETE/PUT in orders, pod, routes, settings, sync) | No `requireWriteAccess` on any delivery write operation — read-only users can create/modify/delete orders, generate routes, sync from Square, upload POD photos |
| 2 | HIGH | `POST /api/vendor-catalog/push-price-changes` | Missing `requireWriteAccess` — bulk Square catalog price updates without write-role gate |
| 3 | HIGH | `POST /api/vendor-catalog/create-items` | Missing `requireWriteAccess` — bulk Square catalog item creation |
| 4 | MEDIUM | `POST /api/vendor-catalog/import` | Missing `requireWriteAccess` |
| 5 | MEDIUM | `POST /api/vendor-catalog/import-mapped` | Missing `requireWriteAccess` |
| 6 | MEDIUM | `POST /api/vendor-catalog/deduplicate` | Missing `requireWriteAccess` — can permanently remove DB rows |
| 7 | MEDIUM | `DELETE /api/vendor-catalog/batches/:batchId` | Missing `requireWriteAccess` — permanent deletion |
| 8 | MEDIUM | `PATCH /api/vendors/:id/settings` | Missing `requireWriteAccess` |
| 9 | MEDIUM | `POST /api/vendor-catalog/confirm-links`, `POST .../archive`, `POST .../unarchive` | Missing `requireWriteAccess` |
| 10 | LOW | `GET /api/vendor-catalog/field-types` | Missing `requireMerchant` — low risk (read-only metadata) but inconsistent with project patterns |
| 11 | INFO | — | `routes/vendors.js` referenced in task scope does not exist; vendor endpoints are in `routes/vendor-catalog/vendors.js` |

---

### Group 6 — Admin, Webhooks & Middleware Summary

Files scanned: `routes/logs.js`, `routes/analytics.js`, `routes/square-attributes.js`, `routes/webhooks.js`, `routes/webhooks/square.js`, plus all remaining uncovered route files: `routes/admin.js`, `routes/ai-autofill.js`, `routes/bundles.js`, `routes/cart-activity.js`, `routes/catalog-location-health.js`, `routes/driver-api.js`, `routes/expiry-discounts.js`, `routes/gmc/` (4 sub-modules), `routes/google-oauth.js`, `routes/labels.js`, `routes/min-max-suppression-routes.js`, `routes/settings.js`, `routes/square-oauth.js`, `routes/staff.js`, `routes/sync.js`, `routes/vendor-match-suggestions.js`.

---

#### `routes/logs.js` — mount: `/api` with `gateApi('/logs', requirePermission('base', 'admin'))`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/logs` | `requireAdmin`, `validators.list` | `readLogContent` (fs read) | Y | — |
| GET | `/api/logs/errors` | `requireAdmin`, `validators.errors` | `readLogContent` (error log) | Y | — |
| GET | `/api/logs/dates` | `requireAdmin`, `validators.dates` | `listAvailableDates` (fs readdir) | Y | — |
| GET | `/api/logs/download` | `requireAdmin`, `validators.download` | `res.download` (today's log file) | Y | — |
| GET | `/api/logs/stats` | `requireAdmin`, `validators.stats` | inline (parse today's log counts) | Y | — |

> Note: `requireAdmin` includes its own session check (equivalent to `requireAuth` + admin role check); no explicit `requireAuth` needed.

---

#### `routes/analytics.js` — mount: `/api` with `gateApi('/analytics', requireFeature('reorder'), requirePermission('reorder', 'read'))` and similar gates on `/min-max/*`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/sales-velocity` | `requireAuth`, `requireMerchant`, `validators.getVelocity` | inline DB query | Y | — |
| GET | `/api/reorder-suggestions` | `requireAuth`, `requireMerchant`, `validators.getReorderSuggestions` | `getReorderSuggestions` + `calculateCheckboxDefaults` | Y | — |
| GET | `/api/min-max/recommendations` | `requireAuth`, `requireMerchant`, `validators.getRecommendations` | `autoMinMax.generateRecommendations` | Y | — |
| POST | `/api/min-max/apply` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.applyRecommendations` | `autoMinMax.applyAllRecommendations` | Y | — |
| GET | `/api/min-max/history` | `requireAuth`, `requireMerchant`, `validators.getHistory` | `autoMinMax.getHistory` | Y | — |
| POST | `/api/min-max/pin` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.pinVariation` | `autoMinMax.pinVariation` | Y | — |

---

#### `routes/square-attributes.js` — mount: `/api` with `gateApi('/square-attributes', requirePermission('base', 'read'))`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/square/custom-attributes` | `requireAuth`, `requireMerchant` | `squareApi.listCustomAttributeDefinitions` | Y | — |
| POST | `/api/square/custom-attributes/init` | `requireAuth`, `requireMerchant`, `validators.init` | `squareApi.initializeCustomAttributes` | Y | ⚠️ Missing `requireWriteAccess` — creates Square attribute definitions |
| POST | `/api/square/custom-attributes/definition` | `requireAuth`, `requireMerchant`, `validators.createDefinition` | `squareApi.upsertCustomAttributeDefinition` | Y | ⚠️ Missing `requireWriteAccess` |
| DELETE | `/api/square/custom-attributes/definition/:key` | `requireAuth`, `requireMerchant`, `validators.deleteDefinition` | `squareApi.deleteCustomAttributeDefinition` | Y | ⚠️ Missing `requireWriteAccess` — deletes definition AND all values |
| PUT | `/api/square/custom-attributes/:objectId` | `requireAuth`, `requireMerchant`, `validators.updateAttributes` | `squareApi.updateCustomAttributeValues` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/square/custom-attributes/push/case-pack` | `requireAuth`, `requireMerchant`, `validators.pushCasePack` | `squareApi.pushCasePackToSquare` | Y | ⚠️ Missing `requireWriteAccess` — bulk Square push |
| POST | `/api/square/custom-attributes/push/brand` | `requireAuth`, `requireMerchant`, `validators.pushBrand` | `squareApi.pushBrandsToSquare` | Y | ⚠️ Missing `requireWriteAccess` — bulk Square push |
| POST | `/api/square/custom-attributes/push/expiry` | `requireAuth`, `requireMerchant`, `validators.pushExpiry` | `squareApi.pushExpiryDatesToSquare` | Y | ⚠️ Missing `requireWriteAccess` — bulk Square push |
| POST | `/api/square/custom-attributes/push/all` | `requireAuth`, `requireMerchant`, `validators.pushAll` | `squareApi.pushCasePackToSquare` + `pushBrandsToSquare` + `pushExpiryDatesToSquare` | Y | ⚠️ Missing `requireWriteAccess` — bulk push of all attributes |

---

#### `routes/webhooks.js` — mount: `/api` (and `/api/v1`); `routes/webhooks/square.js` — mount: `/api/webhooks`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/webhooks/subscriptions` | `requireAuth`, `requireMerchant` | `squareWebhooks.listWebhookSubscriptions` | Y | — |
| GET | `/api/webhooks/subscriptions/audit` | `requireAuth`, `requireMerchant` | `squareWebhooks.auditWebhookConfiguration` | Y | — |
| GET | `/api/webhooks/event-types` | `requireAuth` _(no `requireMerchant`)_ | `squareWebhooks.WEBHOOK_EVENT_TYPES` (inline) | Y | ⚠️ Missing `requireMerchant` — low-risk metadata but inconsistent |
| POST | `/api/webhooks/register` | `requireAuth`, `requireMerchant`, `validators.register` | `squareWebhooks.createWebhookSubscription` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/webhooks/ensure` | `requireAuth`, `requireMerchant`, `validators.ensure` | `squareWebhooks.ensureWebhookSubscription` | Y | ⚠️ Missing `requireWriteAccess` |
| PUT | `/api/webhooks/subscriptions/:subscriptionId` | `requireAuth`, `requireMerchant`, `validators.update` | `squareWebhooks.updateWebhookSubscription` | Y | ⚠️ Missing `requireWriteAccess` |
| DELETE | `/api/webhooks/subscriptions/:subscriptionId` | `requireAuth`, `requireMerchant`, `validators.deleteSubscription` | `squareWebhooks.deleteWebhookSubscription` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/webhooks/subscriptions/:subscriptionId/test` | `requireAuth`, `requireMerchant`, `validators.test` | `squareWebhooks.testWebhookSubscription` | Y | — |
| POST | `/api/webhooks/square` | `webhookRateLimit` _(public — no auth)_ | `webhookProcessor.processWebhook` | Y | — |

---

#### `routes/admin.js` — mount: `/api/admin`; `gateApi('/admin', requirePermission('staff', 'admin'))` applied in server.js

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/admin/merchants` | `requireAuth`, `requireAdmin`, `validators.listMerchants` | inline DB | Y | — |
| POST | `/api/admin/merchants/:merchantId/extend-trial` | `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `requireMerchantAccess`, `validators.extendTrial` | inline DB | Y | — |
| POST | `/api/admin/merchants/:merchantId/deactivate` | `requireAuth`, `requireAdmin`, `requireMerchantAccess`, `validators.deactivateMerchant` | inline DB | Y | — |
| GET | `/api/admin/settings` | `requireAuth`, `requireAdmin`, `validators.listSettings` | `platformSettings.getAllSettings` | Y | — |
| PUT | `/api/admin/settings/:key` | `requireAuth`, `requireAdmin`, `validators.updateSetting` | `platformSettings.setSetting` | Y | — |
| POST | `/api/admin/test-email` | `requireAuth`, `requireAdmin`, `validators.testEmail` | `emailNotifier.testEmail` | Y | — |
| POST | `/api/admin/promo-codes` | `requireAuth`, `requireAdmin`, `validators.createPromoCode` | inline DB | Y | — |
| GET | `/api/admin/promo-codes` | `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `validators.listPromoCodes` | inline DB | Y | — |
| POST | `/api/admin/promo-codes/:id/deactivate` | `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `validators.deactivatePromoCode` | inline DB | Y | — |
| GET | `/api/admin/merchants/:merchantId/payments` | `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `validators.listMerchantPayments` | inline DB | Y | — |
| GET | `/api/admin/merchants/:merchantId/features` | `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `validators.getMerchantFeatures` | inline DB + `featureRegistry.getPaidModules` | Y | — |
| PUT | `/api/admin/merchants/:merchantId/features/:featureKey` | `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `validators.updateMerchantFeature` | inline DB | Y | — |
| POST | `/api/admin/merchants/:merchantId/activate` | `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `validators.activateMerchant` | inline DB | Y | — |

---

#### `routes/ai-autofill.js` — mount: `/api/ai-autofill` with `requireFeature('ai_tools')`, `requirePermission('ai_tools', 'read')`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/ai-autofill/api-key` | `requireAuth`, `requireMerchant`, `aiRateLimit` | `encryptToken` + DB upsert | Y | — |
| GET | `/api/ai-autofill/api-key/status` | `requireAuth`, `requireMerchant`, `aiRateLimit` | inline DB | Y | — |
| DELETE | `/api/ai-autofill/api-key` | `requireAuth`, `requireMerchant`, `aiRateLimit` | inline DB delete | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/ai-autofill/status` | `requireAuth`, `requireMerchant`, `aiRateLimit`, `validators.getStatus` | `aiAutofillService` (item readiness grouping) | Y | — |
| POST | `/api/ai-autofill/generate` | `requireAuth`, `requireMerchant`, `aiRateLimit`, `validators.generate` | `aiAutofillService.generateContent` | Y | — |
| POST | `/api/ai-autofill/apply` | `requireAuth`, `requireMerchant`, `aiRateLimit`, `validators.apply` | `batchUpdateCatalogContent` | Y | ⚠️ Missing `requireWriteAccess` — applies AI content to Square catalog |

---

#### `routes/bundles.js` — mount: `/api/bundles`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/bundles` | `requireAuth`, `requireMerchant`, `validators.getBundles` | `bundleService.listBundles` | Y | — |
| GET | `/api/bundles/availability` | `requireAuth`, `requireMerchant`, `validators.getAvailability` | `bundleService.calculateAvailability` | Y | — |
| POST | `/api/bundles` | `requireAuth`, `requireMerchant`, `validators.createBundle` | `bundleService.createBundle` | Y | ⚠️ Missing `requireWriteAccess` |
| PUT | `/api/bundles/:id` | `requireAuth`, `requireMerchant`, `validators.updateBundle` | `bundleService.updateBundle` | Y | ⚠️ Missing `requireWriteAccess` |
| DELETE | `/api/bundles/:id` | `requireAuth`, `requireMerchant`, `validators.deleteBundle` | `bundleService.deleteBundle` (soft-delete) | Y | ⚠️ Missing `requireWriteAccess` |

---

#### `routes/cart-activity.js` — mount: `/api/cart-activity` with `requireFeature('loyalty')`, `requirePermission('loyalty', 'read')`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/cart-activity` | `requireAuth`, `requireMerchant`, `validators.list` | `cartActivityService.getList` | Y | — |
| GET | `/api/cart-activity/stats` | `requireAuth`, `requireMerchant`, `validators.stats` | `cartActivityService.getStats` | Y | — |

---

#### `routes/catalog-location-health.js` — **NOT MOUNTED**

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/admin/catalog-location-health` | `requireAuth`, `requireAdmin`, `validators.getHealth` | inline DB | Y | 🚨 **Route file exists but is not mounted in `server.js`** — endpoints are unreachable |
| POST | `/api/admin/catalog-location-health/check` | `requireAuth`, `requireAdmin`, `validators.runCheck` | inline DB + health-check job | Y | 🚨 Same — not mounted |

---

#### `routes/driver-api.js` — mount: `/api`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/delivery/route/:id/share` | `deliveryRateLimit`, `requireAuth`, `requireMerchant`, `validators.shareRoute` | token generation + DB | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/delivery/route/:id/token` | `requireAuth`, `requireMerchant`, `validators.getRouteToken` | inline DB | Y | — |
| DELETE | `/api/delivery/route/:id/token` | `deliveryRateLimit`, `requireAuth`, `requireMerchant`, `validators.revokeRouteToken` | inline DB delete | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/driver/:token` | `deliveryRateLimit`, `validators.getDriverRoute` _(public — no auth)_ | inline DB (token lookup) | Y | — |
| POST | `/api/driver/:token/orders/:orderId/complete` | `deliveryRateLimit`, `validators.completeOrder` _(public — no auth)_ | `deliveryApi.completeOrder` | Y | — |
| POST | `/api/driver/:token/orders/:orderId/skip` | `deliveryRateLimit`, `validators.skipOrder` _(public — no auth)_ | `deliveryApi.skipOrder` | Y | — |
| POST | `/api/driver/:token/orders/:orderId/pod` | `deliveryStrictRateLimit`, `podUpload`, `validateUploadedImage` _(public — no auth)_ | `deliveryApi.savePodPhoto` | Y | — |
| POST | `/api/driver/:token/finish` | `deliveryRateLimit`, `validators.finishRoute` _(public — no auth)_ | `deliveryApi.finishRoute` | Y | — |

> Driver token endpoints (`/api/driver/:token/*`) are intentionally public — accessed via shared URL by the delivery driver without a login session; the token acts as a scoped credential.

---

#### `routes/expiry-discounts.js` — mount: `/api` with `gateApi('/expiry-discounts', requireFeature('expiry'), requirePermission('expiry', 'read'))`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/expiry-discounts/status` | `requireAuth`, `requireMerchant` | inline DB | Y | — |
| GET | `/api/expiry-discounts/tiers` | `requireAuth`, `requireMerchant` | inline DB | Y | — |
| PATCH | `/api/expiry-discounts/tiers/:id` | `requireAuth`, `requireMerchant`, `validators.updateTier` | inline DB | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/expiry-discounts/variations` | `requireAuth`, `requireMerchant`, `validators.getVariations` | inline DB | Y | — |
| POST | `/api/expiry-discounts/evaluate` | `requireAuth`, `requireMerchant`, `validators.evaluate` | `expiryDiscountService.evaluate` | Y | — |
| POST | `/api/expiry-discounts/apply` | `requireAuth`, `requireMerchant`, `validators.apply` | `expiryDiscountService.applyDiscounts` | Y | ⚠️ Missing `requireWriteAccess` — applies discounts to Square catalog |
| POST | `/api/expiry-discounts/run` | `requireAuth`, `requireMerchant`, `validators.run` | `expiryDiscountService.runFull` | Y | ⚠️ Missing `requireWriteAccess` — full Square discount run |
| POST | `/api/expiry-discounts/init-square` | `requireAuth`, `requireMerchant` | `expiryDiscountService.initSquare` | Y | ⚠️ Missing `requireWriteAccess` — creates Square discount objects |
| GET | `/api/expiry-discounts/audit-log` | `requireAuth`, `requireMerchant`, `validators.getAuditLog` | inline DB | Y | — |
| GET | `/api/expiry-discounts/settings` | `requireAuth`, `requireMerchant` | inline DB | Y | — |
| PATCH | `/api/expiry-discounts/settings` | `requireAuth`, `requireMerchant`, `validators.updateSettings` | inline DB | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/expiry-discounts/validate` | `requireAuth`, `requireMerchant` | `expiryDiscountService.validate` | Y | — |
| POST | `/api/expiry-discounts/validate-and-fix` | `requireAuth`, `requireMerchant`, `requireWriteAccess` | `expiryDiscountService.validateAndFix` | Y | — |
| GET | `/api/expiry-discounts/flagged` | `requireAuth`, `requireMerchant` | inline DB | Y | — |
| POST | `/api/expiry-discounts/flagged/resolve` | `requireAuth`, `requireMerchant`, `requireWriteAccess` | inline DB | Y | — |
| PATCH | `/api/expiry-discounts/variations/:variationId/quantity` | `requireAuth`, `requireMerchant`, `requireWriteAccess` | inline DB | Y | — |

---

#### `routes/gmc/` — mount: `/api/gmc` with `requireFeature('gmc')`, `requirePermission('gmc', 'read')` (feed.tsv and local-inventory-feed.tsv are public)

**routes/gmc/feed.js:**

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/gmc/feed` | `requireAuth`, `requireMerchant`, `validators.getFeed` | `gmcFeedService.getFeed` | Y | — |
| GET | `/api/gmc/feed.tsv` | _(public — no auth; token-based access)_ | `gmcFeedService.getPublicFeed` | Y | — |
| GET | `/api/gmc/feed-url` | `requireAuth`, `requireMerchant` | inline token lookup | Y | — |
| POST | `/api/gmc/regenerate-token` | `sensitiveOperationRateLimit`, `requireAuth`, `requireMerchant`, `requireWriteAccess` | inline token regeneration | Y | — |
| GET | `/api/gmc/local-inventory-feed-url` | `requireAuth`, `requireMerchant` | inline | Y | — |
| GET | `/api/gmc/local-inventory-feed` | `requireAuth`, `requireMerchant`, `validators.getLocalInventoryFeed` | `gmcFeedService.getLocalInventoryFeed` | Y | — |
| GET | `/api/gmc/local-inventory-feed.tsv` | _(public — no auth; token-based access)_ | `gmcFeedService.getPublicLocalInventoryFeed` | Y | — |

**routes/gmc/brands.js:**

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/gmc/brands` | `requireAuth`, `requireMerchant` | `brandService.listBrands` | Y | — |
| POST | `/api/gmc/brands/import` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.importBrands` | `brandService.importBrands` | Y | — |
| POST | `/api/gmc/brands` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.createBrand` | `brandService.createBrand` | Y | — |
| PUT | `/api/gmc/items/:itemId/brand` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.assignItemBrand` | `brandService.assignItemBrand` | Y | — |
| POST | `/api/gmc/brands/auto-detect` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.autoDetectBrands` | `brandService.autoDetectBrands` | Y | — |
| POST | `/api/gmc/brands/bulk-assign` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.bulkAssignBrands` | `brandService.bulkAssignBrands` | Y | — |

**routes/gmc/taxonomy.js:**

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/gmc/taxonomy` | `requireAuth`, `validators.listTaxonomy` _(no `requireMerchant`)_ | inline DB | Y | ⚠️ Missing `requireMerchant` — taxonomy is global but pattern inconsistency |
| POST | `/api/gmc/taxonomy/import` | `requireAdmin`, `validators.importTaxonomy` | inline CSV import | Y | — |
| GET | `/api/gmc/taxonomy/fetch-google` | `requireAdmin` | external fetch from Google taxonomy URL | Y | — |
| PUT | `/api/gmc/categories/:categoryId/taxonomy` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.mapCategoryTaxonomy` | inline DB | Y | — |
| DELETE | `/api/gmc/categories/:categoryId/taxonomy` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.deleteCategoryTaxonomy` | inline DB | Y | — |
| GET | `/api/gmc/category-mappings` | `requireAuth`, `requireMerchant` | inline DB | Y | — |
| PUT | `/api/gmc/category-taxonomy` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.mapCategoryTaxonomyByName` | inline DB | Y | — |
| DELETE | `/api/gmc/category-taxonomy` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.deleteCategoryTaxonomyByName` | inline DB | Y | — |

**routes/gmc/settings.js:**

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/gmc/settings` | `requireAuth`, `requireMerchant` | `gmcSettingsService.getSettings` | Y | — |
| PUT | `/api/gmc/settings` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.updateSettings` | `gmcSettingsService.updateSettings` | Y | — |
| GET | `/api/gmc/location-settings` | `requireAuth`, `requireMerchant` | inline DB | Y | — |
| PUT | `/api/gmc/location-settings/:locationId` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.updateLocationSettings` | inline DB | Y | — |
| GET | `/api/gmc/api-settings` | `requireAuth`, `requireMerchant` | inline DB | Y | — |
| PUT | `/api/gmc/api-settings` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.updateApiSettings` | inline DB | Y | — |
| POST | `/api/gmc/api/test-connection` | `requireAuth`, `requireMerchant` | `gmcService.testConnection` | Y | — |
| GET | `/api/gmc/api/data-source-info` | `requireAuth`, `requireMerchant` | `gmcService.getDataSourceInfo` | Y | — |
| POST | `/api/gmc/api/sync-products` | `requireAuth`, `requireMerchant`, `requireWriteAccess` | `gmcService.syncProducts` | Y | — |
| GET | `/api/gmc/api/sync-status` | `requireAuth`, `requireMerchant` | `gmcService.getSyncStatus` | Y | — |
| GET | `/api/gmc/api/sync-history` | `requireAuth`, `requireMerchant`, `validators.getSyncHistory` | `gmcService.getSyncHistory` | Y | — |
| POST | `/api/gmc/api/register-developer` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.registerDeveloper` | `gmcService.registerDeveloper` | Y | — |

---

#### `routes/google-oauth.js` — mount: `/api` with `gateApi('/google', requireFeature('gmc'), requirePermission('gmc', 'read'))`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/google/status` | `requireAuth`, `requireMerchant`, `validators.status` | inline DB token check | Y | — |
| GET | `/api/google/auth` | `requireAuth`, `requireMerchant`, `validators.auth` | Google OAuth URL generation | Y | — |
| GET | `/api/google/callback` | `validators.callback` _(public — OAuth redirect)_ | token exchange + DB storage | Y | — |
| POST | `/api/google/disconnect` | `requireAuth`, `requireMerchant`, `validators.disconnect` | inline DB token delete | Y | ⚠️ Missing `requireWriteAccess` |

---

#### `routes/labels.js` — mount: `/api` with `gateApi('/labels', requireFeature('reorder'), requirePermission('reorder', 'read'))`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/labels/generate` | `requireAuth`, `requireMerchant`, `validators.generateLabels` | `labelService.generateLabels` (PDF) | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/labels/generate-with-prices` | `requireAuth`, `requireMerchant`, `validators.generateWithPrices` | `labelService.generateLabelsWithPrices` (PDF) | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/labels/templates` | `requireAuth`, `requireMerchant`, `validators.getTemplates` | `labelService.getTemplates` | Y | — |
| PUT | `/api/labels/templates/:id/default` | `requireAuth`, `requireMerchant`, `validators.setDefault` | `labelService.setDefaultTemplate` | Y | ⚠️ Missing `requireWriteAccess` |

---

#### `routes/min-max-suppression-routes.js` — mount: `/api` with `gateApi` on `/min-max/suppressed`, `/min-max/audit-log`, `/min-max/toggle-pin`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/min-max/suppressed` | `requireAuth`, `requireMerchant`, `validators.getSuppressed` | `autoMinMax.getSuppressedVariations` | Y | — |
| GET | `/api/min-max/audit-log` | `requireAuth`, `requireMerchant`, `validators.getAuditLog` | `autoMinMax.getAuditLog` | Y | — |
| POST | `/api/min-max/toggle-pin` | `requireAuth`, `requireMerchant`, `requireWriteAccess`, `validators.togglePin` | `autoMinMax.togglePin` | Y | — |

---

#### `routes/settings.js` — mount: `/api` with `gateApi('/settings', requirePermission('base', 'admin'))`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/settings/merchant` | `requireAuth`, `requireMerchant`, `validators.get` | `merchantSettingsService.getSettings` | Y | — |
| PUT | `/api/settings/merchant` | `requireAuth`, `requireMerchant`, `validators.update` | `merchantSettingsService.updateSettings` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/settings/merchant/defaults` | `requireAuth`, `validators.defaults` _(no `requireMerchant`)_ | `merchantSettingsService.getDefaults` | Y | ⚠️ Missing `requireMerchant` |

---

#### `routes/square-oauth.js` — mount: `/api/square/oauth`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/square/oauth/connect` | `requireAuth` | Square OAuth URL generation | Y | — |
| GET | `/api/square/oauth/callback` | _(public — OAuth redirect)_ | token exchange + DB storage | Y | — |
| POST | `/api/square/oauth/revoke` | `requireAuth`, `loadMerchantContext`, `requireMerchant`, `requireMerchantRole('owner')` | token revocation | Y | — |
| POST | `/api/square/oauth/refresh` | `requireAuth`, `requireAdmin` | token refresh (admin triggered) | Y | — |

---

#### `routes/staff.js` — mount: `/api/staff` with `gateApi('/staff', requirePermission('staff', 'read'))`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/staff` | `requireAuth`, `requireMerchant`, `requirePermission('staff', 'read')` | `staffService.listStaff` | Y | — |
| POST | `/api/staff/invite` | `requireAuth`, `requireMerchant`, `requirePermission('staff', 'admin')`, `validators.inviteStaff` | `staffService.inviteStaff` | Y | — |
| GET | `/api/staff/validate-token` | `validators.validateTokenQuery` _(public)_ | `staffService.validateToken` | Y | — |
| POST | `/api/staff/accept` | `validators.acceptInvitation` _(public)_ | `staffService.acceptInvitation` | Y | — |
| DELETE | `/api/staff/invitations/:id` | `requireAuth`, `requireMerchant`, `requirePermission('staff', 'admin')`, `validators.cancelInvitation` | `staffService.cancelInvitation` | Y | — |
| DELETE | `/api/staff/:userId` | `requireAuth`, `requireMerchant`, `requirePermission('staff', 'admin')`, `validators.removeStaff` | `staffService.removeStaff` | Y | — |
| PATCH | `/api/staff/:userId/role` | `requireAuth`, `requireMerchant`, `requirePermission('staff', 'admin')`, `validators.changeRole` | `staffService.changeRole` | Y | — |

---

#### `routes/sync.js` — mount: `/api`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| POST | `/api/sync` | `requireAuth`, `requireMerchant`, `validators.sync` | `syncService.runFullSync` | Y | ⚠️ Missing `requireWriteAccess` — triggers full Square catalog sync |
| POST | `/api/sync-sales` | `requireAuth`, `requireMerchant`, `validators.syncSales` | `syncService.syncSales` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/sync-smart` | `requireAuth`, `requireMerchant`, `validators.syncSmart` | `syncService.runSmartSync` | Y | ⚠️ Missing `requireWriteAccess` |
| GET | `/api/sync-history` | `requireAuth`, `requireMerchant`, `validators.syncHistory` | `syncService.getSyncHistory` | Y | — |
| GET | `/api/sync-intervals` | `requireAuth`, `validators.syncIntervals` _(no `requireMerchant`)_ | `syncService.getSyncIntervals` | Y | ⚠️ Missing `requireMerchant` |
| GET | `/api/sync-status` | `requireAuth`, `requireMerchant`, `validators.syncStatus` | `syncService.getSyncStatus` | Y | — |

---

#### `routes/vendor-match-suggestions.js` — mount: `/api/vendor-match-suggestions`

| Method | Path | Middleware chain (route-level) | Handler | Test | Flags |
|--------|------|-------------------------------|---------|------|-------|
| GET | `/api/vendor-match-suggestions/count` | `requireAuth`, `requireMerchant` | `vendorMatchService.getCount` | Y | — |
| GET | `/api/vendor-match-suggestions` | `requireAuth`, `requireMerchant`, `validators.listSuggestions` | `vendorMatchService.listSuggestions` | Y | — |
| POST | `/api/vendor-match-suggestions/bulk-approve` | `requireAuth`, `requireMerchant`, `validators.bulkApprove` | `vendorMatchService.bulkApprove` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/vendor-match-suggestions/backfill` | `requireAuth`, `requireMerchant` | `vendorMatchService.backfill` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/vendor-match-suggestions/:id/approve` | `requireAuth`, `requireMerchant`, `validators.approveOrReject` | `vendorMatchService.approve` | Y | ⚠️ Missing `requireWriteAccess` |
| POST | `/api/vendor-match-suggestions/:id/reject` | `requireAuth`, `requireMerchant`, `validators.approveOrReject` | `vendorMatchService.reject` | Y | ⚠️ Missing `requireWriteAccess` |

---

**Group 6 flag summary:**

| # | Severity | Route | Issue |
|---|----------|-------|-------|
| 1 | CRITICAL | `routes/catalog-location-health.js` | File exists and is tested but is **never mounted** in `server.js` — both endpoints are unreachable |
| 2 | HIGH | All POST/PUT/DELETE in `routes/square-attributes.js` | No `requireWriteAccess` on any write endpoint — init, create/delete definitions, update values, and bulk push operations are all accessible to read-only users |
| 3 | MEDIUM | `POST /api/sync`, `POST /api/sync-sales`, `POST /api/sync-smart` | Missing `requireWriteAccess` — read-only users can trigger full Square catalog syncs |
| 4 | MEDIUM | `POST /api/webhooks/register`, `POST /api/webhooks/ensure`, `PUT /api/webhooks/subscriptions/:id`, `DELETE /api/webhooks/subscriptions/:id` | Missing `requireWriteAccess` |
| 5 | MEDIUM | `POST /api/vendor-match-suggestions/bulk-approve`, `/backfill`, `/:id/approve`, `/:id/reject` | Missing `requireWriteAccess` |
| 6 | MEDIUM | `POST /api/expiry-discounts/apply`, `/run`, `/init-square`, `PATCH .../tiers/:id`, `PATCH .../settings` | Missing `requireWriteAccess` |
| 7 | MEDIUM | `POST /api/bundles`, `PUT /api/bundles/:id`, `DELETE /api/bundles/:id` | Missing `requireWriteAccess` |
| 8 | MEDIUM | `PUT /api/settings/merchant` | Missing `requireWriteAccess` |
| 9 | MEDIUM | `POST /api/ai-autofill/apply`, `DELETE /api/ai-autofill/api-key` | Missing `requireWriteAccess` |
| 10 | MEDIUM | `POST /api/labels/generate`, `/generate-with-prices`, `PUT .../templates/:id/default` | Missing `requireWriteAccess` |
| 11 | LOW | `GET /api/webhooks/event-types` | Missing `requireMerchant` — read-only metadata, low risk |
| 12 | LOW | `GET /api/gmc/taxonomy` | Missing `requireMerchant` — global taxonomy data, low risk |
| 13 | LOW | `GET /api/settings/merchant/defaults`, `GET /api/sync-intervals` | Missing `requireMerchant` |
| 14 | LOW | `POST /api/google/disconnect` | Missing `requireWriteAccess` |

---

## Middleware Summary

All middleware files in `middleware/`:

| File | Purpose |
|------|---------|
| `auth.js` | Session authentication (`requireAuth`), role checks (`requireAdmin`), write-access enforcement (`requireWriteAccess`), auth event logging |
| `merchant.js` | Loads merchant context from session into `req.merchantContext` (`loadMerchantContext`), enforces merchant presence (`requireMerchant`), role-within-merchant checks (`requireMerchantRole`) |
| `feature-gate.js` | `requireFeature(key)` — blocks access if merchant does not have the named paid module enabled |
| `require-permission.js` | `requirePermission(module, action)` — enforces per-module RBAC (read/write/admin) from `merchant_permissions` or role-derived defaults |
| `require-active-subscription.js` | Write-locks expired/suspended merchants; GET requests pass through |
| `require-super-admin.js` | Guards platform-level destructive actions; checks `SUPER_ADMIN_EMAILS` env var |
| `merchant-access.js` | `requireMerchantAccess` — verifies admin user has a `user_merchants` row for the `:merchantId` param (Audit 2.6.1) |
| `async-handler.js` | Wraps async route handlers so thrown errors are forwarded to Express error handler |
| `security.js` | Configures rate limiters (`loginRateLimit`, `deliveryRateLimit`, `deliveryStrictRateLimit`, `webhookRateLimit`, `aiRateLimit`, `sensitiveOperationRateLimit`, etc.), security headers (helmet), CORS |
| `request-id.js` | Attaches a UUID `requestId` to every request for log correlation |
| `request-source.js` | Sets `req.isAutomated = true` when `x-request-source: automation` header is present; distinguishes cron/agent callers from human sessions |
| `validators/` (directory) | Per-route `express-validator` chains; one file per route module; imported as `validators` in route handlers |

---

## Section 3 — Test Coverage Map

> **Scope:** Cross-references `__tests__/` against `docs/DOMAIN-MAP.md` and the routes documented in Section 2. Test counts reflect `it()` / `test()` call totals per file. "Test" column values in Section 2 tables (`Y` / `N`) are the baseline; discrepancies noted below. Test file counts cover both route-level and service-level files for each domain. Some service test files are shared across domains (noted where applicable).

---

### Group 1 — Auth, Subscriptions, Catalog, Inventory

#### Auth

**Section 2 location:** Group 1 — `routes/auth/session.js`, `routes/auth/password.js`, `routes/auth/users.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/auth.test.js` | 55 |
| `__tests__/services/auth/account-service.test.js` | 24 |
| `__tests__/services/auth/password-service.test.js` | 17 |
| `__tests__/services/auth/session-service.test.js` | 13 |
| **Total** | **109** |

**Routes with tests:** All 12 routes across `session.js`, `password.js`, and `users.js` are marked Y in Section 2.

**Routes with NO tests:** None.

**Untested flows:** None. Login, logout, session introspection, password change/reset/forgot, token verification, and all user management operations (create, update, reset, unlock) have route-level and service-level coverage.

---

#### Subscriptions

**Section 2 location:** Group 1 — `routes/subscriptions/plans.js`, `routes/subscriptions/merchant.js`, `routes/subscriptions/admin.js`, `routes/subscriptions/public.js`, `routes/subscriptions/webhooks.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/subscriptions.test.js` | 57 |
| `__tests__/routes/subscription-admin-auth.test.js` | 6 |
| `__tests__/routes/subscription-rate-limit.test.js` | 7 |
| `__tests__/routes/subscription-status-security.test.js` | 6 |
| `__tests__/routes/subscription-tenant-isolation.test.js` | 13 |
| `__tests__/routes/subscriptions-untested-endpoints.test.js` | 23 |
| `__tests__/routes/oauth-trial.test.js` | 3 |
| `__tests__/services/subscription-bridge.test.js` | 19 |
| `__tests__/services/promo-validation.test.js` | 15 |
| `__tests__/services/subscriptions/subscription-create-service.test.js` | 19 |
| `__tests__/integration/subscription-lifecycle.test.js` | 20 |
| **Total** | **188** |

**Routes with tests:** 16 of 17 routes were marked Y in Section 2 at audit time.

**Routes originally flagged N:** `GET /api/webhooks/events` (`routes/subscriptions/webhooks.js`) was marked N (Section 2 Group 1 flag #3). **Reconciliation:** `__tests__/routes/subscriptions-untested-endpoints.test.js` line 330 contains `describe('GET /webhooks/events — query building')`, which covers this endpoint. The gap identified in Section 2 has since been closed; all 17 routes now have tests.

**Untested flows:** None after reconciliation.

---

#### Merchants

**Section 2 location:** Group 1 — `routes/merchants.js`

> Note: `routes/settings.js` and `routes/admin.js` are in the Merchant domain per DOMAIN-MAP.md; admin and settings routes are covered in Group 4.

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/merchants.test.js` | 9 |
| `__tests__/routes/merchant-features.test.js` | 16 |
| `__tests__/routes/settings.test.js` | 6 |
| `__tests__/services/platform-settings.test.js` | 10 |
| **Total** | **41** |

**Routes with tests:** All 4 routes in `routes/merchants.js` marked Y.

**Routes with NO tests:** None.

**Untested flows:** None for the core merchant endpoints (list, switch, context, config). `GET /api/merchant/features` is an inline `server.js` handler not documented in Section 2 route tables; it is exercised indirectly via `merchant-features.test.js` feature-gate logic.

---

#### Catalog

**Section 2 location:** Group 2 — `routes/catalog.js`, `routes/catalog-health.js`, `routes/catalog-location-health.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/catalog.test.js` | 56 |
| `__tests__/routes/catalog-health.test.js` | 4 |
| `__tests__/routes/catalog-location-health.test.js` | 4 |
| `__tests__/routes/catalog-write-access.test.js` | 3 |
| `__tests__/services/catalog/audit-service.test.js` | 11 |
| `__tests__/services/catalog/expired-pull.test.js` | 10 |
| `__tests__/services/catalog/inventory-service.test.js` | 54 |
| `__tests__/services/catalog/item-service.test.js` | 14 |
| `__tests__/services/catalog/location-health-service.test.js` | 11 |
| `__tests__/services/catalog/reorder-math.test.js` | 41 |
| `__tests__/services/catalog/reorder-service.test.js` | 44 |
| `__tests__/services/catalog/save-expirations-reviewed.test.js` | 7 |
| `__tests__/services/catalog/variation-service.test.js` | 75 |
| `__tests__/services/catalog-audit-service.test.js` | 11 |
| `__tests__/services/catalog-health-service.test.js` | 52 |
| `__tests__/services/catalog-handler-vendor-race.test.js` | 4 |
| **Total** | **401** |

> `reorder-math.test.js` and `reorder-service.test.js` are also counted under Reorder in Group 2 (shared service files).

**Routes with tests:** All 20 routes in `catalog.js` and both routes in `catalog-health.js` marked Y. Both routes in `catalog-location-health.js` also marked Y.

**Routes with NO tests:** None.

**Untested flows:** `routes/catalog-location-health.js` is **never mounted in `server.js`** (Section 2 CRITICAL flag). Handler unit tests exist (`catalog-location-health.test.js`) but both endpoints are unreachable via HTTP in production — no integration path through the HTTP layer can be exercised.

---

#### Inventory

**Section 2 location:** Groups 3 and 6 — `routes/cycle-counts.js`, `routes/min-max-suppression-routes.js`

> `routes/analytics.js` exposes additional min-max endpoints (`GET /api/min-max/recommendations`, `POST /api/min-max/apply`, `GET /api/min-max/history`, `POST /api/min-max/pin`) — those are counted under Reorder in Group 2 since they share the analytics route file.

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/cycle-counts.test.js` | 27 |
| `__tests__/services/inventory/auto-min-max-service.test.js` | 88 |
| `__tests__/services/inventory/auto-min-max-square-sync.test.js` | 11 |
| `__tests__/services/inventory/cycle-count-service.test.js` | 14 |
| **Total** | **140** |

**Routes with tests:** All 9 routes in `cycle-counts.js` and all 3 routes in `min-max-suppression-routes.js` marked Y.

**Routes with NO tests:** None.

**Untested flows:** None.

---

### Group 2 — Purchasing, Counts, Vendors

#### Purchase Orders

**Section 2 location:** Group 3 — `routes/purchase-orders.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/purchase-orders.test.js` | 34 |
| `__tests__/services/purchase-orders/po-service.test.js` | 39 |
| `__tests__/services/purchase-orders/po-receive-service.test.js` | 18 |
| `__tests__/services/purchase-orders/po-export-service.test.js` | 36 |
| **Total** | **127** |

**Routes with tests:** All 9 routes marked Y in Section 2 Group 3.

**Routes with NO tests:** None.

**Untested flows:** None.

---

#### Cycle Counts

Covered in full under **Inventory** in Group 1 (`routes/cycle-counts.js`, `routes/min-max-suppression-routes.js`, `services/inventory/`). Total: **140 tests across 4 files.** All 12 routes marked Y. No gaps.

---

#### Reorder

**Section 2 location:** Group 6 — `routes/analytics.js` (reorder suggestions, sales-velocity, and min-max recommendation/apply/history/pin endpoints). Core reorder services are in `services/catalog/`.

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/analytics.test.js` | 47 |
| `__tests__/services/catalog/reorder-service.test.js` | 44 |
| `__tests__/services/catalog/reorder-math.test.js` | 41 |
| `__tests__/services/reorder/checkbox-defaults-service.test.js` | 26 |
| `__tests__/jobs/auto-min-max-job.test.js` | 23 |
| **Total** | **181** |

> `reorder-service.test.js` and `reorder-math.test.js` are also counted under Catalog in Group 1 (shared service files).

**Routes with tests:** All 6 routes in `analytics.js` (`GET /api/sales-velocity`, `GET /api/reorder-suggestions`, `GET /api/min-max/recommendations`, `POST /api/min-max/apply`, `GET /api/min-max/history`, `POST /api/min-max/pin`) marked Y.

**Routes with NO tests:** None.

**Untested flows:** None.

---

#### Vendors

**Section 2 location:** Group 5 — `routes/vendor-catalog/vendors.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/vendor-dashboard.test.js` | 14 |
| `__tests__/routes/vendor-catalog-merchant-taxes.test.js` | 5 |
| `__tests__/services/vendor-dashboard.test.js` | 41 |
| `__tests__/services/vendor/vendor-query-service.test.js` | 15 |
| `__tests__/services/ensure-vendors-exist.test.js` | 7 |
| **Total** | **82** |

**Routes with tests:** All 4 routes in `vendor-catalog/vendors.js` (`GET /api/vendors`, `GET /api/vendor-dashboard`, `PATCH /api/vendors/:id/settings`, `GET /api/vendor-catalog/merchant-taxes`) marked Y.

**Routes with NO tests:** None.

**Untested flows:** None.

---

#### Vendor Catalog

**Section 2 location:** Groups 5 and 6 — `routes/vendor-catalog/import.js`, `routes/vendor-catalog/lookup.js`, `routes/vendor-catalog/manage.js`, `routes/vendor-match-suggestions.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/vendor-catalog.test.js` | 58 |
| `__tests__/routes/vendor-catalog-create.test.js` | 15 |
| `__tests__/routes/vendor-match-suggestions.test.js` | 20 |
| `__tests__/services/vendor/catalog-service.test.js` | 94 |
| `__tests__/services/vendor/catalog-create-service.test.js` | 34 |
| `__tests__/services/vendor/lead-time-service.test.js` | 15 |
| `__tests__/services/vendor/match-suggestions-service.test.js` | 27 |
| `__tests__/services/sync-variation-vendor-guard.test.js` | 7 |
| `__tests__/utils/vendor-catalog.test.js` | 7 |
| **Total** | **277** |

**Routes with tests:** All 16 routes across `import.js`, `lookup.js`, and `manage.js`, and all 6 routes in `vendor-match-suggestions.js`, marked Y.

**Routes with NO tests:** None.

**Untested flows:** None.

---

### Group 3 — Loyalty, Seniors, Delivery

#### Loyalty

**Section 2 location:** Group 4 — `routes/loyalty/` (10 sub-modules: `offers.js`, `variations.js`, `customers.js`, `rewards.js`, `square-integration.js`, `processing.js`, `audit.js`, `reports.js`, `settings.js`, `discounts.js`)

Route-level tests:

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/loyalty.test.js` | 48 |
| `__tests__/routes/loyalty-routes-gap.test.js` | 59 |
| `__tests__/routes/loyalty-square-integration.test.js` | 27 |
| **Route subtotal** | **134** |

Service-level tests (`__tests__/services/loyalty-admin/` — 53 files, total 817 tests):

| Notable Files | Tests |
|---------------|-------|
| `reward-service.test.js` | 60 |
| `square-discount-service.test.js` | 53 |
| `discount-validation-service.test.js` | 40 |
| `order-history-audit-service.test.js` | 39 |
| `order-intake.test.js` | 34 |
| `refund-service.test.js` | 31 |
| `customer-identification-service.test.js` | 28 |
| `square-api-client.test.js` | 27 |
| `customer-cache-service.test.js` | 27 |
| _(48 additional files)_ | _(481)_ |
| **Service subtotal** | **817** |

Additional loyalty-adjacent files:

| Test File | Tests |
|-----------|-------|
| `__tests__/services/loyalty-reports.test.js` | 16 |
| `__tests__/services/reports/brand-redemption-report.test.js` | 41 |
| `__tests__/utils/loyalty-free-items.test.js` | 21 |
| `__tests__/utils/loyalty-logger.test.js` | 20 |
| `__tests__/tools/loyalty-square-orphan-audit.test.js` | 13 |
| **Subtotal** | **111** |

**Total: 1,062 tests across 61 files.**

**Routes with tests:** All 47 routes across the 10 loyalty sub-modules marked Y.

**Routes with NO tests:** None.

**Untested flows:** None. Loyalty is the most test-dense domain in the codebase, with dedicated test files covering offers, variations, customers, rewards, Square integration, order processing, backfill, audit, reports, settings, and discount validation.

---

#### Seniors

**Section 2 location:** Group 4 — `routes/seniors.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/seniors.test.js` | 25 |
| `__tests__/services/seniors/age-calculator.test.js` | 34 |
| `__tests__/services/seniors-service.test.js` | 13 |
| `__tests__/jobs/seniors-day-job.test.js` | 17 |
| **Total** | **89** |

**Routes with tests:** All 6 routes in `seniors.js` (`GET /api/seniors/status`, `POST /api/seniors/setup`, `GET /api/seniors/config`, `PATCH /api/seniors/config`, `GET /api/seniors/members`, `GET /api/seniors/audit-log`) marked Y.

**Routes with NO tests:** None.

**Untested flows:** None.

---

#### Delivery

**Section 2 location:** Groups 5 and 6 — `routes/delivery/orders.js`, `routes/delivery/pod.js`, `routes/delivery/routes.js`, `routes/delivery/settings.js`, `routes/delivery/sync.js`, `routes/driver-api.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/delivery.test.js` | 39 |
| `__tests__/routes/delivery-completion.test.js` | 15 |
| `__tests__/routes/delivery-rate-limiting.test.js` | 1 |
| `__tests__/routes/driver-api.test.js` | 13 |
| `__tests__/services/delivery/delivery-fulfillment.test.js` | 8 |
| `__tests__/services/delivery/delivery-geocoding.test.js` | 8 |
| `__tests__/services/delivery/delivery-orders.test.js` | 4 |
| `__tests__/services/delivery/delivery-routes.test.js` | 5 |
| `__tests__/services/delivery/delivery-service.test.js` | 74 |
| `__tests__/services/delivery/delivery-settings.test.js` | 3 |
| `__tests__/services/delivery/delivery-sync.test.js` | 8 |
| `__tests__/services/delivery/order-lifecycle.test.js` | 58 |
| `__tests__/services/delivery-dedup.test.js` | 10 |
| `__tests__/services/delivery-stats.test.js` | 30 |
| `__tests__/services/delivery-ors-encryption.test.js` | 6 |
| `__tests__/services/delivery-pod-path-traversal.test.js` | 4 |
| `__tests__/jobs/delivery-auto-finish-job.test.js` | 13 |
| `__tests__/jobs/pod-cleanup-job.test.js` | 6 |
| **Total** | **305** |

**Routes with tests:** All 32 routes across the five delivery sub-modules and `driver-api.js` marked Y.

**Routes with NO tests:** None.

**Untested flows:** `delivery-rate-limiting.test.js` contains only 1 test — rate-limit enforcement on delivery write routes has minimal dedicated coverage. This aligns with the Section 2 HIGH flag that all delivery write routes lack `requireWriteAccess`; neither the access control gap nor the rate-limit behaviour has meaningful test depth.

---

### Group 4 — Remaining Domains & Summary

Covers all route files not addressed in Groups 1–3, followed by the overall summary table.

---

#### Square Integration (square-attributes, square-oauth, google-oauth, sync)

**Section 2 location:** Groups 5 and 6 — `routes/square-attributes.js`, `routes/square-oauth.js`, `routes/google-oauth.js`, `routes/sync.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/square-attributes.test.js` | 15 |
| `__tests__/routes/square-oauth.test.js` | 17 |
| `__tests__/routes/google-oauth.test.js` | 10 |
| `__tests__/routes/sync.test.js` | 24 |
| `__tests__/services/square/api.test.js` | 2 |
| `__tests__/services/square/inventory-receive-sync.test.js` | 20 |
| `__tests__/services/square/square-catalog-sync.test.js` | 47 |
| `__tests__/services/square/square-client.test.js` | 29 |
| `__tests__/services/square/square-custom-attributes.test.js` | 57 |
| `__tests__/services/square/square-diagnostics.test.js` | 37 |
| `__tests__/services/square/square-inventory.test.js` | 46 |
| `__tests__/services/square/square-location-preflight.test.js` | 29 |
| `__tests__/services/square/square-locations.test.js` | 7 |
| `__tests__/services/square/square-pricing.test.js` | 39 |
| `__tests__/services/square/square-sync-orchestrator.test.js` | 6 |
| `__tests__/services/square/square-velocity.test.js` | 48 |
| `__tests__/services/square/square-vendors.test.js` | 27 |
| `__tests__/services/square/sync-orchestrator.test.js` | 17 |
| `__tests__/services/square/with-location-repair.test.js` | 9 |
| `__tests__/services/sync-queue.test.js` | 19 |
| `__tests__/services/sold-out-sync.test.js` | 9 |
| `__tests__/services/velocity-fixes.test.js` | 7 |
| `__tests__/services/velocity-handler-dedup.test.js` | 8 |
| `__tests__/services/velocity-idempotency.test.js` | 5 |
| **Total** | **538** |

**Routes with tests:** All 23 routes across the four route files marked Y.

**Routes with NO tests:** None.

**Untested flows:** None.

---

#### Analytics

Analytics/reorder routes (`routes/analytics.js`) are covered under **Reorder** in Group 2. Total: 181 tests, all 6 routes marked Y. See Group 2.

---

#### Logs

**Section 2 location:** Group 6 — `routes/logs.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/logs.test.js` | 19 |
| **Total** | **19** |

**Routes with tests:** All 5 routes marked Y.

**Routes with NO tests:** None.

---

#### Webhooks

**Section 2 location:** Group 6 — `routes/webhooks.js`, `routes/webhooks/square.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/webhooks.test.js` | 11 |
| `__tests__/services/webhook-handlers/catalog-handler.test.js` | 57 |
| `__tests__/services/webhook-handlers/customer-handler.test.js` | 16 |
| `__tests__/services/webhook-handlers/inventory-handler.test.js` | 40 |
| `__tests__/services/webhook-handlers/loyalty-handler.test.js` | 44 |
| `__tests__/services/webhook-handlers/oauth-handler.test.js` | 4 |
| `__tests__/services/webhook-handlers/order-delivery.test.js` | 43 |
| `__tests__/services/webhook-handlers/order-loyalty.test.js` | 23 |
| `__tests__/services/webhook-handlers/subscription-handler.test.js` | 29 |
| `__tests__/services/webhook-handlers/order-handler/order-cart.test.js` | 8 |
| `__tests__/services/webhook-handlers/order-handler/order-normalize.test.js` | 12 |
| `__tests__/services/webhook-handlers/order-handler/order-velocity.test.js` | 11 |
| `__tests__/services/webhook-handlers.test.js` | 21 |
| `__tests__/services/webhook-processor.test.js` | 30 |
| `__tests__/services/webhook-subscription-bridge.test.js` | 10 |
| `__tests__/services/order-handler.test.js` | 68 |
| `__tests__/services/invoice-handlers.test.js` | 17 |
| `__tests__/services/catchup-dedup.test.js` | 6 |
| `__tests__/services/order-processing-cache.test.js` | 5 |
| `__tests__/services/payment-customer-dedup.test.js` | 3 |
| **Total** | **458** |

**Routes with tests:** All 9 routes (`GET /api/webhooks/subscriptions`, `GET .../audit`, `GET .../event-types`, `POST .../register`, `POST .../ensure`, `PUT .../subscriptions/:id`, `DELETE .../subscriptions/:id`, `POST .../subscriptions/:id/test`, `POST /api/webhooks/square`) marked Y.

**Routes with NO tests:** None.

**Untested flows:** None.

---

#### Bundles

**Section 2 location:** Group 6 — `routes/bundles.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/bundles.test.js` | 6 |
| `__tests__/services/bundle-service.test.js` | 27 |
| `__tests__/services/bundle-calculator.test.js` | 15 |
| **Total** | **48** |

**Routes with tests:** All 5 routes marked Y.

**Routes with NO tests:** None.

---

#### Expiry Discounts

**Section 2 location:** Group 6 — `routes/expiry-discounts.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/expiry-discounts.test.js` | 34 |
| `__tests__/services/expiry/discount-service.test.js` | 77 |
| **Total** | **111** |

**Routes with tests:** All 16 routes marked Y.

**Routes with NO tests:** None.

---

#### GMC

**Section 2 location:** Group 6 — `routes/gmc/feed.js`, `routes/gmc/brands.js`, `routes/gmc/taxonomy.js`, `routes/gmc/settings.js`

| Test File | Tests |
|-----------|-------|
| `__tests__/routes/gmc.test.js` | 45 |
| `__tests__/services/gmc/brand-service.test.js` | 20 |
| `__tests__/services/gmc/feed-service.test.js` | 29 |
| `__tests__/services/gmc/merchant-service.test.js` | 32 |
| `__tests__/services/gmc/taxonomy-service.test.js` | 16 |
| **Total** | **142** |

**Routes with tests:** All 33 routes across the four GMC sub-modules marked Y.

**Routes with NO tests:** None.

---

#### Admin, Staff, Cart Activity, AI Autofill, Labels, Settings

**Section 2 location:** Group 6 — `routes/admin.js`, `routes/staff.js`, `routes/cart-activity.js`, `routes/ai-autofill.js`, `routes/labels.js`, `routes/settings.js`

| Domain | Route File | Test Files | Tests |
|--------|-----------|-----------|-------|
| Admin | `routes/admin.js` | admin.test.js (17), admin-feature-management.test.js (19), admin-promo-codes.test.js (8), admin-subscription-management.test.js (20), pricing-admin.test.js (18) | 82 |
| Staff | `routes/staff.js` | staff.test.js (20), services/staff/staff-service.test.js (23) | 43 |
| Cart Activity | `routes/cart-activity.js` | cart-activity.test.js (12), services/cart/cart-activity-service.test.js (32) | 44 |
| AI Autofill | `routes/ai-autofill.js` | ai-autofill.test.js (17), services/ai-autofill-service.test.js (34) | 51 |
| Labels | `routes/labels.js` | labels.test.js (6), services/label/zpl-generator.test.js (16) | 22 |
| Settings | `routes/settings.js` | settings.test.js (6) | 6 |

All routes in these files marked Y in Section 2. No gaps in any domain.

---

#### Overall Summary Table

| Domain | Test Files | Test Count | Routes (S2) | Route Coverage | Gaps |
|--------|-----------|------------|-------------|---------------|------|
| Auth | 4 | 109 | 12 | 100% | None |
| Subscriptions | 11 | 188 | 17 | 100%† | †`GET /api/webhooks/events` was N in S2; now covered by subscriptions-untested-endpoints.test.js |
| Merchants | 4 | 41 | 4 | 100% | None |
| Catalog | 16 | 401 | 24 | 100%‡ | ‡2 routes in `catalog-location-health.js` tested at handler level but unmounted (unreachable via HTTP) |
| Inventory | 4 | 140 | 12 | 100% | None |
| Purchase Orders | 4 | 127 | 9 | 100% | None |
| Reorder/Analytics | 5* | 181* | 6 | 100% | *reorder-service.test.js and reorder-math.test.js shared with Catalog |
| Vendors | 5 | 82 | 4 | 100% | None |
| Vendor Catalog | 9 | 277 | 22 | 100% | None |
| Loyalty | 61 | 1,062 | 47 | 100% | None |
| Seniors | 4 | 89 | 6 | 100% | None |
| Delivery | 18 | 305 | 32 | 100% | Rate-limit test depth thin (1 test in delivery-rate-limiting.test.js) |
| Square Integration | 24 | 538 | 23 | 100% | None |
| Logs | 1 | 19 | 5 | 100% | None |
| Webhooks | 20 | 458 | 9 | 100% | None |
| Bundles | 3 | 48 | 5 | 100% | None |
| Expiry Discounts | 2 | 111 | 16 | 100% | None |
| GMC | 5 | 142 | 33 | 100% | None |
| Admin | 5 | 82 | 13 | 100% | None |
| Staff | 2 | 43 | 7 | 100% | None |
| Cart Activity | 2 | 44 | 2 | 100% | None |
| AI Autofill | 2 | 51 | 6 | 100% | None |
| Labels | 2 | 22 | 4 | 100% | None |
| Settings | 1 | 6 | 3 | 100% | None |

**Overall totals (deduplicated across all groups):** 292 test files, 5,688 tests, 351 documented routes.

**Route coverage: 100%** — every route documented in Section 2 has at least one corresponding test. The single exception (`GET /api/webhooks/events`) has been closed by `subscriptions-untested-endpoints.test.js`. The one structural gap is `routes/catalog-location-health.js`, which is tested at the handler level but unreachable via HTTP because the file is not mounted in `server.js`.

**Coverage quality notes:**
- The `requireWriteAccess` gaps documented in Section 2 (delivery, vendor-catalog, cycle-counts, square-attributes, sync, bundles, expiry-discounts, labels, settings, webhooks, ai-autofill, vendor-match-suggestions) are present in the code but **not validated by dedicated negative-path tests** — existing tests confirm the happy path works but do not assert that read-only users are blocked from write endpoints.
- Delivery rate-limit enforcement has only 1 dedicated test.
- `catalog-location-health.js` endpoints are exercised by unit tests but cannot be reached in production.

---

## Section 4 — QA Checklist

> **Format:** Each item is: `- [ ] Action — Expected result — Frontend file — Backend route`
> **⚠️** marks any step that touches real Square data or fires real payment/PO operations.

---

### Journey 1 — Sign-up & Onboarding

- [ ] Navigate to `/` (marketing landing page) — Page loads; nav shows "Log In" and "Get Started" links — `public/index.html` — static (no API)
- [ ] Click "Get Started" hero button — Redirected to `/subscribe.html` — `public/index.html` — static
- [ ] Load `/subscribe.html` — Plans render (monthly/annual); Square payment form mounts — `public/subscribe.html` — `GET /api/subscriptions/plans`, `GET /api/square/payment-config`
- [ ] Click "Select Monthly" plan toggle — Monthly plan highlighted; price updates in UI — `public/subscribe.html` — client-side only
- [ ] Click "Select Annual" plan toggle — Annual plan highlighted; price updates in UI — `public/subscribe.html` — client-side only
- [ ] Enter a promo code and click "Apply" — Valid code: discount shown; invalid code: inline error — `public/subscribe.html` — `POST /api/subscriptions/promo/validate`
- [ ] Click "Terms of Service" link — Terms modal opens — `public/subscribe.html` — client-side only
- [ ] Click "I Understand and Accept" in modal — Modal closes; terms checkbox checked — `public/subscribe.html` — client-side only
- [ ] Submit signup form with valid email, business name, and payment details ⚠️ — Account created; password setup email sent; `passwordSetupUrl` returned — `public/subscribe.html` — `POST /api/subscriptions/create` ⚠️ (charges real Square payment)
- [ ] Submit signup form with an already-registered email — Error: "An account with this email already exists" — `public/subscribe.html` — `POST /api/subscriptions/create`
- [ ] Submit signup form without accepting terms — Client-side validation prevents submission — `public/subscribe.html` — client-side only
- [ ] Follow password setup link (`/set-password.html?token=...`) — Token validated; password form displayed — `public/set-password.html` — `GET /api/auth/verify-reset-token`
- [ ] Submit new password — Password saved; redirect to `/login.html?setup=complete` — `public/set-password.html` — `POST /api/auth/reset-password`
- [ ] Load `/login.html?setup=complete` — "Setup complete" banner shown — `public/login.html` — client-side only
- [ ] Log in with new credentials — Authenticated; redirect to `/dashboard.html` — `public/login.html` — `POST /api/auth/login`
- [ ] Load `/dashboard.html` after login — Dashboard renders for authenticated user — `public/dashboard.html` — `GET /api/auth/me`

### Journey 2 — Square OAuth Connection

- [ ] Log in and load `/dashboard.html` with no Square account connected — "Connect Square" prompt or banner visible — `public/dashboard.html` — `GET /api/auth/me`
- [ ] Load `/settings.html` — Connection status card shows "Disconnected" for Square — `public/settings.html` — `GET /api/health`
- [ ] Click "Connect Square" / initiate OAuth flow ⚠️ — Browser redirects to `GET /api/square/oauth/connect`; then to Square authorization page — `public/settings.html` — `GET /api/square/oauth/connect` ⚠️ (initiates real Square OAuth)
- [ ] On Square authorization page, grant all requested scopes ⚠️ — Square redirects back to `/api/square/oauth/callback?code=...&state=...` — external (Square UI) — `GET /api/square/oauth/callback` ⚠️ (exchanges real authorization code for tokens)
- [ ] Callback completes for a new merchant ⚠️ — Merchant record created/updated in DB; tokens encrypted; trial period set; custom attributes initialized async; redirect to `/dashboard.html?connected=true` — `public/dashboard.html` (redirect target) — `GET /api/square/oauth/callback` ⚠️
- [ ] Callback completes for an existing merchant (re-auth) ⚠️ — Existing merchant tokens refreshed; `trial_ends_at` NOT overwritten; redirect to dashboard — `public/dashboard.html` — `GET /api/square/oauth/callback` ⚠️
- [ ] Deny/cancel on Square authorization page — Square redirects with `error` param; user lands on `/dashboard.html?error=...` with error banner — `public/dashboard.html` — `GET /api/square/oauth/callback`
- [ ] Attempt OAuth flow with expired state token (wait >10 min or replay) — Error: "OAuth session expired. Please try again." — `public/dashboard.html` — `GET /api/square/oauth/callback`
- [ ] Reload `/settings.html` after successful connect ⚠️ — Square connection card shows "Connected" with business name and token status — `public/settings.html` — `GET /api/health`, `GET /api/locations` ⚠️ (reads real Square locations)
- [ ] Click "Test Connection" on settings page ⚠️ — Success toast with Square API response; locations count shown — `public/settings.html` — `GET /api/health` ⚠️
- [ ] Disconnect Square (click revoke / disconnect button) as owner ⚠️ — Token revoked at Square; merchant marked inactive; session `activeMerchantId` cleared — `public/settings.html` — `POST /api/square/oauth/revoke` ⚠️ (revokes real token)
- [ ] Attempt disconnect as manager or lower role — Error: 403 Insufficient permissions — `public/settings.html` — `POST /api/square/oauth/revoke`
- [ ] Admin manually refreshes token — Token refreshed; new `expiresAt` returned — `public/settings.html` (admin section) — `POST /api/square/oauth/refresh`
