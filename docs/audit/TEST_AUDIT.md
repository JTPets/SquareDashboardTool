# Test Suite Audit

**Audit Date:** 2026-04-12

---

## Summary

| Metric | Value |
|--------|-------|
| Total Test Files | 284 |
| Total Test Code Lines | 102,138 |
| Test Framework | Jest 29.7.0 |
| HTTP Testing | Supertest 7.2.2 |
| Total Test Suites | 289 |
| Total Tests | 5,876 |
| Failures | 0 |
| Snapshot Tests | 0 |
| Parametrized Tests | 17 (`test.each()`) |
| Overall Statements | 81.57% (15,285 / 18,737) |
| Overall Branches | 73.33% (7,811 / 10,651) |
| Overall Functions | 79.69% (1,633 / 2,049) |
| Overall Lines | 81.98% (14,747 / 17,987) |

---

## Test Organization

```
__tests__/
├── config/              (2 files)   Feature registry, permissions
├── database/            (4 files)   Schema integrity, cascade FKs, tenant isolation, timestamps
├── frontend/            (1 file)    Utility script tags
├── integration/         (1 file)    Subscription lifecycle (end-to-end)
├── jobs/                (17 files)  Auto-min-max, expiry discounts, email heartbeat, etc.
├── middleware/           (14 files)  Auth, merchant, permissions, security, validators
├── plugins/             (3 files)   Feature gate, installer, registry, loader
├── routes/              (80 files)  API route testing (auth, catalog, loyalty, subscriptions)
├── scripts/             (2 files)   Migration, schema validation
├── security/            (5 files)   CSRF, OAuth, multi-tenant isolation, password, path traversal
├── services/            (150+ files)
│   ├── auth/            (3 files)
│   ├── cart/            (1 file)
│   ├── catalog/         (6 files)
│   ├── delivery/        (6 files)
│   ├── expiry/          (1 file)
│   ├── gmc/             (4 files)
│   ├── inventory/       (2 files)
│   ├── label/           (1 file)
│   ├── loyalty-admin/   (38 files)  ← Largest subsection
│   ├── purchase-orders/ (3 files)
│   ├── reports/         (1 file)
│   ├── seniors/         (1 file)
│   ├── square/          (11 files)  ← Square API integration tests
│   ├── staff/           (1 file)
│   ├── subscriptions/   (3 files)
│   ├── vendor/          (5 files)
│   └── webhook-handlers/ (21 files) ← Webhook handler tests
├── tools/               (1 file)    Loyalty audit
└── utils/               (25 files)  Password, token encryption, email notifier, etc.
```

### Test Types
| Type | Count | Description |
|------|-------|-------------|
| Unit | 150+ | Service/utility function testing |
| Route/API | 80 | HTTP endpoint testing via Supertest |
| Webhook Handler | 21 | Event processing tests |
| Middleware | 14 | Auth, merchant, security middleware |
| Job | 17 | Cron job testing |
| Security | 5 | CSRF, multi-tenant isolation, password hashing |
| Database/Schema | 4 | Schema validation (filesystem-based, no DB) |
| Integration | 1 | End-to-end subscription lifecycle |
| Config | 2 | Feature registry, permissions |

---

## Test Configuration

**File:** `jest.config.js`

| Setting | Value |
|---------|-------|
| Environment | Node.js |
| Patterns | `__tests__/**/*.test.js`, `*.test.js` |
| Ignored | `/node_modules/`, `/public/`, `/storage/` |
| Timeout | 10,000ms |
| Mock Behavior | Clear + restore between tests |
| Setup File | `__tests__/setup.js` |
| CI Reporters | jest-junit |

**Package.json Scripts:**
```bash
npm test                # jest
npm run test:watch      # jest --watch
npm run test:coverage   # jest --coverage
npm run test:ci         # jest --ci --coverage --reporters=default --reporters=jest-junit
```

---

## Coverage Configuration

### Measured Coverage by Directory

Measured via `npx jest --coverage --no-coverage-threshold --silent`.

