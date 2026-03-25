# Catalog Attribute Coverage Audit — BACKLOG-76

**Date:** 2026-03-25
**Scope:** Square `CatalogItem` and `CatalogItemVariation` objects vs. local DB schema
**Sources reviewed:**
- `database/schema.sql` (full table definitions + applied migrations)
- `utils/schema-manager.js` (runtime migration additions: `is_archived`, `archived_at`)
- `services/square/square-catalog-sync.js` (`syncItem`, `syncVariation`)
- `services/vendor/catalog-create-service.js` (`createSquareBatch`)

---

## Summary

| Category | Items fields | Variation fields |
|----------|-------------|-----------------|
| Fully stored | 16 | 17 |
| Stored but incomplete | 4 | 5 |
| Not stored — useful for BACKLOG-75 | 4 | 3 |
| Not stored — not needed | 3 | 7 |

---

## Part 1 — CatalogItem (item_data) Fields

### Top-Level CatalogObject Fields (for ITEM type)

| Field | Square Type | Local Column | Stored? | Notes |
|-------|-------------|--------------|---------|-------|
| `id` | string | `items.id` | ✅ Yes | |
| `type` | enum | — | — | Always `ITEM`, implied |
| `updated_at` | RFC3339 | `items.updated_at` | ⚠️ Partial | We write `CURRENT_TIMESTAMP`, not Square's timestamp |
| `version` | int64 | — | ❌ No | Square catalog version number |
| `is_deleted` | boolean | `items.is_deleted` | ✅ Yes | Inferred from absence during full sync or `is_deleted: true` in delta sync |
| `present_at_all_locations` | boolean | `items.present_at_all_locations` | ✅ Yes | |
| `present_at_location_ids` | string[] | `items.present_at_location_ids` | ✅ Yes | JSONB |
| `absent_at_location_ids` | string[] | `items.absent_at_location_ids` | ✅ Yes | JSONB |
| `custom_attribute_values` | map | `item_brands` (partial) | ⚠️ Partial | Only `brand` key extracted; no general `custom_attributes` JSONB column on items |

### item_data Fields

| Field | Square Type | Local Column | Stored? | Notes |
|-------|-------------|--------------|---------|-------|
| `name` | string | `items.name` | ✅ Yes | |
| `description` | string | `items.description` | ✅ Yes | Plaintext |
| `description_html` | string | — | ❌ No | Rich-text HTML version. Distinct field in Square API — not same as description |
| `abbreviation` | string | — | ❌ No | Short name shown on receipts/POS |
| `label_color` | string | — | ❌ No | Color label for Square POS (hex string) |
| `available_online` | boolean | `items.available_online` | ⚠️ Partial | Derived from `ecom_visibility === 'VISIBLE'`, not read directly from this field |
| `available_for_pickup` | boolean | `items.available_for_pickup` | ❌ No | Hardcoded `FALSE` in `syncItem` — Square value never read |
| `available_electronically` | boolean | — | ❌ No | For delivery/ghost kitchen integrations |
| `category_id` *(deprecated)* | string | `items.category_id` | ✅ Yes | Handled as fallback |
| `categories` | CategoryPathID[] | `items.category_id` | ⚠️ Partial | Only first/primary category stored; multi-category not supported |
| `reporting_category` | CatalogObjectCategory | `items.category_id` | ⚠️ Partial | Used as last-resort fallback for category_id only |
| `tax_ids` | string[] | `items.tax_ids` | ✅ Yes | JSONB array |
| `modifier_list_info` | CatalogItemModifierListInfo[] | `items.modifier_list_info` | ✅ Yes | Full JSONB blob |
| `variations` | CatalogObject[] | `variations` table | ✅ Yes | Stored separately, fully modelled |
| `product_type` | ProductType enum | `items.product_type` | ✅ Yes | |
| `skip_modifier_screen` | boolean | — | ❌ No | POS-only UX setting, no operational value |
| `item_options` | CatalogItemOptionForItem[] | `items.item_options` | ✅ Yes | JSONB |
| `image_ids` | string[] | `items.images` | ✅ Yes | JSONB array of image IDs |
| `sort_name` | string | — | ❌ No | Alternative sort name (e.g., romaji for Japanese items) |
| `channels` | string[] | — | ❌ No | Channel IDs where item is available |
| `is_archived` | boolean | `items.is_archived` | ✅ Yes | Added via `schema-manager.js` runtime migration |
| `ecom_seo_data.page_title` | string | `items.seo_title` | ✅ Yes | |
| `ecom_seo_data.page_description` | string | `items.seo_description` | ✅ Yes | |
| `ecom_visibility` | enum | `items.visibility` | ✅ Yes | Mapped: `VISIBLE`→`PUBLIC`, `HIDDEN`→`HIDDEN`, else→`PRIVATE` |

