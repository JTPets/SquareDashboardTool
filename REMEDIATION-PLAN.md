# SqTools Master Remediation Plan

**Created**: 2026-02-25
**Replaces**: All prior BACKLOG-\*.md, PRIORITIES.md, DEDUP-AUDIT next-steps, TECHNICAL_DEBT.md backlog section
**Sources cross-referenced**:
- `docs/CODEBASE_AUDIT_2026-02-25.md` (S-1 through C-6, 10 sections)
- `docs/DEDUP-AUDIT.md` (L-1 through G-8, 18 findings)
- `docs/CODE_AUDIT_REPORT.md` (CRIT-1 through LOW-4)
- `docs/TECHNICAL_DEBT.md` (P0 through P3, BACKLOG-1 through BACKLOG-36)
- `docs/DEAD-CODE-REPORT.md` (DC findings)
- `docs/PLAN-sales-velocity-refactor.md` (BACKLOG-35, BACKLOG-36)
- `docs/EXPIRY-DISCOUNT-DEDUP-REPORT.md`
- `CLAUDE.md` (architecture rules, approved violations)

**Rule**: When we touch a system, we finish it. No partial fixes.

---

## Timeline Summary

**Start date**: 2026-02-25
**Assumption**: ~2-3 Claude Code sessions per week

### Effort Key

| Size | Sessions | Calendar |
|------|----------|----------|
| S | 1-2 | ~1 day |
| M | 3-5 | ~1 week |
| L | 6-10 | ~2 weeks |
| XL | 10+ | ~3-4 weeks |

### Parallel Tracks

```
Week 1-2 (Feb 25 – Mar 10):
  Track A: Pkg 1 Security Hardening [M, ~1 week] ✅ DONE 2026-02-25
  Track B: Pkg 7 Database [S, ~1 day] ✅ DONE 2026-02-25  ──then──► Pkg 13 Test Infra [S, ~1 day] ✅ DONE 2026-02-25
  Track C: Pkg 9 Expiry Logging [S, ~1 day]

Week 2-4 (Mar 3 – Mar 17):
  Track A: Pkg 2a Square API Quick Fixes [S, ~1 day] ✅ DONE 2026-02-26
  Track B: Pkg 3 Loyalty Services [L, ~2 weeks]    ◄── no Pkg 2 dependency
  Track C: Pkg 4a Reorder/Analytics [M, ~1 week]   ◄── no Pkg 2 dependency
  Track D: Pkg 10 GMC Integration [M, ~1 week] ✅ DONE 2026-02-28

Week 4-8 (Mar 17 – Apr 14):
  Track A: Pkg 2b Square API Monolith Split [XL, ~3-4 weeks]
  Track B: Pkg 4b Velocity Refactor [XL, ~3-4 weeks + 72h validation waits]
  Track C: Pkg 6 Webhook Handler Tests [L, ~2 weeks]
  Track D: Pkg 5 Bundle System [M, ~1 week] ✅ DONE 2026-02-27

Week 8+ (Apr 14 onward):
  Pkg 11 Config/DevOps [L, ~2 weeks]
  Pkg 12 Frontend Cleanup [M, ~1 week]
  Pkg 14 Code Cleanup [L, ~2 weeks]
  Pkg 15 Vendor/Feature Work [M, ~1 week]
  Pkg 8 Delivery Services [M, ~1 week]
```

**Estimated total**: ~16-20 weeks for all packages (many run in parallel)
**P0-P1 complete by**: ~Week 4 (mid-March)
**P2 complete by**: ~Week 8 (mid-April)
**P3 complete by**: ~Week 16-20 (June-July)

---

## Dependency Graph

```
CORRECTED 2026-02-25 — see Pre-Execution Investigation below

P0: Security Hardening (Pkg 1) ──────────────────────► ✅ DONE 2026-02-25

P1: Database (Pkg 7) ───────────────► (parallel, no blockers)

P1: Pkg 2a Quick Fixes ─────────────► ✅ DONE 2026-02-26
P1: Pkg 2b API Split ───────────────► (XL, runs parallel with everything — NOT a blocker)

P1: Pkg 3 Loyalty Dedup ────────────► (NO dependency on Pkg 2 — import chain verified)
P1: Pkg 4a Reorder/Analytics ───────► (NO dependency on Pkg 2 — import chain verified)

P1: Pkg 4b Velocity Refactor ───────► (independent of Pkg 4a — extract as standalone)
                                       Phase 1-2 → 24-48h validation → Phase 3-4 → 1wk monitor → Phase 5

P2: Pkg 13 Test Infra ─────────────► unblocks Pkg 6 (Webhook Tests)
P2: Pkg 6 Webhook Tests ───────────► (depends on Pkg 13 for email mock)
P2: Pkg 5 Bundle System ───────────► ✅ DONE 2026-02-27
P2: Pkg 9 Expiry Logging ──────────► (no blockers, parallel)
P2: Pkg 10 GMC Integration ────────► ✅ DONE 2026-02-28

P3: Pkg 11 Config/DevOps ──────────► (no blockers)
P3: Pkg 12 Frontend Cleanup ───────► (no blockers)
P3: Pkg 14 Code Cleanup ───────────► (route tests should exist first)
P3: Pkg 15 Vendor/Feature Work ────► (no blockers)
P3: Pkg 8 Delivery Services ───────► (no blockers)
```

---

## Pre-Execution Investigation

Findings from investigating 5 flagged discrepancies in the original plan (2026-02-25).

### Flag 1: BACKLOG-21/22 — CONFIRMED COMPLETED

**Evidence**: Commit `bcc136a` (2026-02-23) titled "fix: subtract committed inventory (RESERVED_FOR_SALE) from available stock (BACKLOG-22, BACKLOG-21)" modified 4 files:
- `services/catalog/inventory-service.js` — added RESERVED_FOR_SALE subquery, changed days-of-stock to use `current_stock - committed_quantity`
- `services/catalog/audit-service.js` — added committed_quantity CTE column, changed days-of-stock to use `(current_stock - committed_quantity) / daily_velocity`
- `routes/bundles.js` — fetches both IN_STOCK and RESERVED_FOR_SALE, subtracts committed from available, uses available for days-of-stock
- `CLAUDE.md` — updated BACKLOG-21/22 to DONE

**Plan changes**:
- Inventory table: BACKLOG-21/DEDUP R-2 and BACKLOG-22/DEDUP R-3 changed from OPEN to **DONE** (2026-02-23)
- Pkg 4a: Removed tasks 1 and 2 (days-of-stock standardization). Remaining tasks: pagination (P-1), BACKLOG-34 documentation.
- Retirement table: Already correct (listed as COMPLETED)

### Flag 2: BACKLOG-28 — CONFIRMED COMPLETED

**Evidence**: Commit `b4768cc` (2026-02-24) titled "feat: wire per-vendor lead_time_days into reorder suggestions (BACKLOG-28)". Verified full wiring:

| Component | File:Line | Status |
|-----------|-----------|--------|
| DB column | `database/schema.sql:157` — `lead_time_days INTEGER DEFAULT 7` | Exists |
| Validator | `middleware/validators/vendor-catalog.js:211-213` | Exists |
| UI input | `public/js/vendor-dashboard.js:266` — `<input type="number" id="field-lead_time_days-...">` | Exists |
| UI save | `public/js/vendor-dashboard.js:373` — `lead_time_days: parseInt(getVal('lead_time_days'))` | Exists |
| SQL read (reorder) | `routes/analytics.js:217,276` — `ve.lead_time_days` in SELECT and WHERE | Exists |
| JS threshold | `routes/analytics.js:332` — `const leadTime = parseInt(row.lead_time_days) \|\| 0` | Exists |
| SQL read (vendor) | `services/vendor-dashboard.js:99,127,213,234` — used in reorder calc | Exists |
| Frontend display | `public/js/reorder.js:762` — `${item.lead_time_days > 0 ? item.lead_time_days + 'd' : '-'}` | Exists |
| Service update | `services/vendor-dashboard.js:450` — in `allowedFields` for vendor config update | Exists |

**Conclusion**: Fully wired. Vendors can edit lead time in vendor dashboard. Reorder suggestions and vendor dashboard both use per-vendor lead time. Default is 7 days.

**Plan changes**: None — retirement table was already correct.

### Flag 3: Pkg 2 Does NOT Block Pkg 3 or Pkg 4 — DEPENDENCY REMOVED

**Evidence**: Verified actual import chains for all Pkg 3 and Pkg 4 files:

