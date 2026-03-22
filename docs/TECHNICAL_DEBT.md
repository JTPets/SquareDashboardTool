# Technical Debt — Known Issues

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Priorities](./PRIORITIES.md) | [Architecture](./ARCHITECTURE.md) | [Roadmap](./ROADMAP.md)

**Last Updated**: 2026-03-22

Known issues that are logged but not yet scheduled. These are not blocking any feature work — they represent latent risks, code smells, or minor correctness issues to address when touching nearby code.

---

## Summary

| Category | Open Items |
|----------|-----------|
| Code Quality Observations | 1 |
| Square Online Store | 4 |
| Logging | 1 |
| Config | 1 |
| Architecture | 1 |
| Multi-Tenant Gaps | 5 |
| Audit Findings (2026-03-22) | 7 |
| **Total** | **~20** |

---

## Code Quality Observations

### OSS locale sweep — remaining frontend hardcoded locale

**Scope**: `public/js/` files still have hardcoded `'en-CA'` and `'CAD'` in `toLocaleString()` calls. Backend fixed; frontend needs merchant context API.

---

## Square Online Store Gaps

| ID | Description |
|----|-------------|
| BACKLOG-64 | `sold_out` flag not reconciled with inventory = 0 |
| BACKLOG-65 | Website catalog categories not synced |
| BACKLOG-63 | Product image captions not populated (SEO/accessibility) |
| BACKLOG-61 | GMC v1beta deprecated — Google Shopping feed broken since Feb 28 2026 (**P0**) |

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

| ID | File | Description |
|----|------|-------------|
| O-4 | `services/square/square-pricing.js` | Scoping bug — `catch` references var from `try` block |

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
| AUDIT-4.2.1 | LIKE wildcard injection in taxonomy search |
| AUDIT-4.5.1 | Server-generated IDs unescaped in HTML attributes |
| AUDIT-5.2.1 | Token refresh race condition — no mutex for concurrent requests |
| AUDIT-5.8.1 | Webhook notificationUrl accepts any URL |
| AUDIT-3.8 | 9 modification routes missing requireWriteAccess |
| AUDIT-2.3.1 | Public /subscriptions/status leaks plan name by email |
| AUDIT-2.5.1 | Debug cron jobs hardcoded to merchant_id = 3 |

---

## Grading History

| Date | Grade | Notes |
|------|-------|-------|
| 2026-03-22 | B+ | 13-section security audit. Core security A+. 4,500+ tests / 219 suites. |
| 2026-03-15 | A+ | 4,035 tests / 187 suites / 0 failures. Loyalty: 857+ tests. 119 new tests in session. |
| 2026-03-04 | A+ | All P0-P2 complete. Test coverage and file size violations remain for A++ |
| 2026-02-19 | A+ | P0 7/7, P1 9/9, P2 6/6. API optimization 4/4 |
| 2026-01-26 | A | P0-5,6,7 fixed. P1-6,7,8,9 fixed. Master engineering review |

**Target A++ requirements**: Comprehensive test coverage, file size compliance, zero known security issues.
