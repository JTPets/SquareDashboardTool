/**
 * Loyalty Variation Management Routes
 *
 * Manages qualifying variations for loyalty offers:
 * - POST /offers/:id/variations - Add qualifying variations
 * - GET /offers/:id/variations - Get qualifying variations
 * - GET /variations/assignments - Get all variation-to-offer assignments
 * - DELETE /offers/:offerId/variations/:variationId - Remove a variation
 *
 * OBSERVATION LOG:
 * - GET /variations/assignments has inline SQL (should be in variation-admin-service)
 * - DELETE handler has inline SQL UPDATE + audit log call (should be in variation-admin-service)
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
 * POST /api/loyalty/offers/:id/variations
 * Add qualifying variations to an offer
 * IMPORTANT: Only explicitly added variations qualify for the offer
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
 * Used by UI to show which variations are already assigned to offers
 */
router.get('/variations/assignments', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await db.query(`
        SELECT qv.variation_id, qv.item_name, qv.variation_name,
               o.id as offer_id, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_qualifying_variations qv
        JOIN loyalty_offers o ON qv.offer_id = o.id
        WHERE qv.merchant_id = $1
          AND qv.is_active = TRUE
          AND o.is_active = TRUE
        ORDER BY o.offer_name, qv.item_name
    `, [merchantId]);

    // Return as a map for easy lookup by variation_id
    const assignments = {};
    for (const row of result.rows) {
        assignments[row.variation_id] = {
            offerId: row.offer_id,
            offerName: row.offer_name,
            brandName: row.brand_name,
            sizeGroup: row.size_group
        };
    }

    res.json({ assignments });
}));

/**
 * DELETE /api/loyalty/offers/:offerId/variations/:variationId
 * Remove a qualifying variation from an offer
 */
router.delete('/offers/:offerId/variations/:variationId', requireAuth, requireMerchant, requireWriteAccess, validators.removeVariation, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerId, variationId } = req.params;

    const result = await db.query(`
        UPDATE loyalty_qualifying_variations
        SET is_active = FALSE, updated_at = NOW()
        WHERE offer_id = $1 AND variation_id = $2 AND merchant_id = $3
        RETURNING *
    `, [offerId, variationId, merchantId]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Variation not found in offer' });
    }

    await loyaltyService.logAuditEvent({
        merchantId,
        action: 'VARIATION_REMOVED',
        offerId,
        triggeredBy: 'ADMIN',
        userId: req.session.user.id,
        details: { variationId }
    });

    res.json({ success: true });
}));

module.exports = router;
