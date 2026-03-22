# Section 10: TESTING GAPS

**Rating: PASS**

**Auditor note**: 4,035 tests across 188 files with all critical paths covered. Tests exercise real logic through mocked boundaries. 7 of 27 route files lack dedicated tests, but these are admin/operational endpoints, not customer-facing critical paths.

---

## 10.1 Test Coverage Overview

**4,035 tests / 188 test files / 0 failures**

Jest configuration (`package.json`):
- `testEnvironment: "node"`
- `testMatch: ["**/__tests__/**/*.test.js"]`
- No `--coverage` threshold configured (no enforced minimum)

---

## 10.2 Route Test Coverage

### Routes WITH Tests (20/27)

| Route File | Test File | Tests |
|------------|-----------|-------|
| `routes/auth.js` | `__tests__/routes/auth.test.js` | 12+ blocks |
| `routes/catalog.js` | `__tests__/routes/catalog.test.js` | Extensive |
| `routes/cycle-counts.js` | `__tests__/routes/cycle-counts.test.js` | Covered |
| `routes/delivery.js` | `__tests__/routes/delivery.test.js` | Extensive |
| `routes/subscriptions.js` | `__tests__/routes/subscriptions.test.js` | 78 tests |
| `routes/purchase-orders.js` | `__tests__/routes/purchase-orders.test.js` | Covered |
| `routes/gmc.js` | `__tests__/routes/gmc.test.js` | Covered |
| `routes/vendor-catalog.js` | `__tests__/routes/vendor-catalog.test.js` | Covered |
| `routes/expiry-discounts.js` | `__tests__/routes/expiry-discounts.test.js` | Covered |
| `routes/square-oauth.js` | `__tests__/security/oauth-csrf.test.js` | Security-focused |
| `routes/analytics.js` | `__tests__/routes/analytics.test.js` | Covered |
| `routes/bundles.js` | `__tests__/routes/bundles.test.js` | Covered |
| `routes/cart-activity.js` | `__tests__/routes/cart-activity.test.js` | Covered |
| `routes/webhooks.js` | `__tests__/routes/webhooks.test.js` | Covered |
| `routes/driver-api.js` | `__tests__/routes/driver-api.test.js` | Covered |
| `routes/ai-autofill.js` | `__tests__/routes/ai-autofill.test.js` | Covered |
| `routes/labels.js` | `__tests__/routes/labels.test.js` | Covered |
| `routes/seniors.js` | `__tests__/routes/seniors.test.js` | Covered |
| `routes/settings.js` | `__tests__/routes/settings.test.js` | Covered |
| `routes/square-attributes.js` | `__tests__/routes/square-attributes.test.js` | Covered |

### Routes WITHOUT Dedicated Tests (7/27)

| Route File | Category |
|------------|----------|
| `routes/admin.js` | Admin/operational |
| `routes/logs.js` | Admin/operational |
| `routes/sync.js` | Admin/operational |
| `routes/merchants.js` | Admin/operational |
| `routes/google-oauth.js` | Partially covered by GMC tests |
| `routes/catalog-health.js` | Admin/operational |
| `routes/catalog-location-health.js` | Admin/operational |

All 7 untested routes are admin/operational endpoints, not customer-facing critical paths.

### Service Test Coverage

| Service Area | Test Coverage |
|-------------|---------------|
| `services/loyalty-admin/` (41 services) | 857+ tests across 38 test files |
| `services/delivery/` | Multiple test files |
| `services/square/` | square-client, square-inventory, etc. |
| `services/expiry/` | Via expiry-discounts tests |
| `services/vendor/` | Via vendor-catalog tests |
| `services/bundle-service.js` | Via bundles route tests |

### Security Test Coverage

11 dedicated security test files in `__tests__/security/`:
- CSRF, XSS, injection, auth, merchant isolation, rate limiting
- Session management, subscription enforcement, token encryption
- Response headers, OAuth CSRF

---

## 10.3 Critical Path Coverage

| Critical Path | Test File(s) | Assessment |
|--------------|-------------|------------|
| Payment/Subscriptions | `subscriptions.test.js` (78 tests) | STRONG |
| Loyalty Processing | 38 test files (857+ tests) | STRONG |
| Tenant Isolation | `merchant-isolation.test.js` | COVERED |
| Authentication | `auth.test.js` + `auth-security.test.js` | STRONG |
| Square OAuth | `oauth-csrf.test.js` | COVERED |
| Webhook Processing | `webhooks.test.js` + `webhook-*.test.js` | COVERED |

**All critical paths have dedicated tests.**

---

## 10.4 Mock Quality Analysis

Sampled 5 test files to verify tests exercise real logic, not just mock pass-through:

| Test File | Mock Boundary | Real Logic Tested | Verdict |
|-----------|--------------|-------------------|---------|
| `subscriptions.test.js` | db.query, squareClient | Validation, promo codes, plan selection, error paths | Real logic |
| `auth.test.js` | db.query, bcrypt | Login flow, session, rate limiting, lockout, token expiry | Real logic |
| `merchant-isolation.test.js` | middleware | merchant_id enforcement, cross-tenant rejection | Real logic |
| `purchase-orders.test.js` | db.query, db.transaction | Multi-step PO flow, validation, error paths | Real logic |
| `discount-validation-service.test.js` | — | Business rules for discount dedup/stacking | Real logic |

**No mock-only tests found.** All sampled tests exercise real application logic through mocked data boundaries.

---

## 10.5 Regression Tests

- Bug fix commits consistently include test file changes in the same commit
- CLAUDE.md enforces "Tests required in same commit — no exceptions"
- Edge case tests found for past bugs (delivery with no customer, PO with zero quantity, etc.)
- No evidence of production bugs without corresponding regression tests

---

## Summary of Findings

| Sub-section | Rating | Key Finding |
|-------------|--------|-------------|
| 10.1 Test Volume | PASS | 4,035 tests / 188 files |
| 10.2 Route Coverage | PASS | 20/27 routes tested; 7 gaps are admin/operational |
| 10.3 Critical Paths | PASS | All critical paths covered |
| 10.4 Mock Quality | PASS | Tests exercise real logic through mocked boundaries |
| 10.5 Regression Tests | PASS | Bug fixes include tests per CLAUDE.md policy |

## Recommendations

| Priority | Item | Effort |
|----------|------|--------|
| MEDIUM | Add tests for routes/admin.js, routes/sync.js, routes/merchants.js | 4-6 hours |
| MEDIUM | Configure jest `--coverage` threshold (80%) in CI | 1 hour |
| LOW | Add integration tests using a real PostgreSQL instance | 8-16 hours |
| LOW | Add tests for routes/logs.js, routes/catalog-health.js, routes/catalog-location-health.js | 2-3 hours |
