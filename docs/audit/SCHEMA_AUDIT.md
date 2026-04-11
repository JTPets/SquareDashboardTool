# SqTools Database Schema Audit

**Audit Date:** 2026-04-10
**Schema Source:** `database/schema.sql` (2,608 lines)
**Active Migrations:** 16 (`database/migrations/`)
**Archived Migrations:** 74 (`database/migrations/archive/`)
**Database:** PostgreSQL 14+

---

## Summary

| Metric | Value |
|--------|-------|
| Total Tables | 74 |
| Square-Specific Columns | 30 distinct |
| JSON/JSONB Columns with Square Data | 40+ |
| Multi-Tenant Tables (with `merchant_id`) | 88+ references |
| Indexes | 150+ |
| Schema Manager | `utils/schema-manager.js` (`ensureSchema()` on startup) |

---

## Current Tables (All 74)

### Foundational (4 tables)

**`users`** (11 columns)
| Column | Type | Constraints |
|--------|------|-------------|
| id | SERIAL | PRIMARY KEY |
| email | VARCHAR(255) | UNIQUE, NOT NULL |
| password_hash | VARCHAR(255) | NOT NULL |
| role | VARCHAR(50) | CHECK (admin, manager, staff, viewer) |
| is_active | BOOLEAN | DEFAULT true |
| created_at | TIMESTAMPTZ | DEFAULT NOW() |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() |
| last_login | TIMESTAMPTZ | |
| password_reset_token | VARCHAR(255) | |
| password_reset_expires | TIMESTAMPTZ | |
| failed_login_attempts | INTEGER | DEFAULT 0 |

**`merchants`** (19 columns)
| Column | Type | Constraints | Square? |
|--------|------|-------------|---------|
| id | SERIAL | PRIMARY KEY | |
| business_name | VARCHAR(255) | NOT NULL | |
| **square_merchant_id** | VARCHAR(255) | UNIQUE | **YES** |
| **square_access_token** | TEXT | Encrypted (AES-256-GCM) | **YES** |
| **square_refresh_token** | TEXT | Encrypted | **YES** |
| **square_token_expires_at** | TIMESTAMPTZ | | **YES** |
| **square_token_scopes** | TEXT | | **YES** |
| is_active | BOOLEAN | DEFAULT true | |
| subscription_status | VARCHAR(50) | CHECK constraint | |
| subscription_plan_id | INTEGER | FK → subscription_plans | |
| trial_ends_at | TIMESTAMPTZ | | |
| subscription_started_at | TIMESTAMPTZ | | |
| subscription_ends_at | TIMESTAMPTZ | | |
| settings | JSONB | DEFAULT '{}' | |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | |
| platform_owner | BOOLEAN | DEFAULT false | |
| onboarding_completed | BOOLEAN | DEFAULT false | |
| timezone | VARCHAR(100) | DEFAULT 'America/Toronto' | |

**`oauth_states`** — CSRF protection for OAuth flows

**`sync_history`** (11 columns)
| Column | Type | Notes | Square? |
|--------|------|-------|---------|
| id | SERIAL | PRIMARY KEY | |
| merchant_id | INTEGER | FK → merchants | |
| sync_type | VARCHAR(50) | catalog, vendors, inventory, sales_* | |
| status | VARCHAR(20) | running, success, failed | |
| **last_delta_timestamp** | TIMESTAMPTZ | Square's `latest_time` for incremental sync | **YES** |
| **last_catalog_version** | BIGINT | Webhook deduplication | **YES** |
| items_synced | INTEGER | | |
| errors | TEXT | | |
| started_at | TIMESTAMPTZ | | |
| completed_at | TIMESTAMPTZ | | |
| duration_ms | INTEGER | | |

---

### Core Catalog (10 tables)

