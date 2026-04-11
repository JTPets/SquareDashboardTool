# Dependencies & External Services Audit

**Audit Date:** 2026-04-10

---

## Summary

| Integration | Version | Status |
|------------|---------|--------|
| Square SDK | 43.2.1 | Primary POS — deeply embedded |
| Google APIs | 144.0.0 | GMC product feed sync |
| PostgreSQL (pg) | 8.17.1 | Primary database |
| Express | 4.18.2 | Web framework |
| Nodemailer | 8.0.5 | Email (SMTP/Resend/Mailgun) |
| Cloudflare R2 | Custom HTTP | Cloud backups |

---

## Current Integrations

### 1. Square SDK (v43.2.1) — Primary POS

**Package:** `square` in package.json
**API Version:** `2025-10-16` (set in `config/constants.js:90`)

#### Client Initialization
- **Location:** `middleware/merchant.js:242-295`
- **Pattern:** Singleton per-merchant with caching
- **Function:** `getSquareClientForMerchant(merchantId)`
- **Cache:** 5-minute TTL, max 100 clients, FIFO eviction
- **Environment:** `SQUARE_ENVIRONMENT` (sandbox or production)

#### SDK Imports
| File | Import |
|------|--------|
| `routes/square-oauth.js:15` | `const { SquareClient, SquareEnvironment } = require('square')` |
| `middleware/merchant.js:13` | Same |
| `utils/square-token.js:9` | Token refresh via SDK |

#### Low-Level HTTP Client
- **File:** `services/square/square-client.js`
- **Library:** `node-fetch` v2.7.0
- **Base URL:** `https://connect.squareup.com` (production)
- **Sandbox:** `https://connect.squareupsandbox.com`
- **Retry:** 3 attempts, exponential backoff (1s, 2s, 4s)
- **Timeout:** 30s per request
- **Rate Limiting:** Respects `Retry-After` header on 429

### 2. Google APIs (v144.0.0) — Merchant Center

**Package:** `googleapis`
**Purpose:** Product feed sync to Google Merchant Center
**Scope:** `https://www.googleapis.com/auth/content`

#### OAuth Flow
| Endpoint | Purpose |
|----------|---------|
| `GET /api/google/status` | Check auth status |
| `GET /api/google/auth` | Start OAuth flow |
| `GET /api/google/callback` | Handle callback |
| `POST /api/google/disconnect` | Revoke access |

#### Implementation
- **File:** `utils/google-auth.js`
- Per-merchant OAuth (each merchant connects their own Google account)
- State: 256-bit random, DB-backed, 10-min expiry, one-time use
- Private IP validation (rejects local network IPs)

### 3. Email Integration

**Package:** `nodemailer` v8.0.5
**File:** `utils/email-notifier.js`

| Provider | Method |
|----------|--------|
| SMTP (Gmail, Outlook, custom) | nodemailer transport |
| Resend | Custom HTTP API |
| Mailgun | Custom HTTP API |

**Features:**
- Throttling: Configurable minimum minutes between error emails
- Heartbeat: Optional daily "system alive" emails
- Alert types: `sendCritical`, `sendAlert`, `sendInfo`, `sendHeartbeat`, `sendBackup`

### 4. Cloudflare R2 — Cloud Backups

**File:** `utils/r2-backup.js`
**Protocol:** S3-compatible with AWS Signature V4
**Library:** Native HTTPS (no AWS SDK dependency)

| Config | Env Var |
|--------|---------|
| Enable | `BACKUP_R2_ENABLED` |
| Account | `BACKUP_R2_ACCOUNT_ID` |
| Credentials | `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` |
| Bucket | `BACKUP_R2_BUCKET_NAME` |
| Retention | 7 daily backups (auto-cleanup) |

---

## Auth & Credentials

### Square Token Storage
- **Table:** `merchants` (columns: `square_access_token`, `square_refresh_token`)
- **Encryption:** AES-256-GCM
- **File:** `utils/token-encryption.js`
- **Algorithm:** `aes-256-gcm`
- **IV Length:** 128 bits (16 bytes)
- **Auth Tag Length:** 128 bits (16 bytes)
- **Format:** `iv:authTag:ciphertext` (hex-encoded)
- **Key:** 32-byte hex (64 chars) from `TOKEN_ENCRYPTION_KEY` env var

### Token Refresh
- **File:** `utils/square-token.js`
- Per-merchant refresh mutex (prevents concurrent refresh races)
- Auto-refresh when token expires within 1 hour (`middleware/merchant.js:260-271`)
- Legacy unencrypted tokens auto-upgraded on first access

### OAuth Flow (Square)
**File:** `routes/square-oauth.js`

| Endpoint | Purpose | Security |
|----------|---------|----------|
| `GET /api/square/oauth/connect` | Initiate | Random state, 10-min expiry |
| `GET /api/square/oauth/callback` | Exchange code | State validation, session regeneration |
| `POST /api/square/oauth/revoke` | Disconnect | Best-effort revocation |
| `POST /api/square/oauth/refresh` | Manual refresh | Admin only |

**Required Scopes (17):**
- `MERCHANT_PROFILE_READ`
- `ITEMS_READ`, `ITEMS_WRITE`
- `INVENTORY_READ`, `INVENTORY_WRITE`
- `ORDERS_READ`, `ORDERS_WRITE`
- `VENDOR_READ`
- `LOYALTY_READ`
- `CUSTOMERS_READ`, `CUSTOMERS_WRITE`
- `INVOICES_READ`
- `DEVELOPER_APPLICATION_WEBHOOKS_READ`, `DEVELOPER_APPLICATION_WEBHOOKS_WRITE`

