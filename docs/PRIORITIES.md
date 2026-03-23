# Active Priorities

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Roadmap](./ROADMAP.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-03-23

---

## HIGH Priority

### Business

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-61 | GMC v1beta → v1 migration — Google Merchant API v1beta discontinued Feb 28 2026. All product upserts failing with 409. Live store affected — organic Google Shopping visibility broken. **P0.** | Error logs 2026-03-09 | M |
| BACKLOG-50 | Post-trial conversion — $1 first month. Capture payment method, prove intent. Decide Stripe vs Square for SaaS billing | CLAUDE.md | L |
| BACKLOG-39 | Vendor bill-back tracking — track promotional discounts funded by vendors. Need `vendor_billbacks` table, reporting view for claim submission | CLAUDE.md | L |
| BACKLOG-80 | Email alerts not visible — system sends from/to same email. Set up Cloudflare Email Routing + transactional sender | WORK-ITEMS | S |
| BACKLOG-81 | Margin erosion alerts — alert when item margin drops due to cost/price changes | WORK-ITEMS | M |

---

## MEDIUM Priority

### Features

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-38 | Timed discount automation — apply/remove Square discount objects on cron schedule | CLAUDE.md | L |
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
| BACKLOG-8 | Vendor management — pull vendor data from Square Vendors API | CLAUDE.md | M |
| BACKLOG-29 | Existing tenants missing `invoice.payment_made` webhook | CLAUDE.md | S |
| BACKLOG-12 | Driver share link validation failure | CLAUDE.md | S |
| BACKLOG-43 | Min/Max stock per item per location | CLAUDE.md | S |

### Code Quality

| ID | Description | Source | Effort |
|----|-------------|--------|--------|
| BACKLOG-34 | Doc: Square reuses variation IDs on POS reorder | CLAUDE.md | S |
| BACKLOG-40 | exceljs pulls deprecated transitive deps | CLAUDE.md | S |
| BACKLOG-97 | Vendor bulk create missing `vendor_code` — no `variation_vendors` link on import | Session 2026-03-23 | S |
| BACKLOG-98 | Oversized toast on PO edit — reorder page confirmation toast too large | Session 2026-03-23 | S |

---

## Effort Key

| Code | Meaning |
|------|---------|
| S | Small — < 1 file change or < 2 hours |
| M | Medium — 2-5 files or half a day |
| L | Large — 6+ files or multi-day effort |
