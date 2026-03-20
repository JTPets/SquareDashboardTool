# Section 4: INJECTION & INPUT VALIDATION

**Rating: PASS**

## 4.1 SQL Injection Audit

**PASS**

### Parameterized Queries

All database queries use PostgreSQL parameterized placeholders (`$1, $2, ...`). No string concatenation of user input into SQL was found.

Dynamic SQL construction patterns found in the codebase are all safe:

#### Pattern 1: Dynamic Placeholder Lists (Safe)

Used for `IN (...)` clauses with arrays:
```javascript
// utils/image-utils.js:38-41
const placeholders = imageIds.map((_, i) => `$${i + 1}`).join(',');
const merchantParam = `$${imageIds.length + 1}`;
db.query(`SELECT ... WHERE id IN (${placeholders}) AND merchant_id = ${merchantParam}`, [...imageIds, merchantId]);
```
Placeholders are computed from array indices, not user data. Values are parameterized.

**Files using this pattern**: `utils/image-utils.js`, `services/square/square-velocity.js`, `services/loyalty-admin/variation-admin-service.js`, `routes/vendor-catalog.js`, `scripts/combined-order-backfill.js`

#### Pattern 2: Dynamic SET Clauses (Safe)

Used for partial UPDATE with whitelisted fields:
```javascript
// services/vendor-dashboard.js:450-463
const allowedFields = ['schedule_type', 'order_day', ...]; // hardcoded whitelist
for (const field of allowedFields) {
    if (settings[field] !== undefined) {
        params.push(settings[field]);
        setClauses.push(`${field} = $${params.length}`);  // field from whitelist, value parameterized
    }
}
```
Field names come from hardcoded whitelists, never from user input. Values are parameterized.

**Files using this pattern**: `services/vendor-dashboard.js:450`, `routes/auth.js:440`, `services/delivery/delivery-service.js:446`, `services/catalog/variation-service.js:234`, `services/bundle-service.js:410-447`

#### Pattern 3: Dynamic Table Names (Safe)

```javascript
// services/square/square-vendors.js:30-41
const tables = ['variation_vendors', 'vendor_catalog_items', 'purchase_orders', ...]; // hardcoded
for (const table of tables) {
    await client.query(`UPDATE ${table} SET vendor_id = $1 WHERE vendor_id = $2 AND merchant_id = $3`, ...);
}
```
Table names from hardcoded array. Not user-controllable.

#### Pattern 4: Dynamic WHERE Conditions (Safe)

```javascript
// routes/sync.js:112-113
const isGmcSync = syncType.startsWith('gmc_') || syncType === 'product_catalog';
const tableName = isGmcSync ? 'gmc_sync_history' : 'sync_history'; // binary choice, not user input
```

```javascript
// services/catalog/inventory-service.js:207-216
if (status === 'deleted') {
    statusCondition = 'v.is_deleted = TRUE AND ...';  // hardcoded SQL for whitelisted value
}
```
Conditions are hardcoded based on whitelisted input values.

#### Pattern 5: Dynamic Date Filters (Safe)

```javascript
// routes/cycle-counts.js:371-384
params.push(start_date);
dateFilter = `AND DATE(ch.last_counted_date) >= $${params.length}`;
// ...
WHERE ch.merchant_id = $1 ${dateFilter}
```
Date value is parameterized. Only the clause structure changes, never from user input.

### No SQL Injection Vulnerabilities Found

Zero instances of user-controlled data interpolated into SQL strings.

---

## 4.2 LIKE/ILIKE Wildcard Injection

**NEEDS WORK**

### Finding 4.2.1 — LIKE search terms not escaped for wildcards

**Severity: LOW**

`routes/gmc.js:523-525`:
```javascript
if (search) {
    params.push(`%${search}%`);
    query += ` WHERE name ILIKE $${params.length}`;
}
```

The `search` value is parameterized (safe from SQL injection), but `%` and `_` characters in the search term are not escaped. A user could input `%` to match everything, or craft patterns like `___` to match any 3-character string.

**Impact**: Information disclosure is minimal (taxonomy data is public), but this pattern may be copied to tenant-scoped searches.

**Fix**: Escape `%` and `_` in search terms:
```javascript
const escapedSearch = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
params.push(`%${escapedSearch}%`);
```

---

## 4.3 ORDER BY Injection

**PASS**

No user-controlled ORDER BY columns found. All ORDER BY clauses use hardcoded column names:
- `ORDER BY ch.last_counted_date DESC`
- `ORDER BY received_at DESC`
- `ORDER BY created_at DESC`
- `ORDER BY name`
- etc.

No `sort_by`, `sortBy`, `order_by`, or `orderBy` query parameters exist in any route.

---

## 4.4 Input Validation Coverage

**PASS**

28 validator files in `middleware/validators/` covering all route modules. Validators use `express-validator` with:
- Type checking (`isInt`, `isString`, `isBoolean`, `isIn`)
- Length limits (`isLength({ min, max })`)
- Custom validators for business rules
- `handleValidationErrors` middleware that returns 400 on invalid input