**Security Measures:**
- DB-backed CSRF state (10-min expiry, one-time use)
- User binding (validates session user matches initiator)
- Open redirect prevention (`isLocalPath()` validation)
- Session regeneration after callback (prevents session fixation)

---

## Webhook Security

### Signature Verification
- **File:** `services/webhook-handlers/webhook-processor.js:77-96`
- **Algorithm:** HMAC-SHA256
- **Header:** `x-square-hmacsha256-signature`
- **Key:** `SQUARE_WEBHOOK_SIGNATURE_KEY` env var
- **Computation:** `HMAC-SHA256(notificationUrl + rawBody)` → base64
- **Comparison:** Timing-safe (`crypto.timingSafeEqual`)

### Webhook Registration
- **Endpoint:** `POST /api/webhooks/register`
- **URL Validation:** HTTPS required
- **Domain Whitelist:** `ALLOWED_WEBHOOK_DOMAINS` or `PUBLIC_APP_URL`
- **SSRF Prevention:** Only registered domains allowed

### Idempotency
- **Duplicate Detection:** `square_event_id` in `webhook_events` table
- **In-Flight Dedup:** Per-process Map for rapid-fire same-ID events
- **Event Logging:** All events persisted with `event_data` JSONB

### Rate Limiting
- 100 webhooks/minute per merchant (`middleware/security.js:286`)

---

## Rate Limiting Strategy (9 Limiters)

| Limiter | Window | Max | Key | File:Line |
|---------|--------|-----|-----|-----------|
| General | 15 min | 100 | IP | security.js:127 |
| Login | 15 min | 5 | email+IP | security.js:163 |
| Webhook | 1 min | 100 | merchant ID | security.js:283 |
| Delivery | 1 min | 30 | user/IP | security.js:194 |
| Delivery strict | 5 min | 10 | user/IP | security.js:224 |
| Sensitive ops | 1 hour | 5 | merchant ID | security.js:253 |
| Password reset | 15 min | 5 | token prefix | security.js:312 |
| Subscription | 1 hour | 5 | IP | security.js:435 |
| AI autofill | 15 min | 10 | merchant ID | security.js:462 |

---

## Environment Variables (from .env.example)

### Database
```
DATABASE_URL          # Connection string (preferred)
DB_USER, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT  # Individual params
```

### Square
```
SQUARE_APPLICATION_ID
SQUARE_APPLICATION_SECRET
SQUARE_ENVIRONMENT            # sandbox or production
SQUARE_WEBHOOK_SIGNATURE_KEY
TOKEN_ENCRYPTION_KEY          # 64-char hex for AES-256-GCM
```

### Google
```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

### Email
```
EMAIL_PROVIDER               # smtp, resend, mailgun
EMAIL_FROM, EMAIL_FROM_NAME
EMAIL_TO                     # Alert recipients
EMAIL_THROTTLE_MINUTES
EMAIL_HEARTBEAT_ENABLED
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
RESEND_API_KEY
MAILGUN_API_KEY, MAILGUN_DOMAIN
```

### Backup
```
BACKUP_R2_ENABLED
BACKUP_R2_ACCOUNT_ID
BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY
BACKUP_R2_BUCKET_NAME
```

### Feature Flags
```
WEBHOOK_CATALOG_SYNC         # Enable webhook-triggered catalog sync
WEBHOOK_INVENTORY_SYNC       # Enable webhook-triggered inventory sync
WEBHOOK_ORDER_SYNC           # Enable webhook-triggered order processing
```

### Sync Configuration
```
SYNC_CATALOG_INTERVAL_HOURS
SYNC_INVENTORY_INTERVAL_HOURS
SMART_SYNC_ENABLED
```

---

## NPM Dependencies (Key Packages)

### Runtime
| Package | Version | Purpose |
|---------|---------|---------|
| express | 4.18.2 | Web framework |
| express-session | 1.18.0 | Session management |
| connect-pg-simple | 9.0.1 | PostgreSQL session store |
| pg | 8.17.1 | PostgreSQL client |
| square | 43.2.1 | Square POS SDK |
| googleapis | 144.0.0 | Google APIs |
| node-fetch | 2.7.0 | HTTP client (for Square) |
| bcrypt | 6.0.0 | Password hashing |
| helmet | 7.1.0 | Security headers |
| express-rate-limit | 7.1.5 | Rate limiting |
| express-validator | 7.0.1 | Input validation |
| multer | 2.0.2 | File uploads |
| nodemailer | 8.0.5 | Email via SMTP |
| node-cron | 4.2.1 | Scheduled jobs |
| exceljs | 4.4.0 | Excel export |
| winston | 3.18.3 | Logging |
| winston-daily-rotate-file | 5.0.0 | Log rotation |

### Dev/Test
| Package | Version | Purpose |
|---------|---------|---------|
| jest | 29.7.0 | Test framework |
| supertest | 7.2.2 | HTTP testing |
| jest-junit | — | CI reporter |

---

## Database Configuration

- **Pool:** 20 max connections (`config/constants.js:81`)
- **Idle Timeout:** 30s
- **Connection Timeout:** 2s
- **Slow Query Threshold:** 1s (logged as warning)
- **Session Store:** `connect-pg-simple` (auto-creates `sessions` table)

---

## Security Architecture

| Layer | Implementation |
|-------|---------------|
| CSP | Hash-based script whitelisting |
| HSTS | Enabled in production |
| Cookies | httpOnly, secure (auto-detect), sameSite=lax |
| Headers | Helmet (full suite) |
| Permissions-Policy | Geolocation, camera, microphone disabled |
| CORS | Origin validation |
| Session | Regenerated after OAuth, fixed expiry |
| Passwords | bcrypt with salt rounds |
| Tokens | AES-256-GCM at rest |
| Webhooks | HMAC-SHA256 with timing-safe comparison |