**`locations`**
| Column | Type | Square? |
|--------|------|---------|
| id | SERIAL | |
| merchant_id | INTEGER | FK → merchants |
| **square_location_id** | VARCHAR(255) | **YES** |
| name | VARCHAR(255) | |
| address | TEXT | |
| is_active | BOOLEAN | |
| created_at / updated_at | TIMESTAMPTZ | |

**`categories`**
| Column | Type | Square? |
|--------|------|---------|
| id | SERIAL | |
| merchant_id | INTEGER | FK → merchants |
| **catalog_object_id** | TEXT | **YES** — Square's category ID |
| name | VARCHAR(255) | |
| **square_updated_at** | TIMESTAMPTZ | **YES** |
| created_at / updated_at | TIMESTAMPTZ | |

**`items`** (26 columns)
| Column | Type | Square? |
|--------|------|---------|
| id | SERIAL | |
| merchant_id | INTEGER | FK → merchants |
| **catalog_object_id** | TEXT | **YES** — Square's item ID |
| name | VARCHAR(255) | |
| description | TEXT | |
| description_html | TEXT | |
| category_id | INTEGER | FK → categories |
| **square_updated_at** | TIMESTAMPTZ | **YES** |
| is_deleted | BOOLEAN | Soft delete |
| deleted_at | TIMESTAMPTZ | |
| seo_title | VARCHAR(255) | |
| seo_description | TEXT | |
| **tax_ids** | JSONB | **YES** — Square tax IDs |
| **present_at_location_ids** | JSONB | **YES** — Square location IDs |
| **absent_at_location_ids** | JSONB | **YES** — Square location IDs |
| **modifier_list_info** | JSONB | **YES** — Square modifier data |
| **item_options** | JSONB | **YES** — Square item options |
| **images** | JSONB | **YES** — Square image refs |
| **custom_attributes** | JSONB | **YES** — Square custom attrs |
| created_at / updated_at | TIMESTAMPTZ | |

**`variations`** (27 columns)
| Column | Type | Square? |
|--------|------|---------|
| id | SERIAL | |
| merchant_id | INTEGER | FK → merchants |
| item_id | INTEGER | FK → items |
| **catalog_object_id** | TEXT | **YES** — Square variation ID |
| name | VARCHAR(255) | |
| sku | VARCHAR(100) | |
| price | BIGINT | In cents |
| cost | BIGINT | |
| **square_updated_at** | TIMESTAMPTZ | **YES** |
| is_deleted | BOOLEAN | |
| deleted_at | TIMESTAMPTZ | |
| upc | VARCHAR(100) | |
| case_pack | INTEGER | |
| min_stock | INTEGER | |
| max_stock | INTEGER | |
| brand | VARCHAR(255) | |
| does_not_expire | BOOLEAN | |
| **present_at_location_ids** | JSONB | **YES** |
| **absent_at_location_ids** | JSONB | **YES** |
| **item_option_values** | JSONB | **YES** |
| **custom_attributes** | JSONB | **YES** |
| **images** | JSONB | **YES** |
| **tax_ids** | JSONB | **YES** |
| pin_min_stock | BOOLEAN | |
| pin_max_stock | BOOLEAN | |
| created_at / updated_at | TIMESTAMPTZ | |

**`images`**
| Column | Type | Square? |
|--------|------|---------|
| id | SERIAL | |
| merchant_id | INTEGER | |
| **catalog_object_id** | TEXT | **YES** |
| name | VARCHAR(255) | |
| url | TEXT | |
| **square_updated_at** | TIMESTAMPTZ | **YES** |

**`variation_vendors`** — Links variations to vendors (merchant_id, variation_id, vendor_id, vendor_code, vendor_cost)

**`inventory_counts`**
| Column | Type | Square? |
|--------|------|---------|
| id | SERIAL | |
| merchant_id | INTEGER | |
| **catalog_object_id** | TEXT | **YES** — Square variation ID |
| location_id | INTEGER | FK → locations |
| quantity | NUMERIC | |
| **square_updated_at** | TIMESTAMPTZ | **YES** |

