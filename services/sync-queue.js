/**
 * Sync Queue Service
 *
 * Manages in-progress and pending sync state for webhook-triggered operations.
 * Prevents duplicate concurrent syncs while ensuring no webhook data is missed.
 *
 * Pattern:
 * 1. If sync requested while another is in progress, mark as pending
 * 2. After sync completes, check if pending flag is set
 * 3. If pending, run follow-up sync to catch any changes that arrived during first sync
 *
 * State Persistence:
 * - In-progress state is persisted to sync_history table
 * - On startup, stale "running" entries are cleaned up
 * - Pending state remains in-memory (webhooks will re-trigger if needed)
 *
 * @module services/sync-queue
 */

const logger = require('../utils/logger');
const db = require('../utils/database');

// Stale sync threshold: syncs running longer than this are considered interrupted
const STALE_SYNC_THRESHOLD_MINUTES = 30;

class SyncQueue {
    constructor() {
        // Catalog sync state: merchantId -> boolean
        this.catalogInProgress = new Map();
        this.catalogPending = new Map();

        // Inventory sync state: merchantId -> boolean
        this.inventoryInProgress = new Map();
        this.inventoryPending = new Map();

        // Track if we've initialized from database
        this.initialized = false;
    }

    /**
     * Initialize sync queue state from database.
     * Cleans up stale "running" entries and restores in-progress state.
     * Should be called on server startup.
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            // Clean up stale "running" syncs (interrupted by server restart/crash)
            const staleResult = await db.query(`
                UPDATE sync_history
                SET status = 'interrupted',
                    error_message = 'Server restart detected - sync was interrupted',
                    completed_at = CURRENT_TIMESTAMP
                WHERE status = 'running'
                AND started_at < NOW() - INTERVAL '1 minute' * $1
                RETURNING sync_type, merchant_id
            `, [STALE_SYNC_THRESHOLD_MINUTES]);

            if (staleResult.rows.length > 0) {
                logger.warn('Cleaned up stale sync entries on startup', {
                    count: staleResult.rows.length,
                    entries: staleResult.rows
                });
            }

            // Check for any currently "running" syncs (started recently before restart)
            const runningResult = await db.query(`
                SELECT sync_type, merchant_id, started_at
                FROM sync_history
                WHERE status = 'running'
            `);

            // Restore in-progress state for recently started syncs
            // (These might still be running if the restart was very quick)
            for (const row of runningResult.rows) {
                if (row.sync_type === 'catalog' && row.merchant_id) {
                    this.catalogInProgress.set(row.merchant_id, true);
                    logger.info('Restored catalog sync in-progress state', {
                        merchantId: row.merchant_id,
                        startedAt: row.started_at
                    });
                } else if (row.sync_type === 'inventory' && row.merchant_id) {
                    this.inventoryInProgress.set(row.merchant_id, true);
                    logger.info('Restored inventory sync in-progress state', {
                        merchantId: row.merchant_id,
                        startedAt: row.started_at
                    });
                }
            }

            this.initialized = true;
            logger.info('Sync queue initialized', {
                staleCleaned: staleResult.rows.length,
                runningRestored: runningResult.rows.length
            });
        } catch (error) {
            logger.error('Failed to initialize sync queue', {
                error: error.message,
                stack: error.stack
            });
            // Don't throw - allow server to start even if this fails
            this.initialized = true;
        }
    }

    // ==================== Catalog Sync Queue ====================

    /**
     * Check if a catalog sync is currently in progress for a merchant
     * @param {number} merchantId - Internal merchant ID
     * @returns {boolean}
     */
    isCatalogSyncInProgress(merchantId) {
        return this.catalogInProgress.get(merchantId) === true;
    }

    /**
     * Set catalog sync in-progress state
     * @param {number} merchantId - Internal merchant ID
     * @param {boolean} value - Whether sync is in progress
     */
    setCatalogSyncInProgress(merchantId, value) {
        this.catalogInProgress.set(merchantId, value);
    }

    /**
     * Check if a catalog sync is pending (webhook arrived during active sync)
     * @param {number} merchantId - Internal merchant ID
     * @returns {boolean}
     */
    isCatalogSyncPending(merchantId) {
        return this.catalogPending.get(merchantId) === true;
    }

    /**
     * Set catalog sync pending state
     * @param {number} merchantId - Internal merchant ID
     * @param {boolean} value - Whether a follow-up sync is needed
     */
    setCatalogSyncPending(merchantId, value) {
        this.catalogPending.set(merchantId, value);
    }

    // ==================== Inventory Sync Queue ====================

    /**
     * Check if an inventory sync is currently in progress for a merchant
     * @param {number} merchantId - Internal merchant ID
     * @returns {boolean}
     */
    isInventorySyncInProgress(merchantId) {
        return this.inventoryInProgress.get(merchantId) === true;
    }

    /**
     * Set inventory sync in-progress state
     * @param {number} merchantId - Internal merchant ID
     * @param {boolean} value - Whether sync is in progress
     */
    setInventorySyncInProgress(merchantId, value) {
        this.inventoryInProgress.set(merchantId, value);
    }

    /**
     * Check if an inventory sync is pending (webhook arrived during active sync)
     * @param {number} merchantId - Internal merchant ID
     * @returns {boolean}
     */
    isInventorySyncPending(merchantId) {
        return this.inventoryPending.get(merchantId) === true;
    }

