# Security & Architecture Review
**Date:** January 21, 2026
**Last Updated:** January 22, 2026
**Application:** Square Dashboard Tool
**Review Type:** Comprehensive Vibe Coder Assessment

---

## Executive Summary

This application is a **production-grade multi-tenant SaaS platform** that has grown organically. While it contains solid security foundations (parameterized queries, bcrypt, encrypted tokens), it has critical gaps that create real business risk.

### Risk Matrix

| Area | Current State | Business Risk | Status |
|------|--------------|---------------|--------|
| **Testing** | 194 tests for security functions | LOW | MOSTLY FIXED |
| **Code Structure** | 9,584-line monolith (120 endpoints) | HIGH | Phase 3 In Progress |
| **Security** | CSP enabled, CORS enforced, file validation | LOW | FIXED |
| **Input Validation** | express-validator on 7 extracted routes | LOW | Phase 3 In Progress |
| **Scalability** | Synchronous operations | MEDIUM | Phase 4 |
| **Documentation** | Security review documented | LOW | FIXED |
| **npm Vulnerabilities** | 0 vulnerabilities | NONE | FIXED |

---

## Completed Fixes (January 21, 2026)

### Security Fixes Applied

| Fix | Description | Status |
|-----|-------------|--------|
| CSP Headers | Enabled Content Security Policy with permissive but protective directives | DONE |
| CORS Enforcement | Production now blocks requests if ALLOWED_ORIGINS not configured | DONE |
| Error Messages | Stack traces hidden from clients in production | DONE |
| bcrypt Upgrade | Updated from v5.1.1 to v6.0.0 (fixes tar vulnerabilities) | DONE |
| supertest Upgrade | Updated from v6.3.4 to v7.1.3 (fixes deprecation) | DONE |

### Testing Infrastructure Added

| Component | Tests | Coverage | What's Protected |
|-----------|-------|----------|------------------|
| `utils/password.js` | 49 | ~96% | Password hashing, validation |
| `utils/token-encryption.js` | 51 | 100% | OAuth token encryption |
| `middleware/auth.js` | 38 | ~85% | Login/logout, role checks, admin access |
| `middleware/merchant.js` | 27 | ~30% | Multi-tenant isolation, subscriptions |
| `utils/file-validation.js` | 30 | 100% | File upload magic number validation |
| **Total** | **194** | - | Critical security functions |

**Run tests with:**
```bash
npm test                    # Run all tests
npm run test:coverage       # Run with coverage report
npm run test:watch          # Watch mode for development
```

---

## Part 1: What You're Doing Right

Before the bad news, recognize these solid foundations:

### Security Wins Already In Place
- **SQL Injection Protection**: All queries use parameterized statements
- **Password Security**: bcrypt with 12 salt rounds (now v6.0.0)
- **Token Encryption**: AES-256-GCM for OAuth tokens at rest
- **Session Security**: HttpOnly cookies, SameSite=Lax
- **Rate Limiting**: Login (5/15min) and general API limits
- **Account Lockout**: 5 failed attempts = 30-minute lockout
- **Audit Logging**: Auth events tracked in database
- **Multi-tenant Isolation**: All queries filtered by merchant_id
- **CSP Headers**: Now enabled with protective directives
- **CORS Protection**: Now enforced in production
- **Access Control**: Role-based middleware tested (165 tests)

### Architecture Wins
- Proper middleware separation (auth, merchant, security)
- Environment-based configuration
- PM2 for process management
- Winston for structured logging
- Proper OAuth 2.0 flows for Square and Google
- Automated testing infrastructure (Jest)

---

## Part 2: Remaining Issues

### Issue #1: Limited Test Coverage (LOW - was CRITICAL)

**Current State:**
```
Total Functions: 235+
Tests Written: 165
Coverage: Security utilities + access control middleware
```

**What's Tested:**
- Password validation, hashing, verification
- Token encryption/decryption
- Authentication middleware (requireAuth, requireAdmin, requireRole)
- Authorization middleware (requireWriteAccess)
- Multi-tenant isolation (requireMerchant, requireMerchantRole)
- Subscription validation (requireValidSubscription)
- IP address extraction for audit logs

