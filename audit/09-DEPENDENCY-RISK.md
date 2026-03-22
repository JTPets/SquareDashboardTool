# Section 9: DEPENDENCY RISK

**Rating: PASS**

**Audit Date**: 2026-03-22
**Auditor**: Automated Security Audit (Claude)
**Scope**: All direct production and dev dependencies, transitive dependency tree, licensing, maintenance status

---

## 9.1 npm audit Results

```
found 0 vulnerabilities
```

**Result: CLEAN.** No known vulnerabilities in the current dependency tree at the time of audit. This is an excellent result for a project with 563 total packages in the lockfile.

---

## 9.2 Dependency Inventory

### Production Dependencies (19)

| Package | Version Spec | License | Last Published | Status |
|---------|-------------|---------|----------------|--------|
| bcrypt | ^6.0.0 | MIT | 2025-10-16 | OK |
| connect-pg-simple | ^9.0.1 | MIT | 2024-09-13 | OK |
| cors | ^2.8.5 | MIT | 2026-01-22 | OK |
| dotenv | ^16.3.1 | BSD-2-Clause | 2026-02-12 | OK |
| exceljs | ^4.4.0 | MIT | 2024-12-20 | OK |
| express | ^4.18.2 | MIT | 2026-03-08 | OK |
| express-rate-limit | ^7.1.5 | MIT | 2026-03-18 | OK |
| express-session | ^1.18.0 | MIT | 2026-01-22 | OK |
| express-validator | ^7.0.1 | MIT | 2025-11-19 | OK |
| googleapis | ^144.0.0 | Apache-2.0 | 2026-02-05 | OK |
| helmet | ^7.1.0 | MIT | 2025-03-17 | OK |
| multer | ^2.0.2 | MIT | 2026-03-04 | OK |
| node-cron | ^4.2.1 | ISC | 2026-03-18 | OK |
| node-fetch | ^2.7.0 | MIT | 2023-11-30 | **WATCH** |
| nodemailer | ^7.0.10 | MIT-0 | 2026-03-18 | OK |
| pg | ^8.17.1 | MIT | 2026-03-04 | OK |
| square | ^43.2.1 | MIT | 2026-03-12 | OK |
| winston | ^3.18.3 | MIT | 2025-12-07 | OK |
| winston-daily-rotate-file | ^5.0.0 | MIT | 2024-02-09 | **WATCH** |

### Dev Dependencies (3)

| Package | Version Spec | License | Status |
|---------|-------------|---------|--------|
| jest | ^29.7.0 | MIT | OK |
| jest-junit | ^16.0.0 | Apache-2.0 | OK |
| supertest | ^7.2.2 | MIT | OK |

### Totals

- **Production**: 19 direct dependencies
- **Dev**: 3 direct dependencies
- **Total direct**: 22
- **Total in lockfile (transitive)**: 563 packages

**Assessment**: The dependency count is lean and appropriate for the project scope. A multi-tenant SaaS with Square API, Google APIs, email, Excel export, scheduled jobs, and session management justifiably requires these packages. There is no dependency bloat.

---

## 9.3 Unmaintained / At-Risk Dependencies

### WATCH: node-fetch v2 (last published 2023-11-30)

- **Age since last publish**: ~2 years, 4 months
- **Why v2**: The project pins `^2.7.0` because node-fetch v3 is ESM-only. The codebase uses CommonJS (`require()`), making v3 incompatible without a significant migration.
- **Risk**: v2 is effectively in maintenance-only mode. No new features or proactive security patches.
- **Mitigation**: Node.js 18+ includes a native `fetch()` global (via `undici`). The project should migrate to native `fetch` and drop node-fetch entirely. This eliminates the dependency and the maintenance concern.
- **Severity**: LOW. The v2 line has no known vulnerabilities. The code path is limited to outbound HTTP calls where input is controlled by the application.

### WATCH: winston-daily-rotate-file (last published 2024-02-09)

- **Age since last publish**: ~1 year, 1 month
- **Risk**: Moderate maintenance cadence. The package is a winston transport plugin with a narrow scope, so infrequent updates are expected.
- **Mitigation**: No action needed now. If it falls behind winston major versions, consider alternatives.
- **Severity**: LOW.

### Note: exceljs deprecated transitive dependencies

The project backlog (BACKLOG-40) already tracks that exceljs pulls in deprecated transitive dependencies. This is a known issue. The package itself is maintained (last published 2024-12-20) but its dependency tree contains legacy packages. No security vulnerabilities are currently reported.

