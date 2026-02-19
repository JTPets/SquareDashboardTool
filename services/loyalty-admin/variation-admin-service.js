/**
 * Loyalty Variation Admin Service
 *
 * Manages qualifying variations for loyalty offers.
 * Only explicitly configured variations qualify for offers - no wildcards.
 *
 * BUSINESS RULES:
 * - Each variation can only belong to one active offer
 * - Variations define which products qualify for a specific offer
 * - Removing a variation is a soft-delete (is_active = false)
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { getOfferById } = require('./offer-admin-service');
const {
    queryQualifyingVariations,
    queryOfferForVariation
} = require('./loyalty-queries');

/**
 * Check if variations are already assigned to other offers
 * @param {Array<string>} variationIds - Array of variation IDs to check
 * @param {number|null} excludeOfferId - Offer ID to exclude from check (for updates)
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Array>} Array of conflicts with offer details
 */
async function checkVariationConflicts(variationIds, excludeOfferId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for checkVariationConflicts - tenant isolation required');
    }

    if (!variationIds || variationIds.length === 0) {
        return [];
    }

    // Find variations that are already assigned to other active offers
    const placeholders = variationIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await db.query(`
        SELECT qv.variation_id, qv.item_name, qv.variation_name,
               o.id as offer_id, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_qualifying_variations qv
        JOIN loyalty_offers o ON qv.offer_id = o.id
        WHERE qv.variation_id IN (${placeholders})
          AND qv.merchant_id = $${variationIds.length + 1}
          AND qv.is_active = TRUE
          AND o.is_active = TRUE
          ${excludeOfferId ? `AND qv.offer_id != $${variationIds.length + 2}` : ''}
    `, excludeOfferId
        ? [...variationIds, merchantId, excludeOfferId]
        : [...variationIds, merchantId]
    );

    return result.rows;
}

/**
 * Add qualifying variations to an offer
 * IMPORTANT: Only explicitly configured variations qualify for the offer
 * @param {number} offerId - Offer ID
 * @param {Array<Object>} variations - Array of variation data
 * @param {string} variations[].variationId - Square variation ID
 * @param {string} [variations[].itemId] - Square item ID
 * @param {string} [variations[].itemName] - Item display name
 * @param {string} [variations[].variationName] - Variation display name
 * @param {string} [variations[].sku] - SKU
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @param {number} [userId] - User ID for audit
 * @param {Object} [options] - Additional options
 * @param {boolean} [options.force] - Skip conflict check (for migration/cleanup)
 * @returns {Promise<Array>} Array of added variation records
 */
async function addQualifyingVariations(offerId, variations, merchantId, userId = null, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for addQualifyingVariations - tenant isolation required');
    }

    const offer = await getOfferById(offerId, merchantId);
    if (!offer) {
        throw new Error('Offer not found or access denied');
    }

    logger.info('Adding qualifying variations to offer', {
        merchantId,
        offerId,
        variationCount: variations.length
    });

    // Check for conflicts unless force option is set
    if (!options.force) {
        const variationIds = variations.map(v => v.variationId).filter(Boolean);
        const conflicts = await checkVariationConflicts(variationIds, offerId, merchantId);

        if (conflicts.length > 0) {
            const conflictDetails = conflicts.map(c =>
                `"${c.item_name}${c.variation_name ? ' - ' + c.variation_name : ''}" is already in "${c.offer_name}"`
            ).join('; ');

            const error = new Error(`Variation conflict: ${conflictDetails}. Each variation can only belong to one offer.`);
            error.code = 'VARIATION_CONFLICT';
            error.conflicts = conflicts;
            throw error;
        }
    }

    const added = [];

    for (const variation of variations) {
        try {
            const result = await db.query(`
                INSERT INTO loyalty_qualifying_variations (
                    merchant_id, offer_id, variation_id, item_id,
                    item_name, variation_name, sku
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (merchant_id, offer_id, variation_id) DO UPDATE
                SET item_name = EXCLUDED.item_name,
                    variation_name = EXCLUDED.variation_name,
                    sku = EXCLUDED.sku,
                    is_active = TRUE,
                    updated_at = NOW()
                RETURNING *
            `, [
                merchantId,
                offerId,
                variation.variationId,
                variation.itemId,
                variation.itemName,
                variation.variationName,
                variation.sku
            ]);

            added.push(result.rows[0]);

            await logAuditEvent({
                merchantId,
                action: AuditActions.VARIATION_ADDED,
                offerId,
                triggeredBy: userId ? 'ADMIN' : 'SYSTEM',
                userId,
                details: { variationId: variation.variationId, variationName: variation.variationName }
            });
        } catch (error) {
            // Re-throw conflict errors
            if (error.code === 'VARIATION_CONFLICT') {
                throw error;
            }
            logger.error('Failed to add qualifying variation', {
                error: error.message,
                variationId: variation.variationId
            });
        }
    }

    return added;
}

/**
 * Get qualifying variations for an offer
 * @param {number} offerId - Offer ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Array>} Array of qualifying variations
 */
async function getQualifyingVariations(offerId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getQualifyingVariations - tenant isolation required');
    }

    return queryQualifyingVariations(offerId, merchantId);
}

/**
 * Check if a variation qualifies for any offer
 * @param {string} variationId - Square variation ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object|null>} Offer if variation qualifies, null otherwise
 */
async function getOfferForVariation(variationId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getOfferForVariation - tenant isolation required');
    }

    return queryOfferForVariation(variationId, merchantId);
}

/**
 * Remove a qualifying variation from an offer (soft delete)
 * @param {number} offerId - Offer ID
 * @param {string} variationId - Square variation ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @param {number} [userId] - User ID for audit
 * @returns {Promise<Object|null>} Removed variation or null if not found
 */
async function removeQualifyingVariation(offerId, variationId, merchantId, userId = null) {
    if (!merchantId) {
        throw new Error('merchantId is required for removeQualifyingVariation - tenant isolation required');
    }

    const result = await db.query(`
        UPDATE loyalty_qualifying_variations
        SET is_active = FALSE, updated_at = NOW()
        WHERE offer_id = $1 AND variation_id = $2 AND merchant_id = $3
        RETURNING *
    `, [offerId, variationId, merchantId]);

    if (result.rows.length === 0) {
        return null;
    }

    await logAuditEvent({
        merchantId,
        action: AuditActions.VARIATION_REMOVED,
        offerId,
        triggeredBy: userId ? 'ADMIN' : 'SYSTEM',
        userId,
        details: {
            variationId,
            variationName: result.rows[0].variation_name,
            itemName: result.rows[0].item_name
        }
    });

    return result.rows[0];
}

/**
 * Get all variation assignments for a merchant (for catalog mapping display)
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Object mapping variation_id to offer details
 */
async function getAllVariationAssignments(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getAllVariationAssignments - tenant isolation required');
    }

    const result = await db.query(`
        SELECT qv.variation_id, qv.item_name, qv.variation_name,
               o.id as offer_id, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_qualifying_variations qv
        JOIN loyalty_offers o ON qv.offer_id = o.id
        WHERE qv.merchant_id = $1
          AND qv.is_active = TRUE
          AND o.is_active = TRUE
        ORDER BY o.brand_name, o.size_group
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

    return assignments;
}

module.exports = {
    checkVariationConflicts,
    addQualifyingVariations,
    getQualifyingVariations,
    getOfferForVariation,
    removeQualifyingVariation,
    getAllVariationAssignments
};
