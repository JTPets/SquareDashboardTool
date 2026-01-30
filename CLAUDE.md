# CLAUDE.md - JTPets Square Dashboard Tool

## Project Overview

Multi-tenant SaaS inventory management system for Square POS. Built for JTPets.ca (pet food/supplies with free local delivery) with goal of SaaS revenue. Running on Raspberry Pi.

## Tech Stack

- **Runtime**: Node.js 18+ with Express.js
- **Database**: PostgreSQL 14+
- **Process Manager**: PM2
- **External APIs**: Square SDK v43.2.1, Google APIs v144
- **Timezone**: America/Toronto

---

## Critical Rules

### Security First
- ALL database queries use parameterized SQL (`$1, $2` - never string concatenation)
- ALL user input validated via express-validator (see `middleware/validators/`)
- ALL routes require authentication unless explicitly public
- Multi-tenant isolation: EVERY query must filter by `merchant_id`
- Tokens encrypted with AES-256-GCM before storage

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
// Success (direct format - most endpoints)
res.json({ count: 5, items: [...] });

// Success (wrapped format - some endpoints)
res.json({ success: true, data: { ... } });

// Error
res.status(4xx).json({ success: false, error: 'message', code: 'ERROR_CODE' });
```

> **Warning**: Response formats are inconsistent. Always check the actual route before writing frontend code. See [EVENT_DELEGATION.md](./docs/EVENT_DELEGATION.md#6-api-response-data-wrapper-mismatch).

### Code Organization
```
routes/          → API endpoints (thin - validation + call service)
middleware/      → Auth, merchant context, validators, security
services/        → Business logic (loyalty/ has good examples)
utils/           → Shared utilities (database, Square API, logging)
database/        → schema.sql + migrations/
jobs/            → Background jobs and cron tasks
```

### Code Rules

| Rule | Limit |
|------|-------|
| Function length | ≤ 100 lines |
| File length | ≤ 300 lines (split if larger) |
| Service scope | Single responsibility |
| Route logic | Validation + call service only |
| New files | Tests + docs reference required |
| Complexity | Explainable in one sentence |

**Violations require justification.** If any rule must be broken:
1. Add a comment at the top of the file/function explaining WHY
2. Log it in the Approved Violations table below
3. Create a backlog item to refactor if temporary

#### Approved Violations
| Date | File | Rule Broken | Reason |
|------|------|-------------|--------|
| 2026-01-29 | utils/database.js | 2,093 line function | SQL schema definition, not logic |
| 2026-01-29 | services/loyalty-admin/loyalty-service.js | 5,475 lines | Legacy service pending deprecation (P1-1) |
| 2026-01-29 | server.js | 1,006 lines | Express entry point, already reduced 66% |
| 2026-01-29 | All LOW severity files | >300 lines | Stable code, refactor-on-touch policy |

**Policy**: Files are refactored when modified, not proactively. Touch it = fix it.

---

## Common Patterns

### Error Handling (asyncHandler)
```javascript
const asyncHandler = require('../middleware/async-handler');

router.get('/endpoint', asyncHandler(async (req, res) => {
    // Errors automatically caught and passed to error handler
}));
```

### Transaction Pattern
```javascript
const result = await db.transaction(async (client) => {
    await client.query('INSERT INTO table1...', [a, b]);
    await client.query('UPDATE table2...', [x, id]);
    return result;
});
```

### Batch Operations
```javascript
// Use ANY for batch lookups
const result = await db.query(
    'SELECT * FROM variations WHERE sku = ANY($1) AND merchant_id = $2',
    [skuArray, merchantId]
);
```

### Square API
```javascript
const { getSquareClientForMerchant } = require('../middleware/merchant');
const squareClient = await getSquareClientForMerchant(merchantId);

// Write operations require idempotency key
await squareClient.orders.createOrder({
    idempotencyKey: crypto.randomUUID(),
    order: { ... }
});
```

### Logging
```javascript
const logger = require('../utils/logger');
logger.info('Operation completed', { merchantId, result });
logger.error('Failed', { error: err.message, stack: err.stack });
```

---

## Commands

```bash
# Development
npm start                    # Production
npm run dev                  # Development with --watch
pm2 restart square-dashboard-addon  # After code changes
npm test                     # Run tests

