/**
 * Square-specific reactive location-repair wrapper.
 *
 * Detects Square INVALID_VALUE/item_id errors (a variation is enabled at a
 * location where its parent ITEM is not), runs a repair pass via
 * repairParentLocationMismatches, then retries the failing call once.
 *
 * Proactive vs reactive repair
 * ----------------------------
 * pushMinStockThresholdsToSquare and batchUpdateCustomAttributeValues use
 * PROACTIVE repair: they call repairParentLocationMismatches BEFORE the upsert
 * so the error never fires in the first place. This wrapper uses REACTIVE
 * repair: catch, fix, retry. Both patterns are valid; the proactive calls are
 * intentionally left unchanged.
 *
 * Circular dependency note
 * ------------------------
 * repairParentLocationMismatches is required LAZILY inside the function body,
 * not at module level, because square-diagnostics (a consumer of this module)
 * creates the cycle:
 *
 *   square-diagnostics → with-location-repair
 *                      → square-location-preflight → square-diagnostics
 *
 * At module-load time, square-location-preflight would receive a partially-
 * initialised square-diagnostics object and enableItemAtAllLocations would be
 * undefined. The lazy require defers until all modules are fully initialised.
 *
 * Square-specific. Not for use outside services/square/.
 * Will NOT be part of the POS adapter interface.
 *
 * @module services/square/with-location-repair
 */

'use strict';

const logger = require('../../utils/logger');
const { makeSquareRequest } = require('./square-client');

// Sentinel used by repairParentLocationMismatches to signal that a variation
// is present_at_all_locations — requires the parent ITEM to be as well.
const ALL_LOCATIONS_SENTINEL = '__ALL_LOCATIONS__';

/**
 * Returns true when the caught error is the Square INVALID_VALUE/item_id
 * location-mismatch (a variation is enabled at a location its parent ITEM
 * is not). Checks the backward-compat `squareErrors` alias that is set on
 * every SquareApiError and accepted throughout the codebase.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isLocationMismatchError(err) {
    const errs = err.squareErrors || err.details;
    return Array.isArray(errs) &&
        errs.some(d => d.code === 'INVALID_VALUE' && d.field === 'item_id');
}

/**
 * Extracts the offending location ID and parent item ID from a Square
 * INVALID_VALUE/item_id error detail string.
 *
 * Square's detail format:
 *   "Object `VARIATION_ID` of type ITEM_VARIATION is enabled at unit
 *    `LOCATION_ID`, but the referenced object with token `ITEM_ID` of
 *    type ITEM is not."
 *
 * The location here is Square's authoritative view of where the variation
 * is enabled — which can differ from what the catalog object's
 * present_at_all/absent_at_location_ids fields imply (the underlying
 * Square-internal inconsistency this targeted repair is designed to fix).
 *
 * @param {Error} err
 * @returns {{ itemId: string, locationId: string } | null}
 */
function parseLocationMismatchDetail(err) {
    const errs = err.squareErrors || err.details;
    if (!Array.isArray(errs)) return null;
    for (const d of errs) {
        if (d.code !== 'INVALID_VALUE' || d.field !== 'item_id') continue;
        const detail = d.detail;
        if (typeof detail !== 'string') continue;
        const locMatch = detail.match(/enabled at unit `([^`]+)`/);
        const itemMatch = detail.match(/referenced object with token `([^`]+)`/);
        if (locMatch && itemMatch) {
            return { locationId: locMatch[1], itemId: itemMatch[1] };
        }
    }
    return null;
}

/**
 * Wraps a Square catalog upsert call with reactive parent-item location repair.
 *
 * On INVALID_VALUE/item_id error:
 *   1. Batch-retrieves the ITEM_VARIATION objects to discover parent item IDs
 *      and the locations at which each variation is enabled.
 *   2. Calls repairParentLocationMismatches to enable any mismatched parent
 *      ITEMs at all locations (see square-location-preflight.js).
 *   3. Retries fn() once.
 *   4. If the retry still fails, rethrows the ORIGINAL error annotated with
 *      repairAttempted: true so callers can distinguish a repair-attempted
 *      failure from a first-try failure.
 *
 * Any other error is rethrown immediately — no repair, no retry.
 *
 * Square-specific. Not for use outside services/square/.
 * Will NOT be part of the POS adapter interface.
 *
 * @param {Object}   opts
 * @param {number}   opts.merchantId   - Merchant ID for repair calls and logging
 * @param {string}   opts.accessToken  - Square access token for this merchant
 * @param {Function} opts.fn           - Async function performing the upsert
 * @param {string[]} opts.variationIds - ITEM_VARIATION IDs being upserted
 * @returns {Promise<*>} Result of fn on success
 */
