/**
 * Loyalty Audit, Stats & Findings Routes
 *
 * Audit log viewing, dashboard stats, and audit findings management:
 * - GET /audit - Get audit log entries
 * - GET /stats - Get loyalty program statistics
 * - GET /audit-findings - List unresolved audit findings
 * - POST /audit-findings/resolve/:id - Mark audit finding as resolved
 * - POST /audit-missed-redemptions - Re-scan for missed redemptions
 *
 * OBSERVATION LOG:
 * - GET /stats has 5 inline SQL queries (should be in a stats service)
 * - GET /audit-findings has inline SQL with dynamic WHERE (should be in audit-service)
 * - POST /audit-findings/resolve/:id has inline SQL UPDATE (should be in audit-service)
 */

const express = require('express');
const router = express.Router();
const db = require('../../utils/database');
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

    // Get offer counts
    const offerStats = await db.query(`
        SELECT
            COUNT(*) FILTER (WHERE is_active = TRUE) as active_offers,
            COUNT(*) as total_offers
        FROM loyalty_offers
        WHERE merchant_id = $1
    `, [merchantId]);

    // Get reward counts by status
    const rewardStats = await db.query(`
        SELECT status, COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
        GROUP BY status
    `, [merchantId]);

    // Get recent activity
    const recentEarned = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status IN ('earned', 'redeemed')
          AND earned_at >= NOW() - INTERVAL '30 days'
    `, [merchantId]);

    // Query loyalty_rewards for redeemed count (consistent with per-offer stats)
    // Note: Modern reward-service.js only updates loyalty_rewards, not loyalty_redemptions
    const recentRedeemed = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'redeemed'
          AND redeemed_at >= NOW() - INTERVAL '30 days'
    `, [merchantId]);

    // Calculate total redemption value from purchase events linked to redeemed rewards
    // Each reward's value is the average unit_price_cents of its contributing purchases
    // This reflects actual item prices at time of purchase
    const totalValue = await db.query(`
        SELECT COALESCE(SUM(reward_value), 0) as total_cents
        FROM (
            SELECT r.id, AVG(pe.unit_price_cents) as reward_value
            FROM loyalty_rewards r
            INNER JOIN loyalty_purchase_events pe ON pe.reward_id = r.id
            WHERE r.merchant_id = $1
              AND r.status = 'redeemed'
              AND pe.unit_price_cents > 0
            GROUP BY r.id
        ) reward_values
    `, [merchantId]);

    res.json({
        stats: {
            offers: {
                active: parseInt(offerStats.rows[0]?.active_offers || 0),
                total: parseInt(offerStats.rows[0]?.total_offers || 0)
            },
            rewards: rewardStats.rows.reduce((acc, row) => {
                acc[row.status] = parseInt(row.count);
                return acc;
            }, {}),
            last30Days: {
                earned: parseInt(recentEarned.rows[0]?.count || 0),
                redeemed: parseInt(recentRedeemed.rows[0]?.count || 0)
            },
            totalRedemptionValueCents: parseInt(totalValue.rows[0]?.total_cents || 0)
        }
    });
}));

/**
 * GET /api/loyalty/audit-findings
 * List unresolved audit findings (orphaned rewards detected by loyalty-audit-job)
 *
 * Query params:
 * - resolved: 'true' or 'false' (default: false)
 * - issueType: MISSING_REDEMPTION, PHANTOM_REWARD, DOUBLE_REDEMPTION
 * - limit: number (default: 50)
 * - offset: number (default: 0)
 */
router.get('/audit-findings', requireAuth, requireMerchant, validators.listAuditFindings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { resolved = 'false', issueType, limit = 50, offset = 0 } = req.query;

    let query = `
        SELECT id, square_customer_id, order_id, reward_id, issue_type,
               details, resolved, resolved_at, created_at
        FROM loyalty_audit_log
        WHERE merchant_id = $1
          AND resolved = $2
    `;
    const params = [merchantId, resolved === 'true'];

    if (issueType) {
        query += ` AND issue_type = $${params.length + 1}`;
        params.push(issueType);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get total count for pagination
    let countQuery = `
        SELECT COUNT(*) as total
        FROM loyalty_audit_log
        WHERE merchant_id = $1 AND resolved = $2
    `;
    const countParams = [merchantId, resolved === 'true'];
    if (issueType) {
        countQuery += ` AND issue_type = $3`;
        countParams.push(issueType);
    }
    const countResult = await db.query(countQuery, countParams);

    res.json({
        findings: result.rows,
        pagination: {
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        }
    });
}));

/**
 * POST /api/loyalty/audit-findings/resolve/:id
 * Mark an audit finding as resolved
 */
router.post('/audit-findings/resolve/:id', requireAuth, requireMerchant, requireWriteAccess, validators.resolveAuditFinding, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { id } = req.params;

    const result = await db.query(`
        UPDATE loyalty_audit_log
        SET resolved = TRUE, resolved_at = NOW()
        WHERE id = $1 AND merchant_id = $2
        RETURNING id, resolved, resolved_at
    `, [id, merchantId]);

    if (result.rows.length === 0) {
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

    res.json({
        success: true,
        finding: result.rows[0]
    });
}));

/**
 * POST /api/loyalty/audit-missed-redemptions
 * Re-scan recent orders through all three detection strategies to catch missed redemptions.
 * Default dryRun=true — reports matches without redeeming.
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
