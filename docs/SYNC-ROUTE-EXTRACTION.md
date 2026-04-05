# Sync Route Extraction Plan

`routes/sync.js` — 588 lines. Business logic (helpers + smart sync orchestration) must move to a service.

---

## 1. Endpoints

| Method | Path | What it does |
|--------|------|--------------|
| POST | `/api/sync` | Full sync via `squareApi.fullSync()`, then generates GMC feed inline |
| POST | `/api/sync-sales` | Sales velocity only via `squareApi.syncSalesVelocityAllPeriods()` |
| POST | `/api/sync-smart` | Interval-based sync via `runSmartSync()` helper defined in this file |
| GET  | `/api/sync-history` | Direct DB query for recent `sync_history` rows |
| GET  | `/api/sync-intervals` | Reads env vars, no DB |
| GET  | `/api/sync-status` | Calls `isSyncNeeded()` per type + detail DB query per type |

---

## 2. Handler Analysis

### Already in services
- `POST /api/sync` — delegates to `squareApi.fullSync()` (in `services/square/`) and `gmc/feed-service`. Route handler is thin.
- `POST /api/sync-sales` — delegates entirely to `squareApi.syncSalesVelocityAllPeriods()`. Already thin.

### Inline logic (must extract)
| Function | Lines | Problem |
|----------|-------|---------|
| `loggedSync()` | 41–100 | DB write + error handling, used by smart sync and cron |
| `isSyncNeeded()` | 109–139 | DB read + interval calc, used by smart sync and sync-status route |
| `runSmartSync()` | 148–398 | 250-line orchestrator; also exported to `server.js` for cron |
| `GET /api/sync-history` handler | 488–512 | Inline DB query, no service layer |
| `GET /api/sync-status` handler | 538–581 | Inline `isSyncNeeded` loop + per-type detail query |

### Target service
All inline logic → **`services/square/square-sync-orchestrator.js`** (file already exists).
Export: `loggedSync`, `isSyncNeeded`, `runSmartSync`, `getSyncHistory`, `getSyncStatus`.

---

## 3. Current Test Coverage

File: `__tests__/routes/sync.test.js` — 6 `describe` blocks, ~18 tests.

| Endpoint | Tests | Gaps |
|----------|-------|------|
| POST /api/sync | 5 (auth, no-merchant, success, GMC fail, fullSync error) | None |
| POST /api/sync-sales | 4 (auth, no-merchant, success, error) | None |
| POST /api/sync-smart | 3 (auth, no-merchant, all-skipped, db-error) | All 4 tiered paths untested; force-sync conditions untested |
| GET /api/sync-history | 4 (auth, no-merchant, success, db-error) | `?limit` param not tested |
| GET /api/sync-intervals | 2 (auth, defaults) | Env var overrides untested |
| GET /api/sync-status | 3 (auth, no-merchant, success, db-error) | Never-synced state untested |

No unit tests exist for `loggedSync`, `isSyncNeeded`, or `runSmartSync` in isolation.

---

## 4. New Tests Needed After Extraction

Target file: `__tests__/services/square/square-sync-orchestrator.test.js`

| Function | Tests to add |
|----------|-------------|
| `loggedSync` | success path, failure updates history, failure in update swallowed |
| `isSyncNeeded` | never synced, stale, fresh, GMC type (different table/column) |
| `runSmartSync` | Tier 1 (365d), Tier 2 (182d), Tier 3 (91d), all-skipped, partial errors, force-location, force-catalog, force-inventory, force-365d-catchup |

**Estimated: ~18 new unit tests.**

Route-level tests for `sync-smart` need 4 additional cases covering each tier path.

**Estimated total new tests: ~22.**
