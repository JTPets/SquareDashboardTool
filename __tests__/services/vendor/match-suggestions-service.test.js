/**
 * Tests for services/vendor/match-suggestions-service.js — BACKLOG-114
 *
 * Covers:
 * - generateMatchSuggestions: finds other vendors by UPC, skips linked & rejected
 * - getPendingCount: returns count from DB
 * - listSuggestions: returns paginated suggestions with joins
 * - approveSuggestion: creates variation_vendors + Square push + marks approved
 * - approveSuggestion: Square push failure is non-fatal
 * - rejectSuggestion: marks rejected, errors on non-pending
 * - bulkApprove: approves multiple, tolerates partial failure
 * - runBackfillScan: finds UPC gaps, calls generateMatchSuggestions
 * - runBackfillScanAllMerchants: iterates all merchants
 */

jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-key-1'),
}));

jest.mock('../../../services/square/square-vendors', () => ({
    ensureVendorsExist: jest.fn().mockResolvedValue(),
}));

const db = require('../../../utils/database');
const { getMerchantToken, makeSquareRequest } = require('../../../services/square/square-client');
const { ensureVendorsExist } = require('../../../services/square/square-vendors');

const {
    generateMatchSuggestions,
    getPendingCount,
    listSuggestions,
    approveSuggestion,
    rejectSuggestion,
    bulkApprove,
    runBackfillScan,
    runBackfillScanAllMerchants,
} = require('../../../services/vendor/match-suggestions-service');

const MERCHANT_ID = 1;

beforeEach(() => {
    jest.resetAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    makeSquareRequest.mockResolvedValue({
        object: {
            type: 'ITEM_VARIATION',
            id: 'VAR1',
            version: 1,
            item_variation_data: { vendor_information: [] },
        },
    });
    ensureVendorsExist.mockResolvedValue();
});

// ============================================================================
// generateMatchSuggestions
// ============================================================================

describe('generateMatchSuggestions', () => {
    it('returns 0 when UPC is null', async () => {
        const count = await generateMatchSuggestions('VAR1', null, 'VENDOR1', MERCHANT_ID);
        expect(count).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('returns 0 when variationId is null', async () => {
        const count = await generateMatchSuggestions(null, '012345678901', 'VENDOR1', MERCHANT_ID);
        expect(count).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('returns 0 when no other vendors carry the UPC', async () => {
        // Query 1: other vendors with same UPC — none
        db.query.mockResolvedValueOnce({ rows: [] });

        const count = await generateMatchSuggestions('VAR1', '012345678901', 'VENDOR1', MERCHANT_ID);
        expect(count).toBe(0);
    });

    it('creates a suggestion for each new vendor with the same UPC', async () => {
        // Query 1: other vendors with same UPC
        db.query.mockResolvedValueOnce({
            rows: [
                { vendor_id: 'VENDOR2', vendor_name: 'Acme', vendor_code: 'AC-001', cost_cents: 1500 },
                { vendor_id: 'VENDOR3', vendor_name: 'Bobs', vendor_code: 'B-99',  cost_cents: 1400 },
            ],
        });
        // Query 2: existing variation_vendors links — none
        db.query.mockResolvedValueOnce({ rows: [] });
        // Query 3: INSERT for VENDOR2 — returns id
        db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });
        // Query 4: INSERT for VENDOR3 — returns id
        db.query.mockResolvedValueOnce({ rows: [{ id: 11 }] });

        const count = await generateMatchSuggestions('VAR1', '012345678901', 'VENDOR1', MERCHANT_ID);
        expect(count).toBe(2);
    });

    it('skips vendors already linked in variation_vendors', async () => {
        // Query 1: other vendors with same UPC
        db.query.mockResolvedValueOnce({
            rows: [{ vendor_id: 'VENDOR2', vendor_name: 'Acme', vendor_code: 'AC-001', cost_cents: 1500 }],
        });
        // Query 2: VENDOR2 already linked
        db.query.mockResolvedValueOnce({ rows: [{ vendor_id: 'VENDOR2' }] });

        const count = await generateMatchSuggestions('VAR1', '012345678901', 'VENDOR1', MERCHANT_ID);
        expect(count).toBe(0);
        // INSERT should not have been called
        const insertCalls = db.query.mock.calls.filter(c => String(c[0]).includes('INSERT INTO vendor_match_suggestions'));
        expect(insertCalls.length).toBe(0);
    });

    it('does not overwrite a previous rejection (ON CONFLICT DO NOTHING)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ vendor_id: 'VENDOR2', vendor_name: 'Acme', vendor_code: 'AC-001', cost_cents: 1500 }],
        });
        // No existing variation_vendors links
        db.query.mockResolvedValueOnce({ rows: [] });
        // INSERT returns no rows (conflict — previously rejected)
        db.query.mockResolvedValueOnce({ rows: [] });

        const count = await generateMatchSuggestions('VAR1', '012345678901', 'VENDOR1', MERCHANT_ID);
        expect(count).toBe(0);
    });
});

