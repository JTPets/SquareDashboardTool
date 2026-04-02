# Domain README Plan — Batch 4

> Generated: 2026-04-02. Branch: claude/domain-readme-outlines-batch-1-p1KRN
> Covers: AI Autofill, Label, Infrastructure, Reports, Orphan Files

---

## 1. AI Autofill (`services/ai-autofill-service.js`)

**Files** (1 file, 664 lines — orphan at `services/` root)

| File | Lines |
|------|-------|
| ai-autofill-service.js | 664 |

**Tables owned:** None — reads `items`, `variations`, `images` from Catalog; writes back to `items` (description, seo_title, seo_description) via Square API

**Routes:** `routes/ai-autofill.js`

**Top 3 business rules:**
1. Three-phase sequential readiness gate: Description requires image + category (image sent to Claude for visual context); SEO Title requires description; SEO Description requires description + SEO title — phases cannot be skipped; items missing image or category are `notReady` and blocked from all generation
2. Calls Claude API (`claude-sonnet-4-20250514`) directly via `fetch` with a 30-second request timeout; no SDK wrapper — raw HTTP to `https://api.anthropic.com/v1/messages`
3. Items are grouped into five buckets (`notReady`, `needsDescription`, `needsSeoTitle`, `needsSeoDescription`, `complete`) on every readiness check; the bucket determines which generation action is offered to the user

**Dependencies on other domains:** Square (`square/api` for catalog reads and writing generated content back); Catalog (reads `items`, `variations`, `images` tables directly)

**Known issues (BACKLOG):** None found. Split suggestion in DOMAIN-MAP: `ai-client`, `prompt-builder`, `result-mapper`.

---

## 2. Label (`services/label/`)

**Files** (1 file, 282 lines)

| File | Lines |
|------|-------|
| label/zpl-generator.js | 282 |

**Tables owned:** label_templates

**Routes:** `routes/labels.js`

