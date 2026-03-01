/**
 * Loyalty Discount Validation Routes
 *
 * Handles earned reward discount validation against Square:
 * - GET /discounts/validate - Validate earned rewards discounts
 * - POST /discounts/validate-and-fix - Validate and fix discount issues
 */

const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const loyaltyService = require('../../utils/loyalty-service');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');

/**
 * GET /api/loyalty/discounts/validate
 * Validate earned rewards discounts against Square
 */
router.get('/discounts/validate', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await loyaltyService.validateEarnedRewardsDiscounts({
        merchantId,
        fixIssues: false
    });

    res.json(result);
}));

/**
 * POST /api/loyalty/discounts/validate-and-fix
 * Validate earned rewards discounts and fix any issues found
 */
router.post('/discounts/validate-and-fix', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await loyaltyService.validateEarnedRewardsDiscounts({
        merchantId,
        fixIssues: true
    });

    logger.info('Validated and fixed discount issues', {
        merchantId,
        totalEarned: result.totalEarned,
        validated: result.validated,
        issues: result.issues.length,
        fixed: result.fixed.length
    });

    res.json(result);
}));

module.exports = router;
