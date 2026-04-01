# SqTools — CLAUDE.md

Multi-tenant SaaS inventory management system for Square POS. Built for JTPets.ca (pet food/supplies with free local delivery) with goal of SaaS revenue. Node.js 18+ / Express / PostgreSQL 15 on Raspberry Pi. Process manager: PM2. Square SDK v43.2.1, Google APIs v144. Timezone: America/Toronto.

> **CLAUDE.md must stay under 300 lines.** Detailed rules belong in `docs/` sub-files. Link, don't inline. Every token here costs money on every prompt.

---

## Critical Rules

### Security
- ALL database queries use parameterized SQL (`$1, $2` — never string concatenation)
- ALL user input validated via express-validator (`middleware/validators/`)
- ALL routes require `requireAuth` + `requireMerchant` middleware
- Multi-tenant isolation: EVERY query must filter by `merchant_id`
- Tokens encrypted with AES-256-GCM before storage
- All user input in HTML must use `escapeHtml()` / `escapeAttr()`
- PII must not appear in logs — `utils/log-sanitizer.js` handles this
- See [SECURITY.md](./SECURITY.md) for full security documentation

### Code Quality
- Function length: ≤ 100 lines
- File length: ≤ 300 lines (split if larger)
- No new `<style>` blocks in HTML — `public/css/shared.css` only
- Every migration wrapped in `BEGIN`/`COMMIT`
- Tests must pass before commit — new features require tests in same commit
- See [docs/CODE-RULES.md](./docs/CODE-RULES.md) for full rules, violations, and checklists

### Git Rules
- Always start work with: `git checkout main && git pull origin main`
- Then create feature branch from updated main
- When told "do not commit" or "show me before committing", do NOT run `git commit` or `git push`. Show the diff only. Wait for explicit approval before committing.
- This rule has no exceptions.

### Multi-Tenant Pattern
```javascript
const merchantId = req.merchantContext.id;
// EVERY database query must include merchant_id
const result = await db.query(
    'SELECT * FROM items WHERE merchant_id = $1 AND id = $2',
    [merchantId, itemId]
);
```

### Response Format
```javascript
const { sendSuccess, sendError, sendPaginated } = require('../utils/response-helper');
sendSuccess(res, { count: 5, items: [...] });   // → { success: true, count: 5, items: [...] }
sendError(res, 'message', 400, 'ERROR_CODE');    // → { success: false, error: 'message', code: 'ERROR_CODE' }
sendPaginated(res, { items, total, limit, offset }); // → { success: true, items, total, limit, offset }
```
> All routes use `utils/response-helper.js`. Do not use raw `res.json()`.

### Error Handling
```javascript
const asyncHandler = require('../middleware/async-handler');
router.get('/endpoint', asyncHandler(async (req, res) => {
    // Errors automatically caught and passed to error handler
}));
```

### Schema Change Policy
- **`schema-manager.js`**: `CREATE TABLE` and `ADD COLUMN IF NOT EXISTS` (runs on start)
- **Migration files**: ONLY for data transforms, `ALTER CONSTRAINT`, `DROP COLUMN`
- **`schema.sql`**: always kept in sync as fresh-install reference
- See [docs/DATABASE-RULES.md](./docs/DATABASE-RULES.md) for full details

### Square SDK Method Naming
The SDK uses nested resource patterns, NOT flat API naming from Square's docs.
- `squareClient.ordersApi.retrieveOrder()` → `squareClient.orders.get({ orderId })`
- `squareClient.catalog.deleteObject()` → `squareClient.catalog.object.delete({ objectId })`
- `response.result.order` → `response.order`

**Rule**: Before writing any Square API call, grep the codebase for an existing working example.

---

## Project Structure

```
routes/          → API endpoints (thin — validation + call service)
middleware/      → Auth, merchant context, validators, security
services/        → Business logic (loyalty-admin/ has good examples)
utils/           → Shared utilities (database, Square API, logging)
database/        → schema.sql + migrations/
jobs/            → Background jobs and cron tasks
public/          → 35 HTML pages + JS/CSS assets
```

**Middleware Stack**: `Request → requireAuth → loadMerchantContext → requireMerchant → validators.* → Handler`

---

## Key Commands

```bash
npm start                    # Production
npm run dev                  # Development with --watch
pm2 restart sqtools          # After code changes
npm test                     # Run tests
```

---

## Documentation Index

| Document | Contents |
|----------|----------|
| [SECURITY.md](./SECURITY.md) | Security architecture, controls, audit history |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Webhook flow, services structure, loyalty-admin modules, Square API details |
| [docs/CODE-RULES.md](./docs/CODE-RULES.md) | Code limits, violations policy, refactor-on-touch, new code checklists, PR checklist |
| [docs/DATABASE-RULES.md](./docs/DATABASE-RULES.md) | Schema change policy, migration format, DB patterns and commands |
| [docs/CODING-PATTERNS.md](./docs/CODING-PATTERNS.md) | Response format, asyncHandler, Square API, transactions, logging |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Common issues and solutions |
| [docs/TECHNICAL_DEBT.md](./docs/TECHNICAL_DEBT.md) | Known issues, observations, deferred work |
| [docs/PRIORITIES.md](./docs/PRIORITIES.md) | Active HIGH/MEDIUM/LOW priority work items |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Future initiatives and planned features |
| [docs/WORK-ITEMS.md](./docs/WORK-ITEMS.md) | Consolidated master work list (all open items) |

---

## Current Status

**Security Audit Grade**: B+ (13-section audit, 2026-03-22)
**Core Security**: A+ (multi-tenant isolation, auth, injection prevention, data integrity)
**Test Coverage**: 4,852 tests / 239 suites / 0 failures
**Last Audit**: 2026-03-25

See [docs/WORK-ITEMS.md](./docs/WORK-ITEMS.md) for the complete backlog and open items.
See [docs/PRIORITIES.md](./docs/PRIORITIES.md) for current priority work.
