/**
 * Square Loyalty Addon - Frequent Buyer Program Service
 *
 * Implements vendor-defined frequent buyer programs (Astro-style loyalty)
 * where customers earn free items after purchasing a defined quantity.
 *
 * BUSINESS RULES (NON-NEGOTIABLE - Required for vendor reimbursement compliance):
 * - One loyalty offer = one brand + one size group
 * - Qualifying purchases must match EXPLICIT variation IDs
 * - NEVER mix sizes to earn or redeem
 * - Rolling time window from first qualifying purchase
 * - Full redemption only (no partials, no substitutions)
 * - Reward is ALWAYS 1 free unit of same size group
 * - Refunds ALWAYS adjust quantities and may revoke earned rewards
 *
 * TODO (vNext):
 * - Buy X Save Y% instantly (promo-compatible discounting)
 * - Pre-checkout POS reward prompts (if Square allows)
 */

const db = require('./database');
const logger = require('./logger');
const { decryptToken, isEncryptedToken } = require('./token-encryption');

// Lazy-load square-api to avoid circular dependency
let squareApi = null;
function getSquareApi() {
    if (!squareApi) {
        squareApi = require('./square-api');
    }
    return squareApi;
}

/**
 * Pre-fetch all recent loyalty ACCUMULATE_POINTS events for batch processing
 * This avoids making individual API calls per order during backfill
 *
 * @param {number} merchantId - Internal merchant ID
 * @param {number} days - Number of days to look back (default 7)
 * @returns {Promise<Object>} Object with events array and lookup maps
 */
async function prefetchRecentLoyaltyEvents(merchantId, days = 7) {
    try {
        // Get merchant's access token
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );

        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return { events: [], byOrderId: {}, byTimestamp: [], loyaltyAccounts: {} };
        }

        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        // Calculate date range for filtering
        const beginTime = new Date();
        beginTime.setDate(beginTime.getDate() - days);

        const allEvents = [];
        let cursor = null;

        // Fetch all ACCUMULATE_POINTS events (paginated)
        do {
            const requestBody = {
                query: {
                    filter: {
                        type_filter: {
                            types: ['ACCUMULATE_POINTS']
                        },
                        date_time_filter: {
                            created_at: {
                                start_at: beginTime.toISOString()
                            }
                        }
                    }
                },
                limit: 30
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const response = await fetch('https://connect.squareup.com/v2/loyalty/events/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2024-01-18'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                logger.error('Failed to fetch loyalty events', { status: response.status });
                break;
            }

            const data = await response.json();
            const events = data.events || [];
            allEvents.push(...events);
            cursor = data.cursor;

        } while (cursor);

        logger.info('Prefetched loyalty events', { merchantId, eventCount: allEvents.length, days });

        // Build lookup maps for fast matching
        const byOrderId = {};
        const byTimestamp = [];
        const loyaltyAccountIds = new Set();

        for (const event of allEvents) {
            // Map by order_id if present
            if (event.order_id) {
                byOrderId[event.order_id] = event;
            }

            // Store for timestamp matching
            byTimestamp.push({
                loyaltyAccountId: event.loyalty_account_id,
                createdAt: new Date(event.created_at).getTime(),
                orderId: event.order_id
            });

            loyaltyAccountIds.add(event.loyalty_account_id);
        }

        // Fetch all loyalty accounts to get customer IDs
        const loyaltyAccounts = {};
        for (const accountId of loyaltyAccountIds) {
            try {
                const accountResponse = await fetch(`https://connect.squareup.com/v2/loyalty/accounts/${accountId}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': '2024-01-18'
                    }
                });

                if (accountResponse.ok) {
                    const accountData = await accountResponse.json();
                    if (accountData.loyalty_account?.customer_id) {
                        loyaltyAccounts[accountId] = accountData.loyalty_account.customer_id;
                    }
                }
            } catch (err) {
                logger.warn('Failed to fetch loyalty account', { accountId, error: err.message });
            }
        }

        logger.info('Prefetched loyalty accounts', { merchantId, accountCount: Object.keys(loyaltyAccounts).length });

        return {
            events: allEvents,
            byOrderId,
            byTimestamp,
            loyaltyAccounts
        };

    } catch (error) {
        logger.error('Error prefetching loyalty events', { error: error.message, merchantId });
        return { events: [], byOrderId: {}, byTimestamp: [], loyaltyAccounts: {} };
    }
}

/**
 * Find customer_id from prefetched loyalty events
 * Uses in-memory lookup instead of API calls
 *
 * IMPORTANT: Only uses reliable order_id lookup.
 * Timestamp matching was removed as it could misattribute purchases.
 *
 * @param {string} orderId - Square order ID
 * @param {Object} prefetchedData - Data from prefetchRecentLoyaltyEvents
 * @returns {string|null} customer_id if found, null otherwise
 */
function findCustomerFromPrefetchedEvents(orderId, prefetchedData) {
    const { byOrderId, loyaltyAccounts } = prefetchedData;

    // Direct lookup by order_id (RELIABLE)
    if (byOrderId[orderId]) {
        const event = byOrderId[orderId];
        const customerId = loyaltyAccounts[event.loyalty_account_id];
        if (customerId) {
            logger.debug('Found customer by order_id in prefetched data', { orderId, customerId });
            return customerId;
        }
    }

    // NOTE: Timestamp matching was intentionally removed.
    // It could match the wrong customer if multiple people checked in
    // around the same time. Better to miss a purchase than misattribute it.

    return null;
}

/**
 * Fetch customer details from Square's Customers API
 * Resolves a customer_id into actual customer info (name, phone, email)
 *
 * @param {string} customerId - Square customer ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object|null>} Customer details or null
 */
async function getCustomerDetails(customerId, merchantId) {
    if (!customerId || !merchantId) {
        return null;
    }

    try {
        // Get merchant's access token
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );

        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return null;
        }

        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        const response = await fetch(`https://connect.squareup.com/v2/customers/${customerId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            }
        });

        if (!response.ok) {
            logger.debug('Failed to fetch customer details', { customerId, status: response.status });
            return null;
        }

        const data = await response.json();
        const customer = data.customer;

        if (!customer) {
            return null;
        }

        return {
            id: customer.id,
            givenName: customer.given_name || null,
            familyName: customer.family_name || null,
            displayName: [customer.given_name, customer.family_name].filter(Boolean).join(' ') || null,
            email: customer.email_address || null,
            phone: customer.phone_number || null,
            createdAt: customer.created_at,
            updatedAt: customer.updated_at
        };

    } catch (error) {
        logger.error('Error fetching customer details', { error: error.message, customerId });
        return null;
    }
}

/**
 * Try to find customer_id for an order via Square's Loyalty API
 * When an order doesn't have customer_id directly, the customer may have
 * used their phone number for Square's loyalty program, which links to a customer account.
 *
 * IMPORTANT: This function only uses reliable identifiers (order_id).
 * Timestamp-based matching was REMOVED because it could incorrectly
 * attribute purchases to the wrong customer if multiple customers
 * checked in around the same time.
 *
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<string|null>} customer_id if found, null otherwise
 */
async function lookupCustomerFromLoyalty(orderId, merchantId) {
    try {
        // Get merchant's access token
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );

        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return null;
        }

        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        // Search for loyalty events by order_id (RELIABLE - direct link)
        const eventsResponse = await fetch('https://connect.squareup.com/v2/loyalty/events/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
                query: {
                    filter: {
                        order_filter: {
                            order_id: orderId
                        }
                    }
                },
                limit: 10
            })
        });

        let loyaltyAccountId = null;

        if (eventsResponse.ok) {
            const eventsData = await eventsResponse.json();
            const events = eventsData.events || [];

            if (events.length > 0) {
                loyaltyAccountId = events[0].loyalty_account_id;
                logger.debug('Found loyalty event by order_id', { orderId, loyaltyAccountId });
            }
        }

        // NOTE: Timestamp-based matching was intentionally removed.
        // It could match the wrong customer if multiple people checked in
        // around the same time. Better to miss a purchase than misattribute it.

        if (!loyaltyAccountId) {
            logger.debug('No loyalty events found for order', { orderId });
            return null;
        }

        // Fetch the loyalty account to get the customer_id
        const accountResponse = await fetch(`https://connect.squareup.com/v2/loyalty/accounts/${loyaltyAccountId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            }
        });

        if (!accountResponse.ok) {
            logger.debug('Failed to fetch loyalty account', { loyaltyAccountId });
            return null;
        }

        const accountData = await accountResponse.json();
        const customerId = accountData.loyalty_account?.customer_id;

        if (customerId) {
            logger.info('Found customer via loyalty lookup', {
                orderId,
                loyaltyAccountId,
                customerId
            });
        }

        return customerId || null;

    } catch (error) {
        logger.error('Error in loyalty customer lookup', {
            error: error.message,
            orderId,
            merchantId
        });
        return null;
    }
}

// ============================================================================
// REWARD STATE MACHINE CONSTANTS
// ============================================================================
const RewardStatus = {
    IN_PROGRESS: 'in_progress',
    EARNED: 'earned',
    REDEEMED: 'redeemed',
    REVOKED: 'revoked'
};

const AuditActions = {
    OFFER_CREATED: 'OFFER_CREATED',
    OFFER_UPDATED: 'OFFER_UPDATED',
    OFFER_DEACTIVATED: 'OFFER_DEACTIVATED',
    VARIATION_ADDED: 'VARIATION_ADDED',
    VARIATION_REMOVED: 'VARIATION_REMOVED',
    PURCHASE_RECORDED: 'PURCHASE_RECORDED',
    REFUND_PROCESSED: 'REFUND_PROCESSED',
    WINDOW_EXPIRED: 'WINDOW_EXPIRED',
    REWARD_PROGRESS_UPDATED: 'REWARD_PROGRESS_UPDATED',
    REWARD_EARNED: 'REWARD_EARNED',
    REWARD_REDEEMED: 'REWARD_REDEEMED',
    REWARD_REVOKED: 'REWARD_REVOKED',
    MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT'
};

const RedemptionTypes = {
    ORDER_DISCOUNT: 'order_discount',
    MANUAL_ADMIN: 'manual_admin',
    AUTO_DETECTED: 'auto_detected'
};

// ============================================================================
// AUDIT LOGGING - All actions must be auditable
// ============================================================================

/**
 * Log an audit event for loyalty operations
 * @param {Object} event - Audit event details
 * @param {number} event.merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 */
async function logAuditEvent(event) {
    if (!event.merchantId) {
        throw new Error('merchantId is required for logAuditEvent - tenant isolation required');
    }

    try {
        await db.query(`
            INSERT INTO loyalty_audit_logs (
                merchant_id, action, offer_id, reward_id, purchase_event_id, redemption_id,
                square_customer_id, square_order_id, old_state, new_state,
                old_quantity, new_quantity, triggered_by, user_id, details
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
            event.merchantId,
            event.action,
            event.offerId || null,
            event.rewardId || null,
            event.purchaseEventId || null,
            event.redemptionId || null,
            event.squareCustomerId || null,
            event.squareOrderId || null,
            event.oldState || null,
            event.newState || null,
            event.oldQuantity || null,
            event.newQuantity || null,
            event.triggeredBy || 'SYSTEM',
            event.userId || null,
            event.details ? JSON.stringify(event.details) : null
        ]);
    } catch (error) {
        logger.error('Failed to log loyalty audit event', {
            error: error.message,
            action: event.action,
            merchantId: event.merchantId
        });
        // Don't throw - audit logging should not break main operations
    }
}

