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

**Simple group** (`square-locations.js`, `square-location-preflight.js`,
`catalog-health-service.js`, `location-health-service.js`,
`utils/square-webhooks.js`). These call sites use at most two client
primitives and have no idempotency or pagination logic. Migrate by
instantiating `new SquareClient({ merchantId })` at function entry and
replacing `makeSquareRequest(endpoint, { accessToken, ... })` with
`client.get(path)` / `client.request(...)`. `utils/square-webhooks.js`
keeps its functional `generateIdempotencyKey` import unchanged since it
performs no HTTP. Expected churn: ≤ 15 lines per file, no test changes
beyond mock swaps. Land all five in a single PR to establish the
migration pattern before touching higher-risk code.

**Medium group** (`square-custom-attributes.js`, `square-pricing.js`,
`square-vendors.js`, `square-velocity.js`, `square-diagnostics.js`,
`inventory-receive-sync.js`, `match-suggestions-service.js`,
`vendor-query-service.js`, `utils/square-subscriptions.js`,
`scripts/combined-order-backfill.js`). These use `sleep` and/or
`generateIdempotencyKey` and exercise version-mismatch or pagination
paths. Migrate one file per PR. Replace manual idempotency-key generation
with `client.post(path, body, { idempotent: true })`. Replace manual
cursor loops with `client.paginate(...)` where shape matches; leave
bespoke loops alone when they interleave custom business logic between
pages. Keep `sleep` imports where callers pace work outside a single
request (e.g., velocity page throttling, backfill scripts).
`vendor-query-service.js` retains its lazy `require` to preserve the
existing cycle-break. Each PR must keep the full existing test suite
green with no snapshot or mock-arity changes beyond the direct call-site
swap.

**Complex group** (`services/square/index.js`, `services/square/api.js`,
`square-inventory.js`, `square-catalog-sync.js`,
`vendor/catalog-create-service.js`). These are either public barrels or
long-running flows where retry pacing, idempotency, and version conflicts
are load-bearing. Migrate last, one PR per file, behind a feature flag
where practical. `index.js` gains the class on its re-export surface
without removing any existing functional export — downstream consumers
outside this plan must continue to work unchanged. `api.js` adopts the
class internally but keeps its own exported signature stable.
`square-inventory.js` and `catalog-create-service.js` must have their
idempotency-key generation traced end-to-end in tests to prove the new
`{ idempotent: true }` path produces the same uniqueness guarantees as
today. `square-catalog-sync.js` needs a dedicated soak test against a
sandbox merchant before rollout because its batch+sleep pacing directly
drives Square rate-limit behavior. No deletions of the functional
exports until every consumer in this document has been migrated and one
full release cycle has elapsed.
