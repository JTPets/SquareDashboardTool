# Section 8: LOGGING & OBSERVABILITY

**Rating: NEEDS WORK**

**Auditor note**: The logging infrastructure is well-structured (Winston with JSON format, daily rotation, separate error transport). However, PII leaks into log files through several paths, and request-level correlation is absent for cross-cutting traceability.

---

## 8.1 PII in Logs

**Rating: FAIL**

Multiple categories of personally identifiable information are written to log files.

### 8.1.1 Email Addresses Logged in Plaintext

User and subscriber email addresses appear in structured log fields across multiple files:

| File | Line | Log Call |
|------|------|----------|
| `routes/auth.js` | 158 | `logger.info('User logged in', { userId, email })` |
| `routes/auth.js` | 191 | `logger.info('User logged out', { userId, email })` |
| `routes/auth.js` | 604 | `logger.info('Password reset requested for non-existent email', { email, ipAddress })` |
| `routes/auth.js` | 635-639 | `logger.info('Password reset token generated', { userId, email, expiresAt })` |
| `routes/subscriptions.js` | 208 | `logger.error('Square customer creation failed', { error, email })` |
| `utils/subscription-handler.js` | 72 | `logger.info('Subscriber created', { email, plan, trialEndDate })` |
| `server.js` | 251 | Request logger includes `user: req.session?.user?.email` on every HTTP request |

**Severity: MEDIUM** -- Email addresses are logged pervasively. The request logging middleware at `server.js:251` is the worst offender since it attaches the user's email to every single HTTP request log entry. This creates a dense PII trail in log files retained for 14 days.

**Recommendation**: Replace `email` with a one-way hash or user ID in log entries. For the request logger, use `userId` instead of email. If email is needed for debugging, log only a masked form (e.g., `j***@example.com`).

### 8.1.2 Customer Names Logged

| File | Line | Detail |
|------|------|--------|
| `services/delivery/delivery-service.js` | 1462-1467 | `logger.info('Resolved customer name via Square API lookup', { customerName })` |
| `services/delivery/delivery-stats.js` | 184 | `logger.debug('Customer stats: Found customer by phone', { customerName: customer.givenName })` |

**Severity: LOW-MEDIUM** -- Customer names are logged during delivery and stats operations. The delivery stats entry also leaks a partial name (givenName).

### 8.1.3 Phone Numbers Logged

| File | Line | Detail |
|------|------|--------|
| `services/delivery/delivery-stats.js` | 164-168 | `logger.debug('Customer stats: No customer ID, searching by phone', { phone: order.phone })` |

**Severity: MEDIUM** -- Full phone number logged in debug output. While debug level may not be active in production, the code path exists and could be activated by changing `LOG_LEVEL`.

### 8.1.4 Physical Addresses Logged

| File | Line | Detail |
|------|------|--------|
| `services/delivery/delivery-service.js` | 916, 934, 1546, 1548, 1552 | Full delivery `address` string logged during geocoding operations |

**Severity: MEDIUM** -- Full street addresses are logged during geocoding. This includes successful geocoding, failures, and errors -- so addresses appear in both app and error log files.

### 8.1.5 IP Addresses Logged

| File | Line | Detail |
|------|------|--------|
| `routes/auth.js` | 604 | `{ email, ipAddress }` logged for password reset attempts |

**Severity: LOW** -- IP address logging for authentication events is standard practice for security audit trails. This is acceptable but should be noted for GDPR/privacy compliance.

---

## 8.2 Tokens and Keys in Logs

**Rating: PASS**

Tokens and API keys are handled carefully in log output.

### Findings

1. **Square OAuth tokens**: The OAuth flow at `routes/square-oauth.js:196-200` logs `merchantId`, `expiresAt`, and `tokenType` but correctly excludes the `accessToken` and `refreshToken` values from the log entry. The destructured variables are available in scope but not passed to the logger.

2. **Token refresh**: `utils/square-token.js:73` logs `merchantId` and `expiresAt` only -- no token values.

3. **Legacy token migration**: `services/square/square-client.js:59-70` logs detection and encryption of legacy tokens but only includes `merchantId`, never the token value.

4. **API keys**: `routes/ai-autofill.js:60` logs "Claude API key stored" with only `merchantId`. The delivery service logs "API key not configured" warnings without values.

5. **Password reset tokens**: `routes/auth.js:635` logs token generation metadata (userId, email, expiresAt) but not the token itself.

6. **No token/key pattern matches**: A search for `logger.*(accessToken|refreshToken|access_token|refresh_token)` returned zero results across the entire codebase.

**Assessment**: Token handling in logs is disciplined. No plaintext secrets, API keys, or authentication tokens appear in log output.

---

## 8.3 Structured vs String Concatenation

**Rating: PASS**

### Logger Configuration (`utils/logger.js`)

The application uses Winston with JSON format for all file transports:

```
winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
)
```

- **File transports**: Both `app-*.log` and `error-*.log` use `winston.format.json()` producing machine-parseable structured JSON.
- **Console transport**: Uses `winston.format.simple()` with colorize for developer readability -- appropriate for development.
- **Log rotation**: `winston-daily-rotate-file` with 20MB max file size, 14-day retention for app logs, 30-day for error logs. Compressed archives enabled.
- **Default metadata**: All entries include `{ service: 'square-dashboard-addon' }`.

### Logging Patterns

The vast majority of log calls use the structured pattern:
```javascript
logger.info('Message', { key1: value1, key2: value2 });
```

One minor inconsistency: a few `logger.error()` calls in `utils/schema-manager.js` use string concatenation for the message (e.g., `logger.error('Failed to add email to auth_audit_log:', error.message)`), but these are schema migration operations, not runtime paths.