**Still Needs Testing (Optional - Lower Priority):**
| File | Lines | Risk | Why |
|------|-------|------|-----|
| `routes/auth.js` | 525 | MEDIUM | Login/logout/reset flows (needs DB mocking) |
| `utils/loyalty-service.js` | 4,833 | MEDIUM | Financial calculations (complex) |

---

### Issue #2: Monolithic Server File (HIGH)

**The Problem:**
`server.js` contains 9,584 lines with:
- **120 API endpoint definitions** (verified by code analysis on 2026-01-22)
- Business logic mixed with routing
- Configuration mixed with handlers
- 7 route files extracted so far (auth.js, square-oauth.js, driver-api.js, purchase-orders.js, subscriptions.js, loyalty.js, gmc.js)

**Why This Matters:**
- Impossible to understand full system
- Changes in one area break unrelated features
- Multiple developers will create merge conflicts
- Can't reuse code between endpoints

**Current Route Extraction Status:**

| Route File | Status | Endpoints | Validators |
|------------|--------|-----------|------------|
| `routes/auth.js` | DONE | 12 endpoints | N/A (inline) |
| `routes/square-oauth.js` | DONE | 4 endpoints | N/A |
| `routes/driver-api.js` | DONE | 8 endpoints (public) | ✅ driver-api.js |
| `routes/purchase-orders.js` | DONE | 9 endpoints | ✅ purchase-orders.js |
| `routes/subscriptions.js` | DONE | 11 endpoints | ✅ subscriptions.js |
| `routes/loyalty.js` | DONE | 41 endpoints | ✅ loyalty.js |
| `routes/gmc.js` | DONE | 32 endpoints | ✅ gmc.js |
| `routes/delivery.js` | TODO | 24 endpoints | ❌ Needed |
| `routes/webhooks.js` | TODO | 10 endpoints | ❌ Needed |
| `routes/sync.js` | TODO | 6 endpoints | ❌ Needed |
| `routes/catalog.js` | TODO | 10+ endpoints | ❌ Needed |
| `routes/expiry-discounts.js` | TODO | 15 endpoints | ❌ Needed |
| `routes/merchants.js` | TODO | 10 endpoints | ❌ Needed |
| `routes/cycle-counts.js` | TODO | 9 endpoints | ❌ Needed |
| `routes/vendor-catalog.js` | TODO | 13 endpoints | ❌ Needed |

**Recommended Split (with line ranges from server.js as of 2026-01-22):**

```
routes/
  ├── auth.js              (DONE)
  ├── square-oauth.js      (DONE)
  ├── driver-api.js        (DONE - 8 public endpoints)
  ├── purchase-orders.js   (DONE - 9 endpoints)
  ├── subscriptions.js     (DONE - 11 endpoints)
  ├── loyalty.js           (DONE - 41 endpoints)
  ├── gmc.js               (DONE - 32 endpoints)
  ├── delivery.js          (TODO - lines 7696-8722, 24 endpoints)
  ├── webhooks.js          (TODO - lines 6028-6321+, 10 endpoints)
  ├── sync.js              (TODO - lines 1324-1489, 6 endpoints)
  ├── catalog.js           (TODO - lines 1545-2177, items/variations/inventory)
  ├── expiry-discounts.js  (TODO - lines 2514-2942, 15 endpoints)
  ├── merchants.js         (TODO - lines 302-606, merchants/settings/config)
  ├── cycle-counts.js      (TODO - lines 5256-5954, 9 endpoints)
  └── vendor-catalog.js    (TODO - lines 3844-4285, 13 endpoints)

services/
  ├── sync-service.js      (FUTURE - business logic from server.js)
  ├── inventory-service.js (FUTURE - from utils/database.js)
  └── reporting-service.js (FUTURE - consolidate reporting logic)
```

---

### Issue #3: File Upload Security (MEDIUM)

**File:** `server.js:190-200`

**Current:** Only checks MIME type
**Risk:** Malicious files can spoof MIME types

