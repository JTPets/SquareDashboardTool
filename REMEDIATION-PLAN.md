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

## Dependency Graph

```
P0: Security Hardening ──────────────────────────────────► (unblocks everything)
         │
         ▼
P1: Database Schema & Indexes ────────────────────────────► Square API Refactor
         │                                                        │
         ▼                                                        ▼
P1: Test Infrastructure ──────────► All P2 test packages    Loyalty Dedup (A-4)
                                                                  │
                                                                  ▼
                                                           Reorder/Analytics cleanup
                                                                  │
                                                                  ▼
                                                           Velocity Refactor (BACKLOG-35/36)

P2: Webhook Handler Tests ─────► (no blockers, parallel with other P2)
P2: Loyalty/Financial Tests ───► (depends on Loyalty Dedup for stable API surface)
P2: Logging Fixes ─────────────► (no blockers, parallel)

P3: Config Centralization ─────► (no blockers)
P3: Frontend Cleanup ──────────► (no blockers)
P3: Response Format ───────────► (depends on route tests existing)
P3: Backward-Compat Shim Removal ► (depends on route tests existing)
```

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
| S-1 | Audit | HIGH | SQL injection via template literal INTERVAL in cart-activity-service.js (4 sites), square-oauth.js, google-auth.js | **OPEN** |
| S-2 | Audit | MEDIUM | `/output` directory served without auth (includes backups) | **OPEN** |
| S-3 | Audit | MEDIUM | OAuth callback missing session auth verification | **OPEN** |
| S-4 | Audit | MEDIUM | CSP allows `'unsafe-inline'` for scripts (P0-4 claims complete) | **OPEN** — needs verification |
| S-5 | Audit | LOW | Password reset token exposed in dev (negative env check) | **OPEN** |
| S-6 | Audit | MEDIUM | Admin user listing not scoped by merchant | **OPEN** |
| S-7 | Audit | LOW | Missing `requireMerchant` on OAuth revoke route | **OPEN** |
| S-8 | Audit | LOW | Health endpoint exposes internal details | **OPEN** |
| S-9 | Audit | LOW | No CSRF token for state-changing POST requests | **OPEN** |
| S-10 | Audit | HIGH | XSS in vendor catalog import validation errors (innerHTML) | **OPEN** |
| S-11 | Audit | LOW | Session fixation window on OAuth callback | **OPEN** |
| CRIT-1 | CODE_AUDIT | CRITICAL | Cross-tenant cart data deletion | **DONE** (2026-02-05) |
| CRIT-2 | CODE_AUDIT | CRITICAL | Google OAuth CSRF vulnerability | **DONE** (2026-02-05) |
| CRIT-3 | CODE_AUDIT | CRITICAL | Server-side XSS in HTML report generation | **DONE** (2026-02-05) |
| CRIT-4 | CODE_AUDIT | CRITICAL | Client-side API key in localStorage | **DONE** (2026-02-05) |
| CRIT-5 | CODE_AUDIT | CRITICAL | No distributed locking for cron jobs (scale) | **OPEN** — P3 |
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
| A-2 | Audit | HIGH | Business logic in route handlers (bundles.js, analytics.js, delivery.js) | **OPEN** |
| A-3 | Audit | MEDIUM | Circular dependency middleware/merchant.js ↔ routes/square-oauth.js | **OPEN** |
| A-4 | Audit+DEDUP | HIGH | Duplicate customer lookup implementations (BACKLOG-17, DEDUP L-4) | **OPEN** |
| A-5 | Audit+BACKLOG | MEDIUM | Inconsistent response formats (BACKLOG-3) | **OPEN** |
| A-6 | Audit | MEDIUM | 66 files over 300-line limit (beyond 2 approved) | **OPEN** — refactor-on-touch |
| A-7 | Audit+DEDUP | LOW | Open deduplication debt: G-3, G-5, G-7, G-8 (BACKLOG-23,25,26,27) | **OPEN** |
| DC-1 | Audit | LOW | 9 backward-compatibility re-export stubs in utils/ | **OPEN** |