async function withLocationRepair({ merchantId, accessToken, fn, variationIds }) {
    try {
        return await fn();
    } catch (err) {
        if (!isLocationMismatchError(err)) {
            throw err;
        }

        let repairedParents = 0;

        // Primary path: parse the offending item + location directly from
        // Square's error detail. This handles cases where Square's internal
        // view of the variation's enabled locations differs from what the
        // catalog object reports (e.g. catalog says
        // absent_at_location_ids=[X] but the upsert still fails with X in
        // the detail). The catalog-derived mismatch check can't see this, so
        // we rely on Square's own error to name the location.
        const parsed = parseLocationMismatchDetail(err);
        if (parsed) {
            try {
                // Lazy require — see circular dependency note in module JSDoc.
                // eslint-disable-next-line global-require
                const { enableItemAtAllLocations } = require('./square-diagnostics');
                await enableItemAtAllLocations(parsed.itemId, merchantId);
                repairedParents = 1;
                logger.info('withLocationRepair: repaired parent from error detail', {
                    merchantId,
                    itemId: parsed.itemId,
                    locationId: parsed.locationId
                });
            } catch (repairErr) {
                logger.warn('withLocationRepair: targeted repair failed, proceeding to retry', {
                    merchantId,
                    itemId: parsed.itemId,
                    locationId: parsed.locationId,
                    error: repairErr.message
                });
            }
        } else {
            // Fallback: batch-retrieve the variation objects so
            // repairParentLocationMismatches can discover parent item IDs and
            // determine which locations need healing.
            try {
                const retrieveData = await makeSquareRequest('/v2/catalog/batch-retrieve', {
                    method: 'POST',
                    body: JSON.stringify({
                        object_ids: variationIds,
                        include_related_objects: false
                    }),
                    accessToken
                });

                const retrievedVariations = new Map();
                for (const obj of (retrieveData.objects || [])) {
                    if (obj.type === 'ITEM_VARIATION') {
                        retrievedVariations.set(obj.id, obj);
                    }
                }

                // Build changesByVariation: map each variation to the locations at
                // which it is enabled. ALL_LOCATIONS_SENTINEL signals
                // present_at_all_locations so repairParentLocationMismatches
                // enforces the parent ITEM is also globally present.
                const changesByVariation = new Map();
                for (const [id, obj] of retrievedVariations.entries()) {
                    const locMap = new Map();
                    if (obj.present_at_all_locations === true) {
                        locMap.set(ALL_LOCATIONS_SENTINEL, 0);
                    } else {
                        for (const locId of (obj.present_at_location_ids || [])) {
                            locMap.set(locId, 0);
                        }
                    }
                    if (locMap.size > 0) changesByVariation.set(id, locMap);
                }

                // Lazy require — see circular dependency note in module JSDoc.
                // eslint-disable-next-line global-require
                const { repairParentLocationMismatches } = require('./square-location-preflight');
                const result = await repairParentLocationMismatches(
                    merchantId, accessToken, retrievedVariations, changesByVariation
                );
                repairedParents = result.repairedParents;
            } catch (repairErr) {
                logger.warn('withLocationRepair: repair step failed, proceeding to retry', {
                    merchantId,
                    variationCount: variationIds.length,
                    error: repairErr.message
                });
            }
        }

        logger.info('withLocationRepair: repair complete, retrying upsert', {
            merchantId,
            variationCount: variationIds.length,
            repairedParents
        });

        try {
            return await fn();
        } catch (retryErr) {
            // Rethrow the ORIGINAL error (not retryErr) so callers see the root
            // cause. Annotate it so callers can distinguish repair-attempted
            // failures from first-try failures.
            err.repairAttempted = true;
            err.repairedParents = repairedParents;
            throw err;
        }
    }
}

module.exports = { withLocationRepair };
