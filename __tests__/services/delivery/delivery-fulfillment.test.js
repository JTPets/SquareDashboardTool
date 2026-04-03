/**
 * Tests for services/delivery/delivery-fulfillment.js
 *
 * Covers: completeDeliveryInSquare — happy path, no square_order_id,
 * already-completed fulfillments, Square API failure.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockGetSquareClientForMerchant = jest.fn();
jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: mockGetSquareClientForMerchant
}));

const mockGenerateIdempotencyKey = jest.fn(k => `idem-${k}`);
jest.mock('../../../utils/idempotency', () => ({
    generateIdempotencyKey: mockGenerateIdempotencyKey
}));

const { completeDeliveryInSquare } = require('../../../services/delivery/delivery-fulfillment');

const MERCHANT_ID = 1;

function makeSquareClient(fulfillments, orderState = 'OPEN') {
    const squareOrder = {
        order: {
            locationId: 'loc-1',
            version: 1,
            state: orderState,
            fulfillments
        }
    };
    return {
        orders: {
            get: jest.fn().mockResolvedValue(squareOrder),
            update: jest.fn().mockResolvedValue({})
        }
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('completeDeliveryInSquare', () => {
    it('returns squareSynced:false when order has no square_order_id', async () => {
        const result = await completeDeliveryInSquare(MERCHANT_ID, { id: 1 });
        expect(result).toEqual({ squareSynced: false, squareSyncError: null });
        expect(mockGetSquareClientForMerchant).not.toHaveBeenCalled();
    });

    it('returns squareSynced:false when Square order has no fulfillments', async () => {
        const client = makeSquareClient([]);
        client.orders.get.mockResolvedValue({ order: { locationId: 'loc-1', version: 1, state: 'OPEN', fulfillments: [] } });
        mockGetSquareClientForMerchant.mockResolvedValue(client);

        const result = await completeDeliveryInSquare(MERCHANT_ID, { id: 1, square_order_id: 'sq-1' });
        expect(result).toEqual({ squareSynced: false, squareSyncError: null });
        expect(client.orders.update).not.toHaveBeenCalled();
    });

    it('skips already-COMPLETED fulfillment and still marks order COMPLETED', async () => {
        const fulfillments = [{ uid: 'f1', type: 'DELIVERY', state: 'COMPLETED' }];
        const client = makeSquareClient(fulfillments);
        mockGetSquareClientForMerchant.mockResolvedValue(client);

        const result = await completeDeliveryInSquare(MERCHANT_ID, { id: 1, square_order_id: 'sq-1' });
        expect(result.squareSynced).toBe(true);
        // Should update order state to COMPLETED
        expect(client.orders.update).toHaveBeenCalledWith(
            expect.objectContaining({ order: expect.objectContaining({ state: 'COMPLETED' }) })
        );
    });

    it('transitions DELIVERY fulfillment from PROPOSED through to COMPLETED with deliveredAt', async () => {
        const fulfillments = [{ uid: 'f1', type: 'DELIVERY', state: 'PROPOSED', deliveryDetails: {} }];
        const client = makeSquareClient(fulfillments);
        mockGetSquareClientForMerchant.mockResolvedValue(client);

        const result = await completeDeliveryInSquare(MERCHANT_ID, { id: 1, square_order_id: 'sq-1' });
        expect(result.squareSynced).toBe(true);
        expect(result.squareSyncError).toBeNull();

        // Should have stepped through RESERVED → PREPARED → COMPLETED
        const updateCalls = client.orders.update.mock.calls;
        const states = updateCalls
            .filter(c => c[0].order.fulfillments)
            .map(c => c[0].order.fulfillments[0].state);
        expect(states).toEqual(['RESERVED', 'PREPARED', 'COMPLETED']);

        // Final fulfillment update should carry deliveredAt
        const completedCall = updateCalls.find(c =>
            c[0].order.fulfillments?.[0]?.state === 'COMPLETED'
        );
        expect(completedCall[0].order.fulfillments[0].deliveryDetails.deliveredAt).toBeDefined();
    });

    it('transitions SHIPMENT fulfillment and sets shippedAt', async () => {
        const fulfillments = [{ uid: 'f1', type: 'SHIPMENT', state: 'PREPARED', shipmentDetails: {} }];
        const client = makeSquareClient(fulfillments);
        mockGetSquareClientForMerchant.mockResolvedValue(client);

        const result = await completeDeliveryInSquare(MERCHANT_ID, { id: 1, square_order_id: 'sq-1' });
        expect(result.squareSynced).toBe(true);

        const completedCall = client.orders.update.mock.calls.find(c =>
            c[0].order.fulfillments?.[0]?.state === 'COMPLETED'
        );
        expect(completedCall[0].order.fulfillments[0].shipmentDetails.shippedAt).toBeDefined();
    });

    it('does not re-update order state when already COMPLETED in Square', async () => {
        const fulfillments = [{ uid: 'f1', type: 'DELIVERY', state: 'COMPLETED' }];
        const client = {
            orders: {
                get: jest.fn().mockResolvedValue({
                    order: { locationId: 'loc-1', version: 2, state: 'COMPLETED', fulfillments }
                }),
                update: jest.fn().mockResolvedValue({})
            }
        };
        mockGetSquareClientForMerchant.mockResolvedValue(client);

        await completeDeliveryInSquare(MERCHANT_ID, { id: 1, square_order_id: 'sq-1' });
        // No update calls — fulfillment already done, order already COMPLETED
        expect(client.orders.update).not.toHaveBeenCalled();
    });

    it('returns squareSynced:false and squareSyncError on Square API failure', async () => {
        mockGetSquareClientForMerchant.mockRejectedValue(new Error('Square API down'));

        const result = await completeDeliveryInSquare(MERCHANT_ID, { id: 1, square_order_id: 'sq-1' });
        expect(result).toEqual({ squareSynced: false, squareSyncError: 'Square API down' });
    });

    it('uses unique idempotency keys for each state transition', async () => {
        const fulfillments = [{ uid: 'f1', type: 'DELIVERY', state: 'PROPOSED', deliveryDetails: {} }];
        const client = makeSquareClient(fulfillments);
        mockGetSquareClientForMerchant.mockResolvedValue(client);

        await completeDeliveryInSquare(MERCHANT_ID, { id: 42, square_order_id: 'sq-42' });

        const keys = mockGenerateIdempotencyKey.mock.calls.map(c => c[0]);
        const uniqueKeys = new Set(keys);
        expect(uniqueKeys.size).toBe(keys.length);
    });
});
