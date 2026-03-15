/**
 * Square Locations Service Tests
 *
 * Tests for syncing location data from Square API to local DB.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn(),
    makeSquareRequest: jest.fn(),
}));

const db = require('../../../utils/database');
const { getMerchantToken, makeSquareRequest } = require('../../../services/square/square-client');
const { syncLocations } = require('../../../services/square/square-locations');

describe('Square Locations Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('syncLocations', () => {
        test('syncs all locations from Square', async () => {
            getMerchantToken.mockResolvedValue('test-token');
            makeSquareRequest.mockResolvedValue({
                locations: [
                    {
                        id: 'LOC1',
                        name: 'Main Store',
                        status: 'ACTIVE',
                        address: { address_line_1: '123 Main St' },
                        timezone: 'America/Toronto',
                        phoneNumber: '4165551234',
                        businessEmail: 'store@test.com',
                    },
                    {
                        id: 'LOC2',
                        name: 'Warehouse',
                        status: 'INACTIVE',
                        address: null,
                        timezone: 'America/Toronto',
                    },
                ],
            });
            db.query.mockResolvedValue({});

            const count = await syncLocations(1);

            expect(count).toBe(2);
            expect(getMerchantToken).toHaveBeenCalledWith(1);
            expect(makeSquareRequest).toHaveBeenCalledWith('/v2/locations', { accessToken: 'test-token' });
            expect(db.query).toHaveBeenCalledTimes(2);

            // Verify first location upsert
            const firstCall = db.query.mock.calls[0][1];
            expect(firstCall[0]).toBe('LOC1'); // id
            expect(firstCall[1]).toBe('Main Store'); // name
            expect(firstCall[3]).toBe(true); // active (ACTIVE status)
            expect(firstCall[8]).toBe(1); // merchantId

            // Verify inactive location
            const secondCall = db.query.mock.calls[1][1];
            expect(secondCall[3]).toBe(false); // active (INACTIVE status)
        });

        test('handles empty locations array', async () => {
            getMerchantToken.mockResolvedValue('token');
            makeSquareRequest.mockResolvedValue({ locations: [] });

            const count = await syncLocations(1);
            expect(count).toBe(0);
            expect(db.query).not.toHaveBeenCalled();
        });

        test('handles missing locations property', async () => {
            getMerchantToken.mockResolvedValue('token');
            makeSquareRequest.mockResolvedValue({});

            const count = await syncLocations(1);
            expect(count).toBe(0);
        });

        test('serializes address as JSON', async () => {
            getMerchantToken.mockResolvedValue('token');
            makeSquareRequest.mockResolvedValue({
                locations: [{ id: 'L1', name: 'Store', status: 'ACTIVE', address: { city: 'Toronto' }, timezone: 'ET' }],
            });
            db.query.mockResolvedValue({});

            await syncLocations(1);
            expect(db.query.mock.calls[0][1][4]).toBe('{"city":"Toronto"}');
        });

        test('handles null optional fields', async () => {
            getMerchantToken.mockResolvedValue('token');
            makeSquareRequest.mockResolvedValue({
                locations: [{ id: 'L1', name: 'Store', status: 'ACTIVE', timezone: 'ET' }],
            });
            db.query.mockResolvedValue({});

            await syncLocations(1);
            const params = db.query.mock.calls[0][1];
            expect(params[4]).toBeNull(); // address
            expect(params[6]).toBeNull(); // phoneNumber
            expect(params[7]).toBeNull(); // businessEmail
        });

        test('throws on API error', async () => {
            getMerchantToken.mockResolvedValue('token');
            makeSquareRequest.mockRejectedValue(new Error('API down'));

            await expect(syncLocations(1)).rejects.toThrow('API down');
        });

        test('throws on token error', async () => {
            getMerchantToken.mockRejectedValue(new Error('No token'));

            await expect(syncLocations(1)).rejects.toThrow('No token');
        });
    });
});
