# Roadmap — Future Planned Work

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Priorities](./PRIORITIES.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-03-15

Items here are planned but not yet started. They represent significant future initiatives beyond the active priority list.

---

## 1. Sales Velocity Refactor (5 phases)

**Resolves**: Variation ID remapping corruption, inventory-based velocity calculation

Replace the current Orders API-based velocity calculation with an `inventory_changes` table sourced from Square's Inventory Changes API. This provides an immutable append-only ledger of inventory adjustments that preserves original variation IDs and natively handles refunds.

| Phase | Description | Risk | Effort |
|-------|-------------|------|--------|
| 1 | Schema + backfill service (additive only, no behavior changes) | Low | M |
| 2 | Webhook integration — capture inventory changes in real-time | Low-Med | M |
| 3 | New velocity recalculation from local data (parallel mode) | Med | M |
| 4 | Cutover — switch source of truth from Orders API to local aggregation | Med | S |
| 5 | Cleanup — deprecate old sync functions | Low | S |

**Key benefits**: 0 API calls per velocity sync (currently ~40), handles refunds natively, eliminates phantom rows, preserves variation ID history.

**Prerequisites**: Test `total_price_money` reliability, backfill depth, remapped ID behavior, partial refund adjustments, non-sale SOLD adjustments.

---

## 2. Architecture Splits (Refactor-on-Touch)

Oversized files to split when next modified. Not proactive — triggered by touching the file.

**Phase B route thinning COMPLETE (2026-04-05)**: 7 fat routes extracted — 5,698 → 1,645 lines across entry points.
`gmc` (1,009→300), `delivery` (942→287), `purchase-orders` (894→212), `subscriptions` (870→292), `auth` (785→196), `vendor-catalog` (610→262), `sync` (588→96).

| File | Lines | Suggested Split |
|------|-------|----------------|
| `routes/loyalty.js` | 2,134 | 5 thin route files + loyalty services |
| `services/expiry/discount-service.js` | 2,097 | tier-evaluator, discount-crud, automation, settings, seeder |
| `services/delivery/delivery-service.js` | 1,918 | order-crud, route-generator, pod-manager, customer-lookup |
| `routes/analytics.js` | 874 | Extract reorder-suggestions-service.js |
| `server.js` | ~1,050 | Remove dead imports + comment lines, further split TBD |

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

---

## 4. Unified Audit Logging (Pre-Franchise)

**Priority**: Low (single store), High (before franchise deployment)

Replace fragmented audit trails (`webhook_events`, `loyalty_audit_logs`, `delivery_audit_log`, `sync_history`) with a single `audit_log` table.

**Schema**: `actor, action, entity_type, entity_id, before_value (JSONB), after_value (JSONB), merchant_id, created_at`

**Missing coverage**: inventory changes, catalog edits, admin actions, manual overrides.

---

## 5. Distributed Locking for Cron Jobs (Pre-Franchise)

Required before multi-instance deployment. Currently cron jobs assume single-instance execution. Need advisory locks or a distributed lock table to prevent duplicate job runs.

---

## 6. CI/CD Pipeline

No automated test execution before deploy. Deployment is manual (`pm2 restart`).

**Recommended**: GitHub Actions workflow — `npm test` on push/PR. Simple `deploy.sh` script that pulls, installs, tests, restarts PM2 only on success.

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

---

## 9. VIP Customer Auto-Discounts (BACKLOG-55)

Assign customers to named VIP groups in Square customer profiles. Pricing rules auto-apply configured discount % at POS. Management UI to assign/remove VIP status. Uses existing Square customer group + pricing rule infrastructure.

---

## 10. Employee KPI Coaching Dashboard (BACKLOG-53)

Pull `employee_id` from orders + labor webhook data: loyalty enrollments per employee, qualifying item upsell rate, avg basket size, punctuality from timecards. Coaching view, not payroll.

---

## 11. Employee Auto-Discounts (BACKLOG-54)

Use `employee_id` on Square orders to auto-apply staff discount via pricing rule scoped to employee group. No loyalty points on staff purchases. Needs staff list management UI.
