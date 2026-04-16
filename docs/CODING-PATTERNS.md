# Coding Patterns

> **Maintenance:** Update when: new standard pattern established in code review, existing pattern deprecated, new security requirement added to all routes.
> See also: [ARCHITECTURE.md](./ARCHITECTURE.md), [AUTOMATION-PATTERNS.md](./AUTOMATION-PATTERNS.md), [CODE-RULES.md](./CODE-RULES.md)

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Architecture](./ARCHITECTURE.md) | [Code Rules](./CODE-RULES.md) | [Database Rules](./DATABASE-RULES.md)
>
> **Last Updated**: 2026-04-01

---

## Response Format

All routes use `utils/response-helper.js`. Do not use raw `res.json()` for new endpoints.

```javascript
const { sendSuccess, sendError, sendPaginated } = require('../utils/response-helper');

// Success — flat-merges data with { success: true }
sendSuccess(res, { count: 5, items: [...] });
// → { success: true, count: 5, items: [...] }

// Error
sendError(res, 'message', 400, 'ERROR_CODE');
// → { success: false, error: 'message', code: 'ERROR_CODE' }

// Paginated
sendPaginated(res, { items: [...], total: 100, limit: 20, offset: 0 });
// → { success: true, items: [...], total: 100, limit: 20, offset: 0 }
```

---

## Error Handling (asyncHandler)

```javascript
const asyncHandler = require('../middleware/async-handler');

router.get('/endpoint', asyncHandler(async (req, res) => {
    // Errors automatically caught and passed to error handler
}));
```

---

## Square API

```javascript
const { getSquareClientForMerchant } = require('../middleware/merchant');
const squareClient = await getSquareClientForMerchant(merchantId);

// Write operations require idempotency key
await squareClient.orders.createOrder({
    idempotencyKey: crypto.randomUUID(),
    order: { ... }
});
```

### Square SDK Method Naming

The Square Node.js SDK in this project uses nested resource patterns, NOT the flat API naming from Square's docs. Always check existing working code before writing Square API calls.

Common mistakes:
- `squareClient.ordersApi.retrieveOrder()` → `squareClient.orders.get({ orderId })`
- `squareClient.catalog.deleteObject()` → `squareClient.catalog.object.delete({ objectId })`
- `squareClient.loyalty.searchLoyaltyEvents()` → `squareClient.loyalty.searchEvents()`
- `response.result.order` → `response.order`

**Rule**: Before writing any Square API call, grep the codebase for an existing working example of that endpoint.

---

## Logging

```javascript
const logger = require('../utils/logger');
logger.info('Operation completed', { merchantId, result });
logger.error('Failed', { error: err.message, stack: err.stack });
```

Log files are in `output/logs/`:
- `app-*.log` — Application logs
- `error-*.log` — Error logs only
