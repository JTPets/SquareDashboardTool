# Dead Code Report

> **Audit Date**: 2026-03-05
> **Investigation Date**: 2026-03-05
> **Scope**: Full codebase scan — server.js, routes/, services/, middleware/, utils/, jobs/, public/js/
> **Previous Report**: docs/archive/DEAD-CODE-REPORT.md (2026-02-19 — found 0 actionable items post-cleanup)

---

## Summary

| Category | Count | Lines Removable | Verdict |
|----------|-------|-----------------|---------|
| Dead imports (server.js) | 11 | ~30 | DELETE |
| Dead variables (server.js) | 4 | ~20 | DELETE (3) + WIRE IN (security) |
| Orphaned module (middleware) | 1 file | ~211 | DELETE |
| Orphaned module (utils/merchant-db.js) | 1 file | ~567 | DELETE |
| Dead exports (middleware/auth.js) | 3 | ~35 | DELETE |
| Dead export (utils/database.js) | 1 | ~8 | DELETE |
| Re-export stubs (utils/) | 10 files | ~130 | DELETE (update 66 consumers) |
| Duplicate function (routes/) | 1 | ~4 | REFACTOR |
| Legacy dual-write (services/) | 1 block | ~20 | KEEP |
| **Total actionable** | **~32 items** | **~1,025 lines** | |

---

## Investigation 1: `utils/merchant-db.js`

> What is it? Was it replaced? Is any logic missing?

### Verdict: DELETE

**What it is**: A 567-line class-based database abstraction that auto-injects `merchant_id` into SQL queries via a `$merchant_id` placeholder. Contains 40+ convenience methods: `getItems()`, `getVariations()`, `getCategories()`, `getLocations()`, `getInventory()`, `getPurchaseOrders()`, `getSalesVelocity()`, plus generic CRUD (`insert`, `update`, `delete`, `softDelete`, `count`, `exists`).