### Loyalty Logger (`utils/loyalty-logger.js`)

A specialized structured logger wraps the base logger with category prefixes (`[LOYALTY:PURCHASE]`, `[LOYALTY:REWARD]`, etc.) and adds `category` and `timestamp` fields to every entry. This is well-designed for log filtering and aggregation.

---

## 8.4 Log Level Usage

**Rating: PASS**

### Distribution

| Level | Approximate Count | Usage Pattern |
|-------|-------------------|---------------|
| `error` | ~363 calls across 108 files | Actual errors: API failures, database errors, unrecoverable conditions |
| `warn` | ~249 calls across 81 files | Degraded conditions: missing config, fallback behavior, client errors |
| `info` | Majority of log calls | Normal operations: sync completed, records created, auth events |
| `debug` | Used in loyalty, delivery, cart services | Verbose tracing: customer lookups, cache hits, idempotency checks |

### Correct Level Assignment

The global error handler in `server.js:665-669` correctly differentiates:
- `logger.error()` for 5xx server errors (with stack traces)
- `logger.warn()` for 4xx client errors (without stack traces)

### No Significant Misuse Found

A search for `logger.info` calls containing "error" or "fail" keywords returned only legitimate uses:
- `logger.info('Delivery order sync completed', { errors: errors.length })` -- reporting a count, not an error
- `logger.info('Auto-healed location mismatch from error detail')` -- informational recovery message
- `logger.info('POD cleanup complete', { deleted, errors })` -- summary with error count

No cases of `logger.error()` used for non-error conditions were found.

---

## 8.5 Request Correlation / Tracing

**Rating: FAIL**

### Current State

1. **Error response only**: A `requestId` is generated in `server.js:677` but only included in the error response body sent to the client in production mode. It is NOT attached to log entries.

2. **No correlation middleware**: There is no middleware that generates a request ID at the start of a request and attaches it to all subsequent log entries via `winston`'s `defaultMeta` or async local storage.

3. **Request logger lacks ID**: The request logging middleware at `server.js:243-258` logs method, path, status, duration, and user email but no request ID.

4. **Loyalty trace_id (database only)**: The loyalty system uses `trace_id` columns in `loyalty_purchase_events`, `loyalty_rewards`, and `loyalty_audit_logs` tables for correlating related database records. However, this is a database-level correlation, not a log-level one. The `trace_id` values do not appear in log entries.

5. **No cross-service tracing**: There is no mechanism to trace a webhook event through the webhook processor, handler, and downstream services in logs.

### Impact

- When debugging a production issue, there is no way to filter log entries for a single HTTP request.
- Webhook processing (which can trigger chains of operations across multiple services) cannot be traced end-to-end in logs.
- The `TODO(pre-franchise)` comment in `utils/logger.js:12` acknowledges the need for `merchantId` scoping but no implementation exists.

**Recommendation**: Add request correlation middleware using Node.js `AsyncLocalStorage`:
1. Generate a UUID at request entry.
2. Store it in `AsyncLocalStorage`.
3. Add a Winston format that reads from `AsyncLocalStorage` and injects `requestId` into every log entry.
4. For webhook processing, propagate a `webhookEventId` through the handler chain.

---

## 8.6 Additional Observations

### 8.6.1 Console.log Usage

The `server.js` file contains two `console.error`/`console.warn` calls (lines 29, 32) used as fatal/startup warnings before the logger is initialized. This is acceptable. All runtime logging uses the structured Winston logger.

Frontend JavaScript files (`public/js/*.js`) use `console.log` extensively (309 occurrences across 44 files), which is expected for browser-side code and does not affect server-side log integrity.

### 8.6.2 Log Retention Periods

- App logs: 14 days (compressed)
- Error logs: 30 days (compressed)
- Max file size: 20MB (app), 10MB (error)

These are reasonable for a single-Pi deployment. For GDPR compliance, the PII in logs (Section 8.1) means these retention periods also define PII retention -- which should be documented in a privacy policy.

### 8.6.3 No Log Sanitization Layer

There is no centralized sanitization function that strips or masks PII before logging. Each call site is responsible for choosing what fields to include. This makes PII leaks easy to introduce and hard to audit.

---

## Summary of Findings

| Sub-section | Rating | Key Issue |
|-------------|--------|-----------|
| 8.1 PII in Logs | FAIL | Emails on every request log, customer names, phones, addresses in delivery logs |
| 8.2 Tokens/Keys | PASS | No tokens or API keys in log output |
| 8.3 Structured Logging | PASS | Winston JSON format, well-structured |
| 8.4 Log Levels | PASS | Correct and consistent usage |
| 8.5 Request Correlation | FAIL | No request ID in log entries; no cross-operation tracing |

## Recommended Remediations

| Priority | Item | Effort |
|----------|------|--------|
| HIGH | Remove email from request logger (`server.js:251`) -- replace with `userId` | 5 min |
| HIGH | Add request correlation middleware with `AsyncLocalStorage` | 2-4 hours |
| MEDIUM | Create a log sanitization utility that masks PII fields (email, phone, address, name) | 2-3 hours |
| MEDIUM | Replace `customerName` logging with customer ID only | 30 min |
| MEDIUM | Replace `address` logging with address hash or city-only | 30 min |
| MEDIUM | Replace `phone` in debug logs with masked form | 15 min |
| LOW | Propagate webhook event IDs through handler chains for log correlation | 4-6 hours |
| LOW | Add `merchantId` to Winston `defaultMeta` via `AsyncLocalStorage` (addresses the `TODO(pre-franchise)` in logger.js) | 1-2 hours |
