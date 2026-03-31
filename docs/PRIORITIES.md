# Active Priorities

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Roadmap](./ROADMAP.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-03-31

---

## HIGH Priority

### Business

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-61 | GMC v1beta → v1 migration — Google Merchant API v1beta discontinued Feb 28 2026. All product upserts failing with 409. Live store affected — organic Google Shopping visibility broken. **P0.** | Error logs 2026-03-09 | M |
| BACKLOG-50 | Post-trial conversion — $1 first month. Capture payment method, prove intent. Decide Stripe vs Square for SaaS billing | CLAUDE.md | L |
| BACKLOG-39 | Vendor bill-back tracking + promo engine — three connected pieces: (1) **Promo engine**: custom coupon/bundle creator outside Square's pricing rules (avoids Square's bug where timed sales show "on sale" on website even when dormant). Group items into named promos, set discount ($ or %), set active date range. (2) **Discount application**: apply discounts at order level, not catalog level, keeping Square catalog clean. (3) **Bill-back reporting**: tie promos to vendor agreements, aggregate sales during promo periods per vendor for claim submission. Two bill-back types: *promo bill-backs* (vendor-funded promos with date range, e.g., "Smack March Promo") and *seniors day bill-backs* (vendors like Smack cover the 10% seniors day discount on their items — recurring, tied to specific items/brands per vendor agreement). | CLAUDE.md | L |
| BACKLOG-80 | Email alerts not visible — system sends from/to same email. Set up Cloudflare Email Routing + transactional sender | WORK-ITEMS | S |
| BACKLOG-81 | Margin erosion tracking — unified dashboard for margin impact from cost/price changes, loyalty redemptions, and expiry discounts | WORK-ITEMS | L |

---

## MEDIUM Priority

### Features

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-38 | Timed discount automation — apply/remove discounts on cron schedule. **Note**: likely absorbed into BACKLOG-39 promo engine (which manages timed promos internally to avoid Square's "on sale" website bug) | CLAUDE.md | L |
| BACKLOG-41 | User access control with roles — manager, clerk, accountant. Required for multi-user SaaS | CLAUDE.md | L |
| BACKLOG-42 | Barcode scan-to-count for cycle counts | CLAUDE.md | M |
| BACKLOG-44 | Purchase order generation with branding | CLAUDE.md | M |
| BACKLOG-45 | Spreadsheet bulk upload — import/update inventory via CSV or Google Sheets | CLAUDE.md | M |
| BACKLOG-51 | Demo account — read-only view for sales demos | CLAUDE.md | M |
| BACKLOG-55 | VIP customer auto-discounts via Square customer groups | CLAUDE.md | M |
| BACKLOG-4 | Customer birthday sync for marketing | CLAUDE.md | S |
| BACKLOG-1 | Frontend polling rate limits | CLAUDE.md | S |
| BACKLOG-82 | Customer purchase intelligence — purchase cycle baseline, RFM scoring, "due to reorder" dashboard | WORK-ITEMS | L |
| BACKLOG-84 | Vendor performance scoring — fill rate, timeliness, price stability, credit notes | WORK-ITEMS | M |
| BACKLOG-85 | Market basket analysis — product affinities for shelf placement and bundle suggestions | WORK-ITEMS | L |
| BACKLOG-95 | Multi-location expiry/count scoping — tables lack `location_id`, pre-franchise | Session 2026-03-23 | L |
| BACKLOG-110 | Webhook-triggered PO receive prompt — flag open POs when inventory increases for items on order | WORK-ITEMS | M |
| BACKLOG-107 | Reorder suggestions system audit — 810-line service, silent exclusion bugs found. Map files, trace SQL+JS filters, document all return-null paths, module breakdown map, security check, test gaps. Output `docs/REORDER-AUDIT.md` | Session 2026-03-31 | S |
| BACKLOG-108 | Stale draft PO warning on reorder page — old DRAFT POs silently suppress items. New `GET /api/purchase-orders/stale-drafts` + red banner + consider "Pending PO" badge | Session 2026-03-31 | M |
| BACKLOG-109 | Merchant-configurable auto min/max settings — all thresholds hardcoded. New `merchant_min_max_settings` table, `GET/PUT /api/min-max/settings`, `reorder_intelligence` feature gate for auto-apply | Session 2026-03-31 | M |
| BACKLOG-104 | GMC product schema audit — compare `buildGmcProduct()` against v1 spec. Known gaps: identifierExists, isBundle, shipping weight, imageLink undefined. Output `docs/GMC-SCHEMA-AUDIT.md`. Prerequisite for BACKLOG-61 | Session 2026-03-31 | S |
| CSS-5 | CSS shared components — extract stats-bar, tabs, empty-state, loading/spinner, controls from all inline styles into `shared.css`. ~12–22 pages per component | Session 2026-03-31 | M |

### Data Integrity

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-64 | Audit Square `sold_out` flag vs inventory = 0 | CLAUDE.md | M |
| BACKLOG-65 | Sync Square Online Store category assignments | CLAUDE.md | M |

---

## LOW Priority

### Features

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-8 | Vendor API sync gaps — `contact_name`/`contact_phone` synced but not displayed in vendor dashboard (trivial fix). `account_number` and `address` not synced (needed for branded POs, BACKLOG-44). Only first contact synced, additional contacts dropped. Square vendor `note` not synced (local `notes` field exists separately). | CLAUDE.md | S (display fix) / M (full sync) |
| BACKLOG-43 | Min/Max stock per item per location | CLAUDE.md | S |
| BACKLOG-99 | PO inventory push — push received quantities to Square inventory on PO receive | Session 2026-03-25 | M |

### Code Quality

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-34 | Doc: Square reuses variation IDs on POS reorder | CLAUDE.md | S |
| BACKLOG-40 | exceljs pulls deprecated transitive deps | CLAUDE.md | S |

---

## Effort Key

| Code | Meaning |
|------|---------|
| S | Small — < 1 file change or < 2 hours |
| M | Medium — 2-5 files or half a day |
| L | Large — 6+ files or multi-day effort |
