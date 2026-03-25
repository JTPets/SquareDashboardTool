# Technical Debt — Known Issues

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Priorities](./PRIORITIES.md) | [Architecture](./ARCHITECTURE.md) | [Roadmap](./ROADMAP.md)

**Last Updated**: 2026-03-23

Known issues that are logged but not yet scheduled. These are not blocking any feature work — they represent latent risks, code smells, or minor correctness issues to address when touching nearby code.

---

## Summary

| Category | Open Items |
|----------|-----------|
| Code Quality Observations | 2 |
| Square Online Store | 4 |
| Logging | 1 |
| Config | 1 |
| Architecture | 0 |
| Multi-Tenant Gaps | 5 |
| Audit Findings (2026-03-22) | 4 |
| **Total** | **~17** |

---

## Code Quality Observations

### Square API does not expose default/primary vendor flag

**Scope**: Square Catalog API `CatalogItemVariation.item_variation_vendor_infos` is an array of vendor links (vendor_id, vendor_code, unit_cost_money). There is no `is_default`, `is_primary`, or priority field. When a variation has multiple vendors, there is no API-level way to determine which vendor the merchant considers "primary." Our system uses cheapest cost as the tiebreaker (LATERAL JOIN ORDER BY unit_cost_money ASC). If Square adds a default vendor flag in the future, update the LATERAL JOIN in `services/reports/loyalty-reports.js` and the reorder page vendor selection logic. **Discovered**: 2026-03-22 (vendor integrity audit, item 0c).

### OSS locale sweep — remaining frontend hardcoded locale

**Scope**: `public/js/` files still have hardcoded `'en-CA'` and `'CAD'` in `toLocaleString()` calls. Backend fixed; frontend needs merchant context API.

---

## Square Online Store Gaps

| ID | Description |
|----|-------------|
| BACKLOG-64 | `sold_out` flag not reconciled with inventory = 0 |
| BACKLOG-65 | Website catalog categories not synced |
| BACKLOG-63 | Product image captions not populated (SEO/accessibility) |
| BACKLOG-61 | GMC v1beta deprecated — Google Shopping feed broken since Feb 28 2026 (**P0**) — see detailed notes below |

### BACKLOG-61: GMC v1beta → v1 Migration (P0)

**Status**: Broken since February 28, 2026. Google deprecated the v1beta Merchant API endpoints.

**Current state**: All API calls in `services/gmc/merchant-service.js` use `v1beta` paths:
- `getDataSourceInfo()` (line ~310): `/datasources/v1beta/accounts/...`
- `upsertProduct()` (line ~340): `/products/v1beta/accounts/.../productInputs:insert`
- `updateLocalInventory()` (line ~694): `/inventories/v1beta/accounts/.../localInventories:insert`
- `testConnection()` (line ~1037): `/accounts/v1beta/accounts/...`

**Impact**: Product catalog sync and local inventory sync to Google Merchant Center are non-functional. Google Shopping feed generation (`feed-service.js`) still works (TSV from DB), but pushed products are stale.

**Migration path**:
1. Update all 4 API paths from `v1beta` to `v1` in `merchant-service.js`
2. Verify request/response schemas haven't changed between v1beta and v1 (Google may have added required fields)
3. Test `upsertProduct` and `updateLocalInventory` against live GMC sandbox
4. Verify OAuth scopes — current `content` scope may need updating for v1
5. Check if `buildMerchantApiProduct()` payload format still matches v1 expectations

**Risk**: Low complexity (path changes), but requires live API testing. Cannot be validated in unit tests alone.

**Do NOT attempt** without access to a GMC test account and time to validate each endpoint.

---

### Email Alert Infrastructure (BACKLOG-80)

**Status**: Role-based alert recipients implemented in code (`utils/alert-recipients.js`). Transactional email delivery infrastructure is a separate task.

**What's needed**:
- Cloudflare Email Routing configured for the alert FROM domain
- Transactional email provider (Resend/Mailgun) verified sender setup for `ALERT_FROM_EMAIL`
- DNS records: SPF, DKIM, DMARC for deliverability
- Test end-to-end flow with a real merchant that has owner + manager staff members

---

## Logging

| ID | Description |
|----|-------------|
| L-2 | 10 locations missing `merchantId` in error logs |

---

## Config

| ID | Description |
|----|-------------|
| C-4 | Backups not encrypted at rest, no post-backup verification, local only |

---

## Architecture

No open items.

---

## Multi-Tenant Gaps (from audit 2026-03-08) — Documented, TODO(pre-franchise)

| ID | Severity | Description |
|----|----------|-------------|
| MT-6 | Degrades | Sync interval configuration is global, not per-merchant |
| MT-7 | Degrades | `DAILY_COUNT_TARGET` cycle count target is global |
| MT-8 | Cosmetic | Shared log files across all merchants (tags work, but flat files don't scale) |
| MT-9 | Degrades | Health check picks arbitrary merchant for Square status |
| MT-11 | Cosmetic | Single global `TOKEN_ENCRYPTION_KEY` for all merchants |

---

## Audit Findings — Remaining LOWs (2026-03-22)

| ID | Description |
|----|-------------|
| AUDIT-4.2.1 | ~~LIKE wildcard injection in taxonomy search~~ — **FIXED** (escapeLikePattern utility) |
| AUDIT-4.5.1 | Server-generated IDs unescaped in HTML attributes |
| AUDIT-5.2.1 | Token refresh race condition — no mutex for concurrent requests |
| AUDIT-5.8.1 | Webhook notificationUrl accepts any URL |
| AUDIT-3.8 | ~~9 modification routes missing requireWriteAccess~~ — **FIXED** (10 routes in catalog.js) |
| AUDIT-2.3.1 | Public /subscriptions/status leaks plan name by email |
| AUDIT-2.5.1 | ~~Debug cron jobs hardcoded to merchant_id = 3~~ — **FIXED** (multi-tenant iteration) |
| AUDIT-6.1 | Driver API routes (`driverApiRoutes` mounted at `/api`) bypass `/api/delivery` feature+permission gates. Authenticated driver management endpoints (e.g. `POST /api/delivery/route/:id/share`) use `requireAuth`+`requireMerchant` directly but skip `requireFeature('delivery')`. Low risk: driver routes are token-based, not session-based. **Pre-franchise review item.** |

---

## Grading History

| Date | Grade | Notes |
|------|-------|-------|
| 2026-03-23 | B+ | 3 audit LOWs fixed (AUDIT-4.2.1, 3.8, 2.5.1). BACKLOG-41 phases 3B-2+4 done. 4,825 tests / 237 suites. |
| 2026-03-22 | B+ | 13-section security audit. Core security A+. 4,500+ tests / 219 suites. |
| 2026-03-15 | A+ | 4,035 tests / 187 suites / 0 failures. Loyalty: 857+ tests. 119 new tests in session. |
| 2026-03-04 | A+ | All P0-P2 complete. Test coverage and file size violations remain for A++ |
| 2026-02-19 | A+ | P0 7/7, P1 9/9, P2 6/6. API optimization 4/4 |
| 2026-01-26 | A | P0-5,6,7 fixed. P1-6,7,8,9 fixed. Master engineering review |

**Target A++ requirements**: Comprehensive test coverage, file size compliance, zero known security issues.
