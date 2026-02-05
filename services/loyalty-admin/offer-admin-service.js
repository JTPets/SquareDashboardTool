/**
 * Loyalty Offer Admin Service
 *
 * Handles CRUD operations for loyalty offers (frequent buyer programs).
 * Each offer represents one brand + size group combination.
 *
 * BUSINESS RULES:
 * - One offer = one brand + one size group (never mix sizes)
 * - requiredQuantity defines purchases needed for reward
 * - windowMonths defines the rolling time window
 * - Vendor tracking for reimbursement compliance
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');

/**
 * Create a new loyalty offer (frequent buyer program)
 * @param {Object} offerData - Offer configuration
 * @param {number} offerData.merchantId - REQUIRED: Merchant ID
 * @param {string} offerData.offerName - Display name
 * @param {string} offerData.brandName - Brand name (must be unique with size group)
 * @param {string} offerData.sizeGroup - Size group identifier
 * @param {number} offerData.requiredQuantity - Number of purchases required
 * @param {number} [offerData.windowMonths=12] - Rolling window in months
 * @param {string} [offerData.description] - Offer description
 * @param {number} [offerData.vendorId] - Associated vendor ID
 * @param {number} [offerData.createdBy] - User ID who created the offer
 * @returns {Promise<Object>} Created offer
 */
async function createOffer(offerData) {
    const { merchantId, offerName, brandName, sizeGroup, requiredQuantity, windowMonths, description, vendorId, createdBy } = offerData;

    if (!merchantId) {
        throw new Error('merchantId is required for createOffer - tenant isolation required');
    }

    if (!brandName || !sizeGroup) {
        throw new Error('brandName and sizeGroup are required - one offer per brand + size group');
    }

    if (!requiredQuantity || requiredQuantity < 1) {
        throw new Error('requiredQuantity must be a positive integer');
    }

    logger.info('Creating loyalty offer', { merchantId, brandName, sizeGroup, requiredQuantity, vendorId });

    // If vendor_id provided, look up vendor details for caching
    let vendorName = null;
    let vendorEmail = null;
    if (vendorId) {
        const vendorResult = await db.query(
            'SELECT name, contact_email FROM vendors WHERE id = $1',
            [vendorId]
        );
        if (vendorResult.rows[0]) {
            vendorName = vendorResult.rows[0].name;
            vendorEmail = vendorResult.rows[0].contact_email;
        }
    }

    const result = await db.query(`
        INSERT INTO loyalty_offers (
            merchant_id, offer_name, brand_name, size_group,
            required_quantity, reward_quantity, window_months,
            description, vendor_id, vendor_name, vendor_email, created_by
        )
        VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11)
        RETURNING *
    `, [
        merchantId,
        offerName || `${brandName} ${sizeGroup} - Buy ${requiredQuantity} Get 1 Free`,
        brandName,
        sizeGroup,
        requiredQuantity,
        windowMonths || 12,
        description,
        vendorId || null,
        vendorName,
        vendorEmail,
        createdBy
    ]);

    const offer = result.rows[0];

    await logAuditEvent({
        merchantId,
        action: AuditActions.OFFER_CREATED,
        offerId: offer.id,
        triggeredBy: createdBy ? 'ADMIN' : 'SYSTEM',
        userId: createdBy,
        details: { brandName, sizeGroup, requiredQuantity, windowMonths }
    });

    return offer;
}

/**
 * Get all offers for a merchant
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @param {Object} [options] - Query options
 * @param {boolean} [options.activeOnly=false] - Only return active offers
 * @param {string} [options.brandName] - Filter by brand name
 * @returns {Promise<Array>} Array of offers with stats
 */
async function getOffers(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getOffers - tenant isolation required');
    }

    const { activeOnly = false, brandName = null } = options;

    let query = `
        SELECT o.*,
            (SELECT COUNT(*) FROM loyalty_qualifying_variations qv
             WHERE qv.offer_id = o.id AND qv.is_active = TRUE) as variation_count,
            (SELECT COUNT(*) FROM loyalty_rewards r
             WHERE r.offer_id = o.id AND r.status = 'earned') as pending_rewards,
            (SELECT COUNT(*) FROM loyalty_rewards r
             WHERE r.offer_id = o.id AND r.status = 'redeemed') as total_redeemed
        FROM loyalty_offers o
        WHERE o.merchant_id = $1
    `;
    const params = [merchantId];

    if (activeOnly) {
        query += ` AND o.is_active = TRUE`;
    }

    if (brandName) {
        query += ` AND o.brand_name = $${params.length + 1}`;
        params.push(brandName);
    }

    query += ` ORDER BY o.brand_name, o.size_group`;

    const result = await db.query(query, params);
    return result.rows;
}