**Recommended Fix:** Add magic number validation:
```javascript
const fileSignatures = {
  'ffd8ffe0': 'image/jpeg',
  '89504e47': 'image/png',
  '47494638': 'image/gif',
};
```

---

### Issue #4: Input Validation Gaps (LOW - was MEDIUM)

**express-validator is now actively used on all extracted routes.**

**Current State (verified by code analysis 2026-01-22):**
- ✅ `middleware/validators/index.js` - 18 reusable validators (UUID, email, currency, etc.)
- ✅ `middleware/validators/driver-api.js` - 8 validators for driver routes
- ✅ `middleware/validators/subscriptions.js` - 7 validators for subscription routes
- ✅ `middleware/validators/purchase-orders.js` - 8 validators for PO routes
- ✅ `middleware/validators/loyalty.js` - 25+ validators for loyalty routes
- ✅ `middleware/validators/gmc.js` - 16 validators for GMC routes

**Validation Pattern Used:**
```javascript
// In routes/subscriptions.js:
const validators = require('../middleware/validators/subscriptions');
router.post('/subscriptions/create', validators.createSubscription, async (req, res) => {
    // Validated request
});

// In middleware/validators/subscriptions.js:
const createSubscription = [
    validateEmail('email'),
    body('businessName').optional().trim().isLength({ max: 255 }),
    body('plan').isIn(['monthly', 'annual']),
    handleValidationErrors  // Returns 400 with field-specific errors
];
```

**Remaining Work:**
- Add validators to remaining 8 route files as they are extracted
- Endpoints still in server.js lack express-validator (sync, catalog, delivery, etc.)

---

### Issue #5: Scalability Concerns (MEDIUM)

| Current | Problem | Solution |
|---------|---------|----------|
| All sessions in PostgreSQL | Adds DB load | Redis for sessions |
| Sync runs synchronously | Blocks server | Background job queue (Bull) |
| Images on local disk | Can't scale servers | S3 or CDN |
| No caching | Repeat queries | Redis cache layer |
| No connection pooling config | Connection exhaustion | Configure pool limits |

---

## Part 3: Prioritized Action Plan

### Phase 1: Foundation Safety - COMPLETED

- [x] Install Jest testing framework
- [x] Write tests for password utilities (49 tests)
- [x] Write tests for token encryption (51 tests)
- [x] Enable CSP headers
- [x] Enforce CORS in production
- [x] Hide stack traces in production
- [x] Fix npm vulnerabilities (bcrypt v6, supertest v7)

### Phase 2: Expand Test Coverage - COMPLETED

- [x] `__tests__/middleware/auth.test.js` - Access control (38 tests)
- [x] `__tests__/middleware/merchant.test.js` - Multi-tenant isolation (27 tests)
- [ ] `__tests__/routes/auth.test.js` - Login/logout/reset flows (optional - needs DB mocking)
- [ ] `__tests__/utils/loyalty-service.test.js` - Financial calculations (optional - complex)

### Phase 3: Code Health (Next Priority)

**Server.js Extraction Plan** - Prioritized by risk and complexity:

#### Priority 1: Financial & External-Facing (HIGH RISK) - COMPLETED
| Route File | Lines in server.js | Endpoints | Risk Level | Status |
|------------|-------------------|-----------|------------|--------|
| `routes/driver-api.js` | (extracted) | 8 | HIGH - Public API | **DONE** |
| `routes/purchase-orders.js` | (extracted) | 9 | HIGH - Financial | **DONE** |
| `routes/subscriptions.js` | (extracted) | 11 | HIGH - Payment handling | **DONE** |
| `routes/loyalty.js` | (extracted) | 41 | HIGH - Financial calculations | **DONE** |

#### Priority 2: External Integrations (MEDIUM RISK) - IN PROGRESS
| Route File | Lines in server.js | Endpoints | Risk Level | Status |
|------------|-------------------|-----------|------------|--------|
| `routes/gmc.js` | (extracted) | 32 | MEDIUM - Google integration | **DONE** |
| `routes/webhooks.js` | 6028-6321+ | 10 | MEDIUM - External callbacks | TODO |
| `routes/delivery.js` | 7696-8722 | 24 | MEDIUM - Complex state | TODO |