---

## Part 2 — CatalogItemVariation (item_variation_data) Fields

### Top-Level CatalogObject Fields (for ITEM_VARIATION type)

| Field | Square Type | Local Column | Stored? | Notes |
|-------|-------------|--------------|---------|-------|
| `id` | string | `variations.id` | ✅ Yes | |
| `updated_at` | RFC3339 | `variations.updated_at` | ⚠️ Partial | Own timestamp, not Square's |
| `version` | int64 | — | ❌ No | |
| `is_deleted` | boolean | `variations.is_deleted` | ✅ Yes | |
| `present_at_all_locations` | boolean | `variations.present_at_all_locations` | ✅ Yes | |
| `present_at_location_ids` | string[] | `variations.present_at_location_ids` | ✅ Yes | JSONB |
| `absent_at_location_ids` | string[] | `variations.absent_at_location_ids` | ✅ Yes | JSONB |
| `custom_attribute_values` | map | `variations.custom_attributes` | ✅ Yes | Full JSONB; also individually parsed for `case_pack_quantity`, expiry fields → `variation_expiration` |

### item_variation_data Fields

| Field | Square Type | Local Column | Stored? | Notes |
|-------|-------------|--------------|---------|-------|
| `item_id` | string | `variations.item_id` | ✅ Yes | |
| `name` | string | `variations.name` | ✅ Yes | |
| `sku` | string | `variations.sku` | ✅ Yes | |
| `upc` | string | `variations.upc` | ✅ Yes | |
| `ordinal` | integer | — | ❌ No | Sort order within parent item |
| `pricing_type` | enum | `variations.pricing_type` | ✅ Yes | |
| `price_money` | Money | `variations.price_money` + `variations.currency` | ✅ Yes | Amount in cents |
| `location_overrides` | ItemVariationLocationOverrides[] | `variation_location_settings` | ⚠️ Partial | See table below |
| `track_inventory` | boolean | `variations.track_inventory` | ✅ Yes | |
| `inventory_alert_type` | enum | `variations.inventory_alert_type` | ✅ Yes | Global value; per-location extracted from `location_overrides` |
| `inventory_alert_threshold` | integer | `variations.inventory_alert_threshold` | ✅ Yes | |
| `image_ids` | string[] | `variations.images` | ✅ Yes | JSONB |
| `team_member_ids` | string[] | — | ❌ No | Service item staff assignments |
| `item_option_values` | CatalogItemOptionValue[] | `variations.item_option_values` | ✅ Yes | JSONB |
| `measurement_unit_id` | string | — | ❌ No | Unit of measure reference (e.g., kg, lb) |
| `tax_ids` | string[] | — | ❌ No | Variation-level tax overrides (different from item-level `tax_ids`) |
| `service_duration` | int64 | — | ❌ No | Duration in ms for service/appointment items |
| `available_for_booking` | boolean | — | ❌ No | Appointment booking |
| `sellable` | boolean | — | ❌ No | Whether variation can be sold |
| `stockable` | boolean | — | ❌ No | Whether variation has stockable inventory |
| `stockable_conversion` | CatalogStockConversion | — | ❌ No | Conversion factor for non-stockable sellable items |
| `vendor_information` | CatalogItemVariationVendorInfo[] | `variation_vendors` | ⚠️ Partial | See table below |

### location_overrides sub-fields (stored in `variation_location_settings`)

