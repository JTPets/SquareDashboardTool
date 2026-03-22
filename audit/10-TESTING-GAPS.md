# Section 10: TESTING GAPS

**Rating: NEEDS WORK**

**Auditor note**: 4,035 tests exist with excellent loyalty coverage (94.5%) and good regression discipline. However, overall statement coverage is only ~54%, the payment path test file is entirely tautological (849 lines testing mocks and JS builtins, not actual code), validators have 0% coverage, and several critical service areas are below 25%.

---

## 10.1 Coverage Overview

**Overall: 53.96% statements, 48.63% functions, 54.89% branches**

This is below the industry standard of 70-80% for a SaaS handling payments.

### Coverage by Service Area

| Directory | Statement Coverage | Assessment |
|-----------|-------------------|------------|
| `services/loyalty-admin/` | 94.54% | Excellent |
| `services/webhook-handlers/` | 95.38% | Excellent |
| `services/inventory/` | 96.70% | Excellent |
| `services/cart/` | 94.82% | Excellent |
| `services/square/` | 92.21% | Excellent |
| `services/catalog/` | 76.87% | Acceptable |
| `services/expiry/` | 75.34% | Acceptable |
| `services/delivery/` | 71.42% | Acceptable |
| `services/reports/` | 65.28% | Low |
| `services/gmc/` | 49.75% | **Low** |
| `services/vendor/` | 23.07% | **Critical** |
| `services/seniors/` | 19.34% | **Critical** |
| `services/merchant/` | 17.39% | **Critical** |
| `middleware/validators/` | 0% | **Critical** |

---

## 10.2 Critical Finding: Tautological Payment Tests

**Severity: HIGH**

`__tests__/routes/subscriptions.test.js` is 849 lines of **tautological tests** that exercise zero lines of `routes/subscriptions.js`. This is the payment/subscription path -- the most critical code in the SaaS.

Examples of tests that test nothing:

| Lines | What It "Tests" | What It Actually Tests |
|-------|----------------|----------------------|
| 45-67 | "validates active promo code" | Mocks `db.query` to return a promo, calls `db.query` directly (not through route), checks the mock returned what it was told |
| 83-92 | "case insensitive code matching" | Tests that `'discount'.toUpperCase() === 'DISCOUNT'` -- a JavaScript builtin |
| 94-97 | "trims whitespace from code" | Tests that `'  PROMO123  '.trim() === 'PROMO123'` -- a JavaScript builtin |
| 282-298 | "requires email" | Checks `expect(!undefined).toBe(true)` |
| 402-448 | "No PCI Data Storage" | Creates a local object literal and checks it doesn't have `card_number` |
| 546-577 | "getUserFriendlyMessage" | Defines and tests a local function copy, not the one in server.js |

**The mock IS the test.** No route handler code, no Express middleware, no validation logic is exercised.

---

## 10.3 Critical Path Coverage

| Critical Path | Test Coverage | Assessment |
|--------------|---------------|------------|
| **Payment/Subscriptions** | `subscriptions.test.js` (849 lines, ALL tautological) | **FAIL** -- zero actual coverage |
| **Loyalty Processing** | 857+ tests across 38 files (94.54%) | **STRONG** |
| **Tenant Isolation** | `merchant.test.js` + `multi-tenant-isolation.test.js` | COVERED |
| **Authentication** | `auth.test.js` + `auth-security.test.js` | COVERED -- supertest integration |
| **Square OAuth** | `oauth-csrf.test.js` | COVERED |
| **Webhook Processing** | `webhook-processor.test.js` -- real HMAC verification | **STRONG** |

### Untested Critical Utils

| File | Purpose | Risk |
|------|---------|------|
| `utils/subscription-handler.js` | Payment/subscription processing | **HIGH** -- handles money |
| `utils/square-subscriptions.js` | Square subscription API calls | **HIGH** -- external payment API |
| `utils/square-token.js` | Token refresh logic | MEDIUM -- security critical |
| `utils/database.js` | Core DB abstraction layer | MEDIUM -- foundational |
| `utils/square-webhooks.js` | Webhook management | MEDIUM |

---

## 10.4 Mock Quality Analysis

| Test File | Verdict | Notes |
|-----------|---------|-------|
| `subscriptions.test.js` | **TAUTOLOGICAL** | Tests mocks and JS builtins, zero route code exercised |
| `auth.test.js` | Real logic | Uses supertest, tests actual Express route handlers |
| `webhook-processor.test.js` | Real logic | Tests actual HMAC computation and event routing |
| `falsy-zero-bugs.test.js` | Real logic | Imports real `logAuditEvent`, genuine regression test |
| `order-processing-service.test.js` | Real logic | Tests real function, mocks at module boundaries only |

**~80% of service-level tests properly test real code.** The `subscriptions.test.js` is the critical outlier.

---

## 10.5 Regression Tests

Bug fix commits consistently include test files (6/6 sampled commits):

| Commit | Bug | Test Files |
|--------|-----|-----------|
| `eec4688` | 7 correctness bugs | 6 test files |
| `c2d4798` | BUG-2 tax_ids | 1 test file |
| `886e07e` | MT-4 to MT-13 multi-tenant | 1 test file |
| `9166649` | CRIT-2+CRIT-4 tenant isolation | 3 test files |
| `8bb8dcc` | CRIT-1 rate limit | 2 test files |
| `8993b44` | SEC-14 image URL isolation | 3 test files |

Named regression test files: `falsy-zero-bugs.test.js`, `backlog-59-multi-redemption.test.js`, webhook regression tests.

**Regression discipline: STRONG**

---

## 10.6 Validator Coverage

**28 validator files in `middleware/validators/` at 0% coverage.** Input validation is a security boundary -- this is a significant gap. Only the index utility functions are tested, not the actual validation rules.

---

## Summary of Findings

| Sub-section | Rating | Key Finding |
|-------------|--------|-------------|
| 10.1 Overall Coverage | NEEDS WORK | 54% statements -- below 70-80% standard |
| 10.2 Payment Tests | **FAIL** | 849 lines of tautological tests; zero actual payment code exercised |
| 10.3 Critical Paths | MIXED | Loyalty excellent; payment/subscription completely untested |
| 10.4 Mock Quality | NEEDS WORK | 80% genuine; subscription tests entirely illusory |
| 10.5 Regression Tests | PASS | Bug fixes consistently include tests |
| 10.6 Validators | FAIL | 28 validator files at 0% coverage |

## Recommendations

| Priority | Item | Effort |
|----------|------|--------|
| **CRITICAL** | Rewrite `subscriptions.test.js` with supertest testing actual route handlers | 8-12 hours |
| HIGH | Add tests for `utils/subscription-handler.js` and `utils/square-subscriptions.js` | 4-6 hours |
| HIGH | Add validator tests for all 28 `middleware/validators/*.js` files | 6-8 hours |
| MEDIUM | Increase coverage for vendor (23%), merchant (17%), seniors (19%) services | 8-12 hours |
| MEDIUM | Configure jest `--coverage` threshold (70% min) in CI | 1 hour |
| LOW | Add integration tests using a real PostgreSQL instance | 8-16 hours |
