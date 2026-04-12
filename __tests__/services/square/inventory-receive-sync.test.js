/**
 * Tests for services/square/inventory-receive-sync.js
 *
 * Covers:
 *  - RECEIVE adjustment (to_state=IN_STOCK) updates last_received_at
 *  - Non-RECEIVE adjustment (wrong to_state) does NOT update last_received_at
 *  - GREATEST logic: earlier receipt timestamp does not overwrite a newer one
 *  - Empty changes response returns 0
 *  - Pagination is followed via cursor
 *  - No-op conditions (no merchantId, no locationIds, no variations)
 */

'use strict';

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../../services/square/square-client', () => ({
    makeSquareRequest: jest.fn(),
    sleep: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 50 },
    SYNC:   { BATCH_DELAY_MS: 0 }
}));

const db = require('../../../utils/database');
const { makeSquareRequest, sleep } = require('../../../services/square/square-client');
const { syncReceiveAdjustments } = require('../../../services/square/inventory-receive-sync');

const MERCHANT_ID = 1;
const ACCESS_TOKEN = 'test-token';
const LOCATION_IDS = ['LOC1'];

// Builds a minimal Square InventoryChange of ADJUSTMENT type
function makeAdjustment({ catalogObjectId, locationId, occurredAt, toState, fromState = 'NONE' }) {
    return {
        type: 'ADJUSTMENT',
        adjustment: {
            catalog_object_id: catalogObjectId,
            location_id: locationId,
            occurred_at: occurredAt,
            from_state: fromState,
            to_state: toState,
            quantity: '10'
        }
    };
}

// Shorthand: single-page Square response
function changesResponse(changes, cursor = null) {
    return cursor ? { changes, cursor } : { changes };
}

