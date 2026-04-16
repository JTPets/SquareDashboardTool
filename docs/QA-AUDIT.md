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