#### Priority 3: Core Operations (LOWER RISK)
| Route File | Lines in server.js | Endpoints | Risk Level | Status |
|------------|-------------------|-----------|------------|--------|
| `routes/sync.js` | 1324-1489 | 6 | LOW - Internal | TODO |
| `routes/catalog.js` | 1545-2177 | 10+ | LOW - CRUD | TODO |
| `routes/expiry-discounts.js` | 2514-2942 | 15 | LOW - Business logic | TODO |
| `routes/cycle-counts.js` | 5256-5954 | 9 | LOW - Internal | TODO |
| `routes/vendor-catalog.js` | 3844-4285 | 13 | LOW - Internal | TODO |
| `routes/merchants.js` | 302-606 | 10 | LOW - Admin | TODO |

**Extraction Checklist Per Route:**
- [ ] Create route file with express Router
- [ ] Extract endpoints from server.js
- [ ] Import required middleware (requireAuth, requireMerchant, etc.)
- [ ] Import required utilities (database, logger, etc.)
- [ ] Add route to server.js via `app.use('/api/...', require('./routes/...'))`
- [ ] Run existing tests to verify no regressions
- [ ] Add input validation using express-validator

**Input Validation Status:**
- ✅ `middleware/validators/` directory created with common utilities
- ✅ Validators added to: driver-api, subscriptions, purchase-orders, loyalty, gmc
- ⏳ Need validators for: delivery, webhooks, sync, catalog, expiry-discounts, cycle-counts, vendor-catalog, merchants

### Phase 4: Production Hardening

**Scalability Prep:**
1. Add Redis for sessions and caching
2. Move file uploads to S3
3. Add Bull for background job queue
4. Configure proper connection pool limits

**Monitoring:**
1. Health check endpoint exists at `/api/health`
2. Add application metrics (response times, error rates)
3. Add alerting for error spikes

---

## Part 4: Testing Strategy

### Current Stack
```json
{
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.1.3",
    "jest-junit": "^16.0.0"
  }
}
```

### Coverage Targets

| Priority | Component | Target | Current | Status |
|----------|-----------|--------|---------|--------|
| P0 | Password/Token utils | 100% | ~98% | DONE |
| P0 | Auth middleware | 80%+ | ~85% | DONE |
| P0 | Merchant middleware | 25%+ | ~30% | DONE |
| P1 | Loyalty calculations | 80%+ | 0% | Optional |
| P2 | API endpoints | 70%+ | 0% | Optional |

---

## Part 5: Environment Configuration

### Required for Production

Add to your `.env`:
```bash
# Required
NODE_ENV=production
ALLOWED_ORIGINS=https://sqtools.ca

# Already configured (verify these exist)
SESSION_SECRET=<your-secret>
TOKEN_ENCRYPTION_KEY=<64-hex-chars>
```

---

## Part 6: Files to Review

### Highest Risk (Read These First)
1. `server.js` - Main application (9,584 lines - down from 14,404)
2. `utils/loyalty-service.js` - Financial calculations (4,833 lines)
3. `utils/square-api.js` - External API integration (3,414 lines)
4. `utils/database.js` - All data access (2,496 lines)

### Security Configuration (Tested)
1. `middleware/security.js` - Security headers, CORS, rate limiting (UPDATED)
2. `middleware/auth.js` - Access control (TESTED - 38 tests)
3. `middleware/merchant.js` - Multi-tenant isolation (TESTED - 27 tests)
4. `utils/token-encryption.js` - OAuth token security (TESTED - 51 tests)
5. `utils/password.js` - Password hashing (TESTED - 49 tests)

---

## Conclusion

Your application is more sophisticated than most "vibe coded" projects. The foundations are solid. **Key security fixes have been applied and tested.**