// ============================================================================
// SETTINGS MANAGEMENT
// ============================================================================

/**
 * Get a loyalty setting value
 * @param {string} key - Setting key
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<string|null>} Setting value
 */
async function getSetting(key, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getSetting - tenant isolation required');
    }

    const result = await db.query(`
        SELECT setting_value FROM loyalty_settings
        WHERE merchant_id = $1 AND setting_key = $2
    `, [merchantId, key]);

    return result.rows[0]?.setting_value || null;
}

/**
 * Update a loyalty setting value
 * @param {string} key - Setting key
 * @param {string} value - Setting value
 * @param {number} merchantId - REQUIRED: Merchant ID
 */
async function updateSetting(key, value, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateSetting - tenant isolation required');
    }

    await db.query(`
        INSERT INTO loyalty_settings (merchant_id, setting_key, setting_value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (merchant_id, setting_key) DO UPDATE
        SET setting_value = $3, updated_at = NOW()
    `, [merchantId, key, value]);
}

/**
 * Initialize default settings for a merchant
 * @param {number} merchantId - REQUIRED: Merchant ID
 */
async function initializeDefaultSettings(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for initializeDefaultSettings');
    }

    const defaults = [
        { key: 'auto_detect_redemptions', value: 'true', desc: 'Automatically detect redemptions from orders' },
        { key: 'send_receipt_messages', value: 'true', desc: 'Send reward messages via Square receipts' },
        { key: 'loyalty_enabled', value: 'true', desc: 'Master switch for loyalty processing' }
    ];

    for (const setting of defaults) {
        await db.query(`
            INSERT INTO loyalty_settings (merchant_id, setting_key, setting_value, description)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (merchant_id, setting_key) DO NOTHING
        `, [merchantId, setting.key, setting.value, setting.desc]);
    }
}

// ============================================================================
// OFFER MANAGEMENT
// ============================================================================

/**
 * Create a new loyalty offer (frequent buyer program)
 * @param {Object} offerData - Offer configuration
 * @param {number} offerData.merchantId - REQUIRED: Merchant ID
 * @param {string} offerData.offerName - Display name
 * @param {string} offerData.brandName - Brand name (must be unique with size group)
 * @param {string} offerData.sizeGroup - Size group identifier
 * @param {number} offerData.requiredQuantity - Number of purchases required
 * @param {number} offerData.windowMonths - Rolling window in months
 * @param {number} [offerData.createdBy] - User ID who created the offer
 * @returns {Promise<Object>} Created offer
 */
async function createOffer(offerData) {
    const { merchantId, offerName, brandName, sizeGroup, requiredQuantity, windowMonths, description, createdBy } = offerData;

    if (!merchantId) {
        throw new Error('merchantId is required for createOffer - tenant isolation required');
    }

    if (!brandName || !sizeGroup) {
        throw new Error('brandName and sizeGroup are required - one offer per brand + size group');
    }

    if (!requiredQuantity || requiredQuantity < 1) {
        throw new Error('requiredQuantity must be a positive integer');
    }

    logger.info('Creating loyalty offer', { merchantId, brandName, sizeGroup, requiredQuantity });

    const result = await db.query(`
        INSERT INTO loyalty_offers (
            merchant_id, offer_name, brand_name, size_group,
            required_quantity, reward_quantity, window_months,
            description, created_by
        )
        VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
        RETURNING *
    `, [
        merchantId,
        offerName || `${brandName} ${sizeGroup} - Buy ${requiredQuantity} Get 1 Free`,
        brandName,
        sizeGroup,
        requiredQuantity,
        windowMonths || 12,
        description,
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
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Array of offers
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
 * @param {string} offerId - Offer UUID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object|null>} Offer or null
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
 * @param {string} offerId - Offer UUID
 * @param {Object} updates - Fields to update
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Updated offer
 */
async function updateOffer(offerId, updates, merchantId, userId = null) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateOffer - tenant isolation required');
    }

    const allowedFields = ['offer_name', 'description', 'is_active'];
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
 * @param {string} offerId - Offer UUID
 * @param {number} merchantId - REQUIRED: Merchant ID for tenant isolation
 * @param {string} userId - Admin user ID for audit
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

    const activeCount = parseInt(activeRewardsCheck.rows[0].count);

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
        action: AuditActions.OFFER_DELETED || 'OFFER_DELETED',
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

// ============================================================================
// QUALIFYING VARIATIONS MANAGEMENT
// ============================================================================

/**
 * Add qualifying variations to an offer
 * IMPORTANT: Only explicitly configured variations qualify for the offer
 * @param {string} offerId - Offer UUID
 * @param {Array<Object>} variations - Array of variation data
 * @param {number} merchantId - REQUIRED: Merchant ID
 */
async function addQualifyingVariations(offerId, variations, merchantId, userId = null) {
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
 * @param {string} offerId - Offer UUID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Array>} Array of qualifying variations
 */
async function getQualifyingVariations(offerId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getQualifyingVariations - tenant isolation required');
    }

    const result = await db.query(`
        SELECT * FROM loyalty_qualifying_variations
        WHERE offer_id = $1 AND merchant_id = $2 AND is_active = TRUE
        ORDER BY item_name, variation_name
    `, [offerId, merchantId]);

    return result.rows;
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

    const result = await db.query(`
        SELECT o.*, qv.variation_id
        FROM loyalty_offers o
        JOIN loyalty_qualifying_variations qv ON o.id = qv.offer_id
        WHERE qv.variation_id = $1
          AND qv.merchant_id = $2
          AND qv.is_active = TRUE
          AND o.is_active = TRUE
    `, [variationId, merchantId]);

    return result.rows[0] || null;
}

// ============================================================================
// PURCHASE PROCESSING - Core loyalty earning logic
// ============================================================================

/**
 * Process a qualifying purchase from an order
 * This is the main entry point for recording purchases from webhooks
 *
 * BUSINESS RULES:
 * - Only explicitly configured variations qualify
 * - Never mix sizes within an offer
 * - Rolling window from first qualifying purchase
 * - Purchases outside window drop off automatically
 *
 * @param {Object} purchaseData - Purchase details
 * @param {number} purchaseData.merchantId - REQUIRED: Merchant ID
 * @param {string} purchaseData.squareOrderId - Square order ID
 * @param {string} purchaseData.squareCustomerId - Square customer ID
 * @param {string} purchaseData.variationId - Square variation ID
 * @param {number} purchaseData.quantity - Quantity purchased
 * @param {number} [purchaseData.unitPriceCents] - Unit price for audit
 * @param {Date} purchaseData.purchasedAt - Purchase timestamp
 * @param {string} [purchaseData.squareLocationId] - Square location ID
 * @param {string} [purchaseData.receiptUrl] - Square receipt URL from tender
 * @returns {Promise<Object>} Processing result
 */
