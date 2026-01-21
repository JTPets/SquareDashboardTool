# Security & Architecture Review
**Date:** January 21, 2026
**Application:** Square Dashboard Tool
**Review Type:** Comprehensive Vibe Coder Assessment

---

## Executive Summary

This application is a **production-grade multi-tenant SaaS platform** that has grown organically. While it contains solid security foundations (parameterized queries, bcrypt, encrypted tokens), it has critical gaps that create real business risk.

### Risk Matrix

| Area | Current State | Business Risk |
|------|--------------|---------------|
| **Testing** | 0 tests for 235+ functions | CRITICAL |
| **Code Structure** | 14,404-line monolith | HIGH |
| **Security** | CSP disabled, CORS permissive | HIGH |
| **Scalability** | Synchronous operations | MEDIUM |
| **Documentation** | Minimal inline docs | MEDIUM |

---

## Part 1: What You're Doing Right

Before the bad news, recognize these solid foundations:

### Security Wins Already In Place
- **SQL Injection Protection**: All queries use parameterized statements
- **Password Security**: bcrypt with 12 salt rounds
- **Token Encryption**: AES-256-GCM for OAuth tokens at rest
- **Session Security**: HttpOnly cookies, SameSite=Lax
- **Rate Limiting**: Login (5/15min) and general API limits
- **Account Lockout**: 5 failed attempts = 30-minute lockout
- **Audit Logging**: Auth events tracked in database
- **Multi-tenant Isolation**: All queries filtered by merchant_id

### Architecture Wins
- Proper middleware separation (auth, merchant, security)
- Environment-based configuration
- PM2 for process management
- Winston for structured logging
- Proper OAuth 2.0 flows for Square and Google

---

## Part 2: Critical Issues

### Issue #1: Zero Test Coverage (CRITICAL)

**The Problem:**
```
Total Functions: 235+
Total Tests: 0
Test Coverage: 0%
```

**Why This Matters:**
- Loyalty program (4,833 lines, 56 functions) calculates rewards with real money
- One bug could give away unlimited free products
- Password reset bugs could lock out all users
- Multi-tenant bugs could expose merchant data to competitors

**Files That MUST Be Tested First:**

| File | Lines | Risk | Why |
|------|-------|------|-----|
| `utils/password.js` | 47 | CRITICAL | Account security |
| `utils/token-encryption.js` | 133 | CRITICAL | OAuth token safety |
| `routes/auth.js` | 525 | CRITICAL | Login/logout/reset |
| `middleware/auth.js` | 181 | CRITICAL | Access control |
| `middleware/merchant.js` | 208 | CRITICAL | Multi-tenant isolation |
| `utils/loyalty-service.js` | 4,833 | CRITICAL | Financial calculations |

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
  ├── auth.js           ✓ (already exists)
  ├── square-oauth.js   ✓ (already exists)
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

### Issue #3: Security Configuration Gaps (HIGH)

#### 3a. Content Security Policy Disabled
**File:** `middleware/security.js:16-18`
```javascript
contentSecurityPolicy: false,
// TODO: Configure proper CSP that works with the app
```

**Risk:** XSS attacks can execute arbitrary JavaScript

**Fix:**
```javascript
contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"], // Tighten later
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'", "https://connect.squareup.com"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'"],
    frameSrc: ["'none'"],
  },
},
```

#### 3b. CORS Allows All Origins
**File:** `middleware/security.js:179-184`
```javascript
if (!allowedOrigins) {
    return callback(null, true); // Allows any origin!
}
```

**Risk:** Any website can make authenticated requests

**Fix:** Always require explicit ALLOWED_ORIGINS in production

#### 3c. File Upload Security
**File:** `server.js:190-200`

**Current:** Only checks MIME type
**Risk:** Malicious files can spoof MIME types

**Fix:** Add magic number validation:
```javascript
const fileSignatures = {
  'ffd8ffe0': 'image/jpeg',
  '89504e47': 'image/png',
  '47494638': 'image/gif',
};
```

---

### Issue #4: Input Validation Gaps (MEDIUM-HIGH)

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

### Phase 1: Foundation Safety (Do First)

#### Week 1-2: Testing Infrastructure
```bash
# Install testing framework
npm install --save-dev jest supertest @types/jest

# Create jest.config.js
# Set up test database
# Write first critical tests
```

**Start with these test files:**
1. `__tests__/utils/password.test.js`
2. `__tests__/utils/token-encryption.test.js`
3. `__tests__/middleware/auth.test.js`
4. `__tests__/routes/auth.test.js`

#### Week 2-3: Security Quick Wins
1. Enable CSP (even permissive is better than none)
2. Force ALLOWED_ORIGINS in production
3. Add file signature validation to uploads
4. Remove stack traces from production errors

---

### Phase 2: Code Health

#### Month 1: Split Server.js
Extract routes in this order:
1. `/api/items/*` → `routes/items.js`
2. `/api/variations/*` → `routes/variations.js`
3. `/api/inventory/*` → `routes/inventory.js`
4. `/api/purchase-orders/*` → `routes/purchase-orders.js`
5. `/api/loyalty/*` → `routes/loyalty.js`
6. `/api/delivery/*` → `routes/delivery.js`