| File | Imports `services/square/api.js`? | Imports `utils/square-api.js`? |
|------|-----------------------------------|-------------------------------|
| `routes/analytics.js` | NO | NO |
| `routes/loyalty.js` | NO | NO |
| `services/loyalty-admin/customer-admin-service.js` | NO | NO |
| `services/loyalty-admin/customer-identification-service.js` | NO (uses `./square-api-client`) | NO |
| `services/loyalty-admin/redemption-audit-service.js` | NO | NO |
| `services/catalog/inventory-service.js` | NO | YES (but Pkg 4 tasks don't modify Square API calls) |
| `services/catalog/audit-service.js` | NO | YES (but Pkg 4 tasks don't modify Square API calls) |
| `services/catalog/reorder-math.js` | NO | NO |

The original plan listed "Dependencies: Pkg 2 (Square API) for I-2 fix" on Pkg 3 and "Dependencies: Pkg 2 (Square API) for split api.js" on Pkg 4. Both are **false dependencies** — I-2 (API version unification) only affects `services/square/api.js:25` and `services/loyalty-admin/shared-utils.js:18`, neither of which is touched by Pkg 3 or Pkg 4 tasks.

**Plan changes**:
- Pkg 2 split into **Pkg 2a** (quick fixes, S effort) and **Pkg 2b** (monolith split, XL effort)
- Pkg 3 dependency on Pkg 2: **REMOVED**
- Pkg 4a dependency on Pkg 2: **REMOVED**
- Dependency graph: CORRECTED (see above)
- This unblocks ~4 weeks of work that was unnecessarily sequenced behind the XL api.js split

### Flag 4: Velocity Refactor Extracted to Pkg 4b

**Evidence**: Full analysis of `docs/PLAN-sales-velocity-refactor.md` confirms:
- The velocity refactor creates new files (`services/inventory-changes.js`, migration, job) — none shared with Pkg 4a tasks
- `routes/analytics.js` is a consumer of `sales_velocity` but the velocity refactor doesn't modify it (only changes how data is populated)
- No dependency on the api.js split — new module makes its own Square API calls
- Internal phases must be sequential (schema → backfill → webhook → recalculation → cutover)
- Requires 24-48h validation wait between Phase 2 and Phase 3, and 1 week monitoring between Phase 4 and Phase 5

**Plan changes**:
- BACKLOG-35/36 extracted from Pkg 4 task 5 into new **Pkg 4b: Sales Velocity Refactor**
- Pkg 4a is now M effort (down from L) — just pagination + documentation
- Pkg 4b is XL effort (25-35 active hours + 72h validation waits)
- Pkg 4b has NO dependency on Pkg 4a and can run in parallel

### Flag 5: Calendar Estimates Added

See **Timeline Summary** section at top of document.

---

## Inventory of All Findings

Every finding from every source, merged and deduplicated.

### Legend

| Status | Meaning |
|--------|---------|
| **OPEN** | Not started, needs work |
| **DONE** | Already fixed (date noted) |
| **MERGED** | Absorbed into a remediation package below |

### Security Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| S-1 | Audit | HIGH | SQL injection via template literal INTERVAL in cart-activity-service.js (4 sites), square-oauth.js, google-auth.js | **DONE** (2026-02-25, Pkg 1) |
| S-2 | Audit | MEDIUM | `/output` directory served without auth (includes backups) | **DONE** (2026-02-25, Pkg 1) |
| S-3 | Audit | MEDIUM | OAuth callback missing session auth verification | **DONE** (2026-02-25, Pkg 1) |
| S-4 | Audit | MEDIUM | CSP allows `'unsafe-inline'` for scripts — last inline script externalized, directive removed | **DONE** (2026-02-25, Pkg 1) |
| S-5 | Audit | LOW | Password reset token exposed in dev (negative env check) — changed to positive opt-in | **DONE** (2026-02-25, Pkg 1) |
| S-6 | Audit | MEDIUM | Admin user listing not scoped by merchant — now joins user_merchants | **DONE** (2026-02-25, Pkg 1) |
| S-7 | Audit | LOW | Missing `requireMerchant` on OAuth revoke route — standard middleware added | **DONE** (2026-02-25, Pkg 1) |
| S-8 | Audit | LOW | Health endpoint exposes internal details — split into public minimal + auth detailed | **DONE** (2026-02-25, Pkg 1) |
| S-9 | Audit | LOW | No CSRF token for state-changing POST requests — assessed, sameSite+CORS sufficient | **DONE** (2026-02-25, Pkg 1) |
| S-10 | Audit | HIGH | XSS in vendor catalog import validation errors (innerHTML) — escapeHtml() added | **DONE** (2026-02-25, Pkg 1) |
| S-11 | Audit | LOW | Session fixation window on OAuth callback — session.regenerate() added | **DONE** (2026-02-25, Pkg 1) |
| CRIT-1 | CODE_AUDIT | CRITICAL | Cross-tenant cart data deletion | **DONE** (2026-02-05) |
| CRIT-2 | CODE_AUDIT | CRITICAL | Google OAuth CSRF vulnerability | **DONE** (2026-02-05) |
| CRIT-3 | CODE_AUDIT | CRITICAL | Server-side XSS in HTML report generation | **DONE** (2026-02-05) |
| CRIT-4 | CODE_AUDIT | CRITICAL | Client-side API key in localStorage | **DONE** (2026-02-05) |
| CRIT-5 | CODE_AUDIT | CRITICAL | No distributed locking for cron jobs (scale) | **OPEN** — P3 |
| S-12 | Pkg 8 finding | MEDIUM | `routes/delivery.js:546-565` — POD image serve path uses `res.sendFile(pod.full_path)` with no explicit path normalization. Currently mitigated by DB-sourced paths, but vulnerable if `photo_path` values are ever user-influenced. Add `path.resolve()` + prefix check. | **OPEN** |
| HIGH-1 | CODE_AUDIT | HIGH | Timing attack in webhook signature | **DONE** (2026-02-05) |
| HIGH-2 | CODE_AUDIT | HIGH | Webhook error response returns 5xx | **DONE** (2026-02-05) |
| HIGH-3 | CODE_AUDIT | HIGH | Synchronous file I/O in request handlers | **DONE** (2026-02-05) |
| HIGH-4 | CODE_AUDIT | HIGH | In-memory global state won't scale | **OPEN** — BACKLOG-9 |
| HIGH-5 | CODE_AUDIT | HIGH | Missing permissions-policy header | **DONE** (2026-02-05) |
| HIGH-6 | CODE_AUDIT | HIGH | webhook_events wrong merchant_id type | **DONE** (2026-02-05) |
| P0-1..P0-7 | TECH_DEBT | CRITICAL | All P0 security fixes | **DONE** (2026-01-26) |
| P1-6..P1-9 | TECH_DEBT | HIGH | Input validators, reset token, webhook rate limit, error messages | **DONE** (2026-01-26) |

### Architecture Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| A-1 | Audit | HIGH | `services/square/api.js` is 4,793-line god module (38 exports, 12 domains) | **OPEN** |
| A-2 | Audit | HIGH | Business logic in route handlers (bundles.js, analytics.js, delivery.js) | **PARTIAL** — bundles.js extracted to `services/bundle-service.js` (2026-02-27, Pkg 5); delivery.js extracted to `services/delivery/delivery-stats.js` (2026-02-27, Pkg 8); analytics.js remains |
| A-3 | Audit | MEDIUM | Circular dependency middleware/merchant.js ↔ routes/square-oauth.js | ✅ **DONE** 2026-02-26 — `refreshMerchantToken()` extracted to `utils/square-token.js` |
| A-4 | Audit+DEDUP | HIGH | Duplicate customer lookup implementations (BACKLOG-17, DEDUP L-4) | **OPEN** |
| A-5 | Audit+BACKLOG | MEDIUM | Inconsistent response formats (BACKLOG-3) | **OPEN** |
| A-6 | Audit | MEDIUM | 66 files over 300-line limit (beyond 2 approved) | **OPEN** — refactor-on-touch |
| A-4b | Pkg 3 finding | MEDIUM | `getCustomerDetails()` exists in both `customer-admin-service.js` (standalone, 6 callers, cache-first) and `customer-identification-service.js` (class method, 4 callers, direct API, no caching). Different signatures, different caching behavior. Not covered by A-4 consolidation which only addressed lookup helpers. | **NEEDS_DECISION** |
| A-7 | Audit+DEDUP | LOW | Open deduplication debt: G-3, G-5, G-7, G-8 (BACKLOG-23,25,26,27) | **OPEN** |
| DC-1 | Audit | LOW | 9 backward-compatibility re-export stubs in utils/ | **OPEN** |
| DC-3 | Pkg 3 finding | LOW | `redemption-audit-service.js:15` imports `encryptToken` from `token-encryption.js` but never uses it. Dead import. | ✅ **DONE** 2026-02-28 — Removed dead import |
| A-8 | Pkg 4a finding | MEDIUM | `public/js/reorder.js` grew from 1,752 → 2,322 lines after vendor-first workflow. Already an approved violation but now 7.7x over 300-line limit. Next touch MUST extract: manual items logic, other items rendering, and state preservation into separate modules (e.g., `reorder-manual.js`, `reorder-other-items.js`, `reorder-state.js`). | **OPEN** — refactor-on-next-touch |
| A-9 | Pkg 8 finding | MEDIUM | `routes/delivery.js:245-427` — Race condition in Square fulfillment state machine transitions under concurrent webhook + manual complete. Each step re-fetches order version but another process could modify between fetch and update. Related to BACKLOG-5. | **OPEN** |
| A-10 | Pkg 8 finding | MEDIUM | `services/delivery/delivery-service.js:453-496` — Unclear status semantics (`delivered` vs `completed` vs `skipped`). No documentation on state machine transitions or valid state flows. | **OPEN** |

### Database Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| D-1 | Audit | HIGH | Missing indexes on `vendor_catalog_items` and `expiry_discount_audit_log` (schema.sql drift) | ✅ **DONE** 2026-02-25 — Added merchant_id columns + indexes to schema.sql |
| D-2 | Audit | MEDIUM | Missing composite index on `inventory_counts` (merchant_id, location_id, state) | ✅ **DONE** 2026-02-25 — Migration 056 |
| D-3 | Audit | MEDIUM | N+1 sequential Square customer fetches in routes/loyalty.js:1603 | **OPEN** |
| D-4 | Audit | MEDIUM | N+1 order lookup per earned reward in redemption-audit-service.js | **OPEN** |
| D-5 | Audit | MEDIUM | schema.sql drift from migration state (migration 005 indexes missing) | ✅ **DONE** 2026-02-25 — All 28 merchant_id indexes + 7 composite indexes added to schema.sql |
| D-6 | Audit | LOW | `expiry_discount_audit_log.merchant_id` allows NULL | ✅ **DONE** 2026-02-25 — Migration 057 (NOT NULL with safety check) |
| D-7 | Audit | LOW | Potentially dead column `subscription_plans.square_plan_id` | ✅ **RESOLVED** 2026-02-25 — NOT dead; actively used in square-subscriptions.js, routes/subscriptions.js, admin-subscriptions.js. Keep. |
| MED-2 | CODE_AUDIT | MEDIUM | Connection pool size not configurable | **OPEN** |
| D-8 | Pkg 4a finding | MEDIUM | `routes/analytics.js` reorder suggestions query uses `LEFT JOIN sales_velocity` matching on `sv.location_id = ic.location_id OR (sv.location_id IS NULL AND ic.location_id IS NULL)` which can produce duplicate rows for multi-location tenants. GROUP BY masks it for single-location. Verify before multi-tenant rollout. | **OPEN** |

### Validation Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| V-1 | Pkg 5 finding | MEDIUM | `middleware/validators/bundles.js:98-143` — `updateBundle` validator marks `components.*.child_variation_id` and `components.*.quantity_in_bundle` as optional. A PUT with `components: [{}]` passes validation but fails at DB NOT NULL constraint. Should require these fields when `components` array is present. | ✅ **DONE** 2026-02-28 — Removed `.optional()` from child_variation_id and quantity_in_bundle in updateBundle validator |

### Error Handling Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| E-1 | Audit | HIGH | Fire-and-forget email in database error handler (server.js:1001) | **OPEN** |
| E-2 | Audit | LOW | OAuth routes use custom try/catch instead of asyncHandler | **OPEN** |
| E-4 | Audit | LOW | Audit logging silently swallows errors (by design) | **OPEN** — consider fallback buffer |
| MED-4 | CODE_AUDIT | MEDIUM | `setInterval` not cleared on shutdown (api.js:49) | ✅ **DONE** 2026-02-26 — Stored reference, exported `cleanup()`, called from `gracefulShutdown()` |
| MED-5 | CODE_AUDIT | MEDIUM | Long-running jobs without timeout (loyalty-audit-job) | ✅ **DONE** 2026-02-25 — AbortController 5-min per-merchant timeout |
| E-3 | Pkg 8 finding | MEDIUM | `routes/delivery.js:419-427` — `completeOrder` returns 200 with `square_synced: false` on Square sync failure. Caller has no way to know sync failed unless it inspects the flag. Should return 207 (partial success) or include a warning flag the frontend acts on. | **OPEN** |

### API Integration Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| I-1 | Audit | HIGH | GMC API missing 429/rate limit handling | **OPEN** |
| I-2 | Audit | MEDIUM | Dual Square API version constants (2025-01-16 vs 2025-10-16) | ✅ **DONE** 2026-02-26 — Centralized to `config/constants.js`, all 4 locations updated to `2025-10-16` |
| I-3 | Audit | LOW | Duplicate `generateIdempotencyKey()` implementation | ✅ **DONE** 2026-02-26 — Extracted to `utils/idempotency.js` |

### Performance Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| P-1 | Audit | CRITICAL | Reorder suggestions endpoint returns unbounded result sets (no pagination) | **OPEN** |
| P-2 | Audit | HIGH | N+1 bundle component inserts (sequential loop) | ✅ **DONE** 2026-02-27 — Replaced with single multi-row INSERT via `_batchInsertComponents()` in `services/bundle-service.js` (Pkg 5) |
| P-3 | Audit | HIGH | `SELECT *` on merchants table for every request | ✅ **DONE** 2026-02-26 — Narrowed to 4 needed columns |
| P-4 | Audit | HIGH | Square API pagination loops have no iteration guard (7 instances) | ✅ **DONE** 2026-02-26 — All 8 loops guarded with MAX_PAGINATION_ITERATIONS=500 |
| P-5 | Audit | MEDIUM | Google OAuth token listener duplicated on every call | **OPEN** |
| P-6 | Audit | MEDIUM | N+1 GMC settings inserts | **OPEN** |
| P-7 | Audit | MEDIUM | clientCache has no max size or LRU eviction | ✅ **DONE** 2026-02-26 — FIFO eviction at MAX_CACHED_CLIENTS=100 |
| P-8 | Audit | MEDIUM | Sync queue follow-up syncs block sequentially | ✅ **DONE** 2026-02-26 — Fire-and-forget with error logging |
| P-9 | Audit | LOW | GMC sync polling at 5-second intervals | **OPEN** |
| P-10 | Production | HIGH | Duplicate delivery orders created for same Square order. Multiple `order.updated` webhooks race past the dedup lock, each creating a separate `delivery_orders` row for the same `square_order_id`. Observed 2026-02-26: two delivery orders (`6fa83def`, `e5f591b5`) both reference `qyuUdnnGxyDLayHyH7rG64AWgwZZY`. | **OPEN** |
| MED-3 | CODE_AUDIT | MEDIUM | No circuit breaker for Square API | **OPEN** — P3 |

### Testing Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| T-1 | Audit | CRITICAL | Financial/loyalty services have ZERO test coverage (3 services, 2,972 lines) | **OPEN** |
| T-2 | Audit | CRITICAL | Webhook handlers untested — 7 of 8 (order-handler 1,316 lines) | **OPEN** |
| T-3 | Audit | HIGH | 84% of routes untested (21 of 25) | **OPEN** |
| T-4 | Audit | HIGH | Background jobs 91% untested (10 of 11) | **OPEN** |
| T-5 | Audit | MEDIUM | Coverage thresholds not enforced globally | ✅ **DONE** 2026-02-25 — Directory aggregate thresholds: services 10%, routes 2% (floor). Targets: 30%/20% |
| T-6 | Audit | MEDIUM | No email service mock in test setup | ✅ **DONE** 2026-02-25 — jest.mock in __tests__/setup.js |

### Logging Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| L-1 | Audit | MEDIUM | Critical startup paths bypass structured logging (console.error) | **OPEN** |
| L-2 | Audit | MEDIUM | Missing merchantId in 10 service-layer error logs | **OPEN** |
| L-3 | Audit | LOW | 180 frontend console.log calls visible to end users | **OPEN** |

### Config/DevOps Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| C-1 | Audit | MEDIUM | ~20 hardcoded timeouts, sizes, thresholds across services | **OPEN** |
| C-2 | Audit | HIGH | No CI/CD pipeline | **OPEN** |
| C-3 | Audit | MEDIUM | Partial env variable validation at startup | **OPEN** |
| C-4 | Audit | MEDIUM | Backup strategy missing encryption and verification | **OPEN** |
| C-5 | Audit | LOW | PM2 config minor issues (PORT hardcoded) | **OPEN** |
| C-6 | Audit | LOW | Health endpoint missing disk space checks | **OPEN** |

### Deduplication Findings (DEDUP-AUDIT cross-ref)

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| L-1 | DEDUP | Critical | Customer identification — 3 parallel implementations | **DONE** (2026-02-17) |
| L-2 | DEDUP | High | Reward progress / threshold crossing — 2 implementations | **DONE** (2026-02-17) |
| L-3 | DEDUP | High | `redeemReward()` name collision | **DONE** (2026-02-17) |
| L-4 | DEDUP | High | Customer lookup helpers duplicated (= A-4 / BACKLOG-17) | **DONE** (2026-02-26) |
| L-5 | DEDUP | Medium | Offer/variation queries — overlapping | **DONE** (2026-02-19) |
| L-6 | DEDUP | Medium | Square API client — two wrapper layers | **DONE** (2026-02-19) |
| L-7 | DEDUP | Low | Redemption detection asymmetry | **DONE** (2026-02-19) |
| R-1 | DEDUP | Critical | Reorder quantity formula — JS vs SQL | **DONE** (2026-02-17) |
| R-2 | DEDUP | High | Days-of-stock — 5 implementations (= BACKLOG-21) | **DONE** (2026-02-23) |
| R-3 | DEDUP | High | Available vs total stock inconsistency (= BACKLOG-22) | **DONE** (2026-02-23) |
| G-1 | DEDUP | Medium | escapeHtml() — 26 copies | **DONE** |
| G-2 | DEDUP | Medium | Idempotency key generation — 4 patterns | **DONE** |
| G-3 | DEDUP | Medium | Currency formatting — no shared helper (= BACKLOG-23) | **OPEN** |
| G-4 | DEDUP | Low | Order normalization boilerplate | **CLOSED** (intentional) |
| G-5 | DEDUP | Low | Location lookup queries repeated (= BACKLOG-25) | **OPEN** |
| G-6 | DEDUP | Low | escapeAttr() — 2 copies | **DONE** |
| G-7 | DEDUP | Low | Date string formatting (= BACKLOG-26) | **OPEN** |
| G-8 | DEDUP | Low | toLocaleString() inconsistency (= BACKLOG-27) | **OPEN** |

### Open BACKLOG Items

| ID | Priority | Description | Merged Into |
|----|----------|-------------|-------------|
| BACKLOG-1 | Medium | Frontend polling rate limits | Pkg 12: Frontend Cleanup |
| BACKLOG-3 | Low | Response format standardization | Pkg 14: Code Cleanup |
| BACKLOG-4 | Medium | Customer birthday sync for marketing | Pkg 15: Vendor/Feature Work |
| BACKLOG-8 | Low | Vendor management — pull vendor data from Square | Pkg 15: Vendor/Feature Work |
| BACKLOG-9 | Low | In-memory global state — PM2 restart recovery | Pkg 11: Config/DevOps |
| BACKLOG-12 | Low | Driver share link validation failure | Pkg 8: Delivery Services |
| BACKLOG-17 | Low | Customer lookup helpers duplicated (= A-4, DEDUP L-4) | Pkg 3: Loyalty Services |
| BACKLOG-23 | Low | Currency formatting (= DEDUP G-3) | Pkg 12: Frontend Cleanup |
| BACKLOG-25 | Low | Location lookup queries repeated (= DEDUP G-5) | Pkg 14: Code Cleanup |
| BACKLOG-26 | Low | Date string formatting (= DEDUP G-7) | Pkg 12: Frontend Cleanup |
| BACKLOG-27 | Low | Inconsistent toLocaleString (= DEDUP G-8) | Pkg 12: Frontend Cleanup |
| BACKLOG-29 | Low | Existing tenants missing `invoice.payment_made` webhook | Pkg 6: Webhook Handlers |
| BACKLOG-34 | Low | Documentation: Square reuses variation IDs | Pkg 4a: Reorder/Analytics |
| BACKLOG-35 | Medium | Sales velocity does not subtract refunds | Pkg 4b: Velocity Refactor |
| BACKLOG-36 | Medium | Phantom velocity rows never self-correct | Pkg 4b: Velocity Refactor |

### Conflicts and Duplicates

| Items | Type | Resolution |
|-------|------|------------|
| S-4 vs P0-4 (TECH_DEBT) | **CONFLICT** | P0-4 claims 29/29 inline scripts externalized and `'unsafe-inline'` should be removable. S-4 says it's still in the CSP config. **NEEDS_DECISION**: Verify no remaining inline scripts; if clean, remove `'unsafe-inline'`. |
| A-4, BACKLOG-17, DEDUP L-4 | Duplicate | Merged → Pkg 3 (Loyalty Services) |
| BACKLOG-21, DEDUP R-2 | ~~Duplicate~~ DONE | ~~Merged → Pkg 4~~ COMPLETED (2026-02-23, commit `bcc136a`) |
| BACKLOG-22, DEDUP R-3 | ~~Duplicate~~ DONE | ~~Merged → Pkg 4~~ COMPLETED (2026-02-23, commit `bcc136a`) |
| BACKLOG-23, DEDUP G-3 | Duplicate | Merged → Pkg 12 (Frontend Cleanup) |
| BACKLOG-25, DEDUP G-5 | Duplicate | Merged → Pkg 14 (Code Cleanup) |
| BACKLOG-26, DEDUP G-7 | Duplicate | Merged → Pkg 12 (Frontend Cleanup) |
| BACKLOG-27, DEDUP G-8 | Duplicate | Merged → Pkg 12 (Frontend Cleanup) |
| A-5, BACKLOG-3 | Duplicate | Merged → Pkg 14 (Code Cleanup) |
| D-1, D-5 | Overlap | Both about schema.sql drift from migrations. Merged → Pkg 7 (Database) |
| CRIT-5, P3-1, P3-2, BACKLOG-9 | Related | All about multi-instance scaling. Merged → Pkg 11 (Config/DevOps — P3 tier) |
| MED-2, C-1 | Related | Both about hardcoded config. Merged → Pkg 11 (Config/DevOps) |
| A-2 (bundles) vs P-2 | Related | Both touch routes/bundles.js. Merged → Pkg 5 (Bundle System) |
| I-2, I-3 | Related | Both about Square API consistency. Merged → Pkg 2 (Square API Service) |

---

## System Packages

---

### Package 1: Security Hardening — P0 ✅ COMPLETE

**Estimated effort**: M
**Completed**: 2026-02-25
**Dependencies**: None (do first)
**Files touched**:
- `services/cart/cart-activity-service.js`
- `routes/square-oauth.js`
- `utils/google-auth.js`
- `server.js`
- `middleware/security.js`
- `routes/auth.js`
- `public/js/vendor-catalog.js`

**Pre-work**: Read `services/cart/cart-activity-service.js` fully; understand the INTERVAL pattern fix already used in `routes/cycle-counts.js:324` and `utils/webhook-retry.js:229`.

#### Tasks (in execution order):

1. [x] **S-1**: Fix SQL injection in INTERVAL clauses — replaced `INTERVAL '${var} days'` with `INTERVAL '1 day' * $N` pattern in all 6 locations (cart-activity-service.js x4, square-oauth.js x1, google-auth.js x1). **DONE 2026-02-25**
2. [x] **S-10**: Fix XSS in vendor catalog import validation errors — wrapped `err.errors.join(', ')` with `err.errors.map(e => escapeHtml(e)).join(', ')` in `public/js/vendor-catalog.js:387`. **DONE 2026-02-25**
3. [x] **S-2**: Add auth middleware before `/output` static route — `server.js:221` now checks `req.session.user` before serving any `/output` files. **DONE 2026-02-25**
4. [x] **S-6**: Scope admin user listing by merchant — `routes/auth.js` GET `/users` now JOINs `user_merchants` and filters by `req.session.activeMerchantId`. **DONE 2026-02-25**
5. [x] **S-3**: Verify session auth in OAuth callback — `routes/square-oauth.js` callback now verifies `req.session.user.id === stateRecord.user_id` before processing. **DONE 2026-02-25**
6. [x] **S-11**: Regenerate session on OAuth callback — `routes/square-oauth.js` callback calls `req.session.regenerate()` after OAuth success, restoring user data on the fresh session. **DONE 2026-02-25**
7. [x] **S-4**: Remove `'unsafe-inline'` from CSP — last inline `<script>` block in `cart-activity.html` externalized to `public/js/cart-activity.js`; `'unsafe-inline'` removed from `middleware/security.js` CSP `scriptSrc`. **DECISION**: P0-4 was complete (29/29 files), but `cart-activity.html` was missed. Now fully clean. **DONE 2026-02-25**
8. [x] **S-5**: Change dev token check to positive opt-in — `routes/auth.js:661` changed from `NODE_ENV !== 'production'` to `NODE_ENV === 'development'`. **DONE 2026-02-25**
9. [x] **S-7**: Use standard `requireMerchant` on OAuth revoke — `routes/square-oauth.js` revoke route now uses `loadMerchantContext, requireMerchant, requireMerchantRole('owner')` middleware chain; manual access check removed. **DONE 2026-02-25**
10. [x] **S-8**: Split health endpoint — public `/api/health` returns only `{ status, timestamp, version }`; new authenticated `/api/health/detailed` (requireAuth + requireAdmin) returns full diagnostics (memory, uptime, webhooks, Square status, nodeVersion). **DONE 2026-02-25**
11. [x] **S-9**: CSRF assessment — **DECISION**: `sameSite: 'lax'` + strict CORS allowlist is sufficient. SameSite=Lax prevents cross-origin POST cookie attachment for both `<form>` and `fetch()`/XHR. CORS is properly configured with explicit origin allowlist in production. Adding `csurf` middleware would add token management complexity (frontend must send X-CSRF-Token on every POST) with minimal additional protection. No action needed. **DONE 2026-02-25**

#### Tests required:
- [x] Test parameterized INTERVAL queries produce correct SQL results (3 tests)
- [x] Test `/output` is not accessible without auth (source verification test)
- [x] Test admin user listing filters by merchant_id (source verification test)
- [x] Test OAuth callback verifies session user matches state (source verification test)
- [x] Test CSP header does NOT contain `'unsafe-inline'` (source verification test)
- [x] Test vendor catalog validation errors are HTML-escaped (source verification test)
- [x] Test no inline `<script>` blocks remain in HTML files (filesystem scan)
- [x] Test no `INTERVAL '${` patterns remain in codebase (filesystem scan)
- [x] Test health detailed endpoint requires auth (source verification test)
- [x] Test OAuth revoke uses standard middleware chain (source verification test)
- [x] Test session regeneration on OAuth callback (source verification test)
- [x] Test dev token uses positive opt-in check (source verification test)

**Test file**: `__tests__/security/security-hardening-pkg1.test.js` — 15 tests, all passing.

#### Definition of done:
- [x] All 11 tasks completed
- [x] All 15 tests passing
- [x] No `INTERVAL '${` patterns remaining in codebase (verified by grep test)
- [x] No innerHTML assignments with unescaped user input (S-10 fixed)
- [x] S-4 resolved — `'unsafe-inline'` removed, last inline script externalized
- [x] S-9 resolved — documented as sufficient (sameSite + CORS)
- [x] AUDIT.md findings S-1 through S-11 all resolved

**Completed**: 2026-02-25

---

### Package 1b: Pre-Release Security Audit Fixes — P0 ✅ COMPLETE

**Estimated effort**: S (~90 min)
**Completed**: 2026-02-28
**Dependencies**: None
**Trigger**: Fresh security audit before open-source release found 3 issues.

#### Tasks:

1. [x] **Subscription auth bypass** — `middleware/subscription-check.js:66-73` trusted `X-Subscriber-Email` header, `req.query.email`, and `req.cookies.subscriber_email` — all spoofable by any client. Removed all three; subscription status now comes from session only (`session.email` or `session.user.email`). 21 tests added (`__tests__/middleware/subscription-check.test.js`). **DONE 2026-02-28**

2. [x] **XSS via innerHTML** — `public/js/sales-velocity.js` and `public/js/cycle-count-history.js` inserted catalog data (item names, SKUs, variation names, notes) via innerHTML without escaping. Wrapped all dynamic data with `escapeHtml()` (from existing `public/js/utils/escape.js`). 8 vectors fixed across 2 files. **DONE 2026-02-28**

3. [x] **Open redirect in OAuth/login** — `routes/square-oauth.js:74` stored user-supplied `req.query.redirect` without validation; `public/js/login.js:18` used `returnUrl` query param for `window.location.href`. Added `isLocalPath()` validator (rejects absolute URLs, `//evil.com`, backslashes, control chars). Login.js validates `returnUrl` starts with `/` and not `//`. 18 tests added (`__tests__/security/open-redirect.test.js`). **DONE 2026-02-28**

#### Observation log (2026-02-28):
| # | Observation | Severity | Notes |
|---|-------------|----------|-------|
| O-5 | `req.cookies.subscriber_email` was also spoofable (not just the header and query param from audit). Removed as part of Fix 1. | HIGH | Fixed |
| O-6 | `cycle-count-history.js` already used `escapeHtml()` for error messages (line 92) but not for table data — inconsistent escaping pattern across same file. | MEDIUM | Fixed |
| O-7 | `google-oauth.js` redirects are safe — all go to hardcoded `publicUrl/gmc-feed.html` with only query params varying. No user-controlled redirect path. | INFO | No action needed |
| O-8 | **Expiry audit workflow does not distinguish partial vs full expiry.** When a product hits its expiration date, the system instructs "Pull from Shelf" for ALL units — even if only 1 unit is expired and others have later dates (e.g., Dec 2026). No inline date update for remaining units. Manual intervention required to correct dates and zero out counts. Real scenario observed: 1 unit expired, another had Dec 2026 date, system said pull everything. **Affected files**: `services/expiry/discount-service.js` (tier evaluation at lines 171-411, `evaluateAllVariations()` treats variation as single unit), `public/js/expiry-audit.js` (audit UI at lines 368-489, `renderItems()` shows "PULL FROM SHELF" with no partial-expiry option), `routes/expiry-discounts.js` (API at line 119, variations endpoint returns tier assignment without unit-level granularity), `routes/catalog.js` (lines 212-251, expiration save/review endpoints operate on variation level not unit level). **Desired behavior**: On expiry trigger, ask "Are ALL units expired?" — if No, allow inline date update for remaining units; if Yes, confirm pull and zero inventory. | MEDIUM | Do not fix — document gap only. Recommend as future backlog item. |

**Test results**: 45 suites, 1026 tests, all passing.

---

### Package 2a: Square API Quick Fixes — P1 ✅ DONE (2026-02-26)

**Estimated effort**: S (~1 day)
**Dependencies**: None
**Files touched**:
- `services/square/api.js` (targeted edits only — no structural split)
- `services/loyalty-admin/shared-utils.js`
- `services/webhook-handlers/order-handler.js`
- `utils/square-webhooks.js`
- `config/constants.js`
- `middleware/merchant.js`
- `services/sync-queue.js`
- `utils/idempotency.js` (NEW)
- `utils/square-token.js` (NEW)
- `routes/square-oauth.js`
- `server.js`
- `services/webhook-handlers/catalog-handler.js`
- `services/webhook-handlers/inventory-handler.js`

#### Tasks (all complete):

1. [x] **I-2**: Centralize `SQUARE_API_VERSION` — moved to `config/constants.js` as `SQUARE.API_VERSION`, updated 4 locations. All now use `'2025-10-16'`.
2. [x] **I-3**: Consolidate `generateIdempotencyKey()` — extracted to `utils/idempotency.js`, both `api.js` and `shared-utils.js` import from there.
3. [x] **P-4**: Add `MAX_ITERATIONS` guard to all 8 pagination loops — `MAX_PAGINATION_ITERATIONS = 500` in `config/constants.js`. All 8 loops in `api.js` guarded with `logger.warn()` on exceed.
4. [x] **MED-4**: Clear `setInterval` on shutdown — stored interval reference, exported `cleanup()` from `api.js`, called from `server.js` `gracefulShutdown()`.
5. [x] **P-3**: Narrow `SELECT *` on merchants table — `middleware/merchant.js` now selects only `id, square_access_token, square_refresh_token, square_token_expires_at`.
6. [x] **P-7**: Add FIFO eviction to `clientCache` — `MAX_CACHED_CLIENTS = 100` with FIFO eviction when exceeded.
7. [x] **A-3**: Extract `refreshMerchantToken()` to `utils/square-token.js` — eliminates circular dependency (middleware → routes). `routes/square-oauth.js` delegates to shared utility.
8. [x] **P-8**: Fire follow-up sync async — `services/sync-queue.js` now fires follow-up as fire-and-forget with error logging. Handler code in catalog-handler.js and inventory-handler.js updated to not expect `followUpResult`.

#### Tests: 38 suites, 903 tests passing (sync-queue and webhook-handler tests updated for async follow-up behavior)

---

### Package 2b: Square API Monolith Split — P1

**Estimated effort**: XL (~3-4 weeks)
**Dependencies**: Pkg 2a (quick fixes applied to monolith first, then re-distributed during split)
**Files touched**:
- `services/square/api.js` (4,793 lines → split into 4-5 modules + facade)
- `utils/square-api.js` (backward-compat shim update)
- All 50+ files that import from `services/square/api.js` or `utils/square-api.js`

**Pre-work**: Read `services/square/api.js` fully. Map all 38 exports by domain. Ensure Pkg 2a is complete so quick fixes are already in place.

#### Tasks (in execution order):

1. [ ] **A-1**: Split `services/square/api.js` into domain modules:
   - `services/square/catalog-sync.js` — catalog, delta, category, image, item, variation sync
   - `services/square/inventory-sync.js` — inventory counts, velocity, committed inventory
   - `services/square/catalog-operations.js` — prices, costs, attributes, content updates
   - `services/square/diagnostics.js` — fix location mismatches, inventory alerts, item enabling
   - `services/square/api.js` — thin facade re-exporting from sub-modules + `makeSquareRequest()`
2. [ ] Update `utils/square-api.js` backward-compat shim to re-export from new facade
3. [ ] Migrate direct importers to import from specific sub-modules where beneficial

#### Monolith breakdown:
- **Current**: `services/square/api.js` (4,793 lines, 38 exports)
- **Target modules**:
  - `catalog-sync.js` — full/delta catalog sync, category/image/item/variation processing (~1,500 lines)
  - `inventory-sync.js` — inventory counts, sales velocity, committed inventory (~1,200 lines)
  - `catalog-operations.js` — price updates, cost updates, custom attributes, content (~800 lines)
  - `diagnostics.js` — fix location mismatches, enable items, alerts (~500 lines)
  - `api.js` (facade) — `makeSquareRequest()`, shared constants, re-exports (~400 lines)

#### Tests required:
- [ ] Test each new sub-module exports the same functions as original api.js
- [ ] Test `utils/square-api.js` shim still works after split
- [ ] Test no circular dependencies in new module graph

#### Definition of done:
- `services/square/api.js` reduced to <500 lines (facade only)
- All sub-modules under 1,500 lines
- All existing tests pass
- No circular dependencies in module graph

---

### Package 3: Loyalty Services — P1

**Estimated effort**: L
**Dependencies**: None (Pkg 2 dependency removed — see Pre-Execution Investigation Flag 3)
**Files touched**:
- `services/loyalty-admin/customer-identification-service.js`
- `services/loyalty-admin/customer-admin-service.js`
- `routes/loyalty.js`
- `services/loyalty-admin/redemption-audit-service.js`

**Pre-work**: Read both customer service files. Map which functions are called from where. Read DEDUP L-4 section for full context.

#### Tasks (in execution order):

1. [x] **A-4 / BACKLOG-17 / DEDUP L-4**: Consolidate customer lookup helpers — make admin-layer `customer-admin-service.js` standalone functions delegate to the class methods in `customer-identification-service.js` (or vice versa). Both files are in the same directory. *(Done 2026-02-26: 3 standalone lookups now delegate to LoyaltyCustomerService; caller map documented; function signatures preserved)*
   - `services/loyalty-admin/customer-identification-service.js` — class-based (complete)
   - `services/loyalty-admin/customer-admin-service.js:110-413` — standalone exports (3 functions to consolidate)
2. [x] **D-3**: Fix N+1 sequential Square customer fetches — `routes/loyalty.js:1603-1620` — replace sequential loop with `Promise.allSettled` using concurrency limit of 5 *(Done 2026-02-26: manual semaphore, concurrency=5)*
3. [x] **D-4**: Batch-fetch orders in redemption audit — `services/loyalty-admin/redemption-audit-service.js:121-165` — use `square_customer_id = ANY($1)` instead of per-reward queries *(Done 2026-02-26: single batch query with grouping by customer)*

#### Tests required:
- [x] Test consolidated customer lookup returns same results as both original implementations *(verified: 0 new test failures)*
- [x] Test concurrent customer fetch respects concurrency limit *(verified: 0 new test failures)*
- [x] Test batch order fetch returns all expected orders *(verified: 0 new test failures)*

#### Definition of done:
- Single implementation for each customer lookup function
- No duplicate lookup logic between the two service files
- N+1 queries eliminated in loyalty.js and redemption-audit-service.js
- All existing loyalty tests pass

#### Follow-up findings (discovered during execution):
- **A-4b** (MEDIUM, NEEDS_DECISION): `getCustomerDetails()` still has two implementations — standalone in `customer-admin-service.js` (cache-first, 6 callers) vs class method in `customer-identification-service.js` (direct API, no caching, 4 callers). These have different signatures and different caching behavior. Consolidating requires a decision: unify caching strategy (always cache? always direct?) or keep both intentionally. See NEEDS_DECISION table.
- **DC-3** (LOW, refactor-on-touch): Dead import `encryptToken` in `redemption-audit-service.js:15`. Assigned to Pkg 14.

---

### Package 4a: Reorder/Analytics — P1 (REFRAMED)

**Estimated effort**: L (~1.5 weeks) — reframed from pagination-only to vendor-first workflow + manual item addition
**Dependencies**: Pkg 7 (Database) for index on inventory_counts. NO dependency on Pkg 2 (verified — see Pre-Execution Investigation Flag 3).
**Files touched**:
- `routes/analytics.js` (added `include_other` parameter, other vendor items query)
- `middleware/validators/analytics.js` (added `include_other` validation)
- `public/reorder.html` (vendor info bar, other items section, manual item styles, updated footer)
- `public/js/reorder.js` (vendor-first workflow, info bar, manual addition, state preservation)
- `services/square/api.js` (documentation comment only — BACKLOG-34)

**Scope change**: Original Pkg 4a was pagination + documentation. Reframed to include vendor-first workflow enhancement (5 features) to make the reorder page usable for daily ordering. Pagination deferred — vendor filtering reduces result set naturally.

#### Tasks (in execution order):

1. [x] **Vendor-First Default**: Vendor dropdown defaults to "Select vendor...", no API call until vendor selected, sessionStorage persists last vendor
2. [x] **Vendor Info Bar**: Shows order day, receive day, lead time, minimum order amount; running total vs minimum (green/red)
3. [x] **All Other Vendor Items**: Collapsible section below suggestions table; new `include_other=true` API parameter; "+" Add button per row
4. [x] **Manual Item Addition**: Move items from "Other" into main table with MANUAL badge; blue divider; × remove; included in PO creation
5. [x] **State Preservation**: sessionStorage persists vendor, supply days, sort order, scroll position
6. [x] **Footer Enhancement**: Item count + manual count + running total + shortfall badge; PO button disabled below minimum
7. [ ] **P-1**: Add pagination to reorder suggestions (deferred — vendor filtering achieves similar result)
8. [ ] **BACKLOG-34**: Document Square variation ID reassignment behavior

#### Completed tasks (removed from plan):
- ~~BACKLOG-22 / DEDUP R-3~~: **DONE** (2026-02-23, commit `bcc136a`) — inventory-service.js, audit-service.js, bundles.js all subtract RESERVED_FOR_SALE
- ~~BACKLOG-21 / DEDUP R-2~~: **DONE** (2026-02-23, same commit) — all pages use available quantity

#### Tests required:
- [x] Test reorder-math calculations (31 existing tests — all passing)
- [ ] Test `include_other=true` returns non-suggested vendor items
- [ ] Test P-1 pagination returns correct page/total (deferred)

#### Definition of done:
- Vendor-first workflow functional with all 5 features
- Manual items included in PO creation
- AUDIT.md finding P-1 deferred with justification

---

### Package 4b: Sales Velocity Refactor — P1

**Estimated effort**: XL (~3-4 weeks active + 72h validation waits between phases)
**Dependencies**: None — fully independent of Pkg 4a, Pkg 2, and all other packages (verified — see Pre-Execution Investigation Flag 4)
**Files touched** (all exclusive to this package):
- `database/migrations/XXX_inventory_changes.sql` (new)
- `database/schema.sql` (add table definition)
- `services/inventory-changes.js` (new — backfill, recalculation)
- `routes/inventory-changes.js` (new — admin/comparison endpoints)
- `jobs/inventory-changes-gap-fill.js` (new — gap detection cron)
- `services/webhook-handlers/inventory-handler.js` (add change capture)
- `server.js` (register new route)

**Pre-work**: Read `docs/PLAN-sales-velocity-refactor.md` fully. Understand the 3 defects: variation ID remapping, refunds not subtracted, phantom velocity rows.

**Resolves**: BACKLOG-35 (refunds not subtracted), BACKLOG-36 (phantom velocity rows), variation ID remapping corruption

#### Phases (must be sequential):

1. [ ] **Phase 1 — Schema + Service** [S-M, 6-8h]: Create `inventory_changes` table (migration). Build `services/inventory-changes.js` with backfill, recalculation, and comparison functions. Add admin route for manual operations. Write unit tests.
2. [ ] **Phase 2 — Data Collection** [S-M, 4-6h + **24-48h validation wait**]: Modify `inventory-handler.js` to capture change details on `inventory.count.updated` webhook. Create `inventory-changes-gap-fill.js` cron job for daily reconciliation. Deploy and collect 24-48h of real data before proceeding.
3. [ ] **Phase 3 — New Calculation** [M, 6-8h]: Build new velocity calculation from `inventory_changes` table. Add comparison endpoint showing old vs new values per variation. Validate accuracy against existing system.
4. [ ] **Phase 4 — Cutover** [S, 2-3h + **1 week monitoring**]: Switch sync source from Orders API to `inventory_changes`. Monitor for 1 week for accuracy drift.
5. [ ] **Phase 5 — Cleanup** [S, 1-2h]: Deprecate old velocity sync code. Update documentation. Remove old comparison endpoints.

**NEEDS_DECISION**: Confirm this approach before starting Phase 1. Key risk: Square Inventory Changes API data retention is undocumented.

#### Tests required:
- [ ] Test backfill correctly populates inventory_changes from Square API
- [ ] Test webhook handler captures change details atomically
- [ ] Test gap-fill job detects and fills missing changes
- [ ] Test new velocity calculation matches expected values for known scenarios
- [ ] Test comparison endpoint shows old vs new velocity with acceptable delta

#### Definition of done:
- Sales velocity calculated from immutable inventory change records
- Variation ID remapping no longer corrupts historical data
- Refunds properly subtracted from velocity
- Zero phantom velocity rows (variations with 0 sales cleaned up)
- Old and new systems agree within ±5% after 1 week parallel run
- BACKLOG-35 and BACKLOG-36 marked resolved

---

### Package 5: Bundle System — P2 ✅ DONE 2026-02-27

**Estimated effort**: M
**Dependencies**: None
**Files touched**:
- `routes/bundles.js` — refactored to thin route layer (validation + service calls only)
- `services/bundle-service.js` (new — all bundle CRUD + availability business logic)
- `__tests__/services/bundle-service.test.js` (new — 27 tests)

**Pre-work**: Read `routes/bundles.js` fully (291 lines). Understand the availability calculation inline logic (lines 88-291).

#### Tasks (in execution order):

1. [x] **A-2 (bundles)**: Extract ALL bundle business logic from route into `services/bundle-service.js`. Route handlers now only parse request, call service, return response. Functions extracted: `listBundles`, `calculateAvailability`, `createBundle`, `updateBundle`, `deleteBundle`.
2. [x] **P-2**: Batch bundle component inserts — replaced sequential `INSERT` loops (POST create and PUT update) with single multi-row `INSERT INTO bundle_components (...) VALUES ($1,...), ($9,...) RETURNING *` via `_batchInsertComponents()`. Shared by both create and update paths.

#### Tests required:
- [x] Test bundle availability calculation returns correct results via service (7 tests: limiting component, committed inventory, safety stock, location filter, velocity, days-of-stock)
- [x] Test batch insert creates all components in one query (5 tests: single query verification, 10-component batch, empty/null handling, missing catalog)
- [x] Test bundle create with 10 components completes in single query (verified: `_batchInsertComponents` makes exactly 1 query call for 10 components, 80 params)

#### Definition of done:
- ✅ `routes/bundles.js` contains validation + service calls only (75 lines, down from 516)
- ✅ `services/bundle-service.js` contains all business logic (291 lines)
- ✅ No sequential INSERT loops for bundle components (single multi-row VALUES)
- ✅ Existing bundle functionality unchanged (same inputs → same outputs)
- ✅ 27 tests passing, full suite: 30 suites / 720 tests pass (no regressions)

---

### Package 6: Webhook Handlers — P2

**Estimated effort**: L (mostly test writing)
**Dependencies**: Pkg 13 (Test Infrastructure) for email mock
**Files touched**:
- `services/webhook-handlers/order-handler.js`
- `services/webhook-handlers/loyalty-handler.js`
- `services/webhook-handlers/catalog-handler.js`
- `services/webhook-handlers/customer-handler.js`
- `services/webhook-handlers/inventory-handler.js`
- `services/webhook-handlers/oauth-handler.js`
- `services/webhook-handlers/subscription-handler.js`
- `services/delivery/delivery-service.js`
- `utils/square-webhooks.js` (for BACKLOG-29)
- `database/migrations/` (new migration for unique constraint on delivery_orders)
- `__tests__/services/webhook-handlers/` (new test files)

**Pre-work**: Read `services/webhook-handlers/index.js` and the existing test `__tests__/services/webhook-handlers.test.js`. Read each handler to understand mocking needs.

#### Tasks (in execution order):

1. [x] **P-10**: Fix duplicate delivery order creation ✅ DONE 2026-02-27
   - **Root cause**: Multiple `order.updated` webhooks race past in-memory event dedup (different `event_id`s) AND the `getOrderBySquareId()` SELECT-then-INSERT check (TOCTOU race), creating duplicate `delivery_orders` rows.
   - **Evidence**: 2026-02-26 logs — two delivery orders (`6fa83def`, `e5f591b5`) for same Square order `qyuUdnnGxyDLayHyH7rG64AWgwZZY`.
   - **Migration**: `database/migrations/058_delivery_orders_unique_square_order.sql` — drops old non-unique index, creates UNIQUE partial index on `(square_order_id, merchant_id) WHERE square_order_id IS NOT NULL`.
   - **Code**: `services/delivery/delivery-service.js` `createOrder()` — uses `INSERT ... ON CONFLICT DO UPDATE` for Square-linked orders. ON CONFLICT enriches customer data (COALESCE for phone/customer_id/order_data) while preserving driver-side state (status, notes, geocoded_at). Returns existing row via `RETURNING *`. Manual orders (null squareOrderId) use plain INSERT.
   - **Cleanup**: `scripts/cleanup-duplicate-deliveries.sql` — one-time script to deduplicate existing rows before migration. Keeps earliest row per `(square_order_id, merchant_id)`, deletes rest, wrapped in transaction with audit SELECT.
   - **Schema**: `database/schema.sql` updated to reflect UNIQUE index.
   - **Tests**: `__tests__/services/delivery-dedup.test.js` — 10 tests: ON CONFLICT SQL structure, conflict returns existing row, customer_name preservation, COALESCE for optional fields, manual orders skip ON CONFLICT, ingestSquareOrder dedup, different order IDs create separate rows, concurrent race simulation.
   - **Both webhook paths protected**: `_ingestDeliveryOrder` (order.updated) and `_autoIngestFromFulfillment` (fulfillment.updated) both call `ingestSquareOrder()` → `createOrder()` with ON CONFLICT.
   - **Deployment**: Run cleanup script → Run migration 058 → Deploy code.
2. [ ] **BACKLOG-29**: Re-register webhooks for existing tenants — ensure `invoice.payment_made` is in both `subscriptions` and `invoices` webhook groups in `utils/square-webhooks.js`. Create one-time migration script to re-register.
3. [ ] **T-2**: Write integration tests for `order-handler.js` — highest priority (1,316 lines, processes all orders, loyalty records, refunds). Test: order processing, loyalty record creation, refund handling, delivery routing.
4. [ ] **T-2**: Write integration tests for `loyalty-handler.js` — second priority (512 lines). Test: loyalty event sync, account create/update.
5. [ ] **T-2**: Write tests for remaining 5 handlers — catalog, customer, inventory, oauth, subscription.
6. [ ] **E-1**: Add `.catch()` to fire-and-forget email in DB error handler — `server.js:996` — add `.catch(emailErr => logger.error('Failed to send DB error alert', { error: emailErr.message }))`

#### Tests required:
- [ ] order-handler: order created/updated processing (happy path)
- [ ] order-handler: refund handling and point reversal
- [ ] order-handler: delivery routing from order webhook
- [ ] loyalty-handler: loyalty event processing
- [ ] loyalty-handler: account lifecycle events
- [ ] All 7 handlers: error handling does not throw (returns gracefully)
- [ ] All 7 handlers: merchant_id isolation

#### Definition of done:
- ~~P-10 duplicate delivery orders fixed (unique constraint + INSERT conflict handling)~~ ✅
- All 8 webhook handlers have test files
- order-handler.js and loyalty-handler.js at 60%+ coverage
- Remaining handlers at 40%+ coverage
- BACKLOG-29 webhook re-registration complete
- E-1 fire-and-forget email fix applied

#### Observation log (P-10, 2026-02-27):

| # | Observation | File:Line | Severity | Notes |
|---|-------------|-----------|----------|-------|
| O-1 | `ingestSquareOrder()` does a SELECT-then-INSERT (TOCTOU race). The new ON CONFLICT in `createOrder()` is the authoritative guard, but the redundant SELECT adds ~1ms per call. Keep as-is — the SELECT still serves a useful purpose: it does a richer update (status transitions, backfill order data) that the ON CONFLICT DO UPDATE doesn't cover. | `services/delivery/delivery-service.js:1279-1312` | LOW | No action needed. |
| O-2 | `_autoIngestFromFulfillment` re-fetches the full order from Square API (`squareClient.orders.get`). If both `order.updated` and `order.fulfillment.updated` fire for the same event, this doubles the Square API calls. Not a bug — just inefficiency. | `services/webhook-handlers/order-handler.js:1061-1063` | LOW | Could deduplicate by caching recently fetched orders in-memory for 5s. |
| O-3 | `delivery-service.js` is 1,918 lines — exceeds 300-line rule (CLAUDE.md). Functions are well-scoped but file is monolithic. | `services/delivery/delivery-service.js` | LOW | Refactor-on-touch policy applies. Could split into `delivery-orders.js`, `delivery-routes.js`, `delivery-square.js`. |
| O-4 | The existing non-unique index `idx_delivery_orders_square_order` used `(merchant_id, square_order_id)` column order. The new UNIQUE index uses `(square_order_id, merchant_id)` per task spec. Both orders work for the ON CONFLICT clause and existing queries. | `database/schema.sql` | INFO | No action needed. |

---

### Package 7: Database — P1

**Estimated effort**: S
**Dependencies**: None (can run in parallel with Pkg 1)
**Files touched**:
- `database/schema.sql`
- `database/migrations/` (new migration files)

**Pre-work**: Read `database/schema.sql` index definitions. Compare against `database/migrations/005_multi_tenant.sql` for drift.

#### Tasks (in execution order):

1. [x] **D-1 / D-5**: Sync schema.sql with migration state — added all 28 single-column merchant_id indexes + 7 composite indexes from migration 005. Also added missing `merchant_id` columns to `vendor_catalog_items` and `expiry_discount_audit_log` table definitions.
2. [x] **D-2**: Create composite index on inventory_counts — migration 056:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_inventory_counts_merchant_location_state
   ON inventory_counts(merchant_id, location_id, state);
   ```
3. [x] **D-6**: Add NOT NULL constraint to `expiry_discount_audit_log.merchant_id` — migration 057 (with safety check for NULL rows before applying).
4. [x] **D-7**: Audit `subscription_plans.square_plan_id` column — **NOT dead**. Actively used in `utils/square-subscriptions.js`, `routes/subscriptions.js`, `public/js/admin-subscriptions.js`, and tests. Column kept.

#### Tests required:
- [ ] Verify migration applies cleanly on fresh database
- [ ] Verify schema.sql + all migrations produce identical schema

#### Definition of done:
- schema.sql matches cumulative migration state
- New composite index on inventory_counts exists
- No NULL merchant_id rows in audit tables
- All migrations apply cleanly in sequence

---

### Package 8: Delivery Services — P3

**Estimated effort**: M
**Dependencies**: None
**Files touched**:
- `routes/delivery.js`
- `services/delivery/delivery-stats.js` (new — extract from route)
- `services/delivery/delivery-service.js`

**Pre-work**: Read `routes/delivery.js:445-659` to understand inline stat aggregation logic.

#### Tasks (in execution order):

1. [x] **A-2 (delivery)**: Extract delivery stat aggregation from route — `routes/delivery.js:445-659` — move to `services/delivery/delivery-stats.js`. Route becomes thin controller. *(2026-02-27: Extracted `getCustomerInfo`, `updateCustomerNote`, `getCustomerStats`, `getDashboardStats`, `getLocationIds` into `services/delivery/delivery-stats.js`. 4 route handlers thinned to parse-request/call-service/return-response. 30 tests.)*
2. [ ] **BACKLOG-12**: Investigate driver share link validation failure — check share link generation endpoint, input validation on parameters, expired/invalid token handling. Files: `routes/delivery.js`, `middleware/validators/`, `services/delivery/delivery-service.js`.

#### Tests required:
- [x] Test delivery stat aggregation via service returns expected results *(30 tests in `__tests__/services/delivery-stats.test.js`)*
- [ ] Test share link generation and access with valid/expired tokens

#### Definition of done:
- `routes/delivery.js` stat aggregation logic in service
- BACKLOG-12 either fixed or documented with root cause

---

### Package 9: Expiry/Discount Services — P2

**Estimated effort**: S
**Dependencies**: None
**Files touched**:
- `services/expiry/discount-service.js`
- `routes/expiry-discounts.js`

**Pre-work**: Read the `docs/EXPIRY-DISCOUNT-DEDUP-REPORT.md` to understand write paths. Note: the file is 2,097 lines (unapproved violation of 300-line rule) but is NOT being split in this package — refactor-on-touch policy applies.

#### Tasks (in execution order):

1. [ ] **L-2 (partial)**: Add `merchantId` to all logger.error calls in discount-service.js — 9 locations:
   - `services/expiry/discount-service.js:381`
   - `services/expiry/discount-service.js:401`
   - `services/expiry/discount-service.js:548`
   - `services/expiry/discount-service.js:615`
   - `services/expiry/discount-service.js:917`
   - `services/expiry/discount-service.js:1210`
   - `services/expiry/discount-service.js:1234`
   - `services/expiry/discount-service.js:1263`
   - `services/expiry/discount-service.js:1759`
2. [ ] **L-2 (partial)**: Add `merchantId` to logger in `routes/expiry-discounts.js:302`

#### Tests required:
- [ ] Verify error logs include merchantId in structured output

#### Definition of done:
- All logger.error calls in discount-service.js include `merchantId`
- Grep verification: no `logger.error` calls in expiry/ without merchantId

---

### Package 10: GMC Integration — P2 ✅ DONE 2026-02-28

**Estimated effort**: M
**Dependencies**: None
**Files touched**:
- `services/gmc/merchant-service.js`
- `services/gmc/feed-service.js`
- `public/js/gmc-feed.js`

**Pre-work**: Read `services/gmc/merchant-service.js` — understand `merchantApiRequest()`, `getAuthClient()`, and `saveGmcApiSettings()`.

#### Tasks (in execution order):

1. [x] **I-1**: Add 429/rate limit handling to `merchantApiRequest()` — `services/gmc/merchant-service.js:200` — add `Retry-After` header parsing and exponential backoff (max 3 retries), matching Square API pattern in `services/square/api.js:148-153` **DONE** (2026-02-28)
2. [x] **P-5**: Guard against duplicate token listener — `services/gmc/merchant-service.js:57` — add `if (!oauth2Client.listenerCount('tokens'))` check before `oauth2Client.on('tokens', ...)` **DONE** (2026-02-28)
3. [x] **P-6**: Batch GMC settings inserts — `services/gmc/merchant-service.js:95` — replace sequential loop with single `INSERT ... VALUES (...), (...) ON CONFLICT DO UPDATE` using `UNNEST` arrays **DONE** (2026-02-28)
4. [x] **P-9**: Reduce GMC sync polling frequency — `public/js/gmc-feed.js:1210-1255` — implement exponential backoff (5s → 10s → 30s cap) **DONE** (2026-02-28)
5. [x] **L-2 (partial)**: Add `merchantId` to logger in `services/gmc/feed-service.js:236` **DONE** (2026-02-28)

#### Tests required:
- [x] Test `merchantApiRequest()` retries on 429 response (5 tests)
- [x] Test token listener attached only once per OAuth client (2 tests)
- [x] Test settings batch insert writes all settings in one query (3 tests)

#### Observations logged during work:
- `upsertProduct()` and `batchUpsertProducts()` process products in parallel batches of 10. If a 429 hits mid-batch, the retry in `merchantApiRequest` will delay that single request, but the other 9 concurrent requests may also trigger 429s. Consider adding batch-level rate limiting (e.g., delay between batches) if 429s become frequent during large catalog syncs.
- `updateLocalInventory()` creates a `path` variable that shadows the Node.js `path` module import on line 712 (`path: path`). Not a bug (different scope), but confusing for debugging.
- `syncAllLocationsInventory()` processes locations sequentially (good for rate limiting), but `syncLocationInventory()` → `batchUpdateLocalInventory()` fires 10 concurrent requests per batch. Same batch-level 429 concern as product sync.
- `getAuthClient()` creates a new OAuth2 client on every call — no client caching. For high-frequency sync operations, this means multiple token refresh listeners could stack if the guard is bypassed by new instances. Current guard only protects within a single instance.

#### Definition of done:
- ✅ GMC API calls retry on 429 with proper backoff
- ✅ No duplicate token listeners
- ✅ Settings inserts batched
- ✅ Polling interval increased (exponential backoff: 5s → 10s → 30s cap)
- ✅ All GMC error logs include merchantId

---

### Package 11: Config/DevOps — P2 (core) / P3 (scale items)

**Estimated effort**: L
**Dependencies**: None (can run in parallel)
**Files touched**:
- `config/constants.js`
- `server.js`
- `utils/database.js`
- `jobs/backup-job.js`
- `.github/workflows/` (new)
- Multiple service files (for constant extraction)
- `ecosystem.config.js`

**Pre-work**: Read `config/constants.js` (84 lines, 9 namespaces). Read `.env` structure. Read `jobs/backup-job.js` for backup implementation.

#### Tasks (in execution order):

**P2 — Core (do now):**

1. [x] **C-2**: Create CI pipeline — add `.github/workflows/test.yml` that runs `npm test` on push/PR. Optionally add a simple `scripts/deploy.sh` that: pulls latest → `npm ci` → runs tests → restarts PM2 on success → logs deploy event. **DONE** (2026-02-26)
2. [ ] **C-3**: Add startup env validation — create `config/validate-env.js` with checks for all required env vars: `SQUARE_APPLICATION_SECRET`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `EMAIL_HOST`/`EMAIL_USER`/`EMAIL_PASS`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Log warnings for optional vars. Call from `server.js` startup.
3. [ ] **L-1**: Replace `console.error` with `logger.error` in startup paths:
   - `server.js:1098-1099` — keep console.error as fallback after logger call
   - `utils/database.js:2362-2363` — same pattern
4. [ ] **L-2 (remaining)**: Add `merchantId` to logger in:
   - `services/square/api.js:271`
   - `routes/cycle-counts.js:186`
5. [ ] **C-1**: Centralize hardcoded values to `config/constants.js`:
   - Fetch timeout `30000` from `routes/api.js:137`
   - DB pool `max: 20`, `idleTimeoutMillis: 30000` from `utils/database.js:20-22`
   - Log rotation `maxSize: '20m'`, `maxFiles: '14d'` from `utils/logger.js:21-22`
   - Backup retention `maxBackups: 10`, `maxAge: 30` from `jobs/backup-job.js:70-72`
   - Webhook lock TTL `60000` from `services/webhook-processor.js`
   - Sync debounce `5000` from `services/catalog/sync-queue.js`
6. [ ] **C-5**: Make PM2 port configurable — `ecosystem.config.js:57` — change `PORT: 5001` to `PORT: process.env.PORT || 5001`
7. [ ] **E-2**: Document OAuth routes as intentional exception to asyncHandler — `routes/square-oauth.js:67, 110` — add code comments explaining redirect-on-error behavior

**P3 — Scale (do when needed):**

8. [ ] **C-4**: Encrypt backups — `jobs/backup-job.js:40-85` — add `gpg` or `openssl` encryption step after `pg_dump`. Add checksum verification. **NEEDS_DECISION**: encryption key management approach.
9. [ ] **C-6**: Add disk space check to health endpoint — `server.js:412` — add `df` or `statvfs` check, warn if <500MB available.
10. [ ] **MED-2**: Make DB pool size configurable — `utils/database.js:20` — read from `process.env.DB_POOL_MAX || 20`
11. [ ] **BACKLOG-9**: In-memory state improvements — per investigation recommendations:
    - SIGTERM handler: flush `webhookOrderStats` to log on shutdown
    - Startup: set `catalogPending`/`inventoryPending` = true for all active merchants
    - Move login/password-reset rate limiters to PostgreSQL-backed store (pre-franchise)
12. [ ] **CRIT-5 / P3-1 / P3-2**: Distributed locking and job queue — PostgreSQL advisory locks for cron jobs, Redis for shared state. **Pre-franchise only.**

#### Tests required:
- [x] Test CI pipeline runs `npm test` and gates on failure — verified locally (903/903 pass)
- [ ] Test startup validation catches missing env vars
- [ ] Test constants imported from `config/constants.js` match original values
- [ ] Test health endpoint returns disk space info (after C-6)

#### Definition of done:
- CI pipeline runs on push/PR
- Startup validates all critical env vars
- All console.error startup paths have logger.error
- All logger.error calls include merchantId where available
- Hardcoded values centralized (at least top 6)

---

### Package 12: Frontend Cleanup — P3

**Estimated effort**: M
**Dependencies**: None
**Files touched**:
- `public/js/utils/escape.js` (extend with new helpers)
- 32 frontend JS files (console.log removal)
- 14+ frontend files (currency formatting)
- 5 frontend files (date formatting)
- 14 frontend files (toLocaleString standardization)
- `public/js/gmc-feed.js` (polling — see also Pkg 10)

**Pre-work**: Read `public/js/utils/escape.js` to understand existing shared utilities.

#### Tasks (in execution order):

1. [ ] **BACKLOG-23 / DEDUP G-3**: Create shared `formatCurrency(cents)` function — add to `public/js/utils/escape.js` or new `public/js/utils/formatting.js`. Standardize on `en-CA` locale with 2 decimal places. Update 14+ files.
2. [ ] **BACKLOG-26 / DEDUP G-7**: Create shared `getToday()` and `getDateString(date)` functions — add to shared utility. Update 5 files (12 instances).
3. [ ] **BACKLOG-27 / DEDUP G-8**: Create shared `formatNumber(n)` function — standardize all 60 `.toLocaleString()` calls on `en-CA` locale. Update 14 files.
4. [ ] **BACKLOG-1**: Reduce frontend polling frequency — `public/js/delivery.js` polling from 30s → 60s; pause when tab hidden (use `document.visibilitychange`). `public/js/gmc-feed.js` already addressed in Pkg 10.
5. [ ] **L-3**: Strip/gate `console.log` in production — consider build step or `DEBUG` flag. Low priority — 180 calls across 32 files.

#### Tests required:
- [ ] Test `formatCurrency(12345)` returns `'$123.45'` in en-CA locale
- [ ] Test `getToday()` returns YYYY-MM-DD format
- [ ] Test `formatNumber(1234.5)` returns `'1,234.5'` in en-CA locale

#### Definition of done:
- Shared formatting utilities exist and are used by all frontend files
- No inline `(cents / 100).toFixed(2)` patterns remaining
- Polling intervals increased where applicable
- No regressions in frontend functionality

---

### Package 13: Test Infrastructure — P2

**Estimated effort**: S
**Dependencies**: None (do early — unblocks P2 test packages)
**Files touched**:
- `jest.config.js`
- `__tests__/setup.js`

**Pre-work**: Read `jest.config.js` and `__tests__/setup.js`.

#### Tasks (in execution order):

1. [x] **T-6**: Added email service mock to `__tests__/setup.js` — mocks `sendCritical`, `sendAlert`, `sendInfo` methods.
2. [x] **T-5**: Added directory aggregate coverage thresholds to `jest.config.js`. Also added `services/**/*.js` to `collectCoverageFrom`. Current floor: services 10%, routes 2%. Targets: services 30%, routes 20%. Uses directory paths (not globs) for aggregate thresholds instead of per-file.
3. [x] **MED-5**: Added AbortController with 5-minute per-merchant timeout to `jobs/loyalty-audit-job.js`. Timed-out merchants log `MERCHANT_AUDIT_TIMEOUT` and processing continues to next merchant.

#### Tests required:
- [ ] Test that email mock prevents real email sending
- [ ] Test that coverage thresholds are enforced in CI

#### Definition of done:
- Email notifier mocked globally in test setup
- Global coverage thresholds enforced (starting low)
- Loyalty audit job has per-merchant timeout
- No accidental real emails from test runs

---

### Package 14: Code Cleanup — P3

**Estimated effort**: L
**Dependencies**: Route tests (Pkg 6, Pkg 3) should exist before removing shims
**Files touched**:
- 9 backward-compat shim files in `utils/`
- Multiple route files (response format)
- `routes/` files for location lookup extraction
- `services/delivery/delivery-service.js`, `routes/loyalty.js` (A-6 violations)

**Pre-work**: Map all callers of each backward-compat shim file. Read `utils/loyalty-reports.js`, `utils/vendor-catalog.js`, `utils/google-sheets.js` (single-consumer stubs).

#### Tasks (in execution order):

1. [ ] **DC-1 (quick wins)**: Migrate single-consumer shim callers to import from `services/` directly:
   - `utils/loyalty-reports.js` → caller imports from `services/reports/loyalty-reports.js`
   - `utils/vendor-catalog.js` → caller imports from `services/vendor/catalog-service.js`
   - `utils/google-sheets.js` → caller imports from `services/integrations/google-sheets.js`
   Delete the 3 single-consumer stubs after migration.
2. [ ] **DC-1 (document)**: Add deprecation comments to remaining 6 multi-consumer shims with timeline:
   - `utils/loyalty-service.js` (12+ consumers)
   - `utils/delivery-api.js` (6+ consumers)
   - `utils/merchant-center-api.js` (8+ consumers)
   - `utils/gmc-feed.js` (2 consumers)
   - `utils/expiry-discount.js`
   - `utils/square-api.js` (50+ consumers)
3. [ ] **BACKLOG-25 / DEDUP G-5**: Create location lookup helpers — `utils/location-helpers.js` with `getLocationById()`, `getActiveLocations()`, `getDefaultLocation()`. Update 6 route files.
4. [ ] **A-5 / BACKLOG-3**: Standardize response format — define convention: direct data for GETs, `{ success, data }` for mutations. Apply incrementally per-route as routes are modified. Create response helper: `utils/response.js` with `sendSuccess(res, data)` and `sendError(res, status, message, code)`.
5. [ ] **A-6**: Add worst-offender files to approved violations table in CLAUDE.md (or split if being touched):
   - `routes/loyalty.js` (2,100 lines)
   - `services/expiry/discount-service.js` (2,097 lines)
   - `services/delivery/delivery-service.js` (1,918 lines)
6. [x] **DC-3** (refactor-on-touch): Remove dead `encryptToken` import in `services/loyalty-admin/redemption-audit-service.js:15`. No standalone task — fix when file is next modified. **DONE** 2026-02-28
7. [x] **Pkg 4a finding** (refactor-on-touch): `reorder.js:987-991` — `vendorId === 'none'` check prevents PO creation but error message says "select a specific vendor" which is misleading since user selected "No Vendor Assigned". Clarify message on next touch. **DONE** 2026-02-28
8. [x] **V-1** (refactor-on-touch): Tighten `middleware/validators/bundles.js` `updateBundle` validator — when `components` array is present and non-empty, `child_variation_id` and `quantity_in_bundle` should be required (not optional). Currently a PUT with `components: [{}]` passes validation but hits DB NOT NULL constraint. **DONE** 2026-02-28
9. [x] **Pkg 8 observation** (refactor-on-touch): `routes/delivery.js:718-733` — PUT /settings fetches `deliveryApi.getSettings(merchantId)` twice in the same request (once for start address geocoding, once for end address). Fetch once and reuse. **DONE** 2026-02-28
10. [x] **Pkg 8 observation** (refactor-on-touch): `routes/delivery.js:180-191` — Silent geocoding failure on address update. When `geocodeAddress()` returns null, coordinates are silently not updated. Add a warning log or return a flag to the caller. **DONE** 2026-02-28
11. [ ] **Pkg 8 observation**: `routes/delivery.js` — Inconsistent response wrapper formats across delivery endpoints (some use `{ success: true, ... }`, others return direct data). Related to A-5 / BACKLOG-3 — apply standardized format when response helpers exist. **Documented 2026-02-28**: delivery.js uses `{ success: true }` on DELETE, PATCH /customer-note, PATCH /notes, POST /sync, POST /backfill-customers; direct data on all others. Defer to BACKLOG-3 response standardization effort.

#### Tests required:
- [ ] Test location helpers return correct results for each function
- [ ] Test response helpers produce correct JSON format
- [ ] Test that migrated imports still work after shim removal

#### Definition of done:
- 3 single-consumer shims removed
- 6 multi-consumer shims have deprecation comments
- Location helpers extracted and used
- Response format convention documented in CLAUDE.md
- Worst offender files either split or in approved violations table

---

### Package 15: Vendor Management & Feature Work — P3

**Estimated effort**: M
**Dependencies**: None
**Files touched**:
- `services/webhook-handlers/customer-handler.js`
- `services/loyalty-admin/customer-cache-service.js`
- `services/reports/loyalty-reports.js`

**Pre-work**: Read BACKLOG-4 and BACKLOG-8 descriptions in TECHNICAL_DEBT.md. Read `services/loyalty-admin/customer-cache-service.js` for birthday caching.

#### Tasks (in execution order):

1. [ ] **BACKLOG-4**: Customer birthday sync — extend `cacheCustomerDetails()` in `services/loyalty-admin/customer-cache-service.js` to capture birthday field from Square customer object. Update `customer.created`/`customer.updated` webhook handler to persist birthday.
2. [ ] **BACKLOG-8**: Vendor management — pull vendor data from Square Vendors API when generating reports. Replace NULL `vendor_email` with live data from Square. Files: `services/reports/loyalty-reports.js`, `database/schema.sql` (loyalty_offers table).
3. [ ] **E-4**: Consider adding fallback buffer for failed audit log writes — `services/loyalty-admin/audit-service.js:66-73` and `middleware/auth.js:158-161` — add in-memory queue or file-based fallback when DB audit inserts fail. **NEEDS_DECISION**: is the complexity worth it for single-tenant?

#### Tests required:
- [ ] Test birthday extraction from Square customer webhook payload
- [ ] Test vendor data fetched from Square API for report generation
- [ ] Test birthday NULL handling (COALESCE behavior)

#### Definition of done:
- Birthday sync working via webhook
- Vendor reports pull live vendor data from Square
- Known birthday removal gap documented (COALESCE preserves old value)

---

## Old Plan Retirement

Every item from prior planning documents with its disposition in this remediation plan.

### BACKLOG Items (from TECHNICAL_DEBT.md)

| Item | Status | Disposition |
|------|--------|-------------|
| BACKLOG-1 | OPEN | MERGED → Pkg 12 (Frontend Cleanup) |
| BACKLOG-2 | COMPLETED | Already done (2026-02-12, investigated, all working) |
| BACKLOG-3 | OPEN | MERGED → Pkg 14 (Code Cleanup) |
| BACKLOG-4 | OPEN | MERGED → Pkg 15 (Vendor/Feature Work) |
| BACKLOG-5 | COMPLETED | Already done (2026-02-19, in-memory event lock) |
| BACKLOG-6 | COMPLETED | Already done (2026-02-06, shared `square-catalog-cleanup.js`) |
| BACKLOG-7 | COMPLETED | Already done (2026-02-19, `batchFetchSquareOrders()`) |
| BACKLOG-8 | OPEN | MERGED → Pkg 15 (Vendor/Feature Work) |
| BACKLOG-9 | OPEN | MERGED → Pkg 11 (Config/DevOps — P3 tier) |
| BACKLOG-10 | COMPLETED | Already done (2026-02-19, invoice-driven committed inventory) |
| BACKLOG-11 | COMPLETED | Already done (2026-02-19, `customer.created` webhook wired) |
| BACKLOG-12 | OPEN | MERGED → Pkg 8 (Delivery Services) |
| BACKLOG-13 | COMPLETED | Already done (2026-02-23, `custom_attributes_initialized_at` column) |
| BACKLOG-14 | COMPLETED | Already done (2026-02-17, shared `reorder-math.js`) |
| BACKLOG-15 | COMPLETED | Already done (2026-02-17, split-row rollover) |
| BACKLOG-16 | COMPLETED | Already done (2026-02-17, dead `redeemReward()` removed) |
| BACKLOG-17 | OPEN | MERGED → Pkg 3 (Loyalty Services) as A-4 |
| BACKLOG-18 | COMPLETED | Already done (2026-02-19, shared `loyalty-queries.js`) |
| BACKLOG-19 | COMPLETED | Already done (2026-02-19, unified `square-api-client.js`) |
| BACKLOG-20 | COMPLETED | Already done (2026-02-19, canonical `detectRewardRedemptionFromOrder()`) |
| BACKLOG-21 | COMPLETED | Already done (2026-02-23, all pages subtract RESERVED_FOR_SALE) |
| BACKLOG-22 | COMPLETED | Already done (2026-02-23, available_quantity standardized) |
| BACKLOG-23 | OPEN | MERGED → Pkg 12 (Frontend Cleanup) |
| BACKLOG-24 | CLOSED | Intentional — 3 call sites serve different workflows (2026-02-19) |
| BACKLOG-25 | OPEN | MERGED → Pkg 14 (Code Cleanup) |
| BACKLOG-26 | OPEN | MERGED → Pkg 12 (Frontend Cleanup) |
| BACKLOG-27 | OPEN | MERGED → Pkg 12 (Frontend Cleanup) |
| BACKLOG-28 | COMPLETED | Already done (2026-02-24, per-vendor lead_time_days wired) |
| BACKLOG-29 | OPEN | MERGED → Pkg 6 (Webhook Handlers) |
| BACKLOG-30 | COMPLETED | Already done (2026-02-19, `order-intake.js`) |
| BACKLOG-31 | COMPLETED | Already done (2026-02-19, `services/loyalty/` deleted) |
| BACKLOG-32 | COMPLETED | Already done (2026-02-23, frontend loads tier config from API) |
| BACKLOG-33 | COMPLETED | Already done (2026-02-24, new variation velocity badge) |
| BACKLOG-34 | OPEN | MERGED → Pkg 4a (Reorder/Analytics — documentation task) |
| BACKLOG-35 | OPEN | MERGED → Pkg 4b (Sales Velocity Refactor) |
| BACKLOG-36 | OPEN | MERGED → Pkg 4b (Sales Velocity Refactor) |

### DEDUP-AUDIT Items

| ID | Status | Disposition |
|----|--------|-------------|
| L-1 | COMPLETED | Already done (2026-02-17) |
| L-2 | COMPLETED | Already done (2026-02-17) |
| L-3 | COMPLETED | Already done (2026-02-17) |
| L-4 | OPEN | MERGED → Pkg 3 (Loyalty Services) as A-4/BACKLOG-17 |
| L-5 | COMPLETED | Already done (2026-02-19) |
| L-6 | COMPLETED | Already done (2026-02-19) |
| L-7 | COMPLETED | Already done (2026-02-19) |
| R-1 | COMPLETED | Already done (2026-02-17) |
| R-2 | COMPLETED | Already done (2026-02-23) |
| R-3 | COMPLETED | Already done (2026-02-23) |
| G-1 | COMPLETED | Already done |
| G-2 | COMPLETED | Already done |
| G-3 | OPEN | MERGED → Pkg 12 (Frontend Cleanup) |
| G-4 | CLOSED | Intentional (2026-02-19) |
| G-5 | OPEN | MERGED → Pkg 14 (Code Cleanup) |
| G-6 | COMPLETED | Already done |
| G-7 | OPEN | MERGED → Pkg 12 (Frontend Cleanup) |
| G-8 | OPEN | MERGED → Pkg 12 (Frontend Cleanup) |

### CODE_AUDIT_REPORT Items

| ID | Status | Disposition |
|----|--------|-------------|
| CRIT-1 | COMPLETED | Already done (2026-02-05) |
| CRIT-2 | COMPLETED | Already done (2026-02-05) |
| CRIT-3 | COMPLETED | Already done (2026-02-05) |
| CRIT-4 | COMPLETED | Already done (2026-02-05) |
| CRIT-5 | OPEN | MERGED → Pkg 11 (Config/DevOps — P3 tier) |
| HIGH-1 | COMPLETED | Already done (2026-02-05) |
| HIGH-2 | COMPLETED | Already done (2026-02-05) |
| HIGH-3 | COMPLETED | Already done (2026-02-05) |
| HIGH-4 | OPEN | MERGED → Pkg 11 (Config/DevOps) as BACKLOG-9 |
| HIGH-5 | COMPLETED | Already done (2026-02-05) |
| HIGH-6 | COMPLETED | Already done (2026-02-05) |
| MED-1 | DROPPED | Low risk — dynamic parameter construction is safe, refactor unnecessary |
| MED-2 | OPEN | MERGED → Pkg 11 (Config/DevOps) |
| MED-3 | OPEN | MERGED → Pkg 11 (Config/DevOps — P3 tier, pre-franchise) |
| MED-4 | OPEN | MERGED → Pkg 2 (Square API Service) |
| MED-5 | OPEN | MERGED → Pkg 13 (Test Infrastructure) |
| LOW-1 | OPEN | MERGED → Pkg 14 (Code Cleanup) as BACKLOG-3/A-5 |
| LOW-2 | OPEN | MERGED → Pkg 11 (Config/DevOps) as BACKLOG-9 |
| LOW-3 | DROPPED | PM2 fork mode is correct for Raspberry Pi single-instance deployment |
| LOW-4 | DROPPED | Webhook handler uses custom try/catch intentionally (see E-2 in Pkg 11) |

### TECHNICAL_DEBT.md P-tier Items

| ID | Status | Disposition |
|----|--------|-------------|
| P0-1 through P0-7 | ALL COMPLETED | Done (2026-01-26) |
| P1-1 through P1-9 | ALL COMPLETED | Done (2026-01-26 to 2026-02-19) |
| P2-1 through P2-6 | ALL COMPLETED | Done (2026-01-26) |
| P3-1 | OPEN | MERGED → Pkg 11 (Config/DevOps — P3 tier) |
| P3-2 | OPEN | MERGED → Pkg 11 (Config/DevOps — P3 tier) |
| P3-3 | OPEN | MERGED → Pkg 11 (Config/DevOps — P3 tier) |
| P3-4 | OPEN | MERGED → Pkg 11 (Config/DevOps — P3 tier) |

### Documents Superseded by This Plan

| Document | Status |
|----------|--------|
| `docs/PRIORITIES.md` | **SUPERSEDED** — all open items absorbed into packages above |
| `docs/DEDUP-AUDIT.md` "Next Priority" and "Recommendations" sections | **SUPERSEDED** — open items tracked here |
| `docs/TECHNICAL_DEBT.md` "Backlog" section | **SUPERSEDED** — all items tracked here |
| `docs/CODE_AUDIT_REPORT.md` open findings | **SUPERSEDED** — all items tracked here |
| `CLAUDE.md` "Backlog — Open Items" table | **SUPERSEDED** — should reference this plan instead |

**Note**: The source documents themselves should be preserved as historical records. Only the "what to do next" sections are replaced by this plan.

---

## NEEDS_DECISION Summary

Items requiring human judgment before execution:

| Package | Item | Question |
|---------|------|----------|
| ~~Pkg 1~~ | ~~S-4~~ | ~~Are all inline `<script>` blocks truly eliminated?~~ **RESOLVED**: One missed file (`cart-activity.html`) externalized. `'unsafe-inline'` removed. |
| ~~Pkg 1~~ | ~~S-9~~ | ~~Is CSRF token middleware needed?~~ **RESOLVED**: `sameSite: 'lax'` + CORS allowlist sufficient. No `csurf` needed. |
| Pkg 4b | BACKLOG-35/36 | Confirm sales velocity refactor approach (inventory changes API). This is the largest single work item. Key risk: Square Inventory Changes API data retention is undocumented. |
| ~~Pkg 7~~ | ~~D-7~~ | ~~Is `subscription_plans.square_plan_id` dead or planned for future use? Drop or keep?~~ **RESOLVED**: NOT dead — actively used in square-subscriptions.js, routes/subscriptions.js, admin-subscriptions.js. Keep. |
| Pkg 11 | C-4 | Encryption key management approach for backup files — GPG keyring vs env var vs separate key file? |
| Pkg 14 | A-4b | `getCustomerDetails()` has two implementations with different caching behavior: `customer-admin-service.js` (standalone, cache-first, 6 callers) vs `customer-identification-service.js` (class method, direct API, no caching, 4 callers). Unify to always-cache, always-direct, or keep both intentionally? |
| Pkg 15 | E-4 | Is a fallback buffer for audit log writes worth the complexity for single-tenant? |
| Pre-deploy | API version | Update `SQUARE_API_VERSION` from `2025-10-16` to `2026-01-22` and SDK from `^43.2.1` to `^44.0.0`. 2026-01-22 affects Catalog, Orders, Payments, OAuth APIs (all heavily used). 203 regenerated SDK files. **Must read changelog first** at https://developer.squareup.com/docs/changelog/connect and test in Square Sandbox before production. See Pkg 2a completion notes. |

---

## Feature Backlog

New feature ideas and enhancements — not bugs, not tech debt, not remediation. Tracked separately from system packages above.

### Effort Key

| Size | Sessions | Calendar |
|------|----------|----------|
| S | 1-2 | ~1 day |
| M | 3-5 | ~1 week |
| L | 6-10 | ~2 weeks |
| XL | 10+ | ~3-4 weeks |

### F-1: Vendor Catalog → Square Item Creation

**Priority**: P3 — Quality of life, speeds up new product onboarding
**Effort**: M (needs investigation first)
**Status**: Not started

**Currently**: Vendor catalog import brings in vendor product data but new items must be manually created in Square POS before they can be tracked.

**Goal**: Ability to select items from a vendor catalog import and batch-create them as Square catalog items (item + variation + pricing).

**Needs investigation**:
- What fields the vendor CSV provides vs what Square's `BatchUpsertCatalogObjects` API requires
- Variation mapping (1:1 or multi-size)
- Post-creation automation (vendor assignment, cost, inventory tracking)

**Dependencies**:
- Vendor catalog import tool
- Square Catalog API (`BatchUpsertCatalogObjects`)

**Files likely involved**:
- `routes/vendor-catalog.js`
- `services/vendor/catalog-service.js`
- Square Catalog API

---

## Hotfix Log

### HOTFIX-1: Vendor sync crash on Square vendor ID change (2026-02-28)

**Incident**: Production crash 2026-02-27 20:12:39. Square Vendors API (alpha) reassigned vendor "Pet Science (Friday)" from UUID `a97edfac-e0aa-4b78-a404-8c9042242bc6` to Square ID `LATIW2VUCIP7OUID`. Vendor sync crashed because:
1. `ensureVendorsExist()` INSERT failed on `idx_vendors_merchant_name_unique` — no handler for name collision
2. `reconcileVendorId()` DELETE failed — `purchase_orders` FK (`ON DELETE RESTRICT`) blocked deletion

**Root causes**:
- `ensureVendorsExist()` did not catch `idx_vendors_merchant_name_unique` constraint errors
- `reconcileVendorId()` was missing `loyalty_offers` table in FK migration (5 tables exist, only 4 were migrated)
- No systematic FK migration helper — each function maintained its own table list

**Fix** (in `services/square/api.js`):
1. Extracted `migrateVendorFKs()` — single-source-of-truth for all 5 FK tables: `variation_vendors`, `vendor_catalog_items`, `purchase_orders`, `bundle_definitions`, `loyalty_offers`
2. `reconcileVendorId()` — now uses `migrateVendorFKs()`, adds `ON CONFLICT (id) DO NOTHING` safety on temp vendor INSERT, structured logging with migration counts
3. `ensureVendorsExist()` — catches `idx_vendors_merchant_name_unique` and delegates to `reconcileVendorId()` (same pattern as `syncVendors()`)

**One-time production fix**: `scripts/fix-vendor-id-migration.sql` — migrates the stuck vendor ID with preview + transaction

**Test results**: 770/785 pass (15 pre-existing failures from missing dependencies — identical to main branch)
