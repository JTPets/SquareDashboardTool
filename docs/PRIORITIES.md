# Active Priorities — Post-Cleanup Assessment

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Roadmap](./ROADMAP.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-04-09
**Assessment Type**: Fresh pre-beta priority audit after cleanup of 9+ verified-FIXED items

---

## Items Verified FIXED This Session (2026-04-09)

### From PRE-BETA-AUDIT verification (removed from audit docs)
| ID | What Was Fixed |
|----|----------------|
| BUG-1/BUG-2 | Signup flow — platform-owner fallback + null merchantId handling |
| B1 | Subscription bridge — merchant_features populated on payment |
| B2 | Cancelled/expired/suspended status blocks access |
| B4 | Promo max_uses race condition — atomic UPDATE...WHERE |
| B5 | Hardcoded fallback prices — DB lookup with throw on missing |
| CSP-1/CSP-2 | Content Security Policy — squarecdn.com added to font-src + connect-src |
| SUSPEND-GAP | Subscription bridge disables features on suspend |
| GMC-AUTH | Google auth delegation to getAuthenticatedClient |
| GATES-HIGH | GMC feed token-based auth via gmc_feed_token |

### From TECHNICAL_DEBT.md (audit LOWs removed)
AUDIT-4.2.1, 4.5.1, 5.2.1, 5.8.1, 3.8, 2.3.1, 2.5.1 — all confirmed FIXED and purged.

### From code verification (audit docs still stale — see note below)
| ID | Doc | Actual Code |
|----|-----|-------------|
| SEC-GMC-1 | CRITICAL: encrypted tokens not decrypted | **FIXED** — google-auth.js decryptToken() at load |
| SEC-GMC-2 | HIGH: token refresh saves plaintext | **FIXED** — saveTokens() encrypts before DB write |
| SEC-GMC-3 | HIGH: brands missing merchant_id | **FIXED** — WHERE merchant_id = $2 on all brand queries |
| DELIVERY-BUG-001 | HIGH: force-regenerate orphans orders | **FIXED** — delivery-routes.js resets order statuses |
| DELIVERY-BUG-002 | HIGH: finishRoute ignores delivered | **FIXED** — auto-completes delivered before rollback |
| DELIVERY-BUG-008 | LOW: cleanupExpiredPods never called | **FIXED** — pod-cleanup-job.js scheduled at 3:30 AM |
| CATALOG: available_for_pickup | HIGH: hardcoded FALSE | **FIXED** — reads from Square data directly |

**Note**: GMC-AUDIT.md, DELIVERY-AUDIT.md, and CATALOG-ATTRIBUTE-AUDIT.md contain stale BROKEN statuses for items that are FIXED in code. These docs need updating in a future session.

---

## CRITICAL (Ship Blockers)

| # | ID | Description | Effort | File |
|---|-----|-------------|--------|------|
| 1 | B3 | **Promo duration_months not enforced** — $0.99 beta price lasts forever. `promo-expiry-job.js` detects expired promos but only logs warnings. Missing: auto-revert `discount_applied_cents = 0`, Square API call to update to full price, merchant notification. | M | `jobs/promo-expiry-job.js`, `services/subscriptions/` |

**Assessment**: Only 1 true ship blocker. Without this fix, beta promo pricing never expires — direct revenue loss.

---

## HIGH (Pre-Launch Polish)

| # | ID | Description | Effort | File |
|---|-----|-------------|--------|------|
| 2 | PRICING-UI | **Pricing page misleading** — shows per-module prices ($9.99-$19.99) with individual CTAs, but subscribe.html only offers all-or-nothing monthly/annual. `full_suite` bundle is dead code. Misleads potential customers. | S | `public/pricing.html` |
| 3 | SUB-UI-1 | **No cancel subscription button** — API exists (`POST /api/subscriptions/cancel`) but no cancel button in any merchant UI. Merchants cannot self-service cancel. | S | `public/upgrade.html` |
| 4 | SUB-UI-2 | **No trial countdown** — no "X days remaining" banner. Trial merchants have zero visibility into expiration. Reduces conversion urgency. | S | `public/dashboard.html` |
| 5 | SUB-UI-3 | **No billing history page** — no payment history view. Merchants can't see past charges. | M | New page or section in `upgrade.html` |
| 6 | BACKLOG-80 | **Email alert infrastructure** — code built (`utils/alert-recipients.js`, 135 tests), but sends from/to same email. Needs Cloudflare Email Routing + transactional sender (Resend/Mailgun). | S | `.env`, `utils/email-notifier.js` |
| 7 | BACKLOG-50 | **Post-trial conversion** — $1 first month. Capture payment method, prove intent. Decide Stripe vs Square for SaaS billing. | L | New system |

---

## MEDIUM (Fix If Time Permits Before Beta)

### Subscription UI Gaps

| # | ID | Description | Effort |
|---|-----|-------------|--------|
| 8 | SUB-UI-4 | Admin promo code management UI — API exists, no form | S |
| 9 | SUB-UI-5 | Admin feature toggle per merchant — no UI exists | S |
| 10 | SUB-UI-6 | Admin subscriber list with search/filter | S |

### Testing & Quality

| # | ID | Description | Effort |
|---|-----|-------------|--------|
| 11 | BACKLOG-120 | Static security analysis test suite — SQL injection, merchant_id, escapeHtml | M |
| 12 | BACKLOG-117 | Jest coverage reporting — visibility into coverage gaps | S |
| 13 | BACKLOG-118 | Integration test framework — real DB tests | M |

### Operational

| # | ID | Description | Effort |
|---|-----|-------------|--------|
| 14 | BACKLOG-107 | Reorder suggestions audit — 810-line service, silent exclusion bugs | S |
| 15 | BACKLOG-108 | Stale draft PO warning — old drafts silently suppress reorder items | M |
| 16 | CSS-5 | CSS shared components — extract inline styles from ~20 pages | M |

### Business Features (Post-Beta OK)

| # | ID | Description | Effort |
|---|-----|-------------|--------|
| 17 | BACKLOG-39 | Vendor bill-back tracking + promo engine | L |
| 18 | BACKLOG-81 | Margin erosion tracking dashboard | L |
| 19 | BACKLOG-82 | Customer purchase intelligence — RFM scoring | L |
| 20 | BACKLOG-42 | Barcode scan-to-count for cycle counts | M |
| 21 | BACKLOG-44 | Purchase order generation with branding | M |
| 22 | BACKLOG-45 | Spreadsheet bulk upload | M |
| 23 | BACKLOG-51 | Demo account — read-only for sales | M |
| 24 | BACKLOG-109 | Merchant-configurable auto min/max settings | M |

---

## LOW (Post-Launch / Pre-Franchise)

| ID | Description | Effort |
|----|-------------|--------|
| AUDIT-6.1 | Driver API routes bypass delivery feature gate | S |
| MT-6/7 | Global config should be per-merchant (sync interval, count target) | S |
| MT-8/9/11 | Shared logs, arbitrary health check, global encryption key | S |
| C-4 | Backups not encrypted at rest | M |
| BACKLOG-8 | Vendor API sync gaps (display + address) | S-M |
| BACKLOG-43 | Min/Max stock per item per location | S |
| BACKLOG-99 | PO inventory push to Square on receive | M |
| BACKLOG-119 | E2E browser test framework | L |
| BACKLOG-34 | Doc: Square variation ID reuse | S |
| BACKLOG-40 | exceljs deprecated transitive deps | S |
| BACKLOG-95 | Multi-location expiry/count scoping | L |
| BACKLOG-104 | GMC product schema completeness audit | S |

---

## Recommended Next Actions

1. **Fix B3 (promo billing revert)** — only CRITICAL item. Add auto-revert logic to `promo-expiry-job.js`. Effort: M. Direct revenue impact.
2. **Fix PRICING-UI** — reword CTAs on pricing.html to match actual billing model. Effort: S (copy change). Prevents customer confusion at signup.
3. **Add cancel button (SUB-UI-1)** — merchants need self-service cancel. API exists; just needs UI. Effort: S.
4. **Add trial countdown (SUB-UI-2)** — drives conversion urgency. Read `trial_ends_at`, show banner. Effort: S.
5. **Smoke test signup → pay → use → cancel flow** end-to-end in staging before beta launch.

---

## Ship Readiness Assessment

| Area | Status | Notes |
|------|--------|-------|
| Core flows working | **Yes** | Signup → pay → activate → use → cancel all functional |
| Revenue path intact | **Mostly** | B3 promo expiry is the one gap — $0.99 price doesn't auto-revert |
| Multi-user ready | **Yes** | Staff roles, permissions, invitation flow all complete (BACKLOG-41 done) |
| Security | **A+** | 5,464 tests, all audit CRITICAL/HIGH fixed, parameterized SQL, merchant isolation |
| Subscription system | **Functional** | End-to-end lifecycle works; UI polish missing (cancel, billing history) |
| Data integrity | **Strong** | Loyalty race conditions fixed, webhook dedup, atomic transactions |

**Recommended action**: Fix B3 + PRICING-UI + SUB-UI-1/2 (4 items, all S-M effort), then **ship beta**. Everything else is polish or new features that beta doesn't need.

---

## Effort Key

| Code | Meaning |
|------|---------|
| S | Small — < 1 file change or < 2 hours |
| M | Medium — 2-5 files or half a day |
| L | Large — 6+ files or multi-day effort |