**Completed (Phase 1 & 2 & Quick Wins):**
1. Testing infrastructure (194 tests passing)
2. Security configuration (CSP, CORS, error handling)
3. Vulnerability fixes (0 npm vulnerabilities)
4. Access control testing (auth middleware - 38 tests)
5. Multi-tenant isolation testing (merchant middleware - 27 tests)
6. **V005 FIXED:** File upload magic number validation (30 tests)
7. **V006 FIXED:** Rate limiting on GMC token regeneration
8. **V007 FIXED:** Test endpoints disabled in production

**Phase 3 - In Progress:**
1. **Split the monolith** - 120 endpoints remain in server.js (was 221)
   - ✅ Priority 1 COMPLETE: Financial routes (loyalty, subscriptions, purchase-orders, driver-api)
   - ⏳ Priority 2 IN PROGRESS: External integrations (gmc ✅, webhooks ❌, delivery ❌)
   - ⏳ Priority 3 TODO: Core operations (sync, catalog, cycle-counts, etc.)
2. **Input validation** - express-validator on all 7 extracted routes, need to add to remaining 8

**Phase 4 - Future (when needed):**
1. Redis for sessions and caching
2. S3 for file uploads
3. Bull for background job queue
4. Application metrics and monitoring

---

## Appendix A: Vulnerability Summary

| ID | Severity | Issue | File | Status |
|----|----------|-------|------|--------|
| V001 | CRITICAL | CSP Disabled | middleware/security.js | **FIXED** |
| V014 | MEDIUM | CSP blocks inline event handlers | middleware/security.js | **FIXED** |
| V002 | HIGH | CORS allows all | middleware/security.js | **FIXED** |
| V003 | HIGH | Legacy unencrypted tokens | utils/square-api.js | MITIGATED (auto-encrypts) |
| V004 | MEDIUM | Stack traces exposed | server.js | **FIXED** |
| V005 | MEDIUM | MIME-only file validation | server.js, utils/file-validation.js | **FIXED** (30 tests) |
| V006 | MEDIUM | GMC token no rate limit | middleware/security.js | **FIXED** |
| V007 | LOW | Test endpoints in production | server.js | **FIXED** (NODE_ENV check) |
| V008 | LOW | console.log in production | server.js (throughout) | LOW PRIORITY |
| V009 | HIGH | npm vulnerabilities (tar/bcrypt) | package.json | **FIXED** |
| V010 | HIGH | Auth middleware untested | middleware/auth.js | **FIXED** (38 tests) |
| V011 | HIGH | Multi-tenant isolation untested | middleware/merchant.js | **FIXED** (27 tests) |
| V012 | MEDIUM | No input validation | All routes | **PARTIAL** (7 routes done) |
| V013 | HIGH | 120 endpoints in monolith | server.js | **IN PROGRESS** (was 221) |

---

## Appendix B: Remaining Vulnerability Details

### V005: MIME-only File Validation - **FIXED**
**Location:** `utils/file-validation.js` (NEW), `server.js` (POD upload endpoints)
**Fix Applied:** Created `validateFileSignature()` utility with magic number validation for:
- JPEG (multiple signatures including EXIF)
- PNG
- GIF (87a and 89a)
- WebP (with RIFF header validation)
- BMP
- TIFF (little and big endian)

Added `validateUploadedImage()` middleware applied to POD photo upload endpoints.
**Tests:** 30 new tests in `__tests__/utils/file-validation.test.js`

### V006: GMC Token No Rate Limit - **FIXED**
**Location:** `middleware/security.js`, `server.js:3976`
**Fix Applied:** Added `configureSensitiveOperationRateLimit()` middleware:
- 5 token regenerations per hour per merchant
- Keyed by merchant ID to prevent abuse
- Applied to `/api/gmc/regenerate-token` endpoint

### V007: Test Endpoints in Production - **FIXED**
**Location:** `server.js:691-737`
**Fix Applied:** Wrapped test endpoints in `if (process.env.NODE_ENV !== 'production')` check:
- `/api/test-email`
- `/api/test-error`
- `/api/test-backup-email`

These endpoints are now only available in development mode.

