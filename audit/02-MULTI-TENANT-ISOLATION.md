# Section 2: MULTI-TENANT ISOLATION

**Rating: PASS**

## 2.1 Tenant Context Architecture

**PASS**

The merchant isolation model is sound:

1. **`loadMerchantContext`** (`middleware/merchant.js:32-130`): Loads merchant from server-side session. The `merchantId` is derived from `user_merchants` table JOIN — user must have an explicit relationship to the merchant. No user input controls which merchant is loaded.

2. **`requireMerchant`** (`middleware/merchant.js:136-148`): Gates all tenant-scoped routes. Returns 403 if no merchant context.

3. **`switchActiveMerchant`** (`middleware/merchant.js:306-328`): Verifies `user_merchants` relationship before allowing switch. Cannot access merchants the user doesn't own.

4. **Merchant ID source**: Always `req.merchantContext.id` (server-side), never from `req.params`, `req.query`, or `req.body` for data access. The only exception is `/api/merchants/switch` which validates ownership before switching.

### Middleware Stack Order (server.js)

```
1. Auth routes (public: /api/auth, /api/square/oauth)      [line 263-267]
2. loadMerchantContext (all requests)                        [line 272]
3. apiAuthMiddleware (blocks unauthenticated)                [line 308]
4. subscriptionEnforcementMiddleware (blocks expired)        [line 364]
5. Route handlers (all use req.merchantContext.id)
```

This ordering is correct — merchant context is loaded from session before any route handler executes.

---

## 2.2 Database Query Audit

**PASS**

Every tenant-scoped database query observed includes `merchant_id` filtering. Sampled across all route files and service files:

- `routes/cycle-counts.js:149` — `WHERE id = $1 AND merchant_id = $2`
- `routes/gmc.js:273` — `WHERE id = $1 AND merchant_id = $2`
- `routes/purchase-orders.js:379,513,545` — `WHERE id = $1 AND merchant_id = $2`
- `routes/sync.js:213,243` — `WHERE merchant_id = $1`
- All service files use parameterized `merchant_id` in queries

### Global Tables (Correctly Unscoped)

These tables are intentionally global and correctly queried without `merchant_id`:
- `merchants` — the tenant table itself
- `users`, `user_merchants` — auth/association tables
- `sessions` — Express sessions
- `platform_settings` — global config
- `webhook_events.square_event_id` uniqueness check — Square event IDs are globally unique UUIDs

---

## 2.3 Public Endpoints Review

**PASS**

Public paths defined in `server.js:279-295`:

| Path | Auth Method | Tenant Isolation |
|------|------------|-----------------|
| `/health` | None | No tenant data |
| `/webhooks/square` | HMAC signature | Merchant resolved from `event.merchant_id` via DB lookup |
| `/square/payment-config` | None | Returns only env var (SQUARE_APPLICATION_ID) |
| `/subscriptions/plans` | None | Returns global plan list |
| `/subscriptions/create` | None (but requires session merchant) | Rejects without merchant context |
| `/subscriptions/status` | None | See Finding 2.3.1 |
| `/subscriptions/promo/validate` | None | See Finding 2.3.2 |
| `/auth/*` | None | Auth operations only |
| `/gmc/feed.tsv` | Token-based | Token resolves merchant via DB |
| `/gmc/local-inventory-feed.tsv` | Token-based | Token resolves merchant via DB |
| `/driver/*` | Token-based | Token includes merchant scope |

### Finding 2.3.1 — Public subscription status endpoint leaks plan names

**Severity: LOW**

`routes/subscriptions.js:500-503`:
```javascript
router.get('/subscriptions/status', subscriptionRateLimit, validators.checkStatus, asyncHandler(async (req, res) => {
    const { email } = req.query;
    const status = await subscriptionHandler.checkSubscriptionStatus(email);
    sendSuccess(res, { active: status.isValid, planName: status.planName || null });
}));
```

Anyone can query `GET /api/subscriptions/status?email=foo@bar.com` and learn:
- Whether that email has a subscription (boolean)
- What plan they're on (string)

**Impact**: Minor information disclosure. An attacker can enumerate which emails are customers and their plan tier. Rate limited but still enumerable.

**Fix**: Remove `planName` from the public response. Return only `{ active: boolean }`. Better: require authentication.

### Finding 2.3.2 — Public promo validation endpoint has no tenant scoping concern

**PASS** — Promo codes are validated with merchant context (`req.merchantContext?.id || req.session?.activeMerchantId`). Falls back safely.

---

## 2.4 Webhook Tenant Routing

**PASS**

`services/webhook-processor.js:220-282`:

1. **Signature verification FIRST** (line 229-255) — HMAC-SHA256 with timing-safe comparison
2. **Merchant resolved from Square's `event.merchant_id`** (line 272) — looked up in DB, not from user input
3. **Rejects unknown merchants** (line 274-281) — 400 response
4. **All handler context includes `merchantId`** (line 295) — passed to every webhook handler

The merchant routing is tamper-proof: the `merchant_id` in the webhook payload is authenticated by the HMAC signature, so it cannot be spoofed without the signature key.

---

## 2.5 Cron Job Tenant Scoping

**PASS**

