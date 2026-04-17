/**
 * Tests for services/catalog/location-health-service.js
 *
 * Covers:
 *   - checkAndRecordHealth: mismatch detection, insert, resolve, idempotency
 *   - getMismatchHistory: returns rows, requires merchantId
 *   - getOpenMismatches: returns open rows, requires merchantId
 */

let db;
let makeSquareRequest;
let checkAndRecordHealth;
let getMismatchHistory;
let getOpenMismatches;

beforeEach(() => {
    jest.resetModules();

    jest.mock('../../utils/database');
    jest.mock('../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }));
    jest.mock('../../services/square/square-client', () => ({
        getMerchantToken: jest.fn().mockResolvedValue('test-token'),
        makeSquareRequest: jest.fn(),
    }));
    jest.mock('../../config/constants', () => ({
        SQUARE: { MAX_PAGINATION_ITERATIONS: 100 },
    }));

    db = require('../../utils/database');
    makeSquareRequest = require('../../services/square/square-client').makeSquareRequest;
    const service = require('../../services/catalog/location-health-service');
    checkAndRecordHealth = service.checkAndRecordHealth;
    getMismatchHistory = service.getMismatchHistory;
    getOpenMismatches = service.getOpenMismatches;
});

// ============================================================================
// checkAndRecordHealth
// ============================================================================
describe('checkAndRecordHealth', () => {
    test('detects new mismatch when variation differs from parent item', async () => {
        // Square returns one item with one variation — variation has mismatched present_at_all_locations
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_1',
                type: 'ITEM',
                present_at_all_locations: true,
                item_data: {
                    variations: [{
                        id: 'VAR_1',
                        present_at_all_locations: false,
                    }]
                }
            }],
            cursor: null
        });

        // No existing open mismatches
        db.query.mockResolvedValueOnce({ rows: [] });
        // INSERT new mismatch
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await checkAndRecordHealth(3);
        expect(result.checked).toBe(1);
        expect(result.newMismatches).toBe(1);
        expect(result.resolved).toBe(0);
        expect(result.existingOpen).toBe(0);

        // Verify INSERT was called
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO catalog_location_health'),
            [3, 'VAR_1', 'ITEM_1', 'present_at_all_locations']
        );
    });

    test('does not insert duplicate when open mismatch already exists', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_1',
                type: 'ITEM',
                present_at_all_locations: true,
                item_data: {
                    variations: [{
                        id: 'VAR_1',
                        present_at_all_locations: false,
                    }]
                }
            }],
            cursor: null
        });

        // Existing open mismatch for VAR_1
        db.query.mockResolvedValueOnce({
            rows: [{ id: 42, variation_id: 'VAR_1', item_id: 'ITEM_1', mismatch_type: 'present_at_all_locations' }]
        });

        const result = await checkAndRecordHealth(3);
        expect(result.checked).toBe(1);
        expect(result.newMismatches).toBe(0);
        expect(result.existingOpen).toBe(1);

        // Only the initial SELECT should have been called, no INSERT
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('resolves previously mismatched variation that is now valid', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_1',
                type: 'ITEM',
                present_at_all_locations: true,
                item_data: {
                    variations: [{
                        id: 'VAR_1',
                        present_at_all_locations: true, // Now matches parent
                    }]
                }
            }],
            cursor: null
        });

        // Open mismatch exists for VAR_1
        db.query.mockResolvedValueOnce({
            rows: [{ id: 42, variation_id: 'VAR_1', item_id: 'ITEM_1', mismatch_type: 'present_at_all_locations' }]
        });
        // UPDATE to resolve
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await checkAndRecordHealth(3);
        expect(result.checked).toBe(1);
        expect(result.newMismatches).toBe(0);
        expect(result.resolved).toBe(1);

        // Verify UPDATE was called with resolved_at
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('resolved_at = NOW()'),
            [42]
        );
    });

    test('handles pagination from Square API', async () => {
        // First page
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_1',
                type: 'ITEM',
                present_at_all_locations: true,
                item_data: {
                    variations: [{ id: 'VAR_1', present_at_all_locations: true }]
                }
            }],
            cursor: 'page2'
        });
        // Second page
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_2',
                type: 'ITEM',
                present_at_all_locations: true,
                item_data: {
                    variations: [{ id: 'VAR_2', present_at_all_locations: true }]
                }
            }],
            cursor: null
        });

        // No open mismatches
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await checkAndRecordHealth(3);
        expect(result.checked).toBe(2);
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    test('reports no mismatches when all variations match', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_1',
                type: 'ITEM',
                present_at_all_locations: true,
                item_data: {
                    variations: [
                        { id: 'VAR_1', present_at_all_locations: true },
                        { id: 'VAR_2', present_at_all_locations: true }
                    ]
                }
            }],
            cursor: null
        });

        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await checkAndRecordHealth(3);
        expect(result.checked).toBe(2);
        expect(result.newMismatches).toBe(0);
        expect(result.resolved).toBe(0);
        expect(result.existingOpen).toBe(0);
    });

    test('detects present_at_all_future_locations mismatch', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_1',
                type: 'ITEM',
                present_at_all_locations: true,
                present_at_all_future_locations: true,
                item_data: {
                    variations: [{
                        id: 'VAR_1',
                        present_at_all_locations: true,
                        present_at_all_future_locations: false,
                    }]
                }
            }],
            cursor: null
        });

        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await checkAndRecordHealth(3);
        expect(result.newMismatches).toBe(1);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT'),
            [3, 'VAR_1', 'ITEM_1', 'present_at_all_future_locations']
        );
    });

    test('handles empty catalog gracefully', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [],
            cursor: null
        });

        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await checkAndRecordHealth(3);
        expect(result.checked).toBe(0);
        expect(result.newMismatches).toBe(0);
    });
});

// ============================================================================
// getMismatchHistory
// ============================================================================
describe('getMismatchHistory', () => {
    test('returns all rows for merchant', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 1, variation_id: 'VAR_1', status: 'mismatch' },
                { id: 2, variation_id: 'VAR_2', status: 'valid' }
            ]
        });

        const rows = await getMismatchHistory(3);
        expect(rows).toHaveLength(2);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('ORDER BY detected_at DESC'),
            [3]
        );
    });

    test('throws without merchantId', async () => {
        await expect(getMismatchHistory()).rejects.toThrow('merchantId is required');
    });
});

// ============================================================================
// getOpenMismatches
// ============================================================================
describe('getOpenMismatches', () => {
    test('returns only open mismatch rows', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: 1, variation_id: 'VAR_1', status: 'mismatch' }]
        });

        const rows = await getOpenMismatches(3);
        expect(rows).toHaveLength(1);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("status = 'mismatch' AND resolved_at IS NULL"),
            [3]
        );
    });

    test('throws without merchantId', async () => {
        await expect(getOpenMismatches()).rejects.toThrow('merchantId is required');
    });
});
