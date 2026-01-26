/**
 * Inventory Webhook Handler
 *
 * Handles Square webhook events related to inventory counts.
 *
 * Event types handled:
 * - inventory.count.updated
 *
 * @module services/webhook-handlers/inventory-handler
 */

const logger = require('../../utils/logger');
const squareApi = require('../../utils/square-api');

class InventoryHandler {
    /**
     * @param {Object} syncQueue - Sync queue service instance
     */
    constructor(syncQueue) {
        this.syncQueue = syncQueue;
    }

    /**
     * Handle inventory.count.updated event
     * Syncs inventory from Square when changes are detected
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with sync details
     */
    async handleInventoryCountUpdated(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (process.env.WEBHOOK_INVENTORY_SYNC === 'false') {
            logger.info('Inventory webhook received but WEBHOOK_INVENTORY_SYNC is disabled');
            result.skipped = true;
            return result;
        }

        if (!merchantId) {
            logger.warn('Cannot sync inventory - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        const inventoryChange = data.inventory_count;

        // Use sync queue to prevent duplicate concurrent syncs
        const syncResult = await this.syncQueue.executeWithQueue(
            'inventory',
            merchantId,
            async () => {
                logger.info('Inventory change detected via webhook', {
                    catalogObjectId: inventoryChange?.catalog_object_id,
                    quantity: inventoryChange?.quantity,
                    locationId: inventoryChange?.location_id,
                    merchantId
                });
                return await squareApi.syncInventory(merchantId);
            }
        );

        if (syncResult.queued) {
            result.queued = true;
        } else if (syncResult.error) {
            result.error = syncResult.error;
        } else {
            result.inventory = {
                count: syncResult.result,
                catalogObjectId: inventoryChange?.catalog_object_id
            };
            logger.info('Inventory sync completed via webhook', { count: syncResult.result });

            if (syncResult.followUpResult) {
                result.followUpSync = { count: syncResult.followUpResult };
                logger.info('Follow-up inventory sync completed', { count: syncResult.followUpResult });
            }
        }

        return result;
    }
}

module.exports = InventoryHandler;
