# Section 12: DEPLOYMENT & OPERATIONS

**Rating: NEEDS WORK**

**Auditor note**: Solid foundations — PM2 ecosystem config, automated migration runner, deploy script with tests, automated weekly backups. Key gaps: no off-site backup (local-only on same SD card), no rollback procedure, no PM2 log rotation, no external uptime monitoring.

---

## 12.1 PM2 Configuration

**Rating: PASS**

`ecosystem.config.js` is well-configured:

- **Memory limit**: `max_memory_restart: '500M'` — appropriate for Raspberry Pi
- **Restart policy**: `max_restarts: 10`, `min_uptime: '10s'` — prevents crash loops
- **Watch mode**: Configured with proper ignore list (node_modules, output, .git, .env)
- **Logging**: PM2 logs directed to `output/logs/` with date formatting
- **Mode**: Fork with `instances: 1` — correct for session-based Express on single-core Pi
- **Graceful shutdown**: `server.js` handles SIGTERM/SIGINT, drains connections, 45s forced exit timeout

**Minor concerns**:
- No `pm2-logrotate` module — PM2's own stdout/stderr logs (`pm2-combined.log`, `pm2-out.log`, `pm2-error.log`) will grow unbounded. Winston handles app logs, but PM2 logs are separate.
- `watch: true` in production is redundant since `scripts/deploy.sh` does `pm2 restart`. Could cause unexpected restarts if a file is touched.

---

## 12.2 Migration Files

**Rating: PASS**

### Structure

- `database/migrations/` — 6 active migration files (067-072)
- `database/migrations/archive/` — 66 archived migrations (001-066)
- `database/schema.sql` — canonical DDL (~2,397 lines)

### Migration Runner (`scripts/migrate.js`)

Proper automated runner with:
- `schema_migrations` tracking table
- Numbered file ordering
- Each migration in its own transaction (BEGIN/COMMIT)
- Stop-on-first-failure behavior
- Integrated into `scripts/deploy.sh` (runs automatically on deploy)

### Idempotency

Migrations use safe patterns:
- `IF NOT EXISTS` for CREATE TABLE/INDEX operations
- `DO $$ BEGIN ... EXCEPTION WHEN duplicate_column THEN NULL; END $$;` for ALTER TABLE
- `ON CONFLICT DO NOTHING` for seed data

### Deploy Script (`scripts/deploy.sh`)

Automated deploy pipeline: `git pull` → `npm ci` → `migrate` → `jest --ci` → `pm2 restart`. Tests must pass before restart.

### Minor Issue

Some migrations (001, 003) wrap themselves in `BEGIN`/`COMMIT` while the runner also wraps them — creating a nested transaction situation. Works by accident (PostgreSQL ignores nested BEGIN) but is inconsistent. No down/rollback migrations exist.

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

- `jobs/backup-job.js` — automated weekly backup (Sundays 2 AM, configurable via `BACKUP_CRON_SCHEDULE`)
- Uses `pg_dump` with gzip compression (level 9)
- Small backups emailed as attachments (<24MB); larger ones saved locally with rotation (keep last 4)
- Failed backups trigger email alerts
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

- Health check endpoint at `/api/health` (public) + `/api/health/detailed` (admin-only with Square connection status)
- Request logging with duration tracking (`server.js:243-258`)
- Separate error log files with extended retention
- PM2 provides basic process monitoring
- Email notifications for critical errors via `utils/email-notifier.js` with throttling
- 15 cron jobs provide self-healing (webhook retries, loyalty catchup, reconciliation)

**Missing**:
- No external uptime monitoring (UptimeRobot, Pingdom, etc.) — if the Pi goes down, nobody is notified
- No metrics/APM collection (Prometheus, Datadog, etc.)
- No disk space monitoring (critical for SD card)
- Email-only alerting is a single point of failure

---

## Summary of Findings

| Sub-section | Rating | Key Finding |
|-------------|--------|-------------|
| 12.1 PM2 Config | PASS | Well-configured with memory limits, restart policy, graceful shutdown. Missing PM2 log rotation. |
| 12.2 Migrations | PASS | Automated runner with tracking table, idempotent SQL, integrated into deploy pipeline |
| 12.3 Rollback | NEEDS WORK | No rollback procedure documented |
| 12.4 Backup/Recovery | NEEDS WORK | Automated weekly backups exist but stored locally on same device; no off-site replication |
| 12.5 Health/Monitoring | NEEDS WORK | Health endpoints and email alerting exist, but no external monitoring or disk space alerts |

## Recommendations

| Priority | Item | Effort |
|----------|------|--------|
| HIGH | Implement off-site database backup (rsync to cloud or second device) | 2-4 hours |
| HIGH | Set up external uptime monitoring (UptimeRobot or similar polling /api/health) | 1 hour |
| MEDIUM | Write disaster recovery runbook (fresh Pi setup → restore from backup) | 2-3 hours |
| MEDIUM | Document rollback procedure (git checkout + pm2 restart + migration revert) | 1 hour |
| MEDIUM | Install pm2-logrotate for PM2 stdout/stderr logs | 30 min |
| LOW | Add SD card health / disk space monitoring to cron | 1 hour |
