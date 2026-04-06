/**
 * Staff Invite Cleanup Job
 *
 * Removes pending staff invitations that were never accepted and are older
 * than 7 days. This unblocks re-invite attempts that would otherwise hit
 * the UNIQUE(merchant_id, email) constraint in staff_invitations.
 *
 * Note: "pending" = accepted_at IS NULL (no status column in the table).
 * Invitations inserted via staff-service.js already delete stale invites
 * before re-inserting, so this job is a belt-and-suspenders cleanup for
 * invites that were never followed up on.
 *
 * @module jobs/staff-invite-cleanup-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

/**
 * Delete pending staff invitations older than 7 days.
 * @returns {Promise<{ deleted: number }>}
 */
async function cleanupExpiredStaffInvites() {
    const result = await db.query(`
        DELETE FROM staff_invitations
        WHERE created_at < NOW() - INTERVAL '7 days'
          AND accepted_at IS NULL
    `);
    const deleted = result.rowCount || 0;
    if (deleted > 0) {
        logger.info('Staff invite cleanup: removed expired pending invites', { deleted });
    } else {
        logger.info('Staff invite cleanup: no expired pending invites found');
    }
    return { deleted };
}

/**
 * Scheduled entry point — catches errors so cron keeps running.
 */
async function runScheduledStaffInviteCleanup() {
    try {
        return await cleanupExpiredStaffInvites();
    } catch (error) {
        logger.error('Staff invite cleanup job failed', { error: error.message });
        return { deleted: 0 };
    }
}

module.exports = { cleanupExpiredStaffInvites, runScheduledStaffInviteCleanup };