### Database Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| D-1 | Audit | HIGH | Missing indexes on `vendor_catalog_items` and `expiry_discount_audit_log` (schema.sql drift) | **OPEN** |
| D-2 | Audit | MEDIUM | Missing composite index on `inventory_counts` (merchant_id, location_id, state) | **OPEN** |
| D-3 | Audit | MEDIUM | N+1 sequential Square customer fetches in routes/loyalty.js:1603 | **OPEN** |
| D-4 | Audit | MEDIUM | N+1 order lookup per earned reward in redemption-audit-service.js | **OPEN** |
| D-5 | Audit | MEDIUM | schema.sql drift from migration state (migration 005 indexes missing) | **OPEN** |
| D-6 | Audit | LOW | `expiry_discount_audit_log.merchant_id` allows NULL | **OPEN** |
| D-7 | Audit | LOW | Potentially dead column `subscription_plans.square_plan_id` | **OPEN** |
| MED-2 | CODE_AUDIT | MEDIUM | Connection pool size not configurable | **OPEN** |

### Error Handling Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| E-1 | Audit | HIGH | Fire-and-forget email in database error handler (server.js:1001) | **OPEN** |
| E-2 | Audit | LOW | OAuth routes use custom try/catch instead of asyncHandler | **OPEN** |
| E-4 | Audit | LOW | Audit logging silently swallows errors (by design) | **OPEN** — consider fallback buffer |
| MED-4 | CODE_AUDIT | MEDIUM | `setInterval` not cleared on shutdown (api.js:49) | **OPEN** |
| MED-5 | CODE_AUDIT | MEDIUM | Long-running jobs without timeout (loyalty-audit-job) | **OPEN** |

### API Integration Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| I-1 | Audit | HIGH | GMC API missing 429/rate limit handling | **OPEN** |
| I-2 | Audit | MEDIUM | Dual Square API version constants (2025-01-16 vs 2025-10-16) | **OPEN** |
| I-3 | Audit | LOW | Duplicate `generateIdempotencyKey()` implementation | **OPEN** |

### Performance Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| P-1 | Audit | CRITICAL | Reorder suggestions endpoint returns unbounded result sets (no pagination) | **OPEN** |
| P-2 | Audit | HIGH | N+1 bundle component inserts (sequential loop) | **OPEN** |
| P-3 | Audit | HIGH | `SELECT *` on merchants table for every request | **OPEN** |
| P-4 | Audit | HIGH | Square API pagination loops have no iteration guard (7 instances) | **OPEN** |
| P-5 | Audit | MEDIUM | Google OAuth token listener duplicated on every call | **OPEN** |
| P-6 | Audit | MEDIUM | N+1 GMC settings inserts | **OPEN** |
| P-7 | Audit | MEDIUM | clientCache has no max size or LRU eviction | **OPEN** |
| P-8 | Audit | MEDIUM | Sync queue follow-up syncs block sequentially | **OPEN** |
| P-9 | Audit | LOW | GMC sync polling at 5-second intervals | **OPEN** |
| MED-3 | CODE_AUDIT | MEDIUM | No circuit breaker for Square API | **OPEN** — P3 |

### Testing Findings