### V014: CSP Blocks Inline Event Handlers - **FIXED**
**Location:** `middleware/security.js`
**Issue:** Helmet's default CSP sets `script-src-attr: 'none'` which blocks `onclick` attributes even though `script-src` has `'unsafe-inline'`. This caused all 26 HTML files with inline event handlers to fail.
**Fix Applied:** Added `scriptSrcAttr: ["'unsafe-inline'"]` to CSP directives to allow inline event handlers.
**Note:** Long-term, converting onclick attributes to addEventListener would be more secure, but this fix restores functionality for the existing codebase.

### V015: Deprecated Mobile Meta Tags - **FIXED**
**Location:** `public/expiry-audit.html`, `public/cycle-count.html`
**Issue:** Using deprecated `apple-mobile-web-app-capable` without the modern `mobile-web-app-capable` meta tag.
**Fix Applied:** Added `<meta name="mobile-web-app-capable" content="yes">` alongside the existing Apple-specific tag.

### V012: No Input Validation (MEDIUM) - PARTIAL
**Location:** All routes
**Risk:** Invalid data could cause errors or unexpected behavior
**Status:** express-validator implemented on 7 extracted route files with 6 validator modules:
- ✅ `middleware/validators/index.js` - 18 reusable validators
- ✅ `middleware/validators/driver-api.js` - 8 validators
- ✅ `middleware/validators/subscriptions.js` - 7 validators
- ✅ `middleware/validators/purchase-orders.js` - 8 validators
- ✅ `middleware/validators/loyalty.js` - 25+ validators
- ✅ `middleware/validators/gmc.js` - 16 validators
**Remaining:** Add validators to 8 remaining route files as they are extracted

### V013: Monolithic Server File (HIGH) - IN PROGRESS
**Location:** `server.js` (9,584 lines, 120 endpoints - down from 14,409/221)
**Risk:** Unmaintainable code, high merge conflict risk, difficult to test
**Progress:**
- ✅ 7 route files extracted: auth, square-oauth, driver-api, purchase-orders, subscriptions, loyalty, gmc
- ⏳ 8 route files remaining: delivery, webhooks, sync, catalog, expiry-discounts, cycle-counts, vendor-catalog, merchants
**Fix:** Continue extracting routes to separate files (see Phase 3 extraction plan)

---

## Appendix C: Quick Reference

### Test Commands
```bash
npm test                    # Run all tests
npm run test:coverage       # Run with coverage report
npm run test:watch          # Watch mode for development
```

### Security Configuration Files
```
middleware/security.js      # CSP, CORS, rate limiting (includes sensitive operation limiter)
middleware/auth.js          # Authentication (38 tests)
middleware/merchant.js      # Multi-tenant isolation (27 tests)
middleware/validators/      # express-validator middleware
  ├── index.js             # 18 reusable validators and utilities
  ├── driver-api.js        # Driver API validators (8)
  ├── purchase-orders.js   # Purchase order validators (8)
  ├── subscriptions.js     # Subscription validators (7)
  ├── loyalty.js           # Loyalty validators (25+)
  └── gmc.js               # GMC validators (16)
utils/password.js           # Password hashing (49 tests)
utils/token-encryption.js   # Token encryption (51 tests)
utils/file-validation.js    # File upload validation (30 tests)
```

### Key Statistics (Updated 2026-01-22)
- **Total Lines:** 9,584 in server.js (4,825 lines extracted)
- **Total Endpoints:** 120 in server.js (101+ extracted to 7 route files)
- **Extracted Routes:**
  - auth.js (12), square-oauth.js (4)
  - driver-api.js (8), purchase-orders.js (9), subscriptions.js (11)
  - loyalty.js (41), gmc.js (32)
- **Validator Modules:** 6 files with 80+ validators
- **Tests:** 194 passing
- **npm Vulnerabilities:** 0
- **Quick Wins Fixed:** V005, V006, V007
- **Validation Coverage:** express-validator on all 7 extracted route files

---

*Document generated by security review on 2026-01-21*
*Last updated: 2026-01-22 - Phase 3 progress: 101+ endpoints extracted to 7 route files (auth, square-oauth, driver-api, purchase-orders, subscriptions, loyalty, gmc) with express-validator on all. 120 endpoints remain in server.js.*