### Validator Files vs Route Files

| Route Module | Validator File | Coverage |
|-------------|---------------|----------|
| admin | admin.js | Yes |
| ai-autofill | ai-autofill.js | Yes |
| analytics | analytics.js | Yes |
| auth | auth.js | Yes |
| bundles | bundles.js | Yes |
| cart-activity | cart-activity.js | Yes |
| catalog | catalog.js | Yes |
| catalog-health | catalog-health.js | Yes |
| cycle-counts | cycle-counts.js | Yes |
| delivery | delivery.js | Yes |
| driver-api | driver-api.js | Yes |
| expiry-discounts | expiry-discounts.js | Yes |
| gmc | gmc.js | Yes |
| google-oauth | google-oauth.js | Yes |
| labels | labels.js | Yes |
| logs | logs.js | Yes |
| loyalty | loyalty.js | Yes |
| merchants | merchants.js | Yes |
| purchase-orders | purchase-orders.js | Yes |
| seniors | seniors.js | Yes |
| settings | settings.js | Yes |
| square-attributes | square-attributes.js | Yes |
| subscriptions | subscriptions.js | Yes |
| sync | sync.js | Yes |
| vendor-catalog | vendor-catalog.js | Yes |
| webhooks | webhooks.js | Yes |

Every route module has a corresponding validator file.

---

## 4.5 XSS Prevention

**PASS**

### Server-Side

- No server-side template rendering (no EJS, Pug, Handlebars)
- Application is a JSON API — all responses via `sendSuccess()` / `sendError()` which return `application/json`
- Static HTML files served via `express.static` — no server-rendered user content
- CSP header blocks inline scripts (`middleware/security.js:38-98`)

### Client-Side

- `escapeHtml()` function (`public/js/utils/escape.js:19-24`) uses DOM-based escaping (`textContent` → `innerHTML`)
- `escapeAttr()` function also available for attribute contexts
- Spot-checked 6 high-innerHTML files (loyalty.js, vendor-catalog.js, purchase-orders.js, expiry-audit.js, delivery-history.js, catalog-workflow.js) — all user-controlled data is escaped via `escapeHtml()`
- `textContent` used for simple text assignments (numbers, dates, etc.)

### Finding 4.5.1 — Server-generated IDs used unescaped in HTML attributes

**Severity: LOW**

Some files use server-generated values (IDs, PO numbers) in HTML attributes without `escapeHtml()`:
```javascript
// public/js/purchase-orders.js:91
data-action-param="${po.id}"
// public/js/purchase-orders.js:103
href="/api/purchase-orders/${po.po_number}/export-xlsx"
```

These values are server-generated (integer IDs, PO number format `PO-YYYYMMDD-NNN`), not user-controlled content. Risk is negligible but defense-in-depth suggests escaping all interpolated values.

---

## 4.6 HTTP Header Injection

**PASS**

- No `res.setHeader()` calls with user-controlled values
- Redirect URLs are all hardcoded paths with `encodeURIComponent()` for query parameters
- Open redirect prevention in `public/js/login.js:19`: validates returnUrl starts with `/` but not `//`
- `Content-Disposition` headers use hardcoded filenames (`gmc-feed.tsv`, `local-inventory-feed.tsv`)
- `Content-Type` headers are hardcoded

---

## 4.7 Request Body Parsing

**PASS**

`server.js:146-157`:
```javascript
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
        if (req.originalUrl === '/api/webhooks/square') {
            req.rawBody = buf.toString();
        }
    }
}));
app.use(express.urlencoded({ extended: false }));
```

- JSON body limited to 10MB (prevents large payload DoS)
- `extended: false` for URL-encoded bodies (prevents prototype pollution via nested objects)
- Raw body preserved for webhook signature verification

---

## Summary

| Check | Result | Findings |
|-------|--------|----------|
| SQL injection (parameterized queries) | PASS | All queries parameterized |
| SQL injection (dynamic SQL) | PASS | All dynamic parts from whitelists |
| LIKE wildcard injection | NEEDS WORK | Finding 4.2.1 |
| ORDER BY injection | PASS | No user-controlled ORDER BY |
| Input validation coverage | PASS | 28 validator files, 1:1 route coverage |
| XSS (server-side) | PASS | JSON API, no template rendering |
| XSS (client-side) | PASS | escapeHtml() used consistently |
| HTTP header injection | PASS | No user input in headers |
| Request body parsing | PASS | Size limits, no prototype pollution |

**Overall: PASS** — No injection vulnerabilities found. One minor LIKE wildcard issue.

### Findings Summary

| ID | Severity | Description |
|----|----------|-------------|
| 4.2.1 | LOW | ILIKE search term not escaped for `%` and `_` wildcards |
| 4.5.1 | LOW | Server-generated IDs used unescaped in HTML attributes (negligible risk) |
