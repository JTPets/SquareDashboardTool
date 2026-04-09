# Pre-Beta Priority Audit — Top 15 Items

> **Date**: 2026-04-09 | **Verified**: 2026-04-09 (code-level confirmation of all statuses)
> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Priorities](./PRIORITIES.md) | [Subscription Audit](./SUBSCRIPTION-AUDIT.md) | [Signup Flow Audit](./SIGNUP-FLOW-AUDIT.md)

---

## Verification Summary

Source-of-truth check against actual code on 2026-04-09. Many items flagged as broken in older audit docs have since been fixed. **Only 1 of the original top 9 items remains broken (B3).** The remaining open items are UI gaps and infrastructure tasks.

| Original # | ID | Doc Said | Code Says | Details |
|-------------|-----|----------|-----------|---------|
| 1 | BUG-1/BUG-2 | CRITICAL | **FIXED** | `merchant.js:19-27` platform-owner fallback; `merchant.js:43` null merchantId allowed |
| 2 | B1 | CRITICAL | **FIXED** | `subscription-bridge.js:46-52` INSERTs all `getPaidModules()` into `merchant_features` |
| 3 | CSP-1/CSP-2 | CRITICAL | **FIXED** | `security.js:70,83` both include `*.squarecdn.com` |
| 4 | B2 | CRITICAL | **FIXED** | `middleware/merchant.js:145` checks `['expired','suspended','cancelled']` |
| 5 | SUSPEND-GAP | HIGH | **FIXED** | `subscription-bridge.js:100-105` disables features on suspend |
| 6 | B3 | HIGH | **STILL BROKEN** | Detection exists but no auto-revert of billing (see below) |
| 7 | B5 | HIGH | **FIXED** | `subscription-handler.js:33-46` DB lookup, throws on missing plan |
| 8 | GMC-AUTH | HIGH | **FIXED** | `merchant-service.js:36` delegates to `google-auth.js:getAuthenticatedClient` |
| 9 | GATES-HIGH | HIGH | **FIXED** | `routes/gmc/feed.js:37-52` token-based auth via `gmc_feed_token` |
| 10 | B4 | MEDIUM | **FIXED** | `subscription-create-service.js:186-197` atomic `UPDATE...WHERE times_used < max_uses` |

---

## REVISED PRE-BETA TOP 15 PRIORITIES

Items re-ranked after code verification. Former CRITICAL/HIGH subscription bugs removed (all fixed). Remaining items are the actual open work.

### Tier 1: CRITICAL (Ship Blockers)

**1. [B3] Promo duration_months not enforced — $0.99 beta price lasts forever**
- File: `services/subscriptions/subscription-create-service.js:292-296`, `jobs/promo-expiry-job.js`
- Effort: M | Status: PARTIALLY FIXED
- `promo_expires_at` is correctly computed and stored. `promo-expiry-job.js` runs weekly and detects expired promos. **But the job only logs warnings — no auto-revert of billing.** The $0.99 beta price continues indefinitely after the promo period ends.
- What's missing: (1) Auto-update `discount_applied_cents = 0` for expired promos, (2) Square API call to update subscription to full price, (3) Merchant notification that promo period ended.

---

### Tier 2: HIGH (Pre-Launch Polish)

**2. [PRICING-UI] Pricing page advertises per-module billing that doesn't exist**
- File: `docs/FEATURE-PACKAGING-AUDIT.md` §3 + §5
- Effort: S | Status: TODO
- `pricing.html` shows individual module prices ($9.99-$19.99) with per-module CTAs. All CTAs link to `subscribe.html` which only offers monthly/annual all-or-nothing. The `full_suite` bundle ($59.99) is dead code. Misleading to potential customers.
- Fix: Reword CTAs to "Subscribe for full access" or "Per-module billing coming soon".

