/**
 * Min/Max Suppression Routes
 *
 * Endpoints for the suppression dashboard (BACKLOG-106):
 *   GET  /api/min-max/suppressed  — items skipped in the last auto-adjustment run
 *   GET  /api/min-max/audit-log   — recent applied min-stock changes
 *   POST /api/min-max/toggle-pin  — pin or unpin a variation from auto-adjustment
 *
 * All routes: authenticated, merchant-scoped, parameterized SQL enforced in service.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireWriteAccess } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/min-max-suppression');
const autoMinMax = require('../services/inventory/auto-min-max-service');
const { sendSuccess, sendError } = require('../utils/response-helper');

/**
 * GET /api/min-max/suppressed
 * Returns items skipped during the most recent weekly auto-adjustment run.
 */
router.get('/min-max/suppressed',
    requireAuth, requireMerchant, validators.getSuppressed,
    asyncHandler(async (req, res) => {
        const items = await autoMinMax.getSuppressedItems(req.merchantContext.id);
        sendSuccess(res, { count: items.length, items });
    })
);

/**
 * GET /api/min-max/audit-log
 * Returns recent applied min-stock changes (skipped=FALSE entries).
 * Query: limit (1-200, default 50)
 */
router.get('/min-max/audit-log',
    requireAuth, requireMerchant, validators.getAuditLog,
    asyncHandler(async (req, res) => {
        const limit = parseInt(req.query.limit) || 50;
        const items = await autoMinMax.getAuditLog(req.merchantContext.id, limit);
        sendSuccess(res, { count: items.length, items });
    })
);

/**
 * POST /api/min-max/toggle-pin
 * Pin or unpin a variation from weekly auto-adjustment.
 * Body: { variationId, locationId, pinned: true|false }
 */
router.post('/min-max/toggle-pin',
    requireAuth, requireMerchant, requireWriteAccess, validators.togglePin,
    asyncHandler(async (req, res) => {
        const { variationId, locationId, pinned } = req.body;
        try {
            const result = await autoMinMax.toggleMinStockPin(
                variationId, locationId, req.merchantContext.id, pinned
            );
            sendSuccess(res, result);
        } catch (err) {
            if (err.message === 'Variation not found for this merchant') {
                return sendError(res, err.message, 404, 'NOT_FOUND');
            }
            throw err;
        }
    })
);

module.exports = router;