| ID | Source | Severity | Description | Status |
|----|--------|----------|-------------|--------|
| T-1 | Audit | CRITICAL | Financial/loyalty services have ZERO test coverage (3 services, 2,972 lines) | **OPEN** |
| T-2 | Audit | CRITICAL | Webhook handlers untested — 7 of 8 (order-handler 1,316 lines) | **OPEN** |
| T-3 | Audit | HIGH | 84% of routes untested (21 of 25) | **OPEN** |
| T-4 | Audit | HIGH | Background jobs 91% untested (10 of 11) | **OPEN** |
| T-5 | Audit | MEDIUM | Coverage thresholds not enforced globally | **OPEN** |
| T-6 | Audit | MEDIUM | No email service mock in test setup | **OPEN** |

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
| L-4 | DEDUP | High | Customer lookup helpers duplicated (= A-4 / BACKLOG-17) | **OPEN** |
| L-5 | DEDUP | Medium | Offer/variation queries — overlapping | **DONE** (2026-02-19) |
| L-6 | DEDUP | Medium | Square API client — two wrapper layers | **DONE** (2026-02-19) |
| L-7 | DEDUP | Low | Redemption detection asymmetry | **DONE** (2026-02-19) |
| R-1 | DEDUP | Critical | Reorder quantity formula — JS vs SQL | **DONE** (2026-02-17) |
| R-2 | DEDUP | High | Days-of-stock — 5 implementations (= BACKLOG-21) | **OPEN** |
| R-3 | DEDUP | High | Available vs total stock inconsistency (= BACKLOG-22) | **OPEN** |
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
| BACKLOG-34 | Low | Documentation: Square reuses variation IDs | Pkg 4: Reorder/Analytics |
| BACKLOG-35 | Medium | Sales velocity does not subtract refunds | Pkg 4: Reorder/Analytics |
| BACKLOG-36 | Medium | Phantom velocity rows never self-correct | Pkg 4: Reorder/Analytics |

### Conflicts and Duplicates

| Items | Type | Resolution |
|-------|------|------------|
| S-4 vs P0-4 (TECH_DEBT) | **CONFLICT** | P0-4 claims 29/29 inline scripts externalized and `'unsafe-inline'` should be removable. S-4 says it's still in the CSP config. **NEEDS_DECISION**: Verify no remaining inline scripts; if clean, remove `'unsafe-inline'`. |
| A-4, BACKLOG-17, DEDUP L-4 | Duplicate | Merged → Pkg 3 (Loyalty Services) |
| BACKLOG-21, DEDUP R-2 | Duplicate | Merged → Pkg 4 (Reorder/Analytics) |
| BACKLOG-22, DEDUP R-3 | Duplicate | Merged → Pkg 4 (Reorder/Analytics) |
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

### Package 1: Security Hardening — P0

**Estimated effort**: M
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

1. [ ] **S-1**: Fix SQL injection in INTERVAL clauses — replace `INTERVAL '${var} days'` with `INTERVAL '1 day' * $N` pattern:
   - `services/cart/cart-activity-service.js:285` — `INTERVAL '${daysThreshold} days'`
   - `services/cart/cart-activity-service.js:324` — `INTERVAL '${daysThreshold} days'`
   - `services/cart/cart-activity-service.js:425` — `INTERVAL '${days} days'`
   - `services/cart/cart-activity-service.js:428` — `INTERVAL '${days} days'`
   - `routes/square-oauth.js:78` — `INTERVAL '${STATE_EXPIRY_MINUTES} minutes'`
   - `utils/google-auth.js:125` — `INTERVAL '${STATE_EXPIRY_MINUTES} minutes'`
2. [ ] **S-10**: Fix XSS in vendor catalog import validation errors — `public/js/vendor-catalog.js:387` — wrap `err.errors.join(', ')` with `escapeHtml()` before innerHTML assignment at line 397
3. [ ] **S-2**: Add `requireAuth` middleware before `/output` static route — `server.js:221` — at minimum exclude `/output/backups/` from public static serving
4. [ ] **S-6**: Scope admin user listing by merchant — `routes/auth.js:299-310` — join through `user_merchants` and filter by `req.merchantContext.id`
5. [ ] **S-3**: Verify session auth in OAuth callback — `routes/square-oauth.js:110` — add `req.session.user.id === stateRecord.user_id` check
6. [ ] **S-11**: Regenerate session on OAuth callback — `routes/square-oauth.js:242-244` — call `req.session.regenerate()` after modifying session state
7. [ ] **S-4**: Remove `'unsafe-inline'` from CSP — `middleware/security.js:29` — first verify no inline `<script>` blocks remain in HTML files; if clean, remove; if not, switch to nonce-based CSP. **NEEDS_DECISION**: Verify P0-4 completion claim.
8. [ ] **S-5**: Change dev token check to positive opt-in — `routes/auth.js:655` — change `process.env.NODE_ENV !== 'production'` to `process.env.NODE_ENV === 'development'`
9. [ ] **S-7**: Use standard `requireMerchant` on OAuth revoke — `routes/square-oauth.js:320` — replace manual access checks with `requireMerchant` + `requireMerchantRole('owner')` middleware
10. [ ] **S-8**: Split health endpoint — `server.js:412` — return minimal info on public `/api/health`; create authenticated `/api/health/detailed` for full diagnostics
11. [ ] **S-9**: Evaluate CSRF token middleware — project-wide — assess whether `sameSite: 'lax'` + CORS is sufficient or if `csurf` is needed for admin operations. **NEEDS_DECISION**: Risk/effort tradeoff.

