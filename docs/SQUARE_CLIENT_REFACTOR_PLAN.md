# Square Client Refactor Plan

Plan to extend `services/square/square-client.js` into a richer shared
abstraction and migrate the ~20 call sites. Scope: internal refactor only;
no change to Square API behavior, retry semantics, or token handling.

## Section 1 — Call-Site Inventory

Files being migrated onto `square-client.js`: 14 importers of
`services/loyalty-admin/shared-utils.js` and 5 importers of
`services/loyalty-admin/square-api-client.js`.

| File | Methods Used | Behavioral Dependencies | Complexity |
|------|--------------|-------------------------|------------|
| services/loyalty-admin/index.js | fetchWithTimeout, getSquareAccessToken, getSquareApi | Public barrel for loyalty-admin; lazy square re-export | Complex |
| services/loyalty-admin/square-api-client.js | squareApiRequest, getSquareAccessToken, SquareApiError | Wrapper client built on shared-utils; exposes SquareApiClient + SquareApiError | Complex |
| services/loyalty-admin/square-customer-group-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION, getSquareApi (lazy) | Multiple inline `require('./shared-utils')` calls mid-function | Complex |
| services/loyalty-admin/square-discount-catalog-service.js | fetchWithTimeout, getSquareAccessToken, generateIdempotencyKey, SQUARE_API_BASE, SQUARE_API_VERSION | Catalog discount upserts; idempotency-key sensitive | Complex |
| services/loyalty-admin/backfill-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION | Long-running order backfill; timeout pacing matters | Complex |
| services/loyalty-admin/backfill-orchestration-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION | Orchestrates backfill over many customers | Complex |
| services/loyalty-admin/order-processing-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION | Critical path: processes orders into loyalty events | Complex |
| services/loyalty-admin/customer-search-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION | Customer search by phone/email | Medium |
| services/loyalty-admin/discount-validation-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION | Validates discount redemption preconditions | Medium |
| services/loyalty-admin/loyalty-event-prefetch-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION | Prefetch/cache loyalty events | Medium |
| services/loyalty-admin/square-discount-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION | Discount CRUD on Square API | Medium |
| services/loyalty-admin/order-history-audit-service.js | fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION | Audits order history for discrepancies | Medium |
| services/loyalty-admin/redemption-audit-service.js | fetchWithTimeout, SQUARE_API_VERSION | Audit-only; no token fetch (token passed in) | Simple |
| services/loyalty-admin/customer-admin-service.js | getSquareAccessToken | Token helper only; no direct HTTP | Simple |
| services/webhook-handlers/loyalty-handler.js | SquareApiClient | Loyalty webhook dispatcher; heavy conditional logic | Complex |
| services/webhook-handlers/customer-handler.js | SquareApiClient | Customer webhook dispatcher | Medium |
| services/seniors/seniors-service.js | SquareApiClient | Seniors-day discount flow | Medium |
| services/loyalty-admin/customer-details-service.js | SquareApiClient | Fetches customer detail records | Simple |
| services/loyalty-admin/customer-identification-service.js | SquareApiClient | Identifies customers via Square | Simple |

## Section 2 — Extension Spec for `square-client.js`

Minimal additions only. No new class, no get/post/put/delete/paginate/batch
helpers. Callers continue to use `makeSquareRequest` directly.

- Add optional `timeout` to `makeSquareRequest` options (default: current 30_000 ms)
- Per-call timeout replaces the hard-coded `AbortSignal.timeout(30000)`
- Timeout value surfaces in the existing "request timed out" error message
- No change to retry count, backoff, or rate-limit handling
- Add and export `SquareApiError` class
- Fields: `status` (HTTP status), `endpoint` (request path), `details` (array of Square error objects), `nonRetryable` (boolean)
- Thrown from `makeSquareRequest` in place of the current generic `Error`
- Existing `err.nonRetryable` and `err.squareErrors` semantics preserved as `SquareApiError` fields
- Base URL stays at `https://connect.squareup.com`; all endpoints continue to start with `/v2/...` at the call site
- Document the `/v2` convention in the module-level JSDoc (no code change)
- No new constants, no new env vars, no new module files
- `getMerchantToken`, `sleep`, `generateIdempotencyKey` exports unchanged
- `SQUARE_BASE_URL`, `MAX_RETRIES`, `RETRY_DELAY_MS` exports unchanged
- Add `SquareApiError` to module exports alongside existing names
- Tests: add cases to `__tests__/services/square/square-client.test.js`
- Test: custom `timeout` option aborts at the specified duration
- Test: default timeout remains 30_000 ms when option omitted
- Test: non-2xx responses throw `SquareApiError` with `status`, `endpoint`, `details` populated
- Test: 401 still sets `nonRetryable: true`
- Test: 429 still retries (no behavior change)
- No migration of existing callers required for these additions; Section 3 covers that

## Section 3 — Migration Spec

