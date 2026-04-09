# Setup & Deployment

---

## Prerequisites

- **Node.js** 18+
- **PostgreSQL** 15+
- **PM2** — production process manager (`npm install -g pm2`)
- **Square Developer Account** — OAuth app credentials
- Optional: **Cloudflare Tunnel** for HTTPS

---

## Quick Start

```bash
git clone <repo-url> && cd SquareDashboardTool
npm install
cp .env.example .env
# Edit .env — see Environment Configuration below
```

---

## Environment Configuration

Copy `.env.example` and fill in all values. Key variables:

| Variable | Purpose |
|----------|---------|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL connection |
| `SESSION_SECRET` | Session encryption (generate: `openssl rand -hex 32`) |
| `TOKEN_ENCRYPTION_KEY` | OAuth token encryption (generate: `openssl rand -hex 32`) |
| `SQUARE_APPLICATION_ID` | Square OAuth app ID |
| `SQUARE_APPLICATION_SECRET` | Square OAuth secret |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Webhook verification key |
| `BASE_URL` | App URL (e.g., `https://your-domain.com`) |

All optional variables are documented with comments in `.env.example`.

---

## Database Setup

### Fresh Install

```bash
set -a && source .env && set +a

# Create schema
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f database/schema.sql

# Run migrations
npm run migrate

# Verify schema (optional)
node scripts/validate-schema.js
```

### Existing Install

```bash
set -a && source .env && set +a && npm run migrate
```

---

## Running the App

```bash
npm run dev                  # Development (auto-reload)
npm start                    # Production
pm2 start server.js --name sqtools   # PM2 (recommended for production)
```

---

## Running Tests

```bash
npm test                     # 5,464 tests / 268 suites
```

All tests must pass before deploying.

---

## Deployment

### Manual Deploy

```bash
cd /path/to/SquareDashboardTool
git pull origin main
npm install --production
npm test
pm2 restart sqtools
```

### Using deploy.sh

```bash
./scripts/deploy.sh
```

Pulls latest code, installs dependencies, runs tests, restarts PM2.

---

## Square OAuth Setup

1. Create an app at the Square Developer Dashboard
2. Set OAuth redirect URL: `{BASE_URL}/api/square-oauth/callback`
3. Add webhook subscription URL: `{BASE_URL}/api/webhooks/square`
4. Copy credentials to `.env`

After starting the app, connect a Square account via the login page.

---

## Cloudflare Tunnel (HTTPS)

SqTools uses Cloudflare Tunnel for HTTPS without exposing the server directly.

1. Install `cloudflared` on the host
2. Create a tunnel: `cloudflared tunnel create sqtools`
3. Configure DNS to point your domain to the tunnel
4. Run: `cloudflared tunnel run sqtools`

The tunnel forwards HTTPS traffic to `localhost:3000`.

---

## Database Shell

```bash
set -a && source .env && set +a
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
```

---

## Log Files

```bash
tail -f output/logs/app-*.log     # Application logs
tail -f output/logs/error-*.log   # Error logs only
```