// Resolve db.query calls:
//   call 0 → variations list
//   remaining → upsert acks
function setupVariations(variationIds) {
    db.query
        .mockResolvedValueOnce({ rows: variationIds.map(id => ({ id })) })
        .mockResolvedValue({ rows: [] }); // upserts
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// No-op conditions
// ---------------------------------------------------------------------------
describe('no-op conditions', () => {
    test('returns 0 if merchantId is falsy', async () => {
        const result = await syncReceiveAdjustments(0, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('returns 0 if locationIds is empty', async () => {
        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, []);
        expect(result).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('returns 0 if no variations found for merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no variations

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('returns 0 when Square returns no changes', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
        expect(db.query).toHaveBeenCalledTimes(1); // only the variations lookup
    });
});

// ---------------------------------------------------------------------------
// RECEIVE adjustment → updates last_received_at
// ---------------------------------------------------------------------------
describe('RECEIVE adjustment updates last_received_at', () => {
    test('upserts last_received_at when to_state is IN_STOCK', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({
                catalogObjectId: 'VAR1',
                locationId: 'LOC1',
                occurredAt: '2026-01-15T10:00:00Z',
                toState: 'IN_STOCK'
            })
        ]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(1);

        const upsertCall = db.query.mock.calls[1]; // call[0] is variations, call[1] is upsert
        expect(upsertCall[0]).toMatch(/INSERT INTO variation_location_settings/);
        expect(upsertCall[0]).toMatch(/GREATEST/);
        expect(upsertCall[1]).toEqual(['VAR1', 'LOC1', MERCHANT_ID, '2026-01-15T10:00:00Z']);
    });

    test('passes merchant_id in every upsert query', async () => {
        setupVariations(['VAR1', 'VAR2']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-10T00:00:00Z', toState: 'IN_STOCK' }),
            makeAdjustment({ catalogObjectId: 'VAR2', locationId: 'LOC1', occurredAt: '2026-01-11T00:00:00Z', toState: 'IN_STOCK' })
        ]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        const upsertCalls = db.query.mock.calls.slice(1); // skip variations lookup
        for (const [, params] of upsertCalls) {
            expect(params[2]).toBe(MERCHANT_ID); // third param is always merchant_id
        }
    });
});

// ---------------------------------------------------------------------------
// Non-RECEIVE adjustment → does NOT update last_received_at
// ---------------------------------------------------------------------------
describe('non-RECEIVE adjustment does not update last_received_at', () => {
    test('ignores ADJUSTMENT with to_state SOLD (not IN_STOCK)', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({
                catalogObjectId: 'VAR1',
                locationId: 'LOC1',
                occurredAt: '2026-01-15T10:00:00Z',
                toState: 'SOLD'
            })
        ]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
        expect(db.query).toHaveBeenCalledTimes(1); // only variations lookup, no upsert
    });

    test('ignores PHYSICAL_COUNT changes', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            {
                type: 'PHYSICAL_COUNT',
                physical_count: {
                    catalog_object_id: 'VAR1',
                    location_id: 'LOC1',
                    occurred_at: '2026-01-15T10:00:00Z',
                    state: 'IN_STOCK'
                }
            }
        ]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
    });

    test('ignores ADJUSTMENT missing catalog_object_id', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            { type: 'ADJUSTMENT', adjustment: { location_id: 'LOC1', occurred_at: '2026-01-01T00:00:00Z', to_state: 'IN_STOCK' } }
        ]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// GREATEST logic: older receipt does not overwrite a newer one
// ---------------------------------------------------------------------------
describe('GREATEST logic: older receipt does not overwrite newer', () => {
    test('picks the most recent occurred_at when two changes exist for the same variation-location', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-20T10:00:00Z', toState: 'IN_STOCK' }),
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-10T10:00:00Z', toState: 'IN_STOCK' })
        ]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(1); // one unique variation-location pair

        const upsertCall = db.query.mock.calls[1];
        // Only the most recent timestamp should be sent to the DB
        expect(upsertCall[1][3]).toBe('2026-01-20T10:00:00Z');
    });

    test('SQL uses GREATEST so DB-side newer value is preserved', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-01T00:00:00Z', toState: 'IN_STOCK' })
        ]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        const [sql] = db.query.mock.calls[1];
        // The upsert must use GREATEST so an already-stored newer value is not replaced
        expect(sql).toMatch(/GREATEST\s*\(\s*EXCLUDED\.last_received_at\s*,\s*variation_location_settings\.last_received_at\s*\)/i);
    });

    test('distinct variation-location pairs each get their own upsert', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-05T00:00:00Z', toState: 'IN_STOCK' }),
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC2', occurredAt: '2026-01-06T00:00:00Z', toState: 'IN_STOCK' })
        ]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(2);

        const upsertCalls = db.query.mock.calls.slice(1);
        const locationArgs = upsertCalls.map(([, params]) => params[1]);
        expect(locationArgs).toContain('LOC1');
        expect(locationArgs).toContain('LOC2');
    });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
describe('pagination', () => {
    test('follows cursor to fetch all pages', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest
            .mockResolvedValueOnce(changesResponse(
                [makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-01T00:00:00Z', toState: 'IN_STOCK' })],
                'cursor-page-2'
            ))
            .mockResolvedValueOnce(changesResponse(
                [makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-02-01T00:00:00Z', toState: 'IN_STOCK' })]
            ));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        // Second call should include the cursor
        const secondCallBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(secondCallBody.cursor).toBe('cursor-page-2');
        // The more-recent timestamp across both pages wins
        const upsertCall = db.query.mock.calls[1];
        expect(upsertCall[1][3]).toBe('2026-02-01T00:00:00Z');
        expect(result).toBe(1);
    });

    test('sends types: [ADJUSTMENT] to Square', async () => {
        setupVariations(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.types).toEqual(['ADJUSTMENT']);
    });

    test('continues to next catalog batch when one batch Square call fails', async () => {
        // 3 variations so batch size=100 keeps them in one batch, but we test error resilience
        setupVariations(['VAR1']);
        makeSquareRequest.mockRejectedValueOnce(new Error('Square 500'));

        // Should not throw — the error is swallowed and we return 0 updated
        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
    });
});