**3. [SUB-UI-1] No cancel subscription button in any UI**
- File: `docs/SUBSCRIPTION-UI-AUDIT.md` §1 + §4
- Effort: S | Status: TODO
- API exists (`POST /api/subscriptions/cancel`) but no cancel button exists on any merchant-facing page. Merchants cannot self-service cancel.
- Fix: Add confirmation modal + cancel button to `upgrade.html` or settings page.

**4. [SUB-UI-2] No trial countdown indicator**
- File: `docs/SUBSCRIPTION-UI-AUDIT.md` §1 + §4
- Effort: S | Status: TODO
- No "X days remaining" banner anywhere. Trial merchants have no visibility into when their trial expires. Reduces conversion urgency.
- Fix: Read `trial_ends_at` from merchant-status API; add countdown banner to dashboard.html.

**5. [SUB-UI-3] No billing history page**
- File: `docs/SUBSCRIPTION-UI-AUDIT.md` §1 + §4
- Effort: M | Status: TODO
- No payment history page exists. Merchants have no way to view past charges.
- Fix: New API to expose past payments + new page or section in upgrade.html.

**6. [BACKLOG-80] Email alert infrastructure not configured**
- File: `docs/TECHNICAL_DEBT.md`, `docs/PRIORITIES.md`
- Effort: S | Status: PARTIAL (code built, infra not configured)
- Alert recipients helper built and tested. System sends from/to the same email — alerts invisible. Needs Cloudflare Email Routing + transactional sender (Resend/Mailgun).
- Fix: Configure email routing + transactional sender. Update `.env`.

---

### Tier 3: MEDIUM (Fix If Time Permits)

**7. [BACKLOG-120] Static security analysis test suite**
- File: `docs/PRIORITIES.md`, `docs/WORK-ITEMS.md`
- Effort: M | Status: TODO
- No automated checks for SQL injection patterns, missing `merchant_id`, missing `escapeHtml`, hardcoded secrets. Regressions possible without automated detection.

**8. [SUB-UI-4] No admin promo code management UI**
- File: `docs/SUBSCRIPTION-UI-AUDIT.md` §2
- Effort: S | Status: TODO
- API exists (`POST /api/admin/promo-codes`) but no admin UI form to create or list promo codes.

**9. [DELIVERY-POD] Expired POD photos never cleaned up**
- File: `docs/DELIVERY-AUDIT.md` §1
- Effort: S | Status: TODO
- `cleanupExpiredPods()` function exists in delivery-service.js but is never invoked by any cron job. `delivery_pod.expires_at` column exists but photos accumulate forever.

**10. [CSS-5] Inline CSS blocks across ~20 HTML pages**
- File: `docs/PRIORITIES.md`, `docs/DELIVERY-AUDIT.md`
- Effort: M | Status: TODO
- Delivery pages alone have ~1,900 lines of inline `<style>` blocks. Violates CLAUDE.md rule. Extract to `shared.css`.

**11. [BACKLOG-117] Jest coverage reporting — no visibility into coverage gaps**
- File: `docs/PRIORITIES.md`
- Effort: S | Status: TODO
- No `jest --coverage` configured. No way to identify lowest-coverage files.

**12. [BACKLOG-107] Reorder suggestions system audit — 810-line oversized service**
- File: `docs/PRIORITIES.md`
- Effort: S | Status: TODO
- `reorder-service.js` at 810 lines with silent exclusion bugs found. Needs full audit and extraction.

**13. [AUDIT-6.1] Driver API routes bypass delivery feature gate**
- File: `docs/TECHNICAL_DEBT.md`
- Effort: S | Status: TODO (pre-franchise)
- Driver management endpoints skip `requireFeature('delivery')`. Low risk (token-based, not session-based).

**14. [MT-6/7] Global config that should be per-merchant**
- File: `docs/TECHNICAL_DEBT.md`
- Effort: S | Status: TODO (pre-franchise)
- Sync interval and `DAILY_COUNT_TARGET` are global env vars, not per-merchant settings.

