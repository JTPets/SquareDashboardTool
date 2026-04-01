# Code Rules & Standards

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Architecture](./ARCHITECTURE.md) | [Database Rules](./DATABASE-RULES.md) | [Coding Patterns](./CODING-PATTERNS.md)
>
> **Last Updated**: 2026-04-01

---

## Code Limits

| Rule | Limit |
|------|-------|
| Function length | ≤ 100 lines |
| File length | ≤ 300 lines (split if larger) |
| Service scope | Single responsibility |
| Route logic | Validation + call service only |
| New files | Tests + docs reference required |
| New features | Tests required in same commit — no exceptions |
| Complexity | Explainable in one sentence |

## Dependencies

`npm install --save` or `--save-dev` only — never manually edit package.json. Commit package.json and package-lock.json together in the same commit as the code requiring the new dependency.

## Environment Variables

Any new `process.env.X` reference MUST have a corresponding entry in `.env.example` with a placeholder value and descriptive comment.

## HTML Pages

Every new HTML page MUST include shared utility scripts before page-specific scripts. Only include utilities the page's JS actually uses. Required order: `escape.js` → `toast.js` → `format-currency.js` → `date-format.js` → `your-page.js`. The test in `__tests__/frontend/utility-script-tags.test.js` enforces this — `npm test` will fail if a utility function is called but the script tag is missing.

## CSS Styles

No new `<style>` blocks in HTML pages. All shared styles go in `public/css/shared.css`. Page-specific styles only if truly unique to that page and documented with a comment explaining why.

## Logger Changes

Any change to `utils/logger.js` or `utils/log-sanitizer.js` must include a Winston integration test that verifies log entries actually appear in the output file. See `__tests__/utils/logger-integration.test.js`.

## Migrations

Every migration file MUST be wrapped in BEGIN/COMMIT. The test in `__tests__/database/schema-integrity.test.js` enforces this — `npm test` will fail if missing.

---

## Violations Policy

If any rule must be broken:
1. Add a comment at the top of the file/function explaining WHY
2. Log it in the Approved Violations table below
3. Create a backlog item to refactor if temporary

### Approved Violations

| Date | File | Rule Broken | Reason |
|------|------|-------------|--------|
| 2026-01-29 | utils/database.js | 2,397 line function | SQL schema definition, not logic |
| 2026-01-29 | server.js | 1,006 lines | Express entry point, already reduced 66% |
| 2026-01-29 | All LOW severity files | >300 lines | Stable code, refactor-on-touch policy |

**Policy**: Files are refactored when modified, not proactively. Touch it = fix it.

---

## Refactor-on-Touch: Files Over 500 Lines

Before modifying any file over 500 lines, produce a **module breakdown map** (filename, responsibility, line range, dependencies, extraction risk) and include it in the PR description or commit message. This ensures refactoring is planned, not ad-hoc. The map does not require immediate extraction — it documents the path for future work.

---

## New Code Checklists

### New Route
1. Create validator in `middleware/validators/routename.js`
2. Create route file in `routes/routename.js` using `asyncHandler`
3. Add to `server.js`
4. **Write tests in `__tests__/routes/routename.test.js` — mandatory, must be in the same commit**

### New Database Table
1. Add to `database/schema.sql`
2. Create migration `database/migrations/XXX_description.sql`
3. Include `merchant_id INTEGER REFERENCES merchants(id)` column
4. Add composite index with merchant_id as leading column

---

## PR Checklist

- [ ] No security vulnerabilities (parameterized queries, no error exposure)
- [ ] asyncHandler used (no manual try/catch in routes)
- [ ] merchant_id filter on ALL database queries
- [ ] Validators in `middleware/validators/`, not inline
- [ ] Business logic in services, not routes
- [ ] Tests added for new functionality
- [ ] Multi-step operations use transactions