async function processQualifyingPurchase(purchaseData) {
    const {
        merchantId, squareOrderId, squareCustomerId, variationId,
        quantity, unitPriceCents, purchasedAt, squareLocationId, receiptUrl
    } = purchaseData;

    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    if (!squareCustomerId) {
        logger.debug('Skipping loyalty processing - no customer ID', { squareOrderId });
        return { processed: false, reason: 'no_customer' };
    }

    // Check if variation qualifies for any offer (tenant-scoped)
    const offer = await getOfferForVariation(variationId, merchantId);
    if (!offer) {
        logger.debug('Variation does not qualify for any offer', { variationId, merchantId });
        return { processed: false, reason: 'variation_not_qualifying' };
    }

    // Generate idempotency key to prevent duplicate processing
    const idempotencyKey = `${squareOrderId}:${variationId}:${quantity}`;

    // Check for existing event (idempotency)
    const existingEvent = await db.query(`
        SELECT id FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND idempotency_key = $2
    `, [merchantId, idempotencyKey]);

    if (existingEvent.rows.length > 0) {
        logger.debug('Purchase event already processed (idempotent)', { idempotencyKey });
        return { processed: false, reason: 'already_processed' };
    }

    logger.info('Processing qualifying purchase', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity,
        offerId: offer.id,
        offerName: offer.offer_name
    });

    // Begin transaction for consistency
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Calculate window dates
        const purchaseDate = new Date(purchasedAt);
        const windowEndDate = new Date(purchaseDate);
        windowEndDate.setMonth(windowEndDate.getMonth() + offer.window_months);

        // Get or determine window start date for this customer+offer
        const existingPurchases = await client.query(`
            SELECT MIN(purchased_at) as first_purchase
            FROM loyalty_purchase_events
            WHERE merchant_id = $1
              AND offer_id = $2
              AND square_customer_id = $3
              AND window_end_date >= CURRENT_DATE
              AND quantity > 0
        `, [merchantId, offer.id, squareCustomerId]);

        let windowStartDate = purchaseDate;
        if (existingPurchases.rows[0]?.first_purchase) {
            windowStartDate = new Date(existingPurchases.rows[0].first_purchase);
        }

        // Record the purchase event
        const eventResult = await client.query(`
            INSERT INTO loyalty_purchase_events (
                merchant_id, offer_id, square_customer_id, square_order_id,
                square_location_id, variation_id, quantity, unit_price_cents,
                purchased_at, window_start_date, window_end_date,
                is_refund, idempotency_key, receipt_url
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
        `, [
            merchantId, offer.id, squareCustomerId, squareOrderId,
            squareLocationId, variationId, quantity, unitPriceCents,
            purchasedAt, windowStartDate.toISOString().split('T')[0],
            windowEndDate.toISOString().split('T')[0],
            false, idempotencyKey, receiptUrl || null
        ]);

        const purchaseEvent = eventResult.rows[0];

        await logAuditEvent({
            merchantId,
            action: AuditActions.PURCHASE_RECORDED,
            offerId: offer.id,
            purchaseEventId: purchaseEvent.id,
            squareCustomerId,
            squareOrderId,
            newQuantity: quantity,
            triggeredBy: 'WEBHOOK',
            details: { variationId, unitPriceCents }
        });

        // Update reward progress
        const rewardResult = await updateRewardProgress(client, {
            merchantId,
            offerId: offer.id,
            squareCustomerId,
            offer
        });

        await client.query('COMMIT');

        logger.info('Purchase processed successfully', {
            merchantId,
            purchaseEventId: purchaseEvent.id,
            rewardStatus: rewardResult.status,
            currentQuantity: rewardResult.currentQuantity
        });

        return {
            processed: true,
            purchaseEvent,
            reward: rewardResult
        };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Failed to process qualifying purchase', {
            error: error.message,
            stack: error.stack,
            merchantId,
            squareOrderId
        });
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Update reward progress for a customer+offer after a purchase or refund
 * Implements the rolling window logic and state machine
 *
 * @param {Object} client - Database client (for transaction)
 * @param {Object} data - Update data
 */