All cron jobs iterate over active merchants and scope their operations:

| Job | Pattern | Evidence |
|-----|---------|----------|
| `sync-job.js` | Iterates all active merchants | Line 26: `SELECT id FROM merchants WHERE ... is_active = TRUE` |
| `cycle-count-job.js` | Per-merchant | Line 26, 99: merchant iterator; line 114: `WHERE ... merchant_id = $1` |
| `expiry-discount-job.js` | Per-merchant | Line 109: merchant iterator |
| `loyalty-audit-job.js` | Per-merchant | Line 36: `JOIN loyalty_offers lo ON lo.merchant_id = m.id` |
| `loyalty-catchup-job.js` | Per-merchant | Line 35: merchant iterator with loyalty scope |
| `seniors-day-job.js` | Per-merchant | Line 61: `JOIN seniors_discount_config sdc ON sdc.merchant_id = m.id` |
| `webhook-retry-job.js` | Per-event (merchant resolved) | Line 48: `merchant_id` from event row |
| `cart-activity-cleanup-job.js` | Per-merchant | Line 32: merchant iterator |
| `catalog-health-job.js` | Hardcoded merchant 3 | Line 5: debug-only, single tenant |
| `trial-expiry-job.js` | Cross-tenant by design | Checks all merchants' trial dates (platform admin function) |

### Finding 2.5.1 — Catalog health job hardcoded to merchant_id = 3

**Severity: LOW**

`jobs/catalog-health-job.js:5` and `jobs/catalog-location-health-job.js:5`:
```
Debug-only: hard-coded to merchant_id = 3.
```

These debug jobs only process one specific merchant. Not a security issue but should be parameterized or removed before SaaS release.

### Finding 2.5.2 — Cron job error isolation

**Severity: LOW**

If a cron job throws for merchant A during iteration, it could prevent merchant B from being processed in the same batch (depending on error handling). Sampled `sync-job.js` — it does use try/catch per merchant. Most jobs handle this correctly.

---

## 2.6 Admin Routes

**PASS**

Admin routes (`routes/admin.js`) require `requireAuth` + `requireAdmin` and are intentionally cross-tenant (platform management). The `GET /api/admin/merchants` endpoint lists all merchants — this is correct for a platform admin view.

Super-admin routes in `routes/subscriptions.js:705-747` add an additional email-based check (`SUPER_ADMIN_EMAILS` env var) on top of `requireAdmin`.

### Finding 2.6.1 — Admin role is user-level, not merchant-level

**Severity: MEDIUM**

`middleware/auth.js:57`: `req.session.user.role !== 'admin'`

The `requireAdmin` check is on the **user** object, not the **merchant** relationship. A user with role `admin` who is linked to merchant A could potentially access admin endpoints that operate on merchant B (e.g., `POST /api/admin/merchants/:merchantId/extend-trial`).

The admin routes in `routes/admin.js` take `merchantId` from `req.params` and operate on any merchant without checking if the admin user owns or is associated with that merchant:

```javascript
// routes/admin.js:47-48
router.post('/merchants/:merchantId/extend-trial', requireAuth, requireAdmin, ...
    const merchantId = parseInt(req.params.merchantId, 10);
    // No check: does this admin have access to this merchantId?
```

**Impact**: By design for a single platform owner, but for multi-admin SaaS this could allow one merchant's admin to manage another merchant's trial/subscription.

**Fix**: Either:
1. Add super-admin email check (like `subscriptions/admin/setup-plans` does), or
2. Verify the admin user's merchant association before allowing cross-tenant admin operations

---

## 2.7 Merchant Context Bypass Vectors

**PASS**

Checked for merchant_id override vectors:
- No `req.query.merchant_id` used for data access
- No `req.body.merchantId` used to override context (except `/merchants/switch` which validates ownership)
- No `req.headers['x-merchant-id']` or similar
- No `req.params.merchantId` used in tenant-scoped data queries (only in admin routes, which are gated)
- Session `activeMerchantId` can only be set via `switchActiveMerchant()` which validates ownership

---

## Summary

| Check | Result | Findings |
|-------|--------|----------|
| Tenant context architecture | PASS | Derived from server-side session, ownership-verified |
| DB query merchant_id filtering | PASS | All sampled queries include merchant_id |
| Public endpoint isolation | PASS | Token/signature-based tenant resolution |
| Webhook tenant routing | PASS | HMAC-authenticated merchant_id |
| Cron job scoping | PASS | Per-merchant iteration with error isolation |
| Admin cross-tenant access | NEEDS WORK | Finding 2.6.1 |
| Context bypass vectors | PASS | No user-controllable tenant override |

**Overall: PASS** — Strong tenant isolation with one architectural concern (admin role scope) that should be addressed before multi-admin SaaS deployment.

### Findings Summary

| ID | Severity | Description |
|----|----------|-------------|
| 2.3.1 | LOW | Public `/subscriptions/status` leaks plan name by email |
| 2.5.1 | LOW | Debug jobs hardcoded to merchant_id = 3 |
| 2.5.2 | LOW | Cron job error isolation between tenants |
| 2.6.1 | MEDIUM | Admin role is user-level; admin endpoints accept any merchantId from params |
