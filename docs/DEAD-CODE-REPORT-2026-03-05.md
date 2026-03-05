# Dead Code Report

> **Audit Date**: 2026-03-05
> **Scope**: Full codebase scan — server.js, routes/, services/, middleware/, utils/, jobs/, public/js/
> **Previous Report**: docs/archive/DEAD-CODE-REPORT.md (2026-02-19 — found 0 actionable items post-cleanup)

---

## Summary

| Category | Count | Lines Removable |
|----------|-------|-----------------|
| Dead imports (server.js) | 7 | ~7 |
| Dead variables (server.js) | 5 | ~20 |
| Orphaned module (middleware) | 1 file | ~211 |
| Dead exports (middleware/auth.js) | 3 | ~35 |
| Dead export (utils/database.js) | 1 | ~8 |
| Orphaned module (utils/merchant-db.js) | 1 file | ~567 |
| Re-export stubs (utils/) | 10 files | ~130 |
| Duplicate function (routes/) | 1 | ~4 |
| Legacy dual-write (services/) | 1 block | ~20 |
| **Total** | **~30 items** | **~1,002 lines** |

---

## P0: Orphaned Modules (Safe to Delete Entirely)

### 1. `middleware/subscription-check.js` (~211 lines)

**Classification**: SAFE TO DELETE

5 exports (`subscriptionCheck`, `apiSubscriptionCheck`, `requireSubscription`, `isPublicRoute`, `getSubscriberEmail`) — zero production consumers. Only imported by its own test file.

**Reason**: System B subscription enforcement was removed from server.js (2026-03-01). System A (`requireValidSubscription` in merchant.js) is the sole enforcement layer. This file is fully orphaned.

### 2. `utils/merchant-db.js` (~567 lines)

**Classification**: NEEDS VERIFICATION

Full `MerchantDB` class with 40+ methods — never imported or instantiated anywhere in the codebase. Only referenced in its own JSDoc example comment.

**Reason**: Appears to be a proposed abstraction pattern that was never adopted. The codebase uses direct `db.query()` with `merchant_id` filtering instead. If confirmed as abandoned design, delete entirely.

---

## P1: Dead Imports & Variables in `server.js`

### Dead Imports (7 items)

| Line | Import | Reason | Classification |
|------|--------|--------|----------------|
| 7 | `const startupTime = Date.now()` | Never referenced after declaration | SAFE TO DELETE |
| 16 | `const cron = require('node-cron')` | Never used; jobs module manages cron internally | SAFE TO DELETE |
| 31 | `const subscriptionHandler = require('./utils/subscription-handler')` | Subscription enforcement moved to merchant middleware | SAFE TO DELETE |
| 35 | `const deliveryApi = require('./utils/delivery-api')` | Delivery routes extracted to routes/delivery.js | SAFE TO DELETE |
| 36 | `const loyaltyService = require('./utils/loyalty-service')` | Loyalty routes extracted to routes/loyalty.js | SAFE TO DELETE |
| 37 | `const loyaltyReports = require('./utils/loyalty-reports')` | Reports extracted to loyalty route module | SAFE TO DELETE |
| 38 | `const gmcApi = require('./utils/merchant-center-api')` | GMC routes extracted to routes/gmc.js | SAFE TO DELETE |

### Dead Destructured Imports (2 items)

| Line | Import | Reason | Classification |
|------|--------|--------|----------------|
| 63 | `{ generateDailyBatch }` from `utils/cycle-count-utils` | Never used; cycle counts handled by extracted routes | SAFE TO DELETE |
| 65 | `loggedSync` from `routes/sync` destructuring | Never referenced; only `runSmartSync` and `isSyncNeeded` used | SAFE TO DELETE |

### Dead Variables (4 items)

| Line | Variable | Reason | Classification |
|------|----------|--------|----------------|
| 126 | `deliveryRateLimit` | Configured but never applied to any route | NEEDS VERIFICATION |
| 127 | `deliveryStrictRateLimit` | Configured but never applied to any route | NEEDS VERIFICATION |
| 129 | `sensitiveOperationRateLimit` | Configured but never applied to any route | NEEDS VERIFICATION |
| 228-241 | `podUpload` (multer config) | Configured but never applied; delivery routes may have own config | NEEDS VERIFICATION |

> **Note on rate limiters**: These 3 rate-limit variables + `podUpload` were likely intended to be wired into routes but never were. Before deleting, verify whether `routes/delivery.js` has its own upload/rate-limit config. If so, these are dead. If not, they should be wired in (security gap).

---

## P1: Dead Exports

### `middleware/auth.js` — 3 unused exports

| Line | Export | Reason | Classification |
|------|--------|--------|----------------|
| 143-145 | `getCurrentUser(req)` | 0 non-test consumers; trivial accessor (`req.session?.user`) | SAFE TO DELETE |
| 77-103 | `requireRole(...roles)` | 0 non-test consumers; superseded by `requireMerchantRole()` in merchant.js | SAFE TO DELETE |
| 130-136 | `optionalAuth(req, res, next)` | 0 non-test consumers; sets `req.user` but no route reads it | SAFE TO DELETE |