async function updateRewardProgress(client, data) {
    const { merchantId, offerId, squareCustomerId, offer } = data;

    // Calculate current qualifying quantity within the rolling window
    // Only count purchases that haven't been locked into an earned reward
    // and are still within their window
    const quantityResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) as total_quantity
        FROM loyalty_purchase_events
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND window_end_date >= CURRENT_DATE
          AND reward_id IS NULL
    `, [merchantId, offerId, squareCustomerId]);

    const currentQuantity = parseInt(quantityResult.rows[0].total_quantity) || 0;

    // Get or create the in_progress reward
    let rewardResult = await client.query(`
        SELECT * FROM loyalty_rewards
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND status = 'in_progress'
        FOR UPDATE
    `, [merchantId, offerId, squareCustomerId]);

    let reward = rewardResult.rows[0];

    if (!reward && currentQuantity > 0) {
        // Create new in_progress reward
        const windowResult = await client.query(`
            SELECT MIN(window_start_date) as start_date, MAX(window_end_date) as end_date
            FROM loyalty_purchase_events
            WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
              AND window_end_date >= CURRENT_DATE AND reward_id IS NULL
        `, [merchantId, offerId, squareCustomerId]);

        const { start_date, end_date } = windowResult.rows[0];

        const newRewardResult = await client.query(`
            INSERT INTO loyalty_rewards (
                merchant_id, offer_id, square_customer_id, status,
                current_quantity, required_quantity,
                window_start_date, window_end_date
            )
            VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $7)
            RETURNING *
        `, [
            merchantId, offerId, squareCustomerId,
            currentQuantity, offer.required_quantity,
            start_date, end_date
        ]);

        reward = newRewardResult.rows[0];
    } else if (reward) {
        // Update existing reward
        const oldQuantity = reward.current_quantity;

        await client.query(`
            UPDATE loyalty_rewards
            SET current_quantity = $1, updated_at = NOW()
            WHERE id = $2
        `, [currentQuantity, reward.id]);

        reward.current_quantity = currentQuantity;

        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_PROGRESS_UPDATED,
            offerId,
            rewardId: reward.id,
            squareCustomerId,
            oldQuantity,
            newQuantity: currentQuantity,
            triggeredBy: 'SYSTEM'
        });
    }

    // Check if reward has been earned
    if (reward && currentQuantity >= offer.required_quantity && reward.status === 'in_progress') {
        // Lock the contributing purchases to this reward
        // PostgreSQL requires a subquery for UPDATE with ORDER BY and LIMIT
        await client.query(`
            UPDATE loyalty_purchase_events
            SET reward_id = $1, updated_at = NOW()
            WHERE id IN (
                SELECT id FROM loyalty_purchase_events
                WHERE merchant_id = $2
                  AND offer_id = $3
                  AND square_customer_id = $4
                  AND window_end_date >= CURRENT_DATE
                  AND reward_id IS NULL
                ORDER BY purchased_at ASC
                LIMIT $5
            )
        `, [reward.id, merchantId, offerId, squareCustomerId, offer.required_quantity]);

        // Transition reward to earned status
        await client.query(`
            UPDATE loyalty_rewards
            SET status = 'earned', earned_at = NOW(), updated_at = NOW()
            WHERE id = $1
        `, [reward.id]);

        reward.status = RewardStatus.EARNED;

        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_EARNED,
            offerId,
            rewardId: reward.id,
            squareCustomerId,
            oldState: RewardStatus.IN_PROGRESS,
            newState: RewardStatus.EARNED,
            details: { requiredQuantity: offer.required_quantity }
        });

        logger.info('Reward earned!', {
            merchantId,
            rewardId: reward.id,
            squareCustomerId,
            offerName: offer.offer_name
        });

        // Try to create a Square Loyalty reward (non-blocking)
        // This makes the reward visible in Square POS for the cashier
        setImmediate(async () => {
            try {
                const squareResult = await createSquareLoyaltyReward({
                    merchantId,
                    squareCustomerId,
                    internalRewardId: reward.id,
                    offerId
                });
                if (squareResult.success) {
                    logger.info('Square Loyalty reward created for earned reward', {
                        merchantId,
                        rewardId: reward.id,
                        squareRewardId: squareResult.squareRewardId
                    });
                } else {
                    logger.warn('Could not create Square Loyalty reward', {
                        merchantId,
                        rewardId: reward.id,
                        reason: squareResult.error
                    });
                }
            } catch (err) {
                logger.error('Error creating Square Loyalty reward', {
                    error: err.message,
                    merchantId,
                    rewardId: reward.id
                });
            }
        });
    }

    // Update customer summary
    await updateCustomerSummary(client, merchantId, squareCustomerId, offerId);

    return {
        rewardId: reward?.id,
        status: reward?.status || 'no_progress',
        currentQuantity,
        requiredQuantity: offer.required_quantity
    };
}

// ============================================================================
// REFUND PROCESSING - Adjusts quantities and may revoke rewards
// ============================================================================

/**
 * Process a refund that affects loyalty purchases
 * BUSINESS RULE: Refunds ALWAYS adjust quantities immediately
 * If a refund causes an earned reward to become invalid, the reward is REVOKED
 *
 * @param {Object} refundData - Refund details
 */
async function processRefund(refundData) {
    const {
        merchantId, squareOrderId, squareCustomerId, variationId,
        quantity, unitPriceCents, refundedAt, squareLocationId, originalEventId
    } = refundData;

    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    // Check if variation qualifies for any offer
    const offer = await getOfferForVariation(variationId, merchantId);
    if (!offer) {
        return { processed: false, reason: 'variation_not_qualifying' };
    }

    const refundQuantity = Math.abs(quantity) * -1;  // Ensure negative
    const idempotencyKey = `refund:${squareOrderId}:${variationId}:${quantity}:${Date.now()}`;

    logger.info('Processing loyalty refund', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        refundQuantity,
        offerId: offer.id
    });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Calculate window dates based on original purchase
        const refundDate = new Date(refundedAt || Date.now());
        const windowEndDate = new Date(refundDate);
        windowEndDate.setMonth(windowEndDate.getMonth() + offer.window_months);

        // Record the refund event
        const eventResult = await client.query(`
            INSERT INTO loyalty_purchase_events (
                merchant_id, offer_id, square_customer_id, square_order_id,
                square_location_id, variation_id, quantity, unit_price_cents,
                purchased_at, window_start_date, window_end_date,
                is_refund, original_event_id, idempotency_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, $13)
            RETURNING *
        `, [
            merchantId, offer.id, squareCustomerId, squareOrderId,
            squareLocationId, variationId, refundQuantity, unitPriceCents,
            refundedAt || new Date(), refundDate.toISOString().split('T')[0],
            windowEndDate.toISOString().split('T')[0], originalEventId, idempotencyKey
        ]);

        const refundEvent = eventResult.rows[0];

        await logAuditEvent({
            merchantId,
            action: AuditActions.REFUND_PROCESSED,
            offerId: offer.id,
            purchaseEventId: refundEvent.id,
            squareCustomerId,
            squareOrderId,
            newQuantity: refundQuantity,
            triggeredBy: 'WEBHOOK',
            details: { variationId, originalEventId }
        });

        // Check if this refund affects an earned reward
        const earnedReward = await client.query(`
            SELECT r.*
            FROM loyalty_rewards r
            WHERE r.merchant_id = $1
              AND r.offer_id = $2
              AND r.square_customer_id = $3
              AND r.status = 'earned'
            FOR UPDATE
        `, [merchantId, offer.id, squareCustomerId]);

        if (earnedReward.rows.length > 0) {
            const reward = earnedReward.rows[0];

            // Calculate remaining locked purchases after refund
            const lockedQuantity = await client.query(`
                SELECT COALESCE(SUM(quantity), 0) as total
                FROM loyalty_purchase_events
                WHERE reward_id = $1
            `, [reward.id]);

            const remainingQuantity = parseInt(lockedQuantity.rows[0].total) || 0;

            // If refund causes reward to be invalid, revoke it
            if (remainingQuantity < offer.required_quantity) {
                await client.query(`
                    UPDATE loyalty_rewards
                    SET status = 'revoked',
                        revoked_at = NOW(),
                        revocation_reason = 'Refund reduced qualifying quantity below threshold',
                        updated_at = NOW()
                    WHERE id = $1
                `, [reward.id]);

                // Unlock the purchase events
                await client.query(`
                    UPDATE loyalty_purchase_events
                    SET reward_id = NULL, updated_at = NOW()
                    WHERE reward_id = $1
                `, [reward.id]);

                await logAuditEvent({
                    merchantId,
                    action: AuditActions.REWARD_REVOKED,
                    offerId: offer.id,
                    rewardId: reward.id,
                    squareCustomerId,
                    oldState: RewardStatus.EARNED,
                    newState: RewardStatus.REVOKED,
                    details: {
                        reason: 'refund',
                        remainingQuantity,
                        requiredQuantity: offer.required_quantity
                    }
                });

                logger.warn('Earned reward revoked due to refund', {
                    merchantId,
                    rewardId: reward.id,
                    squareCustomerId,
                    remainingQuantity,
                    requiredQuantity: offer.required_quantity
                });
            }
        }

        // Update reward progress for any in-progress reward
        await updateRewardProgress(client, {
            merchantId,
            offerId: offer.id,
            squareCustomerId,
            offer
        });

        await client.query('COMMIT');

        return {
            processed: true,
            refundEvent,
            rewardAffected: earnedReward.rows.length > 0
        };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Failed to process refund', {
            error: error.message,
            merchantId,
            squareOrderId
        });
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================================
// REDEMPTION PROCESSING
// ============================================================================

/**
 * Redeem an earned reward
 * BUSINESS RULES:
 * - Full redemption only (no partials)
 * - Same size group as earned
 * - One reward = one free unit
 *
 * @param {Object} redemptionData - Redemption details
 */
async function redeemReward(redemptionData) {
    const {
        merchantId, rewardId, squareOrderId, squareCustomerId,
        redemptionType, redeemedVariationId, redeemedValueCents,
        redeemedByUserId, adminNotes, squareLocationId
    } = redemptionData;

    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Get and lock the reward
        const rewardResult = await client.query(`
            SELECT r.*, o.brand_name, o.size_group, o.offer_name
            FROM loyalty_rewards r
            JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.id = $1 AND r.merchant_id = $2
            FOR UPDATE
        `, [rewardId, merchantId]);

        const reward = rewardResult.rows[0];

        if (!reward) {
            throw new Error('Reward not found or access denied');
        }

        if (reward.status !== RewardStatus.EARNED) {
            throw new Error(`Cannot redeem reward in status: ${reward.status}`);
        }

        // Verify customer matches
        if (squareCustomerId && reward.square_customer_id !== squareCustomerId) {
            throw new Error('Customer ID mismatch - cannot redeem reward for different customer');
        }

        // Get variation details for redemption record
        let itemName = null;
        let variationName = null;

        if (redeemedVariationId) {
            const varResult = await client.query(`
                SELECT item_name, variation_name
                FROM loyalty_qualifying_variations
                WHERE variation_id = $1 AND merchant_id = $2
            `, [redeemedVariationId, merchantId]);

            if (varResult.rows[0]) {
                itemName = varResult.rows[0].item_name;
                variationName = varResult.rows[0].variation_name;
            }
        }

        // Create redemption record
        const redemptionResult = await client.query(`
            INSERT INTO loyalty_redemptions (
                merchant_id, reward_id, offer_id, square_customer_id,
                redemption_type, square_order_id, square_location_id,
                redeemed_variation_id, redeemed_item_name, redeemed_variation_name,
                redeemed_value_cents, redeemed_by_user_id, admin_notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            merchantId, rewardId, reward.offer_id, reward.square_customer_id,
            redemptionType || RedemptionTypes.ORDER_DISCOUNT, squareOrderId, squareLocationId,
            redeemedVariationId, itemName, variationName,
            redeemedValueCents, redeemedByUserId, adminNotes
        ]);

        const redemption = redemptionResult.rows[0];

        // Update reward status
        await client.query(`
            UPDATE loyalty_rewards
            SET status = 'redeemed',
                redeemed_at = NOW(),
                redemption_id = $1,
                redemption_order_id = $2,
                updated_at = NOW()
            WHERE id = $3
        `, [redemption.id, squareOrderId, rewardId]);

        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_REDEEMED,
            offerId: reward.offer_id,
            rewardId,
            redemptionId: redemption.id,
            squareCustomerId: reward.square_customer_id,
            squareOrderId,
            oldState: RewardStatus.EARNED,
            newState: RewardStatus.REDEEMED,
            triggeredBy: redeemedByUserId ? 'ADMIN' : 'SYSTEM',
            userId: redeemedByUserId,
            details: {
                redemptionType,
                redeemedVariationId,
                redeemedValueCents
            }
        });

        // Update customer summary
        await updateCustomerSummary(client, merchantId, reward.square_customer_id, reward.offer_id);

        await client.query('COMMIT');

        logger.info('Reward redeemed successfully', {
            merchantId,
            rewardId,
            redemptionId: redemption.id,
            squareCustomerId: reward.square_customer_id
        });

        return {
            success: true,
            redemption,
            reward: { ...reward, status: RewardStatus.REDEEMED }
        };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Failed to redeem reward', {
            error: error.message,
            merchantId,
            rewardId
        });
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get available (earned) rewards for a customer
 * @param {string} squareCustomerId - Square customer ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Array>} Array of earned rewards
 */
async function getCustomerEarnedRewards(squareCustomerId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const result = await db.query(`
        SELECT r.*, o.offer_name, o.brand_name, o.size_group,
               o.required_quantity, o.window_months
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1
          AND r.square_customer_id = $2
          AND r.status = 'earned'
        ORDER BY r.earned_at ASC
    `, [merchantId, squareCustomerId]);

    return result.rows;
}

// ============================================================================
// CUSTOMER SUMMARY MANAGEMENT
// ============================================================================

/**
 * Update the denormalized customer summary
 * Called after any purchase, refund, or redemption
 */
