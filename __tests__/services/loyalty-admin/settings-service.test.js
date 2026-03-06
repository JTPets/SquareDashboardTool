/**
 * Tests for services/loyalty-admin/settings-service.js
 *
 * Validates getSettings: default initialization, DB query,
 * flat key-value response format.
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

const db = require('../../../utils/database');
const {
    getSettings,
    initializeDefaultSettings
} = require('../../../services/loyalty-admin/settings-service');

const MERCHANT_ID = 1;

describe('settings-service - getSettings', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('throws on missing merchantId', async () => {
        await expect(getSettings(null)).rejects.toThrow('merchantId is required');
        await expect(getSettings(undefined)).rejects.toThrow('merchantId is required');
    });

    test('initializes defaults then returns flat key-value map', async () => {
        // initializeDefaultSettings calls db.query for each default (3 INSERT calls)
        // getSettings calls db.query for the SELECT
        db.query
            .mockResolvedValueOnce({ rows: [] }) // default 1 INSERT
            .mockResolvedValueOnce({ rows: [] }) // default 2 INSERT
            .mockResolvedValueOnce({ rows: [] }) // default 3 INSERT
            .mockResolvedValueOnce({ rows: [   // SELECT query
                { setting_key: 'auto_detect_redemptions', setting_value: 'true', description: 'Auto detect' },
                { setting_key: 'send_receipt_messages', setting_value: 'false', description: 'Send receipts' },
                { setting_key: 'loyalty_enabled', setting_value: 'true', description: 'Master switch' }
            ]});

        const result = await getSettings(MERCHANT_ID);

        expect(result).toEqual({
            auto_detect_redemptions: 'true',
            send_receipt_messages: 'false',
            loyalty_enabled: 'true'
        });

        // Verify the SELECT query uses merchant_id parameter
        const selectCall = db.query.mock.calls[3];
        expect(selectCall[1]).toEqual([MERCHANT_ID]);
    });

    test('returns empty object when no settings exist', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] }) // default 1
            .mockResolvedValueOnce({ rows: [] }) // default 2
            .mockResolvedValueOnce({ rows: [] }) // default 3
            .mockResolvedValueOnce({ rows: [] }); // SELECT returns nothing

        const result = await getSettings(MERCHANT_ID);

        expect(result).toEqual({});
    });
});
