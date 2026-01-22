# Security & Architecture Review
**Date:** January 21, 2026
**Last Updated:** January 22, 2026 (Phase 3 Complete - All Route Extraction Done)
**Application:** Square Dashboard Tool
**Review Type:** Comprehensive Vibe Coder Assessment

---

## Executive Summary

This application is a **production-grade multi-tenant SaaS platform** that has grown organically. While it contains solid security foundations (parameterized queries, bcrypt, encrypted tokens), it has critical gaps that create real business risk.

### Risk Matrix

| Area | Current State | Business Risk | Status |
|------|--------------|---------------|--------|
| **Testing** | 194 tests for security functions | LOW | FIXED |
| **Code Structure** | 2,670-line server.js (5 endpoints remaining) | LOW | COMPLETE |
| **Security** | CSP enabled, CORS enforced, file validation | LOW | FIXED |
| **Input Validation** | express-validator on all 20 extracted routes | LOW | COMPLETE |
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

### Issue #2: Monolithic Server File (RESOLVED)

**Original Problem:**
`server.js` originally contained 14,409 lines with 221 API endpoint definitions.

**Current State:**
`server.js` now contains only **2,670 lines** with **5 endpoints** (1 health check, 3 dev-only test endpoints, 1 webhook processor).

**Route Extraction Status - COMPLETE:**

| Route File | Status | Endpoints | Lines |
|------------|--------|-----------|-------|
| `routes/auth.js` | **DONE** | 12 endpoints | 897 |
| `routes/square-oauth.js` | **DONE** | 4 endpoints | 534 |
| `routes/driver-api.js` | **DONE** | 8 endpoints (public) | 255 |
| `routes/purchase-orders.js` | **DONE** | 9 endpoints | 759 |
| `routes/subscriptions.js` | **DONE** | 11 endpoints | 817 |
| `routes/loyalty.js` | **DONE** | 40 endpoints | 1,873 |
| `routes/gmc.js` | **DONE** | 32 endpoints | 1,169 |
| `routes/delivery.js` | **DONE** | 23 endpoints | 1,251 |
| `routes/webhooks.js` | **DONE** | 8 mgmt endpoints | 285 |
| `routes/expiry-discounts.js` | **DONE** | 13 endpoints | 491 |
| `routes/vendor-catalog.js` | **DONE** | 13 endpoints | 537 |
| `routes/cycle-counts.js` | **DONE** | 9 endpoints | 502 |
| `routes/sync.js` | **DONE** | 6 endpoints | 213 |
| `routes/catalog.js` | **DONE** | 16 endpoints | 1,549 |
| `routes/square-attributes.js` | **DONE** | 9 endpoints | 220 |
| `routes/google-oauth.js` | **DONE** | 4 endpoints | 127 |
| `routes/merchants.js` | **DONE** | 4 endpoints | 165 |
| `routes/settings.js` | **DONE** | 3 endpoints | 112 |
| `routes/logs.js` | **DONE** | 4 endpoints | 140 |
| `routes/analytics.js` | **DONE** | 5 endpoints | 536 |

**TOTAL:** 20 route files (12,858 lines, 233 endpoints extracted)
**Remaining in server.js:** 5 endpoints (health check, 3 dev-only test endpoints, 1 webhook processor)

**Final Route Structure (COMPLETE):**

