/**
 * Tests for services/square/with-location-repair.js
 *
 * Covers:
 *   - fn succeeds first try → no repair called
 *   - INVALID_VALUE/item_id with parseable detail → repair called, retried,
 *     returns retry result
 *   - Retry STILL fails with INVALID_VALUE/item_id → throws descriptive
 *     "manual review required" error, does NOT repair again
 *   - Retry fails with a DIFFERENT error → that different error propagates
 *   - parseLocationMismatchDetail fails → warning logged with raw detail,
 *     original error rethrown, no repair attempted
 *   - Non-INVALID_VALUE error → rethrown immediately
 *   - INVALID_VALUE but field !== item_id → rethrown immediately
 *   - Repair throws (non-fatal) → retry still attempted
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// square-diagnostics is lazy-required for targeted parent repair.
jest.mock('../../../services/square/square-diagnostics', () => ({
    enableItemAtAllLocations: jest.fn()
}));

const { withLocationRepair } = require('../../../services/square/with-location-repair');
const { enableItemAtAllLocations } = require('../../../services/square/square-diagnostics');
const logger = require('../../../utils/logger');

const MERCHANT_ID = 1;
const ACCESS_TOKEN = 'test-access-token';
const VARIATION_IDS = ['VAR1', 'VAR2'];

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

/** Build a location-mismatch error whose detail does NOT match the expected format. */
function makeUnparseableLocationError(detail = 'unparseable detail') {
    const err = new Error('mismatch');
    err.squareErrors = [{ code: 'INVALID_VALUE', field: 'item_id', detail }];
    return err;
}

beforeEach(() => {
    jest.clearAllMocks();
    enableItemAtAllLocations.mockResolvedValue({ success: true });
});

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
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
    });

    test('INVALID_VALUE + item_id with parseable detail → repair called, fn retried, returns retry result', async () => {
        const locationError = makeParsedLocationError();
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
        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(1);
        expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', MERCHANT_ID);
    });

    test('retry STILL fails with INVALID_VALUE/item_id → throws manual-review error, no second repair', async () => {
        const firstErr = makeParsedLocationError({ itemId: 'ITEM_X', locationId: 'LOC_Y' });
        const retryErr = makeParsedLocationError({ itemId: 'ITEM_X', locationId: 'LOC_Y' });
        const fn = jest.fn()
            .mockRejectedValueOnce(firstErr)
            .mockRejectedValueOnce(retryErr);

        const thrown = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        }).catch(e => e);

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toMatch(/manual review required/);
        expect(thrown.message).toContain('ITEM_X');
        expect(thrown.message).toContain('LOC_Y');
        expect(thrown.repairAttempted).toBe(true);
        expect(thrown.parsedItemId).toBe('ITEM_X');
        expect(thrown.parsedLocationId).toBe('LOC_Y');
        expect(fn).toHaveBeenCalledTimes(2);
        // Exactly ONE repair attempt — never retried.
        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            'withLocationRepair: retry still failing with location mismatch after repair',
            expect.objectContaining({
                merchantId: MERCHANT_ID,
                parsedItemId: 'ITEM_X',
                parsedLocationId: 'LOC_Y'
            })
        );
    });

    test('retry fails with a DIFFERENT error → that different error propagates (not manual-review message)', async () => {
        const firstErr = makeParsedLocationError();
        const otherErr = new Error('Rate limited');
        otherErr.squareErrors = [{ code: 'RATE_LIMITED' }];
        const fn = jest.fn()
            .mockRejectedValueOnce(firstErr)
            .mockRejectedValueOnce(otherErr);

        const thrown = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        }).catch(e => e);

        expect(thrown).toBe(otherErr);
        expect(thrown.message).toBe('Rate limited');
        expect(thrown.message).not.toMatch(/manual review required/);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(1);
    });

    test('parseLocationMismatchDetail fails → original error rethrown, no repair attempted, warning logged', async () => {
        const firstErr = makeUnparseableLocationError('garbled detail');
        const fn = jest.fn().mockRejectedValueOnce(firstErr);

        const thrown = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        }).catch(e => e);

        expect(thrown).toBe(firstErr);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'withLocationRepair: could not parse location mismatch detail, aborting repair',
            expect.objectContaining({
                merchantId: MERCHANT_ID,
                variationIds: VARIATION_IDS,
                rawDetail: 'garbled detail'
            })
        );
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
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
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
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
    });

    test('repair throws internally → retry still happens (repair failure is non-fatal)', async () => {
        const firstErr = makeParsedLocationError();
        const retryResult = { objects: [] };
        const fn = jest.fn()
            .mockRejectedValueOnce(firstErr)
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
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
    });
});