**Top 3 business rules:**
1. Barcode source priority: UPC first, SKU fallback — ensures staff can always scan to identify products; the resolved value is stored in the `{{barcode}}` field regardless of source
2. ZPL templates use `{{placeholder}}` substitution; ZPL injection prevented by `sanitizeZpl()` which strips `^`, `~`, and `\` (ZPL command characters) from all field values before substitution
3. Default template management is transactional: clearing the old default and setting the new one happen atomically to prevent a merchant ever having zero or two default templates simultaneously

**Dependencies on other domains:** Catalog (reads `variations` and `items` tables for label data)

**Known issues (BACKLOG):** None found in label service files.

---

## 3. Infrastructure (`services/sync-queue.js`, `services/webhook-processor.js`)

**Files** (2 files, 726 lines — both orphans at `services/` root)

| File | Lines |
|------|-------|
| webhook-processor.js | 372 |
| sync-queue.js | 354 |

**Tables owned:** None directly — `sync-queue.js` reads/writes `sync_history`; `webhook-processor.js` reads/writes `webhook_events`

**Routes:** None — called by other services

**Top 3 business rules:**
1. `SyncQueue`: double-buffer pattern — if a catalog or inventory sync arrives while one is in progress, a `pending` flag is set in-memory; after the first sync completes it checks the flag and runs a follow-up sync to catch changes that arrived during the first run; in-progress state is persisted to `sync_history` and restored on startup; stale "running" entries (> 30 min) are marked `interrupted` at startup
2. `WebhookProcessor`: two-layer idempotency guard — in-process `Map` (60s TTL) blocks the race window between receive and DB INSERT; DB check (`webhook_events.square_event_id`) is the authoritative dedup; signature verification uses HMAC-SHA256 with `crypto.timingSafeEqual` (length-checked first to prevent buffer exceptions)
3. `WebhookProcessor.resolveMerchant` maps Square's `merchant_id` → internal `merchants.id` and rejects inactive merchants at the entry point before any handler runs

**Dependencies on other domains:** `webhook-processor.js` delegates to `services/webhook-handlers` (`routeEvent`); `sync-queue.js` is used by Webhook Handlers (`sync-queue` queues catalog sync tasks from order events)

**Known issues (BACKLOG):** None found. DOMAIN-MAP notes: `sync-queue.js` → split into queue-writer/queue-processor; `webhook-processor.js` → move into `services/webhook-handlers/processor.js`; PM2 cluster mode would need Redis for cross-process webhook dedup (noted in source comment)

---

## 4. Reports (`services/reports/`)

**Files** (3 files, 2,554 lines)

| File | Lines |
|------|-------|
| loyalty-reports.js | 1,471 |
| brand-redemption-report.js | 1,064 |
| index.js | 19 |

**Tables owned:** None — read-only against Loyalty tables; no writes

**Routes:** `routes/loyalty/reports.js`

**Top 3 business rules:**
1. `loyalty-reports.js` is a first-class vendor reimbursement feature: generates human-readable vendor receipts (HTML, printable/PDF) and machine-readable audit exports (CSV with UTF-8 BOM); merchant info is fetched live from Square API at report time (Square is source of truth), with DB fallback on error
2. All customer PII in report output is privacy-masked via `utils/privacy-format.js` (`formatPrivacyName`, `formatPrivacyPhone`, `formatPrivacyEmail`) before rendering in any format; raw PII never appears in generated HTML or CSV
3. Redemption order excluded from contributing purchase history rows to avoid double-counting (BACKLOG-73); when multiple rewards are redeemed in the same order, actual totals are captured to detect items already free via another reward in the same transaction

**Dependencies on other domains:** Loyalty (reads all loyalty tables); Square (live merchant/location info via Square API at report generation time)

**Known issues (BACKLOG):**
- BACKLOG-73: Redemption order exclusion and multi-reward same-order handling — logic present in `loyalty-reports.js` at lines 432, 571, 616

---

## 5. Orphan Files — Recommended Domain Placement

From DOMAIN-MAP Table 3. No new files to create — this section guides future moves only.

| File | Current Location | Recommended Move | Reason |
|------|-----------------|-----------------|--------|
| `services/vendor-dashboard.js` | root services/ | → `services/vendor/` | Vendor stats logic; imports `reorder-math` and `merchant` settings |
| `services/bundle-service.js` | root services/ | → `services/bundles/` (create dir) | Owns `bundle_definitions` / `bundle_components`; no owning dir exists |
| `services/bundle-calculator.js` | root services/ | → `services/bundles/` | Pure calculation util consumed by `bundle-service` and `catalog/reorder-service` |
| `services/ai-autofill-service.js` | root services/ | → `services/ai-autofill/` (create dir) | Standalone feature; large enough to warrant its own directory |
| `services/sync-queue.js` | root services/ | → `services/infra/` or `services/webhook-handlers/` | Infrastructure singleton with no domain; moving to `webhook-handlers/` aligns with its primary caller |
| `services/webhook-processor.js` | root services/ | → `services/webhook-handlers/processor.js` | Already delegates to `webhook-handlers`; logically belongs there |
| `services/subscription-bridge.js` | root services/ | → `services/subscriptions/` (create dir) | Owns subscription state logic; pair with `promo-validation.js` |
| `services/promo-validation.js` | root services/ | → `services/subscriptions/` | Extracted from subscriptions route (BACKLOG-74); belongs with subscription-bridge |
| `services/platform-settings.js` | root services/ | → `services/merchant/` or `services/infra/` | Cross-merchant config — closest fit is `merchant/` since it serves merchant-context reads |

**Route-level orphans (no owning service — DB queries inline in route):**

| Route File | Tables Queried Inline | Recommended Action |
|------------|----------------------|-------------------|
| `routes/purchase-orders.js` (894 lines) | `purchase_orders`, `purchase_order_items` | Create `services/purchase-orders/` |
| `routes/square-oauth.js` (539 lines) | `oauth_states` | Move oauth state logic to `services/square/oauth-service.js` |