```
routes/                        # 20 route files, 12,858 lines, 233 endpoints
  ├── auth.js                  # 12 endpoints - authentication/authorization
  ├── square-oauth.js          # 4 endpoints - Square OAuth flow
  ├── google-oauth.js          # 4 endpoints - Google OAuth flow
  ├── loyalty.js               # 40 endpoints - loyalty program
  ├── delivery.js              # 23 endpoints - delivery management
  ├── driver-api.js            # 8 endpoints - public driver API
  ├── gmc.js                   # 32 endpoints - Google Merchant Center
  ├── subscriptions.js         # 11 endpoints - subscription management
  ├── purchase-orders.js       # 9 endpoints - purchase orders
  ├── webhooks.js              # 8 endpoints - webhook management
  ├── sync.js                  # 6 endpoints - data synchronization
  ├── catalog.js               # 16 endpoints - catalog/inventory
  ├── merchants.js             # 4 endpoints - merchant context
  ├── settings.js              # 3 endpoints - merchant settings
  ├── logs.js                  # 4 endpoints - admin log viewing
  ├── analytics.js             # 5 endpoints - sales/reorder analytics
  ├── cycle-counts.js          # 9 endpoints - inventory cycle counts
  ├── vendor-catalog.js        # 13 endpoints - vendor catalog import
  ├── expiry-discounts.js      # 13 endpoints - expiry discount rules
  └── square-attributes.js     # 9 endpoints - Square custom attributes

services/                      # Future: service layer for complex logic
  └── webhookProcessor.js      # TODO - extract from server.js webhook handler
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

### Issue #4: Input Validation Gaps (RESOLVED)

**express-validator is now used across all extracted routes.**

**Current State:**
- 19 validator files in `middleware/validators/`
- All POST/PUT/PATCH endpoints have input validation
- Centralized validation patterns with reusable common validators

**Validation Coverage (COMPLETE):**

| Validator File | Routes Covered |
|----------------|---------------|
| `index.js` | Common validators and utilities |
| `auth.js` | Authentication routes (via routes/auth.js) |
| `driver-api.js` | Public driver API |
| `purchase-orders.js` | Purchase order CRUD |
| `subscriptions.js` | Subscription management |
| `loyalty.js` | Loyalty program (40 endpoints) |
| `gmc.js` | Google Merchant Center |
| `delivery.js` | Delivery routes |
| `webhooks.js` | Webhook management |
| `expiry-discounts.js` | Expiry discount rules |
| `vendor-catalog.js` | Vendor catalog import |
| `cycle-counts.js` | Inventory cycle counts |
| `sync.js` | Data synchronization |
| `catalog.js` | Catalog/inventory operations |
| `square-attributes.js` | Square custom attributes |
| `google-oauth.js` | Google OAuth flow |
| `merchants.js` | Merchant context |
| `settings.js` | Merchant settings |
| `logs.js` | Admin log viewing |
| `analytics.js` | Sales/reorder analytics |

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

### Phase 3: Code Health (COMPLETE)

**Server.js Extraction - FINISHED**

All 233 endpoints have been extracted to 20 route files (12,858 lines total).
Only 5 endpoints remain in server.js: health check, 3 dev-only test endpoints, and the webhook processor.

#### Complete Extraction List (233 endpoints, 12,858 lines)
| Route File | Endpoints | Risk Level | Status |
|------------|-----------|------------|--------|
| `routes/auth.js` | 12 | HIGH - Authentication | **DONE** |
| `routes/square-oauth.js` | 4 | HIGH - OAuth flow | **DONE** |
| `routes/google-oauth.js` | 4 | HIGH - OAuth flow | **DONE** |
| `routes/driver-api.js` | 8 | HIGH - Public API | **DONE** |
| `routes/purchase-orders.js` | 9 | HIGH - Financial | **DONE** |
| `routes/subscriptions.js` | 11 | HIGH - Payment handling | **DONE** |
| `routes/loyalty.js` | 40 | HIGH - Financial calculations | **DONE** |
| `routes/gmc.js` | 32 | MEDIUM - Google integration | **DONE** |
| `routes/delivery.js` | 23 | HIGH - Customer-facing, POD photos | **DONE** |
| `routes/webhooks.js` | 8 | HIGH - Mgmt endpoints | **DONE** |
| `routes/expiry-discounts.js` | 13 | MEDIUM - Financial calculations | **DONE** |
| `routes/vendor-catalog.js` | 13 | MEDIUM - Import handling | **DONE** |
| `routes/cycle-counts.js` | 9 | MEDIUM - Inventory updates | **DONE** |
| `routes/sync.js` | 6 | MEDIUM - Data sync | **DONE** |
| `routes/catalog.js` | 16 | MEDIUM - Catalog CRUD | **DONE** |
| `routes/square-attributes.js` | 9 | LOW - Internal | **DONE** |
| `routes/merchants.js` | 4 | LOW - Context | **DONE** |
| `routes/settings.js` | 3 | LOW - Config | **DONE** |
| `routes/logs.js` | 4 | LOW - Admin only | **DONE** |
| `routes/analytics.js` | 5 | LOW - Reporting | **DONE** |

#### Remaining: Webhook Processor Service Layer (OPTIONAL)
| Task | Description | Status |
|------|-------------|--------|
| Step 1: Management endpoints | Extract 8 CRUD endpoints | **DONE** |
| Step 2: Webhook processor service | Create `services/webhookProcessor.js` | OPTIONAL |
| Step 3: Event handlers | Consolidate into existing services | OPTIONAL |
| Step 4: Thin route handler | Reduce to ~50 lines | OPTIONAL |

**Note:** The webhook processor remains functional in server.js. Service layer refactoring is optional for improved testability.

**⚠️ Webhook Refactoring Strategy**

The webhook handler (`/api/webhooks/square`) is a ~1,400 line event processor that cannot be simply "extracted" like other routes. It requires a **service layer refactoring** approach.

**Current Problem:**
```
POST /api/webhooks/square (1,400 lines)
    └── Giant switch statement handling 15+ event types
        ├── Direct database queries
        ├── Direct Square API calls
        ├── Inline business logic for loyalty, delivery, inventory
        └── Deeply nested error handling
