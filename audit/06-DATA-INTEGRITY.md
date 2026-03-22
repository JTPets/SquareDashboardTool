# Section 6: DATA INTEGRITY

**Rating: PASS**

**Auditor note**: Money is stored as integer cents in the database and through the application. All multi-step mutations use `db.transaction()`. Foreign key constraints are DB-enforced with appropriate `ON DELETE` behaviors. Merchant delete is handled safely.

---

## 6.1 Money / Decimal Handling

**Rating: PASS**

### Storage: Integer Cents

All money columns in `database/schema.sql` use `INTEGER` for cent-based storage:

| Column | Type | Example Tables |
|--------|------|---------------|
| `price_money` | INTEGER | variations |
| `last_cost_cents` | INTEGER | variations |
| `unit_cost_money` | INTEGER | vendor_variation_map |
| `total_revenue_cents` | INTEGER | variation_sales |
| `subtotal_cents`, `total_cents` | INTEGER | purchase_orders |
| `unit_cost_cents`, `total_cost_cents` | INTEGER | purchase_order_items |
| `cost_cents`, `price_cents` | INTEGER | vendor_catalog_items |
| `original_price_cents`, `discounted_price_cents` | INTEGER | expiry_discounts |
| `amount_cents` | INTEGER | subscription_invoices |

**No `FLOAT`, `REAL`, or `DOUBLE PRECISION` types are used for money.** `DECIMAL` columns are limited to non-currency fields: quantities (`DECIMAL(10,2)`), averages (`DECIMAL(10,4)`), percentages (`DECIMAL(5,2)`), and GPS coordinates (`DECIMAL(10,8)`).

### Application-Level Conversion

Division by 100 for display formatting occurs in only a few controlled locations:

| File | Line | Pattern | Context |
|------|------|---------|---------|
| `routes/subscriptions.js` | 115 | `(promo.discount_value / 100).toFixed(2)` | Display string for promo amount |
| `routes/subscriptions.js` | 256 | `(discountCents/100).toFixed(2)` | Payment note string |
| `routes/purchase-orders.js` | 790 | `(item.unit_cost_cents \|\| 0) / 100` | Excel export formatting |
| `routes/cycle-counts.js` | 380 | `v.price_money / 100.0` | SQL expression for variance display |

All of these are **display-only conversions** -- the cent values are never modified and written back. No floating-point arithmetic is used for financial calculations.

### Square API Alignment

Square's API uses `Money` objects with `amount` (integer cents) and `currency`. The codebase stores `amount` directly as INTEGER, matching Square's format exactly. No conversion step exists that could introduce floating-point drift.

---

## 6.2 Transaction Boundaries

**Rating: PASS**

### Transaction Usage

`db.transaction()` is used for all multi-step database mutations:

| File | Operation | Lines |
|------|-----------|-------|
| `routes/cycle-counts.js` | Record count + update session progress | 162 |
| `routes/cycle-counts.js` | Delete all counts in session | 269 |
| `routes/cycle-counts.js` | Generate summary statistics | 440 |
| `routes/auth.js` | Create user + create user_merchants link | 335 |
| `routes/purchase-orders.js` | Create PO + insert line items | 86 |
| `routes/purchase-orders.js` | Receive PO + update inventory | 320 |
| `routes/purchase-orders.js` | Close PO + finalize quantities | 435 |
| `services/bundle-service.js` | Create bundle + variations | 352, 398 |
| `services/square/square-inventory.js` | Sync inventory + update records | 615, 718 |
| `services/square/square-vendors.js` | Upsert vendor + map to variations | 58, 330 |
| `services/vendor/catalog-create-service.js` | Create catalog items + variations | 236, 343 |

### Transaction Implementation (`utils/database.js`)

The `db.transaction()` utility:
1. Acquires a client from the pool
2. Runs `BEGIN`
3. Executes the callback with the client
4. Runs `COMMIT` on success, `ROLLBACK` on error
5. Releases the client back to the pool in `finally`

### Single-Statement Operations

Routes with single `INSERT`, `UPDATE`, or `DELETE` statements do NOT use transactions, which is correct -- PostgreSQL auto-commits single statements. Examples:
- `routes/auth.js:618` -- single DELETE for password reset tokens
- `routes/gmc.js:283` -- single DELETE for item brands

No multi-step mutations were found outside of `db.transaction()`.

---

## 6.3 Foreign Key Constraints

**Rating: PASS**

### DB-Enforced Foreign Keys

All foreign key relationships are enforced at the database level with `REFERENCES` clauses. The schema contains **81 `ON DELETE` specifications** across all tables.

### ON DELETE Behavior Distribution

| Behavior | Count | Usage Pattern |
|----------|-------|---------------|
| `CASCADE` | ~50 | Child records deleted with parent (e.g., `purchase_order_items` when PO deleted) |
| `SET NULL` | ~10 | Optional references nullified (e.g., `replacement_variation_id`, `matched_variation_id`) |
| `RESTRICT` | ~5 | Prevent parent deletion if children exist (e.g., `purchase_orders.vendor_id`) |

### merchant_id References

Every tenant-scoped table has `merchant_id INTEGER NOT NULL REFERENCES merchants(id)`. Notably, the merchant FK does **not** specify `ON DELETE CASCADE` -- deleting a merchant would fail due to RESTRICT (the default when unspecified). This is the correct behavior: merchant deletion should be an explicit, multi-step administrative operation, not a cascade that wipes all business data.

### No Missing Foreign Keys

All parent-child relationships found in queries have corresponding `REFERENCES` constraints in the schema. No app-level-only foreign keys were identified.

---

## 6.4 Orphan Record Potential

**Rating: PASS**

### Merchant Deletion

- `merchants(id)` FK uses default `RESTRICT` -- cannot delete a merchant while any child records exist
- The only merchant deletion code is in `database/migrations/archive/061_cleanup_dead_merchants.sql`, which explicitly deletes child records in order before removing merchants
- No route or service exposes merchant deletion to users

### Cascade Coverage

When a parent record IS deleted (via CASCADE), all children are properly cleaned up:

| Parent Deleted | Children Cascaded |
|---------------|-------------------|
| `items(id)` | variations, item_brands, item_images, expiry_discounts |
| `variations(id)` | inventory, vendor_variation_map, variation_sales, price_history, vendor_catalog matches |
| `locations(id)` | inventory, variation_sales, price_history |
| `vendors(id)` | vendor_variation_map, vendor_catalog_items |
| `purchase_orders(id)` | purchase_order_items |
| `categories(id)` | category_taxonomy_mapping |

### Potential Orphan Scenarios

1. **Soft deletes**: Square catalog items can be marked as deleted (`is_deleted_by_square = true`) without removing the database row. This is intentional -- historical data preservation for sales records.

2. **Webhook events**: The `webhook_events` table has no foreign key to merchants. Events are standalone audit records with `merchant_id` as a plain integer. This is acceptable for an audit log table.

---

## Summary of Findings

| Sub-section | Rating | Key Finding |
|-------------|--------|-------------|
| 6.1 Money Handling | PASS | Integer cents throughout; no floating-point currency math |
| 6.2 Transactions | PASS | All multi-step mutations wrapped in `db.transaction()` |
| 6.3 Foreign Keys | PASS | 81 DB-enforced FK constraints with appropriate ON DELETE |
| 6.4 Orphan Prevention | PASS | Merchant deletion blocked by RESTRICT; cascades cover children |