/**
 * Get a single offer by ID
 * @param {number} offerId - Offer ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object|null>} Offer or null if not found
 */
async function getOfferById(offerId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getOfferById - tenant isolation required');
    }

    const result = await db.query(`
        SELECT * FROM loyalty_offers
        WHERE id = $1 AND merchant_id = $2
    `, [offerId, merchantId]);

    return result.rows[0] || null;
}

/**
 * Update an offer
 * @param {number} offerId - Offer ID
 * @param {Object} updates - Fields to update
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @param {number} [userId] - Admin user ID for audit
 * @returns {Promise<Object>} Updated offer
 */
async function updateOffer(offerId, updates, merchantId, userId = null) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateOffer - tenant isolation required');
    }

    // If vendor_id is being updated, look up vendor details
    if (updates.vendor_id !== undefined) {
        if (updates.vendor_id) {
            const vendorResult = await db.query(
                'SELECT name, contact_email FROM vendors WHERE id = $1',
                [updates.vendor_id]
            );
            if (vendorResult.rows[0]) {
                updates.vendor_name = vendorResult.rows[0].name;
                updates.vendor_email = vendorResult.rows[0].contact_email;
            }
        } else {
            // Clearing vendor
            updates.vendor_name = null;
            updates.vendor_email = null;
        }
    }

    const allowedFields = ['offer_name', 'description', 'is_active', 'window_months', 'vendor_id', 'vendor_name', 'vendor_email', 'size_group'];
    const setClause = [];
    const params = [offerId, merchantId];

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            params.push(value);
            setClause.push(`${key} = $${params.length}`);
        }
    }

    if (setClause.length === 0) {
        throw new Error('No valid fields to update');
    }

    setClause.push('updated_at = NOW()');

    const result = await db.query(`
        UPDATE loyalty_offers
        SET ${setClause.join(', ')}
        WHERE id = $1 AND merchant_id = $2
        RETURNING *
    `, params);

    if (result.rows.length === 0) {
        throw new Error('Offer not found or access denied');
    }

    await logAuditEvent({
        merchantId,
        action: updates.is_active === false ? AuditActions.OFFER_DEACTIVATED : AuditActions.OFFER_UPDATED,
        offerId,
        triggeredBy: userId ? 'ADMIN' : 'SYSTEM',
        userId,
        details: updates
    });

    return result.rows[0];
}

/**
 * Delete a loyalty offer
 * This will also remove all qualifying variations for the offer
 * Note: Does NOT delete historical rewards/redemptions for audit purposes
 * @param {number} offerId - Offer ID
 * @param {number} merchantId - REQUIRED: Merchant ID for tenant isolation
 * @param {number} [userId] - Admin user ID for audit
 * @returns {Promise<Object>} Deletion result
 */
async function deleteOffer(offerId, merchantId, userId = null) {
    if (!merchantId) {
        throw new Error('merchantId is required for deleteOffer - tenant isolation required');
    }

    // First verify the offer exists and belongs to this merchant
    const offerCheck = await db.query(`
        SELECT id, offer_name, brand_name, size_group
        FROM loyalty_offers
        WHERE id = $1 AND merchant_id = $2
    `, [offerId, merchantId]);

    if (offerCheck.rows.length === 0) {
        throw new Error('Offer not found or access denied');
    }

    const offer = offerCheck.rows[0];

    // Check for any in-progress or earned rewards
    const activeRewardsCheck = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE offer_id = $1 AND merchant_id = $2 AND status IN ('in_progress', 'earned')
    `, [offerId, merchantId]);

    const activeCount = parseInt(activeRewardsCheck.rows[0]?.count || 0);

    // Delete qualifying variations first (foreign key constraint)
    await db.query(`
        DELETE FROM loyalty_qualifying_variations
        WHERE offer_id = $1 AND merchant_id = $2
    `, [offerId, merchantId]);

    // Delete the offer
    await db.query(`
        DELETE FROM loyalty_offers
        WHERE id = $1 AND merchant_id = $2
    `, [offerId, merchantId]);

    // Log audit event
    await logAuditEvent({
        merchantId,
        action: AuditActions.OFFER_DELETED,
        offerId,
        triggeredBy: userId ? 'ADMIN' : 'SYSTEM',
        userId,
        details: {
            deletedOffer: offer.offer_name,
            brandName: offer.brand_name,
            sizeGroup: offer.size_group,
            hadActiveRewards: activeCount > 0,
            activeRewardsCount: activeCount
        }
    });

    return {
        deleted: true,
        offerName: offer.offer_name,
        hadActiveRewards: activeCount > 0,
        activeRewardsCount: activeCount
    };
}

module.exports = {
    createOffer,
    getOffers,
    getOfferById,
    updateOffer,
    deleteOffer
};