**Was it replaced?** Yes. The codebase uses direct `db.query()` calls with explicit `merchant_id` parameters in the services layer. MerchantDB was added in commit `697cf5a` (2026-02-27, PR #913) but was never imported, instantiated, or referenced by any other file.

**Is any logic missing?** No. Every MerchantDB method has an equivalent in the current services layer:

| MerchantDB Method | Current Implementation |
|---|---|
| `getItems()` | `services/catalog/item-service.js:71-108` |
| `getVariations()` | `services/catalog/variation-service.js:25+` |
| `getCategories()` | `services/catalog/item-service.js:45-62` |
| `getLocations()` | `services/catalog/item-service.js:20-37` |
| `getInventory()` | `services/catalog/inventory-service.js` |
| `insert/update/delete` | Inline `db.query()` across services |

**Additional finding**: Contains SEC-9 security vulnerability — `update()` method (lines 451-465) interpolates column names into SQL without validation. Unreachable since the class is never instantiated, but deletion eliminates the vulnerability.

**Evidence**:
- Zero `require` references: `grep -r "merchant-db\|MerchantDB" --include="*.js"` returns only self-references
- Zero test coverage
- Single commit, never modified
- Architectural mismatch: CLAUDE.md specifies routes -> services -> db pattern; MerchantDB is a redundant data-access layer

---

## Investigation 2: `middleware/subscription-check.js`

> What does it do? Is its logic duplicated or abandoned?

### Verdict: DELETE (file + test file)

**What it does**: Email-based subscription enforcement ("System B") with 5 exports:
- `subscriptionCheck` — Global middleware checking subscription status by session email
- `apiSubscriptionCheck` — API wrapper returning JSON 403
- `requireSubscription(status)` — Factory middleware for specific subscription statuses
- `isPublicRoute(path)` — Route whitelist for paths not requiring subscription
- `getSubscriberEmail(req)` — Extracts email from session (hardened against header/cookie spoofing)

**Is logic duplicated?** Yes. System A (`requireValidSubscription` in `middleware/merchant.js:148-169`) covers all checks:

| Check | System B (this file) | System A (merchant.js) |
|-------|---------------------|----------------------|
| Trial expiry | Via `checkSubscriptionStatus()` | Explicit `trial_ends_at` check |
| Subscription expiry | Via `checkSubscriptionStatus()` | Explicit `subscription_ends_at` check |
| Suspension | Via `checkSubscriptionStatus()` | Explicit `subscription_status` check |
| Route exemptions | `PUBLIC_ROUTES` array | `subscriptionExcludedPaths` in server.js |
| Response | 403 Forbidden | 402 Payment Required |

**Difference**: System B is email-based (now deprecated). System A is merchant-context-based (active). System B was removed from server.js on 2026-03-01 with explicit comment: "System B email-based subscriptionCheck removed — System A is the sole enforcement layer."

**Test file**: `__tests__/middleware/subscription-check.test.js` (293 lines, 67 tests) — all test System B-specific behavior. Delete alongside the module.

---

## Investigation 3: Re-export Stubs in `utils/`

> For each stub: every consumer, what they need, correct direct import path. Confirm service module exports everything.

### Verdict: DELETE all 10 (update 66 consumer files)

All 10 stubs are one-line pass-through re-exports with zero added logic. Every function consumers import through the stub is confirmed available in the target service module. No missing exports, no circular dependency issues.

### Stub 1: `utils/square-api.js` -> `services/square`

| Consumer | Imports Used | New Import Path |
|----------|-------------|-----------------|
| `server.js` | Full module | `./services/square` |
| `routes/delivery.js` | `generateIdempotencyKey` | `../services/square` |
| `routes/square-oauth.js` | Full module | `../services/square` |
| `routes/sync.js` | Full module | `../services/square` |
| `routes/cycle-counts.js` | Full module | `../services/square` |
| `routes/vendor-catalog.js` | `generateIdempotencyKey` | `../services/square` |
| `routes/gmc.js` | Full module | `../services/square` |
| `routes/square-attributes.js` | Full module | `../services/square` |
| `routes/subscriptions.js` | Full module + destructured | `../services/square` |
| `services/catalog/inventory-service.js` | Full module | `../square` |
| `services/catalog/audit-service.js` | Full module | `../square` |
| `services/catalog/variation-service.js` | Full module | `../square` |
| `services/webhook-handlers/catalog-handler.js` | Full module | `../square` |
| `services/webhook-handlers/inventory-handler.js` | Full module | `../square` |
| `services/webhook-handlers/order-handler.js` | Full module | `../square` |
| `services/expiry/discount-service.js` | Lazy require | `../square` |
| `services/loyalty-admin/shared-utils.js` | Lazy require | `../square` |
| `jobs/webhook-retry-job.js` | Full module | `../services/square` |
| `jobs/committed-inventory-reconciliation-job.js` | Full module | `../services/square` |
| 4 test files | Various | `../../services/square` |

**Export coverage**: 100% — `services/square/index.js` re-exports everything consumers need.

### Stub 2: `utils/loyalty-service.js` -> `services/loyalty-admin`

| Consumer | Imports Used | New Import Path |
|----------|-------------|-----------------|
| `server.js` | Full module | `./services/loyalty-admin` |
| `routes/loyalty/audit.js` | Specific functions | `../../services/loyalty-admin` |
| `routes/loyalty/customers.js` | Specific functions | `../../services/loyalty-admin` |
| `routes/loyalty/discounts.js` | Specific functions | `../../services/loyalty-admin` |
| `routes/loyalty/offers.js` | Specific functions | `../../services/loyalty-admin` |
| `routes/loyalty/processing.js` | Specific functions | `../../services/loyalty-admin` |
| `routes/loyalty/rewards.js` | Specific functions | `../../services/loyalty-admin` |
| `routes/loyalty/settings.js` | Specific functions | `../../services/loyalty-admin` |
| `routes/loyalty/square-integration.js` | Specific functions | `../../services/loyalty-admin` |
| `routes/loyalty/variations.js` | Specific functions | `../../services/loyalty-admin` |
| `services/webhook-handlers/order-handler.js` | Specific functions | `../loyalty-admin` |
| `services/webhook-handlers/loyalty-handler.js` | Specific functions | `../loyalty-admin` |
| `services/webhook-handlers/customer-handler.js` | Specific functions | `../loyalty-admin` |
| `jobs/loyalty-catchup-job.js` | Specific functions | `../services/loyalty-admin` |
| 1 test file | Various | `../../services/loyalty-admin` |

**Export coverage**: 100% — `services/loyalty-admin/index.js` exports 61 functions across 21 modules.

### Stub 3: `utils/delivery-api.js` -> `services/delivery`

| Consumer | New Import Path |
|----------|-----------------|
| `server.js` | `./services/delivery` |
| `routes/delivery.js` | `../services/delivery` |
| `routes/driver-api.js` | `../services/delivery` |
| `services/webhook-handlers/order-handler.js` | `../delivery` |
| 1 test file | `../../services/delivery` |

**Export coverage**: 100% — 29 functions available.

### Stub 4: `utils/expiry-discount.js` -> `services/expiry`

| Consumer | New Import Path |
|----------|-----------------|
| `server.js` | `./services/expiry` |
| `routes/expiry-discounts.js` | `../services/expiry` |
| `services/catalog/inventory-service.js` | `../expiry` |
| `jobs/expiry-discount-job.js` | `../services/expiry` |

**Export coverage**: 100% — 24 functions available.

### Stub 5: `utils/cycle-count-utils.js` -> `services/inventory`

| Consumer | New Import Path |
|----------|-----------------|
| `server.js` | `./services/inventory` |
| `routes/cycle-counts.js` | `../services/inventory` |
| `jobs/cycle-count-job.js` | `../services/inventory` |

**Export coverage**: 100% — 2 functions: `generateDailyBatch`, `sendCycleCountReport`.

### Stub 6: `utils/merchant-center-api.js` -> `services/gmc/merchant-service`

| Consumer | New Import Path |
|----------|-----------------|
| `server.js` | `./services/gmc/merchant-service` |
| `routes/gmc.js` | `../services/gmc/merchant-service` |
| `jobs/sync-job.js` | `../services/gmc/merchant-service` |

**Export coverage**: 100% — 8 functions available.

### Stub 7: `utils/loyalty-reports.js` -> `services/reports`

| Consumer | New Import Path |
|----------|-----------------|
| `server.js` | `./services/reports` |
| `routes/loyalty/reports.js` | `../../services/reports` |

**Export coverage**: 100% — 6 report generation functions.

### Stub 8: `utils/gmc-feed.js` -> `services/gmc/feed-service`

| Consumer | New Import Path |
|----------|-----------------|
| `routes/gmc.js` | `../services/gmc/feed-service` |
| `routes/sync.js` | `../services/gmc/feed-service` |

**Export coverage**: 100% — 10 functions.

### Stub 9: `utils/vendor-catalog.js` -> `services/vendor`

| Consumer | New Import Path |
|----------|-----------------|
| `routes/vendor-catalog.js` | `../services/vendor` |
| 1 test file | `../../services/vendor` |

**Export coverage**: 100% — 16 functions.

### Stub 10: `utils/google-sheets.js` -> `utils/google-auth`

| Consumer | New Import Path |
|----------|-----------------|
| 1 test file | `../utils/google-auth` |

**Export coverage**: 100%. Misnamed stub (handles GMC OAuth, not Sheets). Only 1 test consumer.

---

## Investigation 4: Rate Limiters in `server.js`

> Should these be wired in, or deleted? What routes are exposed?

### Verdict: DELETE the server.js variables (they are redundant) + WIRE IN rate limiting on unprotected delivery/driver endpoints (separate security task)

**Critical finding**: `routes/delivery.js` (lines 61-62) and `routes/gmc.js` (line 45) each create their **own instances** of these rate limiters by importing `configureDeliveryRateLimit`, `configureDeliveryStrictRateLimit`, and `configureSensitiveOperationRateLimit` directly from `middleware/security.js`. The server.js copies are leftover from before route extraction and are fully redundant.

**Rate limiter specs**:
- `configureDeliveryRateLimit()` — 30 requests/minute, keyed by user ID or IP
- `configureDeliveryStrictRateLimit()` — 10 requests/5 minutes, for expensive operations
- `configureSensitiveOperationRateLimit()` — 5 requests/hour per merchant, for token regeneration

**`podUpload` multer config** (server.js:228-241): Dead. Both `routes/delivery.js` (lines 65-78) and `routes/driver-api.js` (lines 37-51) define their own identical multer configs. The `multer` import on line 15 is also dead — its only use is the dead `podUpload`.

### Security Gaps Discovered (Separate from dead code cleanup)

The following delivery endpoints have **NO rate limiting** beyond the global 100/15min:

**P0 — Public driver API (unauthenticated, token-based):**

| Endpoint | Risk |
|----------|------|
| `POST /api/driver/:token/orders/:orderId/pod` | **CRITICAL**: 10MB file upload, 100/15min = 1GB potential |
| `POST /api/driver/:token/orders/:orderId/complete` | State change, no per-token limit |
| `POST /api/driver/:token/orders/:orderId/skip` | State change, no per-token limit |
| `POST /api/driver/:token/finish` | State change, no per-token limit |

**P1 — Authenticated delivery routes missing rate limiter:**

| Endpoint | Should Have |
|----------|-------------|
| `PATCH /api/delivery/orders/:id` | `deliveryRateLimit` |
| `DELETE /api/delivery/orders/:id` | `deliveryRateLimit` |
| `POST /api/delivery/orders/:id/skip` | `deliveryRateLimit` |
| `POST /api/delivery/orders/:id/complete` | `deliveryRateLimit` |
| `POST /api/delivery/route/finish` | `deliveryRateLimit` |
| `PUT /api/delivery/settings` | `deliveryRateLimit` |
| `POST /api/delivery/backfill-customers` | `deliveryStrictRateLimit` |

> **Action**: File these as a security task (not dead code cleanup). The server.js variables should still be deleted — they are unused duplicates. The security gaps should be fixed in `routes/delivery.js` and `routes/driver-api.js` where the rate limiters are already instantiated.

---

## Investigation 5: Dead Exports in `middleware/auth.js`

> Test usage? Needed for BACKLOG-41 (user access control)?

### Verdict: DELETE all 3

**Test usage**: All 3 functions have test coverage in `__tests__/middleware/auth.test.js` (16 tests total). These tests would be deleted alongside the functions.

**BACKLOG-41 analysis**: BACKLOG-41 specifies "manager, clerk, accountant permissions" — these are **merchant-scoped roles**, not global roles.

| Function | Needed for BACKLOG-41? | Reason |
|----------|----------------------|--------|
| `requireRole(...roles)` | **NO** | Checks global `req.session.user.role`. BACKLOG-41 needs merchant-scoped roles (`user_merchants.role`). `requireMerchantRole()` in merchant.js already handles this correctly. |
| `getCurrentUser(req)` | **NO** | Trivial one-liner (`req.session?.user`). BACKLOG-41 audit logging will use `req.session.user.id` + `req.merchantContext.id` directly. |
| `optionalAuth(req, res, next)` | **NO** | Sets `req.user` from session but no route reads `req.user`. BACKLOG-41 endpoints require full auth (`requireAuth` + `requireMerchantRole()`). |

**Two role systems exist**:
- **Global roles** (`users.role`): `admin`, `user`, `readonly` — platform-wide, used by `requireRole()` (dead)
- **Merchant roles** (`user_merchants.role`): `owner`, `admin`, `user`, `readonly` — per-tenant, used by `requireMerchantRole()` (active)

BACKLOG-41 will extend the merchant role system (adding `manager`, `clerk`, `accountant` to the `user_merchants.role` constraint). `requireMerchantRole()` already supports arbitrary role strings. No changes to auth.js needed.

---

## Investigation 6: Server.js Dead Imports

> Confirm each is truly unused end-to-end.

### Verdict: DELETE all 11

Every import was verified by searching the full 1,186-line server.js for any reference beyond the import line (dot notation, function calls, bracket notation, middleware usage, variable passing).

| # | Line | Import | References in server.js | Verdict |
|---|------|--------|------------------------|---------|
| 1 | 7 | `startupTime = Date.now()` | 0 | DELETE |
| 2 | 15 | `multer = require('multer')` | Only used by dead `podUpload` (line 228) | DELETE |
| 3 | 16 | `cron = require('node-cron')` | 0 (cron logic in `jobs/cron-scheduler.js`) | DELETE |
| 4 | 31 | `subscriptionHandler = require(...)` | 0 | DELETE |
| 5 | 33 | `expiryDiscount = require(...)` | 0 (not to be confused with `expiryDiscountsRoutes` on line 60, which IS used) | DELETE |
| 6 | 35 | `deliveryApi = require(...)` | 0 | DELETE |
| 7 | 36 | `loyaltyService = require(...)` | 0 | DELETE |
| 8 | 37 | `loyaltyReports = require(...)` | 0 | DELETE |
| 9 | 38 | `gmcApi = require(...)` | 0 | DELETE |
| 10 | 63 | `{ generateDailyBatch }` destructured | 0 | DELETE |
| 11 | 65 | `loggedSync` in destructuring | 0 (`runSmartSync` used at line 1035; `isSyncNeeded` at line 1022) | DELETE (keep other destructured names) |

**Line 228-241**: `podUpload` multer config — dead. `routes/delivery.js:65-78` and `routes/driver-api.js:37-51` each have their own identical configs.

**Line 126-129**: 3 rate limiter variables — dead (superseded by route-local instances, see Investigation 4).

---

## Final Verdicts

| Item | Verdict | Reason |
|------|---------|--------|
| **`utils/merchant-db.js`** | **DELETE** | 567-line class never imported. All methods duplicated in services layer. Contains SEC-9 vulnerability. Confirmed dead via git history + exhaustive grep. |
| **`middleware/subscription-check.js`** | **DELETE** | System B removed 2026-03-01. System A covers all checks. Zero production consumers. Delete test file too. |
| **10 re-export stubs** | **DELETE** (update 66 consumers) | All stubs are one-line pass-throughs. 100% export coverage in target modules confirmed. No circular dependency issues. Mechanical find-replace refactor. |
| **3 rate limiter variables (server.js)** | **DELETE** | Redundant — `routes/delivery.js` and `routes/gmc.js` create their own instances. |
| **`podUpload` + `multer` import (server.js)** | **DELETE** | Both delivery.js and driver-api.js define own multer configs. |
| **8 dead imports (server.js)** | **DELETE** | All confirmed zero references beyond import line. |
| **`expiryDiscount` import (server.js:33)** | **DELETE** | Zero references. Distinct from `expiryDiscountsRoutes` (line 60) which IS used. |
| **`loggedSync` + `generateDailyBatch`** | **DELETE** | Destructured but never called. Fix: remove from destructuring. |
| **`getCurrentUser` (auth.js)** | **DELETE** | Trivial accessor, zero consumers, not needed for BACKLOG-41. |
| **`requireRole` (auth.js)** | **DELETE** | Superseded by `requireMerchantRole()`. BACKLOG-41 will use merchant-scoped roles. |
| **`optionalAuth` (auth.js)** | **DELETE** | Zero consumers, not needed for any planned feature. |
| **`getPoolStats` (database.js)** | **DELETE** | Exported, never imported. |
| **`hashResetToken` duplication** | **REFACTOR** | Extract to `utils/password.js`. Not dead, but duplicated. |
| **Legacy dual-write (reward-service.js)** | **KEEP** | Intentional backward compatibility. Explicitly marked "LEGACY: Remove after migration." |
| **Delivery rate limiting gaps** | **WIRE IN** (separate task) | 7 authenticated + 5 public endpoints missing rate limits. File as security task, not dead code cleanup. |
| **`clearClientCache` (merchant.js)** | **KEEP** | Utility function for cache management. Low cost to keep, may be useful for operations/debugging. |

---

## Recommended Cleanup Order

### Phase 1: Zero-Risk Deletions (~830 lines)

1. Delete `middleware/subscription-check.js` + its test file (~504 lines)
2. Delete `utils/merchant-db.js` (~567 lines, also resolves SEC-9)
3. Remove 11 dead imports from server.js (lines 7, 15-16, 31, 33, 35-38, 63 partial, 65 partial)
4. Remove dead `podUpload` config from server.js (lines 228-241)
5. Remove 3 dead rate limiter variables from server.js (lines 126-129)
6. Remove 3 dead exports + functions from `middleware/auth.js` + their 16 tests
7. Remove `getPoolStats` export + function from `utils/database.js`

### Phase 2: Stub Elimination (~130 lines deleted, 66 files updated)

8. Update 66 consumer files to import directly from `services/` modules
9. Delete 10 re-export stub files from `utils/`
10. Consolidate `hashResetToken` into `utils/password.js`

### Phase 3: Security Hardening (not dead code — separate task)

11. Add rate limiting to 7 unprotected delivery write endpoints in `routes/delivery.js`
12. Add per-token rate limiting to 5 public driver API endpoints in `routes/driver-api.js`
13. Consolidate 3 identical multer configs into shared utility

---

## Clean Areas (No Dead Code Found)

| Area | Files Scanned | Status |
|------|--------------|--------|
| `routes/` (36 files + 11 subroutes) | 47 | Clean — all routes registered in server.js |
| `services/` (12 subdirectories, 84 files) | 84 | Clean — O-1 already resolved |
| `jobs/` (13 files) | 13 | Clean — all jobs registered in cron-scheduler.js |
| `public/js/` (38 files) | 38 | Clean — all files referenced by HTML pages |
| `middleware/validators/` (21 files) | 21 | Clean — all validators used by routes |

---

## Previously Reported Items — Status

| Item | Previous Report | Current Status |
|------|----------------|----------------|
| `createSquareLoyaltyReward` (loyalty-admin) | Dead (2026-02-19) | RESOLVED — deleted 2026-02-19 |
| `getAllVariationAssignments` (loyalty-admin) | Dead (2026-02-19) | RESOLVED — deleted 2026-02-19 |
| `updateVariationPrice` (square-pricing.js) | Dead (TECHNICAL_DEBT O-1) | RESOLVED — function no longer exists |
| CSP TODO in security.js | Stale (2026-02-19) | RESOLVED — updated 2026-02-19 |
| DEAD-6-12 in server.js | 7 dead imports noted | CONFIRMED — 11 total (includes newly found expiryDiscount, multer) |
| DC-1 re-export stubs | 9 stubs noted | CONFIRMED — 10 stubs, all safe to delete |

---

## Methodology

- **Unused imports**: Read each file's `require()` statements, then searched entire file for variable usage (dot notation, function calls, bracket notation, middleware parameters, destructuring)
- **Unused exports**: For each `module.exports`, grepped all production code (excluding `__tests__/` and `node_modules/`)
- **Orphaned files**: Cross-referenced route registrations in server.js, job registrations in cron-scheduler.js, HTML `<script>` tags for frontend JS
- **Re-export stubs**: Read each stub, traced all consumers, read target service modules to confirm 100% export coverage
- **Rate limiters**: Read `middleware/security.js` definitions, searched both server.js and route files for instantiation and application
- **Auth exports**: Compared `requireRole` vs `requireMerchantRole`, analyzed BACKLOG-41 requirements for role system compatibility
- **MerchantDB**: Read all 567 lines, compared each method against existing service implementations, checked git history
- **Subscription-check**: Compared System A vs System B check-by-check, verified server.js removal comments

**Tools**: File reads, ripgrep searches, git log, cross-reference analysis across all directories
**Coverage**: 246 JavaScript files scanned (excluding node_modules, .git, __tests__)
