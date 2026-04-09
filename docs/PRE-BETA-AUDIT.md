# Pre-Beta Priority Audit — Top 15 Items

> **Date**: 2026-04-09 | **Method**: Full scan of all .md docs, audit files, and source-traced findings
> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Priorities](./PRIORITIES.md) | [Subscription Audit](./SUBSCRIPTION-AUDIT.md) | [Signup Flow Audit](./SIGNUP-FLOW-AUDIT.md)

---

## PRE-BETA TOP 15 PRIORITIES

### Tier 1: CRITICAL (Ship Blockers)

**1. [BUG-1 + BUG-2] Subscription checkout completely broken for new users**
- File: `docs/SIGNUP-FLOW-AUDIT.md` §2
- Effort: S | Status: TODO
- `POST /api/subscriptions/promo/validate` and `POST /api/subscriptions/create` return 400 for unauthenticated users. Route handlers require `merchantId` from session, but new subscribers have no session. **No new user can complete signup or payment.** Core revenue flow is dead.
- Fix: Remove `merchantId` guard from create handler; use platform-owner fallback for promo validation (pattern exists in `plans.js:18-26`).

**2. [B1] merchant_features never populated on subscription activation**
- File: `docs/SUBSCRIPTION-AUDIT.md` §4 item 1
- Effort: S | Status: TODO
- `activateMerchantSubscription()` only sets `subscription_status = 'active'` but never inserts rows into `merchant_features`. Every `requireFeature()` check returns 403 for new paid subscribers. **Feature gating is completely disconnected from billing — paid users can't access paid features.**
- Fix: Add `merchant_features` INSERT for all `getPaidModules()` inside `activateMerchantSubscription()`. Also wire into `handleInvoicePaymentMade` webhook path.

**3. [CSP-1 + CSP-2] Square payment card form blocked by Content Security Policy**
- File: `docs/SIGNUP-FLOW-AUDIT.md` §4
- Effort: S | Status: TODO
- `font-src` and `connect-src` in `middleware/security.js` missing `*.squarecdn.com`. Square Web Payments SDK loads fonts and makes XHR calls to its CDN. Without these CSP entries, the card input widget renders broken or silently fails in some browsers. **Payment collection may not work.**
- Fix: Add `"https://*.squarecdn.com"` to both `fontSrc` and `connectSrc` arrays in Helmet config.

**4. [B2] Cancelled merchants retain full platform access**
- File: `docs/SUBSCRIPTION-AUDIT.md` §4 item 2
- Effort: S | Status: TODO
- `middleware/merchant.js:127` checks only `'expired'` and `'suspended'` for `isSubscriptionValid = false`. The `'cancelled'` status falls to the `else` branch, setting `isSubscriptionValid = true`. **Cancelled merchants keep full access indefinitely — direct revenue leakage.**
- Fix: Add `'cancelled'` to the `isSubscriptionValid = false` check. Also: `cancelMerchantSubscription()` already disables `merchant_features` rows (correct), but the subscription middleware still passes.

---

### Tier 2: HIGH (Test Before Launch)

**5. [SUSPEND-GAP] Suspended merchants retain feature access**
- File: `docs/FEATURE-PACKAGING-AUDIT.md` §5 item 4
- Effort: S | Status: TODO
- `suspendMerchantSubscription()` sets merchant status to `'suspended'` but does NOT disable `merchant_features` rows. Although `requireValidSubscription` blocks at the middleware level (status `'suspended'` → `isSubscriptionValid = false`), any route without `requireValidSubscription` (base module routes) still allows access. Feature rows should be disabled for defense-in-depth.
- Fix: Add `UPDATE merchant_features SET enabled = FALSE WHERE source = 'subscription'` to `suspendMerchantSubscription()`.

