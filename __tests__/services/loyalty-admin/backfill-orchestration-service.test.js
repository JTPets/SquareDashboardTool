/**
 * Tests for backfill-orchestration-service.js
 *
 * Validates backfill logic: location lookup, Square API pagination,
 * qualifying item filtering, customer identification, and diagnostics.
 *
 * LA-1 fix: backfill now routes through processLoyaltyOrder() (order-intake)
 * instead of the legacy processOrderForLoyalty() (webhook-processing-service).
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    getSquareAccessToken: jest.fn(),
    fetchWithTimeout: jest.fn((url, options) => global.fetch(url, options)),
}));

jest.mock('../../../services/loyalty-admin/loyalty-event-prefetch-service', () => ({
    prefetchRecentLoyaltyEvents: jest.fn(),
    findCustomerFromPrefetchedEvents: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn(),
}));

const { runBackfill } = require('../../../services/loyalty-admin/backfill-orchestration-service');
const db = require('../../../utils/database');
const { getSquareAccessToken } = require('../../../services/loyalty-admin/shared-utils');
const { prefetchRecentLoyaltyEvents, findCustomerFromPrefetchedEvents } = require('../../../services/loyalty-admin/loyalty-event-prefetch-service');
const { processLoyaltyOrder } = require('../../../services/loyalty-admin/order-intake');

const MERCHANT_ID = 1;
const LOCATION_ID = 'LOC_001';
const VARIATION_ID = 'VAR_BCR_4LB';

function makeOrder(id, { customerId = null, variationId = VARIATION_ID } = {}) {
    return {
        id,
        customer_id: customerId,
        state: 'COMPLETED',
        created_at: '2026-01-15T12:00:00Z',
        location_id: LOCATION_ID,
        line_items: [{
            catalog_object_id: variationId,
            quantity: '1',
            name: 'BCR Chicken 4lb'
        }],
        tenders: []
    };
}

function setupDbMocks({ locations = [{ id: LOCATION_ID }], qualifyingVariations = [{ variation_id: VARIATION_ID }] } = {}) {
    db.query
        .mockResolvedValueOnce({ rows: locations })          // locations
        .mockResolvedValueOnce({ rows: qualifyingVariations }); // qualifying variations
}

function mockIntakeResult({ purchaseCount = 1 } = {}) {
    return {
        alreadyProcessed: false,
        purchaseEvents: Array.from({ length: purchaseCount }, (_, i) => ({ id: i + 1 })),
        rewardEarned: false
    };
}

const EMPTY_PREFETCH = { events: [], loyaltyAccounts: {} };

describe('backfill-orchestration-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
        prefetchRecentLoyaltyEvents.mockResolvedValue(EMPTY_PREFETCH);
        findCustomerFromPrefetchedEvents.mockReturnValue(null);
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('throws on missing merchantId', async () => {
        await expect(runBackfill({ days: 7 }))
            .rejects.toThrow('merchantId is required');
    });

    test('returns early when no active locations', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no locations

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(result.error).toBe('No active locations found');
        expect(result.processed).toBe(0);
    });

    test('throws when no Square access token', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: LOCATION_ID }] }); // locations
        getSquareAccessToken.mockResolvedValue(null);

        await expect(runBackfill({ merchantId: MERCHANT_ID }))
            .rejects.toThrow('No Square access token');
    });

    test('processes qualifying orders with customer_id', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order = makeOrder('ORD_1', { customerId: 'CUST_1' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order], cursor: null })
        });

        processLoyaltyOrder.mockResolvedValue(mockIntakeResult());

        const result = await runBackfill({ merchantId: MERCHANT_ID, days: 7 });

        expect(result.success).toBe(true);
        expect(result.ordersProcessed).toBe(1);
        expect(result.ordersWithCustomer).toBe(1);
        expect(result.ordersWithQualifyingItems).toBe(1);
        expect(result.loyaltyPurchasesRecorded).toBe(1);
        expect(result.results).toHaveLength(1);
        expect(processLoyaltyOrder).toHaveBeenCalledTimes(1);
    });

    test('calls processLoyaltyOrder with correct signature and source=backfill', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order = makeOrder('ORD_1', { customerId: 'CUST_1' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order], cursor: null })
        });

        processLoyaltyOrder.mockResolvedValue(mockIntakeResult());

        await runBackfill({ merchantId: MERCHANT_ID });

        expect(processLoyaltyOrder).toHaveBeenCalledWith({
            order,
            merchantId: MERCHANT_ID,
            squareCustomerId: 'CUST_1',
            source: 'backfill',
            customerSource: 'order'
        });
    });

    test('passes raw Square order object without camelCase transform', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order = makeOrder('ORD_1', { customerId: 'CUST_1' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order], cursor: null })
        });

        processLoyaltyOrder.mockResolvedValue(mockIntakeResult());

        await runBackfill({ merchantId: MERCHANT_ID });

        const callArg = processLoyaltyOrder.mock.calls[0][0];
        // Should pass the raw Square order — no 'lineItems' (camelCase) property
        expect(callArg.order).toBe(order);
        expect(callArg.order.lineItems).toBeUndefined();
        expect(callArg.order.line_items).toBeDefined();
    });

    test('skips orders without qualifying items', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order = makeOrder('ORD_1', { customerId: 'CUST_1', variationId: 'NON_QUALIFYING' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order], cursor: null })
        });

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(result.ordersProcessed).toBe(1);
        expect(result.ordersWithQualifyingItems).toBe(0);
        expect(processLoyaltyOrder).not.toHaveBeenCalled();
    });

    test('finds customer from prefetched loyalty events', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order = makeOrder('ORD_1'); // no customer_id
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order], cursor: null })
        });

        findCustomerFromPrefetchedEvents.mockReturnValue('CUST_FROM_PREFETCH');
        processLoyaltyOrder.mockResolvedValue(mockIntakeResult());

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(result.customersFoundViaPrefetch).toBe(1);
        expect(result.results[0].customerSource).toBe('loyalty_prefetch');
        expect(processLoyaltyOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                squareCustomerId: 'CUST_FROM_PREFETCH',
                customerSource: 'loyalty_prefetch'
            })
        );
    });

    test('finds customer from tender customer_id', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order = makeOrder('ORD_1');
        order.tenders = [{ customer_id: 'CUST_FROM_TENDER' }];
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order], cursor: null })
        });

        processLoyaltyOrder.mockResolvedValue(mockIntakeResult());

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(result.loyaltyPurchasesRecorded).toBe(1);
        expect(findCustomerFromPrefetchedEvents).not.toHaveBeenCalled();
        expect(processLoyaltyOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                squareCustomerId: 'CUST_FROM_TENDER',
                customerSource: 'tender'
            })
        );
    });

    test('skips orders with no customer found and collects diagnostics', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order = makeOrder('ORD_1'); // no customer_id, no tender, no prefetch
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order], cursor: null })
        });

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(result.ordersProcessed).toBe(1);
        expect(result.loyaltyPurchasesRecorded).toBe(0);
        expect(result.diagnostics.sampleOrdersWithoutCustomer).toHaveLength(1);
        expect(result.diagnostics.sampleOrdersWithoutCustomer[0].orderId).toBe('ORD_1');
    });

    test('handles Square API pagination', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order1 = makeOrder('ORD_1', { customerId: 'CUST_1' });
        const order2 = makeOrder('ORD_2', { customerId: 'CUST_2' });

        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ orders: [order1], cursor: 'page2' })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ orders: [order2], cursor: null })
            });

        processLoyaltyOrder.mockResolvedValue(mockIntakeResult());

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(result.ordersProcessed).toBe(2);
    });

    test('continues processing when individual order fails', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order1 = makeOrder('ORD_FAIL', { customerId: 'CUST_1' });
        const order2 = makeOrder('ORD_OK', { customerId: 'CUST_2' });

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order1, order2], cursor: null })
        });

        processLoyaltyOrder
            .mockRejectedValueOnce(new Error('Processing failed'))
            .mockResolvedValueOnce(mockIntakeResult());

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(result.ordersProcessed).toBe(2);
        expect(result.loyaltyPurchasesRecorded).toBe(1);
    });

    test('skips already-processed orders without counting them as recorded', async () => {
        setupDbMocks();
        getSquareAccessToken.mockResolvedValue('fake-token');

        const order = makeOrder('ORD_1', { customerId: 'CUST_1' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [order], cursor: null })
        });

        processLoyaltyOrder.mockResolvedValue({
            alreadyProcessed: true,
            purchaseEvents: [],
            rewardEarned: false
        });

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(result.ordersProcessed).toBe(1);
        expect(result.loyaltyPurchasesRecorded).toBe(0);
        expect(result.results).toHaveLength(0);
    });

    test('includes diagnostics in result', async () => {
        setupDbMocks({ qualifyingVariations: [{ variation_id: VARIATION_ID }] });
        getSquareAccessToken.mockResolvedValue('fake-token');

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ orders: [], cursor: null })
        });

        const result = await runBackfill({ merchantId: MERCHANT_ID });

        expect(result.diagnostics).toBeDefined();
        expect(result.diagnostics.qualifyingVariationIdsConfigured).toContain(VARIATION_ID);
        expect(result.diagnostics.prefetchedLoyaltyEvents).toBe(0);
    });
});
