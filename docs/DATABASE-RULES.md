# Database Rules

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Architecture](./ARCHITECTURE.md) | [Code Rules](./CODE-RULES.md)
>
> **Last Updated**: 2026-04-01

---

## Schema Change Policy

- **`schema-manager.js`**: handles `CREATE TABLE` and `ADD COLUMN IF NOT EXISTS` (structural changes). Runs on every server start. No migration file needed for simple column additions.
- **Migration files (`database/migrations/`)**: ONLY for data transforms (`UPDATE`, backfill, `ALTER CONSTRAINT`, `DROP COLUMN`, data migration between tables). These are changes schema-manager cannot safely do idempotently.
- **`schema.sql`**: always kept in sync as the reference schema for fresh installs.

## Migration Format

Every migration file MUST be wrapped in `BEGIN`/`COMMIT`. The test in `__tests__/database/schema-integrity.test.js` enforces this — `npm test` will fail if missing.

```sql
BEGIN;

-- Your migration SQL here
ALTER TABLE example ADD COLUMN new_col TEXT;

COMMIT;
```

## Multi-Tenant Pattern

Every tenant-scoped table MUST include `merchant_id INTEGER REFERENCES merchants(id)` and every query MUST filter by `merchant_id`.

```javascript
const merchantId = req.merchantContext.id;

const result = await db.query(
    'SELECT * FROM items WHERE merchant_id = $1 AND id = $2',
    [merchantId, itemId]
);
```

## Transaction Pattern

```javascript
const result = await db.transaction(async (client) => {
    await client.query('INSERT INTO table1...', [a, b]);
    await client.query('UPDATE table2...', [x, id]);
    return result;
});
```

## Batch Operations

```javascript
// Use ANY for batch lookups
const result = await db.query(
    'SELECT * FROM variations WHERE sku = ANY($1) AND merchant_id = $2',
    [skuArray, merchantId]
);
```

## Running Migrations

```bash
# Always source .env first
set -a && source .env && set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/migrations/XXX_name.sql
```

## Database Shell

```bash
set -a && source .env && set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
```
