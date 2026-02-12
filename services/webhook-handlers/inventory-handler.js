/**
 * Inventory Webhook Handler
 *
 * Handles Square webhook events related to inventory counts and
 * invoice-driven committed inventory tracking (BACKLOG-10).
 *
 * Event types handled:
 * - inventory.count.updated
 * - invoice.created
 * - invoice.updated
 * - invoice.published
 * - invoice.canceled
 * - invoice.deleted
 * - invoice.refunded
 * - invoice.scheduled_charge_failed
 *
 * @module services/webhook-handlers/inventory-handler
 */

const logger = require('../../utils/logger');
const db = require('../../utils/database');
const squareApi = require('../../utils/square-api');
const { getSquareClientForMerchant } = require('../../middleware/merchant');

// Invoice statuses that represent committed (reserved) inventory
const OPEN_INVOICE_STATUSES = ['DRAFT', 'UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'];

// Invoice statuses that mean inventory is no longer committed
const TERMINAL_INVOICE_STATUSES = ['PAID', 'CANCELED', 'REFUNDED'];

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

    /**
     * Handle invoice.created, invoice.updated, invoice.published,
     * invoice.refunded, or invoice.scheduled_charge_failed events.
     *
     * For open invoices: fetch order line items and upsert into committed_inventory.
     * For terminal invoices (PAID/CANCELED/REFUNDED): remove from committed_inventory.
     * Then rebuild the RESERVED_FOR_SALE aggregate in inventory_counts.
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with committed inventory details
     */
    async handleInvoiceChanged(context) {
        const { data, merchantId, entityId } = context;
        const result = { handled: true };

        if (!merchantId) {
            logger.warn('Cannot process invoice - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        const invoice = data.invoice || data;
        const invoiceId = entityId || invoice?.id;

        if (!invoiceId) {
            logger.warn('Invoice webhook missing invoice ID', { merchantId });
            result.skipped = true;
            return result;
        }

        const invoiceStatus = invoice?.status;

        logger.info('Invoice change detected via webhook', {
            invoiceId,
            status: invoiceStatus,
            merchantId
        });

        // Terminal status → remove commitment
        if (TERMINAL_INVOICE_STATUSES.includes(invoiceStatus)) {
            return this._removeInvoiceCommitment(merchantId, invoiceId, invoiceStatus);
        }

        // Open status → upsert commitment from order line items
        if (OPEN_INVOICE_STATUSES.includes(invoiceStatus)) {
            return this._upsertInvoiceCommitment(merchantId, invoiceId, invoice);
        }

        // Unknown status — log and skip
        logger.info('Invoice status not actionable for committed inventory', {
            invoiceId,
            status: invoiceStatus,
            merchantId
        });
        result.skipped = true;
        return result;
    }

    /**
     * Handle invoice.canceled or invoice.deleted events.
     * Removes all committed inventory rows for this invoice and rebuilds aggregate.
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with removal details
     */
    async handleInvoiceClosed(context) {
        const { data, merchantId, entityId } = context;
        const result = { handled: true };

        if (!merchantId) {
            logger.warn('Cannot process invoice close - merchant not found');
            result.error = 'Merchant not found';
            return result;
        }

        const invoice = data.invoice || data;
        const invoiceId = entityId || invoice?.id;

        if (!invoiceId) {
            logger.warn('Invoice close webhook missing invoice ID', { merchantId });
            result.skipped = true;
            return result;
        }

        logger.info('Invoice closed/deleted via webhook', {
            invoiceId,
            status: invoice?.status,
            merchantId
        });

        return this._removeInvoiceCommitment(merchantId, invoiceId, invoice?.status || 'CANCELED');
    }

    /**
     * Upsert committed inventory from an invoice's order line items.
     *
     * @private
     * @param {number} merchantId
     * @param {string} invoiceId - Square invoice ID
     * @param {Object} invoice - Invoice data from webhook
     * @returns {Promise<Object>} Handler result
     */
    async _upsertInvoiceCommitment(merchantId, invoiceId, invoice) {
        const result = { handled: true };

        try {
            const orderId = invoice?.order_id;
            if (!orderId) {
                // Need to fetch invoice to get order_id
                const fullInvoice = await this._fetchInvoice(merchantId, invoiceId);
                if (!fullInvoice?.order_id) {
                    logger.warn('Invoice has no order_id, skipping committed inventory', {
                        invoiceId, merchantId
                    });
                    result.skipped = true;
                    return result;
                }
                return this._processOrderForCommitment(
                    merchantId, invoiceId, fullInvoice.order_id, fullInvoice.status
                );
            }

            return this._processOrderForCommitment(
                merchantId, invoiceId, orderId, invoice.status
            );
        } catch (error) {
            logger.error('Failed to upsert invoice commitment', {
                invoiceId, merchantId, error: error.message
            });
            result.error = error.message;
            return result;
        }
    }

    /**
     * Fetch order and upsert line items into committed_inventory, then rebuild aggregate.
     *
     * @private
     * @param {number} merchantId
     * @param {string} invoiceId
     * @param {string} orderId
     * @param {string} invoiceStatus
     * @returns {Promise<Object>} Handler result
     */
    async _processOrderForCommitment(merchantId, invoiceId, orderId, invoiceStatus) {
        const result = { handled: true };

        // Fetch order to get line items with catalog_object_id
        const squareClient = await getSquareClientForMerchant(merchantId);
        const orderResponse = await squareClient.orders.get({ orderId });
        const order = orderResponse.order;

        if (!order) {
            logger.warn('Order not found for invoice commitment', {
                orderId, invoiceId, merchantId
            });
            result.skipped = true;
            return result;
        }

        const lineItems = order.lineItems || order.line_items || [];
        const locationId = order.locationId || order.location_id;

        if (lineItems.length === 0) {
            logger.info('Invoice order has no line items', { orderId, invoiceId, merchantId });
            result.skipped = true;
            return result;
        }

        // Use transaction: delete old rows for this invoice, insert new ones
        await db.transaction(async (client) => {
            // Remove existing rows for this invoice (handles line item changes)
            await client.query(
                'DELETE FROM committed_inventory WHERE merchant_id = $1 AND square_invoice_id = $2',
                [merchantId, invoiceId]
            );

            // Insert each line item
            let itemsInserted = 0;
            for (const item of lineItems) {
                const variationId = item.catalogObjectId || item.catalog_object_id;
                const itemLocationId = locationId;
                const quantity = parseInt(item.quantity) || 0;

                if (!variationId || quantity <= 0 || !itemLocationId) continue;

                await client.query(`
                    INSERT INTO committed_inventory
                        (merchant_id, square_invoice_id, square_order_id, catalog_object_id,
                         location_id, quantity, invoice_status, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                `, [merchantId, invoiceId, orderId, variationId, itemLocationId, quantity, invoiceStatus]);
                itemsInserted++;
            }

            result.committedInventory = {
                invoiceId,
                orderId,
                status: invoiceStatus,
                lineItemsTracked: itemsInserted
            };
        });

        // Rebuild RESERVED_FOR_SALE aggregate
        await this._rebuildReservedForSaleAggregate(merchantId);

        logger.info('Invoice commitment upserted', {
            invoiceId,
            orderId,
            status: invoiceStatus,
            lineItems: result.committedInventory.lineItemsTracked,
            merchantId
        });

        return result;
    }

    /**
     * Remove all committed inventory rows for an invoice and rebuild aggregate.
     *
     * @private
     * @param {number} merchantId
     * @param {string} invoiceId
     * @param {string} status - Terminal status for logging
     * @returns {Promise<Object>} Handler result
     */
    async _removeInvoiceCommitment(merchantId, invoiceId, status) {
        const result = { handled: true };

        try {
            const deleteResult = await db.query(
                'DELETE FROM committed_inventory WHERE merchant_id = $1 AND square_invoice_id = $2',
                [merchantId, invoiceId]
            );

            result.committedInventory = {
                invoiceId,
                status,
                rowsRemoved: deleteResult.rowCount
            };

            // Rebuild RESERVED_FOR_SALE aggregate
            await this._rebuildReservedForSaleAggregate(merchantId);

            logger.info('Invoice commitment removed', {
                invoiceId,
                status,
                rowsRemoved: deleteResult.rowCount,
                merchantId
            });
        } catch (error) {
            logger.error('Failed to remove invoice commitment', {
                invoiceId, merchantId, error: error.message
            });
            result.error = error.message;
        }

        return result;
    }

    /**
     * Rebuild the RESERVED_FOR_SALE aggregate in inventory_counts from committed_inventory.
     * Runs inside a transaction: deletes all RESERVED_FOR_SALE rows, then inserts
     * aggregated quantities from committed_inventory.
     *
     * @private
     * @param {number} merchantId
     */
    async _rebuildReservedForSaleAggregate(merchantId) {
        await db.transaction(async (client) => {
            // Clear existing RESERVED_FOR_SALE for this merchant
            await client.query(
                "DELETE FROM inventory_counts WHERE state = 'RESERVED_FOR_SALE' AND merchant_id = $1",
                [merchantId]
            );

            // Rebuild from committed_inventory (aggregate across all open invoices)
            await client.query(`
                INSERT INTO inventory_counts
                    (catalog_object_id, location_id, state, quantity, merchant_id, updated_at)
                SELECT
                    catalog_object_id,
                    location_id,
                    'RESERVED_FOR_SALE',
                    SUM(quantity),
                    $1,
                    NOW()
                FROM committed_inventory
                WHERE merchant_id = $1
                GROUP BY catalog_object_id, location_id
                ON CONFLICT (catalog_object_id, location_id, state, merchant_id)
                DO UPDATE SET
                    quantity = EXCLUDED.quantity,
                    updated_at = NOW()
            `, [merchantId]);
        });

        logger.debug('RESERVED_FOR_SALE aggregate rebuilt from committed_inventory', { merchantId });
    }

    /**
     * Fetch a single invoice from Square API.
     *
     * @private
     * @param {number} merchantId
     * @param {string} invoiceId
     * @returns {Promise<Object|null>} Invoice object or null
     */
    async _fetchInvoice(merchantId, invoiceId) {
        try {
            const squareClient = await getSquareClientForMerchant(merchantId);
            const response = await squareClient.invoices.get({ invoiceId });
            return response.invoice || null;
        } catch (error) {
            logger.error('Failed to fetch invoice from Square', {
                invoiceId, merchantId, error: error.message
            });
            return null;
        }
    }
}

module.exports = InventoryHandler;
