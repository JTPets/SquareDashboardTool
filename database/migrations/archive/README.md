# Historical Migrations (Archive)

These are historical migration files for existing production databases that were deployed before the unified schema-manager approach.

**NOT needed for fresh installs** — `utils/schema-manager.js` creates the full schema directly.

**Kept for audit trail only.** Do not run these on a fresh install.

Migrations 003-075 cover the evolution from the initial schema through multi-tenancy, loyalty programs, delivery module, seniors discounts, cart activity, and catalog health.

Future migrations start at `001_*.sql` in `database/migrations/` (not this archive folder).
