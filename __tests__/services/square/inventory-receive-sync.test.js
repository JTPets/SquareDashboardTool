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
 *  - Delta sync: NULL last_received_sync_at → no updated_after (full pull)
 *  - Delta sync: set last_received_sync_at → updated_after = (ts - 10 min)
 *  - Successful sync → last_received_sync_at updated in DB
 *  - Fatal sync error → last_received_sync_at NOT updated
 *  - Per-batch retry error (non-fatal) → last_received_sync_at still updated
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

/**
 * Set up db.query mocks for a typical sync run:
 *   call 0 → merchants.last_received_sync_at lookup
 *   call 1 → variations list
 *   call 2..N-1 → upsert acks
 *   call N → UPDATE merchants SET last_received_sync_at = NOW()
 *
 * @param {string[]} variationIds
 * @param {Date|null} lastSyncAt  - value returned for last_received_sync_at
 */
function setupMocks(variationIds, lastSyncAt = null) {
    db.query
        .mockResolvedValueOnce({ rows: [{ last_received_sync_at: lastSyncAt }] }) // getLastReceivedSyncAt
        .mockResolvedValueOnce({ rows: variationIds.map(id => ({ id })) })         // variations
        .mockResolvedValue({ rows: [] }); // upserts + high-water mark update
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
        db.query
            .mockResolvedValueOnce({ rows: [{ last_received_sync_at: null }] }) // getLastReceivedSyncAt
            .mockResolvedValueOnce({ rows: [] }); // no variations

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('returns 0 when Square returns no changes', async () => {
        setupMocks(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
        // queries: getLastReceivedSyncAt + variations + high-water mark update = 3
        expect(db.query).toHaveBeenCalledTimes(3);
    });
});

