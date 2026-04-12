/**
 * Inventory RECEIVE Adjustment Sync
 *
 * Fetches ADJUSTMENT-type inventory changes that increase IN_STOCK quantities
 * (i.e. inventory receipts) from Square, then upserts the most recent
 * occurred_at per (variation_id, location_id) into
 * variation_location_settings.last_received_at.
 *
 * Delta sync: after the first full-history pull the high-water mark
 * merchants.last_received_sync_at is written.  Subsequent runs pass
 * updated_after = (last_received_sync_at - 10 min) to the Square endpoint so
 * only recent changes are fetched.  The 10-minute overlap guards against
 * Square eventual-consistency delays.
 *
 * Called from syncInventory() — piggybacks on the existing sync run.
 *
 * Exports:
 *   syncReceiveAdjustments(merchantId, accessToken, locationIds)
 */

'use strict';

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { makeSquareRequest, sleep } = require('./square-client');
const {
    SQUARE: { MAX_PAGINATION_ITERATIONS },
    SYNC:  { BATCH_DELAY_MS }
} = require('../../config/constants');

const BATCH_SIZE = 100;
const OVERLAP_MINUTES = 10;

/**
 * Read merchants.last_received_sync_at for the given merchant.
 * Returns a Date or null (first run / full-history pull).
 * @param {number} merchantId
 * @returns {Promise<Date|null>}
 */
async function getLastReceivedSyncAt(merchantId) {
    const result = await db.query(
        'SELECT last_received_sync_at FROM merchants WHERE id = $1',
        [merchantId]
    );
    const raw = result.rows[0]?.last_received_sync_at;
    return raw ? new Date(raw) : null;
}

/**
 * Write the high-water mark after a successful sync.
 * @param {number} merchantId
 */
async function setLastReceivedSyncAt(merchantId) {
    await db.query(
        'UPDATE merchants SET last_received_sync_at = NOW() WHERE id = $1',
        [merchantId]
    );
}

/**
 * Is this inventory change a RECEIVE (stock flowing into IN_STOCK)?
 * @param {Object} change - Square InventoryChange object
 * @returns {boolean}
 */
function isReceiveAdjustment(change) {
    return (
        change.type === 'ADJUSTMENT' &&
        change.adjustment &&
        change.adjustment.to_state === 'IN_STOCK' &&
        change.adjustment.catalog_object_id &&
        change.adjustment.location_id &&
        change.adjustment.occurred_at
    );
}

/**
 * Collect the most recent occurred_at per (catalogObjectId|locationId) from
 * a page of Square inventory changes.
 * @param {Object[]} changes
 * @param {Map<string,string>} latestMap  - mutated in place
 */
function collectReceives(changes, latestMap) {
    for (const change of changes) {
        if (!isReceiveAdjustment(change)) continue;

        const { catalog_object_id, location_id, occurred_at } = change.adjustment;
        const key = `${catalog_object_id}|${location_id}`;
        const existing = latestMap.get(key);
        if (!existing || occurred_at > existing) {
            latestMap.set(key, occurred_at);
        }
    }
}

/**
 * Fetch RECEIVE adjustments for one batch of catalog object IDs, following
 * pagination until exhausted or the safety limit is hit.
 * @param {string[]} batch
 * @param {string[]} locationIds
 * @param {string} accessToken
 * @param {Map<string,string>} latestMap  - mutated in place
 * @param {string|undefined} updatedAfter - RFC 3339 string for delta pull, or undefined for full pull
 */
async function fetchBatchReceives(batch, locationIds, accessToken, latestMap, updatedAfter) {
    let cursor = null;
    let iterations = 0;

    do {
        const requestBody = {
            catalog_object_ids: batch,
            location_ids: locationIds,
            types: ['ADJUSTMENT']
        };
        if (updatedAfter) requestBody.updated_after = updatedAfter;
        if (cursor) requestBody.cursor = cursor;

        try {
            const data = await makeSquareRequest('/v2/inventory/changes/batch-retrieve', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                accessToken
            });
            collectReceives(data.changes || [], latestMap);
            cursor = data.cursor || null;
        } catch (err) {
            logger.error('syncReceiveAdjustments: batch fetch failed', {
                batchSize: batch.length, error: err.message
            });
            break; // Continue to next catalog batch
        }

        iterations++;
    } while (cursor && iterations < MAX_PAGINATION_ITERATIONS);
}

