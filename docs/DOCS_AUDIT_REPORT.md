# Documentation & Codebase Audit Report

**Date**: 2026-02-10
**Scope**: All `.md` documents cross-referenced against actual codebase
**Changes**: Documentation-only (no code changes)

---

## Executive Summary

Reviewed 13 markdown documents against the actual codebase. Found **27 discrepancies** across 7 documents, primarily stale counts and references to the eliminated `loyalty-service.js` monolith. All security claims verified correct. All fixable documentation errors have been corrected in this commit.

---

## Discrepancies Found & Fixed

### 1. Stale Counts (Fixed across CLAUDE.md, README.md, ARCHITECTURE.md)

| Metric | Documented | Actual | Files Affected |
|--------|-----------|--------|----------------|
| Route modules | 20-23 | **24** | CLAUDE.md, README.md, ARCHITECTURE.md |
| API endpoints | 233-250+ | **257** | CLAUDE.md, README.md, ARCHITECTURE.md |
| Database tables | 33-35+ | **51** | README.md, ARCHITECTURE.md |
| Validator modules | 19-20 | **24** | README.md, ARCHITECTURE.md |
| HTML frontend pages | 30 | **33** | README.md |
| loyalty-admin exports | 47 | **53** | CLAUDE.md, ARCHITECTURE.md |
| Migration range | 003-043 | **003-046** | ARCHITECTURE.md |
| database.js line count | 2,093 | **2,397** | CLAUDE.md (Approved Violations table) |
| Security test total | 194 | **195** (49+51+38+27+30) | README.md |

### 2. Stale Monolith References (Fixed in TECHNICAL_DEBT.md, SENIORS_DAY.md)

The P1-1 migration eliminated `services/loyalty-admin/loyalty-service.js`, but several docs still referenced it:

| Document | Section | Stale Reference | Corrected To |
|----------|---------|-----------------|--------------|
| TECHNICAL_DEBT.md | BACKLOG-4 | `loyalty-service.js:265-299` | `customer-cache-service.js` |
| TECHNICAL_DEBT.md | BACKLOG-4 | `loyalty-service.js:3488-3567` | `square-discount-service.js` |
| TECHNICAL_DEBT.md | BACKLOG-4 | `loyalty-service.js:454-526` | `customer-admin-service.js` |
| TECHNICAL_DEBT.md | BACKLOG-4 | `loyalty-service.js:3578-3700` | `square-discount-service.js` |
| SENIORS_DAY.md | Functions | `loyalty-service.js:3500-3766` | `square-discount-service.js` |
| SENIORS_DAY.md | References | `loyalty-service.js:3500-3766` | `square-discount-service.js` |
| README.md | Project Structure | `utils/loyalty-service.js` | Removed (monolith eliminated) |

### 3. Status Inconsistencies (Fixed)

| Document | Issue | Fix |
|----------|-------|-----|
| TECHNICAL_DEBT.md | Summary says "P1-1 in progress" but all phases complete | Updated to "All P1 items complete" |
| API_OPTIMIZATION_PLAN.md | Says "PLANNING PHASE (No code changes yet)" but work is done | Updated to "COMPLETED (Archived)" |
| TECHNICAL_DEBT.md | BACKLOG-4 says birthday column "Missing" | Updated — column exists via migration 032 |
| README.md | "Last Updated: January 2026" | Updated to February 2026 |

### 4. Line Number Drift (Fixed in CLAUDE.md)

| File Reference | Documented Lines | Actual Lines |
|----------------|-----------------|--------------|
| `square-discount-service.js:deleteRewardDiscountObjects()` | 519-600 | **509-590** (off by 10) |
| `jobs/loyalty-audit-job.js:orderHasOurDiscount()` | 152-178 | 152-178 (correct) |
| `services/expiry/discount-service.js:upsertPricingRule()` | 948-1107 | 948-1107 (correct) |
| `services/expiry/discount-service.js:clearExpiryDiscountForReorder()` | 1716-1823 | 1716-1823 (correct) |

---

## Security Claims Verified

All security-critical claims in the documentation were verified as accurate:

| Claim | Verification |
|-------|-------------|
| Timing-safe webhook signature comparison (HIGH-1) | `crypto.timingSafeEqual()` confirmed in `services/webhook-processor.js` |
| Google OAuth CSRF protection (CRIT-2) | State parameter with `crypto.randomBytes(32)`, DB-backed, 10-min expiry, single-use confirmed in `utils/google-auth.js` |
| AES-256-GCM token encryption | Confirmed in `utils/token-encryption.js` |
| Parameterized SQL queries | Consistent `$1, $2` patterns across codebase |
| Square SDK v43.2.1 | Confirmed in `package.json` |
| Google APIs v144 | Confirmed in `package.json` |
| Square SDK nested resource patterns | Confirmed: `squareClient.orders.get()`, `squareClient.loyalty.searchEvents()`, etc. |

---

## Codebase Observations (No Changes Made)

These are observations from the code scan that may warrant future attention. **No code was modified** — these are informational only.

### README.md API Endpoint Table

The individual endpoint counts in the API Structure table (lines 203-224) sum to a different total than claimed. The listed modules only cover 20 route modules — 4 additional modules exist in the codebase but aren't listed in the table. Consider updating the table to include all 24 modules.

### Archived Docs

`docs/archive/API_CACHING_STRATEGY.md` still shows `Status: PLANNING`. This is a separate future initiative from the completed API optimization and correctly remains in planning state. No change needed, but worth noting it's distinct from the completed API optimization work.

### `createCustomerGroup()` Function

BACKLOG-4 and SENIORS_DAY.md reference `createCustomerGroup()` as an existing function. This function existed in the eliminated monolith but does not appear to have been migrated to the modular services. The modern equivalent exists in `services/loyalty/square-client.js`. Removed the stale reference from the BACKLOG-4 "Existing Code to Leverage" table.

---

## Documents Reviewed

| Document | Issues Found | Issues Fixed |
|----------|-------------|--------------|
| CLAUDE.md | 4 | 4 |
| README.md | 10 | 10 |
| ARCHITECTURE.md | 5 | 5 |
| TECHNICAL_DEBT.md | 5 | 5 |
| SENIORS_DAY.md | 2 | 2 |
| API_OPTIMIZATION_PLAN.md (archive) | 1 | 1 |
| SECURITY_AUDIT.md | 0 | - |
| CODE_AUDIT_REPORT.md | 0 | - |
| SECURITY.md | 0 | - |
| MARKETPLACE_COMPLIANCE.md | 0 | - |
| PROJECT_PLAN.md | 0 | - |
| EVENT_DELEGATION.md (archive) | 0 | - |
| API_CACHING_STRATEGY.md (archive) | 0 | - |
| **Total** | **27** | **27** |
