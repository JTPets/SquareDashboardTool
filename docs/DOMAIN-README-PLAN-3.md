# Domain README Plan — Batch 3

> Generated: 2026-04-02. Branch: claude/domain-readme-outlines-batch-1-p1KRN
> Covers: Subscriptions, Staff, Merchant, Bundles, Cart

---

## 1. Subscriptions (`services/subscription-bridge.js`, `services/promo-validation.js`)

**Files** (2 files, 293 lines — both orphans at `services/` root)

| File | Lines |
|------|-------|
| subscription-bridge.js | 192 |
| promo-validation.js | 101 |

**Tables owned:** subscribers, subscription_plans, subscription_events, subscription_payments, promo_codes, promo_code_uses

**Routes:** `routes/subscriptions.js`

**Top 3 business rules:**
1. Two-system bridge: System B (`subscribers` table, Square billing) writes payment events; `subscription-bridge.js` propagates those into System A (`merchants.subscription_status`) for access enforcement; the two systems are linked by `subscriber.merchant_id` with email-based fallback resolution that backfills `merchant_id` on first match
2. `platform_owner` merchants are immune to suspension and cancellation — the bridge explicitly checks and no-ops for this status; `active` / `suspended` / `cancelled` are the only mutable states for regular merchants
3. Promo codes resolve merchant-own codes first, then fall back to `platform_owner`-owned codes (site-wide beta promos); three discount types: `percent`, `fixed` (cents off), `fixed_price` (flat monthly rate); `max_uses` and date window enforced at query time (BACKLOG-74: `promo-validation.js` extracted from `routes/subscriptions.js`)

**Dependencies on other domains:** Square (Square subscription API calls in `routes/subscriptions.js`)

**Known issues (BACKLOG):**
- BACKLOG-74: `promo-validation.js` extracted from route; `routes/subscriptions.js` still 870 lines — business logic not yet fully moved to a service

---

## 2. Staff (`services/staff/`)

**Files** (2 files, 306 lines)

| File | Lines |
|------|-------|
| staff-service.js | 303 |
| index.js | 3 |

**Tables owned:** staff_invitations, user_merchants, users

**Routes:** `routes/staff.js`

**Top 3 business rules:**
1. Invitation tokens: raw 32-byte crypto token sent to user via email link; only the SHA-256 hash is stored in DB — same pattern as password-reset tokens; tokens expire after 7 days
2. Duplicate guards: invite rejects if target email is already an active `user_merchants` member (409), or if an unexpired, unaccepted invite already exists (409); stale (expired or accepted) invites for the same email/merchant are deleted before inserting a new one, within a transaction
3. Accept flow is fully transactional: upserts `users` row (creates with hashed password if new, skips if existing), inserts `user_merchants` with `ON CONFLICT DO NOTHING`, marks invitation `accepted_at`; valid roles are `manager`, `clerk`, `readonly` only

**Dependencies on other domains:** None — Staff has no service-level imports from other domains

**Known issues (BACKLOG):**
- BACKLOG-41: Staff service extracted; `staff-service.js` at 303 lines — split into `invitation-service` and `user-role-service` noted in DOMAIN-MAP

---

## 3. Merchant (`services/merchant/`, `services/platform-settings.js`)

**Files** (3 files, 367 lines — `platform-settings.js` is an orphan at `services/` root)

| File | Lines |
|------|-------|
| merchant/settings-service.js | 232 |
| platform-settings.js _(orphan — root services/)_ | 97 |
| merchant/index.js | 38 |

**Tables owned:** merchants, merchant_settings, platform_settings

**Routes:** `routes/merchants.js`, `routes/settings.js`, `routes/admin.js`

**Top 3 business rules:**
1. `getMerchantSettings` merges DB row with `DEFAULT_MERCHANT_SETTINGS` — so newly added columns always have a value; if no row exists for the merchant it is auto-created with defaults; fallback chain: DB value → env var → hardcoded default
2. Update writes only whitelisted fields (`ALLOWED_SETTING_FIELDS`); any unknown key in the request payload is silently dropped — whitelist enforced in the service, not in validation middleware
3. `platform-settings.js` is a separate singleton for platform-level (cross-merchant) config; uses a 5-minute TTL in-process cache (`Map`); on DB error it returns stale cache if available rather than propagating the error (BACKLOG-9: cache lost on PM2 restart, rebuilds on first miss)

**Dependencies on other domains:** Used by almost all domains (Catalog, Vendor, Delivery, Inventory) as a read-only settings source; no upstream dependencies itself

**Known issues (BACKLOG):**
- BACKLOG-9: `platform-settings.js` in-memory cache lost on PM2 restart — read-through cache rebuilds on first miss per key; 5-minute TTL limits exposure

---

## 4. Bundles (`services/bundle-service.js`, `services/bundle-calculator.js`)

**Files** (2 files, 625 lines — both orphans at `services/` root)

| File | Lines |
|------|-------|
| bundle-service.js | 503 |
| bundle-calculator.js | 122 |

**Tables owned:** bundle_definitions, bundle_components

**Routes:** `routes/bundles.js`

**Top 3 business rules:**
1. Square has no bundle API — bundles are tracked entirely locally in `bundle_definitions` + `bundle_components`; availability is calculated by finding the minimum assemblable count across all child components at the given location
2. `bundle-calculator.js` computes three ordering options for reorder planning: `all_individual` (0 bundles), `all_bundles` (enough to cover highest-need child), and `optimized` (exhaustive search over 0…max bundle quantities to find minimum total cost); savings vs individual reported as cents and percentage
3. `listBundles` uses `json_agg` + `FILTER (WHERE bc.id IS NOT NULL)` to aggregate components in a single query; components always returned as an array (empty array when none, not null)

**Dependencies on other domains:** Catalog (`reorder-service` imports `bundle-calculator` for reorder suggestions), Vendor (bundles can be linked to a vendor via `bundle_definitions.vendor_id`)

**Known issues (BACKLOG):** None found in bundle service files. Split into `services/bundles/` noted in DOMAIN-MAP.

---

## 5. Cart (`services/cart/`)

**Files** (2 files, 485 lines)

| File | Lines |
|------|-------|
| cart/cart-activity-service.js | 475 |
| cart/index.js | 10 |

**Tables owned:** cart_activity

**Routes:** `routes/cart-activity.js`

**Top 3 business rules:**
1. Only carts with a customer identifier (Square customer ID or phone last-4) are persisted; anonymous carts are silently dropped to avoid ~70+ useless writes per hour from anonymous browsing sessions
2. PII reduction by design: full phone number is never stored — only last 4 digits; Square customer ID is stored as SHA-256 hash (`customer_id_hash`) alongside the raw ID for lookup; BigInt money amounts from Square SDK are coerced to `Number` via custom JSON replacer before storage
3. Upsert on `(merchant_id, square_order_id)` conflict — subsequent `order.updated` events for the same DRAFT order update `cart_total_cents`, `item_count`, and `items_json` in place; status transitions: `pending` → `converted` (on completed order) → `abandoned` (on cancellation or cleanup job)

**Dependencies on other domains:** Webhook Handlers (`order-cart.js` calls this service on `order.created`/`order.updated` events for DRAFT state orders)

**Known issues (BACKLOG):** None found in cart service files.