**Benefit:** Each extraction is testable independently

#### Month 2: Input Validation
Add express-validator to all endpoints:
- All POST/PUT/PATCH bodies validated
- All URL parameters validated
- All query strings validated

---

### Phase 3: Production Hardening

#### Scalability Prep
1. Add Redis for sessions and caching
2. Move file uploads to S3
3. Add Bull for background job queue
4. Configure proper connection pool limits

#### Monitoring
1. Add health check endpoint (exists at `/api/health`)
2. Add application metrics (response times, error rates)
3. Add alerting for error spikes

---

## Part 4: Testing Strategy

### Recommended Stack
```json
{
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^6.3.4",
    "@faker-js/faker": "^8.4.0",
    "jest-extended": "^4.0.2"
  }
}
```

### Test Categories

#### Unit Tests (Fast, Isolated)
```javascript
// __tests__/utils/password.test.js
describe('Password Utils', () => {
  test('validates password with all requirements', () => {
    expect(validatePassword('Abcd1234')).toBe(true);
    expect(validatePassword('abcd1234')).toBe(false); // no uppercase
    expect(validatePassword('ABCD1234')).toBe(false); // no lowercase
    expect(validatePassword('Abcdefgh')).toBe(false); // no number
    expect(validatePassword('Abc1')).toBe(false);     // too short
  });
});
```

#### Integration Tests (With Database)
```javascript
// __tests__/routes/auth.integration.test.js
describe('Auth Routes', () => {
  test('locks account after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@test.com', password: 'wrong' });
    }

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@test.com', password: 'correct' });

    expect(response.status).toBe(423); // Locked
  });
});
```

#### API Contract Tests
```javascript
// __tests__/api/items.test.js
describe('GET /api/items', () => {
  test('returns paginated items with required fields', async () => {
    const response = await authenticatedRequest()
      .get('/api/items?limit=10');

    expect(response.body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          variations: expect.any(Array),
        })
      ]),
      pagination: expect.objectContaining({
        total: expect.any(Number),
        limit: 10,
      })
    });
  });
});
```

### Coverage Targets

| Priority | Component | Target |
|----------|-----------|--------|
| P0 | Authentication | 90%+ |
| P0 | Authorization | 90%+ |
| P0 | Password/Token utils | 100% |
| P1 | Loyalty calculations | 80%+ |
| P1 | Multi-tenant isolation | 90%+ |
| P2 | API endpoints | 70%+ |
| P3 | UI integration | 50%+ |

---

## Part 5: Quick Wins (Do Today)

### 1. Enable Basic CSP
```javascript
// middleware/security.js - Change line 16-18
contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'"],
  },
},
```

### 2. Force CORS Configuration
```javascript
// middleware/security.js - Change lines 179-184
if (!allowedOrigins) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('CORS: ALLOWED_ORIGINS must be set in production');
        return callback(new Error('CORS not configured'), false);
    }
    return callback(null, true);
}
```

### 3. Hide Stack Traces in Production
```javascript
// server.js error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message,
    // Never send stack in production
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});
```

### 4. Add .env.example
Create a file showing required environment variables without actual secrets.

---

## Part 6: Files to Review

### Highest Risk (Read These First)
1. `server.js` - Main application (14,404 lines)
2. `utils/loyalty-service.js` - Financial calculations (4,833 lines)
3. `utils/square-api.js` - External API integration (3,414 lines)
4. `utils/database.js` - All data access (2,496 lines)
5. `middleware/auth.js` - Access control (181 lines)
6. `middleware/merchant.js` - Multi-tenant isolation (208 lines)

### Security Configuration
1. `middleware/security.js` - Security headers, CORS, rate limiting
2. `utils/token-encryption.js` - OAuth token security
3. `utils/password.js` - Password hashing

---

## Conclusion

Your application is more sophisticated than most "vibe coded" projects. The foundations are solid. The risks are manageable.

**Priority order:**
1. Add testing (prevents regression bugs)
2. Fix security configuration (CSP, CORS)
3. Split the monolith (maintainability)
4. Add input validation (defense in depth)
5. Scale when needed (not before)

The biggest risk isn't that the code is bad - it's that **you have no way to know when changes break things**. Testing solves this.

---

## Appendix: Vulnerability Summary

| ID | Severity | Issue | File | Line |
|----|----------|-------|------|------|
| V001 | CRITICAL | CSP Disabled | middleware/security.js | 16 |
| V002 | HIGH | CORS allows all | middleware/security.js | 179 |
| V003 | HIGH | Legacy unencrypted tokens | utils/square-api.js | 54 |
| V004 | MEDIUM | Stack traces exposed | server.js | 323 |
| V005 | MEDIUM | MIME-only file validation | server.js | 190 |
| V006 | MEDIUM | GMC token no rate limit | server.js | 3837 |
| V007 | LOW | Test endpoints in production | server.js | 688 |
| V008 | LOW | console.log in production | server.js | 6 |

---

*Document generated by security review on 2026-01-21*