### `utils/database.js` — 1 unused export

| Line | Export | Reason | Classification |
|------|--------|--------|----------------|
| 44, 2409 | `getPoolStats()` | Exported but never imported by any file | SAFE TO DELETE |

---

## P2: Re-export Stubs (DC-1 from TECHNICAL_DEBT.md)

10 files in `utils/` that simply re-export from `services/`. All have active consumers, but the stub pattern is tech debt. Removing requires updating all consumer import paths.

| File | Real Source | Consumer Count | Classification |
|------|------------|----------------|----------------|
| `utils/square-api.js` | `services/square` | 24 | SAFE TO DELETE (update consumers) |
| `utils/loyalty-service.js` | `services/loyalty-admin` | 15 | SAFE TO DELETE (update consumers) |
| `utils/delivery-api.js` | `services/delivery` | 5 | SAFE TO DELETE (update consumers) |
| `utils/expiry-discount.js` | `services/expiry` | 4 | SAFE TO DELETE (update consumers) |
| `utils/cycle-count-utils.js` | `services/inventory` | 3 | SAFE TO DELETE (update consumers) |
| `utils/merchant-center-api.js` | `services/gmc/merchant-service` | 3 | SAFE TO DELETE (update consumers) |
| `utils/loyalty-reports.js` | `services/reports` | 2 | SAFE TO DELETE (update consumers) |
| `utils/gmc-feed.js` | `services/gmc/feed-service` | 2 | SAFE TO DELETE (update consumers) |
| `utils/vendor-catalog.js` | `services/vendor` | 2 | SAFE TO DELETE (update consumers) |
| `utils/google-sheets.js` | `google-auth` | 1 (test only) | SAFE TO DELETE |

---

## P3: Code Quality Issues (Not Strictly Dead)

### Duplicate function: `hashResetToken`

- `routes/auth.js:19-21` and `routes/subscriptions.js:40-43` — identical 3-line SHA-256 hash function
- Already tracked in TECHNICAL_DEBT.md
- **Recommendation**: Extract to `utils/password.js` (which already exists)

### Duplicate import pattern: `routes/subscriptions.js:37-38`

```javascript
const squareApi = require('../utils/square-api');
const { generateIdempotencyKey } = require('../utils/square-api');
```
- Same module required twice; consolidate to single import

### Legacy dual-write: `services/loyalty-admin/reward-service.js:94-113`

- Inserts into legacy `loyalty_redemptions` table alongside modern `loyalty_rewards` table
- Explicitly commented as "LEGACY: Remove after migration"
- **Classification**: KEEP (intentional backward compatibility during migration)

---

## Clean Areas (No Dead Code Found)

| Area | Files Scanned | Status |
|------|--------------|--------|
| `routes/` (36 files + 11 subroutes) | 47 | Clean — all routes registered in server.js |
| `services/` (12 subdirectories, 84 files) | 84 | Clean — O-1 (`updateVariationPrice`) already resolved |
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
| DEAD-6-12 in server.js | 7 dead imports noted | STILL PRESENT — confirmed in this report |
| DC-1 re-export stubs | 9 stubs noted | STILL PRESENT — 10 stubs confirmed |

---

## Recommended Cleanup Order

### Phase 1: Zero-Risk Deletions (~250 lines)
1. Delete `middleware/subscription-check.js` (entire file)
2. Remove 7 dead imports from server.js (lines 7, 16, 31, 35-38)
3. Remove 2 dead destructured imports from server.js (lines 63, 65)
4. Remove 3 dead exports from `middleware/auth.js` (`getCurrentUser`, `requireRole`, `optionalAuth`)
5. Remove `getPoolStats` export from `utils/database.js`

### Phase 2: Requires Decision (~567 lines)
6. Decide on `utils/merchant-db.js` — delete if confirmed obsolete
7. Decide on server.js rate limiters — wire to routes or delete
8. Decide on `podUpload` multer config — check if delivery routes have own config

### Phase 3: Refactoring (~130 lines, higher effort)
9. Update 55+ consumer imports to remove 10 re-export stubs in `utils/`
10. Extract `hashResetToken` to shared utility

---

## Methodology

- **Unused imports**: Read each file's `require()` statements, then searched entire codebase for each imported variable name
- **Unused exports**: For each `module.exports`, grepped all production code (excluding `__tests__/` and `node_modules/`)
- **Orphaned files**: Cross-referenced route registrations in server.js, job registrations in cron-scheduler.js, HTML `<script>` tags for frontend JS
- **Commented-out code**: Scanned for blocks of 3+ consecutive lines of commented JavaScript code patterns
- **Re-export stubs**: Identified files that only re-export from another module, traced all consumers

**Tools**: File reads, ripgrep searches, cross-reference analysis across all directories
**Coverage**: 246 JavaScript files scanned (excluding node_modules, .git, __tests__)
