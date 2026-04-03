/**
 * Tests for getSettingsWithDefaults in services/delivery/delivery-settings.js
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../utils/token-encryption', () => ({
    encryptToken: jest.fn(v => `enc:${v}`),
    decryptToken: jest.fn(v => v.replace('enc:', '')),
    isEncryptedToken: jest.fn(v => v?.startsWith('enc:'))
}));

const db = require('../../../utils/database');
const { getSettingsWithDefaults } = require('../../../services/delivery/delivery-settings');

const MERCHANT_ID = 5;

beforeEach(() => jest.clearAllMocks());

describe('getSettingsWithDefaults', () => {
    it('returns real settings when a row exists', async () => {
        db.query.mockResolvedValue({ rows: [{ merchant_id: MERCHANT_ID, same_day_cutoff: '16:00', pod_retention_days: 90 }] });
        const result = await getSettingsWithDefaults(MERCHANT_ID);
        expect(result.same_day_cutoff).toBe('16:00');
        expect(result.pod_retention_days).toBe(90);
    });

    it('returns default object when no row exists', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const result = await getSettingsWithDefaults(MERCHANT_ID);
        expect(result).toMatchObject({
            merchant_id: MERCHANT_ID,
            start_address: null,
            end_address: null,
            same_day_cutoff: '17:00',
            pod_retention_days: 180,
            auto_ingest_ready_orders: true
        });
    });

    it('defaults include correct merchant_id', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const result = await getSettingsWithDefaults(99);
        expect(result.merchant_id).toBe(99);
    });
});