**6. [B3] Promo duration_months not enforced — $0.99 beta price lasts forever**
- File: `docs/SUBSCRIPTION-AUDIT.md` §4 item 3
- Effort: M | Status: TODO
- `promo_codes.duration_months` is stored and shown in UI but never applied to billing. A `fixed_price` promo ($0.99/mo beta) continues indefinitely. No cron job or webhook handler checks promo expiry.
- Fix: Store `promo_expires_at = NOW() + duration_months` on subscription creation. Add check in renewal webhook or trial-expiry-job to revert pricing when promo period ends.

**7. [B5] Hardcoded fallback prices don't match DB-seeded plan prices**
- File: `docs/SUBSCRIPTION-AUDIT.md` §3 + §4 item 5
- Effort: S | Status: TODO
- `utils/subscription-handler.js:44-46` has `priceCents = plan === 'annual' ? 9999 : 999` ($99.99/$9.99). DB-seeded values are $29.99/$299.99. If plan lookup fails, the system silently charges the wrong amount.
- Fix: Remove hardcoded fallback prices; throw a clear error if plan not found in DB.

**8. [GMC-AUTH] GMC merchant-service reads encrypted tokens without decrypting**
- File: `docs/GMC-AUDIT.md` §2
- Effort: S | Status: TODO
- `services/gmc/merchant-service.js:getAuthClient()` reads tokens from DB but doesn't call `decryptToken()`. Token refresh handler saves plaintext back without encrypting. The correct auth module (`utils/google-auth.js`) is never used. All GMC API calls and cron sync fail with encrypted tokens.
- Fix: Refactor `getAuthClient()` to use `utils/google-auth.js` or add proper decrypt/encrypt calls.

**9. [GATES-HIGH] GMC feed endpoints fully unauthenticated — catalog exposed**
- File: `docs/FEATURE-GATES-AUDIT.md` §6
- Effort: S | Status: TODO
- `/api/gmc/feed.tsv` and `/api/gmc/local-inventory-feed.tsv` explicitly skip `requireFeature('gmc')` AND `requirePermission`. No token or secret protects them. Any external party can enumerate full product catalog + pricing.
- Fix: Add shared-secret query parameter (`?token=`) or restrict to known Google crawler IPs.

---

### Tier 3: MEDIUM (Fix If Time Permits)

**10. [B4] Promo max_uses race condition — no atomic check**
- File: `docs/SUBSCRIPTION-AUDIT.md` §4 item 4
- Effort: S | Status: TODO
- `max_uses` is checked and incremented in two separate queries with no transaction or `SELECT FOR UPDATE`. Two concurrent signups with a `max_uses = 1` code can both succeed.
- Fix: Use atomic `UPDATE promo_codes SET times_used = times_used + 1 WHERE id = $1 AND times_used < max_uses RETURNING id`.

**11. [PRICING-UI] Pricing page advertises per-module billing that doesn't exist**
- File: `docs/FEATURE-PACKAGING-AUDIT.md` §3 + §5
- Effort: S | Status: TODO
- `pricing.html` shows individual module prices ($9.99-$19.99) with per-module CTAs. All CTAs link to `subscribe.html` which only offers monthly/annual all-or-nothing. The `full_suite` bundle ($59.99) is dead code. Misleading to potential customers.
- Fix: Reword CTAs to "Subscribe for full access" or "Per-module billing coming soon". Remove dead bundle code or wire it up.

**12. [SUB-UI-1] No cancel subscription button in any UI**
- File: `docs/SUBSCRIPTION-UI-AUDIT.md` §1 + §4
- Effort: S | Status: TODO
- API exists (`POST /api/subscriptions/cancel`) but no cancel button exists on any merchant-facing page. Merchants cannot self-service cancel — they'd need to contact support.
- Fix: Add confirmation modal + cancel button to `upgrade.html` or settings page.

**13. [SUB-UI-2] No trial countdown indicator**
- File: `docs/SUBSCRIPTION-UI-AUDIT.md` §1 + §4
- Effort: S | Status: TODO
- No "X days remaining" banner anywhere. Trial merchants have no visibility into when their trial expires. Reduces conversion urgency.
- Fix: Read `trial_ends_at` from merchant-status API; add countdown banner to dashboard.html.