| Directory | Statements | Branches | Functions | Lines |
|-----------|------------|----------|-----------|-------|
| **All files** | **81.57%** | **73.33%** | **79.69%** | **81.98%** |
| `middleware/` | 61.88% | 62.30% | 49.23% | 62.27% |
| `middleware/validators/` | 63.77% | 49.51% | 45.80% | 64.26% |
| `routes/` | 87.98% | 70.03% | 89.25% | 88.45% |
| `routes/auth/` | 98.13% | 68.75% | 100% | 100% |
| `routes/delivery/` | 93.80% | 70.12% | 96.00% | 98.93% |
| `routes/gmc/` | 82.85% | 70.37% | 80.55% | 83.50% |
| `routes/loyalty/` | 99.01% | 87.62% | 100% | 100% |
| `routes/subscriptions/` | 64.51% | 43.42% | 40.00% | 65.70% |
| `routes/vendor-catalog/` | 94.25% | 74.46% | 100% | 100% |
| `routes/webhooks/` | 0.00% | 100% | 0.00% | 0.00% |
| `services/` (root) | 93.33% | 77.77% | 80.00% | 95.00% |
| `services/merchant/` | 43.47% | 65.30% | 55.55% | 43.47% |
| `services/reports/` | 65.90% | 43.31% | 61.11% | 67.20% |
| `services/seniors/` | 52.26% | 44.52% | 51.42% | 51.06% |
| `services/square/` | 90.14% | 79.19% | 93.83% | 90.93% |
| `services/subscriptions/` | 94.71% | 88.23% | 94.11% | 95.51% |
| `services/vendor/` | 89.98% | 81.89% | 91.30% | 90.56% |
| `services/webhook-handlers/` | 94.75% | 95.25% | 71.15% | 94.81% |
| `utils/` | 37.98% | 44.13% | 60.00% | 37.67% |

### Per-File Thresholds (jest.config.js)

**Security-Critical Files (High Requirements):**
| File | Branches | Functions | Lines | Statements |
|------|----------|-----------|-------|------------|
| `utils/token-encryption.js` | **100%** | **100%** | **100%** | **100%** |
| `utils/password.js` | 80% | 100% | 90% | 90% |
| `middleware/auth.js` | 70% | 80% | 80% | 80% |
| `middleware/merchant.js` | 20% | 40% | 25% | 25% |

**Directory-Level Thresholds:**
| Directory | Branches | Functions | Lines | Statements |
|-----------|----------|-----------|-------|------------|
| `services/` | 8% | 10% | 10% | 10% |
| `routes/` | 1% | 0% | 2% | 2% |

> Thresholds are set far below measured coverage; measured coverage far exceeds the enforced floors.

**Collection Scope:**
```javascript
collectCoverageFrom: [
    'utils/**/*.js',
    'middleware/**/*.js',
    'routes/**/*.js',
    'services/**/*.js',
    '!**/node_modules/**',
    '!**/__tests__/**'
]
```

---

## Global Test Setup (`__tests__/setup.js`)

### Environment
```javascript
process.env.NODE_ENV = 'test';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);  // Test key
process.env.SESSION_SECRET = 'test-session-secret-for-jest-tests';
```

### Global Mocks (applied to ALL tests)

**1. Logger** (lines 18-23)
```javascript
jest.mock('../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
```

**2. Email Notifier** (lines 26-39)
```javascript
jest.mock('../utils/email-notifier', () => ({
    sendCritical: jest.fn(), sendAlert: jest.fn(),
    sendInfo: jest.fn(), sendHeartbeat: jest.fn(),
    sendBackup: jest.fn(), enabled: false
}));
```

**3. Database** (lines 43-59)
```javascript
jest.mock('../utils/database', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    transaction: jest.fn(),   // Returns mock client
    getClient: jest.fn(),     // Returns mock client
    pool: { end: jest.fn() }
}));
```

---

## Square API Mocking Strategy

### Level 1: HTTP/Fetch Level
**Files:** `__tests__/services/square/square-client.test.js`
```javascript
jest.mock('node-fetch', () => jest.fn());
```
- Mocks at the lowest level (HTTP transport)
- Used for testing retry logic, rate limiting, error handling

### Level 2: Square Service Module Level
**Files:** `__tests__/services/square/*.test.js` (11 files)
```javascript
jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn(),
    makeSquareRequest: jest.fn()
}));
```
- Mocks the Square client, not HTTP
- Used for testing sync logic, data transformation

### Level 3: Full Service Mock
**Files:** 30+ files across routes and services
```javascript
jest.mock('../../../services/square/square-catalog-sync', () => ({
    syncCatalog: jest.fn(), deltaSyncCatalog: jest.fn()
}));
```
- Mocks entire service modules
- Used for route/handler testing

### Mock Usage Statistics
| Mock Target | Files Using It |
|-------------|---------------|
| `utils/database` | ~250 |
| `utils/logger` | ~240 |
| `middleware/auth` | ~80 |
| `middleware/merchant` | ~70 |
| `services/square/*` | ~30 |
| `utils/token-encryption` | ~10 |
| `node-fetch` | ~5 |