// ---------------------------------------------------------------------------
// RECEIVE adjustment → updates last_received_at
// ---------------------------------------------------------------------------
describe('RECEIVE adjustment updates last_received_at', () => {
    test('upserts last_received_at when to_state is IN_STOCK', async () => {
        setupMocks(['VAR1']);
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

        // call[0]=getLastReceivedSyncAt, call[1]=variations, call[2]=upsert
        const upsertCall = db.query.mock.calls[2];
        expect(upsertCall[0]).toMatch(/INSERT INTO variation_location_settings/);
        expect(upsertCall[0]).toMatch(/GREATEST/);
        expect(upsertCall[1]).toEqual(['VAR1', 'LOC1', MERCHANT_ID, '2026-01-15T10:00:00Z']);
    });

    test('passes merchant_id in every upsert query', async () => {
        setupMocks(['VAR1', 'VAR2']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-10T00:00:00Z', toState: 'IN_STOCK' }),
            makeAdjustment({ catalogObjectId: 'VAR2', locationId: 'LOC1', occurredAt: '2026-01-11T00:00:00Z', toState: 'IN_STOCK' })
        ]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        // skip getLastReceivedSyncAt (call[0]) and variations (call[1])
        const upsertCalls = db.query.mock.calls.slice(2, -1); // exclude last high-water mark call
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
        setupMocks(['VAR1']);
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
        // queries: getLastReceivedSyncAt + variations + high-water mark update = 3
        expect(db.query).toHaveBeenCalledTimes(3);
    });

    test('ignores PHYSICAL_COUNT changes', async () => {
        setupMocks(['VAR1']);
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
        setupMocks(['VAR1']);
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
        setupMocks(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-20T10:00:00Z', toState: 'IN_STOCK' }),
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-10T10:00:00Z', toState: 'IN_STOCK' })
        ]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(1); // one unique variation-location pair

        const upsertCall = db.query.mock.calls[2]; // call[0]=hwm, call[1]=vars, call[2]=upsert
        // Only the most recent timestamp should be sent to the DB
        expect(upsertCall[1][3]).toBe('2026-01-20T10:00:00Z');
    });

    test('SQL uses GREATEST so DB-side newer value is preserved', async () => {
        setupMocks(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-01T00:00:00Z', toState: 'IN_STOCK' })
        ]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        const [sql] = db.query.mock.calls[2];
        // The upsert must use GREATEST so an already-stored newer value is not replaced
        expect(sql).toMatch(/GREATEST\s*\(\s*EXCLUDED\.last_received_at\s*,\s*variation_location_settings\.last_received_at\s*\)/i);
    });

    test('distinct variation-location pairs each get their own upsert', async () => {
        setupMocks(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC1', occurredAt: '2026-01-05T00:00:00Z', toState: 'IN_STOCK' }),
            makeAdjustment({ catalogObjectId: 'VAR1', locationId: 'LOC2', occurredAt: '2026-01-06T00:00:00Z', toState: 'IN_STOCK' })
        ]));

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(2);

        const upsertCalls = db.query.mock.calls.slice(2, -1); // exclude high-water mark
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
        setupMocks(['VAR1']);
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
        const upsertCall = db.query.mock.calls[2];
        expect(upsertCall[1][3]).toBe('2026-02-01T00:00:00Z');
        expect(result).toBe(1);
    });

    test('sends types: [ADJUSTMENT] to Square', async () => {
        setupMocks(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.types).toEqual(['ADJUSTMENT']);
    });

    test('continues to next catalog batch when one batch Square call fails', async () => {
        setupMocks(['VAR1']);
        makeSquareRequest.mockRejectedValueOnce(new Error('Square 500'));

        // Should not throw — the error is swallowed and we return 0 updated
        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Delta sync — high-water mark behaviour
// ---------------------------------------------------------------------------
describe('delta sync: high-water mark', () => {
    test('NULL last_received_sync_at → no updated_after sent to Square (full pull)', async () => {
        setupMocks(['VAR1'], null);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.updated_after).toBeUndefined();
    });

    test('set last_received_sync_at → updated_after = (timestamp - 10 min) sent to Square', async () => {
        const lastSyncAt = new Date('2026-03-01T12:00:00.000Z');
        setupMocks(['VAR1'], lastSyncAt);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        // 10 minutes before 12:00 = 11:50
        expect(body.updated_after).toBe('2026-03-01T11:50:00.000Z');
    });

    test('successful sync → last_received_sync_at updated in DB', async () => {
        setupMocks(['VAR1']);
        makeSquareRequest.mockResolvedValueOnce(changesResponse([]));

        await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);

        // The last db.query call should be the high-water mark update
        const lastCall = db.query.mock.calls[db.query.mock.calls.length - 1];
        expect(lastCall[0]).toMatch(/UPDATE merchants SET last_received_sync_at = NOW/);
        expect(lastCall[1]).toEqual([MERCHANT_ID]);
    });

    test('fatal sync error → last_received_sync_at NOT updated', async () => {
        // Simulate a fatal error by making fetchBatchReceives throw unexpectedly.
        // We do this by having db.query (the variations lookup) throw after the
        // getLastReceivedSyncAt call, simulating a crash mid-sync.
        db.query
            .mockResolvedValueOnce({ rows: [{ last_received_sync_at: null }] }) // getLastReceivedSyncAt
            .mockRejectedValueOnce(new Error('DB connection lost'));             // variations query throws

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS).catch(() => -1);
        // Either threw or returned 0; either way no high-water mark call should follow
        const allSqls = db.query.mock.calls.map(([sql]) => sql);
        const hwmUpdated = allSqls.some(sql => /UPDATE merchants SET last_received_sync_at/.test(sql));
        expect(hwmUpdated).toBe(false);
    });

    test('per-batch Square error (non-fatal) → last_received_sync_at still updated', async () => {
        // fetchBatchReceives swallows per-batch Square errors internally and
        // continues. The outer loop should NOT set fatalError, so the high-water
        // mark must still be written after the loop ends.
        setupMocks(['VAR1', 'VAR2']);
        // First batch: Square returns an error (swallowed inside fetchBatchReceives)
        makeSquareRequest.mockRejectedValueOnce(new Error('Square 503'));
        // Second batch (if BATCH_SIZE split occurred) would also need a mock,
        // but both IDs fit in one batch of 100, so one call is made and swallowed.

        const result = await syncReceiveAdjustments(MERCHANT_ID, ACCESS_TOKEN, LOCATION_IDS);
        expect(result).toBe(0); // no successful data, but not a fatal error

        // High-water mark MUST still be written
        const lastCall = db.query.mock.calls[db.query.mock.calls.length - 1];
        expect(lastCall[0]).toMatch(/UPDATE merchants SET last_received_sync_at = NOW/);
        expect(lastCall[1]).toEqual([MERCHANT_ID]);
    });
});