# View logs
tail -f output/logs/app-*.log
tail -f output/logs/error-*.log

# Database (always source .env first)
set -a && source .env && set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"

# Run migration (always include .env sourcing in one command)
set -a && source .env && set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/migrations/XXX_name.sql
```

---

## Architecture Overview

```
/home/user/SquareDashboardTool/
├── server.js            # Route setup, middleware (~1,000 lines)
├── config/constants.js  # Centralized configuration
├── routes/              # 20 modules, ~246 routes
├── middleware/          # auth, merchant, security, validators/
├── services/            # Business logic
│   ├── webhook-processor.js
│   ├── webhook-handlers/ (6 handlers)
│   ├── loyalty/         # Modern service
│   └── catalog/         # Example service layer
├── jobs/                # Cron tasks
└── utils/               # database, logger, helpers
```

**Middleware Stack**: `Request → requireAuth → loadMerchantContext → requireMerchant → validators.* → Handler`

---

## New Code Checklists

### New Route
1. Create validator in `middleware/validators/routename.js`
2. Create route file in `routes/routename.js` using `asyncHandler`
3. Add to `server.js`
4. Write tests in `__tests__/routes/routename.test.js`

### New Database Table
1. Add to `database/schema.sql`
2. Create migration `database/migrations/XXX_description.sql`
3. Include `merchant_id INTEGER REFERENCES merchants(id)` column
4. Add composite index with merchant_id as leading column

---

## Common Issues

| Issue | Solution |
|-------|----------|
| "relation does not exist" | Run missing migration |
| "Cannot find module" | `npm install` |
| "merchant_id cannot be null" | Add `requireMerchant` middleware |
| Session issues after deploy | `pm2 restart square-dashboard-addon` |

---

## Detailed Documentation

| Document | Contents |
|----------|----------|
| [docs/TECHNICAL_DEBT.md](./docs/TECHNICAL_DEBT.md) | P0/P1/P2/P3 status, roadmap to A++, API optimization |
| [docs/SECURITY_AUDIT.md](./docs/SECURITY_AUDIT.md) | Vulnerability history, fixes, security best practices |
| [docs/EVENT_DELEGATION.md](./docs/EVENT_DELEGATION.md) | CSP-compliant event handling, JS execution rules |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Webhook flow, services structure, middleware stack |
| [docs/API_OPTIMIZATION_PLAN.md](./docs/API_OPTIMIZATION_PLAN.md) | Rate limit fixes, caching strategy |

---

## Current Status

**Grade**: A+ (All P0 and P1 issues FIXED)
**Last Review**: 2026-01-26

| Priority | Status |
|----------|--------|
| P0 Security | 7/7 Complete |
| P1 Architecture | 9/9 Complete |
| P2 Testing | 6/6 Complete |
| API Optimization | 4/4 Complete |
| P3 Scalability | Optional |

### Active Work

- **P0-4 CSP Phase 2**: Externalizing inline scripts (20/29 files done, ~69%)
- **P1-1 Loyalty Migration**: Running in production (rate limiting fix applied 2026-01-30)

### Backlog (Target: TBD)

- BACKLOG-1: Frontend polling rate limits
- BACKLOG-2: Delivery routing webhook sync
- BACKLOG-3: Response format standardization
- BACKLOG-4: Customer birthday sync (see [TECHNICAL_DEBT.md](./docs/TECHNICAL_DEBT.md#backlog-4-customer-birthday-sync-for-targeted-marketing))

---

## PR Checklist

- [ ] No security vulnerabilities (parameterized queries, no error exposure)
- [ ] asyncHandler used (no manual try/catch in routes)
- [ ] merchant_id filter on ALL database queries
- [ ] Validators in `middleware/validators/`, not inline
- [ ] Business logic in services, not routes
- [ ] Tests added for new functionality
- [ ] Multi-step operations use transactions
