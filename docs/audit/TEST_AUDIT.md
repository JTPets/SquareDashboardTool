# Test Suite Audit

**Audit Date:** 2026-04-10

---

## Summary

| Metric | Value |
|--------|-------|
| Total Test Files | 284 |
| Total Test Code Lines | 102,138 |
| Test Framework | Jest 29.7.0 |
| HTTP Testing | Supertest 7.2.2 |
| Total Test Suites | 268 |
| Total Tests | 5,464 |
| Failures | 0 |
| Snapshot Tests | 0 |
| Parametrized Tests | 17 (`test.each()`) |

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

### Thresholds (jest.config.js:34-76)

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

1. **No real database tests** — All DB queries mocked; no integration tests against a test database
2. **No end-to-end tests** — No browser/UI testing (Cypress, Playwright, etc.)
3. **Low directory-level thresholds** — Routes: 1% branches, Services: 8% branches
4. **Single integration test** — Only subscription lifecycle has multi-step flow testing
5. **No test fixtures** — Inline data creation leads to inconsistent test data across files
6. **No Square response fixtures** — Square API responses are hand-crafted per test

---

## Test Infrastructure Strengths

1. **Comprehensive security tests** — 5 dedicated files + high thresholds for crypto code
2. **Strong webhook handler coverage** — 21 test files covering all event types
3. **Schema validation without DB** — CI-friendly filesystem-based checks
4. **Multi-tenant isolation testing** — Dedicated tests verify cross-tenant data access prevention
5. **100% coverage required** for `token-encryption.js` — critical crypto code fully tested
6. **Consistent patterns** — Route tests follow uniform `createTestApp()` pattern
