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

## 4. Deletion Checklist

What gets deleted and when, after all 19 files are migrated and one full
release cycle has elapsed without regressions.

**Functions/constants to remove from `shared-utils.js`** (duplicated by `square-client.js`):
- `squareApiRequest` — replaced by `squareClient.request`
- `getSquareAccessToken` — replaced by `squareClient.getToken`
- `fetchWithTimeout` — folded into `squareClient.request` internals
- `SQUARE_API_BASE` constant — now owned by `square-client.js`
- `SQUARE_API_VERSION` constant — now owned by `square-client.js`

**Symbols to keep in `shared-utils.js`** for import compatibility:
- `SquareApiError` — kept as a re-export shim from `square-client.js`
- `generateIdempotencyKey` — kept as a re-export from `square-client.js`
- `getSquareApi` — lazy loader stays (module-cache concern, not client concern)

**`square-api-client.js` fate**: kept as a thin shim that delegates to
`square-client.js`. It is NOT deleted outright; any file still importing
`SquareApiClient` continues to work via the shim until a follow-up sweep
removes those imports. Task 18 deletes the duplicate `shared-utils`
functions only; the `square-api-client.js` shim persists.

**Gate**: NO deletions land until
1. All 19 files in Section 3 are migrated and merged to main
2. One full release cycle (≥ 7 days in production) has elapsed
3. No rollback or hotfix has touched the Square client path in that window
4. `grep -r 'require.*shared-utils.*squareApiRequest'` returns zero hits

## 5. Sprint Breakdown

Atomic tasks, each independently mergeable. Format per task:
**files touched | tests to update | acceptance criteria**.

**Task 1 — Extend `square-client.js`** (Section 2 changes, no callers change)
- Files: `services/square/square-client.js`
- Tests: `square-client.test.js`
- Accept: new `timeout` option lands with default matching prior behavior; existing callers untouched pass unchanged.

**Task 2 — Simple group migration** (4 files, single PR)
- Files: `redemption-audit-service.js`, `customer-admin-service.js`, `customer-details-service.js`, `customer-identification-service.js`
- Tests: matching `*.test.js` for each
- Accept: each file imports from `square-client.js` only; shared-utils Square imports removed from these 4.

**Tasks 3–9 — Medium group** (one PR per file)
- 3: `customer-search-service.js` | its test | no shared-utils Square imports remain
- 4: `discount-validation-service.js` | its test | 404 path and retry behavior preserved
- 5: `loyalty-event-prefetch-service.js` | its test | pagination semantics unchanged
- 6: `square-discount-service.js` | its test | null-vs-throw token path matches prior
- 7: `order-history-audit-service.js` | its test | idempotency key format byte-identical
- 8: `customer-handler.js` | its test | retry policy preserved under 429
- 9: `seniors-service.js` | its test | idempotency + error shape preserved

**Tasks 10–17 — Complex group** (one PR per file)
- 10: `index.js` | `index.test.js` | server boot unchanged
- 11: `square-api-client.js` → shim | `square-api-client.test.js` | SquareApiError fields match; shim delegates cleanly
- 12: `square-customer-group-service.js` | its test | group ops unchanged
- 13: `square-discount-catalog-service.js` | its test | idempotency key shape preserved
- 14: `backfill-service.js` | its test | per-call timeout honored
- 15: `backfill-orchestration-service.js` | its test | long-loop timeout honored
- 16: `order-processing-service.js` | its test + 500-order soak | no retry/timeout regression
- 17: `loyalty-handler.js` | its test + full loyalty E2E | accumulate/redeem/refund intact

**Task 18 — Delete `shared-utils.js` duplicate functions**
- Files: `services/loyalty-admin/shared-utils.js` (retain re-export shims per Section 4); `services/loyalty-admin/square-api-client.js` retained as shim
- Tests: full suite
- Accept: gate in Section 4 satisfied; `grep` sweep for removed symbols returns zero; `square-api-client.js` shim retained; all 5,464 tests green.

## 6. Risk Register

One row per behavioral difference from the Section 2 header.

| Risk | What breaks if wrong | How to detect | How to verify |
|------|---------------------|---------------|---------------|
| Null-vs-throw token | Callers expecting `null` from `getSquareAccessToken` on missing merchant now get a thrown error; silent features (e.g. background backfill) crash instead of skipping | Error logs spike from `backfill-service` / cron jobs shortly after deploy | Unit test `getToken` for missing-merchant: assert identical return shape (null) to prior behavior, plus explicit test for the throw variant |
| 404 handling | `order-history-audit-service.js` and `loyalty-event-prefetch-service.js` previously treated 404 as a typed soft-miss; if new client throws `SquareApiError` with `status=404`, branches that check `result === null` mis-branch into error path | Audit/prefetch handlers return 500 where they previously returned a "not found" success; test `order-history-audit-service.test.js` fails on the 404 case | Add explicit 404 fixture tests; diff handler response body against golden file pre/post migration |
| Retry policy change | New `retries` default differs from `squareApiRequest`; 429/503 under load either over-retry (rate-limit cascade) or under-retry (order processing fails that previously recovered) | 429 response counts in logs drift; `order-processing-service` soak test fails at ≥500 orders | Compare retry count + backoff schedule in `square-client.test.js` against `shared-utils.test.js` baseline; run 500-order soak in sandbox |
| Timeout default change | Section 2 replaces the hard-coded 15 s `fetchWithTimeout` default with the `square-client.js` 30 s default; `backfill-service` long loops that previously aborted at 15 s now run twice as long, and callers that relied on the shorter fail-fast window may block workers | Backfill jobs report longer per-call durations; webhook worker queue depth grows | Assert the 30 s default matches the current `square-client.js` value; add explicit per-call `timeout: 15000` override tests for any call site that relied on the old 15 s behavior |
| `SquareApiError` field shape | `loyalty-handler` and `order-processing-service` key off `status`, `endpoint`, `details`, `nonRetryable`; missing or renamed fields silently route all errors to the retryable branch | Loyalty errors loop indefinitely; retry counters climb with no progress | Snapshot test of `SquareApiError` JSON shape; diff against `square-api-client.js` original before Task 11 merges |
| Idempotency key format | `square-discount-catalog-service.js` sends a key format Square has already seen; duplicate catalog upsert creates a second row | Square API returns `IDEMPOTENCY_KEY_REUSED` or duplicate catalog objects appear | Byte-for-byte diff of `generateIdempotencyKey` output vs `squareClient.idempotencyKey` on same inputs; assert in unit test |
