/**
 * Vendor Match Suggestions Routes — BACKLOG-114
 *
 * Endpoints for reviewing and acting on cross-vendor UPC match suggestions.
 * All matches require explicit merchant approval — never auto-applied.
 *
 * Endpoints:
 * - GET  /api/vendor-match-suggestions         - List suggestions (filterable by status)
 * - GET  /api/vendor-match-suggestions/count   - Pending count for badge
 * - POST /api/vendor-match-suggestions/:id/approve  - Approve one suggestion
 * - POST /api/vendor-match-suggestions/:id/reject   - Reject one suggestion
 * - POST /api/vendor-match-suggestions/bulk-approve - Approve multiple suggestions
 * - POST /api/vendor-match-suggestions/backfill     - Trigger retroactive backfill scan
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/vendor-match-suggestions');
const { sendSuccess, sendError, sendPaginated } = require('../utils/response-helper');
const {
    getPendingCount,
    listSuggestions,
    approveSuggestion,
    rejectSuggestion,
    bulkApprove,
    runBackfillScan
} = require('../services/vendor/match-suggestions-service');

/**
 * GET /api/vendor-match-suggestions/count
 * Pending count for badge display.
 */
router.get('/count', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const count = await getPendingCount(merchantId);
    sendSuccess(res, { count });
}));

/**
 * GET /api/vendor-match-suggestions
 * List suggestions with product/vendor context.
 * Query params: status (default: pending), limit, offset
 */
router.get('/', requireAuth, requireMerchant, validators.listSuggestions, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const status = req.query.status || 'pending';
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;

    const { suggestions, total } = await listSuggestions(merchantId, { status, limit, offset });
    sendPaginated(res, { items: suggestions, total, limit, offset });
}));

/**
 * POST /api/vendor-match-suggestions/bulk-approve
 * Approve multiple pending suggestions at once.
 * Body: { ids: [1, 2, 3] }
 */
router.post('/bulk-approve', requireAuth, requireMerchant, validators.bulkApprove, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const userId = req.session?.user?.id || null;
    const { ids } = req.body;

    const result = await bulkApprove(ids, userId, merchantId);
    sendSuccess(res, result);
}));

/**
 * POST /api/vendor-match-suggestions/backfill
 * Trigger a retroactive backfill scan for this merchant.
 * Generates pending suggestions for any UPC-matched variations missing vendor links.
 */
router.post('/backfill', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await runBackfillScan(merchantId);
    sendSuccess(res, result);
}));

/**
 * POST /api/vendor-match-suggestions/:id/approve
 * Approve a single suggestion: creates variation_vendors + pushes to Square.
 */
router.post('/:id/approve', requireAuth, requireMerchant, validators.approveOrReject, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const userId = req.session?.user?.id || null;
    const suggestionId = parseInt(req.params.id, 10);

    try {
        const result = await approveSuggestion(suggestionId, userId, merchantId);
        sendSuccess(res, result);
    } catch (err) {
        const status = err.statusCode || 500;
        sendError(res, err.message, status);
    }
}));

/**
 * POST /api/vendor-match-suggestions/:id/reject
 * Reject a suggestion permanently.
 */
router.post('/:id/reject', requireAuth, requireMerchant, validators.approveOrReject, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const userId = req.session?.user?.id || null;
    const suggestionId = parseInt(req.params.id, 10);

    try {
        const result = await rejectSuggestion(suggestionId, userId, merchantId);
        sendSuccess(res, result);
    } catch (err) {
        const status = err.statusCode || 500;
        sendError(res, err.message, status);
    }
}));

module.exports = router;