**14. [BACKLOG-80] Email alert infrastructure not configured**
- File: `docs/TECHNICAL_DEBT.md`, `docs/PRIORITIES.md`
- Effort: S | Status: PARTIAL (code built, infra not configured)
- Alert recipients helper built and tested (`utils/alert-recipients.js`). But system sends from/to the same email (john@jtpets.ca), so alerts are invisible. Needs Cloudflare Email Routing + transactional sender (Resend/Mailgun). DNS records (SPF, DKIM, DMARC) needed.
- Fix: Configure email routing + transactional sender. Update SMTP config in `.env`.

**15. [BACKLOG-120] Static security analysis test suite**
- File: `docs/PRIORITIES.md`, `docs/WORK-ITEMS.md`
- Effort: M | Status: TODO
- No automated checks for: SQL injection (string concatenation in queries), missing `merchant_id` on data queries, missing `escapeHtml` on frontend rendering, raw user input in logs, hardcoded secrets. Manual audits have caught these, but regressions are possible without automated detection.
- Fix: Create `__tests__/security/security-static-analysis.test.js` with AST/grep-based checks.

---

## Summary

| Tier | Count | Items |
|------|-------|-------|
| CRITICAL (Ship Blockers) | 4 | BUG-1/2, B1, CSP-1/2, B2 |
| HIGH (Test Before Launch) | 5 | SUSPEND-GAP, B3, B5, GMC-AUTH, GATES-HIGH |
| MEDIUM (Fix If Time Permits) | 6 | B4, PRICING-UI, SUB-UI-1, SUB-UI-2, BACKLOG-80, BACKLOG-120 |

**Estimated effort for all CRITICAL items**: ~4-6 hours (all are S-effort code changes)
**Estimated effort for all HIGH items**: ~1-2 days
**Estimated effort for all 15 items**: ~3-5 days

---

## Items Already FIXED That Should Be Cleaned From Docs

The following items are marked as **FIXED** in `docs/TECHNICAL_DEBT.md` §Audit Findings but still listed in the table (with strikethrough). They can be removed entirely:

| ID | Description | Status |
|----|-------------|--------|
| AUDIT-4.2.1 | LIKE wildcard injection in taxonomy search | FIXED |
| AUDIT-4.5.1 | Server-generated IDs unescaped in HTML attributes | FIXED |
| AUDIT-5.2.1 | Token refresh race condition | FIXED |
| AUDIT-5.8.1 | Webhook notificationUrl accepts any URL | FIXED |
| AUDIT-3.8 | 9 modification routes missing requireWriteAccess | FIXED |
| AUDIT-2.3.1 | Public /subscriptions/status leaks plan name | FIXED |
| AUDIT-2.5.1 | Debug cron jobs hardcoded to merchant_id = 3 | FIXED |

**Recommendation**: Remove the entire "Audit Findings — Remaining LOWs" section from `TECHNICAL_DEBT.md` since all items are resolved. Only AUDIT-6.1 (driver API bypass) remains open and is already documented as a pre-franchise review item.

---

## Key Observations

1. **The subscription/payment flow is the #1 risk area.** Items 1-7 all touch the subscribe → pay → activate → cancel lifecycle. A focused sprint on `routes/subscriptions/merchant.js`, `middleware/merchant.js`, and `services/subscriptions/subscription-create-service.js` resolves the top 7 items.

2. **All 4 CRITICAL items are small fixes.** None require new tables, new services, or architectural changes. They're guard condition fixes, CSP config additions, and missing INSERT statements.

3. **GMC is functional via TSV feed fallback.** Items 8-9 affect the Merchant API v1 path, but the TSV feed generation still works. Lower urgency if GMC API isn't needed at launch.

4. **No data loss or corruption risks found.** All issues are access control, billing, or UI gaps. The core data layer (multi-tenant isolation, parameterized queries, webhook processing) is solid.

5. **Test coverage is strong (5,464 tests)** but none of the broken subscription flows have test coverage for the specific failure modes identified here. Priority #15 (static analysis) would catch regressions.
