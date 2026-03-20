# Section 1: SECRET SCAN

**Rating: NEEDS WORK**

## 1.1 Git History Scan

**PASS** — No real API keys, tokens, passwords, or private keys found in git history.

Scanned for:
- Square token prefixes (`sq0`, `EQBB`)
- Google API key prefix (`AIza`)
- Anthropic API key prefix (`sk-ant-`) — only test mocks and validation code
- Private key headers (`BEGIN RSA PRIVATE KEY`, etc.)
- Hardcoded password assignments in non-test JS files

All `sk-ant-` references are validation logic (checking format) or test mocks with fake values. No real credentials leaked.

---

## 1.2 `.gitignore` Completeness

**NEEDS WORK**

`.gitignore` covers the basics (`.env`, `node_modules/`, `logs/`, `output/`), but has issues:

### Finding 1.2.1 — Suspicious gitignore entries suggest past accidents

**Severity: MEDIUM**

The `.gitignore` contains entries that look like they were added *after* files were accidentally created in the repo root:

```
.env.save
core
FETCH_HEAD
et -a
2026-*
check_invoice.js
```

- `et -a` — This is a typo from running `set -a` (sourcing `.env`). Someone ran `et -a` which created a file or directory.
- `core` — A core dump was generated at some point.
- `2026-*` — Timestamped files were created in the repo root.
- `check_invoice.js` — A one-off debug script was created in the repo root.

**Impact**: None currently (files are ignored), but this indicates sloppy operational practices. The `et -a` entry specifically suggests `.env` was sourced in the repo root context — if `set -a && source .env` failed partway, env vars could have been partially loaded.

**Fix**: Clean up these entries. Add a comment block explaining they're historical cleanup. More importantly, verify none of these files were ever committed:
```bash
git log --all -- 'core' 'et -a' 'FETCH_HEAD' 'check_invoice.js' '.env.save'
```
Confirmed: none were committed.

### Finding 1.2.2 — Missing gitignore entries for open-source release

**Severity: LOW**

For an open-source project, consider adding:

```gitignore
# Secrets that might be created
*.secret
*.credentials
service-account*.json
*-credentials.json
*.p12
*.pem
*.key

# Storage directories with runtime data
storage/
```

---

## 1.3 `.env.example` Review

**NEEDS WORK**

`.env.example` exists and contains NO real values — all placeholders like `your_square_access_token_here`. This is correct.

### Finding 1.3.1 — Undocumented environment variables

**Severity: MEDIUM**

23 environment variables are used in code (`process.env.X`) but missing from `.env.example`:

| Variable | Where Used | Risk |
|----------|-----------|------|
| `OPENROUTESERVICE_API_KEY` | `services/delivery/delivery-service.js:27` | **Secret** — API key with no documentation |
| `DATABASE_URL` | `utils/database.js` | Alternative DB config — should be documented |
| `BASE_URL` | Various | Fallback URL config |
| `POD_STORAGE_DIR` | Storage path config | Operational |
| `ADMIN_EMAIL` | `scripts/init-admin.js` | Script-only, acceptable |
| `ADMIN_PASSWORD` | `scripts/init-admin.js` | Script-only, acceptable |
| `CART_ACTIVITY_CLEANUP_CRON` | Cron schedule | Operational |
| `CATALOG_HEALTH_CRON` | Cron schedule | Operational |
| `COMMITTED_INVENTORY_RECONCILIATION_CRON` | Cron schedule | Operational |
| `LOYALTY_AUDIT_CRON` | Cron schedule | Operational |
| `LOYALTY_CATCHUP_CRON` | Cron schedule | Operational |
| `LOYALTY_SYNC_RETRY_CRON` | Cron schedule | Operational |
| `SENIORS_DISCOUNT_CRON` | Cron schedule | Operational |
| `TRIAL_EXPIRY_CRON` | Cron schedule | Operational |
| `WEBHOOK_CLEANUP_CRON_SCHEDULE` | Cron schedule | Operational |
| `WEBHOOK_RETRY_CRON_SCHEDULE` | Cron schedule | Operational |
| `SYNC_CATALOG_INTERVAL` | Sync config (legacy?) | Operational |
| `SYNC_INVENTORY_INTERVAL` | Sync config (legacy?) | Operational |
| `SYNC_SALES_INTERVAL` | Sync config (legacy?) | Operational |
| `TZ` | Timezone override | Operational |

**Fix**: Add all undocumented env vars to `.env.example` with placeholder values and comments. Priority on `OPENROUTESERVICE_API_KEY` and `DATABASE_URL` since they're secrets/connection strings.

### Finding 1.3.2 — `.env.example` documents vars not used in code

**Severity: LOW**

These vars are in `.env.example` but have zero `process.env` references in JS code:
- `SUBSCRIPTION_CHECK_ENABLED`
- `PLATFORM_OWNER_MERCHANT_ID`

Either dead config or planned features. Remove or annotate as "planned".

---

## 1.4 Session Secret Handling

**PASS**

`server.js:182-206` — Session secret falls back to `crypto.randomBytes(64)` in development and **exits the process** in production if `SESSION_SECRET` is not set. This is correct behavior.

---

## 1.5 Token Encryption Key Handling

**PASS**

`utils/token-encryption.js:30` — Reads `TOKEN_ENCRYPTION_KEY` from env. Used for AES-256-GCM encryption of Square OAuth tokens at rest.

---

## 1.6 No Leaked Files

**PASS**

- No `.pem`, `.key`, `.p12`, `.pfx` files in the repository
- No `.env` file committed (confirmed via git history)
- `storage/pod/` is gitignored

---

## Summary

| Check | Result |
|-------|--------|
| Secrets in git history | PASS |
| `.gitignore` completeness | NEEDS WORK (1.2.1, 1.2.2) |
| `.env.example` — no real values | PASS |
| `.env.example` — completeness | NEEDS WORK (1.3.1, 1.3.2) |
| Session secret handling | PASS |
| Token encryption key | PASS |
| No leaked files | PASS |

**Overall: NEEDS WORK** — No secrets leaked, but 23 undocumented env vars (including one API key) and sloppy gitignore hygiene need cleanup before open-source release.
