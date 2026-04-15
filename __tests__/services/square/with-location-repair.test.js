/**
 * Tests for services/square/with-location-repair.js
 *
 * Covers:
 *   - fn succeeds first try → no repair called
 *   - INVALID_VALUE + item_id → repair called, fn retried, returns result
 *   - Repair succeeds, retry still fails → throws original error
 *   - Non-INVALID_VALUE error → rethrown immediately, no repair
 *   - INVALID_VALUE but field !== item_id → rethrown immediately
 *   - Repair called with correct variationIds and merchantId
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../../services/square/square-client', () => ({
    makeSquareRequest: jest.fn()
}));

// square-location-preflight is lazy-required inside withLocationRepair to break
// a circular dependency. jest.mock still intercepts lazy require calls.
jest.mock('../../../services/square/square-location-preflight', () => ({
    repairParentLocationMismatches: jest.fn()
}));

// square-diagnostics is lazy-required for targeted parent repair.
jest.mock('../../../services/square/square-diagnostics', () => ({
    enableItemAtAllLocations: jest.fn()
}));

const { withLocationRepair } = require('../../../services/square/with-location-repair');
const { makeSquareRequest } = require('../../../services/square/square-client');
const { repairParentLocationMismatches } = require('../../../services/square/square-location-preflight');
const { enableItemAtAllLocations } = require('../../../services/square/square-diagnostics');
const logger = require('../../../utils/logger');

const MERCHANT_ID = 1;
const ACCESS_TOKEN = 'test-access-token';
const VARIATION_IDS = ['VAR1', 'VAR2'];

/** Build a location-mismatch error (INVALID_VALUE + item_id). */
function makeLocationError(msg = 'Location mismatch') {
    const err = new Error(msg);
    err.squareErrors = [{ code: 'INVALID_VALUE', field: 'item_id', detail: 'mismatch' }];
    return err;
}

/** Build the batch-retrieve response for the given variation IDs. */
function makeBatchRetrieveResponse(ids) {
    return {
        objects: ids.map(id => ({
            id,
            type: 'ITEM_VARIATION',
            present_at_all_locations: true,
            item_variation_data: { item_id: `ITEM_FOR_${id}` }
        }))
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    // Default: repair succeeds with 1 repaired parent
    repairParentLocationMismatches.mockResolvedValue({ repairedParents: 1 });
    enableItemAtAllLocations.mockResolvedValue({ success: true });
    // Default: batch-retrieve returns variation objects
    makeSquareRequest.mockResolvedValue(makeBatchRetrieveResponse(VARIATION_IDS));
});

/** Build a location-mismatch error whose detail matches Square's production format. */
function makeParsedLocationError({
    variationId = 'VAR1',
    locationId = 'LOC_X',
    itemId = 'ITEM1',
    msg = 'Location mismatch'
} = {}) {
    const err = new Error(msg);
    err.squareErrors = [{
        code: 'INVALID_VALUE',
        field: 'item_id',
        detail: 'Object `' + variationId + '` of type ITEM_VARIATION is enabled at unit `'
            + locationId + '`, but the referenced object with token `' + itemId
            + '` of type ITEM is not.'
    }];
    return err;
}

