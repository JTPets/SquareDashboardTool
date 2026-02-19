# Backlog Priorities & Execution Plan

**Generated**: 2026-02-19
**Source**: Cross-referenced from CLAUDE.md, TECHNICAL_DEBT.md, DEDUP-AUDIT.md

---

## 1. Open Backlog Items

| # | Item | Priority | Effort | DEDUP ID | Description |
|---|------|----------|--------|----------|-------------|
| 1 | BACKLOG-4 | Medium | M | — | Customer birthday sync for marketing |
| 2 | BACKLOG-1 | Medium | S-M | — | Frontend polling rate limits |
| 3 | BACKLOG-13 | Medium | M | — | Move custom attribute initialization from startup to tenant onboarding |
| 4 | BACKLOG-22 | Medium | S | R-3 | Available vs total stock inconsistency in days-of-stock |
| 5 | BACKLOG-28 | Medium | M | — | Wire vendor dashboard per-vendor config into reorder formula |
| 6 | BACKLOG-3 | Low | L | — | Response format standardization |
| 7 | BACKLOG-5 | Low | S | — | Rapid-fire webhook duplicate processing |
| 8 | BACKLOG-7 | Low | S | — | Loyalty audit job batch optimization |
| 9 | BACKLOG-8 | Low | M | — | Vendor management — pull vendor data from Square |
| 10 | BACKLOG-9 | Low | M | — | In-memory global state — PM2 restart recovery |
| 11 | BACKLOG-12 | Low | S | — | Driver share link validation failure |
| 12 | BACKLOG-17 | Low | M | L-4 | Customer lookup helpers duplicated between loyalty layers |
| 13 | BACKLOG-21 | Low | M | R-2 | Days-of-stock calculation — 5 implementations |
| 14 | BACKLOG-23 | Low | S | G-3 | Currency formatting — no shared helper |
| 15 | BACKLOG-24 | Low | S | G-4 | Order normalization boilerplate in order-handler.js |
| 16 | BACKLOG-25 | Low | S | G-5 | Location lookup queries repeated across 6 routes |
| 17 | BACKLOG-26 | Low | S | G-7 | Date string formatting pattern repeated 12 times |
| 18 | BACKLOG-27 | Low | S | G-8 | Inconsistent toLocaleString() — 60 uses, mixed locales |
| 19 | BACKLOG-29 | Low | S | — | Existing tenants missing `invoice.payment_made` webhook |
| 20 | BACKLOG-31 | Low | M | — | Remove dead modern loyalty layer (`services/loyalty/`) |

**Effort key**: S = < 1 file change, M = 2-5 files, L = 6+ files

---

## 2. Grouped by Category

### Revenue / Feature Enhancement

| Item | Description | Effort |
|------|-------------|--------|
| BACKLOG-4 | Customer birthday sync for marketing | M |
| BACKLOG-8 | Vendor management — pull vendor data from Square | M |
| BACKLOG-28 | Wire vendor dashboard per-vendor config into reorder formula | M |

### Data Integrity / UX Consistency

| Item | Description | Effort |
|------|-------------|--------|
| BACKLOG-22 | Available vs total stock inconsistency in days-of-stock (R-3) | S |
| BACKLOG-21 | Days-of-stock calculation — 5 implementations (R-2) | M |
| BACKLOG-23 | Currency formatting — no shared helper (G-3) | S |
| BACKLOG-27 | Inconsistent toLocaleString() — 60 uses (G-8) | S |

### Performance / Scalability

| Item | Description | Effort |
|------|-------------|--------|
| BACKLOG-1 | Frontend polling rate limits | S-M |
| BACKLOG-7 | Loyalty audit job batch optimization | S |
| BACKLOG-13 | Custom attribute initialization on startup | M |
| BACKLOG-9 | In-memory global state — PM2 restart recovery | M |

### Tech Debt / Code Quality

| Item | Description | Effort |
|------|-------------|--------|
| BACKLOG-31 | Remove dead modern loyalty layer (`services/loyalty/`) | M |
| BACKLOG-17 | Customer lookup helpers duplicated between layers (L-4) | M |
| BACKLOG-24 | Order normalization boilerplate (G-4) | S |
| BACKLOG-25 | Location lookup queries repeated (G-5) | S |
| BACKLOG-26 | Date string formatting pattern (G-7) | S |
| BACKLOG-3 | Response format standardization | L |

### Bug Fixes / Reliability

| Item | Description | Effort |
|------|-------------|--------|
| BACKLOG-5 | Rapid-fire webhook duplicate processing | S |
| BACKLOG-12 | Driver share link validation failure | S |
| BACKLOG-29 | Existing tenants missing webhook subscription | S |

