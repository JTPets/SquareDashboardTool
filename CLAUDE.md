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

## Documentation Maintenance

After ANY of the following changes, Claude Code MUST update the relevant architecture documents before closing the PR:

| Change | Documents to Update |
|--------|-------------------|
| New service file added | DOMAIN-MAP.md (Table 1) |
| New route file added or mounted in server.js | DOMAIN-MAP.md, QA-AUDIT.md Section 2 |
| New DB table created | DOMAIN-MAP.md (Tables Owned column) |
| New cron job added | AUTOMATION-PATTERNS.md |
| New automation header convention | AUTOMATION-PATTERNS.md |
| New Square catalog upsert function | CODING-PATTERNS.md |
| New middleware added | DOMAIN-MAP.md, ARCHITECTURE.md |
| New auth/permission pattern | ARCHITECTURE.md, CODING-PATTERNS.md |
| Security gap found | BACKLOG.md |
| New standard pattern established | CODING-PATTERNS.md |
| Route removed or renamed | DOMAIN-MAP.md, QA-AUDIT.md |

This rule is NON-NEGOTIABLE. Documentation debt compounds. A PR that adds a new service without updating DOMAIN-MAP.md is incomplete regardless of passing tests.

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
| [SECURITY.md](./SECURITY.md) | Security architecture and controls |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System design, webhook flow, services structure, Square API details |
| [docs/SETUP.md](./docs/SETUP.md) | Local dev setup, database init, deployment, Cloudflare Tunnel |
| [docs/BACKLOG.md](./docs/BACKLOG.md) | All open work items by priority (CRITICAL/HIGH/MEDIUM/LOW) |
| [docs/DOMAIN-MAP.md](./docs/DOMAIN-MAP.md) | Codebase organization, cross-domain dependencies, split candidates |
| [docs/CODE-RULES.md](./docs/CODE-RULES.md) | Code limits, violations policy, checklists |
| [docs/DATABASE-RULES.md](./docs/DATABASE-RULES.md) | Schema change policy, migration format, DB patterns |
| [docs/CODING-PATTERNS.md](./docs/CODING-PATTERNS.md) | Response format, asyncHandler, Square API, logging |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Common issues and solutions |

---

## Current Status

**Test Coverage**: 5,464 tests / 268 suites / 0 failures
**Security**: A+ core (multi-tenant isolation, auth, injection prevention, data integrity)
**Open Items**: 4 CRITICAL, 11 HIGH, ~33 MEDIUM, ~18 LOW

See [docs/BACKLOG.md](./docs/BACKLOG.md) for the full backlog and priorities.