| Field | Local Column | Stored? | Notes |
|-------|-------------|---------|-------|
| `location_id` | `variation_location_settings.location_id` | ✅ Yes | |
| `pricing_type` | — | ❌ No | Per-location pricing type |
| `price_money` | — | ❌ No | Per-location price override |
| `track_inventory` | — | ❌ No | Per-location tracking override |
| `inventory_alert_type` | `variation_location_settings.stock_alert_min` | ⚠️ Partial | Type not stored; threshold stored as `stock_alert_min` |
| `inventory_alert_threshold` | `variation_location_settings.stock_alert_min` | ✅ Yes | |
| `sold_out` | — | ❌ No | BACKLOG-64 — square `sold_out` flag not tracked |
| `override_location_overrides` | — | ❌ No | Nested override metadata |

### vendor_information sub-fields (stored in `variation_vendors`)

| Field | Local Column | Stored? | Notes |
|-------|-------------|---------|-------|
| `vendor_id` | `variation_vendors.vendor_id` | ✅ Yes | |
| `catalog_v2_id` | — | ❌ No | Square's internal variation catalog ID (same as variation id) |
| `sku` | `variation_vendors.vendor_code` | ✅ Yes | Mapped to `vendor_code` |
| `unit_cost_money` | `variation_vendors.unit_cost_money` | ✅ Yes | Amount in cents |
| `name` | — | ❌ No | Vendor-assigned product name |
| `ordinal` | — | ❌ No | Preferred vendor ordering |

---

## Part 3 — Grouped Summary

### ✅ Stored — Core Fields Working Well

**Items:** `id`, `name`, `description`, `category_id`, `tax_ids`, `modifier_list_info`, `item_options`, `image_ids`, `product_type`, `tax_ids`, `visibility`, `seo_title`, `seo_description`, `is_archived`, `is_deleted`, `present_at_*_location_ids`

**Variations:** `id`, `item_id`, `name`, `sku`, `upc`, `price_money`, `pricing_type`, `track_inventory`, `inventory_alert_type/threshold`, `item_option_values`, `custom_attributes` (JSONB blob), `image_ids`, `is_deleted`, `present_at_*_location_ids`; vendor info → `variation_vendors`; expiry data → `variation_expiration`

---

### ⚠️ Stored But Incomplete

| Field | What's Missing |
|-------|---------------|
| `items.available_online` | Derived from `ecom_visibility` instead of reading the field directly. The two can diverge if Square adds new channel logic |
| `items.available_for_pickup` | Always written as `FALSE` — Square value is never read; actual pickup availability is lost |
| `items.categories` (multi-category) | Only `categories[0]` stored; Square supports multiple categories per item |
| `items.custom_attribute_values` | Only `brand` key is extracted into `item_brands`; all other item-level custom attributes are silently dropped (no general JSONB column on `items`) |
| `location_overrides.inventory_alert_type` | Type enum not stored; only threshold stored as `stock_alert_min` |
| `variations.vendor_information` — `name`, `ordinal` | Vendor display name and preferred-vendor ordering not stored |
| `items.updated_at` / `variations.updated_at` | We write our own timestamp; Square's authoritative `updated_at` is discarded — breaks delta sync confidence and idempotency checks |

---

### ❌ Not Stored — Relevant to BACKLOG-75 (Item Restore)

These are fields that would be **needed to fully recreate a deleted item** in Square:

| Field | Why It Matters |
|-------|---------------|
| `item_data.description_html` | Square stores HTML and plaintext separately. If item was created with rich text, restore would use plaintext only — visible formatting degradation |
| `item_data.abbreviation` | Shown on receipts and POS display; customer-visible field that would be blank after restore |
| `item_data.available_for_pickup` | Since we hardcode `FALSE` on sync, we don't know the real value. Items that had pickup enabled would be restored with it off |
| `item_data.channels` | Channel availability (Square Online, Appointments, etc.) would not be restored |
| `item_variation_data.ordinal` | Variation display order within an item would be reset on restore; affects POS UX |
| `location_overrides.price_money` | Per-location pricing not stored. Restore would apply global price to all locations even if they had different prices |
| `location_overrides.sold_out` | Restore would not know which locations had items marked as sold out (BACKLOG-64) |
| `item_variation_data.tax_ids` | Variation-level tax overrides (distinct from item-level `tax_ids`) not captured — tax settings may be wrong after restore |

