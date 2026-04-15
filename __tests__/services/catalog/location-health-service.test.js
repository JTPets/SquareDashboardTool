/**
 * Tests for services/catalog/location-health-service.js
 *
 * Covers: checkAndRecordHealth — mismatch detection, DB INSERT correctness
 * (check_type must be explicitly 'location_mismatch'), and resolve logic.
 *
 * The INSERT check_type fix matters because enableItemAtAllLocations resolves
 * catalog_location_health rows by filtering on check_type = 'location_mismatch'.
 * Rows without an explicit check_type would survive the resolve query and cause
 * the health panel to show open issues after a successful fix.
 */

const db = require('../../../utils/database');

jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
}));

const { makeSquareRequest } = require('../../../services/square/square-client');
const { checkAndRecordHealth } = require('../../../services/catalog/location-health-service');

const MERCHANT_ID = 3; // must be DEBUG_MERCHANT_ID

beforeEach(() => {
    jest.clearAllMocks();
});

// Build a minimal Square ITEM catalog object with nested variations
function makeSquareItem(id, variations = [], overrides = {}) {
    return {
        type: 'ITEM',
        id,
        present_at_all_locations: true,
        item_data: { name: `Item ${id}`, variations },
        ...overrides,
    };
}

// Build a minimal Square ITEM_VARIATION object
function makeSquareVariation(id, overrides = {}) {
    return {
        type: 'ITEM_VARIATION',
        id,
        present_at_all_locations: true,
        ...overrides,
    };
}

// Return a single-page Square catalog response (no cursor = end of pages)
function squarePage(objects) {
    return { objects, cursor: null };
}