// ============================================================================
// getPendingCount
// ============================================================================

describe('getPendingCount', () => {
    it('returns the pending count from DB', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '7' }] });
        const count = await getPendingCount(MERCHANT_ID);
        expect(count).toBe(7);
    });

    it('returns 0 when no pending suggestions', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        const count = await getPendingCount(MERCHANT_ID);
        expect(count).toBe(0);
    });
});

// ============================================================================
// listSuggestions
// ============================================================================

describe('listSuggestions', () => {
    it('returns suggestions and total from DB', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ total: '3' }] });
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 1, variation_id: 'VAR1', upc: '123', status: 'pending',
                  source_vendor_name: 'Acme', suggested_vendor_name: 'Bobs',
                  suggested_cost_cents: 1500, source_cost_cents: 1800 },
            ],
        });

        const result = await listSuggestions(MERCHANT_ID, { status: 'pending', limit: 50, offset: 0 });
        expect(result.total).toBe(3);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].id).toBe(1);
    });

    it('defaults to pending status', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
        db.query.mockResolvedValueOnce({ rows: [] });

        await listSuggestions(MERCHANT_ID);

        const countCall = db.query.mock.calls[0];
        expect(countCall[1]).toContain('pending');
    });
});

// ============================================================================
// approveSuggestion
// ============================================================================

describe('approveSuggestion', () => {
    const pendingSuggestion = {
        id: 5,
        merchant_id: MERCHANT_ID,
        variation_id: 'VAR1',
        upc: '012345678901',
        source_vendor_id: 'VENDOR1',
        suggested_vendor_id: 'VENDOR2',
        suggested_vendor_code: 'AC-001',
        suggested_cost_cents: 1500,
        status: 'pending',
    };

    // Helper: set up full happy-path mock sequence for approveSuggestion.
    // Called at the start of each test that expects approval to succeed.
    function setupApprovalMocks(squareUpsertResult = { catalog_object: { version: 3 } }) {
        db.query
            .mockResolvedValueOnce({ rows: [pendingSuggestion] })   // SELECT suggestion
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })        // INSERT variation_vendors
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });       // UPDATE status
        makeSquareRequest
            .mockResolvedValueOnce({
                object: {
                    type: 'ITEM_VARIATION', id: 'VAR1', version: 2,
                    item_variation_data: { vendor_information: [] },
                },
            })
            .mockResolvedValueOnce(squareUpsertResult);
    }

    it('creates a variation_vendors row on approval', async () => {
        setupApprovalMocks();
        await approveSuggestion(5, 1, MERCHANT_ID);

        const insertCall = db.query.mock.calls.find(c =>
            String(c[0]).includes('INSERT INTO variation_vendors')
        );
        expect(insertCall).toBeDefined();
        expect(insertCall[1]).toContain('VAR1');
        expect(insertCall[1]).toContain('VENDOR2');
    });

    it('pushes vendor_information to Square', async () => {
        setupApprovalMocks();
        await approveSuggestion(5, 1, MERCHANT_ID);

        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        const upsertCall = makeSquareRequest.mock.calls[1];
        expect(upsertCall[0]).toBe('/v2/catalog/object');
        const body = JSON.parse(upsertCall[1].body);
        expect(body.object.item_variation_data.vendor_information).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ vendor_id: 'VENDOR2' })
            ])
        );
    });

    it('marks the suggestion as approved', async () => {
        setupApprovalMocks();
        const result = await approveSuggestion(5, 1, MERCHANT_ID);

        expect(result.approved).toBe(true);
        const updateCall = db.query.mock.calls.find(c =>
            String(c[0]).includes("status = 'approved'")
        );
        expect(updateCall).toBeDefined();
        expect(updateCall[1]).toContain(5);   // suggestionId
        expect(updateCall[1]).toContain(1);   // userId
    });

    it('returns approved:true even when Square push fails (non-fatal)', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [pendingSuggestion] })   // SELECT suggestion
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })        // INSERT variation_vendors
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });       // UPDATE status
        makeSquareRequest
            .mockResolvedValueOnce({
                object: {
                    type: 'ITEM_VARIATION', id: 'VAR1', version: 2,
                    item_variation_data: { vendor_information: [] },
                },
            })
            .mockRejectedValueOnce(new Error('Square API timeout'));

        const result = await approveSuggestion(5, 1, MERCHANT_ID);

        expect(result.approved).toBe(true);
        expect(result.squarePushError).toBe('Square API timeout');
    });

    it('throws 404 when suggestion not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(approveSuggestion(999, 1, MERCHANT_ID)).rejects.toMatchObject({
            message: 'Suggestion not found',
            statusCode: 404,
        });
    });

    it('throws 409 when suggestion is already approved', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ ...pendingSuggestion, status: 'approved' }] });

        await expect(approveSuggestion(5, 1, MERCHANT_ID)).rejects.toMatchObject({
            statusCode: 409,
        });
    });
});