#### Tests required:
- [ ] Test parameterized INTERVAL queries produce correct SQL results
- [ ] Test `/output/backups/` is not accessible without auth
- [ ] Test admin user listing returns only same-merchant users
- [ ] Test OAuth callback rejects session user mismatch
- [ ] Test CSP header does NOT contain `'unsafe-inline'` (after removal)
- [ ] Test vendor catalog validation errors are HTML-escaped in output

#### Definition of done:
- All tasks checked
- All tests passing
- No `INTERVAL '${` patterns remaining in codebase (grep verification)
- No innerHTML assignments with unescaped user input
- S-4 resolved (either removed or documented with nonce plan)
- AUDIT.md findings S-1 through S-11 marked resolved

---

### Package 2: Square API Service Refactor — P1

**Estimated effort**: XL
**Dependencies**: Pkg 1 (Security) should complete first
**Files touched**:
- `services/square/api.js` (4,793 lines → split into 4-5 modules + facade)
- `services/loyalty-admin/shared-utils.js`
- `config/constants.js`
- All files that import from `services/square/api.js` or `utils/square-api.js`

**Pre-work**: Read `services/square/api.js` fully. Map all 38 exports by domain. Understand the `makeSquareRequest()` retry logic (lines 117-216). Read `config/constants.js` to understand existing namespaces.

#### Tasks (in execution order):

1. [ ] **I-2**: Centralize `SQUARE_API_VERSION` — move to `config/constants.js`, update `services/square/api.js:25` (currently `'2025-10-16'`) and `services/loyalty-admin/shared-utils.js:18` (currently `'2025-01-16'`) to import from constants. Use `'2025-10-16'` (newer).
2. [ ] **I-3**: Consolidate `generateIdempotencyKey()` — extract to `utils/idempotency.js`, update imports in `services/square/api.js:107-109` and `services/loyalty-admin/shared-utils.js:176-184`.
3. [ ] **P-4**: Add `MAX_ITERATIONS` guard to all 8 pagination loops — `services/square/api.js` at lines 331, 445, 770, 1598, 1845, 2566, 3028, 3479. Add constant `MAX_PAGINATION_ITERATIONS = 500` to `config/constants.js`. Break with `logger.warn()` if exceeded.
4. [ ] **MED-4**: Clear `setInterval` on shutdown — `services/square/api.js:51` — store reference and export a `cleanup()` function; call from `server.js` graceful shutdown handler. (Note: `.unref()` is already present, so this is LOW urgency but clean.)
5. [ ] **A-1**: Split `services/square/api.js` into domain modules:
   - `services/square/catalog-sync.js` — catalog, delta, category, image, item, variation sync
   - `services/square/inventory-sync.js` — inventory counts, velocity, committed inventory
   - `services/square/catalog-operations.js` — prices, costs, attributes, content updates
   - `services/square/diagnostics.js` — fix location mismatches, inventory alerts, item enabling
   - `services/square/api.js` — thin facade re-exporting from sub-modules + `makeSquareRequest()`