---

### ❌ Not Stored — Not Needed for This System

| Field | Reason |
|-------|--------|
| `version` (CatalogObject) | Only needed for optimistic concurrency in writes; we don't do concurrent writes via API |
| `item_data.skip_modifier_screen` | POS-only UI setting; no operational or reporting value |
| `item_data.sort_name` | Alternate sort string for non-Latin scripts; not applicable to JTPets |
| `item_data.available_electronically` | Delivery service integration not in scope |
| `item_variation_data.team_member_ids` | Service item staff assignment; not applicable |
| `item_variation_data.service_duration` | Service/appointment item field; not applicable |
| `item_variation_data.available_for_booking` | Appointment booking; not applicable |
| `item_variation_data.sellable` / `stockable` | Boolean flags; useful for edge cases but no current feature depends on them |
| `item_variation_data.stockable_conversion` | Non-stockable sellable conversion; not applicable |
| `item_variation_data.measurement_unit_id` | Unit of measure; not currently used in any feature |

---

## Part 4 — What catalog-create-service.js Sends to Square

When creating items from vendor catalog (`bulkCreateSquareItems`), we send a **minimal subset**:

| Field Sent | Value |
|-----------|-------|
| `type` | `ITEM` |
| `item_data.name` | `entry.product_name` |
| `item_data.tax_ids` | All active merchant taxes (fetched) |
| `item_data.variations[0].name` | `'Regular'` (hardcoded) |
| `item_data.variations[0].pricing_type` | `FIXED_PRICING` |
| `item_data.variations[0].price_money` | `entry.price_cents` |
| `item_data.variations[0].upc` | `entry.upc` (if available) |
| `item_data.variations[0].sku` | `entry.upc` (same as UPC) |
| `item_data.variations[0].vendor_information` | `[{vendor_id, unit_cost_money}]` (if vendor) |
| `present_at_all_locations` | `true` (hardcoded) |

**Not sent on create (fields that would need to be restored for BACKLOG-75):**
- `description` / `description_html`
- `category` assignment
- `modifier_list_info`
- `item_options`
- `ecom_visibility` / SEO data
- `available_for_pickup`
- `channels`
- `abbreviation` / `label_color`
- Variation `ordinal`
- Per-location pricing or sold_out flags

---

## Part 5 — BACKLOG-75 Impact Assessment

**What we can restore (data is available):**
- Item name, description (plaintext), category, tax IDs
- Modifier list associations (JSONB blob stored)
- Item options and item_option_values
- SEO title + description
- ecom_visibility / available_online
- Variation name, SKU, UPC, price, pricing_type
- Vendor associations (vendor_id, vendor_code, unit_cost)
- Custom attributes (stored as JSONB blob on variations)
- Track inventory flag, alert type/threshold

**What we would lose on restore (data not captured):**
1. `description_html` — rich text formatting stripped to plaintext
2. `abbreviation` — receipt/POS short name blank
3. `available_for_pickup` — always restored as `false`
4. `channels` — channel assignments reset to Square defaults
5. Variation `ordinal` — display order reset to insertion order
6. Per-location price overrides — global price applied everywhere
7. Per-location `sold_out` state — all locations restored as not sold out
8. Variation-level `tax_ids` — item-level taxes applied, variation overrides lost
9. Item-level custom attributes (non-brand) — silently dropped during sync

**Highest-value gaps to close for a complete restore:**
1. Store Square's `updated_at` in both tables (enables safe idempotent upsert)
2. Add `description_html TEXT` to `items`
3. Add `abbreviation TEXT` to `items`
4. Fix `available_for_pickup` — read from Square instead of hardcoding `false`
5. Store `ordinal INTEGER` on `variations`
6. Add `custom_attributes JSONB` to `items` (mirrors what `variations` already has)
7. Store `tax_ids JSONB` on `variations` for variation-level tax override

---

*Generated for BACKLOG-76. No code changes made.*
