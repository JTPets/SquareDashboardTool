/**
 * Catalog Webhook Handler
 *
 * Handles Square webhook events related to catalog, vendors, locations,
 * and customer updates (delivery note sync).
 *
 * Event types handled:
 * - catalog.version.updated
 * - vendor.created
 * - vendor.updated
 * - location.created
 * - location.updated
 * - customer.updated
 *
 * @module services/webhook-handlers/catalog-handler
 */

const logger = require('../../utils/logger');
const db = require('../../utils/database');
const squareApi = require('../../utils/square-api');
const loyaltyService = require('../../utils/loyalty-service');

class CatalogHandler {
    /**
     * @param {Object} syncQueue - Sync queue service instance
     */
    constructor(syncQueue) {
        this.syncQueue = syncQueue;
    }

    /**
     * Handle catalog.version.updated event
     * Syncs catalog from Square when changes are detected
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with sync details
     */
    async handleCatalogVersionUpdated(context) {
        const { merchantId } = context;
        const result = { handled: true };

        if (process.env.WEBHOOK_CATALOG_SYNC === 'false') {
            logger.info('Catalog webhook received but WEBHOOK_CATALOG_SYNC is disabled');
            result.skipped = true;
            return result;
        }

        if (!merchantId) {
            logger.warn('Cannot sync catalog - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        // Use sync queue to prevent duplicate concurrent syncs
        const syncResult = await this.syncQueue.executeWithQueue(
            'catalog',
            merchantId,
            async () => {
                logger.info('Catalog change detected via webhook, syncing...', { merchantId });
                return await squareApi.syncCatalog(merchantId);
            }
        );

        if (syncResult.queued) {
            result.queued = true;
        } else if (syncResult.error) {
            result.error = syncResult.error;
        } else {
            result.catalog = {
                items: syncResult.result?.items,
                variations: syncResult.result?.variations
            };
            logger.info('Catalog sync completed via webhook', result.catalog);

            if (syncResult.followUpResult) {
                result.followUpSync = {
                    items: syncResult.followUpResult.items,
                    variations: syncResult.followUpResult.variations
                };
                logger.info('Follow-up catalog sync completed', result.followUpSync);
            }
        }

        return result;
    }

    /**
     * Handle customer.updated event
     * Syncs customer notes to delivery orders and runs loyalty catchup
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with sync details
     */
    async handleCustomerUpdated(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (!data.customer || !merchantId) {
            return result;
        }

        const customerId = data.customer.id;
        const customerNote = data.customer.note || null;

        // Update customer_note on all delivery orders for this customer
        const updateResult = await db.query(
            `UPDATE delivery_orders
             SET customer_note = $1, updated_at = NOW()
             WHERE merchant_id = $2 AND square_customer_id = $3`,
            [customerNote, merchantId, customerId]
        );

        if (updateResult.rowCount > 0) {
            logger.info('Customer notes synced via webhook', {
                merchantId,
                customerId,
                ordersUpdated: updateResult.rowCount
            });
            result.customerNotes = {
                customerId,
                ordersUpdated: updateResult.rowCount
            };
        }

        // Run loyalty catchup - customer phone/email might have changed,
        // allowing us to link previously untracked orders
        const catchupResult = await loyaltyService.runLoyaltyCatchup({
            merchantId,
            customerIds: [customerId],
            periodDays: 1, // 24 hours - loyalty events happen same-day
            maxCustomers: 1
        });

        if (catchupResult.ordersNewlyTracked > 0) {
            logger.info('Loyalty catchup found untracked orders via customer.updated', {
                customerId,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked
            });
            result.loyaltyCatchup = {
                customerId,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked
            };
        }

        return result;
    }

    /**
     * Handle vendor.created event
     * Upserts vendor to local database
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with vendor details
     */
    async handleVendorCreated(context) {
        return this._handleVendorChange(context);
    }

    /**
     * Handle vendor.updated event
     * Upserts vendor to local database
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with vendor details
     */
    async handleVendorUpdated(context) {
        return this._handleVendorChange(context);
    }

    /**
     * Internal handler for vendor create/update events
     * @private
     */
    async _handleVendorChange(context) {
        const { data, merchantId, event } = context;
        const result = { handled: true };

        if (process.env.WEBHOOK_CATALOG_SYNC === 'false') {
            logger.info('Vendor webhook received but WEBHOOK_CATALOG_SYNC is disabled');
            result.skipped = true;
            return result;
        }

        if (!merchantId) {
            logger.warn('Cannot sync vendor - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        const vendor = data.vendor;
        if (!vendor) {
            return result;
        }

        logger.info('Vendor change detected via webhook', {
            vendorId: vendor.id,
            vendorName: vendor.name,
            status: vendor.status,
            eventType: event.type,
            merchantId
        });

        // Sync the specific vendor directly
        await db.query(`
            INSERT INTO vendors (
                id, name, status, contact_name, contact_email, contact_phone, merchant_id, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                status = EXCLUDED.status,
                contact_name = EXCLUDED.contact_name,
                contact_email = EXCLUDED.contact_email,
                contact_phone = EXCLUDED.contact_phone,
                merchant_id = EXCLUDED.merchant_id,
                updated_at = CURRENT_TIMESTAMP
        `, [
            vendor.id,
            vendor.name,
            vendor.status,
            vendor.contacts?.[0]?.name || null,
            vendor.contacts?.[0]?.email_address || null,
            vendor.contacts?.[0]?.phone_number || null,
            merchantId
        ]);

        result.vendor = {
            id: vendor.id,
            name: vendor.name,
            status: vendor.status
        };

        logger.info('Vendor synced via webhook', {
            vendorId: vendor.id,
            vendorName: vendor.name
        });

        return result;
    }

    /**
     * Handle location.created event
     * Upserts location to local database
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with location details
     */
    async handleLocationCreated(context) {
        return this._handleLocationChange(context);
    }

    /**
     * Handle location.updated event
     * Upserts location to local database
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with location details
     */
    async handleLocationUpdated(context) {
        return this._handleLocationChange(context);
    }

    /**
     * Internal handler for location create/update events
     * @private
     */
    async _handleLocationChange(context) {
        const { data, merchantId, event } = context;
        const result = { handled: true };

        if (process.env.WEBHOOK_CATALOG_SYNC === 'false') {
            logger.info('Location webhook received but WEBHOOK_CATALOG_SYNC is disabled');
            result.skipped = true;
            return result;
        }

        if (!merchantId) {
            logger.warn('Cannot sync location - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        const location = data.location;
        if (!location) {
            return result;
        }

        logger.info('Location change detected via webhook', {
            locationId: location.id,
            locationName: location.name,
            status: location.status,
            eventType: event.type,
            merchantId
        });

        // Sync the specific location directly
        await db.query(`
            INSERT INTO locations (id, name, square_location_id, active, address, timezone, merchant_id, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                square_location_id = EXCLUDED.square_location_id,
                active = EXCLUDED.active,
                address = EXCLUDED.address,
                timezone = EXCLUDED.timezone,
                merchant_id = EXCLUDED.merchant_id,
                updated_at = CURRENT_TIMESTAMP
        `, [
            location.id,
            location.name,
            location.id,
            location.status === 'ACTIVE',
            location.address ? JSON.stringify(location.address) : null,
            location.timezone,
            merchantId
        ]);

        result.location = {
            id: location.id,
            name: location.name,
            status: location.status
        };

        logger.info('Location synced via webhook', {
            locationId: location.id,
            locationName: location.name
        });

        return result;
    }
}

module.exports = CatalogHandler;
