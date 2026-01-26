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
 * @module services/sync-queue
 */

const logger = require('../utils/logger');

class SyncQueue {
    constructor() {
        // Catalog sync state: merchantId -> boolean
        this.catalogInProgress = new Map();
        this.catalogPending = new Map();

        // Inventory sync state: merchantId -> boolean
        this.inventoryInProgress = new Map();
        this.inventoryPending = new Map();
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

        // Mark sync as in progress
        setInProgress(true);
        setPending(false);

        try {
            const result = await syncFn();

            // Check if webhooks arrived during sync - run follow-up if needed
            if (isPending()) {
                logger.info(`Webhooks arrived during ${type} sync - running follow-up sync`, {
                    merchantId
                });
                setPending(false);
                const followUpResult = await syncFn();
                return { result, followUpResult };
            }

            return { result };
        } catch (error) {
            logger.error(`${type} sync via webhook failed`, {
                merchantId,
                error: error.message,
                stack: error.stack
            });
            return { error: error.message };
        } finally {
            // Always clear the in-progress flag
            setInProgress(false);
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
