/**
 * Tests for square-location-preflight.js
 *
 * Covers repairParentLocationMismatches and isItemEnabledAtLocation:
 * - All variations healthy → no repair calls
 * - Some variations have mismatched parents → repair called per mismatch
 * - Repair fails for one parent → logged, remaining repairs still attempted
 * - No parent item IDs found → returns 0 early
 * - Parent item fetch fails → logged, no repair attempted for that batch
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/square/square-client', () => ({
    makeSquareRequest: jest.fn(),
    sleep: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../services/square/square-diagnostics', () => ({
    enableItemAtAllLocations: jest.fn(),
}));

jest.mock('../../../config/constants', () => ({
    SYNC: { CATALOG_BATCH_SIZE: 100, INTER_BATCH_DELAY_MS: 0 },
}));

const logger = require('../../../utils/logger');
const { makeSquareRequest, sleep } = require('../../../services/square/square-client');
const { enableItemAtAllLocations } = require('../../../services/square/square-diagnostics');
const {
    repairParentLocationMismatches,
    isItemEnabledAtLocation,
    hasLocationMismatch,
} = require('../../../services/square/square-location-preflight');

const MERCHANT_ID = 1;
const ACCESS_TOKEN = 'test-token';

beforeEach(() => {
    jest.clearAllMocks();
});

// ==================== isItemEnabledAtLocation ====================

describe('isItemEnabledAtLocation', () => {
    test('returns true when present_at_all_locations is true', () => {
        expect(isItemEnabledAtLocation({ present_at_all_locations: true }, 'LOC1')).toBe(true);
    });

    test('returns true when present_at_all_locations is true and absent list is empty', () => {
        expect(isItemEnabledAtLocation({
            present_at_all_locations: true,
            absent_at_location_ids: [],
        }, 'LOC1')).toBe(true);
    });

    test('returns false when present_at_all_locations is true but location is in absent_at_location_ids', () => {
        // This is the production bug: item U6HPEUEJWY3T7NQMDGJQ4DZL had
        // present_at_all_locations=true AND absent_at_location_ids=["EDVJ38R7K424Q"].
        // The old code returned true immediately, causing Square 400 INVALID_VALUE.
        expect(isItemEnabledAtLocation({
            present_at_all_locations: true,
            absent_at_location_ids: ['LOC1'],
        }, 'LOC1')).toBe(false);
    });

    test('returns true when present_at_all_locations is true and a different location is absent', () => {
        expect(isItemEnabledAtLocation({
            present_at_all_locations: true,
            absent_at_location_ids: ['LOC2'],
        }, 'LOC1')).toBe(true);
    });

    test('returns true when locationId is in present_at_location_ids', () => {
        expect(isItemEnabledAtLocation({
            present_at_all_locations: false,
            present_at_location_ids: ['LOC1', 'LOC2'],
        }, 'LOC1')).toBe(true);
    });

    test('returns false when not present_at_all and location not in list', () => {
        expect(isItemEnabledAtLocation({
            present_at_all_locations: false,
            present_at_location_ids: ['LOC2'],
        }, 'LOC1')).toBe(false);
    });

    test('returns false when present_at_location_ids is empty', () => {
        expect(isItemEnabledAtLocation({
            present_at_all_locations: false,
            present_at_location_ids: [],
        }, 'LOC1')).toBe(false);
    });

    test('returns false when present_at_location_ids is absent', () => {
        expect(isItemEnabledAtLocation({ present_at_all_locations: false }, 'LOC1')).toBe(false);
    });
});

// ==================== repairParentLocationMismatches ====================

// Build a fake retrieved variation object
function makeVariation(variationId, itemId) {
    return [variationId, {
        id: variationId,
        type: 'ITEM_VARIATION',
        item_variation_data: { item_id: itemId },
    }];
}

// Build a fake parent item Square object
function makeParentItem(itemId, {
    presentAtAll = true,
    presentAtLocationIds = [],
    absentAtLocationIds = []
} = {}) {
    return {
        id: itemId,
        type: 'ITEM',
        present_at_all_locations: presentAtAll,
        present_at_location_ids: presentAtLocationIds,
        absent_at_location_ids: absentAtLocationIds,
    };
}

describe('repairParentLocationMismatches — all healthy (no repair)', () => {
    test('no repair when parent item is present_at_all_locations=true', async () => {
        const retrievedVariations = new Map([makeVariation('VAR1', 'ITEM1')]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 5]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', { presentAtAll: true })],
        });

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(result).toEqual({ repairedParents: 0 });
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
    });

    test('no repair when parent item lists the specific location', async () => {
        const retrievedVariations = new Map([makeVariation('VAR1', 'ITEM1')]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 3]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', { presentAtAll: false, presentAtLocationIds: ['LOC1'] })],
        });

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(result).toEqual({ repairedParents: 0 });
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
    });

    test('returns 0 early when no variations have item_id', async () => {
        const retrievedVariations = new Map([
            ['VAR1', { id: 'VAR1', item_variation_data: {} }],
        ]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 2]])]]);

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(result).toEqual({ repairedParents: 0 });
        expect(makeSquareRequest).not.toHaveBeenCalled();
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
    });

    test('returns 0 early when retrievedVariations is empty', async () => {
        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, new Map(), new Map()
        );
        expect(result).toEqual({ repairedParents: 0 });
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });
});

describe('repairParentLocationMismatches — mismatch detected and repaired', () => {
    test('calls enableItemAtAllLocations for mismatched parent', async () => {
        const retrievedVariations = new Map([makeVariation('VAR1', 'ITEM1')]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 5]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', { presentAtAll: false, presentAtLocationIds: [] })],
        });
        enableItemAtAllLocations.mockResolvedValueOnce({ success: true, itemId: 'ITEM1' });

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', MERCHANT_ID);
        expect(result).toEqual({ repairedParents: 1 });
    });

    test('repairs only the mismatched parent, not the healthy one', async () => {
        const retrievedVariations = new Map([
            makeVariation('VAR1', 'ITEM1'),
            makeVariation('VAR2', 'ITEM2'),
        ]);
        const changesByVariation = new Map([
            ['VAR1', new Map([['LOC1', 5]])],
            ['VAR2', new Map([['LOC1', 3]])],
        ]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [
                makeParentItem('ITEM1', { presentAtAll: false, presentAtLocationIds: [] }),
                makeParentItem('ITEM2', { presentAtAll: true }),
            ],
        });
        enableItemAtAllLocations.mockResolvedValueOnce({ success: true, itemId: 'ITEM1' });

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(1);
        expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', MERCHANT_ID);
        expect(result).toEqual({ repairedParents: 1 });
    });

    test('deduplicates parent repairs when multiple variations share one parent', async () => {
        const retrievedVariations = new Map([
            makeVariation('VAR1', 'ITEM1'),
            makeVariation('VAR2', 'ITEM1'), // same parent
        ]);
        const changesByVariation = new Map([
            ['VAR1', new Map([['LOC1', 2]])],
            ['VAR2', new Map([['LOC1', 4]])],
        ]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', { presentAtAll: false })],
        });
        enableItemAtAllLocations.mockResolvedValueOnce({ success: true, itemId: 'ITEM1' });

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ repairedParents: 1 });
    });

    test('calls repair when parent has present_at_all_locations=true but location is in absent_at_location_ids', async () => {
        // Production case: item present_at_all_locations=true AND absent_at_location_ids=["LOC1"]
        // Variation is being synced at LOC1 → Square would return 400 INVALID_VALUE
        const retrievedVariations = new Map([makeVariation('VAR1', 'ITEM1')]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 5]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', { presentAtAll: true, absentAtLocationIds: ['LOC1'] })],
        });
        enableItemAtAllLocations.mockResolvedValueOnce({ success: true, itemId: 'ITEM1' });

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', MERCHANT_ID);
        expect(result).toEqual({ repairedParents: 1 });
    });

    test('no repair when present_at_all_locations=true and absent list does not include the location', async () => {
        const retrievedVariations = new Map([makeVariation('VAR1', 'ITEM1')]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 5]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', { presentAtAll: true, absentAtLocationIds: ['LOC2'] })],
        });

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(result).toEqual({ repairedParents: 0 });
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
    });

    test('logs completion with repaired and failed arrays', async () => {
        const retrievedVariations = new Map([makeVariation('VAR1', 'ITEM1')]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 5]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', { presentAtAll: false })],
        });
        enableItemAtAllLocations.mockResolvedValueOnce({ success: true, itemId: 'ITEM1' });

        await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(logger.info).toHaveBeenCalledWith(
            'repairParentLocationMismatches complete',
            expect.objectContaining({
                merchantId: MERCHANT_ID,
                repaired: ['ITEM1'],
                failed: [],
            })
        );
    });
});

describe('repairParentLocationMismatches — repair failure', () => {
    test('logs warning and continues when one repair fails, counts only successes', async () => {
        const retrievedVariations = new Map([
            makeVariation('VAR1', 'ITEM1'),
            makeVariation('VAR2', 'ITEM2'),
        ]);
        const changesByVariation = new Map([
            ['VAR1', new Map([['LOC1', 2]])],
            ['VAR2', new Map([['LOC1', 3]])],
        ]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [
                makeParentItem('ITEM1', { presentAtAll: false }),
                makeParentItem('ITEM2', { presentAtAll: false }),
            ],
        });
        enableItemAtAllLocations
            .mockRejectedValueOnce(new Error('Square unavailable'))
            .mockResolvedValueOnce({ success: true, itemId: 'ITEM2' });

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(2);
        expect(result.repairedParents).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
            'repairParentLocationMismatches: repair failed for item',
            expect.objectContaining({ merchantId: MERCHANT_ID, error: 'Square unavailable' })
        );
    });

    test('returns repairedParents=0 when all repairs fail', async () => {
        const retrievedVariations = new Map([makeVariation('VAR1', 'ITEM1')]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 2]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', { presentAtAll: false })],
        });
        enableItemAtAllLocations.mockRejectedValueOnce(new Error('timeout'));

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(result).toEqual({ repairedParents: 0 });
    });
});

describe('hasLocationMismatch — structural check', () => {
    test('no mismatch when both present_at_all=true with identical absent lists', () => {
        const variation = { present_at_all_locations: true, absent_at_location_ids: ['EDV'] };
        const parent = { present_at_all_locations: true, absent_at_location_ids: ['EDV'] };
        expect(hasLocationMismatch(variation, parent)).toBe(false);
    });

    test('mismatch when variation.present_at_all=true but parent.present_at_all=false', () => {
        const variation = { present_at_all_locations: true, absent_at_location_ids: [] };
        const parent = { present_at_all_locations: false, present_at_location_ids: ['LOC1'] };
        expect(hasLocationMismatch(variation, parent)).toBe(true);
    });

    test('mismatch when parent is absent at a location the variation is present at (via present_at_all minus absent)', () => {
        // Variation is enabled everywhere except LOC_OTHER.
        // Parent is enabled everywhere except LOC_X.
        // So at LOC_X: variation is enabled but parent is not → mismatch.
        const variation = {
            present_at_all_locations: true,
            absent_at_location_ids: ['LOC_OTHER'],
        };
        const parent = {
            present_at_all_locations: true,
            absent_at_location_ids: ['LOC_X'],
        };
        expect(hasLocationMismatch(variation, parent)).toBe(true);
    });

    test('no mismatch when parent absent list is a subset of variation absent list', () => {
        const variation = {
            present_at_all_locations: true,
            absent_at_location_ids: ['LOC_A', 'LOC_B'],
        };
        const parent = {
            present_at_all_locations: true,
            absent_at_location_ids: ['LOC_A'],
        };
        expect(hasLocationMismatch(variation, parent)).toBe(false);
    });

    test('mismatch when !present_at_all and parent missing a present location', () => {
        const variation = {
            present_at_all_locations: false,
            present_at_location_ids: ['LOC1', 'LOC2'],
        };
        const parent = {
            present_at_all_locations: false,
            present_at_location_ids: ['LOC1'],
        };
        expect(hasLocationMismatch(variation, parent)).toBe(true);
    });

    test('no mismatch when !present_at_all and parent covers all variation locations', () => {
        const variation = {
            present_at_all_locations: false,
            present_at_location_ids: ['LOC1'],
        };
        const parent = {
            present_at_all_locations: true,
            absent_at_location_ids: [],
        };
        expect(hasLocationMismatch(variation, parent)).toBe(false);
    });
});

describe('repairParentLocationMismatches — structural consistency check', () => {
    test('repairs when variation is present at location the parent is absent from, even if sync location is healthy', () => {
        // Sync location (LTZ) is OK for both, but the variation is also
        // implicitly enabled at every other location (present_at_all=true)
        // including LOC_X where the parent is absent. That's a latent
        // mismatch that would break other pushes, so repair proactively.
        const retrievedVariations = new Map([[
            'VAR1',
            {
                id: 'VAR1',
                type: 'ITEM_VARIATION',
                present_at_all_locations: true,
                absent_at_location_ids: [],
                item_variation_data: { item_id: 'ITEM1' },
            },
        ]]);
        const changesByVariation = new Map([['VAR1', new Map([['LTZ', 5]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', {
                presentAtAll: true,
                absentAtLocationIds: ['LOC_X'],
            })],
        });
        enableItemAtAllLocations.mockResolvedValueOnce({ success: true, itemId: 'ITEM1' });

        return repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        ).then(result => {
            expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', MERCHANT_ID);
            expect(result).toEqual({ repairedParents: 1 });
        });
    });

    test('no repair when variation.absent matches parent.absent and sync location is covered', () => {
        // The specific production case described in the bug report:
        // both variation and parent have identical absent_at_location_ids.
        // Structurally consistent — proactive check finds nothing to do.
        // (The reactive path in withLocationRepair handles this.)
        const retrievedVariations = new Map([[
            'VAR1',
            {
                id: 'VAR1',
                type: 'ITEM_VARIATION',
                present_at_all_locations: true,
                absent_at_location_ids: ['EDV'],
                item_variation_data: { item_id: 'ITEM1' },
            },
        ]]);
        const changesByVariation = new Map([['VAR1', new Map([['LTZ', 5]])]]);

        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeParentItem('ITEM1', {
                presentAtAll: true,
                absentAtLocationIds: ['EDV'],
            })],
        });

        return repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        ).then(result => {
            expect(result).toEqual({ repairedParents: 0 });
            expect(enableItemAtAllLocations).not.toHaveBeenCalled();
        });
    });
});

describe('repairParentLocationMismatches — parent fetch failure', () => {
    test('logs warning when parent item batch-retrieve fails, skips repair', async () => {
        const retrievedVariations = new Map([makeVariation('VAR1', 'ITEM1')]);
        const changesByVariation = new Map([['VAR1', new Map([['LOC1', 2]])]]);

        makeSquareRequest.mockRejectedValueOnce(new Error('network error'));

        const result = await repairParentLocationMismatches(
            MERCHANT_ID, ACCESS_TOKEN, retrievedVariations, changesByVariation
        );

        expect(result).toEqual({ repairedParents: 0 });
        expect(enableItemAtAllLocations).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'repairParentLocationMismatches: failed to retrieve parent items',
            expect.objectContaining({ merchantId: MERCHANT_ID, error: 'network error' })
        );
    });
});
