/**
 * Platform Settings Service Tests
 *
 * Tests for the platform_settings table read/write with caching.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

const db = require('../../utils/database');
const platformSettings = require('../../services/platform-settings');

describe('Platform Settings Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        platformSettings.clearCache();
    });

    describe('getSetting', () => {
        it('should return value from database when not cached', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ value: '180' }]
            });

            const value = await platformSettings.getSetting('default_trial_days');

            expect(value).toBe('180');
            expect(db.query).toHaveBeenCalledWith(
                'SELECT value FROM platform_settings WHERE key = $1',
                ['default_trial_days']
            );
        });

        it('should return default value when key not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const value = await platformSettings.getSetting('nonexistent', '42');

            expect(value).toBe('42');
        });

        it('should return null when key not found and no default', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const value = await platformSettings.getSetting('nonexistent');

            expect(value).toBeNull();
        });

        it('should return cached value on subsequent calls', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ value: '180' }]
            });

            // First call - hits DB
            const value1 = await platformSettings.getSetting('default_trial_days');
            // Second call - should use cache
            const value2 = await platformSettings.getSetting('default_trial_days');

            expect(value1).toBe('180');
            expect(value2).toBe('180');
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        it('should return stale cache on database error', async () => {
            // First call succeeds
            db.query.mockResolvedValueOnce({
                rows: [{ value: '180' }]
            });
            await platformSettings.getSetting('default_trial_days');

            // Expire cache manually
            platformSettings.clearCache();

            // Repopulate cache with a value, then simulate expiry + error
            db.query.mockResolvedValueOnce({
                rows: [{ value: '180' }]
            });
            await platformSettings.getSetting('default_trial_days');

            // Now clear cache and simulate DB failure
            platformSettings.clearCache();
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            // Should return default since cache was cleared
            const value = await platformSettings.getSetting('default_trial_days', '30');

            expect(value).toBe('30');
        });

        it('should return default value on database error with no cache', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            const value = await platformSettings.getSetting('default_trial_days', '30');

            expect(value).toBe('30');
        });
    });

    describe('setSetting', () => {
        it('should write to database and invalidate cache', async () => {
            db.query.mockResolvedValue({ rows: [] });

            // Pre-populate cache
            db.query.mockResolvedValueOnce({
                rows: [{ value: '180' }]
            });
            await platformSettings.getSetting('default_trial_days');

            // Now update the setting
            db.query.mockResolvedValueOnce({ rows: [] });
            await platformSettings.setSetting('default_trial_days', '90');

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO platform_settings'),
                ['default_trial_days', '90']
            );

            // Next getSetting should hit DB again (cache invalidated)
            db.query.mockResolvedValueOnce({
                rows: [{ value: '90' }]
            });
            const value = await platformSettings.getSetting('default_trial_days');
            expect(value).toBe('90');
        });

        it('should upsert (insert or update) a setting', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await platformSettings.setSetting('new_setting', 'new_value');

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('ON CONFLICT (key) DO UPDATE'),
                ['new_setting', 'new_value']
            );
        });
    });

    describe('getAllSettings', () => {
        it('should return all settings ordered by key', async () => {
            const mockSettings = [
                { key: 'default_trial_days', value: '180', updated_at: '2026-03-01T00:00:00Z' },
                { key: 'feature_flag_x', value: 'true', updated_at: '2026-03-01T00:00:00Z' }
            ];
            db.query.mockResolvedValueOnce({ rows: mockSettings });

            const settings = await platformSettings.getAllSettings();

            expect(settings).toEqual(mockSettings);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('ORDER BY key')
            );
        });
    });

    describe('clearCache', () => {
        it('should force next getSetting to hit database', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ value: '180' }]
            });
            await platformSettings.getSetting('default_trial_days');

            platformSettings.clearCache();

            db.query.mockResolvedValueOnce({
                rows: [{ value: '90' }]
            });
            const value = await platformSettings.getSetting('default_trial_days');

            expect(value).toBe('90');
            expect(db.query).toHaveBeenCalledTimes(2);
        });
    });
});
