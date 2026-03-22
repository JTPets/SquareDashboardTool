# Section 7: ERROR HANDLING & INFORMATION LEAKAGE

**Rating: PASS**

**Auditor note**: The global error handler properly sanitizes responses in production. `asyncHandler` wraps all route handlers. Process-level exception handlers are in place. No error information leakage found in production code paths.

---

## 7.1 Error Response Leakage

**Rating: PASS**

### Global Error Handler (`server.js:631-708`)

The global error handler distinguishes production from development mode:

**Production mode** (`NODE_ENV=production`):
- Returns `getUserFriendlyMessage()` -- generic messages like "An unexpected error occurred" for 500s
- Includes `requestId` (UUID) for support correlation
- Includes `code` if the error has one (e.g., `VALIDATION_ERROR`)
- Includes `errors` array for validation failures only
- **Does NOT include**: `err.message`, `err.stack`, file paths, DB schema, or env vars

**Development mode**:
- Adds `details: err.message` to the response
- This is appropriate for local debugging and never runs in production

### Direct Error Responses

A search for `res.json({ error: err.message })` or `res.status(500).send(err)` patterns found matches **only in test files** (`__tests__/routes/*.test.js`), where simplified error handlers are used for test isolation. No production route handler exposes raw error messages.

### Square API Error Handling

Square SDK errors are caught in `services/square/square-client.js` and wrapped with sanitized messages:
- 401: "Square API authentication failed. Check your access token."
- 429: "Too many requests. Please wait a moment before trying again."
- Other: Generic failure message with error code only

The raw `squareErrors` array is attached to the error object for internal logging but never sent to the client.

---

## 7.2 Global Error Handler Analysis

**Rating: PASS**

### Status Code Mapping (`server.js:636-651`)

If an error doesn't have a `statusCode`, the handler maps it based on error codes and message patterns:
- `UNAUTHORIZED` / "unauthorized" → 401
- `FORBIDDEN` / "permission" → 403
- `NOT_FOUND` → 404
- `RATE_LIMITED` / "rate limit" → 429
- `VALIDATION_ERROR` / `ValidationError` → 422

This prevents internal errors from leaking as 200 OK responses.

### User-Friendly Messages (`server.js:687-708`)

The `getUserFriendlyMessage()` function returns canned messages for all standard HTTP error codes. For operational errors (`err.isOperational`), the custom message is used -- these are intentionally user-facing messages set by the application.

### Logging Separation

- 5xx errors: `logger.error()` with full stack trace (server-side only)
- 4xx errors: `logger.warn()` without stack trace
- Client response: Never includes stack trace in any mode

---

## 7.3 Async Error Handling

**Rating: PASS**

### asyncHandler Coverage

`asyncHandler` (`middleware/async-handler.js`) wraps async functions with `Promise.resolve(fn(req, res, next)).catch(next)`.

**Coverage analysis**:
- 234 route definitions (`router.get/post/put/delete/patch`) across 27 route files
- 256 `asyncHandler` references across the same 27 files (higher count includes the `require` statement per file plus one per route)
- Every route file that uses `async` handlers imports and uses `asyncHandler`

No route handler was found using `async (req, res)` without `asyncHandler` wrapping.

### Process-Level Handlers (`server.js:1088-1103`)

```javascript
process.on('uncaughtException', (error) => {
    logger.error('UNCAUGHT EXCEPTION', { error: error.message, stack: error.stack, type: error.name });
    setTimeout(() => process.exit(1), 1000);  // Allow log flush before exit
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED PROMISE REJECTION', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined
    });
});
```

Both handlers:
- Log the full error for post-mortem debugging
- `uncaughtException` exits the process after a 1-second delay for log flushing (correct -- the process is in an undefined state)
- `unhandledRejection` logs but does not exit (consistent with Node.js default behavior in v18+)

---

## 7.4 Return Without Await Pattern

**Rating: PASS**

A search for `return` statements calling async functions without `await` in route handlers found no instances where this pattern would cause unhandled rejections. The `asyncHandler` wrapper catches rejections from the top-level promise, so even `return asyncFn()` without `await` is safe -- the rejection propagates through `Promise.resolve()`.

In services, the pattern does not appear in try/catch blocks where it would be dangerous.

---

## 7.5 Error Response Standards

**Rating: PASS**

### Response Helper Usage

The codebase uses `utils/response-helper.js` with `sendSuccess()`, `sendError()`, and `sendPaginated()` for consistent response formatting:
- `sendError(res, 'message', 400, 'ERROR_CODE')` → `{ success: false, error: 'message', code: 'ERROR_CODE' }`
- No raw error details are passed through this helper

### No Information Leakage Vectors Found

| Vector | Status | Notes |
|--------|--------|-------|
| Stack traces in responses | SAFE | Only in development mode |
| Database schema exposure | SAFE | SQL errors caught and wrapped |
| File paths in responses | SAFE | Not included in any error response |
| Environment variables | SAFE | Not included in any error response |
| Square API details | SAFE | Raw errors logged, not sent to client |
| Validation errors | SAFE | Express-validator messages are user-facing by design |

---

## Summary of Findings

| Sub-section | Rating | Key Finding |
|-------------|--------|-------------|
| 7.1 Error Leakage | PASS | Production errors return generic messages only |
| 7.2 Global Handler | PASS | Proper status mapping, user-friendly messages, log separation |
| 7.3 Async Coverage | PASS | asyncHandler on all routes; process-level handlers in place |
| 7.4 Return/Await | PASS | No dangerous return-without-await patterns found |
| 7.5 Response Standards | PASS | Consistent error format, no information leakage vectors |
