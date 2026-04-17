/**
 * Square-specific reactive location-repair wrapper.
 *
 * Detects Square INVALID_VALUE/item_id errors (a variation is enabled at a
 * location where its parent ITEM is not), parses the offending item and
 * location out of Square's error detail, calls enableItemAtAllLocations
 * on that parent, then retries the failing call. Up to MAX_REPAIRS=5
 * repairs are attempted; each iteration may fix a DIFFERENT parent.
 * A 2 s sleep after each repair allows Square's catalog engine to reach
 * consistency before the next attempt.
 *
 * Bounded-repair contract
 * -----------------------
 * At most MAX_REPAIRS repair+retry cycles. If the call is still failing
 * with INVALID_VALUE/item_id after MAX_REPAIRS repairs, a descriptive
 * "manual review required" error is thrown. A retry that fails with a
 * different error is rethrown unchanged.
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
const { sleep } = require('./square-client');

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
 * Calls fn() in a loop. On each INVALID_VALUE/item_id failure, parses the
 * offending parent, repairs it via enableItemAtAllLocations, waits 2 s for
 * Square catalog consistency, then retries. Up to MAX_REPAIRS cycles.
 *
 * Square-specific. Not for use outside services/square/.
 * Will NOT be part of the POS adapter interface.
 *
 * @param {Object}   opts
 * @param {number}   opts.merchantId   - Merchant ID for repair calls and logging
 * @param {string}   opts.accessToken  - Square access token for this merchant (unused, reserved)
 * @param {Function} opts.fn           - Async function performing the upsert
 * @param {string[]} opts.variationIds - ITEM_VARIATION IDs being upserted (for logging)
 * @returns {Promise<{ result: *, repairedCount: number }>}
 */
// eslint-disable-next-line no-unused-vars
async function withLocationRepair({ merchantId, accessToken, fn, variationIds }) {
    const MAX_REPAIRS = 5;
    let repairCount = 0;
    let lastResult;

    while (true) {
        try {
            lastResult = await fn();
            break;
        } catch (err) {
            if (!isLocationMismatchError(err)) throw err;

            if (repairCount >= MAX_REPAIRS) {
                logger.error('withLocationRepair: exhausted max repairs', {
                    merchantId,
                    variationIds,
                    repairCount
                });
                throw new Error(
                    'Location mismatch repair exhausted after ' + MAX_REPAIRS +
                    ' attempts — manual review required'
                );
            }

            const parsed = parseLocationMismatchDetail(err);
            if (!parsed) {
                logger.warn('withLocationRepair: unparseable detail, rethrowing', {
                    merchantId,
                    detail: getLocationMismatchDetail(err)
                });
                throw err;
            }

            // Lazy require — see circular dependency note in module JSDoc.
            // eslint-disable-next-line global-require
            const { enableItemAtAllLocations } = require('./square-diagnostics');
            await enableItemAtAllLocations(parsed.itemId, merchantId);
            logger.info('withLocationRepair: repaired parent', {
                itemId: parsed.itemId,
                locationId: parsed.locationId,
                merchantId,
                repairCount: repairCount + 1
            });
            await sleep(2000);
            repairCount++;
        }
    }

    return { result: lastResult, repairedCount: repairCount };
}

module.exports = { withLocationRepair };