async function updateCustomerSummary(client, merchantId, squareCustomerId, offerId) {
    // Get current stats
    const stats = await client.query(`
        SELECT
            COALESCE(SUM(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL THEN pe.quantity ELSE 0 END), 0) as current_quantity,
            COALESCE(SUM(CASE WHEN pe.quantity > 0 THEN pe.quantity ELSE 0 END), 0) as lifetime_purchases,
            MAX(pe.purchased_at) as last_purchase,
            MIN(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL THEN pe.window_start_date END) as window_start,
            MAX(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL THEN pe.window_end_date END) as window_end
        FROM loyalty_purchase_events pe
        WHERE pe.merchant_id = $1
          AND pe.offer_id = $2
          AND pe.square_customer_id = $3
    `, [merchantId, offerId, squareCustomerId]);

    const earnedRewards = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'earned'
    `, [merchantId, offerId, squareCustomerId]);

    const redeemedRewards = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'redeemed'
    `, [merchantId, offerId, squareCustomerId]);

    const totalEarned = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
          AND status IN ('earned', 'redeemed')
    `, [merchantId, offerId, squareCustomerId]);

    const offer = await client.query(`
        SELECT required_quantity FROM loyalty_offers WHERE id = $1
    `, [offerId]);

    const s = stats.rows[0];
    const hasEarned = parseInt(earnedRewards.rows[0].count) > 0;

    // Get the earned reward ID if exists
    let earnedRewardId = null;
    if (hasEarned) {
        const earnedResult = await client.query(`
            SELECT id FROM loyalty_rewards
            WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'earned'
            ORDER BY earned_at ASC LIMIT 1
        `, [merchantId, offerId, squareCustomerId]);
        earnedRewardId = earnedResult.rows[0]?.id;
    }

    await client.query(`
        INSERT INTO loyalty_customer_summary (
            merchant_id, square_customer_id, offer_id,
            current_quantity, required_quantity,
            window_start_date, window_end_date,
            has_earned_reward, earned_reward_id,
            total_lifetime_purchases, total_rewards_earned, total_rewards_redeemed,
            last_purchase_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (merchant_id, square_customer_id, offer_id) DO UPDATE SET
            current_quantity = EXCLUDED.current_quantity,
            window_start_date = EXCLUDED.window_start_date,
            window_end_date = EXCLUDED.window_end_date,
            has_earned_reward = EXCLUDED.has_earned_reward,
            earned_reward_id = EXCLUDED.earned_reward_id,
            total_lifetime_purchases = EXCLUDED.total_lifetime_purchases,
            total_rewards_earned = EXCLUDED.total_rewards_earned,
            total_rewards_redeemed = EXCLUDED.total_rewards_redeemed,
            last_purchase_at = EXCLUDED.last_purchase_at,
            updated_at = NOW()
    `, [
        merchantId, squareCustomerId, offerId,
        parseInt(s.current_quantity) || 0,
        offer.rows[0]?.required_quantity || 0,
        s.window_start, s.window_end,
        hasEarned, earnedRewardId,
        parseInt(s.lifetime_purchases) || 0,
        parseInt(totalEarned.rows[0].count) || 0,
        parseInt(redeemedRewards.rows[0].count) || 0,
        s.last_purchase
    ]);
}

// ============================================================================
// ROLLING WINDOW MANAGEMENT
// ============================================================================

/**
 * Process expired window entries
 * Purchases outside the rolling window drop off automatically
 * This should be run periodically (e.g., daily cron)
 */
async function processExpiredWindowEntries(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    logger.info('Processing expired window entries', { merchantId });

    // Find purchases that have expired from the window and are not locked to a reward
    const expiredResult = await db.query(`
        SELECT DISTINCT offer_id, square_customer_id
        FROM loyalty_purchase_events
        WHERE merchant_id = $1
          AND window_end_date < CURRENT_DATE
          AND reward_id IS NULL
    `, [merchantId]);

    let processedCount = 0;

    const client = await db.pool.connect();
    try {
        for (const row of expiredResult.rows) {
            await client.query('BEGIN');

            // Get the offer
            const offerResult = await client.query(`
                SELECT * FROM loyalty_offers WHERE id = $1
            `, [row.offer_id]);

            if (offerResult.rows[0]) {
                await updateRewardProgress(client, {
                    merchantId,
                    offerId: row.offer_id,
                    squareCustomerId: row.square_customer_id,
                    offer: offerResult.rows[0]
                });

                await logAuditEvent({
                    merchantId,
                    action: AuditActions.WINDOW_EXPIRED,
                    offerId: row.offer_id,
                    squareCustomerId: row.square_customer_id,
                    triggeredBy: 'SYSTEM'
                });

                processedCount++;
            }

            await client.query('COMMIT');
        }
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error processing expired entries', { error: error.message });
        throw error;
    } finally {
        client.release();
    }

    logger.info('Expired window processing complete', { merchantId, processedCount });

    return { processedCount };
}

// ============================================================================
// CUSTOMER LOOKUP APIs
// ============================================================================

/**
 * Get loyalty status for a customer
 * @param {string} squareCustomerId - Square customer ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Customer loyalty status across all offers
 */
async function getCustomerLoyaltyStatus(squareCustomerId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    // Get all active offers with customer's progress
    const result = await db.query(`
        SELECT
            o.id as offer_id,
            o.offer_name,
            o.brand_name,
            o.size_group,
            o.required_quantity,
            o.window_months,
            COALESCE(cs.current_quantity, 0) as current_quantity,
            cs.window_start_date,
            cs.window_end_date,
            cs.has_earned_reward,
            cs.earned_reward_id,
            cs.total_lifetime_purchases,
            cs.total_rewards_earned,
            cs.total_rewards_redeemed,
            cs.last_purchase_at
        FROM loyalty_offers o
        LEFT JOIN loyalty_customer_summary cs
            ON o.id = cs.offer_id
            AND cs.square_customer_id = $2
            AND cs.merchant_id = $1
        WHERE o.merchant_id = $1 AND o.is_active = TRUE
        ORDER BY o.brand_name, o.size_group
    `, [merchantId, squareCustomerId]);

    return {
        squareCustomerId,
        offers: result.rows
    };
}

/**
 * Get full loyalty history for a customer
 * @param {string} squareCustomerId - Square customer ID
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @param {Object} options - Query options
 */
async function getCustomerLoyaltyHistory(squareCustomerId, merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { limit = 50, offerId = null } = options;

    // Get purchase events
    let purchaseQuery = `
        SELECT pe.*, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_purchase_events pe
        JOIN loyalty_offers o ON pe.offer_id = o.id
        WHERE pe.merchant_id = $1 AND pe.square_customer_id = $2
    `;
    const purchaseParams = [merchantId, squareCustomerId];

    if (offerId) {
        purchaseQuery += ` AND pe.offer_id = $${purchaseParams.length + 1}`;
        purchaseParams.push(offerId);
    }

    purchaseQuery += ` ORDER BY pe.purchased_at DESC LIMIT $${purchaseParams.length + 1}`;
    purchaseParams.push(limit);

    // Get rewards
    let rewardQuery = `
        SELECT r.*, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1 AND r.square_customer_id = $2
    `;
    const rewardParams = [merchantId, squareCustomerId];

    if (offerId) {
        rewardQuery += ` AND r.offer_id = $${rewardParams.length + 1}`;
        rewardParams.push(offerId);
    }

    rewardQuery += ` ORDER BY r.created_at DESC`;

    // Get redemptions
    let redemptionQuery = `
        SELECT rd.*, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_redemptions rd
        JOIN loyalty_offers o ON rd.offer_id = o.id
        WHERE rd.merchant_id = $1 AND rd.square_customer_id = $2
    `;
    const redemptionParams = [merchantId, squareCustomerId];

    if (offerId) {
        redemptionQuery += ` AND rd.offer_id = $${redemptionParams.length + 1}`;
        redemptionParams.push(offerId);
    }

    redemptionQuery += ` ORDER BY rd.redeemed_at DESC`;

    const [purchases, rewards, redemptions] = await Promise.all([
        db.query(purchaseQuery, purchaseParams),
        db.query(rewardQuery, rewardParams),
        db.query(redemptionQuery, redemptionParams)
    ]);

    return {
        squareCustomerId,
        purchases: purchases.rows,
        rewards: rewards.rows,
        redemptions: redemptions.rows
    };
}

// ============================================================================
// WEBHOOK ORDER PROCESSING
// ============================================================================

/**
 * Process an order for loyalty (called from webhook handler)
 * Extracts line items and processes qualifying purchases
 *
 * @param {Object} order - Square order object from webhook
 * @param {number} merchantId - Internal merchant ID
 */
async function processOrderForLoyalty(order, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    // Check if loyalty is enabled for this merchant
    const loyaltyEnabled = await getSetting('loyalty_enabled', merchantId);
    if (loyaltyEnabled === 'false') {
        logger.debug('Loyalty processing disabled for merchant', { merchantId });
        return { processed: false, reason: 'loyalty_disabled' };
    }

    // RELIABLE CUSTOMER IDENTIFICATION - Only use trustworthy identifiers
    // Priority order: order.customer_id > tenders.customer_id > loyalty event by order_id
    let squareCustomerId = order.customer_id;
    let customerSource = 'order.customer_id';

    // Fallback 1: Check tenders for customer_id (some POS workflows attach customer to payment)
    if (!squareCustomerId && order.tenders && order.tenders.length > 0) {
        for (const tender of order.tenders) {
            if (tender.customer_id) {
                squareCustomerId = tender.customer_id;
                customerSource = 'tender.customer_id';
                logger.debug('Found customer_id on tender', { orderId: order.id, customerId: squareCustomerId });
                break;
            }
        }
    }

    // Fallback 2: Lookup via Square Loyalty API using order_id (NOT timestamp)
    if (!squareCustomerId) {
        logger.debug('No customer_id on order or tenders, trying loyalty lookup by order_id', { orderId: order.id });
        squareCustomerId = await lookupCustomerFromLoyalty(order.id, merchantId);
        customerSource = 'loyalty_event_order_id';

        if (!squareCustomerId) {
            logger.debug('Order has no reliable customer identifier', { orderId: order.id });
            return { processed: false, reason: 'no_customer' };
        }

        logger.info('Found customer via loyalty API (order_id match)', {
            orderId: order.id,
            customerId: squareCustomerId
        });
    }

    const lineItems = order.line_items || [];
    if (lineItems.length === 0) {
        return { processed: false, reason: 'no_line_items' };
    }

    // Extract receipt URL from tenders (usually on card payments)
    let receiptUrl = null;
    if (order.tenders && order.tenders.length > 0) {
        for (const tender of order.tenders) {
            if (tender.receipt_url) {
                receiptUrl = tender.receipt_url;
                break;
            }
        }
    }

    logger.info('Processing order for loyalty', {
        merchantId,
        orderId: order.id,
        customerId: squareCustomerId,
        customerSource,
        lineItemCount: lineItems.length,
        hasReceiptUrl: !!receiptUrl
    });

    const results = {
        processed: true,
        orderId: order.id,
        customerId: squareCustomerId,
        customerSource,  // 'order' or 'loyalty_lookup'
        purchasesRecorded: [],
        errors: []
    };

    for (const lineItem of lineItems) {
        try {
            // Get variation ID from line item
            const variationId = lineItem.catalog_object_id;
            if (!variationId) {
                continue;  // Skip items without variation ID
            }

            const quantity = parseInt(lineItem.quantity) || 0;
            if (quantity <= 0) {
                continue;  // Skip zero or negative quantities
            }

            // Get unit price
            const unitPriceCents = lineItem.base_price_money?.amount || 0;

            // Process the purchase
            const purchaseResult = await processQualifyingPurchase({
                merchantId,
                squareOrderId: order.id,
                squareCustomerId,
                variationId,
                quantity,
                unitPriceCents,
                purchasedAt: order.created_at || new Date(),
                squareLocationId: order.location_id,
                receiptUrl
            });

            if (purchaseResult.processed) {
                results.purchasesRecorded.push({
                    variationId,
                    quantity,
                    reward: purchaseResult.reward
                });
            }
        } catch (error) {
            logger.error('Error processing line item for loyalty', {
                error: error.message,
                lineItemUid: lineItem.uid,
                orderId: order.id
            });
            results.errors.push({
                lineItemUid: lineItem.uid,
                error: error.message
            });
        }
    }

    return results;
}

/**
 * Process refunds in an order (called from webhook handler)
 * @param {Object} order - Square order object with refunds
 * @param {number} merchantId - Internal merchant ID
 */
async function processOrderRefundsForLoyalty(order, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const refunds = order.refunds || [];
    if (refunds.length === 0) {
        return { processed: false, reason: 'no_refunds' };
    }

    const squareCustomerId = order.customer_id;

    logger.info('Processing order refunds for loyalty', {
        merchantId,
        orderId: order.id,
        refundCount: refunds.length
    });

    const results = {
        processed: true,
        orderId: order.id,
        refundsProcessed: [],
        errors: []
    };

    for (const refund of refunds) {
        if (refund.status !== 'COMPLETED') {
            continue;  // Only process completed refunds
        }

        for (const tender of refund.tender_id ? [{ tender_id: refund.tender_id }] : []) {
            // Process refund line items
            for (const returnItem of refund.return_line_items || []) {
                try {
                    const variationId = returnItem.catalog_object_id;
                    if (!variationId) continue;

                    const quantity = parseInt(returnItem.quantity) || 0;
                    if (quantity <= 0) continue;

                    const refundResult = await processRefund({
                        merchantId,
                        squareOrderId: order.id,
                        squareCustomerId,
                        variationId,
                        quantity,
                        unitPriceCents: returnItem.base_price_money?.amount || 0,
                        refundedAt: refund.created_at,
                        squareLocationId: order.location_id
                    });

                    if (refundResult.processed) {
                        results.refundsProcessed.push({
                            variationId,
                            quantity,
                            rewardAffected: refundResult.rewardAffected
                        });
                    }
                } catch (error) {
                    logger.error('Error processing refund line item', {
                        error: error.message,
                        orderId: order.id
                    });
                    results.errors.push({
                        refundId: refund.id,
                        error: error.message
                    });
                }
            }
        }
    }

    return results;
}

// ============================================================================
// AUDIT LOG QUERIES
// ============================================================================

/**
 * Get audit log entries
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @param {Object} options - Query options
 */
async function getAuditLogs(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { limit = 100, offset = 0, action = null, squareCustomerId = null, offerId = null } = options;

    let query = `
        SELECT al.*,
               o.offer_name, o.brand_name,
               u.name as user_name
        FROM loyalty_audit_logs al
        LEFT JOIN loyalty_offers o ON al.offer_id = o.id
        LEFT JOIN users u ON al.user_id = u.id
        WHERE al.merchant_id = $1
    `;
    const params = [merchantId];

    if (action) {
        query += ` AND al.action = $${params.length + 1}`;
        params.push(action);
    }

    if (squareCustomerId) {
        query += ` AND al.square_customer_id = $${params.length + 1}`;
        params.push(squareCustomerId);
    }

    if (offerId) {
        query += ` AND al.offer_id = $${params.length + 1}`;
        params.push(offerId);
    }

    query += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
}

// ============================================================================
// FUTURE FEATURES - TODO (vNext)
// ============================================================================
// The following features are planned for future releases:
//
// TODO (vNext): Buy X Save Y% instantly (promo-compatible discounting)
// - Instead of "buy 12 get 1 free", support "buy 6+ get 10% off"
// - Must be compatible with existing Square promotions
// - Requires real-time discount application at checkout
// - Need to integrate with Square Catalog pricing rules
//
// TODO (vNext): Pre-checkout POS reward prompts (if Square allows)
// - Notify cashier when customer has earned reward before completing transaction
// - Requires Square POS Terminal API integration (if available)
// - May need Square webhook for cart events (not currently available)
// - Fallback: Display notification on Square Dashboard
//
// TODO (vNext): Customer-facing loyalty dashboard
// - Self-service portal for customers to view their progress
// - QR code on receipts linking to their status
// - Email notifications for milestones (requires opt-in)
//
// TODO (vNext): Square receipt message integration
// - Use Square Receipts API to append reward status to digital receipts
// - Show "You've earned X/Y towards your next free item!"
// - Requires additional Square API permissions
//
// TODO (vNext): Bulk import historical purchases
// - Allow merchants to import existing purchase history
// - Support CSV upload with order ID, customer ID, variation ID, qty
// - Validation against Square catalog
//
// TODO (vNext): Loyalty tiers (Bronze/Silver/Gold)
// - Multiple reward tiers based on lifetime purchases
// - Different earning rates per tier
// - Tier status display and progression tracking
// ============================================================================

// ============================================================================
// SQUARE CUSTOMER GROUP DISCOUNT INTEGRATION
// When a customer earns a reward in our system, create a Customer Group Discount
// that auto-applies at Square POS when the customer is identified at checkout.
// This replaces the old Loyalty API approach which required points.
// ============================================================================

/**
 * Get Square API access token for a merchant
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<string|null>} Access token or null
 */
async function getSquareAccessToken(merchantId) {
    const tokenResult = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );

    if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
        return null;
    }

    const rawToken = tokenResult.rows[0].square_access_token;
    return isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;
}

/**
 * Create a Customer Group in Square for a specific reward
 * Each reward gets its own group so we can track/remove individually
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.internalRewardId - Our internal reward ID
 * @param {string} params.offerName - Name of the offer for display
 * @param {string} params.customerName - Customer name for group naming
 * @returns {Promise<Object>} Result with group ID if successful
 */
async function createRewardCustomerGroup({ merchantId, internalRewardId, offerName, customerName }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        // Create a unique group name for this specific reward
        const groupName = `FBP Reward #${internalRewardId}: ${offerName}`.substring(0, 255);

        const response = await fetch('https://connect.squareup.com/v2/customers/groups', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
                group: {
                    name: groupName
                },
                idempotency_key: `fbp-group-${internalRewardId}-${Date.now()}`
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            logger.error('Failed to create customer group', {
                status: response.status,
                error: errText,
                merchantId
            });
            return { success: false, error: `Square API error: ${response.status}` };
        }

        const data = await response.json();
        const groupId = data.group?.id;

        logger.info('Created reward customer group', {
            merchantId,
            internalRewardId,
            groupId,
            groupName
        });

        return { success: true, groupId, groupName };

    } catch (error) {
        logger.error('Error creating customer group', { error: error.message, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Add a customer to a Customer Group
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {string} params.groupId - Square customer group ID
 * @returns {Promise<Object>} Result
 */
async function addCustomerToGroup({ merchantId, squareCustomerId, groupId }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        const response = await fetch(
            `https://connect.squareup.com/v2/customers/${squareCustomerId}/groups/${groupId}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2024-01-18'
                }
            }
        );

        if (!response.ok) {
            const errText = await response.text();
            logger.error('Failed to add customer to group', {
                status: response.status,
                error: errText,
                merchantId,
                squareCustomerId,
                groupId
            });
            return { success: false, error: `Square API error: ${response.status}` };
        }

        logger.info('Added customer to reward group', {
            merchantId,
            squareCustomerId,
            groupId
        });

        return { success: true };

    } catch (error) {
        logger.error('Error adding customer to group', { error: error.message, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Remove a customer from a Customer Group (after redemption)
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {string} params.groupId - Square customer group ID
 * @returns {Promise<Object>} Result
 */
async function removeCustomerFromGroup({ merchantId, squareCustomerId, groupId }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        const response = await fetch(
            `https://connect.squareup.com/v2/customers/${squareCustomerId}/groups/${groupId}`,
            {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2024-01-18'
                }
            }
        );

        if (!response.ok && response.status !== 404) {
            const errText = await response.text();
            logger.error('Failed to remove customer from group', {
                status: response.status,
                error: errText,
                merchantId,
                squareCustomerId,
                groupId
            });
            return { success: false, error: `Square API error: ${response.status}` };
        }

        logger.info('Removed customer from reward group', {
            merchantId,
            squareCustomerId,
            groupId
        });

        return { success: true };

    } catch (error) {
        logger.error('Error removing customer from group', { error: error.message, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Delete a Customer Group (cleanup after redemption)
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.groupId - Square customer group ID
 * @returns {Promise<Object>} Result
 */
async function deleteCustomerGroup({ merchantId, groupId }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        const response = await fetch(
            `https://connect.squareup.com/v2/customers/groups/${groupId}`,
            {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2024-01-18'
                }
            }
        );

        if (!response.ok && response.status !== 404) {
            const errText = await response.text();
            logger.error('Failed to delete customer group', {
                status: response.status,
                error: errText,
                merchantId,
                groupId
            });
            return { success: false, error: `Square API error: ${response.status}` };
        }

        logger.info('Deleted reward customer group', { merchantId, groupId });

        return { success: true };

    } catch (error) {
        logger.error('Error deleting customer group', { error: error.message, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Create a Catalog Discount with Pricing Rule for a reward
 * This creates an auto-applying 100% discount for the customer group on qualifying items
 * Limited to 1 item via maximum_amount_money cap
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.internalRewardId - Our internal reward ID
 * @param {string} params.groupId - Square customer group ID
 * @param {string} params.offerName - Offer name for discount display
 * @param {Array<string>} params.variationIds - Square catalog variation IDs that qualify
 * @returns {Promise<Object>} Result with discount and pricing rule IDs
 */
async function createRewardDiscount({ merchantId, internalRewardId, groupId, offerName, variationIds }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        // Get merchant's currency setting
        const merchantResult = await db.query('SELECT currency FROM merchants WHERE id = $1', [merchantId]);
        const currency = merchantResult.rows[0]?.currency || 'USD';

        // Query the max price from the customer's ACTUAL purchases that earned this reward
        // This ensures the discount cap reflects what they actually bought, not catalog max
        let maxPriceCents = 0;
        let priceSource = 'unknown';
        try {
            const priceResult = await db.query(`
                SELECT MAX(unit_price_cents) as max_price
                FROM loyalty_purchase_events
                WHERE reward_id = $1
                  AND unit_price_cents IS NOT NULL
                  AND quantity > 0
            `, [internalRewardId]);

            maxPriceCents = parseInt(priceResult.rows[0]?.max_price) || 0;
            if (maxPriceCents > 0) {
                priceSource = 'purchase_events';
            }
        } catch (priceErr) {
            logger.warn('Could not fetch purchase prices for discount cap', { error: priceErr.message });
        }

        // Fallback to catalog prices if no purchase data available
        if (maxPriceCents === 0) {
            try {
                const catalogResponse = await fetch('https://connect.squareup.com/v2/catalog/batch-retrieve', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': '2024-01-18'
                    },
                    body: JSON.stringify({
                        object_ids: variationIds,
                        include_related_objects: false
                    })
                });

                if (catalogResponse.ok) {
                    const catalogData = await catalogResponse.json();
                    for (const obj of catalogData.objects || []) {
                        if (obj.type === 'ITEM_VARIATION' && obj.item_variation_data?.price_money?.amount) {
                            const price = obj.item_variation_data.price_money.amount;
                            if (price > maxPriceCents) {
                                maxPriceCents = price;
                            }
                        }
                    }
                }
                if (maxPriceCents > 0) {
                    priceSource = 'catalog_fallback';
                }
            } catch (catalogErr) {
                logger.warn('Could not fetch catalog prices for discount cap', { error: catalogErr.message });
            }
        }

        // Default to $50 if we still couldn't determine max price
        if (maxPriceCents === 0) {
            maxPriceCents = 5000; // $50.00
            priceSource = 'default_fallback';
            logger.warn('Using default $50 discount cap - no price data available', { internalRewardId });
        }

        logger.info('Creating reward discount with price cap', {
            merchantId,
            internalRewardId,
            maxPriceCents,
            priceSource,
            currency,
            variationCount: variationIds.length
        });

        // Generate unique IDs for the catalog objects
        const discountId = `#fbp-discount-${internalRewardId}`;
        const matchProductSetId = `#fbp-match-set-${internalRewardId}`;
        const pricingRuleId = `#fbp-pricing-rule-${internalRewardId}`;

        // Build the catalog batch upsert request
        // Simple approach: 100% discount on qualifying items, capped at max item price
        // This gives exactly 1 item's worth of discount regardless of quantity in cart
        const catalogObjects = [
            // 1. Create the Discount (100% off)
            // Prefix with "zz_" so it sorts to bottom of discount list in Square Dashboard
            {
                type: 'DISCOUNT',
                id: discountId,
                discount_data: {
                    name: `zz_Loyalty: ${offerName}`.substring(0, 255),
                    discount_type: 'FIXED_PERCENTAGE',
                    percentage: '100.0',
                    modify_tax_basis: 'MODIFY_TAX_BASIS'
                }
            },
            // 2. Create the Match Product Set (triggers when cart has qualifying items)
            {
                type: 'PRODUCT_SET',
                id: matchProductSetId,
                product_set_data: {
                    product_ids_any: variationIds,
                    quantity_min: 1  // Triggers if at least 1 qualifying item in cart
                }
            },
            // 3. Create the Pricing Rule (ties it all together)
            // NO EXCLUDE - just cap the total discount at 1 item's value
            {
                type: 'PRICING_RULE',
                id: pricingRuleId,
                pricing_rule_data: {
                    name: `zz_FBP Reward #${internalRewardId}`,
                    discount_id: discountId,
                    match_products_id: matchProductSetId,
                    // Cap discount at max item price = exactly 1 item free worth
                    maximum_amount_money: {
                        amount: maxPriceCents,
                        currency: currency
                    },
                    customer_group_ids_any: [groupId]
                }
            }
        ];

        const response = await fetch('https://connect.squareup.com/v2/catalog/batch-upsert', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
                idempotency_key: `fbp-catalog-${internalRewardId}-${Date.now()}`,
                batches: [{
                    objects: catalogObjects
                }]
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            logger.error('Failed to create reward discount', {
                status: response.status,
                error: errText,
                merchantId,
                internalRewardId
            });
            return { success: false, error: `Square API error: ${response.status} - ${errText}` };
        }

        const data = await response.json();
        const objects = data.objects || [];

        // Extract the real Square IDs from the response
        const discountObj = objects.find(o => o.type === 'DISCOUNT');
        const productSetObj = objects.find(o => o.type === 'PRODUCT_SET');
        const pricingRuleObj = objects.find(o => o.type === 'PRICING_RULE');

        logger.info('Created reward discount in Square catalog', {
            merchantId,
            internalRewardId,
            discountId: discountObj?.id,
            productSetId: productSetObj?.id,
            pricingRuleId: pricingRuleObj?.id,
            maxPriceCap: maxPriceCents
        });

        return {
            success: true,
            discountId: discountObj?.id,
            productSetId: productSetObj?.id,
            pricingRuleId: pricingRuleObj?.id
        };

    } catch (error) {
        logger.error('Error creating reward discount', { error: error.message, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Delete catalog objects (discount, product set, pricing rule) after redemption
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {Array<string>} params.objectIds - Square catalog object IDs to delete
 * @returns {Promise<Object>} Result
 */
async function deleteRewardDiscountObjects({ merchantId, objectIds }) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { success: false, error: 'No access token available' };
        }

        // Delete each object (Square doesn't support batch delete for catalog)
        const results = [];
        for (const objectId of objectIds) {
            if (!objectId) continue;

            const response = await fetch(
                `https://connect.squareup.com/v2/catalog/object/${objectId}`,
                {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': '2024-01-18'
                    }
                }
            );

            if (!response.ok && response.status !== 404) {
                logger.warn('Failed to delete catalog object', {
                    objectId,
                    status: response.status
                });
            }
            results.push({ objectId, deleted: response.ok || response.status === 404 });
        }

        logger.info('Deleted reward discount objects', { merchantId, results });

        return { success: true, results };

    } catch (error) {
        logger.error('Error deleting reward discount objects', { error: error.message, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Create a Square Customer Group Discount when a customer earns a reward
 * This is the main function that orchestrates the entire flow:
 * 1. Create a customer group for this reward
 * 2. Add the customer to the group
 * 3. Create a catalog discount + pricing rule for the group
 * 4. Store all IDs in our database for cleanup later
 *
 * When the customer checks out at Square POS and is identified (phone lookup),
 * the discount will auto-apply to qualifying items.
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {number} params.internalRewardId - Our internal reward ID
 * @param {number} params.offerId - Our internal offer ID
 * @returns {Promise<Object>} Result with Square object IDs if successful
 */
async function createSquareCustomerGroupDiscount({ merchantId, squareCustomerId, internalRewardId, offerId }) {
    try {
        // Get offer details
        const offerResult = await db.query(`
            SELECT o.*, array_agg(qv.variation_id) as variation_ids
            FROM loyalty_offers o
            LEFT JOIN loyalty_qualifying_variations qv ON o.id = qv.offer_id AND qv.is_active = TRUE
            WHERE o.id = $1 AND o.merchant_id = $2
            GROUP BY o.id
        `, [offerId, merchantId]);

        if (offerResult.rows.length === 0) {
            return { success: false, error: 'Offer not found' };
        }

        const offer = offerResult.rows[0];
        const variationIds = (offer.variation_ids || []).filter(v => v != null);

        if (variationIds.length === 0) {
            return {
                success: false,
                error: 'No qualifying variations configured for this offer'
            };
        }

        // Get customer name for group naming (optional)
        const customerDetails = await getCustomerDetails(squareCustomerId, merchantId);
        const customerName = customerDetails?.displayName || squareCustomerId.substring(0, 8);

        // Step 1: Create customer group
        const groupResult = await createRewardCustomerGroup({
            merchantId,
            internalRewardId,
            offerName: offer.offer_name,
            customerName
        });

        if (!groupResult.success) {
            return groupResult;
        }

        // Step 2: Add customer to group
        const addResult = await addCustomerToGroup({
            merchantId,
            squareCustomerId,
            groupId: groupResult.groupId
        });

        if (!addResult.success) {
            // Cleanup: delete the group we just created
            await deleteCustomerGroup({ merchantId, groupId: groupResult.groupId });
            return addResult;
        }

        // Step 3: Create discount + pricing rule
        const discountResult = await createRewardDiscount({
            merchantId,
            internalRewardId,
            groupId: groupResult.groupId,
            offerName: offer.offer_name,
            variationIds
        });

        if (!discountResult.success) {
            // Cleanup: remove customer from group and delete group
            await removeCustomerFromGroup({ merchantId, squareCustomerId, groupId: groupResult.groupId });
            await deleteCustomerGroup({ merchantId, groupId: groupResult.groupId });
            return discountResult;
        }

        // Step 4: Store Square object IDs in our reward record for cleanup later
        await db.query(`
            UPDATE loyalty_rewards SET
                square_group_id = $1,
                square_discount_id = $2,
                square_product_set_id = $3,
                square_pricing_rule_id = $4,
                square_pos_synced_at = NOW(),
                updated_at = NOW()
            WHERE id = $5
        `, [
            groupResult.groupId,
            discountResult.discountId,
            discountResult.productSetId,
            discountResult.pricingRuleId,
            internalRewardId
        ]);

        logger.info('Created Square Customer Group Discount for reward', {
            merchantId,
            internalRewardId,
            squareCustomerId,
            groupId: groupResult.groupId,
            discountId: discountResult.discountId,
            pricingRuleId: discountResult.pricingRuleId
        });

        return {
            success: true,
            groupId: groupResult.groupId,
            discountId: discountResult.discountId,
            productSetId: discountResult.productSetId,
            pricingRuleId: discountResult.pricingRuleId
        };

    } catch (error) {
        logger.error('Error creating Square Customer Group Discount', { error: error.message, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Cleanup Square Customer Group Discount after a reward is redeemed
 * Removes the customer from the group and deletes the discount/pricing rule
 *
 * @param {Object} params - Parameters
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {number} params.internalRewardId - Our internal reward ID
 * @returns {Promise<Object>} Result
 */
async function cleanupSquareCustomerGroupDiscount({ merchantId, squareCustomerId, internalRewardId }) {
    try {
        // Get the Square object IDs from our reward record
        const rewardResult = await db.query(`
            SELECT square_group_id, square_discount_id, square_product_set_id, square_pricing_rule_id
            FROM loyalty_rewards
            WHERE id = $1 AND merchant_id = $2
        `, [internalRewardId, merchantId]);

        if (rewardResult.rows.length === 0) {
            return { success: false, error: 'Reward not found' };
        }

        const reward = rewardResult.rows[0];

        // If no Square objects were created, nothing to clean up
        if (!reward.square_group_id && !reward.square_discount_id) {
            logger.info('No Square objects to clean up for reward', { internalRewardId });
            return { success: true, message: 'No Square objects to clean up' };
        }

        // Step 1: Delete the pricing rule first (it references other objects)
        if (reward.square_pricing_rule_id) {
            await deleteRewardDiscountObjects({
                merchantId,
                objectIds: [reward.square_pricing_rule_id]
            });
        }

        // Step 2: Delete the discount and product sets (may be comma-separated for multiple sets)
        const productSetIds = reward.square_product_set_id
            ? reward.square_product_set_id.split(',').filter(Boolean)
            : [];
        const objectsToDelete = [reward.square_discount_id, ...productSetIds].filter(Boolean);
        if (objectsToDelete.length > 0) {
            await deleteRewardDiscountObjects({
                merchantId,
                objectIds: objectsToDelete
            });
        }

        // Step 3: Remove customer from group
        if (reward.square_group_id && squareCustomerId) {
            await removeCustomerFromGroup({
                merchantId,
                squareCustomerId,
                groupId: reward.square_group_id
            });
        }

        // Step 4: Delete the customer group
        if (reward.square_group_id) {
            await deleteCustomerGroup({
                merchantId,
                groupId: reward.square_group_id
            });
        }

        // Step 5: Clear the Square IDs from our reward record
        await db.query(`
            UPDATE loyalty_rewards SET
                square_group_id = NULL,
                square_discount_id = NULL,
                square_product_set_id = NULL,
                square_pricing_rule_id = NULL,
                updated_at = NOW()
            WHERE id = $1
        `, [internalRewardId]);

        logger.info('Cleaned up Square Customer Group Discount', {
            merchantId,
            internalRewardId,
            groupId: reward.square_group_id
        });

        return { success: true };

    } catch (error) {
        logger.error('Error cleaning up Square Customer Group Discount', { error: error.message, merchantId });
        return { success: false, error: error.message };
    }
}

/**
 * Check if an order used a reward discount and mark it as redeemed
 * Called from order webhook to detect when customer redeems at POS
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object>} Result with redeemed reward info if found
 */
async function detectRewardRedemptionFromOrder(order, merchantId) {
    try {
        const discounts = order.discounts || [];
        if (discounts.length === 0) {
            return { detected: false };
        }

        // Look for any of our reward discounts in the order
        for (const discount of discounts) {
            const catalogObjectId = discount.catalog_object_id;
            if (!catalogObjectId) continue;

            // Check if this discount matches any of our earned rewards
            // Check BOTH square_discount_id AND square_pricing_rule_id because Square
            // may reference either one in the order discount depending on how it was applied
            const rewardResult = await db.query(`
                SELECT r.*, o.offer_name
                FROM loyalty_rewards r
                JOIN loyalty_offers o ON r.offer_id = o.id
                WHERE r.merchant_id = $1
                  AND (r.square_discount_id = $2 OR r.square_pricing_rule_id = $2)
                  AND r.status = 'earned'
            `, [merchantId, catalogObjectId]);

            if (rewardResult.rows.length > 0) {
                const reward = rewardResult.rows[0];

                logger.info('Detected reward redemption from order', {
                    merchantId,
                    orderId: order.id,
                    rewardId: reward.id,
                    discountId: catalogObjectId
                });

                // Redeem the reward
                const redemptionResult = await redeemReward({
                    merchantId,
                    rewardId: reward.id,
                    squareOrderId: order.id,
                    squareCustomerId: order.customer_id,
                    redemptionType: RedemptionTypes.AUTO_DETECTED,
                    redeemedValueCents: discount.applied_money?.amount || 0,
                    squareLocationId: order.location_id
                });

                // Cleanup the Square objects
                await cleanupSquareCustomerGroupDiscount({
                    merchantId,
                    squareCustomerId: reward.square_customer_id,
                    internalRewardId: reward.id
                });

                return {
                    detected: true,
                    rewardId: reward.id,
                    offerName: reward.offer_name,
                    redemption: redemptionResult
                };
            }
        }

        return { detected: false };

    } catch (error) {
        logger.error('Error detecting reward redemption', { error: error.message, merchantId, orderId: order.id });
        return { detected: false, error: error.message };
    }
}

// Legacy function for backward compatibility - now uses Customer Group Discounts
// Keep the old name for any existing code references, but redirect to new implementation
async function createSquareLoyaltyReward({ merchantId, squareCustomerId, internalRewardId, offerId }) {
    logger.info('createSquareLoyaltyReward called - redirecting to Customer Group Discount approach');
    return createSquareCustomerGroupDiscount({ merchantId, squareCustomerId, internalRewardId, offerId });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Constants
    RewardStatus,
    AuditActions,
    RedemptionTypes,

    // Settings
    getSetting,
    updateSetting,
    initializeDefaultSettings,

    // Offer management
    createOffer,
    getOffers,
    getOfferById,
    updateOffer,
    deleteOffer,

    // Qualifying variations
    addQualifyingVariations,
    getQualifyingVariations,
    getOfferForVariation,

    // Purchase processing
    processQualifyingPurchase,
    processRefund,

    // Reward management
    redeemReward,
    getCustomerEarnedRewards,

    // Rolling window
    processExpiredWindowEntries,

    // Customer APIs
    getCustomerLoyaltyStatus,
    getCustomerLoyaltyHistory,
    getCustomerDetails,
    lookupCustomerFromLoyalty,
    prefetchRecentLoyaltyEvents,
    findCustomerFromPrefetchedEvents,

    // Square Customer Group Discount Integration (replaces old Loyalty API)
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount,
    detectRewardRedemptionFromOrder,
    createSquareLoyaltyReward,  // Legacy wrapper, redirects to Customer Group Discount

    // Webhook processing
    processOrderForLoyalty,
    processOrderRefundsForLoyalty,

    // Utilities
    getSquareAccessToken,

    // Audit
    logAuditEvent,
    getAuditLogs
};