6. [ ] Update `utils/square-api.js` backward-compat shim to re-export from new facade
7. [ ] **P-3**: Narrow `SELECT *` on merchants table — `middleware/merchant.js:210` — select only `id, square_access_token, square_refresh_token, square_token_expires_at`
8. [ ] **P-7**: Add LRU eviction to `clientCache` — `middleware/merchant.js:19` — add `MAX_CLIENTS = 100` and evict oldest when full. Consider using Node's built-in Map with a size check.
9. [ ] **A-3**: Extract `refreshMerchantToken()` to `utils/square-token.js` — eliminate circular dependency between `middleware/merchant.js:227` and `routes/square-oauth.js`
10. [ ] **P-8**: Fire follow-up sync async — `services/sync-queue.js:232-242` — change to `syncFn().catch(err => logger.error(...))` without await

#### Monolith breakdown:
- **Current**: `services/square/api.js` (4,793 lines, 38 exports)
- **Target modules**:
  - `catalog-sync.js` — full/delta catalog sync, category/image/item/variation processing (~1,500 lines)
  - `inventory-sync.js` — inventory counts, sales velocity, committed inventory (~1,200 lines)
  - `catalog-operations.js` — price updates, cost updates, custom attributes, content (~800 lines)
  - `diagnostics.js` — fix location mismatches, enable items, alerts (~500 lines)
  - `api.js` (facade) — `makeSquareRequest()`, shared constants, re-exports (~400 lines)

#### Tests required:
- [ ] Test `MAX_ITERATIONS` guard breaks pagination and logs warning
- [ ] Test each new sub-module exports the same functions as original api.js
- [ ] Test `utils/square-api.js` shim still works after split
- [ ] Test merchant query returns only needed columns
- [ ] Test clientCache eviction when MAX_CLIENTS exceeded
- [ ] Test `refreshMerchantToken()` works from new location without circular import

#### Definition of done:
- `services/square/api.js` reduced to <500 lines (facade only)
- All sub-modules under 1,500 lines
- Single `SQUARE_API_VERSION` in `config/constants.js`
- Single `generateIdempotencyKey()` in `utils/idempotency.js`
- All 8 pagination loops have iteration guards
- All existing tests pass
- No circular dependencies in module graph

---

### Package 3: Loyalty Services — P1

**Estimated effort**: L
**Dependencies**: Pkg 2 (Square API) for I-2 fix; Pkg 13 (Test Infra) for testing
**Files touched**:
- `services/loyalty-admin/customer-identification-service.js`
- `services/loyalty-admin/customer-admin-service.js`
- `routes/loyalty.js`
- `services/loyalty-admin/redemption-audit-service.js`

**Pre-work**: Read both customer service files. Map which functions are called from where. Read DEDUP L-4 section for full context.

#### Tasks (in execution order):

1. [ ] **A-4 / BACKLOG-17 / DEDUP L-4**: Consolidate customer lookup helpers — make admin-layer `customer-admin-service.js` standalone functions delegate to the class methods in `customer-identification-service.js` (or vice versa). Both files are in the same directory.
   - `services/loyalty-admin/customer-identification-service.js` — class-based (complete)
   - `services/loyalty-admin/customer-admin-service.js:110-413` — standalone exports (3 functions to consolidate)
2. [ ] **D-3**: Fix N+1 sequential Square customer fetches — `routes/loyalty.js:1603-1620` — replace sequential loop with `Promise.allSettled` using concurrency limit of 5
3. [ ] **D-4**: Batch-fetch orders in redemption audit — `services/loyalty-admin/redemption-audit-service.js:121-165` — use `square_customer_id = ANY($1)` instead of per-reward queries

#### Tests required:
- [ ] Test consolidated customer lookup returns same results as both original implementations
- [ ] Test concurrent customer fetch respects concurrency limit
- [ ] Test batch order fetch returns all expected orders

#### Definition of done:
- Single implementation for each customer lookup function
- No duplicate lookup logic between the two service files
- N+1 queries eliminated in loyalty.js and redemption-audit-service.js
- All existing loyalty tests pass

---

### Package 4: Reorder/Analytics — P1