```

**Target Architecture:**
```
POST /api/webhooks/square (~50 lines)
    └── webhookProcessor.handle(event)
            ├── Verify signature
            ├── Check duplicates
            └── Delegate to services:
                ├── subscriptionService
                ├── catalogSyncService
                ├── inventorySyncService
                ├── deliveryService (exists)
                ├── loyaltyService (exists)
                └── locationService
```

**Webhook Refactoring Plan (4 Steps):**

| Step | Task | Files | Risk |
|------|------|-------|------|
| 1 | Extract management endpoints | `routes/webhooks.js` | LOW |
| 2 | Create webhook processor service | `services/webhookProcessor.js` | MEDIUM |
| 3 | Consolidate event handlers into existing services | `utils/*.js` | MEDIUM |
| 4 | Thin out route handler | `server.js` | LOW |

**Step 1: Extract Management Endpoints (Simple)**
Move these 8 CRUD endpoints to `routes/webhooks.js`:
- `GET /api/webhooks/subscriptions` - List subscriptions
- `GET /api/webhooks/subscriptions/audit` - Audit configuration
- `GET /api/webhooks/event-types` - Get event types
- `POST /api/webhooks/register` - Register new subscription
- `POST /api/webhooks/ensure` - Ensure subscription exists
- `PUT /api/webhooks/subscriptions/:id` - Update subscription
- `DELETE /api/webhooks/subscriptions/:id` - Delete subscription
- `POST /api/webhooks/subscriptions/:id/test` - Send test event

**Step 2: Create Webhook Processor Service**
Create `services/webhookProcessor.js`:
```javascript
// services/webhookProcessor.js
class WebhookProcessor {
    async handle(event, headers, rawBody) {
        await this.verifySignature(headers, rawBody);
        if (await this.isDuplicate(event.event_id)) return { duplicate: true };
        await this.logEvent(event);
        return await this.processEvent(event);
    }

    async processEvent(event) {
        const merchantId = await this.resolveMerchant(event.merchant_id);
        const handler = this.handlers[event.type];
        if (handler) return handler(event.data, merchantId);
        return { unhandled: true };
    }
}
```

**Step 3: Consolidate Event Handlers**
Move business logic from webhook switch cases into appropriate services:

| Event Type | Current Location | Target Service |
|------------|------------------|----------------|
| `subscription.*` | server.js:6416-6452 | `subscriptionHandler.js` (exists) |
| `catalog.version.updated` | server.js:6570-6593 | `square-api.js` (exists) |
| `inventory.count.updated` | server.js:6596-6625 | `square-api.js` (exists) |
| `order.created/updated` | server.js:6628-6847 | `services/orderEventService.js` (NEW) |
| `order.fulfillment.updated` | server.js:6850-6986 | `services/orderEventService.js` (NEW) |
| `vendor.created/updated` | server.js:6991-7048 | `square-api.js` (exists) |
| `location.created/updated` | server.js:7051-7108 | `square-api.js` (exists) |
| `oauth.authorization.revoked` | server.js:7113-7142 | `middleware/merchant.js` |
| `payment.created/updated` | server.js:7147-7284 | `loyaltyService.js` (exists) |
| `refund.created/updated` | server.js:7287-7345 | `loyaltyService.js` (exists) |
| `loyalty.event.created` | server.js:7348-7500 | `loyaltyService.js` (exists) |
| `customer.updated` | server.js:6515-6565 | `deliveryService.js` or NEW |

**Step 4: Thin Route Handler**
Final `server.js` webhook endpoint (~50 lines):
```javascript
const webhookProcessor = require('./services/webhookProcessor');

app.post('/api/webhooks/square', async (req, res) => {
    try {
        const result = await webhookProcessor.handle(
            req.body,
            req.headers,
            req.rawBody
        );
        res.json({ received: true, ...result });
    } catch (error) {
        if (error.code === 'INVALID_SIGNATURE') {
            return res.status(401).json({ error: 'Invalid signature' });
        }
        logger.error('Webhook processing failed', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});
```

**Benefits of This Approach:**
1. **Testable** - Each service can be unit tested independently
2. **Reusable** - `loyaltyService.processOrder()` works from webhook, cron, or manual sync
3. **Maintainable** - Loyalty changes only touch `loyaltyService.js`
4. **Debuggable** - Clear call stack instead of 1,400-line switch statement

**Estimated Effort:** 4-6 hours for full refactoring

---

#### All Route Extraction Priorities: COMPLETE

All route files from Priority 2, 3, and 4 have been extracted:
- **Priority 2 (Financial):** expiry-discounts.js, vendor-catalog.js, cycle-counts.js - **DONE**
- **Priority 3 (Core Operations):** catalog.js, sync.js, square-attributes.js, google-oauth.js - **DONE**
- **Priority 4 (Admin & Config):** merchants.js, settings.js, logs.js, analytics.js - **DONE**

**Extraction Checklist Per Route:** ALL COMPLETE
- [x] Create route file with express Router
- [x] Extract endpoints from server.js
- [x] Import required middleware (requireAuth, requireMerchant, etc.)
- [x] Import required utilities (database, logger, etc.)
- [x] Add route to server.js via `app.use('/api/...', require('./routes/...'))`
- [x] Run existing tests to verify no regressions
- [x] Add input validation using express-validator

**Input Validation Progress:** COMPLETE
- [x] Created `middleware/validators/` directory
- [x] 19 validator files covering all 20 route files

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
1. `server.js` - Main application (14,404 lines)
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

Your application is more sophisticated than most "vibe coded" projects. The foundations are solid. **All major security fixes have been applied and tested. Phase 3 route extraction is COMPLETE.**

**Completed (Phase 1, 2 & 3):**
1. Testing infrastructure (194 tests passing)
2. Security configuration (CSP, CORS, error handling)
3. Vulnerability fixes (0 npm vulnerabilities)
4. Access control testing (auth middleware - 38 tests)
5. Multi-tenant isolation testing (merchant middleware - 27 tests)
6. **V005 FIXED:** File upload magic number validation (30 tests)
7. **V006 FIXED:** Rate limiting on GMC token regeneration
8. **V007 FIXED:** Test endpoints disabled in production

**Phase 3 - COMPLETE:**
1. **Split the monolith** - 100% complete
   - ✓ 20 route files created with 233 endpoints (12,858 lines)
   - ✓ server.js reduced from 14,409 lines to 2,670 lines
   - ✓ Only 5 endpoints remain: health check, 3 dev-only tests, webhook processor
2. **Input validation** - 19 validator files created
   - ✓ All routes have express-validator middleware
3. **Utilities created**
   - ✓ `utils/image-utils.js` - Shared image URL resolution
   - ✓ `utils/cycle-count-utils.js` - Cycle count helpers

**Completed Since Last Review:**
1. **Loyalty service layer** - All 8 phases of modular refactoring complete
   - `services/loyalty/` directory with 8 service modules + tests
   - Enhanced logging, tracing, and testability

**Optional Future Work:**
1. **Webhook processor service layer** (improves testability, not required)
   - Create `services/webhookProcessor.js` for event routing
   - Consolidate logic into existing services

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
| V012 | MEDIUM | No input validation | All routes | **FIXED** (19 validators) |
| V013 | HIGH | 221 endpoints in monolith | server.js | **FIXED** (5 remaining) |

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

### V012: No Input Validation (MEDIUM) - FIXED
**Location:** All routes
**Risk:** Invalid data could cause errors or unexpected behavior
**Fix Applied:** 19 validator files created in `middleware/validators/`:
- `index.js` - Common validators and utilities
- `driver-api.js` - Driver API validators
- `purchase-orders.js` - Purchase order validators
- `subscriptions.js` - Subscription validators
- `loyalty.js` - Loyalty program validators
- `gmc.js` - Google Merchant Center validators
- `delivery.js` - Delivery route validators
- `webhooks.js` - Webhook management validators
- `expiry-discounts.js` - Expiry discount validators
- `vendor-catalog.js` - Vendor catalog validators
- `cycle-counts.js` - Cycle count validators
- `sync.js` - Sync route validators
- `catalog.js` - Catalog route validators
- `square-attributes.js` - Square attributes validators
- `google-oauth.js` - Google OAuth validators
- `merchants.js` - Merchant context validators
- `settings.js` - Settings validators
- `logs.js` - Log viewing validators
- `analytics.js` - Analytics validators

### V013: Monolithic Server File (HIGH) - FIXED
**Location:** `server.js` (now 2,670 lines, 5 endpoints remaining)
**Risk:** Was unmaintainable code, high merge conflict risk
**Fix Applied:** 20 route files extracted (12,858 lines, 233 endpoints):
- `routes/auth.js` (12 endpoints)
- `routes/square-oauth.js` (4 endpoints)
- `routes/google-oauth.js` (4 endpoints)
- `routes/driver-api.js` (8 endpoints)
- `routes/purchase-orders.js` (9 endpoints)
- `routes/subscriptions.js` (11 endpoints)
- `routes/loyalty.js` (40 endpoints)
- `routes/gmc.js` (32 endpoints)
- `routes/delivery.js` (23 endpoints)
- `routes/webhooks.js` (8 mgmt endpoints)
- `routes/expiry-discounts.js` (13 endpoints)
- `routes/vendor-catalog.js` (13 endpoints)
- `routes/cycle-counts.js` (9 endpoints)
- `routes/sync.js` (6 endpoints)
- `routes/catalog.js` (16 endpoints)
- `routes/square-attributes.js` (9 endpoints)
- `routes/merchants.js` (4 endpoints)
- `routes/settings.js` (3 endpoints)
- `routes/logs.js` (4 endpoints)
- `routes/analytics.js` (5 endpoints)

**Remaining:** Only health check, 3 dev-only test endpoints, and webhook processor (optional service layer refactoring)

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
middleware/validators/      # express-validator middleware (19 files)
  ├── index.js             # Common validators and utilities
  ├── driver-api.js        # Driver API validators
  ├── purchase-orders.js   # Purchase order validators
  ├── subscriptions.js     # Subscription validators
  ├── loyalty.js           # Loyalty program validators
  ├── gmc.js               # Google Merchant Center validators
  ├── delivery.js          # Delivery route validators
  ├── webhooks.js          # Webhook management validators
  ├── expiry-discounts.js  # Expiry discount validators
  ├── vendor-catalog.js    # Vendor catalog validators
  ├── cycle-counts.js      # Cycle count validators
  ├── sync.js              # Sync route validators
  ├── catalog.js           # Catalog route validators
  ├── square-attributes.js # Square attributes validators
  ├── google-oauth.js      # Google OAuth validators
  ├── merchants.js         # Merchant context validators
  ├── settings.js          # Settings validators
  ├── logs.js              # Log viewing validators
  └── analytics.js         # Analytics validators
utils/password.js           # Password hashing (49 tests)
utils/token-encryption.js   # Token encryption (51 tests)
utils/file-validation.js    # File upload validation (30 tests)
utils/image-utils.js        # Shared image URL resolution
utils/cycle-count-utils.js  # Cycle count batch generation and reporting
```

### Key Statistics
- **Total Lines:** 2,670 in server.js (12,858 lines extracted to routes)
- **Endpoints in server.js:** 5 remaining (health, 3 dev-only tests, webhook processor)
- **Extracted Routes:** 20 files with 233 endpoints
  - auth.js (12), square-oauth.js (4), google-oauth.js (4), driver-api.js (8)
  - purchase-orders.js (9), subscriptions.js (11), loyalty.js (40), gmc.js (32)
  - delivery.js (23), webhooks.js (8), expiry-discounts.js (13), vendor-catalog.js (13)
  - cycle-counts.js (9), sync.js (6), catalog.js (16), square-attributes.js (9)
  - merchants.js (4), settings.js (3), logs.js (4), analytics.js (5)
- **Tests:** 194 passing
- **npm Vulnerabilities:** 0
- **Validators Created:** 19 files in middleware/validators/
- **Phase 3 Status:** COMPLETE

---

*Document generated by security review on 2026-01-21*
*Last updated: 2026-01-22 - Phase 3 COMPLETE: 233 endpoints extracted (20 route files) with 19 express-validator files. Loyalty service modular refactoring complete.*
