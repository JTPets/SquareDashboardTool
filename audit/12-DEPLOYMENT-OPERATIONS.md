# Section 12: DEPLOYMENT & OPERATIONS

**Rating: NEEDS WORK**

**Auditor note**: Migrations are well-structured and idempotent. However, PM2 has no versioned config file, there is no rollback procedure, and backups are stored on the same device as the database — providing no protection against SD card failure.

---

## 12.1 PM2 Configuration

**Rating: NEEDS WORK**

There is **no PM2 ecosystem configuration file** (`ecosystem.config.js` or `pm2.config.js`). PM2 is used but configured entirely via CLI commands.

- `package.json` scripts: `"start": "node server.js"` — no PM2-specific start script
- CLAUDE.md documents `pm2 restart square-dashboard-addon` as the deploy command
- No ecosystem file found in the codebase

**Missing without an ecosystem file**:
- No documented memory limits (critical on a Pi with limited RAM)
- No max restart count (infinite restart loops possible)
- No cluster mode configuration
- No environment variable management through PM2
- No log rotation through PM2 (though Winston handles its own rotation)

**Severity: MEDIUM** — Process configuration lives in PM2's runtime state, not in version control. A fresh deploy or PM2 reinstall would require manual reconfiguration.

---

## 12.2 Migration Files

**Rating: PASS**

### Structure

- `database/migrations/` — 6 active migration files (067-072)
- `database/migrations/archive/` — 66 archived migrations (001-066)
- `database/schema.sql` — canonical DDL (~2,397 lines)

### Idempotency

Migrations use safe patterns:
- `IF NOT EXISTS` for CREATE TABLE/INDEX operations
- `DO $$ BEGIN ... EXCEPTION WHEN duplicate_column THEN NULL; END $$;` for ALTER TABLE
- `ON CONFLICT DO NOTHING` for seed data

### Ordering

Numbered prefix system (001-072) provides clear ordering. Active migrations start at 067.

### Runner

No automated migration runner — migrations run manually via `psql -f` (documented in CLAUDE.md). Acceptable for single-Pi deployment but needs automation pre-franchise.

---

## 12.3 Rollback Procedure

**Rating: NEEDS WORK**

Only one rollback migration exists: `database/migrations/archive/005_multi_tenant_rollback.sql`.

**Missing**:
- No rollback documentation in `docs/`
- No operational runbook for reverting a bad deploy
- No `git revert` or deployment rollback procedure documented
- PM2 supports `pm2 deploy revert` but no deploy configuration exists

**Severity: MEDIUM** — For single-store, `git checkout` + `pm2 restart` is sufficient. Must be documented before onboarding other tenants.

---

## 12.4 Backup & Recovery

**Rating: NEEDS WORK**

### What Exists

- `scripts/backup-database.sh` — uses `pg_dump`, stores in `/home/user/backups/`, keeps last 7 daily backups
- Winston log rotation (14-day app, 30-day error)
- PM2 auto-restart on crash

### What's Missing

| Gap | Risk |
|-----|------|
| Off-site backup | SD card failure loses everything (database + backups) |
| Recovery runbook | No documented procedure for restoring from scratch |
| SD card health monitoring | No smartctl or wear-level monitoring |
| Documented RTO/RPO targets | No defined recovery objectives |

**Severity: HIGH** — Backups stored on the same SD card as the database provide zero protection against card failure. This is the most critical operational gap for a production SaaS.

---

## 12.5 Health Check & Monitoring

**Rating: PASS**

- Health check endpoint at `/api/health`
- Request logging with duration tracking (`server.js:243-258`)
- Separate error log files with extended retention
- PM2 provides basic process monitoring
- Email notifications for critical errors via `utils/email-notifier.js`

---

## Summary of Findings

| Sub-section | Rating | Key Finding |
|-------------|--------|-------------|
| 12.1 PM2 Config | NEEDS WORK | No ecosystem.config.js — config lives in PM2 runtime only |
| 12.2 Migrations | PASS | Idempotent, numbered, well-structured |
| 12.3 Rollback | NEEDS WORK | No rollback procedure documented |
| 12.4 Backup/Recovery | NEEDS WORK | Backups on same device; no off-site backup or recovery runbook |
| 12.5 Health/Monitoring | PASS | Health endpoint, error alerting, request logging |

## Recommendations

| Priority | Item | Effort |
|----------|------|--------|
| HIGH | Implement off-site database backup (rsync to cloud or second device) | 2-4 hours |
| HIGH | Create `ecosystem.config.js` with memory limits, restart policy, env vars | 1 hour |
| MEDIUM | Write disaster recovery runbook (fresh Pi setup → restore from backup) | 2-3 hours |
| MEDIUM | Document rollback procedure (git checkout + pm2 restart + migration revert) | 1 hour |
| LOW | Add SD card health monitoring to cron | 1 hour |