Migrates the 19 loyalty-admin and webhook files from Section 1 onto
`services/square/square-client.js`. `SquareApiError` (per Section 2)
must land before any file in this section is migrated — it is the shim
that lets callers preserve 404-tolerant and other status-based branches.
All 19 target files have corresponding test files under
`__tests__/services/loyalty-admin/`, `__tests__/services/webhook-handlers/`,
or `__tests__/services/seniors/`; each migration PR must keep its
file-specific test suite green.

**Simple group** (`redemption-audit-service.js`,
`customer-admin-service.js`, `customer-details-service.js`,
`customer-identification-service.js`). Changes: replace
`fetchWithTimeout` + manual `Bearer`/`Square-Version` header assembly
with `makeSquareRequest(endpoint, { accessToken, method, body })`;
replace `getSquareAccessToken(merchantId)` with
`getMerchantToken(merchantId)`; drop the `shared-utils` / `square-api-client`
imports. `SquareApiError` must already be exported from `square-client.js`
before any of these land. **Main migration risk**: `getSquareAccessToken`
returned `null` for missing tokens while `getMerchantToken` throws —
every call site must either catch the throw or pre-check the merchant.
**Acceptance criteria**: `redemption-audit-service.test.js`,
`customer-admin-service.test.js`, `customer-details-service.test.js`,
and `customer-identification-service.test.js` all pass unchanged (only
their mocks swap from `shared-utils`/`square-api-client` to
`square-client`). Land this group first in a single PR to prove the
shim and the null-vs-throw handling before touching riskier code.

**Medium group** (`customer-search-service.js`,
`discount-validation-service.js`, `loyalty-event-prefetch-service.js`,
`square-discount-service.js`, `order-history-audit-service.js`,
`customer-handler.js`, `seniors-service.js`). Changes: replace
`squareApiRequest(accessToken, method, endpoint, body, options)` calls
with `makeSquareRequest(endpoint, { accessToken, method, body })`;
rewrite any `err.status === 404 ? null : throw` branches to
`err instanceof SquareApiError && err.status === 404`. Preserve the
existing 404-to-null semantics exactly — several of these services
depend on it for "customer not found" and "discount not found" paths.
One PR per file. **Main migration risk**: `squareApiRequest` had its own
retry loop with `maxRetries` option; `makeSquareRequest` uses the shared
`MAX_RETRIES` constant, so call sites that previously passed a custom
`maxRetries` will silently use the module default. Audit every call for
custom retry counts before migration. **Acceptance criteria**: each
file's matching test file
(`customer-search-service.test.js`, `discount-validation-service.test.js`,
`loyalty-event-prefetch-service.test.js`, `square-discount-service.test.js`,
`order-history-audit-service.test.js`, `customer-handler.test.js`,
`seniors-service.test.js`) passes, plus `la-fixes-batch.test.js` which
exercises several of these services end-to-end.

**Complex group** (`services/loyalty-admin/index.js`,
`square-api-client.js`, `square-customer-group-service.js`,
`square-discount-catalog-service.js`, `backfill-service.js`,
`backfill-orchestration-service.js`, `order-processing-service.js`,
`loyalty-handler.js`). Changes: deepest rewrites.
`square-customer-group-service.js` has inline `require('./shared-utils')`
calls mid-function that must be hoisted and rewritten.
`square-api-client.js` is itself a client wrapper; collapse its
`SquareApiClient` class onto `makeSquareRequest` directly, or keep the
class as a thin shim that delegates (decide per call-site survey).
`square-discount-catalog-service.js` threads `generateIdempotencyKey`
through catalog upserts and must preserve the exact key shape.
`backfill-service.js` and `backfill-orchestration-service.js` run long
loops where per-call `timeout` tuning matters — use the new `timeout`
option from Section 2 rather than the default 30 s.
`loyalty-handler.js` and `order-processing-service.js` are on the
critical loyalty path. Migrate last, one PR per file.
**Main migration risk**: `SquareApiClient` currently surfaces errors via
`SquareApiError` with its own field shape; downstream handlers
(`loyalty-handler.js`, `order-processing-service.js`) key off those
fields. The `SquareApiError` class added in Section 2 must match that
field shape (`status`, `endpoint`, `details`, `nonRetryable`) or those
handlers will silently mis-branch. Diff both error shapes before the
first complex-group PR. **Acceptance criteria**: each file's matching
test file passes (`index.test.js`, `square-api-client.test.js`,
`square-customer-group-service.test.js`,
`square-discount-catalog-service.test.js`, `backfill-service.test.js`,
`backfill-orchestration-service.test.js`,
`order-processing-service.test.js`, `loyalty-handler.test.js`).
`order-processing-service.js` additionally requires a soak test against
a sandbox merchant processing ≥ 500 orders before merge to catch retry
or timeout regressions under load. `loyalty-handler.js` additionally
requires a full regression of the loyalty webhook flow (accumulate →
redeem → refund) end-to-end before merge. No removal of `shared-utils.js`
or the legacy `square-api-client.js` until every file in this document
has merged and one full release cycle has elapsed.
