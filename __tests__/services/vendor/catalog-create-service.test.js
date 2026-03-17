/**
 * Vendor Catalog Create Service Tests
 *
 * Tests services/vendor/catalog-create-service.js:
 * - Entry validation (skip no name, no price, already matched)
 * - UPC dedup (match existing instead of creating duplicate)
 * - Square BatchUpsertCatalogObjects call structure
 * - Batch splitting for >100 items
 * - Local DB updates (variations, vendor_catalog_items)
 * - Transaction rollback on Square API failure
 * - Vendor assignment on created items
 * - merchant_id filter on all queries
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const mockDbQuery = jest.fn();
const mockDbTransaction = jest.fn();
jest.mock('../../../utils/database', () => ({
    query: mockDbQuery,
    transaction: mockDbTransaction,
}));

const mockGetMerchantToken = jest.fn();
const mockMakeSquareRequest = jest.fn();
const mockSleep = jest.fn();
const mockGenerateIdempotencyKey = jest.fn();
jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: mockGetMerchantToken,
    makeSquareRequest: mockMakeSquareRequest,
    sleep: mockSleep,
    generateIdempotencyKey: mockGenerateIdempotencyKey,
}));

const {
    bulkCreateSquareItems,
    validateEntries,
    checkExistingUPCs,
    splitIntoBatches
} = require('../../../services/vendor/catalog-create-service');

// ============================================================================
// HELPERS
// ============================================================================

function makeEntry(overrides = {}) {
    return {
        id: 1,
        vendor_id: 'VENDOR_SQ_ID',
        vendor_name: 'Test Vendor',
        product_name: 'Test Product',
        upc: '123456789012',
        cost_cents: 500,
        price_cents: 999,
        matched_variation_id: null,
        vendor_item_number: 'VIN001',
        ...overrides,
    };
}

// ============================================================================
// TESTS
// ============================================================================

describe('catalog-create-service', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
        mockGenerateIdempotencyKey.mockReturnValue('test-idempotency-key');
        mockSleep.mockResolvedValue();
    });

    // ========================================================================
    // validateEntries
    // ========================================================================

    describe('validateEntries', () => {
        it('skips entries with no product name, returns in errors array', () => {
            const entries = [makeEntry({ id: 1, product_name: '' })];
            const { valid, invalid } = validateEntries(entries, [1]);
            expect(valid).toHaveLength(0);
            expect(invalid).toHaveLength(1);
            expect(invalid[0].error).toMatch(/Missing product name/);
        });

        it('skips entries with null product name', () => {
            const entries = [makeEntry({ id: 1, product_name: null })];
            const { valid, invalid } = validateEntries(entries, [1]);
            expect(valid).toHaveLength(0);
            expect(invalid[0].error).toMatch(/Missing product name/);
        });

        it('skips entries with no price, returns in errors array', () => {
            const entries = [makeEntry({ id: 2, price_cents: null })];
            const { valid, invalid } = validateEntries(entries, [2]);
            expect(valid).toHaveLength(0);
            expect(invalid).toHaveLength(1);
            expect(invalid[0].error).toMatch(/Missing price/);
        });

        it('skips already-matched entries, does not create duplicates', () => {
            const entries = [makeEntry({ id: 3, matched_variation_id: 'EXISTING_VAR_ID' })];
            const { valid, invalid } = validateEntries(entries, [3]);
            expect(valid).toHaveLength(0);
            expect(invalid).toHaveLength(1);
            expect(invalid[0].error).toMatch(/Already matched/);
        });

        it('reports IDs not found (different merchant)', () => {
            const entries = [makeEntry({ id: 1 })];
            const { valid, invalid } = validateEntries(entries, [1, 99]);
            expect(valid).toHaveLength(1);
            expect(invalid).toHaveLength(1);
            expect(invalid[0].vendorCatalogId).toBe(99);
            expect(invalid[0].error).toMatch(/Not found/);
        });

        it('passes valid entries through', () => {
            const entries = [
                makeEntry({ id: 1 }),
                makeEntry({ id: 2, product_name: 'Another Product' }),
            ];
            const { valid, invalid } = validateEntries(entries, [1, 2]);
            expect(valid).toHaveLength(2);
            expect(invalid).toHaveLength(0);
        });
    });

    // ========================================================================
    // checkExistingUPCs
    // ========================================================================

    describe('checkExistingUPCs', () => {
        it('matches to existing Square item when UPC already exists', async () => {
            const entries = [makeEntry({ id: 1, upc: '111222333444' })];

            mockDbQuery.mockResolvedValue({
                rows: [{ id: 'EXISTING_VAR_ID', upc: '111222333444', item_id: 'EXISTING_ITEM_ID' }]
            });

            const { toCreate, toMatch } = await checkExistingUPCs(entries, 1);
            expect(toCreate).toHaveLength(0);
            expect(toMatch).toHaveLength(1);
            expect(toMatch[0].existing.variationId).toBe('EXISTING_VAR_ID');
        });

        it('sends entries without UPC to create', async () => {
            const entries = [makeEntry({ id: 1, upc: null })];
            const { toCreate, toMatch } = await checkExistingUPCs(entries, 1);
            expect(toCreate).toHaveLength(1);
            expect(toMatch).toHaveLength(0);
        });

        it('includes merchant_id filter in UPC query', async () => {
            const entries = [makeEntry({ id: 1, upc: '111222333444' })];
            mockDbQuery.mockResolvedValue({ rows: [] });

            await checkExistingUPCs(entries, 42);

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('merchant_id = $2'),
                expect.arrayContaining([42])
            );
        });
    });

    // ========================================================================
    // splitIntoBatches
    // ========================================================================

    describe('splitIntoBatches', () => {
        it('batches correctly when more than 100 items', () => {
            const items = Array.from({ length: 250 }, (_, i) => ({ id: i }));
            const batches = splitIntoBatches(items, 100);
            expect(batches).toHaveLength(3);
            expect(batches[0]).toHaveLength(100);
            expect(batches[1]).toHaveLength(100);
            expect(batches[2]).toHaveLength(50);
        });

        it('returns single batch for <= 100 items', () => {
            const items = Array.from({ length: 50 }, (_, i) => ({ id: i }));
            const batches = splitIntoBatches(items, 100);
            expect(batches).toHaveLength(1);
            expect(batches[0]).toHaveLength(50);
        });
    });

    // ========================================================================
    // bulkCreateSquareItems (integration)
    // ========================================================================

    describe('bulkCreateSquareItems', () => {
        it('calls BatchUpsertCatalogObjects with correct item structure', async () => {
            const entry = makeEntry({ id: 10, product_name: 'Dog Food 25lb', upc: '999888777666', price_cents: 4999, cost_cents: 2500 });

            // fetchVendorCatalogEntries
            mockDbQuery
                .mockResolvedValueOnce({ rows: [entry] }) // fetch entries
                .mockResolvedValueOnce({ rows: [] }); // check UPCs - no existing

            mockMakeSquareRequest.mockResolvedValue({
                objects: [],
                id_mappings: [
                    { client_object_id: '#item_10', object_id: 'REAL_ITEM_ID' },
                    { client_object_id: '#var_10', object_id: 'REAL_VAR_ID' },
                ]
            });

            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
            mockDbTransaction.mockImplementation(async (fn) => fn(mockClient));

            const result = await bulkCreateSquareItems([10], 1);

            expect(result.created).toBe(1);
            expect(result.failed).toBe(0);

            // Check Square API was called correctly
            const callArgs = JSON.parse(mockMakeSquareRequest.mock.calls[0][1].body);
            expect(callArgs.batches[0].objects).toHaveLength(1);
            const item = callArgs.batches[0].objects[0];
            expect(item.type).toBe('ITEM');
            expect(item.item_data.name).toBe('Dog Food 25lb');
            const variation = item.item_data.variations[0];
            expect(variation.type).toBe('ITEM_VARIATION');
            expect(variation.item_variation_data.name).toBe('Regular');
            expect(variation.item_variation_data.upc).toBe('999888777666');
            expect(variation.item_variation_data.sku).toBe('999888777666');
            // BigInt serialized as string in JSON
            expect(Number(variation.item_variation_data.price_money.amount)).toBe(4999);
        });

        it('updates vendor catalog match status after successful creation', async () => {
            const entry = makeEntry({ id: 5, upc: null });

            mockDbQuery
                .mockResolvedValueOnce({ rows: [entry] })
                .mockResolvedValueOnce({ rows: [] }); // no UPC to check (no UPC)

            // Note: checkExistingUPCs won't query since no entries have UPCs

            mockMakeSquareRequest.mockResolvedValue({
                objects: [],
                id_mappings: [
                    { client_object_id: '#item_5', object_id: 'ITEM_5' },
                    { client_object_id: '#var_5', object_id: 'VAR_5' },
                ]
            });

            const txQueries = [];
            const mockClient = { query: jest.fn((...args) => { txQueries.push(args); return { rows: [] }; }) };
            mockDbTransaction.mockImplementation(async (fn) => fn(mockClient));

            await bulkCreateSquareItems([5], 1);

            // Check that vendor_catalog_items was updated
            const matchUpdate = txQueries.find(q => q[0].includes('UPDATE vendor_catalog_items'));
            expect(matchUpdate).toBeDefined();
            expect(matchUpdate[1]).toContain('VAR_5'); // matched_variation_id
            expect(matchUpdate[1]).toContain(5); // vendor catalog id
            expect(matchUpdate[1]).toContain(1); // merchant_id
        });

        it('INSERTs new variation into local variations table with Square IDs', async () => {
            // Use upc: null to avoid extra db.query call in checkExistingUPCs
            const entry = makeEntry({ id: 7, upc: null, price_cents: 1299 });

            mockDbQuery
                .mockResolvedValueOnce({ rows: [entry] });

            mockMakeSquareRequest.mockResolvedValue({
                objects: [],
                id_mappings: [
                    { client_object_id: '#item_7', object_id: 'SQ_ITEM_7' },
                    { client_object_id: '#var_7', object_id: 'SQ_VAR_7' },
                ]
            });

            const txQueries = [];
            const mockClient = { query: jest.fn(async (...args) => { txQueries.push(args); return { rows: [] }; }) };
            mockDbTransaction.mockImplementation(async (fn) => fn(mockClient));

            const result = await bulkCreateSquareItems([7], 1);

            expect(result.created).toBe(1);
            const varInsert = txQueries.find(q => q[0].includes('INSERT INTO variations'));
            expect(varInsert).toBeDefined();
            expect(varInsert[1]).toContain('SQ_VAR_7');
            expect(varInsert[1]).toContain('SQ_ITEM_7');
            expect(varInsert[1]).toContain(1); // merchant_id
        });

        it('transaction rolls back local DB changes if Square API fails', async () => {
            // Use upc: null to avoid extra db.query call in checkExistingUPCs
            const entry = makeEntry({ id: 8, upc: null });

            mockDbQuery
                .mockResolvedValueOnce({ rows: [entry] });

            mockMakeSquareRequest.mockRejectedValue(new Error('Square API error'));

            const result = await bulkCreateSquareItems([8], 1);

            expect(result.created).toBe(0);
            expect(result.failed).toBe(1);
            expect(result.errors[0].error).toContain('Square API error');
            // Transaction was never called because error happened before it
            expect(mockDbTransaction).not.toHaveBeenCalled();
        });

        it('vendor assignment is set correctly on created items', async () => {
            // Use upc: null to simplify mock chain
            const entry = makeEntry({ id: 11, vendor_id: 'VENDOR_ABC', cost_cents: 300, upc: null, vendor_item_number: 'VIN-ABC-001' });

            mockDbQuery
                .mockResolvedValueOnce({ rows: [entry] });

            mockMakeSquareRequest.mockResolvedValue({
                objects: [],
                id_mappings: [
                    { client_object_id: '#item_11', object_id: 'ITEM_11' },
                    { client_object_id: '#var_11', object_id: 'VAR_11' },
                ]
            });

            const txQueries = [];
            const mockClient = { query: jest.fn(async (...args) => { txQueries.push(args); return { rows: [] }; }) };
            mockDbTransaction.mockImplementation(async (fn) => fn(mockClient));

            await bulkCreateSquareItems([11], 1);

            // Check vendor info in Square API call
            const callArgs = JSON.parse(mockMakeSquareRequest.mock.calls[0][1].body);
            const variation = callArgs.batches[0].objects[0].item_data.variations[0];
            expect(variation.item_variation_data.vendor_information).toBeDefined();
            expect(variation.item_variation_data.vendor_information[0].vendor_id).toBe('VENDOR_ABC');

            // Check variations INSERT includes vendor_code and vendor_id
            const varInsert = txQueries.find(q => q[0].includes('INSERT INTO variations'));
            expect(varInsert).toBeDefined();
            expect(varInsert[0]).toContain('vendor_code');
            expect(varInsert[0]).toContain('vendor_id');
            expect(varInsert[1]).toContain('VENDOR_ABC'); // vendor_id
            expect(varInsert[1]).toContain('VIN-ABC-001'); // vendor_code from vendor_item_number

            // Check variation_vendors insert includes vendor_code
            const vendorInsert = txQueries.find(q => q[0].includes('INSERT INTO variation_vendors'));
            expect(vendorInsert).toBeDefined();
            expect(vendorInsert[0]).toContain('vendor_code');
            expect(vendorInsert[1]).toContain('VENDOR_ABC');
            expect(vendorInsert[1]).toContain('VIN-ABC-001'); // vendor_code
            expect(vendorInsert[1]).toContain(300); // cost_cents
        });

        it('all DB queries include merchant_id filter', async () => {
            const entry = makeEntry({ id: 12 });

            mockDbQuery
                .mockResolvedValueOnce({ rows: [entry] }) // fetch entries
                .mockResolvedValueOnce({ rows: [] }); // check UPCs

            mockMakeSquareRequest.mockResolvedValue({
                objects: [],
                id_mappings: [
                    { client_object_id: '#item_12', object_id: 'ITEM_12' },
                    { client_object_id: '#var_12', object_id: 'VAR_12' },
                ]
            });

            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
            mockDbTransaction.mockImplementation(async (fn) => fn(mockClient));

            await bulkCreateSquareItems([12], 42);

            // Fetch entries query includes merchant_id
            expect(mockDbQuery.mock.calls[0][1]).toContain(42);

            // Check UPC query includes merchant_id
            expect(mockDbQuery.mock.calls[1][1]).toContain(42);

            // Transaction queries include merchant_id
            for (const call of mockClient.query.mock.calls) {
                expect(call[1]).toContain(42);
            }
        });

        it('handles batch splitting for >100 items', async () => {
            const entries = Array.from({ length: 150 }, (_, i) =>
                makeEntry({ id: i + 1, product_name: `Product ${i + 1}`, upc: null })
            );

            // Only 1 db.query call since upc: null skips checkExistingUPCs query
            mockDbQuery
                .mockResolvedValueOnce({ rows: entries });

            // Two batch calls to Square
            const makeMappings = (start, count) => {
                const mappings = [];
                for (let i = start; i < start + count; i++) {
                    mappings.push({ client_object_id: `#item_${i}`, object_id: `ITEM_${i}` });
                    mappings.push({ client_object_id: `#var_${i}`, object_id: `VAR_${i}` });
                }
                return mappings;
            };

            mockMakeSquareRequest
                .mockResolvedValueOnce({ objects: [], id_mappings: makeMappings(1, 100) })
                .mockResolvedValueOnce({ objects: [], id_mappings: makeMappings(101, 50) });

            const mockClient = { query: jest.fn(async () => ({ rows: [] })) };
            mockDbTransaction.mockImplementation(async (fn) => fn(mockClient));

            const ids = Array.from({ length: 150 }, (_, i) => i + 1);
            const result = await bulkCreateSquareItems(ids, 1);

            expect(result.created).toBe(150);
            expect(mockMakeSquareRequest).toHaveBeenCalledTimes(2);

            // First batch should have 100 objects
            const firstBatchArgs = JSON.parse(mockMakeSquareRequest.mock.calls[0][1].body);
            expect(firstBatchArgs.batches[0].objects).toHaveLength(100);

            // Second batch should have 50 objects
            const secondBatchArgs = JSON.parse(mockMakeSquareRequest.mock.calls[1][1].body);
            expect(secondBatchArgs.batches[0].objects).toHaveLength(50);

            // Sleep should be called between batches
            expect(mockSleep).toHaveBeenCalledWith(200);
        });

        it('returns empty result for empty vendorCatalogIds', async () => {
            const result = await bulkCreateSquareItems([], 1);
            expect(result.created).toBe(0);
            expect(result.failed).toBe(0);
            expect(result.errors).toEqual([]);
        });

        it('throws if merchantId is missing', async () => {
            await expect(bulkCreateSquareItems([1], null)).rejects.toThrow('merchantId is required');
        });
    });
});
