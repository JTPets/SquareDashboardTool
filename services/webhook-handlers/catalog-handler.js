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
     * Uses delta sync (SearchCatalogObjects with begin_time) instead of full catalog fetch.
     * Falls back to full sync automatically if no prior timestamp or too many changes.
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with sync details
     */
    async handleCatalogVersionUpdated(context) {
        const { merchantId, data } = context;
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

        // Deduplicate by catalog version timestamp from webhook payload
        const catalogVersionUpdatedAt = data?.object?.catalog_version?.updated_at;
        if (catalogVersionUpdatedAt) {
            try {
                const versionCheck = await db.query(
                    'SELECT last_catalog_version FROM sync_history WHERE sync_type = $1 AND merchant_id = $2',
                    ['catalog', merchantId]
                );
                const lastVersion = versionCheck.rows[0]?.last_catalog_version;
                if (lastVersion && lastVersion >= catalogVersionUpdatedAt) {
                    logger.info('Catalog webhook skipped — already processed this version', {
                        merchantId,
                        webhookVersion: catalogVersionUpdatedAt,
                        lastProcessed: lastVersion
                    });
                    result.skipped = true;
                    result.reason = 'duplicate_version';
                    return result;
                }
            } catch (error) {
                // Non-fatal — proceed with sync if dedup check fails
                logger.warn('Catalog version dedup check failed', { error: error.message });
            }
        }

        // Use sync queue to prevent duplicate concurrent syncs
        const syncResult = await this.syncQueue.executeWithQueue(
            'catalog',
            merchantId,
            async () => {
                logger.info('Catalog change detected via webhook, running delta sync...', { merchantId });
                return await squareApi.deltaSyncCatalog(merchantId);
            }
        );

        if (syncResult.queued) {
            result.queued = true;
        } else if (syncResult.error) {
            result.error = syncResult.error;
        } else {
            result.catalog = {
                items: syncResult.result?.items,
                variations: syncResult.result?.variations,
                deltaSync: syncResult.result?.deltaSync
            };
            logger.info('Catalog delta sync completed via webhook', result.catalog);

            if (syncResult.followUpResult) {
                result.followUpSync = {
                    items: syncResult.followUpResult.items,
                    variations: syncResult.followUpResult.variations
                };
                logger.info('Follow-up catalog sync completed', result.followUpSync);
            }
        }

        // Reconcile bundle components that reference deleted/replaced variations
        if (!syncResult.error && !syncResult.queued) {
            await reconcileBundleComponents(merchantId);
        }

        // Update last_catalog_version after successful sync
        if (!syncResult.error && !syncResult.queued && catalogVersionUpdatedAt) {
            try {
                await db.query(`
                    UPDATE sync_history
                    SET last_catalog_version = $1
                    WHERE sync_type = 'catalog' AND merchant_id = $2
                `, [catalogVersionUpdatedAt, merchantId]);
            } catch (error) {
                logger.warn('Failed to update catalog version', { error: error.message });
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
        const { data, merchantId, entityId } = context;
        const result = { handled: true };

        if (!data.customer || !merchantId) {
            return result;
        }

        // Use entityId (canonical) with fallback to nested object
        const customerId = entityId || data.customer.id;
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
        const { data, merchantId, event, entityId } = context;
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

        // Use entityId (canonical) with fallback to nested object
        const vendorId = entityId || vendor.id;

        logger.info('Vendor change detected via webhook', {
            vendorId,
            vendorName: vendor.name,
            status: vendor.status,
            eventType: event.type,
            merchantId
        });

        // Sync the specific vendor using upsert
        // First try to update by ID, then by normalized name (handles ID changes),
        // finally insert if neither exists
        const contactName = vendor.contacts?.[0]?.name || null;
        const contactEmail = vendor.contacts?.[0]?.email_address || null;
        const contactPhone = vendor.contacts?.[0]?.phone_number || null;

        await db.query(`
            WITH updated AS (
                UPDATE vendors SET
                    id = $1,
                    name = $2,
                    status = $3,
                    contact_name = $4,
                    contact_email = $5,
                    contact_phone = $6,
                    updated_at = CURRENT_TIMESTAMP
                WHERE merchant_id = $7 AND (id = $1 OR vendor_name_normalized(name) = vendor_name_normalized($2))
                RETURNING id
            )
            INSERT INTO vendors (id, name, status, contact_name, contact_email, contact_phone, merchant_id, updated_at)
            SELECT $1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP
            WHERE NOT EXISTS (SELECT 1 FROM updated)
        `, [
            vendorId,
            vendor.name,
            vendor.status,
            contactName,
            contactEmail,
            contactPhone,
            merchantId
        ]);

        result.vendor = {
            id: vendorId,
            name: vendor.name,
            status: vendor.status
        };

        logger.info('Vendor synced via webhook', {
            vendorId,
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
        const { data, merchantId, event, entityId } = context;
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

        // Use entityId (canonical) with fallback to nested object
        const locationId = entityId || location.id;

        logger.info('Location change detected via webhook', {
            locationId,
            locationName: location.name,
            status: location.status,
            eventType: event.type,
            merchantId
        });

        // Sync the specific location directly
        await db.query(`
            INSERT INTO locations (id, name, square_location_id, active, address, timezone, phone_number, business_email, merchant_id, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                square_location_id = EXCLUDED.square_location_id,
                active = EXCLUDED.active,
                address = EXCLUDED.address,
                timezone = EXCLUDED.timezone,
                phone_number = EXCLUDED.phone_number,
                business_email = EXCLUDED.business_email,
                merchant_id = EXCLUDED.merchant_id,
                updated_at = CURRENT_TIMESTAMP
        `, [
            locationId,
            location.name,
            locationId,
            location.status === 'ACTIVE',
            location.address ? JSON.stringify(location.address) : null,
            location.timezone,
            location.phoneNumber || null,
            location.businessEmail || null,
            merchantId
        ]);

        result.location = {
            id: locationId,
            name: location.name,
            status: location.status
        };

        logger.info('Location synced via webhook', {
            locationId,
            locationName: location.name
        });

        return result;
    }
}

/**
 * Reconcile bundle components that reference deleted/replaced variations.
 * When Square replaces a variation (new ID, same SKU), bundle_components
 * still point to the old deleted ID. This finds stale references and
 * updates them to the active replacement.
 *
 * Called after catalog sync (webhook + cron) to auto-repair bundles.
 */
async function reconcileBundleComponents(merchantId) {
    try {
        const staleResult = await db.query(`
            SELECT bc.id as component_id, bc.bundle_id, bc.child_variation_id as old_id,
                   bc.child_sku, v_new.id as new_id, v_new.name as new_variation_name,
                   i_new.name as new_item_name
            FROM bundle_components bc
            JOIN bundle_definitions bd ON bc.bundle_id = bd.id AND bd.merchant_id = $1
            JOIN variations v_old ON bc.child_variation_id = v_old.id AND v_old.merchant_id = $1
            JOIN variations v_new ON v_new.sku = bc.child_sku AND v_new.merchant_id = $1
                AND COALESCE(v_new.is_deleted, FALSE) = FALSE
                AND v_new.id != bc.child_variation_id
            JOIN items i_new ON v_new.item_id = i_new.id AND i_new.merchant_id = $1
            WHERE bd.is_active = true
              AND v_old.is_deleted = TRUE
              AND bc.child_sku IS NOT NULL
        `, [merchantId]);

        if (staleResult.rows.length === 0) return;

        for (const row of staleResult.rows) {
            await db.query(`
                UPDATE bundle_components
                SET child_variation_id = $1, child_variation_name = $2,
                    child_item_name = $3, updated_at = NOW()
                WHERE id = $4
            `, [row.new_id, row.new_variation_name, row.new_item_name, row.component_id]);

            logger.info('Bundle component reconciled: replaced deleted variation', {
                merchantId,
                bundleId: row.bundle_id,
                oldVariationId: row.old_id,
                newVariationId: row.new_id,
                sku: row.child_sku
            });
        }

        logger.info('Bundle component reconciliation complete', {
            merchantId, componentsFixed: staleResult.rows.length
        });
    } catch (error) {
        logger.warn('Bundle component reconciliation failed', {
            merchantId, error: error.message
        });
    }
}

module.exports = CatalogHandler;
module.exports.reconcileBundleComponents = reconcileBundleComponents;
