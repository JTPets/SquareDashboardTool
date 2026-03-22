#!/usr/bin/env bash
#
# deploy.sh — Pull latest, install deps, run tests, restart PM2 on success.
# Usage: ./scripts/deploy.sh
#
set -euo pipefail

APP_NAME="square-dashboard-addon"
LOG_DIR="output/logs"
DEPLOY_LOG="${LOG_DIR}/deploy.log"

log() {
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[${timestamp}] $*" | tee -a "$DEPLOY_LOG"
}

# Ensure log directory exists
mkdir -p "$LOG_DIR"

log "=== Deploy started ==="

# 1. Pull latest code
log "Pulling latest from origin..."
git pull origin main
log "Pull complete."

# 2. Install dependencies
log "Installing dependencies..."
npm ci
log "Dependencies installed."

# 3. Run database migrations
log "Running database migrations..."
node scripts/migrate.js
log "Migrations complete."

# 4. Run tests
log "Running tests..."
if npm test; then
    log "Tests passed."
else
    log "ERROR: Tests failed. Aborting deploy."
    exit 1
fi

# 5. Restart PM2
log "Restarting PM2 process '${APP_NAME}'..."
pm2 restart "$APP_NAME"
log "PM2 restart complete."

log "=== Deploy finished successfully ==="
