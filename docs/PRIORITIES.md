# Active Priorities

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Roadmap](./ROADMAP.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-03-06
**Consolidated from**: AUDIT-2026-02-28, CODEBASE_AUDIT_2026-02-25, MULTI-TENANT-AUDIT, CLAUDE.md backlog

---

## HIGH Priority

### Security

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| ~~SEC-5~~ | ~~JSON.stringify script injection in `public/js/vendor-catalog.js:1123`~~ — **RESOLVED 2026-03-04**: Added `.replace(/<\//g, '<\\/')` after JSON.stringify to prevent `</script>` breakout | AUDIT-2026-02-28 | S |
| ~~SEC-6~~ | ~~Google OAuth tokens stored in plaintext in `utils/google-auth.js`~~ — **RESOLVED 2026-03-04**: Tokens encrypted with AES-256-GCM via `token-encryption.js` before storage; decrypted on retrieval; backward-compatible with legacy plaintext tokens | CODEBASE_AUDIT_2026-02-25 | M |
| ~~SEC-7~~ | ~~Password reset tokens stored as plaintext hex in database~~ — **RESOLVED 2026-03-04**: Tokens hashed with SHA-256 before storage in both `routes/auth.js` and `routes/subscriptions.js`; verification hashes incoming token before DB lookup | CODEBASE_AUDIT_2026-02-25 | M |
| ~~S-1~~ | ~~SQL injection via template literal interpolation in INTERVAL clauses (6 locations in `cart-activity-service.js`, `square-oauth.js`, `google-auth.js`)~~ — **RESOLVED 2026-03-04**: All 6 locations use parameterized `INTERVAL '1 day' * $N` / `INTERVAL '1 minute' * $N` pattern. Test file `oauth-csrf.test.js` also updated. | CODEBASE_AUDIT_2026-02-25 | S |
| ~~S-2~~ | ~~`/output` directory served without auth (`server.js:221`)~~ — **RESOLVED 2026-03-04**: Added `requireAuth` to `/output/logs` and `/output/backups`; `/output/feeds` remains public for Google Merchant Center | CODEBASE_AUDIT_2026-02-25 | S |
| SEC-14 | 12 delivery/driver API endpoints lack per-endpoint rate limiting beyond global 100/15min cap. Includes public 10MB file upload (`POST /api/driver/:token/orders/:orderId/pod`) — 100 requests = 1GB potential DoS. 4 unauthenticated driver-api.js endpoints + 7 authenticated delivery.js write endpoints need per-route rate limiting via `deliveryRateLimit`/`deliveryStrictRateLimit`. | DEAD-CODE-REPORT-2026-03-05 | M |

### Reliability

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| ~~ERR-1/2~~ | ~~Add `asyncHandler` to `square-oauth.js` `/connect` and `/callback` routes~~ — **RESOLVED 2026-03-04**: Both routes wrapped with `asyncHandler` | AUDIT-2026-02-28 | S |
| ~~E-1~~ | ~~Fire-and-forget email in DB error handler (`server.js:1001`) — add `.catch()` for silent email failures during DB outage~~ — **RESOLVED 2026-03-06**: Added `.catch(err => logger.error(...))` to prevent unhandled rejection | CODEBASE_AUDIT_2026-02-25 | S |

### Business

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-50 | Post-trial conversion — $1 first month. Capture payment method, prove intent. Decide Stripe vs Square for SaaS billing | CLAUDE.md | L |
| BACKLOG-39 | Vendor bill-back tracking — track promotional discounts funded by vendors. Need `vendor_billbacks` table, reporting view for claim submission | CLAUDE.md | L |

---

## MEDIUM Priority

### Features

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-38 | Timed discount automation — apply/remove Square discount objects on cron schedule, bypassing Square's broken native timed discounts. Reuse expiry discount cron pattern | CLAUDE.md | L |
| BACKLOG-41 | User access control with roles — manager, clerk, accountant permissions. Per-user action logging. Required for multi-user SaaS | CLAUDE.md | L |
| BACKLOG-42 | Barcode scan-to-count for cycle counts — accept barcode scanner input during cycle count workflow | CLAUDE.md | M |
| BACKLOG-44 | Purchase order generation with branding — generate printable/emailable POs with merchant logo | CLAUDE.md | M |
| BACKLOG-45 | Spreadsheet bulk upload — import/update inventory via CSV or Google Sheets | CLAUDE.md | M |
| BACKLOG-4 | Customer birthday sync for marketing | CLAUDE.md | S |
| BACKLOG-1 | Frontend polling rate limits | CLAUDE.md | S |
| BACKLOG-51 | Demo account — read-only view of a merchant's SqTools dashboard for sales demos and franchise prospect walkthroughs. Single shared login per merchant, view-only (no mutations), can be enabled/disabled by merchant owner, should not expose sensitive vendor pricing or customer PII. Relates to BACKLOG-41 (user access control) — may be implemented as a role type when that work is done | CLAUDE.md | M |

### Data Integrity

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| ~~BACKLOG-36~~ | ~~Phantom velocity rows never self-correct — `syncSalesVelocity` only upserts variations in orders; stale rows persist forever~~ — **RESOLVED 2026-03-06**: Added DELETE WHERE variation_id NOT IN (processed keys) after upsert in both `syncSalesVelocity` and `syncSalesVelocityAllPeriods`. 3 tests. | CLAUDE.md | S |
| ~~BACKLOG-35~~ | ~~Sales velocity does not subtract refunds — net sales slightly inflated on refunded items (~2 refunds/day)~~ — **RESOLVED 2026-03-06**: Both sync functions now subtract `order.returns[].return_line_items` quantities and revenue. Net values floored at 0. 4 tests. | CLAUDE.md | S |
| DB-1 | 14 core tables have nullable `merchant_id` — add NOT NULL constraint via migration | AUDIT-2026-02-28 | M |

### Testing

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| TEST-28 | Replace `subscriptions.test.js` — 849 lines testing JS operators, not application code. Rewrite with real route/service tests | AUDIT-2026-02-28 | M |
| T-1 | Financial/loyalty services have zero test coverage (square-discount-service, purchase-service, reward-service) | CODEBASE_AUDIT_2026-02-25 | L |
| ~~T-2~~ | ~~Webhook handlers untested (7 of 8) — order-handler.js (1,316 lines) is highest risk~~ — **RESOLVED 2026-03-06**: 88 tests, split into 6-file module (`order-handler/index.js` + 5 sub-modules). See TECHNICAL_DEBT.md T-2 | CODEBASE_AUDIT_2026-02-25 | L |
| T-3 | 84% of routes untested (21 of 25) — prioritize analytics.js, catalog.js, loyalty.js | CODEBASE_AUDIT_2026-02-25 | L |
| T-4 | Background jobs 91% untested (10 of 11) | CODEBASE_AUDIT_2026-02-25 | L |

### Security (Medium)

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| ~~S-3~~ | ~~OAuth callback missing session auth verification (`square-oauth.js:110`)~~ — **RESOLVED 2026-03-04**: Callback verifies `req.session.user.id === stateRecord.user_id` before processing; mismatched/missing session redirects to login | CODEBASE_AUDIT_2026-02-25 | S |
| ~~S-4~~ | ~~CSP allows `'unsafe-inline'` for scripts~~ — **RESOLVED 2026-03-04**: `'unsafe-inline'` removed from `scriptSrc` in `middleware/security.js`. All HTML files use external scripts only. Note: popup report in `vendor-catalog.js:1122` has inline script blocked by CSP — logged in TECHNICAL_DEBT.md | CODEBASE_AUDIT_2026-02-25 | S |
| ~~S-6~~ | ~~Admin user listing `/api/auth/users` not scoped by merchant~~ — **RESOLVED 2026-03-04**: All admin user endpoints (list, create, update, reset-password, unlock) now scoped by `activeMerchantId` via `user_merchants` JOIN. Create user also links to merchant in transaction. | CODEBASE_AUDIT_2026-02-25 | S |
| ~~S-10~~ | ~~XSS in vendor catalog import validation errors (`vendor-catalog.js:387`) — innerHTML without escaping~~ — **RESOLVED 2026-03-04**: All dynamic values in `showImportError()` escaped via `escapeHtml()`, including `err.row` | CODEBASE_AUDIT_2026-02-25 | S |

---

## LOW Priority

### Features

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-8 | Vendor management — pull vendor data from Square Vendors API | CLAUDE.md | M |
| BACKLOG-29 | Existing tenants missing `invoice.payment_made` webhook — re-register webhooks for active merchants | CLAUDE.md | S |
| BACKLOG-12 | Driver share link validation failure | CLAUDE.md | S |
| BACKLOG-43 | Min/Max stock per item per location — investigate Square inventory alert thresholds first | CLAUDE.md | S |

### Code Quality

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-3 | Response format standardization | CLAUDE.md | M |
| BACKLOG-17 | Customer lookup helpers duplicated between loyalty layers (DEDUP L-4) | CLAUDE.md | M |
| BACKLOG-23 | Currency formatting — no shared helper, 14+ files (DEDUP G-3) | CLAUDE.md | S |
| BACKLOG-25 | Location lookup queries repeated across 6 routes (DEDUP G-5) | CLAUDE.md | S |
| BACKLOG-26 | Date string formatting pattern repeated 12 times (DEDUP G-7) | CLAUDE.md | S |
| BACKLOG-27 | Inconsistent toLocaleString() — 60 uses, mixed locales (DEDUP G-8) | CLAUDE.md | S |
| BACKLOG-34 | Doc: Square reuses variation IDs on POS reorder delete/recreate — velocity data may be inherited | CLAUDE.md | S |
| BACKLOG-40 | exceljs pulls deprecated transitive deps — evaluate lighter xlsx/csv library before open-source | CLAUDE.md | S |

### Security/Infra (Low)

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| SEC-12/13 | XSS in `logs.js` and `delivery-settings.js` — innerHTML without escaping | AUDIT-2026-02-28 | S |
| BACKLOG-9 | In-memory global state — PM2 restart recovery (investigated, no immediate action) | CLAUDE.md | S |

---

## Effort Key

| Code | Meaning |
|------|---------|
| S | Small — < 1 file change or < 2 hours |
| M | Medium — 2-5 files or half a day |
| L | Large — 6+ files or multi-day effort |