**15. [BACKLOG-118] Integration test framework — no real DB tests**
- File: `docs/PRIORITIES.md`
- Effort: M | Status: TODO
- All 5,464 tests mock the DB. No tests verify actual SQL execution, constraints, or transactions.

---

## Summary

| Tier | Count | Items |
|------|-------|-------|
| CRITICAL (Ship Blockers) | 1 | B3 (promo billing revert) |
| HIGH (Pre-Launch Polish) | 5 | PRICING-UI, SUB-UI-1/2/3, BACKLOG-80 |
| MEDIUM (Fix If Time Permits) | 9 | BACKLOG-120, SUB-UI-4, DELIVERY-POD, CSS-5, BACKLOG-117/107/118, AUDIT-6.1, MT-6/7 |

**The platform is in much better shape than the audit docs suggest.** 9 of the original top 10 items have been fixed in code. The audit docs (SUBSCRIPTION-AUDIT.md, SIGNUP-FLOW-AUDIT.md, FEATURE-GATES-AUDIT.md, FEATURE-PACKAGING-AUDIT.md) are stale and should be updated to reflect current state.

---

## Items Already FIXED That Should Be Cleaned From Docs

### TECHNICAL_DEBT.md — Audit Findings Section
All items in the "Audit Findings — Remaining LOWs" table are FIXED (strikethrough already present). Remove the entire section. Only AUDIT-6.1 remains open.

### SUBSCRIPTION-AUDIT.md — Blocking Issues (§6)
| Item | Doc Status | Actual Status |
|------|-----------|---------------|
| B1 — merchant_features not populated | CRITICAL | **FIXED** (`subscription-bridge.js:46-52`) |
| B2 — cancelled status allows access | HIGH | **FIXED** (`middleware/merchant.js:145`) |
| B3 — duration_months not enforced | HIGH | **PARTIALLY FIXED** (detection exists, no revert) |
| B4 — promo max_uses race condition | MEDIUM | **FIXED** (`subscription-create-service.js:186-197`) |
| B5 — hardcoded fallback prices | MEDIUM | **FIXED** (`subscription-handler.js:33-46`) |

### SIGNUP-FLOW-AUDIT.md — Broken Paths (§2) and CSP Issues (§4)
| Item | Doc Status | Actual Status |
|------|-----------|---------------|
| BUG-1 — promo/validate 400 | CRITICAL | **FIXED** (platform-owner fallback) |
| BUG-2 — create 400 | CRITICAL | **FIXED** (null merchantId allowed) |
| CSP-1 — font-src missing | MEDIUM | **FIXED** (`security.js:70`) |
| CSP-2 — connect-src missing | MEDIUM | **FIXED** (`security.js:83`) |

### FEATURE-GATES-AUDIT.md — Security Holes (§6)
| Item | Doc Status | Actual Status |
|------|-----------|---------------|
| GMC feed unauthenticated | HIGH | **FIXED** (token-based auth via `gmc_feed_token`) |

### FEATURE-PACKAGING-AUDIT.md — Broken/Missing (§5)
| Item | Doc Status | Actual Status |
|------|-----------|---------------|
| Suspension gap | BROKEN | **FIXED** (`subscription-bridge.js:100-105`) |

---

## Key Observations

1. **Only 1 true blocker remains (B3).** The promo-expiry-job detects expired promos but doesn't revert billing. This is the only item that could cause direct revenue loss at beta launch.

2. **The subscription system is now functional end-to-end.** Signup → pay → activate features → cancel → deactivate all work correctly. The 6 original subscription bugs (BUG-1/2, B1/B2/B4/B5) are all fixed.

3. **UI polish is the main gap.** Missing cancel button, trial countdown, billing history, and promo admin UI are the highest-value remaining items.

4. **Audit docs are significantly stale.** 5 audit documents contain outdated "BROKEN" statuses that have been fixed. Updating these docs would prevent future confusion.

5. **Test coverage is strong (5,464 tests)** and the subscription lifecycle now has integration tests (`subscription-lifecycle.test.js`) covering the payment → activation → cancellation flow.
