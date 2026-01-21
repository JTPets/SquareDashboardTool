# Security & Architecture Review
**Date:** January 21, 2026
**Last Updated:** January 21, 2026
**Application:** Square Dashboard Tool
**Review Type:** Comprehensive Vibe Coder Assessment

---

## Executive Summary

This application is a **production-grade multi-tenant SaaS platform** that has grown organically. While it contains solid security foundations (parameterized queries, bcrypt, encrypted tokens), it has critical gaps that create real business risk.

### Risk Matrix

| Area | Current State | Business Risk | Status |
|------|--------------|---------------|--------|
| **Testing** | 100 tests for critical security functions | MEDIUM | PARTIALLY FIXED |
| **Code Structure** | 14,404-line monolith | HIGH | TODO |
| **Security** | CSP enabled, CORS enforced | LOW | FIXED |
| **Scalability** | Synchronous operations | MEDIUM | TODO |
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

| Component | Tests | Coverage |
|-----------|-------|----------|
| `utils/password.js` | 49 tests | HIGH |
| `utils/token-encryption.js` | 51 tests | HIGH |
| **Total** | **100 tests** | Critical security functions |

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

### Architecture Wins
- Proper middleware separation (auth, merchant, security)
- Environment-based configuration
- PM2 for process management
- Winston for structured logging
- Proper OAuth 2.0 flows for Square and Google
- Automated testing infrastructure (Jest)

---

## Part 2: Remaining Issues

### Issue #1: Limited Test Coverage (MEDIUM - was CRITICAL)

**Current State:**
```
Total Functions: 235+
Tests Written: 100
Coverage: Critical security utilities (password, encryption)
```

**What's Tested:**
- Password validation, hashing, verification
- Token encryption/decryption
- Key validation

**Still Needs Testing:**
| File | Lines | Risk | Why |
|------|-------|------|-----|
| `routes/auth.js` | 525 | HIGH | Login/logout/reset flows |
| `middleware/auth.js` | 181 | HIGH | Access control |
| `middleware/merchant.js` | 208 | HIGH | Multi-tenant isolation |
| `utils/loyalty-service.js` | 4,833 | HIGH | Financial calculations |

---

### Issue #2: Monolithic Server File (HIGH)

**The Problem:**
`server.js` contains 14,404 lines with:
- 131+ API endpoint definitions
- Business logic mixed with routing
- Configuration mixed with handlers

**Why This Matters:**
- Impossible to understand full system
- Changes in one area break unrelated features
- Multiple developers will create merge conflicts
- Can't reuse code between endpoints

**Recommended Split:**

```
routes/
  ├── auth.js           (already exists)
  ├── square-oauth.js   (already exists)
  ├── items.js          (NEW - extract from server.js)
  ├── variations.js     (NEW)
  ├── inventory.js      (NEW)
  ├── purchase-orders.js (NEW)
  ├── loyalty.js        (NEW)
  ├── delivery.js       (NEW)
  ├── sync.js           (NEW)
  ├── admin.js          (NEW)
  └── webhooks.js       (NEW)

services/
  ├── sync-service.js   (NEW - business logic)
  ├── inventory-service.js (NEW)
  └── reporting-service.js (NEW)
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

### Issue #4: Input Validation Gaps (MEDIUM)

**express-validator is installed but underutilized.**

Current validation is inconsistent:
- Some endpoints validate inputs
- Many just trust `req.body` directly

**Example of Missing Validation:**
```javascript
// Current - trusts input
app.patch('/api/variations/:id/cost', async (req, res) => {
  const { cost } = req.body; // What if cost is negative? A string?

// Should be:
app.patch('/api/variations/:id/cost', [
  body('cost').isFloat({ min: 0 }).withMessage('Cost must be positive'),
], async (req, res) => {
```

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

### Phase 2: Expand Test Coverage (Next)

**Priority test files to create:**
1. `__tests__/middleware/auth.test.js` - Access control
2. `__tests__/middleware/merchant.test.js` - Multi-tenant isolation
3. `__tests__/routes/auth.test.js` - Login/logout/reset flows
4. `__tests__/utils/loyalty-service.test.js` - Financial calculations

### Phase 3: Code Health

**Split Server.js** - Extract routes in this order:
1. `/api/items/*` → `routes/items.js`
2. `/api/variations/*` → `routes/variations.js`
3. `/api/inventory/*` → `routes/inventory.js`
4. `/api/purchase-orders/*` → `routes/purchase-orders.js`
5. `/api/loyalty/*` → `routes/loyalty.js`
6. `/api/delivery/*` → `routes/delivery.js`

**Add Input Validation:**
- All POST/PUT/PATCH bodies validated
- All URL parameters validated
- All query strings validated

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

| Priority | Component | Target | Current |
|----------|-----------|--------|---------|
| P0 | Password/Token utils | 100% | ~95% |
| P0 | Authentication | 90%+ | 0% |
| P0 | Authorization | 90%+ | 0% |
| P1 | Loyalty calculations | 80%+ | 0% |
| P1 | Multi-tenant isolation | 90%+ | 0% |
| P2 | API endpoints | 70%+ | 0% |

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
1. `server.js` - Main application (14,404 lines)
2. `utils/loyalty-service.js` - Financial calculations (4,833 lines)
3. `utils/square-api.js` - External API integration (3,414 lines)
4. `utils/database.js` - All data access (2,496 lines)
5. `middleware/auth.js` - Access control (181 lines)
6. `middleware/merchant.js` - Multi-tenant isolation (208 lines)

### Security Configuration (Updated)
1. `middleware/security.js` - Security headers, CORS, rate limiting (UPDATED)
2. `utils/token-encryption.js` - OAuth token security (TESTED)
3. `utils/password.js` - Password hashing (TESTED)

---

## Conclusion

Your application is more sophisticated than most "vibe coded" projects. The foundations are solid. **Key security fixes have been applied.**

**Completed:**
1. Testing infrastructure (100 tests passing)
2. Security configuration (CSP, CORS, error handling)
3. Vulnerability fixes (0 npm vulnerabilities)

**Remaining priority:**
1. Expand test coverage (auth, merchant, loyalty)
2. Split the monolith (maintainability)
3. Add input validation (defense in depth)
4. Scale when needed (not before)

---

## Appendix: Vulnerability Summary

| ID | Severity | Issue | File | Status |
|----|----------|-------|------|--------|
| V001 | CRITICAL | CSP Disabled | middleware/security.js | **FIXED** |
| V002 | HIGH | CORS allows all | middleware/security.js | **FIXED** |
| V003 | HIGH | Legacy unencrypted tokens | utils/square-api.js | MITIGATED (auto-encrypts) |
| V004 | MEDIUM | Stack traces exposed | server.js | **FIXED** |
| V005 | MEDIUM | MIME-only file validation | server.js | TODO |
| V006 | MEDIUM | GMC token no rate limit | server.js | TODO |
| V007 | LOW | Test endpoints in production | server.js | TODO |
| V008 | LOW | console.log in production | server.js | LOW PRIORITY |
| V009 | HIGH | npm vulnerabilities (tar/bcrypt) | package.json | **FIXED** |

---

*Document generated by security review on 2026-01-21*
*Last updated: 2026-01-21 - Added fix status for completed items*