---

## Test Data Patterns

### No Dedicated Fixtures
- No `__fixtures__/` or `__factories__/` directory
- Test data created inline in each test file

### Merchant Context in Route Tests
```javascript
// Pattern used in 80+ route test files
app.use((req, res, next) => {
    if (authenticated) req.session.user = { id: 1, email: 'test@test.com', role: 'admin' };
    if (hasMerchant) req.merchantContext = { id: 1, businessName: 'Test Store' };
    if (activeMerchantId) req.session.activeMerchantId = 1;
    next();
});
```

### Database Query Sequencing
```javascript
// Pattern for complex flows (subscription-lifecycle.test.js)
function mockDbSequence(responses) {
    db.query.mockReset();
    responses.forEach(r => db.query.mockResolvedValueOnce(r));
}
```

### Multi-Tenant Isolation Tests
```javascript
// Separate merchant/user objects
const MERCHANT_A = { id: 1, businessName: 'Store A' };
const MERCHANT_B = { id: 2, businessName: 'Store B' };
const USER_A = { id: 1, email: 'a@test.com' };
const USER_B = { id: 2, email: 'b@test.com' };
// Verify one tenant cannot access another's data
```

### Supertest HTTP Testing
```javascript
// Pattern used in route tests
function createTestApp(opts = {}) {
    const app = express();
    app.use(express.json());
    app.use(session({...}));
    app.use((req, res, next) => {
        if (authenticated) req.session.user = {...};
        next();
    });
    app.use('/api/auth', authRoutes);
    return app;
}
```

---

## Database in Tests

| Aspect | Approach |
|--------|----------|
| Real DB connections | **None** — all queries mocked |
| Transaction testing | Mock client with `query`/`release` |
| Schema validation | Filesystem-based (reads .sql files, no DB) |
| Test isolation | `jest.clearAllMocks()` in `beforeEach` |

---

## Key Test Gaps

Confirmed from actual coverage run (not inferred):

1. **`routes/webhooks/` — 0% line coverage** — `routes/webhooks/square.js` has no test file; the Square webhook HTTP entry point is entirely uncovered.
2. **`routes/subscriptions/` — 64.51% lines** — Notably `public.js` (50%) and `webhooks.js` (41.66%) are weak; `admin.js` sits at 53.84% statements.
3. **`services/merchant/` — 43.47% lines** — `settings-service.js` is only 18.18% covered (lines 62-201 untested).
4. **`services/seniors/` — 52.26% lines** — `seniors-service.js` is 43.06% covered; most of lines 82-284 and 499-798 are untested.
5. **`services/reports/` — 65.9% lines** — `loyalty-reports.js` is only 51.18% covered; large unreported ranges (436-491, 1133-1447).
6. **`middleware/validators/` — 63.77% lines** — Several validator modules are entirely untested: `cycle-counts.js`, `expiry-discounts.js`, `gmc.js`, `purchase-orders.js` (all 0%), plus several at 0% statement coverage (`ai-autofill.js`, `cart-activity.js`, `min-max-suppression.js`, `seniors.js`, `sync.js`).
7. **`utils/` — 37.98% lines** — Several utilities are entirely unexecuted during the suite: `database.js`, `schema-manager.js`, `square-subscriptions.js`, `link-existing-subscribers.js` (all 0%); `privacy-format.js` (2.63%), `r2-backup.js` (37.93%), `subscription-handler.js` (32.32%), `square-webhooks.js` (51.56%).
8. **`middleware/security.js` — 18.60% statements** — Most of the security middleware body is uncovered despite global `middleware/` threshold.
9. **No real database tests** — All DB queries mocked; no integration tests against a test database.
10. **No end-to-end tests** — No browser/UI testing (Cypress, Playwright, etc.).
11. **Single integration test** — Only subscription lifecycle has multi-step flow testing.
12. **No test fixtures** — Inline data creation leads to inconsistent test data across files.
13. **No Square response fixtures** — Square API responses are hand-crafted per test.

---

## Test Infrastructure Strengths

1. **Comprehensive security tests** — 5 dedicated files + high thresholds for crypto code
2. **Strong webhook handler coverage** — 21 test files covering all event types
3. **Schema validation without DB** — CI-friendly filesystem-based checks
4. **Multi-tenant isolation testing** — Dedicated tests verify cross-tenant data access prevention
5. **100% coverage required** for `token-encryption.js` — critical crypto code fully tested
6. **Consistent patterns** — Route tests follow uniform `createTestApp()` pattern