/**
 * Upsert last_received_at for all collected receives using GREATEST so an
 * earlier sync run never overwrites a more-recent receipt timestamp.
 * @param {Map<string,string>} latestMap
 * @param {number} merchantId
 * @returns {Promise<number>} number of rows upserted
 */
async function upsertLastReceivedAt(latestMap, merchantId) {
    let updated = 0;

    for (const [key, occurredAt] of latestMap) {
        const pipe = key.indexOf('|');
        const variationId = key.slice(0, pipe);
        const locationId  = key.slice(pipe + 1);

        await db.query(`
            INSERT INTO variation_location_settings
                (variation_id, location_id, merchant_id, last_received_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (variation_id, location_id, merchant_id) DO UPDATE SET
                last_received_at = GREATEST(
                    EXCLUDED.last_received_at,
                    variation_location_settings.last_received_at
                )
        `, [variationId, locationId, merchantId, occurredAt]);

        updated++;
    }

    return updated;
}

/**
 * Sync RECEIVE-type inventory adjustments from Square and persist
 * last_received_at per (variation_id, location_id) for the merchant.
 *
 * On the first run (last_received_sync_at IS NULL) all history is pulled.
 * On subsequent runs only changes since (last_received_sync_at - 10 min) are
 * fetched.  The high-water mark is written only after a successful completion.
 *
 * @param {number} merchantId
 * @param {string} accessToken  - already-fetched merchant token
 * @param {string[]} locationIds
 * @returns {Promise<number>} number of variation-location pairs updated
 */
async function syncReceiveAdjustments(merchantId, accessToken, locationIds) {
    if (!merchantId || !accessToken || !locationIds.length) return 0;

    // --- Delta sync: determine updated_after filter ---
    const lastSyncAt = await getLastReceivedSyncAt(merchantId);
    let updatedAfter; // undefined → full pull (no filter sent to Square)
    if (lastSyncAt) {
        const withOverlap = new Date(lastSyncAt.getTime() - OVERLAP_MINUTES * 60 * 1000);
        updatedAfter = withOverlap.toISOString();
    }

    const variationsResult = await db.query(
        'SELECT id FROM variations WHERE merchant_id = $1',
        [merchantId]
    );
    const catalogObjectIds = variationsResult.rows.map(r => r.id);

    if (catalogObjectIds.length === 0) return 0;

    const latestMap = new Map(); // `variationId|locationId` → occurred_at
    let fatalError = false;

    for (let i = 0; i < catalogObjectIds.length; i += BATCH_SIZE) {
        const batch = catalogObjectIds.slice(i, i + BATCH_SIZE);
        try {
            await fetchBatchReceives(batch, locationIds, accessToken, latestMap, updatedAfter);
        } catch (err) {
            // fetchBatchReceives swallows per-batch errors internally; a throw
            // here is a programming error — treat as fatal and skip the mark update.
            logger.error('syncReceiveAdjustments: fatal error during batch loop', {
                merchantId, error: err.message
            });
            fatalError = true;
            break;
        }
        await sleep(BATCH_DELAY_MS);
    }

    if (fatalError) return 0;

    const updated = await upsertLastReceivedAt(latestMap, merchantId);

    // --- High-water mark: only written on successful completion ---
    await setLastReceivedSyncAt(merchantId);

    logger.info('syncReceiveAdjustments complete', {
        merchantId,
        uniqueVariationLocations: updated,
        deltaMode: !!updatedAfter,
        updatedAfter: updatedAfter || null
    });

    return updated;
}

module.exports = { syncReceiveAdjustments };