    /**
     * Set inventory sync pending state
     * @param {number} merchantId - Internal merchant ID
     * @param {boolean} value - Whether a follow-up sync is needed
     */
    setInventorySyncPending(merchantId, value) {
        this.inventoryPending.set(merchantId, value);
    }

    // ==================== High-Level Queue Execution ====================

    /**
     * Execute a sync operation with queue protection.
     * Handles in-progress/pending state management automatically.
     * Persists state to sync_history table for crash recovery.
     *
     * @param {'catalog'|'inventory'} type - Type of sync
     * @param {number} merchantId - Internal merchant ID
     * @param {Function} syncFn - Async function that performs the sync
     * @returns {Promise<{queued?: boolean, result?: any, followUpResult?: any, error?: string}>}
     */
    async executeWithQueue(type, merchantId, syncFn) {
        const isInProgress = type === 'catalog'
            ? this.isCatalogSyncInProgress(merchantId)
            : this.isInventorySyncInProgress(merchantId);

        const setPending = type === 'catalog'
            ? (v) => this.setCatalogSyncPending(merchantId, v)
            : (v) => this.setInventorySyncPending(merchantId, v);

        const setInProgress = type === 'catalog'
            ? (v) => this.setCatalogSyncInProgress(merchantId, v)
            : (v) => this.setInventorySyncInProgress(merchantId, v);

        const isPending = type === 'catalog'
            ? () => this.isCatalogSyncPending(merchantId)
            : () => this.isInventorySyncPending(merchantId);

        // If sync already running, mark as pending for follow-up
        if (isInProgress) {
            logger.info(`${type} sync already in progress - marking for follow-up sync`, {
                merchantId
            });
            setPending(true);
            return { queued: true };
        }

        // Mark sync as in progress (memory + database)
        setInProgress(true);
        setPending(false);
        await this._persistSyncStart(type, merchantId);

        const startTime = Date.now();
        try {
            const result = await syncFn();

            // Check if webhooks arrived during sync - fire follow-up async (non-blocking)
            if (isPending()) {
                logger.info(`Webhooks arrived during ${type} sync - scheduling follow-up sync`, {
                    merchantId
                });
                setPending(false);
                syncFn().catch(err => {
                    logger.error(`${type} follow-up sync failed`, {
                        merchantId, error: err.message, stack: err.stack
                    });
                });
            }

            // Persist success
            await this._persistSyncComplete(type, merchantId, 'success', Date.now() - startTime);
            return { result };
        } catch (error) {
            logger.error(`${type} sync via webhook failed`, {
                merchantId,
                error: error.message,
                stack: error.stack
            });

            // Persist failure
            await this._persistSyncComplete(type, merchantId, 'failed', Date.now() - startTime, error.message);
            return { error: error.message };
        } finally {
            // Always clear the in-progress flag
            setInProgress(false);
        }
    }

    /**
     * Persist sync start to database
     * @private
     */
    async _persistSyncStart(type, merchantId) {
        try {
            await db.query(`
                INSERT INTO sync_history (sync_type, merchant_id, started_at, status)
                VALUES ($1, $2, CURRENT_TIMESTAMP, 'running')
                ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
                    started_at = CURRENT_TIMESTAMP,
                    status = 'running',
                    completed_at = NULL,
                    error_message = NULL,
                    records_synced = 0
            `, [type, merchantId]);
        } catch (error) {
            // Log but don't fail - persistence is best-effort
            logger.warn('Failed to persist sync start', {
                type, merchantId, error: error.message
            });
        }
    }

    /**
     * Persist sync completion to database
     * @private
     */
    async _persistSyncComplete(type, merchantId, status, durationMs, errorMessage = null) {
        try {
            await db.query(`
                UPDATE sync_history
                SET status = $1,
                    completed_at = CURRENT_TIMESTAMP,
                    duration_seconds = $2,
                    error_message = $3,
                    synced_at = CASE WHEN $1 = 'success' THEN CURRENT_TIMESTAMP ELSE synced_at END
                WHERE sync_type = $4 AND merchant_id = $5
            `, [status, Math.round(durationMs / 1000), errorMessage, type, merchantId]);
        } catch (error) {
            // Log but don't fail - persistence is best-effort
            logger.warn('Failed to persist sync completion', {
                type, merchantId, status, error: error.message
            });
        }
    }

    /**
     * Get current queue status for debugging/monitoring
     * @returns {Object} Current state of all queues
     */
    getStatus() {
        return {
            catalog: {
                inProgress: Array.from(this.catalogInProgress.entries())
                    .filter(([, v]) => v)
                    .map(([k]) => k),
                pending: Array.from(this.catalogPending.entries())
                    .filter(([, v]) => v)
                    .map(([k]) => k)
            },
            inventory: {
                inProgress: Array.from(this.inventoryInProgress.entries())
                    .filter(([, v]) => v)
                    .map(([k]) => k),
                pending: Array.from(this.inventoryPending.entries())
                    .filter(([, v]) => v)
                    .map(([k]) => k)
            }
        };
    }

    /**
     * Clear all sync state (useful for testing or recovery)
     */
    clear() {
        this.catalogInProgress.clear();
        this.catalogPending.clear();
        this.inventoryInProgress.clear();
        this.inventoryPending.clear();
    }
}

// Export singleton instance
module.exports = new SyncQueue();
