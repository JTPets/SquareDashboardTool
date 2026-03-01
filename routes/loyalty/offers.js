/**
 * Loyalty Offer Management Routes
 *
 * CRUD operations for loyalty offers (frequent buyer programs):
 * - GET /offers - List all offers
 * - POST /offers - Create a new offer
 * - GET /offers/:id - Get a single offer with details
 * - PATCH /offers/:id - Update an offer
 * - DELETE /offers/:id - Delete an offer
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
 * GET /api/loyalty/offers
 * List all loyalty offers for the merchant
 */
router.get('/offers', requireAuth, requireMerchant, validators.listOffers, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { activeOnly, brandName } = req.query;

    const offers = await loyaltyService.getOffers(merchantId, {
        activeOnly: activeOnly === 'true',
        brandName
    });

    res.json({ offers });
}));

/**
 * POST /api/loyalty/offers
 * Create a new loyalty offer (frequent buyer program)
 * Requires admin role
 */
router.post('/offers', requireAuth, requireMerchant, requireWriteAccess, validators.createOffer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerName, brandName, sizeGroup, requiredQuantity, windowMonths, description, vendorId } = req.body;

    const offer = await loyaltyService.createOffer({
        merchantId,
        offerName,
        brandName,
        sizeGroup,
        requiredQuantity: parseInt(requiredQuantity),
        windowMonths: windowMonths ? parseInt(windowMonths) : 12,
        description,
        vendorId: vendorId || null,
        createdBy: req.session.user.id
    });

    logger.info('Created loyalty offer', {
        offerId: offer.id,
        brandName,
        sizeGroup,
        merchantId
    });

    res.status(201).json({ offer });
}));

/**
 * GET /api/loyalty/offers/:id
 * Get a single loyalty offer with details
 */
router.get('/offers/:id', requireAuth, requireMerchant, validators.getOffer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const offer = await loyaltyService.getOfferById(req.params.id, merchantId);

    if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
    }

    // Get qualifying variations
    const variations = await loyaltyService.getQualifyingVariations(req.params.id, merchantId);

    res.json({ offer, variations });
}));

/**
 * PATCH /api/loyalty/offers/:id
 * Update a loyalty offer
 * Note: requiredQuantity cannot be changed to preserve integrity
 */
router.patch('/offers/:id', requireAuth, requireMerchant, requireWriteAccess, validators.updateOffer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offer_name, description, is_active, window_months, vendor_id, size_group } = req.body;

    const updates = {};
    if (offer_name !== undefined) updates.offer_name = offer_name;
    if (description !== undefined) updates.description = description;
    if (is_active !== undefined) updates.is_active = is_active;
    if (window_months !== undefined && window_months > 0) updates.window_months = parseInt(window_months);
    if (vendor_id !== undefined) updates.vendor_id = vendor_id || null;
    if (size_group !== undefined && size_group.trim()) updates.size_group = size_group.trim();

    const offer = await loyaltyService.updateOffer(
        req.params.id,
        updates,
        merchantId,
        req.session.user.id
    );

    res.json({ offer });
}));

/**
 * DELETE /api/loyalty/offers/:id
 * Delete a loyalty offer (discontinued by vendor)
 * Note: Historical rewards/redemptions are preserved for audit
 */
router.delete('/offers/:id', requireAuth, requireMerchant, requireWriteAccess, validators.deleteOffer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await loyaltyService.deleteOffer(
        req.params.id,
        merchantId,
        req.session.user.id
    );

    logger.info('Deleted loyalty offer', {
        offerId: req.params.id,
        offerName: result.offerName,
        hadActiveRewards: result.hadActiveRewards,
        merchantId
    });

    res.json(result);
}));

module.exports = router;