**`committed_inventory`**
| Column | Type | Square? |
|--------|------|---------|
| id | SERIAL | |
| merchant_id | INTEGER | |
| variation_id | INTEGER | FK → variations |
| location_id | INTEGER | FK → locations |
| **square_invoice_id** | TEXT | **YES** |
| quantity_committed | NUMERIC | |
| invoice_status | VARCHAR(50) | |
| vendor_name | VARCHAR(255) | |
| expected_arrival | DATE | |
| created_at / updated_at | TIMESTAMPTZ | |

**`sales_velocity`** — Per-variation, per-location, per-period sales rate tracking
- `catalog_object_id` (TEXT) — **Square-specific**
- Multiple period columns: `period_91d`, `period_182d`, `period_365d`

**`variation_location_settings`** — Per-variation, per-location overrides (min_stock, max_stock, etc.)

---

### Inventory Management (9 tables)

| Table | Key Columns | Square Refs |
|-------|-------------|-------------|
| `vendors` | id, merchant_id, name, square_vendor_id | **square_vendor_id** |
| `purchase_orders` | id, merchant_id, vendor_id, status | None |
| `purchase_order_items` | id, purchase_order_id, variation_id, qty | None |
| `count_history` | id, merchant_id, variation_id, counted_qty | None |
| `count_queue_priority` | merchant_id, variation_id, priority_score | None |
| `count_queue_daily` | merchant_id, variation_id, batch_date | None |
| `count_sessions` | id, merchant_id, status, counts | None |
| `min_stock_audit` | id, merchant_id, variation_id, old/new values | None |
| `min_max_audit_log` | id, merchant_id, changes, reason | None |

---

### Reorder & Bundling (4 tables)

| Table | Square Refs |
|-------|-------------|
| `bundle_definitions` | None |
| `bundle_components` | None |
| `vendor_catalog_items` | None |
| `vendor_match_suggestions` | None |

---

### Expiry Discount System (4 tables)

| Table | Square Refs |
|-------|-------------|
| `variation_expiration` | None |
| `expiry_discount_tiers` | None |
| `variation_discount_status` | **square_synced_at**, **square_sync_status**, **square_sync_pending**, **square_error_message** |
| `expiry_discount_audit_log` | None |

---

### Delivery Module (6 tables)

**`delivery_orders`** (15 columns)
| Column | Type | Square? |
|--------|------|---------|
| id | UUID | PRIMARY KEY |
| merchant_id | INTEGER | |
| **square_order_id** | TEXT | **YES** |
| **square_customer_id** | TEXT | **YES** |
| **square_order_state** | VARCHAR(50) | **YES** — DRAFT/OPEN/COMPLETED/CANCELED |
| **square_order_data** | JSONB | **YES** — Full order payload |
| customer_name | VARCHAR(255) | |
| delivery_address | TEXT | |
| status | VARCHAR(50) | |
| assigned_driver_id | INTEGER | |
| route_id | UUID | |
| created_at / updated_at | TIMESTAMPTZ | |

Other delivery tables: `delivery_settings`, `delivery_pod`, `delivery_routes`, `delivery_route_tokens`, `delivery_audit_log`

---

### Loyalty Program (11 tables)

| Table | Square-Specific Columns |
|-------|------------------------|
| `loyalty_offers` | None |
| `loyalty_qualifying_variations` | None |
| `loyalty_purchase_events` (19 cols) | **square_order_id**, **square_customer_id** |
| `loyalty_rewards` (28 cols, state machine) | **square_reward_tier_id**, **square_reward_id**, **square_group_id**, **square_discount_id**, **square_product_set_id**, **square_pricing_rule_id**, **square_pos_synced_at**, **square_sync_status** |
| `loyalty_redemptions` | **square_order_id** |
| `loyalty_customers` (cache) | **square_customer_id** |
| `loyalty_customer_summary` | **square_customer_id** |
| `loyalty_processed_orders` | **square_order_id** |
| `loyalty_audit_log` / `loyalty_audit_logs` | Details in JSONB |
| `loyalty_settings` | None |