// ============================================================================
// rejectSuggestion
// ============================================================================

describe('rejectSuggestion', () => {
    it('marks a pending suggestion as rejected', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

        const result = await rejectSuggestion(5, 1, MERCHANT_ID);
        expect(result.rejected).toBe(true);
        expect(result.suggestionId).toBe(5);

        const updateCall = db.query.mock.calls[0];
        expect(String(updateCall[0])).toContain("status = 'rejected'");
        expect(updateCall[1]).toContain(5);
    });

    it('throws 404 when suggestion not found', async () => {
        // UPDATE returns 0 rows
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // SELECT to distinguish not-found vs wrong-status
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(rejectSuggestion(999, 1, MERCHANT_ID)).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it('throws 409 when suggestion is already approved', async () => {
        // UPDATE returns 0 rows (status != pending)
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // SELECT finds it with status approved
        db.query.mockResolvedValueOnce({ rows: [{ status: 'approved' }] });

        await expect(rejectSuggestion(5, 1, MERCHANT_ID)).rejects.toMatchObject({
            statusCode: 409,
        });
    });
});

// ============================================================================
// bulkApprove
// ============================================================================

describe('bulkApprove', () => {
    it('approves all provided suggestions', async () => {
        const suggestion = {
            id: 1, merchant_id: MERCHANT_ID, variation_id: 'VAR1',
            upc: '123', source_vendor_id: 'V1', suggested_vendor_id: 'V2',
            suggested_vendor_code: 'X1', suggested_cost_cents: 1200, status: 'pending',
        };

        // For each of 2 suggestions: SELECT + INSERT variation_vendors + Square calls + UPDATE
        db.query
            .mockResolvedValueOnce({ rows: [{ ...suggestion, id: 1 }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ ...suggestion, id: 2 }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        makeSquareRequest
            .mockResolvedValue({
                object: { type: 'ITEM_VARIATION', id: 'VAR1', version: 1,
                    item_variation_data: { vendor_information: [] } },
            });

        const result = await bulkApprove([1, 2], 1, MERCHANT_ID);
        expect(result.approved).toBe(2);
        expect(result.failed).toBe(0);
    });

    it('reports partial success when one suggestion fails', async () => {
        // First suggestion: not found
        db.query.mockResolvedValueOnce({ rows: [] });

        // Second suggestion: succeeds
        const suggestion = {
            id: 2, merchant_id: MERCHANT_ID, variation_id: 'VAR1',
            upc: '456', source_vendor_id: 'V1', suggested_vendor_id: 'V3',
            suggested_vendor_code: 'Y1', suggested_cost_cents: 900, status: 'pending',
        };
        db.query
            .mockResolvedValueOnce({ rows: [suggestion] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        makeSquareRequest.mockResolvedValue({
            object: { type: 'ITEM_VARIATION', id: 'VAR1', version: 1,
                item_variation_data: { vendor_information: [] } },
        });

        const result = await bulkApprove([1, 2], 1, MERCHANT_ID);
        expect(result.approved).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].suggestionId).toBe(1);
    });
});

// ============================================================================
// runBackfillScan
// ============================================================================

describe('runBackfillScan', () => {
    it('returns zero scanned and created when no matched UPCs exist', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runBackfillScan(MERCHANT_ID);
        expect(result.scanned).toBe(0);
        expect(result.suggestionsCreated).toBe(0);
    });

    it('scans every matched UPC row and generates suggestions via generateMatchSuggestions', async () => {
        // Query: all matched UPCs — one row per (upc, variation, vendor)
        db.query.mockResolvedValueOnce({
            rows: [
                { upc: '012345678901', variation_id: 'VAR1', source_vendor_id: 'VENDOR1' },
                { upc: '012345678901', variation_id: 'VAR1', source_vendor_id: 'VENDOR2' },
            ],
        });

        // For generateMatchSuggestions(VAR1, upc, VENDOR1):
        //   query: other vendors with same UPC → VENDOR2
        db.query.mockResolvedValueOnce({ rows: [{ vendor_id: 'VENDOR2', vendor_name: 'B', vendor_code: 'B1', cost_cents: 1000 }] });
        //   query: existing variation_vendors → none
        db.query.mockResolvedValueOnce({ rows: [] });
        //   INSERT → created
        db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });

        // For generateMatchSuggestions(VAR1, upc, VENDOR2):
        //   query: other vendors → VENDOR1
        db.query.mockResolvedValueOnce({ rows: [{ vendor_id: 'VENDOR1', vendor_name: 'A', vendor_code: 'A1', cost_cents: 900 }] });
        //   query: existing links → none
        db.query.mockResolvedValueOnce({ rows: [] });
        //   INSERT → conflict (already created from VENDOR1's perspective)
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runBackfillScan(MERCHANT_ID);
        expect(result.scanned).toBe(2);
        expect(result.suggestionsCreated).toBe(1);
    });

    it('creates suggestion for UPC matched at vendor A that exists unmatched at vendor B', async () => {
        // Query: single matched row — vendor A only
        db.query.mockResolvedValueOnce({
            rows: [
                { upc: '111122223333', variation_id: 'VAR2', source_vendor_id: 'VENDOR_A' },
            ],
        });

        // generateMatchSuggestions finds vendor B carries same UPC
        db.query.mockResolvedValueOnce({ rows: [{ vendor_id: 'VENDOR_B', vendor_name: 'B', vendor_code: 'B2', cost_cents: 500 }] });
        db.query.mockResolvedValueOnce({ rows: [] }); // no existing links
        db.query.mockResolvedValueOnce({ rows: [{ id: 20 }] }); // INSERT

        const result = await runBackfillScan(MERCHANT_ID);
        expect(result.scanned).toBe(1);
        expect(result.suggestionsCreated).toBe(1);
    });

    it('creates no suggestion when matched UPC has no other vendors', async () => {
        // Query: single matched row — only one vendor carries this UPC
        db.query.mockResolvedValueOnce({
            rows: [
                { upc: '999988887777', variation_id: 'VAR3', source_vendor_id: 'VENDOR_SOLO' },
            ],
        });

        // generateMatchSuggestions finds no other vendors
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runBackfillScan(MERCHANT_ID);
        expect(result.scanned).toBe(1);
        expect(result.suggestionsCreated).toBe(0);
    });
});

// ============================================================================
// runBackfillScanAllMerchants
// ============================================================================

describe('runBackfillScanAllMerchants', () => {
    it('runs scan for each active merchant', async () => {
        // Query: active merchants
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 1, business_name: 'Store A' },
                { id: 2, business_name: 'Store B' },
            ],
        });
        // For each merchant: no UPCs found
        db.query.mockResolvedValue({ rows: [] });

        const result = await runBackfillScanAllMerchants();
        expect(result.merchantCount).toBe(2);
        expect(result.results).toHaveLength(2);
        expect(result.errors).toHaveLength(0);
    });

    it('collects errors per merchant without stopping', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, business_name: 'A' }, { id: 2, business_name: 'B' }] })
            // Merchant 1: backfill throws
            .mockRejectedValueOnce(new Error('DB connection lost'))
            // Merchant 2: no UPCs
            .mockResolvedValueOnce({ rows: [] });

        const result = await runBackfillScanAllMerchants();
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].merchantId).toBe(1);
        expect(result.results).toHaveLength(1);
        expect(result.results[0].merchantId).toBe(2);
    });
});