**Estimated effort**: L
**Dependencies**: Pkg 2 (Square API) for split api.js; Pkg 7 (Database) for index on inventory_counts
**Files touched**:
- `routes/analytics.js`
- `routes/bundles.js` (availability extraction only — see Pkg 5 for full bundle work)
- `services/catalog/inventory-service.js`
- `services/catalog/audit-service.js`
- `services/catalog/reorder-math.js`
- `services/vendor-dashboard.js`
- `public/js/reorder.js`

**Pre-work**: Read `docs/PLAN-sales-velocity-refactor.md` for BACKLOG-35/36 context. Read `services/catalog/reorder-math.js` for existing shared formula.

#### Tasks (in execution order):

1. [ ] **BACKLOG-22 / DEDUP R-3**: Standardize stock base to available quantity — update two files:
   - `services/catalog/inventory-service.js:58-64` — change from `on_hand` to `on_hand - committed`
   - `services/catalog/audit-service.js:116-121` — change from `current_stock` to `current_stock - committed`
2. [ ] **BACKLOG-21 / DEDUP R-2**: Consolidate days-of-stock calculation — add `calculateDaysOfStock()` to `services/catalog/reorder-math.js` (partially exists already) and update all 5 call sites to use it
3. [ ] **P-1**: Add pagination to reorder suggestions — `routes/analytics.js:95-760` — add `LIMIT $X OFFSET $Y` to main SQL query (currently no LIMIT). Add `page` and `pageSize` query params with defaults (page=1, pageSize=100). Return `{ items, total, page, pageSize }`.
4. [ ] **BACKLOG-34**: Document Square variation ID reassignment behavior — add comment in `services/square/api.js` velocity sync functions
5. [ ] **BACKLOG-35 / BACKLOG-36**: Implement sales velocity refactor — follow `docs/PLAN-sales-velocity-refactor.md` phases. This is a large sub-project:
   - Phase 1: Create `inventory_changes` table (migration)
   - Phase 2: Backfill historical data from Square Inventory Changes API
   - Phase 3: Wire `inventory.count.updated` webhook to capture changes
   - Phase 4: Rewrite velocity calculation from `inventory_changes` table
   - Phase 5: Parallel-run both systems, validate accuracy
   - Phase 6: Cut over, remove old velocity sync code
   **NEEDS_DECISION**: This is the largest single work item. Confirm approach before starting.

#### Tests required:
- [ ] Test days-of-stock uses available quantity (on_hand - committed) consistently
- [ ] Test reorder suggestions pagination returns correct page/total
- [ ] Test reorder suggestions with pageSize=10 returns max 10 items
- [ ] Test velocity calculation from inventory_changes matches expected values (Phase 5)

#### Definition of done:
- All pages show same days-of-stock for same item
- Reorder suggestions endpoint has working pagination
- BACKLOG-35/36 either implemented or documented as separate phase
- AUDIT.md findings P-1 marked resolved

---

### Package 5: Bundle System — P2

**Estimated effort**: M
**Dependencies**: None
**Files touched**:
- `routes/bundles.js`
- `services/bundle-calculator.js` (new — extract from route)

**Pre-work**: Read `routes/bundles.js` fully (291 lines). Understand the availability calculation inline logic (lines 88-291).

#### Tasks (in execution order):

1. [ ] **A-2 (bundles)**: Extract bundle availability calculation from route — move lines 88-291 of `routes/bundles.js` to `services/bundle-calculator.js`. Route should become thin: validate input, call service, return result.
2. [ ] **P-2**: Batch bundle component inserts — replace sequential `INSERT` loops at `routes/bundles.js:340-358` (POST) and `routes/bundles.js:455-473` (PUT) with batch `INSERT INTO bundle_components (...) VALUES ($1,...), ($2,...) RETURNING *`

#### Tests required:
- [ ] Test bundle availability calculation returns correct results via service
- [ ] Test batch insert creates all components in one query
- [ ] Test bundle create with 10 components completes in <200ms (no N+1)

#### Definition of done:
- `routes/bundles.js` contains validation + service calls only
- `services/bundle-calculator.js` contains all business logic
- No sequential INSERT loops for bundle components
- Existing bundle functionality unchanged

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
- `utils/square-webhooks.js` (for BACKLOG-29)
- `__tests__/services/webhook-handlers/` (new test files)

