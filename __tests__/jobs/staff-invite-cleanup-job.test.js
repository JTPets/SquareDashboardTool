/**
 * Tests for staff-invite-cleanup-job.
 *
 * Verifies that expired pending invitations are deleted, active/accepted
 * invitations are preserved, and that the job handles DB errors gracefully.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database');

const db = require('../../utils/database');
const { cleanupExpiredStaffInvites, runScheduledStaffInviteCleanup } = require('../../jobs/staff-invite-cleanup-job');
const logger = require('../../utils/logger');

describe('Staff Invite Cleanup Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('cleanupExpiredStaffInvites', () => {
        it('deletes pending invitations older than 7 days', async () => {
            db.query.mockResolvedValue({ rowCount: 3 });

            const result = await cleanupExpiredStaffInvites();

            expect(db.query).toHaveBeenCalledTimes(1);
            const [sql] = db.query.mock.calls[0];
            expect(sql).toMatch(/DELETE FROM staff_invitations/i);
            expect(sql).toMatch(/created_at < NOW\(\) - INTERVAL '7 days'/i);
            expect(sql).toMatch(/accepted_at IS NULL/i);
            expect(result).toEqual({ deleted: 3 });
        });

        it('returns deleted: 0 and logs no-op when no expired invites exist', async () => {
            db.query.mockResolvedValue({ rowCount: 0 });

            const result = await cleanupExpiredStaffInvites();

            expect(result).toEqual({ deleted: 0 });
            const infoCalls = logger.info.mock.calls.map(c => c[0]);
            expect(infoCalls.some(msg => msg.includes('no expired'))).toBe(true);
        });

        it('logs how many invites were deleted when rowCount > 0', async () => {
            db.query.mockResolvedValue({ rowCount: 5 });

            await cleanupExpiredStaffInvites();

            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('removed expired'),
                expect.objectContaining({ deleted: 5 })
            );
        });

        it('handles rowCount being undefined (treats as 0)', async () => {
            db.query.mockResolvedValue({ rowCount: undefined });

            const result = await cleanupExpiredStaffInvites();

            expect(result).toEqual({ deleted: 0 });
        });
    });

    describe('runScheduledStaffInviteCleanup', () => {
        it('returns result on success', async () => {
            db.query.mockResolvedValue({ rowCount: 2 });

            const result = await runScheduledStaffInviteCleanup();

            expect(result).toEqual({ deleted: 2 });
        });

        it('catches DB errors and returns deleted: 0 without re-throwing', async () => {
            db.query.mockRejectedValue(new Error('connection lost'));

            const result = await runScheduledStaffInviteCleanup();

            expect(result).toEqual({ deleted: 0 });
            expect(logger.error).toHaveBeenCalledWith(
                'Staff invite cleanup job failed',
                expect.objectContaining({ error: 'connection lost' })
            );
        });

        it('does not delete accepted invitations (accepted_at IS NULL guard)', async () => {
            db.query.mockResolvedValue({ rowCount: 0 });

            await runScheduledStaffInviteCleanup();

            const [sql] = db.query.mock.calls[0];
            // Confirm the query guards on accepted_at IS NULL so accepted invites are safe
            expect(sql).toMatch(/accepted_at IS NULL/i);
        });
    });
});
