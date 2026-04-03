/**
 * Tests for services/delivery/delivery-orders.js
 *
 * Covers: updateOrderNotes — the function extracted from the /orders/:id/notes route handler.
 */

const db = require('../../../utils/database');

jest.mock('../../../utils/token-encryption', () => ({
    encryptToken: jest.fn(val => `encrypted:${val}`),
    decryptToken: jest.fn(val => val.replace('encrypted:', '')),
    isEncryptedToken: jest.fn(val => val?.startsWith('encrypted:'))
}));
jest.mock('../../../services/loyalty-admin/customer-details-service', () => ({
    getCustomerDetails: jest.fn().mockResolvedValue(null)
}));
jest.mock('fs', () => ({ promises: { mkdir: jest.fn(), writeFile: jest.fn(), unlink: jest.fn() } }));
global.fetch = jest.fn();

const { updateOrderNotes } = require('../../../services/delivery/delivery-orders');

const MERCHANT_ID = 1;
const ORDER_ID = '11111111-1111-1111-1111-111111111111';

function makeOrder(overrides = {}) {
    return { id: ORDER_ID, merchant_id: MERCHANT_ID, status: 'pending', notes: null, ...overrides };
}

beforeEach(() => {
    jest.resetAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('updateOrderNotes', () => {
    it('returns null when order not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // getOrderById returns nothing
        const result = await updateOrderNotes(MERCHANT_ID, ORDER_ID, 'Leave at door');
        expect(result).toBeNull();
    });

    it('updates notes and returns { notes }', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeOrder()] })          // getOrderById
            .mockResolvedValueOnce({ rows: [makeOrder({ notes: 'Leave at door' })] }); // updateOrder
        const result = await updateOrderNotes(MERCHANT_ID, ORDER_ID, 'Leave at door');
        expect(result).toEqual({ notes: 'Leave at door' });
    });

    it('stores null when empty string provided', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeOrder()] })
            .mockResolvedValueOnce({ rows: [makeOrder({ notes: null })] });
        const result = await updateOrderNotes(MERCHANT_ID, ORDER_ID, '');
        expect(result).toEqual({ notes: null });
        // Verify updateOrder was called with notes: null
        const updateCall = db.query.mock.calls[1];
        expect(updateCall[0]).toContain('notes');
        expect(updateCall[1]).toContain(null);
    });

    it('stores null when notes is undefined', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeOrder()] })
            .mockResolvedValueOnce({ rows: [makeOrder({ notes: null })] });
        const result = await updateOrderNotes(MERCHANT_ID, ORDER_ID, undefined);
        expect(result).toEqual({ notes: null });
    });
});
