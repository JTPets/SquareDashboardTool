/**
 * Square Vendors Service
 *
 * Syncs vendor data from Square API and handles vendor ID reconciliation.
 *
 * Exports:
 *   syncVendors(merchantId)                — paginated vendor sync from Square
 *   ensureVendorsExist(vendorIds, merchantId) — on-demand fetch for missing vendors
 *
 * Internal (not exported):
 *   migrateVendorFKs(client, oldId, newId, merchantId) — FK migration in transaction
 *   reconcileVendorId(vendor, vendorParams, merchantId) — handle vendor ID changes
 *
 * Usage:
 *   const { syncVendors } = require('./services/square');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep } = require('./square-client');

const { SQUARE: { MAX_PAGINATION_ITERATIONS }, SYNC: { BATCH_DELAY_MS } } = require('../../config/constants');

/**
 * Migrate all FK references from one vendor ID to another within a transaction.
 * Covers all tables: variation_vendors, vendor_catalog_items, purchase_orders,
 * bundle_definitions, loyalty_offers.
 */
async function migrateVendorFKs(client, oldId, newId, merchantId) {
    const tables = [
        'variation_vendors',
        'vendor_catalog_items',
        'purchase_orders',
        'bundle_definitions',
        'loyalty_offers',
    ];
    const counts = {};
    for (const table of tables) {
        const result = await client.query(
            `UPDATE ${table} SET vendor_id = $1 WHERE vendor_id = $2 AND merchant_id = $3`,
            [newId, oldId, merchantId]
        );
        counts[table] = result.rowCount;
    }
    return counts;
}

/**
 * Reconcile a vendor whose Square ID changed but name matches an existing DB row.
 * Uses a transaction to: insert new vendor with temp name, migrate ALL FK references,
 * delete old vendor, then set the correct name on the new vendor.
 */
async function reconcileVendorId(vendor, vendorParams, merchantId) {
    await db.transaction(async (client) => {
        const existing = await client.query(
            'SELECT id FROM vendors WHERE merchant_id = $1 AND vendor_name_normalized(name) = vendor_name_normalized($2)',
            [merchantId, vendor.name]
        );
        if (existing.rows.length === 0) return;

        const oldId = existing.rows[0].id;
        if (oldId === vendor.id) return;

        // Insert new vendor with a temp name to avoid unique name constraint
        const tempName = `__reconciling_${vendor.id}`;
        await client.query(
            `INSERT INTO vendors (id, name, status, contact_name, contact_email, contact_phone, merchant_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO NOTHING`,
            [vendor.id, tempName, vendorParams[2], vendorParams[3], vendorParams[4], vendorParams[5], merchantId]
        );

        // Migrate ALL FK references from old vendor ID to new
        const migrated = await migrateVendorFKs(client, oldId, vendor.id, merchantId);

        // Delete old vendor (no FK refs remain)
        await client.query('DELETE FROM vendors WHERE id = $1 AND merchant_id = $2', [oldId, merchantId]);

        // Set the correct name on the new vendor
        await client.query(
            'UPDATE vendors SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND merchant_id = $3',
            [vendor.name, vendor.id, merchantId]
        );

        logger.info('Reconciled vendor ID change', {
            merchantId, vendorName: vendor.name, oldId, newId: vendor.id, migrated
        });
    });
}

/**
 * Sync vendors from Square
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<number>} Number of vendors synced
 */
async function syncVendors(merchantId) {
    logger.info('Starting vendor sync', { merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);
        let cursor = null;
        let totalSynced = 0;
        let paginationIterations = 0;

        do {
            if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
                logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/vendors/search' });
                break;
            }
            const requestBody = {
                filter: {
                    status: ['ACTIVE', 'INACTIVE']  // ✅ CORRECT (singular, not plural)
                },
                limit: 100  // Add for better performance
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/vendors/search', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                accessToken
            });

            const vendors = data.vendors || [];

            for (const vendor of vendors) {
                const vendorParams = [
                    vendor.id,
                    vendor.name,
                    vendor.status,
                    vendor.contacts?.[0]?.name || null,
                    vendor.contacts?.[0]?.email_address || null,
                    vendor.contacts?.[0]?.phone_number || null,
                    merchantId
                ];

                try {
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
                    `, vendorParams);
                } catch (err) {
                    if (err.constraint === 'idx_vendors_merchant_name_unique') {
                        // Vendor exists with same name but different Square ID — reconcile
                        await reconcileVendorId(vendor, vendorParams, merchantId);
                    } else {
                        throw err;
                    }
                }
                totalSynced++;
            }

            cursor = data.cursor;
            logger.info('Vendor sync progress', { merchantId, count: totalSynced });

            if (cursor) await sleep(BATCH_DELAY_MS);
        } while (cursor);

        logger.info('Vendor sync complete', { merchantId, count: totalSynced });
        return totalSynced;
    } catch (error) {
        logger.error('Vendor sync failed', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Ensure vendors exist locally before inserting variation_vendors rows.
 * Checks the DB for each vendor_id; any missing vendors are fetched from
 * Square's Vendors API and upserted. Prevents FK violations when
 * deltaSyncCatalog runs before vendor webhooks are processed.
 *
 * @param {string[]} vendorIds - Square vendor IDs to check
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 */
async function ensureVendorsExist(vendorIds, merchantId) {
    if (!vendorIds.length) return;

    const unique = [...new Set(vendorIds)];

    const existing = await db.query(
        'SELECT id FROM vendors WHERE id = ANY($1) AND merchant_id = $2',
        [unique, merchantId]
    );
    const existingSet = new Set(existing.rows.map(r => r.id));
    const missing = unique.filter(id => !existingSet.has(id));

    if (!missing.length) return;

    logger.info('Fetching missing vendors from Square before variation sync', {
        merchantId, missingVendorIds: missing
    });

    const accessToken = await getMerchantToken(merchantId);

    for (const vendorId of missing) {
        try {
            const data = await makeSquareRequest(`/v2/vendors/${vendorId}`, { accessToken });
            const vendor = data.vendor;
            if (!vendor) continue;

            const vendorParams = [
                vendor.id,
                vendor.name,
                vendor.status,
                vendor.contacts?.[0]?.name || null,
                vendor.contacts?.[0]?.email_address || null,
                vendor.contacts?.[0]?.phone_number || null,
                merchantId
            ];

            try {
                await db.query(`
                    INSERT INTO vendors (id, name, status, contact_name, contact_email, contact_phone, merchant_id, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        status = EXCLUDED.status,
                        contact_name = EXCLUDED.contact_name,
                        contact_email = EXCLUDED.contact_email,
                        contact_phone = EXCLUDED.contact_phone,
                        merchant_id = EXCLUDED.merchant_id,
                        updated_at = CURRENT_TIMESTAMP
                `, vendorParams);
            } catch (insertErr) {
                if (insertErr.constraint === 'idx_vendors_merchant_name_unique') {
                    // Name exists with different Square ID — vendor was deleted/recreated in Square
                    await reconcileVendorId(vendor, vendorParams, merchantId);
                } else {
                    throw insertErr;
                }
            }

            logger.info('On-demand vendor fetch succeeded', { merchantId, vendorId, vendorName: vendor.name });
        } catch (error) {
            // Vendor may have been deleted from Square — log and let the INSERT catch handle it
            logger.warn('On-demand vendor fetch failed', { merchantId, vendorId, error: error.message });
        }
    }
}

module.exports = {
    syncVendors,
    ensureVendorsExist
};
