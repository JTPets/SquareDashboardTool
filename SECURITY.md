# SqTools Security Documentation

This document describes the security architecture, controls, and testing practices implemented in SqTools.

---

## Security Summary

| Area | Status | Implementation |
|------|--------|----------------|
| Authentication | ✅ Hardened | Session-based with bcrypt, rate limiting, lockout |
| Authorization | ✅ Complete | Role-based access (admin, user, readonly) |
| Multi-Tenant Isolation | ✅ Enforced | All queries filtered by merchant_id |
| API Security | ✅ Protected | Authentication required, input validation, rate limiting |
| Token Security | ✅ Encrypted | AES-256-GCM for OAuth tokens at rest |
| Webhook Security | ✅ Verified | HMAC-SHA256 signature validation |
| Dependency Security | ✅ Audited | 0 npm vulnerabilities |

---

## Authentication & Session Security

### Password Security
- **Hashing:** bcrypt v6.0.0 with 12 salt rounds
- **Validation:** Minimum length, complexity requirements enforced
- **Storage:** Only hashed passwords stored, never plaintext

### Session Management
- **Store:** PostgreSQL-backed sessions via connect-pg-simple
- **Cookies:** HttpOnly, Secure (HTTPS), SameSite=Lax
- **Expiry:** Configurable session timeout
- **Regeneration:** Session ID regenerated on login

### Brute Force Protection
- **Rate Limiting:** 5 login attempts per 15 minutes per IP
- **Account Lockout:** 30-minute lockout after 5 failed attempts
- **Audit Trail:** Failed login attempts logged with IP address

### Password Reset
- **Token Security:** Cryptographically random tokens
- **Expiry:** Short-lived reset tokens (1 hour)
- **Single Use:** Tokens invalidated after use

---

## Authorization & Access Control

### Role-Based Access Control (RBAC)
| Role | Capabilities |
|------|-------------|
| `admin` | Full access, user management, settings |
| `user` | Read/write access to operational features |
| `readonly` | View-only access to dashboards and reports |

### Middleware Enforcement
- `requireAuth` — Validates authenticated session
- `requireAdmin` — Restricts to admin role
- `requireRole(roles)` — Flexible role checking
- `requireWriteAccess` — Blocks readonly users from mutations

### Super Admin
- Configured via `SUPER_ADMIN_EMAILS` environment variable
- Cross-merchant access for platform administration
- All access logged for audit purposes

---

## Multi-Tenant Data Isolation

### Query-Level Isolation
- **Every database query** includes `merchant_id` filtering
- No API endpoint returns data from other tenants
- Foreign key relationships enforce ownership

### Resource Ownership Validation
- Locations validated against merchant ownership
- Vendors validated against merchant ownership
- Purchase orders validated against merchant ownership
- All child resources inherit parent merchant_id

### Subscription Gating
- Active subscription required for feature access
- `requireValidSubscription` middleware on protected routes
- Grace period handling for expired subscriptions

---

## API Security

### Authentication Requirements
- All endpoints require valid session (except public driver API)
- Session validation on every request via middleware
- Automatic session extension on activity

### Input Validation
- **express-validator** on all 238 endpoints
- **19 validator modules** covering all route files
- Type checking, length limits, format validation
- SQL injection prevention through parameterized queries

### Rate Limiting
| Endpoint Type | Limit | Window |
|---------------|-------|--------|
| Login | 5 requests | 15 minutes |
| General API | 100 requests | 1 minute |
| Sensitive Operations | 5 requests | 1 hour |

### Security Headers (Helmet.js)
- `Content-Security-Policy` — Script source restrictions
- `X-Frame-Options` — Clickjacking prevention
- `X-Content-Type-Options` — MIME sniffing prevention
- `Strict-Transport-Security` — HTTPS enforcement
- `X-XSS-Protection` — Browser XSS filtering

### CORS Protection
- Strict origin validation in production
- `ALLOWED_ORIGINS` environment variable required
- Requests from unauthorized origins rejected

---

## OAuth Token Security

### Square OAuth Tokens
- **Encryption:** AES-256-GCM with authentication tags
- **Key Management:** Encryption key in environment variable, never in code
- **Storage:** Only encrypted tokens stored in database
- **Refresh:** Automatic refresh within 1 hour of expiry

### Google OAuth Tokens
- Same AES-256-GCM encryption as Square tokens
- Scoped to minimum required permissions
- Revocable by user at any time

### Token Handling
- Tokens never logged (even at debug level)
- Tokens never exposed in error messages
- Tokens never transmitted to client-side code

---

## Webhook Security

### Signature Verification
- **Algorithm:** HMAC-SHA256
- **Validation:** Every incoming webhook verified against signature
- **Rejection:** Invalid signatures rejected with 401 status

### Event Processing
- **Deduplication:** Event IDs tracked to prevent replay
- **Idempotency:** Handlers designed for safe re-processing
- **Logging:** All events logged for audit trail

### Revocation Handling
- `oauth.authorization.revoked` webhook handled immediately
- Merchant tokens cleared from database
- User notified of disconnection

---

## File Upload Security

### Magic Number Validation
File uploads validated by actual file content, not just MIME type:

| Format | Magic Bytes |
|--------|-------------|
| JPEG | `FF D8 FF` |
| PNG | `89 50 4E 47` |
| GIF | `47 49 46 38` |
| WebP | `52 49 46 46` + `57 45 42 50` |
| BMP | `42 4D` |
| TIFF | `49 49` or `4D 4D` |

### Upload Restrictions
- Maximum file size enforced
- Allowed file types restricted by endpoint
- Files stored with generated names (not user-supplied)

---

## Security Testing

### Test Coverage

| Component | Tests | Coverage |
|-----------|-------|----------|
| Password utilities | 49 | ~96% |
| Token encryption | 51 | 100% |
| Auth middleware | 38 | ~85% |
| Multi-tenant isolation | 27 | ~30% |
| File validation | 30 | 100% |
| **Total** | **194** | Security-critical paths |

### Running Tests
```bash
npm test                    # Run all tests
npm run test:coverage       # Run with coverage report
npm run test:watch          # Watch mode for development
```

### Dependency Auditing
- **npm audit** run regularly
- **0 vulnerabilities** in current dependency tree
- Dependencies updated promptly for security fixes

---

## Error Handling

### Production Mode
- Stack traces hidden from clients
- Generic error messages returned to users
- Full details logged server-side only

### Error Response Format
```json
{
  "error": "User-friendly error message",
  "code": "ERROR_CODE"
}
```

### Audit Logging
- All authentication events logged
- Failed login attempts tracked with IP
- Admin actions logged with user ID
- Webhook events logged for debugging

---

## Environment Security

### Required Environment Variables
| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | Session encryption (64 hex chars) |
| `TOKEN_ENCRYPTION_KEY` | OAuth token encryption (64 hex chars) |
| `SQUARE_APPLICATION_SECRET` | Square OAuth (never in code) |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Webhook verification |

### Environment Separation
- Separate keys for development/staging/production
- `.env` file excluded from version control
- No secrets committed to repository

---

## Compliance

### Square App Marketplace
- OAuth 2.0 authorization code flow
- State parameter CSRF protection
- Token encryption requirements met
- Rate limiting with exponential backoff
- Webhook signature verification

### Data Protection
- No PCI data stored (payments via Square)
- Customer data isolated by merchant
- Audit trail for data access
- Data retention policies configurable

---

## Security Contact

For security concerns or vulnerability reports, contact: security@sqtools.ca

---

*Last Updated: January 2026*