**Pre-work**: Read `services/webhook-handlers/index.js` and the existing test `__tests__/services/webhook-handlers.test.js`. Read each handler to understand mocking needs.

#### Tasks (in execution order):

1. [ ] **BACKLOG-29**: Re-register webhooks for existing tenants — ensure `invoice.payment_made` is in both `subscriptions` and `invoices` webhook groups in `utils/square-webhooks.js`. Create one-time migration script to re-register.
2. [ ] **T-2**: Write integration tests for `order-handler.js` — highest priority (1,316 lines, processes all orders, loyalty records, refunds). Test: order processing, loyalty record creation, refund handling, delivery routing.
3. [ ] **T-2**: Write integration tests for `loyalty-handler.js` — second priority (512 lines). Test: loyalty event sync, account create/update.
4. [ ] **T-2**: Write tests for remaining 5 handlers — catalog, customer, inventory, oauth, subscription.
5. [ ] **E-1**: Add `.catch()` to fire-and-forget email in DB error handler — `server.js:996` — add `.catch(emailErr => logger.error('Failed to send DB error alert', { error: emailErr.message }))`

#### Tests required:
- [ ] order-handler: order created/updated processing (happy path)
- [ ] order-handler: refund handling and point reversal
- [ ] order-handler: delivery routing from order webhook
- [ ] loyalty-handler: loyalty event processing
- [ ] loyalty-handler: account lifecycle events
- [ ] All 7 handlers: error handling does not throw (returns gracefully)
- [ ] All 7 handlers: merchant_id isolation

#### Definition of done:
- All 8 webhook handlers have test files
- order-handler.js and loyalty-handler.js at 60%+ coverage
- Remaining handlers at 40%+ coverage
- BACKLOG-29 webhook re-registration complete
- E-1 fire-and-forget email fix applied

---

### Package 7: Database — P1

**Estimated effort**: S
**Dependencies**: None (can run in parallel with Pkg 1)
**Files touched**:
- `database/schema.sql`
- `database/migrations/` (new migration files)

**Pre-work**: Read `database/schema.sql` index definitions. Compare against `database/migrations/005_multi_tenant.sql` for drift.

#### Tasks (in execution order):

1. [ ] **D-1 / D-5**: Sync schema.sql with migration state — add all indexes from migration 005 (and any other migrations) that are missing from schema.sql. Specifically:
   - Index on `vendor_catalog_items(merchant_id)` — `database/schema.sql:676-705`
   - Index on `expiry_discount_audit_log(merchant_id)` — `database/schema.sql:867-880`