describe('checkAndRecordHealth', () => {
    it('throws when called with a merchant other than 3', async () => {
        await expect(checkAndRecordHealth(1)).rejects.toThrow();
        await expect(checkAndRecordHealth(99)).rejects.toThrow();
    });

    // =========================================================================
    // check_type in INSERT
    // =========================================================================
    describe('INSERT sets check_type = location_mismatch explicitly', () => {
        it('includes check_type in the column list and uses literal location_mismatch', async () => {
            // item=TRUE, variation=FALSE → mismatch detected → INSERT triggered
            const variation = makeSquareVariation('VAR_1', { present_at_all_locations: false });
            const item = makeSquareItem('ITEM_1', [variation], { present_at_all_locations: true });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            db.query
                .mockResolvedValueOnce({ rows: [] })   // SELECT open mismatches
                .mockResolvedValueOnce({ rows: [] });   // INSERT

            await checkAndRecordHealth(MERCHANT_ID);

            const insertCall = db.query.mock.calls.find(
                ([sql]) => sql.trim().toUpperCase().startsWith('INSERT')
            );
            expect(insertCall).toBeDefined();
            const [insertSql] = insertCall;
            // The column must be explicit in the INSERT so enableItemAtAllLocations
            // can resolve it via WHERE check_type = 'location_mismatch'
            expect(insertSql).toMatch(/check_type/i);
            expect(insertSql).toContain('location_mismatch');
        });
    });

    // =========================================================================
    // Mismatch detection — both directions
    // =========================================================================
    describe('mismatch detection', () => {
        it('detects item=TRUE variation=FALSE (item more permissive than variation)', async () => {
            const variation = makeSquareVariation('VAR_1', { present_at_all_locations: false });
            const item = makeSquareItem('ITEM_1', [variation], { present_at_all_locations: true });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.newMismatches).toBe(1);
            expect(result.checked).toBe(1);
        });

        it('detects item=FALSE variation=TRUE (variation more permissive than item)', async () => {
            const variation = makeSquareVariation('VAR_1', { present_at_all_locations: true });
            const item = makeSquareItem('ITEM_1', [variation], { present_at_all_locations: false });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.newMismatches).toBe(1);
        });

        it('does not flag when item and variation both have present_at_all_locations=true', async () => {
            const variation = makeSquareVariation('VAR_1', { present_at_all_locations: true });
            const item = makeSquareItem('ITEM_1', [variation], { present_at_all_locations: true });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            db.query.mockResolvedValueOnce({ rows: [] }); // SELECT only — no INSERT expected

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.newMismatches).toBe(0);
            const insertCall = db.query.mock.calls.find(
                ([sql]) => sql.trim().toUpperCase().startsWith('INSERT')
            );
            expect(insertCall).toBeUndefined();
        });

        it('detects mismatch when item present_at_all=true has absent_at_location_ids and variation present_at_all=true', async () => {
            // Production case: item present_at_all=true AND absent_at_location_ids=["LOC_X"].
            // Variation present_at_all=true means it IS at LOC_X while the parent is NOT.
            const variation = makeSquareVariation('VAR_1', { present_at_all_locations: true });
            const item = makeSquareItem('ITEM_1', [variation], {
                present_at_all_locations: true,
                absent_at_location_ids: ['LOC_X'],
            });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.newMismatches).toBe(1);
        });

        it('detects mismatch when item present_at_all=true has absent_at_location_ids and variation lists that location explicitly', async () => {
            const variation = makeSquareVariation('VAR_1', {
                present_at_all_locations: false,
                present_at_location_ids: ['LOC_X'],
            });
            const item = makeSquareItem('ITEM_1', [variation], {
                present_at_all_locations: true,
                absent_at_location_ids: ['LOC_X'],
            });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.newMismatches).toBe(1);
        });

        it('does not flag when item and variation both have the same absent_at_location_ids', async () => {
            // Item absent at LOC_X, variation also absent at LOC_X → no conflict
            const variation = makeSquareVariation('VAR_1', {
                present_at_all_locations: true,
                absent_at_location_ids: ['LOC_X'],
            });
            const item = makeSquareItem('ITEM_1', [variation], {
                present_at_all_locations: true,
                absent_at_location_ids: ['LOC_X'],
            });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.newMismatches).toBe(0);
        });

        it('does not flag when both have present_at_all_locations=false with no extra location IDs', async () => {
            const variation = makeSquareVariation('VAR_1', { present_at_all_locations: false });
            const item = makeSquareItem('ITEM_1', [variation], { present_at_all_locations: false });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.newMismatches).toBe(0);
        });
    });

    // =========================================================================
    // Resolve previously open mismatches
    // =========================================================================
    describe('resolve logic', () => {
        it('resolves an existing open row when the variation is now valid', async () => {
            const variation = makeSquareVariation('VAR_1', { present_at_all_locations: true });
            const item = makeSquareItem('ITEM_1', [variation], { present_at_all_locations: true });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            // Pre-existing open mismatch for VAR_1
            db.query
                .mockResolvedValueOnce({
                    rows: [{ id: 99, variation_id: 'VAR_1', item_id: 'ITEM_1', mismatch_type: 'present_at_all_locations' }],
                })
                .mockResolvedValueOnce({ rows: [] }); // UPDATE resolved_at

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.resolved).toBe(1);
            expect(result.newMismatches).toBe(0);

            const updateCall = db.query.mock.calls.find(
                ([sql]) => sql.trim().toUpperCase().startsWith('UPDATE')
            );
            expect(updateCall).toBeDefined();
            expect(updateCall[0]).toContain('resolved_at');
        });

        it('does not re-insert for a variation that already has an open row', async () => {
            const variation = makeSquareVariation('VAR_1', { present_at_all_locations: false });
            const item = makeSquareItem('ITEM_1', [variation], { present_at_all_locations: true });

            makeSquareRequest.mockResolvedValueOnce(squarePage([item]));
            // Pre-existing open mismatch row — openByVariation already has VAR_1
            db.query.mockResolvedValueOnce({
                rows: [{ id: 42, variation_id: 'VAR_1', item_id: 'ITEM_1', mismatch_type: 'present_at_all_locations' }],
            });

            const result = await checkAndRecordHealth(MERCHANT_ID);
            expect(result.newMismatches).toBe(0);
            expect(result.existingOpen).toBe(1);
            const insertCall = db.query.mock.calls.find(
                ([sql]) => sql.trim().toUpperCase().startsWith('INSERT')
            );
            expect(insertCall).toBeUndefined();
        });
    });
});
