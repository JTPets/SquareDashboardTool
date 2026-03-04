# Dead Code Report

> **Audit Date**: 2026-02-19
> **Scope**: services/, routes/, jobs/, middleware/, utils/ (excluding node_modules, .git, __tests__)
> **Post**: BACKLOG-31 (dead modern loyalty layer removed), feature flag cleanup

---

## Summary

| Category | Count | Cleanup Effort |
|----------|-------|----------------|
| Unused exports | 0 (2 removed 2026-02-19) | — |
| Orphan route handlers | 0 | — |
| Debug artifacts (console.log) | 1 file (CLI utility, OK) | — |
| Commented-out code blocks | 0 | — |
| TODO/FIXME comments | 2 (1 stale removed 2026-02-19) | — |
| Stale imports | 0 | — |
| **Total actionable items** | **0** | **—** |

**Overall assessment**: Codebase is clean. All actionable findings resolved 2026-02-19. Remaining 2 TODOs are known backlog items (currency hardcode, batch-delete restart edge case).

---

## 1. Unused Exports

Exports from `module.exports` that have zero importers in production code (services/, routes/, jobs/, middleware/, utils/).

| File | Export | Import Count | Status | Recommendation |
|------|--------|-------------|--------|----------------|
| `services/loyalty-admin/index.js` | `createSquareLoyaltyReward` | 0 | ~~DEAD~~ **REMOVED** (2026-02-19) | Removed from index.js, reward-service.js exports, and function body deleted. |
| `services/loyalty-admin/index.js` | `getAllVariationAssignments` | 0 | ~~DEAD~~ **REMOVED** (2026-02-19) | Removed from index.js, variation-admin-service.js exports, and function body deleted. |

**Notes**:
- Both were re-exports from the loyalty-admin index. Functions and re-exports removed 2026-02-19.

---

## 2. Orphan Route Handlers

Functions in `routes/` that are defined but never attached to `router.get/post/put/delete`.

| File | Function | Status |
|------|----------|--------|
| — | — | None found |

All route files follow the pattern of inline handlers or helper functions that are actively called by route definitions.

---

## 3. Debug Artifacts

`console.log`, `console.debug`, `console.warn` in production code (not __tests__/).

| File | Count | Type | Recommendation |
|------|-------|------|----------------|
| `utils/link-existing-subscribers.js` | 19 | `console.log` | OK — CLI utility script run manually, not production server code |

**No debug artifacts in production server code** (routes, services, middleware, jobs).

---

## 4. Commented-Out Code Blocks

Blocks of 5+ consecutive commented lines containing code patterns (// if, // const, // function, // await).

| File | Lines | Content | Recommendation |
|------|-------|---------|----------------|
| — | — | None found | — |

The codebase has clean commenting practices. Inline comments explain logic but don't contain commented-out code blocks.

---

## 5. TODO/FIXME/HACK Comments

| File | Line | Comment | Status | Recommendation |
|------|------|---------|--------|----------------|
| `middleware/security.js` | 23 | `TODO: Externalize inline scripts to complete CSP hardening (see P0-4 in CLAUDE.md)` | ~~STALE~~ **REMOVED** (2026-02-19) | TODO removed and comment updated from "P0-4 PARTIAL" to "P0-4 COMPLETE". |
| `services/loyalty-admin/square-discount-service.js` | 348 | `TODO: BACKLOG - currency hardcoded to CAD; for multi-tenant SaaS, pull from merchant config` | Known | Pre-franchise item. Leave as-is until multi-tenant currency support is needed. |
| `utils/square-catalog-cleanup.js` | 14 | `TODO: If the server restarts during a batch-delete call, objects may be partially deleted` | Known | Edge case documentation. The batch-delete is idempotent so this is informational, not a bug. |

---

## 6. Stale Imports

Variables imported/required but never referenced in the file body.

| File | Import | Status |
|------|--------|--------|
| — | — | None found |

All imports are actively used in their respective files.

---

## Recommendations

### Priority: Low (S effort)

1. **Remove 2 unused loyalty-admin exports** from `services/loyalty-admin/index.js`:
   - `createSquareLoyaltyReward` (dead — Square Loyalty API approach abandoned)
   - `getAllVariationAssignments` (dead — no production caller)

2. **Fix stale CSP TODO** in `middleware/security.js:21-23`:
   - Remove `// TODO: Externalize inline scripts...` (P0-4 Phase 2 complete)
   - Update `// P0-4 PARTIAL` comment to `// P0-4 COMPLETE`

3. **No other action needed** — codebase is clean.

---

## Methodology

- **Unused exports**: Searched every `module.exports` in services/ and utils/ directories, then grepped entire codebase for each export name. Excluded test files from consumer counts. Checked frontend JS files (public/js/) and API routes for indirect usage.
- **Orphan handlers**: Listed all function definitions in routes/ files and verified each is referenced in a `router.METHOD()` call.
- **Debug artifacts**: `grep -rn "console\.\(log\|debug\|warn\)" services/ routes/ jobs/ middleware/ utils/`
- **Commented code**: Manual scan for patterns of `// if`, `// const`, `// function`, `// await` in consecutive blocks.
- **TODO/FIXME**: `grep -rn "\bTODO\b\|\bFIXME\b\|\bHACK\b\|\bXXX\b\|\bWORKAROUND\b"` with word boundary matching.
- **Stale imports**: Checked each `require()` in services/ and routes/ against variable usage in the same file.

---

**Report generated**: 2026-02-19
**Codebase grade**: A+ (minimal dead code, clean practices)