describe('withLocationRepair', () => {
    test('fn succeeds first try — no repair called, returns result', async () => {
        const successResult = { objects: [{ id: 'VAR1' }] };
        const fn = jest.fn().mockResolvedValue(successResult);

        const result = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        });

        expect(result).toBe(successResult);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(repairParentLocationMismatches).not.toHaveBeenCalled();
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('INVALID_VALUE + item_id → repair called, fn retried, returns retry result', async () => {
        const locationError = makeLocationError();
        const retryResult = { objects: [{ id: 'VAR1' }] };
        const fn = jest.fn()
            .mockRejectedValueOnce(locationError)
            .mockResolvedValueOnce(retryResult);

        const result = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        });

        expect(result).toBe(retryResult);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(repairParentLocationMismatches).toHaveBeenCalledTimes(1);
    });

    test('repair succeeds, retry still fails → throws original error (not retry error)', async () => {
        const originalError = makeLocationError('original error');
        const fn = jest.fn().mockRejectedValue(originalError);

        const thrown = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        }).catch(e => e);

        expect(thrown).toBe(originalError);
        expect(thrown.message).toBe('original error');
        expect(thrown.repairAttempted).toBe(true);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(repairParentLocationMismatches).toHaveBeenCalledTimes(1);
    });

    test('non-INVALID_VALUE error → rethrown immediately, no repair, fn called once', async () => {
        const serverError = new Error('Internal server error');
        serverError.squareErrors = [{ code: 'INTERNAL_SERVER_ERROR' }];
        const fn = jest.fn().mockRejectedValue(serverError);

        await expect(
            withLocationRepair({
                merchantId: MERCHANT_ID,
                accessToken: ACCESS_TOKEN,
                fn,
                variationIds: VARIATION_IDS
            })
        ).rejects.toThrow('Internal server error');

        expect(fn).toHaveBeenCalledTimes(1);
        expect(repairParentLocationMismatches).not.toHaveBeenCalled();
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('INVALID_VALUE but field !== item_id → rethrown immediately, no repair', async () => {
        const wrongFieldError = new Error('Invalid value');
        wrongFieldError.squareErrors = [{ code: 'INVALID_VALUE', field: 'price_money' }];
        const fn = jest.fn().mockRejectedValue(wrongFieldError);

        await expect(
            withLocationRepair({
                merchantId: MERCHANT_ID,
                accessToken: ACCESS_TOKEN,
                fn,
                variationIds: VARIATION_IDS
            })
        ).rejects.toThrow('Invalid value');

        expect(fn).toHaveBeenCalledTimes(1);
        expect(repairParentLocationMismatches).not.toHaveBeenCalled();
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('repair called with correct merchantId and variationIds via batch-retrieve', async () => {
        const specificIds = ['VAR_A', 'VAR_B'];
        const locationError = makeLocationError();
        const fn = jest.fn()
            .mockRejectedValueOnce(locationError)
            .mockResolvedValueOnce({ objects: [] });

        makeSquareRequest.mockResolvedValue(makeBatchRetrieveResponse(specificIds));

        await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: specificIds
        });

        // Verify batch-retrieve was called with the exact variationIds
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/batch-retrieve',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    object_ids: specificIds,
                    include_related_objects: false
                }),
                accessToken: ACCESS_TOKEN
            })
        );

        // Verify repairParentLocationMismatches received the correct merchantId and accessToken
        expect(repairParentLocationMismatches).toHaveBeenCalledWith(
            MERCHANT_ID,
            ACCESS_TOKEN,
            expect.any(Map),
            expect.any(Map)
        );
    });

    test('retrieved variations populate changesByVariation with correct location data', async () => {
        const locationError = makeLocationError();
        const fn = jest.fn()
            .mockRejectedValueOnce(locationError)
            .mockResolvedValueOnce({});

        // Return a variation with specific location IDs (not present_at_all_locations)
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'VAR1',
                type: 'ITEM_VARIATION',
                present_at_all_locations: false,
                present_at_location_ids: ['LOC_A', 'LOC_B'],
                item_variation_data: { item_id: 'ITEM1' }
            }]
        });

        await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: ['VAR1']
        });

        const [, , , changesByVariation] = repairParentLocationMismatches.mock.calls[0];
        expect(changesByVariation.has('VAR1')).toBe(true);
        const locMap = changesByVariation.get('VAR1');
        expect(locMap.has('LOC_A')).toBe(true);
        expect(locMap.has('LOC_B')).toBe(true);
    });

    test('repair step failure is non-fatal — retry still happens', async () => {
        const locationError = makeLocationError();
        const retryResult = { objects: [] };
        const fn = jest.fn()
            .mockRejectedValueOnce(locationError)
            .mockResolvedValueOnce(retryResult);

        repairParentLocationMismatches.mockRejectedValue(new Error('repair API failed'));

        const result = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        });

        expect(result).toBe(retryResult);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            'withLocationRepair: repair step failed, proceeding to retry',
            expect.objectContaining({ merchantId: MERCHANT_ID })
        );
    });

    test('parses error detail and calls enableItemAtAllLocations with parsed itemId', async () => {
        // Production case: Square's error detail names a location (EDVJ...)
        // that differs from the sync location. repairParentLocationMismatches
        // can't see this via the catalog object, so we parse the detail and
        // directly enable the referenced parent everywhere.
        const err = makeParsedLocationError({
            variationId: 'ZAI3NVSTGMENOL6BNFZOGHQO',
            locationId: 'EDVJ38R7K424Q',
            itemId: '2SN7XICAOQNROZZB2HVLB42Y'
        });
        const retryResult = { objects: [] };
        const fn = jest.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce(retryResult);

        const result = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: ['ZAI3NVSTGMENOL6BNFZOGHQO']
        });

        expect(result).toBe(retryResult);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(enableItemAtAllLocations).toHaveBeenCalledWith(
            '2SN7XICAOQNROZZB2HVLB42Y', MERCHANT_ID
        );
        // When the detail parses, the fallback path should be skipped.
        expect(repairParentLocationMismatches).not.toHaveBeenCalled();
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('parsed-detail path: targeted repair failure is non-fatal, retry still happens', async () => {
        const err = makeParsedLocationError();
        const retryResult = { objects: [] };
        const fn = jest.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce(retryResult);
        enableItemAtAllLocations.mockRejectedValueOnce(new Error('Square down'));

        const result = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: ['VAR1']
        });

        expect(result).toBe(retryResult);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            'withLocationRepair: targeted repair failed, proceeding to retry',
            expect.objectContaining({ merchantId: MERCHANT_ID, itemId: 'ITEM1' })
        );
    });

    test('unparseable detail falls back to batch-retrieve + repairParentLocationMismatches', async () => {
        // Detail doesn't match the regex → fall through to the old path.
        const err = new Error('mismatch');
        err.squareErrors = [{ code: 'INVALID_VALUE', field: 'item_id', detail: 'unparseable' }];
        const retryResult = { objects: [] };
        const fn = jest.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce(retryResult);

        await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        });

        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
        expect(repairParentLocationMismatches).toHaveBeenCalled();
        expect(makeSquareRequest).toHaveBeenCalled();
    });

    test('plain error without squareErrors → rethrown immediately', async () => {
        const plainError = new Error('plain failure');
        const fn = jest.fn().mockRejectedValue(plainError);

        await expect(
            withLocationRepair({
                merchantId: MERCHANT_ID,
                accessToken: ACCESS_TOKEN,
                fn,
                variationIds: VARIATION_IDS
            })
        ).rejects.toThrow('plain failure');

        expect(fn).toHaveBeenCalledTimes(1);
        expect(repairParentLocationMismatches).not.toHaveBeenCalled();
    });
});