---

## 3. Recommended Execution Order

### Phase 1: Quick Data Fixes (1-2 days)

These are small, high-impact changes that improve data consistency.

1. **BACKLOG-22** (R-3) — Standardize available vs total stock. Two SQL query changes in `inventory-service.js` and `audit-service.js`. Fixes merchant seeing conflicting numbers across pages.

2. **BACKLOG-31** — Remove dead `services/loyalty/` layer. After L-6 completion, no active callers remain. Clean deletion of ~10 files. Reduces confusion for developers and removes ~3,000 lines of dead code.

3. **BACKLOG-29** — Re-register webhooks for existing tenants. One-time script using the webhook management endpoint. Low risk, prevents `invoice.payment_made` gap for existing tenants.

### Phase 2: Loyalty Cleanup (2-3 days)

4. **BACKLOG-17** (L-4) — Deduplicate customer lookup helpers. Consolidate 3 functions between loyalty layers. Reduces cross-layer bug risk.

5. **BACKLOG-21** (R-2) — Shared days-of-stock calculation. Create `calculateDaysOfStock()` in `reorder-math.js` (already partially exists) and update 5 files.

### Phase 3: Feature Work (1-2 weeks)

6. **BACKLOG-4** — Customer birthday sync. Infrastructure exists (webhook handler, customer cache, birthday column). Needs: extend `cacheCustomerDetails()`, add birthday group management cron.

7. **BACKLOG-28** — Vendor dashboard per-vendor config into reorder formula. Shared `reorder-math.js` is ready. Needs: wire `lead_time_days`/`safety_days` from vendor config into reorder.html.

8. **BACKLOG-13** — Move custom attribute initialization to tenant onboarding. Eliminates 12 Square API calls per server restart.

### Phase 4: Polish (Optional, Low Priority)

9. **BACKLOG-1** — Frontend polling rate limits. Reduce polling frequency, pause when tab hidden.

10. **BACKLOG-23 + BACKLOG-27** — Shared currency/number formatting helpers. Bundle together as one frontend utility effort.

11. **BACKLOG-24 + BACKLOG-25 + BACKLOG-26** — Minor code deduplication (order normalization, location lookups, date formatting). Low risk, low reward — do when touching those files.

12. **BACKLOG-3** — Response format standardization. Large effort (L), touches many routes. Do incrementally per-route as routes are modified.

---

## 4. Quick Wins

Items that can be completed in under a day with high confidence:

| Item | Time Estimate | Impact |
|------|---------------|--------|
| **BACKLOG-22** (R-3) | 1-2 hours | Fixes data inconsistency across pages |
| **BACKLOG-29** | 30 minutes | One-time webhook re-registration script |
| **BACKLOG-5** | 2-3 hours | Order-level dedup in webhook processor |
| **BACKLOG-7** | 2-3 hours | Batch order fetch in audit job |
| **BACKLOG-12** | 2-3 hours | Investigate + fix share link validation |
| **BACKLOG-26** (G-7) | 1 hour | Extract `getToday()` helper |
| **BACKLOG-24** (G-4) | 1 hour | Extract `fetchAndNormalizeOrder()` |
| **BACKLOG-25** (G-5) | 1-2 hours | Extract location lookup helpers |

---

## Recently Completed (for context)

| Item | Completed | Summary |
|------|-----------|---------|
| BACKLOG-30 | 2026-02-19 | Consolidated order processing — `order-intake.js`, 14 tests |
| BACKLOG-20 / L-7 | 2026-02-19 | Canonical redemption detection in audit job |
| BACKLOG-19 / L-6 | 2026-02-19 | Unified `square-api-client.js`, 429 retry ported |
| BACKLOG-18 / L-5 | 2026-02-19 | Shared `loyalty-queries.js`, 3 bug fixes |
| BACKLOG-15 / L-2 | 2026-02-17 | Split-row rollover ported to admin layer |
| BACKLOG-16 / L-3 | 2026-02-17 | Dead `redeemReward()`/`expireRewards()` removed |
| BACKLOG-14 / R-1 | 2026-02-17 | Shared `reorder-math.js`, 31 tests |
| BACKLOG-10 | 2026-02-19 | Invoice-driven committed inventory |
| BACKLOG-11 | 2026-02-19 | `customer.created` webhook wired |
| BACKLOG-6 | 2026-02-06 | Shared `square-catalog-cleanup.js`, 21 tests |
| BACKLOG-2 | 2026-02-12 | Delivery routing — investigated, all working |
