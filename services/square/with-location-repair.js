/**
 * Square-specific reactive location-repair wrapper.
 *
 * Detects Square INVALID_VALUE/item_id errors (a variation is enabled at a
 * location where its parent ITEM is not), parses the offending item and
 * location out of Square's error detail, calls enableItemAtAllLocations
 * on that parent, then retries the failing call once.
 *
 * Bounded-repair contract
 * -----------------------
 * Exactly ONE repair attempt per withLocationRepair call. The repair is
 * never retried, and the wrapper never loops. If the retry after repair
 * STILL throws INVALID_VALUE/item_id, a descriptive "manual review
 * required" error is thrown so operators see the failure instead of it
 * being swallowed. A retry that fails with a different error is rethrown
 * unchanged.
 *
 * If Square's error detail cannot be parsed into {itemId, locationId},
 * the original error is rethrown immediately — we never attempt a repair
 * with incomplete data.
 *
 * Proactive vs reactive repair
 * ----------------------------
 * pushMinStockThresholdsToSquare and batchUpdateCustomAttributeValues use
 * PROACTIVE repair: they call repairParentLocationMismatches BEFORE the
 * upsert so the error never fires in the first place. This wrapper uses
 * REACTIVE repair: catch, fix, retry.
 *
 * Circular dependency note
 * ------------------------
 * enableItemAtAllLocations is required LAZILY inside the function body,
 * not at module level, because square-diagnostics (a consumer of this
 * module) creates the cycle:
 *
 *   square-diagnostics → with-location-repair → square-diagnostics
 *
 * At module-load time, the inner require would receive a partially-
 * initialised square-diagnostics object. The lazy require defers until
 * all modules are fully initialised.
 *
 * Square-specific. Not for use outside services/square/.
 * Will NOT be part of the POS adapter interface.
 *
 * @module services/square/with-location-repair
 */

'use strict';

const logger = require('../../utils/logger');

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
 * Returns the raw error detail string from the first INVALID_VALUE/item_id
 * entry, or null if absent. Used for diagnostic logging when parsing fails.
 *
 * @param {Error} err
 * @returns {string|null}
 */
function getLocationMismatchDetail(err) {
    const errs = err.squareErrors || err.details;
    if (!Array.isArray(errs)) return null;
    for (const d of errs) {
        if (d.code === 'INVALID_VALUE' && d.field === 'item_id') {
            return typeof d.detail === 'string' ? d.detail : null;
        }
    }
    return null;
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
    const detail = getLocationMismatchDetail(err);
    if (!detail) return null;
    const locMatch = detail.match(/enabled at unit `([^`]+)`/);
    const itemMatch = detail.match(/referenced object with token `([^`]+)`/);
    if (locMatch && itemMatch) {
        return { locationId: locMatch[1], itemId: itemMatch[1] };
    }
    return null;
}

/**
 * Wraps a Square catalog upsert call with reactive parent-item location repair.
 *
 * Flow:
 *   1. Call fn(). On success, return result.
 *   2. If fn throws, and it's not INVALID_VALUE/item_id → rethrow.
 *   3. Parse the offending itemId/locationId from the error detail.
 *      If parsing fails → log warning with raw detail, rethrow original.
 *   4. Call enableItemAtAllLocations(itemId, merchantId). This is the ONLY
 *      repair attempt — never retried.
 *   5. Retry fn() exactly once.
 *      - Retry succeeds → return result.
 *      - Retry throws INVALID_VALUE/item_id → throw a "manual review
 *        required" error (do NOT repair again, do NOT loop).
 *      - Retry throws anything else → rethrow that error unchanged.
 *
 * Square-specific. Not for use outside services/square/.
 * Will NOT be part of the POS adapter interface.
 *
 * @param {Object}   opts
 * @param {number}   opts.merchantId   - Merchant ID for repair calls and logging
 * @param {string}   opts.accessToken  - Square access token for this merchant (unused, reserved)
 * @param {Function} opts.fn           - Async function performing the upsert
 * @param {string[]} opts.variationIds - ITEM_VARIATION IDs being upserted (for logging)
 * @returns {Promise<*>} Result of fn on success
 */
// eslint-disable-next-line no-unused-vars
async function withLocationRepair({ merchantId, accessToken, fn, variationIds }) {
    let firstErr;
    try {
        return await fn();
    } catch (err) {
        if (!isLocationMismatchError(err)) throw err;
        firstErr = err;
    }

    const parsed = parseLocationMismatchDetail(firstErr);
    if (!parsed) {
        logger.warn('withLocationRepair: could not parse location mismatch detail, aborting repair', {
            merchantId,
            variationIds,
            rawDetail: getLocationMismatchDetail(firstErr)
        });
        throw firstErr;
    }

    const { itemId, locationId } = parsed;

    // Single repair attempt — never retried, never looped.
    try {
        // Lazy require — see circular dependency note in module JSDoc.
        // eslint-disable-next-line global-require
        const { enableItemAtAllLocations } = require('./square-diagnostics');
        await enableItemAtAllLocations(itemId, merchantId);
        logger.info('withLocationRepair: repaired parent from error detail', {
            merchantId,
            itemId,
            locationId
        });
    } catch (repairErr) {
        logger.warn('withLocationRepair: targeted repair failed, proceeding to retry', {
            merchantId,
            itemId,
            locationId,
            error: repairErr.message
        });
    }

    // Exactly one retry. Do not repair again under any circumstance.
    try {
        return await fn();
    } catch (retryErr) {
        if (isLocationMismatchError(retryErr)) {
            logger.error('withLocationRepair: retry still failing with location mismatch after repair', {
                merchantId,
                variationIds,
                parsedItemId: itemId,
                parsedLocationId: locationId,
                error: retryErr.message
            });
            const finalErr = new Error(
                `Location mismatch repair failed after 1 attempt for parent ${itemId} at location ${locationId} — manual review required`
            );
            finalErr.repairAttempted = true;
            finalErr.parsedItemId = itemId;
            finalErr.parsedLocationId = locationId;
            finalErr.originalError = firstErr;
            finalErr.retryError = retryErr;
            throw finalErr;
        }
        // Different error → propagate unchanged so callers see the real cause.
        throw retryErr;
    }
}

module.exports = { withLocationRepair };
