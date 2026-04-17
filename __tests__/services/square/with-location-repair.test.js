/**
 * Tests for services/square/with-location-repair.js
 *
 * Covers:
 *   - fn succeeds first try → no repair called
 *   - INVALID_VALUE/item_id with parseable detail → repair + sleep, retried,
 *     repairedCount: 1
 *   - Two different parents in batch → both repaired → repairedCount: 2
 *   - MAX_REPAIRS exhausted → throws descriptive "manual review required" error
 *   - Non-location-mismatch error → rethrown immediately, no repair
 *   - parseLocationMismatchDetail fails → warning logged, original error rethrown
 *   - Retry fails with a DIFFERENT error → that different error propagates
 *   - INVALID_VALUE but field !== item_id → rethrown immediately
 *   - Repair throws → error propagates (repair is not fire-and-forget)
 *   - sleep called with 2000 ms after each repair
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../../services/square/square-diagnostics', () => ({
    enableItemAtAllLocations: jest.fn()
}));

jest.mock('../../../services/square/square-client', () => ({
    sleep: jest.fn().mockResolvedValue(undefined)
}));

const { withLocationRepair } = require('../../../services/square/with-location-repair');
const { enableItemAtAllLocations } = require('../../../services/square/square-diagnostics');
const { sleep } = require('../../../services/square/square-client');
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
    sleep.mockResolvedValue(undefined);
});

describe('withLocationRepair', () => {
    test('fn succeeds first try — no repair called, returns { result, repairedCount: 0 }', async () => {
        const successResult = { objects: [{ id: 'VAR1' }] };
        const fn = jest.fn().mockResolvedValue(successResult);

        const ret = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        });

        expect(ret.result).toBe(successResult);
        expect(ret.repairedCount).toBe(0);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
    });

    test('single repair succeeds after delay → repairedCount: 1', async () => {
        const locationError = makeParsedLocationError();
        const retryResult = { objects: [{ id: 'VAR1' }] };
        const fn = jest.fn()
            .mockRejectedValueOnce(locationError)
            .mockResolvedValueOnce(retryResult);

        const ret = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        });

        expect(ret.result).toBe(retryResult);
        expect(ret.repairedCount).toBe(1);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(1);
        expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', MERCHANT_ID);
    });

    test('sleep called with 2000 ms after each repair', async () => {
        const locationError = makeParsedLocationError();
        const retryResult = { objects: [] };
        const fn = jest.fn()
            .mockRejectedValueOnce(locationError)
            .mockResolvedValueOnce(retryResult);

        await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        });

        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(2000);
    });

    test('two different parents in batch → both repaired → repairedCount: 2', async () => {
        const errorItem1 = makeParsedLocationError({ itemId: 'ITEM1', locationId: 'LOC_A' });
        const errorItem2 = makeParsedLocationError({ itemId: 'ITEM2', locationId: 'LOC_B' });
        const finalResult = { objects: [{ id: 'VAR1' }] };
        const fn = jest.fn()
            .mockRejectedValueOnce(errorItem1)
            .mockRejectedValueOnce(errorItem2)
            .mockResolvedValueOnce(finalResult);

        const ret = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        });

        expect(ret.result).toBe(finalResult);
        expect(ret.repairedCount).toBe(2);
        expect(fn).toHaveBeenCalledTimes(3);
        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(2);
        expect(enableItemAtAllLocations).toHaveBeenNthCalledWith(1, 'ITEM1', MERCHANT_ID);
        expect(enableItemAtAllLocations).toHaveBeenNthCalledWith(2, 'ITEM2', MERCHANT_ID);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(2000);
    });

    test('MAX_REPAIRS exhausted → throws with clear "manual review required" message', async () => {
        const locationError = makeParsedLocationError({ itemId: 'ITEM_X', locationId: 'LOC_Y' });
        // fn fails MAX_REPAIRS + 1 times to exhaust all repair attempts
        const fn = jest.fn().mockRejectedValue(locationError);

        const thrown = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        }).catch(e => e);

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toMatch(/manual review required/);
        expect(thrown.message).toContain('5');
        expect(fn).toHaveBeenCalledTimes(6); // initial + 5 retries
        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(5);
        expect(sleep).toHaveBeenCalledTimes(5);
        expect(logger.error).toHaveBeenCalledWith(
            'withLocationRepair: exhausted max repairs',
            expect.objectContaining({ merchantId: MERCHANT_ID, repairCount: 5 })
        );
    });

    test('retry fails with a DIFFERENT error → that different error propagates', async () => {
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
            'withLocationRepair: unparseable detail, rethrowing',
            expect.objectContaining({
                merchantId: MERCHANT_ID,
                detail: 'garbled detail'
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

    test('repair throws → error propagates immediately', async () => {
        const firstErr = makeParsedLocationError();
        const repairErr = new Error('Square down');
        const fn = jest.fn().mockRejectedValueOnce(firstErr);
        enableItemAtAllLocations.mockRejectedValueOnce(repairErr);

        const thrown = await withLocationRepair({
            merchantId: MERCHANT_ID,
            accessToken: ACCESS_TOKEN,
            fn,
            variationIds: VARIATION_IDS
        }).catch(e => e);

        expect(thrown).toBe(repairErr);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
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