2. [ ] **D-2**: Create composite index on inventory_counts — new migration:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_inventory_counts_merchant_location_state
   ON inventory_counts(merchant_id, location_id, state);
   ```
3. [ ] **D-6**: Add NOT NULL constraint to `expiry_discount_audit_log.merchant_id` — new migration (after verifying no NULL rows exist):
   ```sql
   ALTER TABLE expiry_discount_audit_log
   ALTER COLUMN merchant_id SET NOT NULL;
   ```
4. [ ] **D-7**: Audit `subscription_plans.square_plan_id` column — check if any code references it; if dead, create migration to drop it. **NEEDS_DECISION**: verify future use intent.

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

1. [ ] **A-2 (delivery)**: Extract delivery stat aggregation from route — `routes/delivery.js:445-659` — move to `services/delivery/delivery-stats.js`. Route becomes thin controller.
2. [ ] **BACKLOG-12**: Investigate driver share link validation failure — check share link generation endpoint, input validation on parameters, expired/invalid token handling. Files: `routes/delivery.js`, `middleware/validators/`, `services/delivery/delivery-service.js`.

#### Tests required:
- [ ] Test delivery stat aggregation via service returns expected results
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

### Package 10: GMC Integration — P2

**Estimated effort**: M
**Dependencies**: None
**Files touched**:
- `services/gmc/merchant-service.js`
- `services/gmc/feed-service.js`
- `public/js/gmc-feed.js`

**Pre-work**: Read `services/gmc/merchant-service.js` — understand `merchantApiRequest()`, `getAuthClient()`, and `saveGmcApiSettings()`.

#### Tasks (in execution order):

1. [ ] **I-1**: Add 429/rate limit handling to `merchantApiRequest()` — `services/gmc/merchant-service.js:200` — add `Retry-After` header parsing and exponential backoff (max 3 retries), matching Square API pattern in `services/square/api.js:148-153`
2. [ ] **P-5**: Guard against duplicate token listener — `services/gmc/merchant-service.js:57` — add `if (!oauth2Client.listenerCount('tokens'))` check before `oauth2Client.on('tokens', ...)`
3. [ ] **P-6**: Batch GMC settings inserts — `services/gmc/merchant-service.js:95` — replace sequential loop with single `INSERT ... VALUES (...), (...) ON CONFLICT DO UPDATE` using `UNNEST` arrays
4. [ ] **P-9**: Reduce GMC sync polling frequency — `public/js/gmc-feed.js:1210-1255` — increase from 5s to 10s intervals, or implement exponential backoff (5s → 10s → 30s)
5. [ ] **L-2 (partial)**: Add `merchantId` to logger in `services/gmc/feed-service.js:236`

#### Tests required:
- [ ] Test `merchantApiRequest()` retries on 429 response
- [ ] Test token listener attached only once per OAuth client
- [ ] Test settings batch insert writes all settings in one query

#### Definition of done:
- GMC API calls retry on 429 with proper backoff
- No duplicate token listeners
- Settings inserts batched
- Polling interval increased
- All GMC error logs include merchantId

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

1. [ ] **C-2**: Create CI pipeline — add `.github/workflows/test.yml` that runs `npm test` on push/PR. Optionally add a simple `scripts/deploy.sh` that: pulls latest → `npm ci` → runs tests → restarts PM2 on success → logs deploy event.
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
- [ ] Test CI pipeline runs `npm test` and gates on failure
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

1. [ ] **T-6**: Add email service mock to test setup — `__tests__/setup.js` — add `jest.mock('../utils/email-notifier')` to prevent tests from sending real emails
2. [ ] **T-5**: Add global coverage thresholds — `jest.config.js:33-60` — add:
   ```javascript
   './services/**/*.js': { branches: 30, functions: 30, lines: 30, statements: 30 },
   './routes/**/*.js': { branches: 20, functions: 20, lines: 20, statements: 20 },
   ```
   Start low to avoid blocking existing PR flow. Ratchet up as coverage improves.
3. [ ] **MED-5**: Add per-merchant timeout to loyalty audit job — `jobs/loyalty-audit-job.js` — add `AbortController` with 5-minute timeout per merchant processing loop

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
| BACKLOG-34 | OPEN | MERGED → Pkg 4 (Reorder/Analytics — documentation task) |
| BACKLOG-35 | OPEN | MERGED → Pkg 4 (Reorder/Analytics — velocity refactor) |
| BACKLOG-36 | OPEN | MERGED → Pkg 4 (Reorder/Analytics — velocity refactor) |

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
| Pkg 1 | S-4 | Are all inline `<script>` blocks truly eliminated? If yes, remove `'unsafe-inline'`. If not, switch to nonce-based CSP. |
| Pkg 1 | S-9 | Is CSRF token middleware needed given `sameSite: 'lax'` + CORS? Cost/benefit for admin operations? |
| Pkg 4 | BACKLOG-35/36 | Confirm sales velocity refactor approach (inventory changes API). This is the largest single work item. |
| Pkg 7 | D-7 | Is `subscription_plans.square_plan_id` dead or planned for future use? Drop or keep? |
| Pkg 11 | C-4 | Encryption key management approach for backup files — GPG keyring vs env var vs separate key file? |
| Pkg 15 | E-4 | Is a fallback buffer for audit log writes worth the complexity for single-tenant? |
