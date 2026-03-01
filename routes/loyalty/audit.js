/**
 * Loyalty Audit, Stats & Findings Routes
 *
 * Audit log viewing, dashboard stats, and audit findings management:
 * - GET /audit - Get audit log entries
 * - GET /stats - Get loyalty program statistics
 * - GET /audit-findings - List unresolved audit findings
 * - POST /audit-findings/resolve/:id - Mark audit finding as resolved
 * - POST /audit-missed-redemptions - Re-scan for missed redemptions
 */

const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const loyaltyService = require('../../utils/loyalty-service');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const validators = require('../../middleware/validators/loyalty');

/**
 * GET /api/loyalty/audit
 * Get loyalty audit log entries
 */
router.get('/audit', requireAuth, requireMerchant, validators.listAudit, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { action, squareCustomerId, offerId, limit, offset } = req.query;

    const entries = await loyaltyService.getAuditLogs(merchantId, {
        action,
        squareCustomerId,
        offerId,
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0
    });

    res.json({ entries });
}));

/**
 * GET /api/loyalty/stats
 * Get loyalty program statistics for dashboard
 */
router.get('/stats', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const stats = await loyaltyService.getLoyaltyStats(merchantId);
    res.json({ stats });
}));

/**
 * GET /api/loyalty/audit-findings
 * List unresolved audit findings (orphaned rewards detected by loyalty-audit-job)
 */
router.get('/audit-findings', requireAuth, requireMerchant, validators.listAuditFindings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { resolved = 'false', issueType, limit = 50, offset = 0 } = req.query;

    const result = await loyaltyService.getAuditFindings({
        merchantId,
        resolved: resolved === 'true',
        issueType,
        limit: parseInt(limit),
        offset: parseInt(offset)
    });

    res.json(result);
}));

/**
 * POST /api/loyalty/audit-findings/resolve/:id
 * Mark an audit finding as resolved
 */
router.post('/audit-findings/resolve/:id', requireAuth, requireMerchant, requireWriteAccess, validators.resolveAuditFinding, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { id } = req.params;

    const finding = await loyaltyService.resolveAuditFinding({ merchantId, findingId: id });

    if (!finding) {
        return res.status(404).json({
            success: false,
            error: 'Audit finding not found',
            code: 'NOT_FOUND'
        });
    }

    logger.info('Resolved loyalty audit finding', {
        findingId: id,
        merchantId,
        userId: req.session.user.id
    });

    res.json({ success: true, finding });
}));

/**
 * POST /api/loyalty/audit-missed-redemptions
 * Re-scan recent orders through all three detection strategies to catch missed redemptions.
 */
router.post('/audit-missed-redemptions', requireAuth, requireMerchant, requireWriteAccess, validators.auditMissedRedemptions, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const days = parseInt(req.query.days, 10) || 7;
    const dryRun = req.query.dryRun !== 'false';

    logger.info('Starting missed redemption audit', {
        merchantId,
        days,
        dryRun,
        userId: req.session.user.id
    });

    const result = await loyaltyService.auditMissedRedemptions({
        merchantId,
        days,
        dryRun
    });

    res.json(result);
}));

module.exports = router;
