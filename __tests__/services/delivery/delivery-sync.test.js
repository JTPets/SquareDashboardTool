/**
 * Tests for services/delivery/delivery-sync.js
 *
 * Covers: syncSquareOrders — happy path, empty results,
 * completed order update, duplicate skip, ingest failure handling.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockGetSquareClientForMerchant = jest.fn();
jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: mockGetSquareClientForMerchant
}));

const mockGetLocationIds = jest.fn();
jest.mock('../../../services/delivery/delivery-stats', () => ({
    getLocationIds: mockGetLocationIds
}));

const mockGetOrderBySquareId = jest.fn();
const mockUpdateOrder = jest.fn();
jest.mock('../../../services/delivery/delivery-orders', () => ({
    getOrderBySquareId: mockGetOrderBySquareId,
    updateOrder: mockUpdateOrder
}));

const mockIngestSquareOrder = jest.fn();
jest.mock('../../../services/delivery/delivery-square', () => ({
    ingestSquareOrder: mockIngestSquareOrder
}));

const { syncSquareOrders } = require('../../../services/delivery/delivery-sync');

const MERCHANT_ID = 1;

function makeSquareClient(orders = []) {
    return {
        orders: {
            search: jest.fn().mockResolvedValue({ orders })
        }
    };
}

function makeOpenOrder(id, fulfillmentType = 'DELIVERY') {
    return {
        id,
        state: 'OPEN',
        fulfillments: [{ type: fulfillmentType, deliveryDetails: { recipient: { displayName: 'Alice' } } }]
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetLocationIds.mockResolvedValue(['loc-1']);
});

describe('syncSquareOrders', () => {
    it('returns zeroes when Square returns no orders', async () => {
        mockGetSquareClientForMerchant.mockResolvedValue(makeSquareClient([]));

        const result = await syncSquareOrders(MERCHANT_ID, 7);
        expect(result).toEqual({ found: 0, imported: 0, skipped: 0, errors: undefined });
    });

    it('imports open orders with delivery fulfillments', async () => {
        const orders = [makeOpenOrder('sq-1'), makeOpenOrder('sq-2')];
        mockGetSquareClientForMerchant.mockResolvedValue(makeSquareClient(orders));
        mockIngestSquareOrder.mockResolvedValue({ id: 10 });

        const result = await syncSquareOrders(MERCHANT_ID, 7);
        expect(result.found).toBe(2);
        expect(result.imported).toBe(2);
        expect(result.skipped).toBe(0);
        expect(mockIngestSquareOrder).toHaveBeenCalledTimes(2);
    });

    it('skips orders with no delivery-type fulfillment', async () => {
        const order = { id: 'sq-1', state: 'OPEN', fulfillments: [{ type: 'DIGITAL' }] };
        mockGetSquareClientForMerchant.mockResolvedValue(makeSquareClient([order]));

        const result = await syncSquareOrders(MERCHANT_ID, 7);
        expect(result.skipped).toBe(1);
        expect(result.imported).toBe(0);
        expect(mockIngestSquareOrder).not.toHaveBeenCalled();
    });

    it('updates existing local order when Square state is COMPLETED', async () => {
        const order = { id: 'sq-1', state: 'COMPLETED', fulfillments: [{ type: 'DELIVERY' }] };
        mockGetSquareClientForMerchant.mockResolvedValue(makeSquareClient([order]));
        mockGetOrderBySquareId.mockResolvedValue({ id: 99, status: 'pending' });

        const result = await syncSquareOrders(MERCHANT_ID, 7);
        expect(result.imported).toBe(1);
        expect(mockUpdateOrder).toHaveBeenCalledWith(MERCHANT_ID, 99, expect.objectContaining({ status: 'completed' }));
    });

    it('skips completed Square order already marked completed locally', async () => {
        const order = { id: 'sq-1', state: 'COMPLETED', fulfillments: [{ type: 'DELIVERY' }] };
        mockGetSquareClientForMerchant.mockResolvedValue(makeSquareClient([order]));
        mockGetOrderBySquareId.mockResolvedValue({ id: 99, status: 'completed' });

        const result = await syncSquareOrders(MERCHANT_ID, 7);
        expect(result.skipped).toBe(1);
        expect(mockUpdateOrder).not.toHaveBeenCalled();
    });

    it('skips completed Square order not in local system', async () => {
        const order = { id: 'sq-new', state: 'COMPLETED', fulfillments: [{ type: 'DELIVERY' }] };
        mockGetSquareClientForMerchant.mockResolvedValue(makeSquareClient([order]));
        mockGetOrderBySquareId.mockResolvedValue(null);

        const result = await syncSquareOrders(MERCHANT_ID, 7);
        expect(result.skipped).toBe(1);
        expect(mockIngestSquareOrder).not.toHaveBeenCalled();
    });

    it('records errors for individual order failures but continues', async () => {
        const orders = [makeOpenOrder('sq-1'), makeOpenOrder('sq-2')];
        mockGetSquareClientForMerchant.mockResolvedValue(makeSquareClient(orders));
        mockIngestSquareOrder
            .mockResolvedValueOnce({ id: 10 })
            .mockRejectedValueOnce(new Error('DB error'));

        const result = await syncSquareOrders(MERCHANT_ID, 7);
        expect(result.imported).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({ orderId: 'sq-2', error: 'DB error' });
    });

    it('passes daysBack to Square search date filter', async () => {
        const client = makeSquareClient([]);
        mockGetSquareClientForMerchant.mockResolvedValue(client);

        await syncSquareOrders(MERCHANT_ID, 14);

        const searchArg = client.orders.search.mock.calls[0][0];
        const startAt = new Date(searchArg.query.filter.dateTimeFilter.createdAt.startAt);
        const daysAgo = Math.round((Date.now() - startAt.getTime()) / (1000 * 60 * 60 * 24));
        expect(daysAgo).toBeGreaterThanOrEqual(13);
        expect(daysAgo).toBeLessThanOrEqual(15);
    });
});