---

### Seniors Discount (3 tables)

| Table | Square Refs |
|-------|-------------|
| `seniors_discount_config` | **square_group_id**, **square_discount_id** |
| `seniors_group_members` | **square_customer_id** |
| `seniors_discount_audit_log` | None |

---

### Google Merchant Center (6 tables)

| Table | Square Refs |
|-------|-------------|
| `brands` | None |
| `google_taxonomy` | None |
| `category_taxonomy_mapping` | None |
| `item_brands` | None |
| `gmc_settings` | None |
| `gmc_feed_history` | None |

---

### Subscriptions & Billing (7 tables)

| Table | Square Refs |
|-------|-------------|
| `subscription_plans` | None |
| `subscribers` | **square_subscription_id**, **square_customer_id** |
| `subscription_payments` | **square_payment_id** |
| `subscription_events` | None |
| `promo_codes` | None |
| `promo_code_uses` | None |
| `module_pricing` | None |

---

### Platform & Config (8 tables)

| Table | Square Refs |
|-------|-------------|
| `platform_settings` | None |
| `merchant_settings` | None |
| `merchant_features` | None |
| `webhook_events` | **square_event_id**, event_data (JSONB) |
| `cart_activity` | **square_order_id**, **square_customer_id**, items_json (JSONB) |
| `label_templates` | None |
| `catalog_location_health` | None |
| `user_merchants` | None (join table: user_id ↔ merchant_id) |
| `staff_invitations` | None |

---

## Square-Specific Columns — Complete Inventory (30)

### Authentication & OAuth (5 columns)
| Column | Table | Type |
|--------|-------|------|
| `square_merchant_id` | merchants | VARCHAR(255) UNIQUE |
| `square_access_token` | merchants | TEXT (AES-256-GCM encrypted) |
| `square_refresh_token` | merchants | TEXT (encrypted) |
| `square_token_expires_at` | merchants | TIMESTAMPTZ |
| `square_token_scopes` | merchants | TEXT |

### Entity IDs (6 columns, used across many tables)
| Column | Tables Using It |
|--------|----------------|
| `catalog_object_id` | items, variations, categories, images, inventory_counts, sales_velocity |
| `square_location_id` | locations |
| `square_order_id` | delivery_orders, loyalty_purchase_events, loyalty_redemptions, loyalty_processed_orders, cart_activity |
| `square_customer_id` | delivery_orders, loyalty_purchase_events, loyalty_customers, loyalty_customer_summary, seniors_group_members, subscribers, cart_activity |
| `square_invoice_id` | committed_inventory |
| `square_vendor_id` | vendors |

### Sync & Tracking (4 columns)
| Column | Tables | Purpose |
|--------|--------|---------|
| `square_updated_at` | items, variations, categories, images, inventory_counts | Square's authoritative timestamp |
| `last_delta_timestamp` | sync_history | Incremental catalog sync cursor |
| `last_catalog_version` | sync_history | Webhook deduplication |
| `square_synced_at` | variation_discount_status | Sync completion time |

### Loyalty Integration (6 columns)
| Column | Table |
|--------|-------|
| `square_reward_tier_id` | loyalty_rewards |
| `square_reward_id` | loyalty_rewards |
| `square_group_id` | loyalty_rewards, seniors_discount_config |
| `square_discount_id` | loyalty_rewards, seniors_discount_config |
| `square_product_set_id` | loyalty_rewards |
| `square_pricing_rule_id` | loyalty_rewards |

### Subscription & Payment (3 columns)
| Column | Table |
|--------|-------|
| `square_plan_id` | subscription_plans |
| `square_payment_id` | subscription_payments |
| `square_subscription_id` | subscribers |