### No Deprecated Packages

None of the 22 direct dependencies are marked as deprecated in the npm registry.

---

## 9.4 License Compatibility

All licenses are permissive and compatible with commercial SaaS use:

| License | Count | Commercial SaaS Compatible |
|---------|-------|---------------------------|
| MIT | 17 | Yes |
| Apache-2.0 | 2 | Yes (requires attribution) |
| BSD-2-Clause | 1 | Yes |
| ISC | 1 | Yes |
| MIT-0 | 1 | Yes (no attribution required) |

**No copyleft licenses found.** No GPL, AGPL, LGPL, MPL, or any other copyleft license exists in the direct dependency set.

**Note**: The transitive dependency tree (563 packages) was not exhaustively audited for licenses in this pass. A full transitive license audit should be performed before any commercial distribution or franchise licensing. The `license-checker` tool reported the project itself as MIT. For a thorough transitive check, run `npx license-checker --production --failOn "GPL;AGPL"` against a fully installed node_modules.

**Recommendation**: Add a `license-checker` step to CI that fails on copyleft licenses to prevent future regressions.

---

## 9.5 Version Pinning Strategy

### Current Strategy

- **All 22 dependencies** use caret (`^`) ranges (e.g., `^4.18.2`)
- **Zero** use tilde (`~`) or exact pinning
- **package-lock.json**: Present (lockfile version 3, 255 KB)

### Analysis

The caret strategy (`^`) allows minor and patch updates within the same major version. Combined with a committed `package-lock.json`, this is a **standard and acceptable approach**:

- `package-lock.json` ensures deterministic installs in production (exact versions locked)
- `^` ranges allow `npm update` to pull compatible security patches
- No risk of surprise breaking changes (major version bumps are excluded)

### Recommendation

The current strategy is sound. For additional hardening:

1. **Run `npm ci` in production** (not `npm install`) to guarantee lockfile-exact installs
2. **Enable npm audit in CI** to catch newly disclosed vulnerabilities on every build
3. Consider `npm-check-updates` as a periodic maintenance tool to review available updates

---

## 9.6 Supply Chain Risks

| Risk | Status | Notes |
|------|--------|-------|
| Typosquatting | LOW | All dependencies are well-known, high-download packages |
| Lockfile integrity | OK | package-lock.json present and committed |
| Install scripts | PRESENT | `bcrypt` runs native compilation on install (expected for C++ bindings) |
| googleapis size | NOTED | googleapis is a very large package (~100MB). Consider importing only needed sub-packages (e.g., `@googleapis/sheets`) if bundle size or install time becomes an issue |

---

## 9.7 Summary of Findings

| # | Finding | Severity | Action Required |
|---|---------|----------|-----------------|
| 9.1 | Zero npm audit vulnerabilities | INFO | None |
| 9.2 | node-fetch v2 unmaintained (~2.3 years) | LOW | Migrate to native `fetch()` (Node 18+) |
| 9.3 | winston-daily-rotate-file infrequent updates | LOW | Monitor; no action now |
| 9.4 | All licenses permissive (MIT/Apache/BSD/ISC) | INFO | Add CI license gate before franchise |
| 9.5 | All deps use caret ranges with lockfile | INFO | Use `npm ci` in production deploys |
| 9.6 | exceljs has deprecated transitive deps | LOW | Already tracked as BACKLOG-40 |
| 9.7 | No transitive license audit performed | LOW | Run full check before commercial distribution |

---

## 9.8 Recommendations (Priority Order)

1. **Migrate off node-fetch v2** -- Replace with native `fetch()` available in Node 18+. This removes an unmaintained dependency and simplifies the stack. (Aligns with Node.js best practices.)

2. **Add CI pipeline checks** -- `npm audit --audit-level=high` and `npx license-checker --production --failOn "GPL;AGPL"` should run on every PR.

3. **Use `npm ci` in production** -- Ensures exact lockfile versions are installed, preventing drift.

4. **Evaluate googleapis sub-packages** -- If install time or disk usage on the Raspberry Pi is a concern, switch from the monolithic `googleapis` to specific API packages like `@googleapis/sheets`.

5. **Periodic dependency review** -- Schedule quarterly `npm outdated` review to stay current and avoid accumulating update debt.

---

**Overall Assessment**: The dependency posture is strong. Zero vulnerabilities, no copyleft licenses, a lean dependency count, and a committed lockfile. The only notable item is node-fetch v2 approaching end-of-practical-life, which has a clear migration path to Node.js native `fetch()`. No immediate action is required for production safety.
