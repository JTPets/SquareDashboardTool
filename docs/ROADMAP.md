# Roadmap — Future Planned Work

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Priorities](./PRIORITIES.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-03-10

Items here are planned but not yet started. They represent significant future initiatives beyond the active priority list.

---

## 1. Sales Velocity Refactor (DRAFT — 5 phases)

**Resolves**: BACKLOG-35 (refunds not subtracted), BACKLOG-36 (phantom velocity rows), variation ID remapping corruption

**Source**: [archived plan](./archive/PLAN-sales-velocity-refactor.md)

Replace the current Orders API-based velocity calculation with an `inventory_changes` table sourced from Square's Inventory Changes API. This provides an immutable append-only ledger of inventory adjustments that preserves original variation IDs and natively handles refunds.

| Phase | Description | Risk | Effort |
|-------|-------------|------|--------|
| 1 | Schema + backfill service (additive only, no behavior changes) | Low | M |
| 2 | Webhook integration — capture inventory changes in real-time | Low-Med | M |
| 3 | New velocity recalculation from local data (parallel mode) | Med | M |
| 4 | Cutover — switch source of truth from Orders API to local aggregation | Med | S |
| 5 | Cleanup — deprecate old sync functions, close BACKLOG items | Low | S |

**Key benefits**: 0 API calls per velocity sync (currently ~40), handles refunds natively, eliminates phantom rows, preserves variation ID history.

**Prerequisites**: Answer 5 open questions (see archived plan Section 8) — test `total_price_money` reliability, backfill depth, remapped ID behavior, partial refund adjustments, non-sale SOLD adjustments.

---

## 2. Architecture Splits (Refactor-on-Touch)

Oversized files to split when next modified. Not proactive — triggered by touching the file.

| File | Lines | Suggested Split |
|------|-------|----------------|
| `routes/loyalty.js` | 2,134 | 5 thin route files + loyalty services |
| `services/expiry/discount-service.js` | 2,097 | tier-evaluator, discount-crud, automation, settings, seeder |
| `services/delivery/delivery-service.js` | 1,918 | order-crud, route-generator, pod-manager, customer-lookup |
| `routes/analytics.js` | 874 | Extract reorder-suggestions-service.js |
| `server.js` | ~1,050 | Remove dead imports + comment lines, further split TBD |

**Source**: CODEBASE_AUDIT_2026-02-25 (A-6), AUDIT-2026-02-28 Phase 3

---

## 3. Open-Source Readiness

Prepare for public release. Estimated 1-2 days focused effort.

| Item | Description | Effort |
|------|-------------|--------|
| OSS-1-7 | Remove JTPets branding from 6 HTML files, replace referral links with configurable values | S |
| OSS-8-21 | Centralize currency/locale/timezone — currently hardcoded CAD, en-CA, America/Toronto across ~60 locations | M |
| OSS-22-27 | Make pet-store-specific AI prompts, seniors discount config, delivery URLs configurable | S |
| Dual Square API versions | Consolidate `SQUARE_API_VERSION` to single constant in `config/constants.js` | S |
| Frontend util extraction | Shared `showToast`, `escapeJsString`, `formatDate` (7 copies each) | S |

**Source**: AUDIT-2026-02-28 Section 10

---

## 4. Unified Audit Logging (Pre-Franchise)

**Priority**: Low (single store), High (before franchise deployment)

Replace fragmented audit trails (`webhook_events`, `loyalty_audit_logs`, `delivery_audit_log`, `sync_history`) with a single `audit_log` table.

**Schema**: `actor, action, entity_type, entity_id, before_value (JSONB), after_value (JSONB), merchant_id, created_at`

**Missing coverage**: inventory changes, catalog edits, admin actions, manual overrides.

**Source**: CLAUDE.md Architectural Tech Debt

---

## 5. Distributed Locking for Cron Jobs (Pre-Franchise)

Required before multi-instance deployment. Currently cron jobs assume single-instance execution. Need advisory locks or a distributed lock table to prevent duplicate job runs.

**Source**: CODE_AUDIT_REPORT (HIGH-4)

---

## 6. CI/CD Pipeline

No automated test execution before deploy. Deployment is manual (`pm2 restart`).

**Recommended**: GitHub Actions workflow — `npm test` on push/PR. Simple `deploy.sh` script that pulls, installs, tests, restarts PM2 only on success.

**Source**: CODEBASE_AUDIT_2026-02-25 (C-2)

---

## 7. Future Integrations

| ID | Description | Effort | Depends On |
|----|-------------|--------|------------|
| BACKLOG-46 | QuickBooks daily sync — auto-sync sales summaries and inventory to QuickBooks Online | L | — |
| BACKLOG-47 | Multi-channel inventory sync — Shopify, WooCommerce, BigCommerce | XL | Multi-POS abstraction |
| BACKLOG-48 | Clover POS integration | XL | Multi-POS abstraction |
| BACKLOG-49 | Stripe payment integration — alternative payment processor | L | — |

---

## 8. Subscription System Cleanup

| Item | Description |
|------|-------------|
| `merchants.subscription_status` auto-transition | Status stays stale at 'trial'. Add cron to update for cleaner admin reporting |
| Decide SaaS billing provider | Stripe vs Square for SqTools subscriptions (BACKLOG-50 dependency) |

**Source**: MULTI-TENANT-AUDIT Subscription System Observations

---

## 9. VIP Customer Auto-Discounts (BACKLOG-55)

Assign customers to named VIP groups (e.g., "Family", "Staff Alumni", "Investor") in Square customer profiles. Pricing rules auto-apply configured discount % at POS with no staff action required. Management UI to assign/remove VIP status and set discount % per group. Uses existing Square customer group + pricing rule infrastructure from loyalty system. No loyalty points on VIP-discounted items.

---

## 10. Employee KPI Coaching Dashboard (BACKLOG-53)

Do not recreate Square's native labor reports. Instead pull `employee_id` from orders + labor webhook data to surface: loyalty enrollments per employee, qualifying item upsell rate, avg basket size, punctuality from timecards. Coaching view, not payroll. Franchise-relevant for store managers.

---

## 11. Employee Auto-Discounts (BACKLOG-54)

Use `employee_id` already present on Square orders to auto-apply staff discount. Create discount via Square catalog API, apply via pricing rule scoped to employee group. No loyalty points on staff purchases. Needs staff list management UI.

---

## Loyalty Data Integrity - Known Issues

### ~~BACKLOG-59: Multi-Reward Redemption Detection Bug~~ RESOLVED (2026-03-10)

`detectRewardRedemptionFromOrder()` now loops all matched earned rewards instead of early-returning after the first. Multi-reward redemption confirmed incident resolved 2026-03-10.

### BACKLOG-60: Orphaned Earned Rewards Cleanup (Pre-CRIT-1/CRIT-2)

Manual data cleanup required for orphaned earned rewards created before the CRIT-1/CRIT-2 race condition fixes (merged 2026-03-10). Affected customers have been identified in the database and need SQL audit and manual revocation.

**Audit query**:
```sql
SELECT square_customer_id, array_agg(id)
FROM loyalty_rewards
WHERE merchant_id = 3 AND status = 'earned'
GROUP BY square_customer_id
HAVING COUNT(*) > 1;
```

### BACKLOG-63: Caption Auto-Generation for Square Online Store Product Images

Medium priority. Use Claude API to generate descriptive captions for all catalog images (under 140 chars). Push via `POST /v2/catalog/batch-upsert` updating `image_data.caption`. Square has no `alt_text` field — `caption` is displayed in Online Store and is the closest SEO/accessibility equivalent. One-time bulk run + hook into catalog sync for new items. Requires: Claude API integration already exists (SEO content generation). Low effort — reuse existing pattern.