### Status & Sync Flags (4 columns)
| Column | Tables |
|--------|--------|
| `square_pos_synced_at` | loyalty_rewards |
| `square_sync_status` | loyalty_rewards, variation_discount_status |
| `square_sync_pending` | variation_discount_status |
| `square_error_message` | variation_discount_status |

### Delivery (2 columns)
| Column | Table |
|--------|-------|
| `square_order_state` | delivery_orders |
| `square_order_data` | delivery_orders (JSONB — full order payload) |

---

## Existing External Reference Patterns

- **No `external_refs` table or column exists** — IDs are stored as direct `square_*` columns
- **No multi-POS support** — All external references assume Square as the only POS
- **ID strategy**: Square catalog IDs stored as `TEXT` in `catalog_object_id` columns
- **Multi-tenant isolation**: All tables use `merchant_id` FK — ready for multi-POS per tenant

---

## JSON/JSONB Columns Storing Square Metadata (40+)

### High-Impact JSONB Columns
| Table | Column | Contents |
|-------|--------|----------|
| items | `tax_ids` | Square tax reference IDs |
| items | `present_at_location_ids` | Square location IDs array |
| items | `absent_at_location_ids` | Square location IDs array |
| items | `modifier_list_info` | Square modifier configurations |
| items | `item_options` | Square item option definitions |
| items | `images` | Square image object references |
| items | `custom_attributes` | Square custom attribute key-value pairs |
| variations | `present_at_location_ids` | Square location IDs array |
| variations | `absent_at_location_ids` | Square location IDs array |
| variations | `item_option_values` | Square option value selections |
| variations | `custom_attributes` | Square custom attributes |
| variations | `images` | Square image references |
| variations | `tax_ids` | Square tax IDs |
| delivery_orders | `square_order_data` | Complete Square order JSON payload |
| webhook_events | `event_data` | Raw Square webhook payloads |
| webhook_events | `sync_results` | Processing results |
| merchants | `settings` | Merchant configuration |
| cart_activity | `items_json` | Order line item details |
| delivery_routes | `route_geometry` | Route path data |

---

## Migration History

### Active Migrations (16 files in `database/migrations/`)
Recent fixes and features: timestamp corrections, index additions, health checks, promo pricing, vendor dedup, stock pinning.

### Archived Migrations (74 files in `database/migrations/archive/`)
Historical migrations covering the full evolution: soft deletes, expiration tracking, cycle counts, SEO/tax fields, vendor catalogs, GMC, expiry discounts, delivery, loyalty, bundles, seniors discounts, cart activity, labels, catalog health, merchant features.

### Schema Versioning
- No explicit version column — managed via `schema-manager.js` (`ensureSchema()`)
- `sync_history` table tracks sync state per type (catalog, vendors, inventory, sales_*)
- `last_delta_timestamp` provides incremental sync cursor for Square catalog
- `last_catalog_version` prevents duplicate webhook processing

---

## Index Strategy (150+)

| Category | Pattern | Example |
|----------|---------|---------|
| Tenant isolation | `idx_{table}_merchant(merchant_id)` | `idx_items_merchant` |
| Compound lookup | `idx_{table}_merchant_{field}(merchant_id, field)` | `idx_variations_merchant_sku` |
| Square integration | `idx_{table}_{square_field}` | `idx_inventory_variation_location(catalog_object_id, location_id)` |
| State tracking | Partial indexes | `WHERE status = 'pending'` |
| Time-based | DESC on `created_at` | For recent data queries |
| Uniqueness | UNIQUE compound | `(merchant_id, variation_id)` in variation_vendors |

---

## Key Constraints

- **CHECK**: Status fields (subscription_status, order_state, sync_status), user roles
- **UNIQUE**: (merchant_id, code) for promo codes; (merchant_id, square_merchant_id) on merchants
- **ON DELETE CASCADE**: Most child tables cascade from parent
- **ON DELETE RESTRICT**: Critical relationships (merchants → users)
- **Triggers**: Loyalty state machine enforcement, `updated_at` auto-update
