/**
 * Loyalty Variation Management Routes
 *
 * Manages qualifying variations for loyalty offers:
 * - POST /offers/:id/variations - Add qualifying variations
 * - GET /offers/:id/variations - Get qualifying variations
 * - GET /variations/assignments - Get all variation-to-offer assignments
 * - DELETE /offers/:offerId/variations/:variationId - Remove a variation
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
 * POST /api/loyalty/offers/:id/variations
 * Add qualifying variations to an offer
 */
router.post('/offers/:id/variations', requireAuth, requireMerchant, requireWriteAccess, validators.addVariations, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { variations } = req.body;

    const added = await loyaltyService.addQualifyingVariations(
        req.params.id,
        variations,
        merchantId,
        req.session.user.id
    );

    logger.info('Added qualifying variations to offer', {
        offerId: req.params.id,
        addedCount: added.length,
        merchantId
    });

    res.json({ added });
}));

/**
 * GET /api/loyalty/offers/:id/variations
 * Get qualifying variations for an offer
 */
router.get('/offers/:id/variations', requireAuth, requireMerchant, validators.getOfferVariations, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const variations = await loyaltyService.getQualifyingVariations(req.params.id, merchantId);
    res.json({ variations });
}));

/**
 * GET /api/loyalty/variations/assignments
 * Get all variation assignments across all offers for this merchant
 */
router.get('/variations/assignments', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const assignments = await loyaltyService.getVariationAssignments(merchantId);
    res.json({ assignments });
}));

/**
 * DELETE /api/loyalty/offers/:offerId/variations/:variationId
 * Remove a qualifying variation from an offer
 */
router.delete('/offers/:offerId/variations/:variationId', requireAuth, requireMerchant, requireWriteAccess, validators.removeVariation, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerId, variationId } = req.params;

    const removed = await loyaltyService.removeQualifyingVariation(
        offerId,
        variationId,
        merchantId,
        req.session.user.id
    );

    if (!removed) {
        return res.status(404).json({ error: 'Variation not found in offer' });
    }

    res.json({ success: true });
}));

module.exports = router;
