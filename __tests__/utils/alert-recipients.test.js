/**
 * Tests for utils/alert-recipients.js
 *
 * Verifies role-based alert routing:
 * - Owner gets critical alerts
 * - Manager gets operational alerts
 * - Clerk and readonly get nothing
 */

process.env.NODE_ENV = 'test';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'test-session-secret-for-jest-tests';

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
const { getAlertRecipients, ALERT_ROLE_MAP } = require('../../utils/alert-recipients');

describe('getAlertRecipients', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('critical alerts', () => {
        it('should return only owner emails for critical alerts', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ email: 'owner@store.com' }]
            });

            const result = await getAlertRecipients(1, 'critical');

            expect(result).toEqual(['owner@store.com']);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('um.role = ANY($2)'),
                [1, ['owner']]
            );
        });

        it('should not include manager in critical alerts', async () => {
            // Verify the query is called with only 'owner' role
            db.query.mockResolvedValueOnce({ rows: [] });

            await getAlertRecipients(1, 'critical');

            const roles = db.query.mock.calls[0][1][1];
            expect(roles).toEqual(['owner']);
            expect(roles).not.toContain('manager');
        });
    });

    describe('operational alerts', () => {
        it('should return owner and manager emails for operational alerts', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { email: 'owner@store.com' },
                    { email: 'manager@store.com' }
                ]
            });

            const result = await getAlertRecipients(1, 'operational');

            expect(result).toEqual(['owner@store.com', 'manager@store.com']);
            expect(db.query).toHaveBeenCalledWith(
                expect.any(String),
                [1, ['owner', 'manager']]
            );
        });
    });

    describe('info alerts', () => {
        it('should return owner and manager emails for info alerts', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ email: 'owner@store.com' }]
            });

            const result = await getAlertRecipients(1, 'info');

            expect(result).toEqual(['owner@store.com']);
            expect(db.query).toHaveBeenCalledWith(
                expect.any(String),
                [1, ['owner', 'manager']]
            );
        });
    });

    describe('clerk and readonly exclusion', () => {
        it('should not include clerk role in any alert type', () => {
            for (const roles of Object.values(ALERT_ROLE_MAP)) {
                expect(roles).not.toContain('clerk');
            }
        });

        it('should not include readonly role in any alert type', () => {
            for (const roles of Object.values(ALERT_ROLE_MAP)) {
                expect(roles).not.toContain('readonly');
            }
        });
    });

    describe('edge cases', () => {
        it('should return empty array when merchantId is null', async () => {
            const result = await getAlertRecipients(null, 'critical');
            expect(result).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('should return empty array for unknown alert type', async () => {
            const result = await getAlertRecipients(1, 'unknown');
            expect(result).toEqual([]);
        });

        it('should return empty array when no matching users found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getAlertRecipients(1, 'critical');
            expect(result).toEqual([]);
        });

        it('should return empty array on database error', async () => {
            db.query.mockRejectedValueOnce(new Error('connection error'));

            const result = await getAlertRecipients(1, 'critical');
            expect(result).toEqual([]);
        });
    });
});
