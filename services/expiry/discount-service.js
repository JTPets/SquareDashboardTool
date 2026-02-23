/**
 * Expiry-Aware Discount Service
 * Handles tier evaluation, Square discount object management, and discount automation
 *
 * This service was moved from utils/expiry-discount.js as part of P1-3 (utils reorganization).
 * For backward compatibility, utils/expiry-discount.js re-exports this module.
 *
 * Usage:
 *   const { getActiveTiers, runExpiryDiscountAutomation } = require('./services/expiry');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { deleteCatalogObjects } = require('../../utils/square-catalog-cleanup');

// Lazy-load square-api to avoid circular dependency
let squareApi = null;
function getSquareApi() {
    if (!squareApi) {
        squareApi = require('../../utils/square-api');
    }
    return squareApi;
}

/**
 * Get all active discount tiers from database, ordered by priority
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Array>} Array of tier objects
 */
async function getActiveTiers(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getActiveTiers');
    }
    const result = await db.query(`
        SELECT * FROM expiry_discount_tiers
        WHERE is_active = TRUE AND merchant_id = $1
        ORDER BY priority DESC
    `, [merchantId]);
    return result.rows;
}

/**
 * Get a specific tier by code
 * @param {string} tierCode - Tier code (e.g., 'AUTO50')
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Object|null>} Tier object or null
 */
async function getTierByCode(tierCode, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getTierByCode');
    }
    const result = await db.query(`
        SELECT * FROM expiry_discount_tiers WHERE tier_code = $1 AND merchant_id = $2
    `, [tierCode, merchantId]);
    return result.rows[0] || null;
}

/**
 * Get a setting value from expiry_discount_settings
 * @param {string} key - Setting key
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<string|null>} Setting value
 */
async function getSetting(key, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getSetting');
    }
    const result = await db.query(`
        SELECT setting_value FROM expiry_discount_settings WHERE setting_key = $1 AND merchant_id = $2
    `, [key, merchantId]);
    return result.rows[0]?.setting_value || null;
}

/**
 * Update a setting value
 * @param {string} key - Setting key
 * @param {string} value - New value
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 */
async function updateSetting(key, value, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateSetting');
    }
    await db.query(`
        INSERT INTO expiry_discount_settings (setting_key, setting_value, merchant_id, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (setting_key, merchant_id) DO UPDATE
        SET setting_value = $2, updated_at = NOW()
    `, [key, value, merchantId]);
}

/**
 * Calculate days until expiry for a given expiration date
 * @param {Date|string} expirationDate - The expiration date
 * @param {string} timezone - Timezone string (default: America/Toronto)
 * @returns {number|null} Days until expiry (negative if expired), or null if no date
 */
function calculateDaysUntilExpiry(expirationDate, timezone = 'America/Toronto') {
    if (!expirationDate) return null;

    const expiry = new Date(expirationDate);
    const now = new Date();

    // Set both to start of day for accurate day calculation
    expiry.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);

    const diffMs = expiry - now;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    return diffDays;
}

/**
 * Build a tier rank map from DB tiers, ordered by urgency (most urgent = highest rank).
 * Uses min_days_to_expiry ascending: EXPIRED (null/lowest min) = rank N, OK (highest min) = rank 0.
 * @param {Array} tiers - Array of tier objects from getActiveTiers()
 * @returns {Map<number, number>} Map of tier ID → rank (higher rank = more urgent)
 */
function buildTierRankMap(tiers) {
    // Sort by min_days_to_expiry descending (OK first, EXPIRED last)
    // so that rank index increases with urgency
    const sorted = [...tiers].sort((a, b) => {
        const aMin = a.min_days_to_expiry ?? -Infinity;
        const bMin = b.min_days_to_expiry ?? -Infinity;
        return bMin - aMin; // descending: highest min_days first (OK), lowest last (EXPIRED)
    });
    const rankMap = new Map();
    sorted.forEach((tier, index) => {
        rankMap.set(tier.id, index); // OK=0, REVIEW=1, AUTO25=2, AUTO50=3, EXPIRED=4
    });
    return rankMap;
}

/**
 * Determine which tier a variation belongs to based on days until expiry
 * @param {number|null} daysUntilExpiry - Days until expiry
 * @param {Array} tiers - Array of tier objects (sorted by priority DESC)
 * @returns {Object|null} Matching tier object or null
 */
function determineTier(daysUntilExpiry, tiers) {
    if (daysUntilExpiry === null) {
        // No expiration date - could be "does_not_expire" or unknown
        return null;
    }

    for (const tier of tiers) {
        const minDays = tier.min_days_to_expiry;
        const maxDays = tier.max_days_to_expiry;

        // Check if days falls within this tier's range
        const meetsMin = minDays === null || daysUntilExpiry >= minDays;
        const meetsMax = maxDays === null || daysUntilExpiry <= maxDays;

        if (meetsMin && meetsMax) {
            return tier;
        }
    }

    return null;
}

/**
 * Evaluate all variations with expiration dates and assign tiers
 * @param {Object} options - Options
 * @param {number} options.merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @param {boolean} options.dryRun - If true, don't make any changes
 * @param {string} options.triggeredBy - 'SYSTEM', 'MANUAL', or 'CRON'
 * @returns {Promise<Object>} Evaluation results
 */
async function evaluateAllVariations(options = {}) {
    const { merchantId, dryRun = false, triggeredBy = 'SYSTEM' } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for evaluateAllVariations');
    }

    logger.info('Starting expiry tier evaluation', { merchantId, dryRun, triggeredBy });

    const results = {
        totalEvaluated: 0,
        tierChanges: [],
        newAssignments: [],
        regressionsFlagged: [],
        unchanged: 0,
        errors: [],
        byTier: {}
    };

    try {
        // Get active tiers for this merchant
        const tiers = await getActiveTiers(merchantId);

        // Build rank map: tier ID → urgency rank (higher = more urgent)
        const tierRankMap = buildTierRankMap(tiers);

        // Initialize tier counts
        for (const tier of tiers) {
            results.byTier[tier.tier_code] = 0;
        }
        results.byTier['NO_EXPIRY'] = 0;

        // Get all variations with expiration data for this merchant
        const variationsResult = await db.query(`
            SELECT
                v.id as variation_id,
                v.item_id,
                v.name as variation_name,
                v.sku,
                v.price_money as current_price_cents,
                i.name as item_name,
                ve.expiration_date,
                ve.does_not_expire,
                vds.current_tier_id,
                vds.original_price_cents,
                vds.discounted_price_cents
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN variation_expiration ve ON v.id = ve.variation_id AND ve.merchant_id = $1
            LEFT JOIN variation_discount_status vds ON v.id = vds.variation_id
            WHERE v.is_deleted = FALSE
              AND i.is_deleted = FALSE
              AND v.merchant_id = $1
        `, [merchantId]);

        const timezone = await getSetting('timezone', merchantId) || 'America/Toronto';

        for (const row of variationsResult.rows) {
            results.totalEvaluated++;

            try {
                // Skip items that don't expire
                if (row.does_not_expire === true) {
                    results.byTier['NO_EXPIRY']++;
                    continue;
                }

                // Calculate days until expiry
                const daysUntilExpiry = calculateDaysUntilExpiry(row.expiration_date, timezone);

                if (daysUntilExpiry === null) {
                    results.byTier['NO_EXPIRY']++;
                    continue;
                }

                // Determine tier
                const newTier = determineTier(daysUntilExpiry, tiers);

                if (!newTier) {
                    results.byTier['NO_EXPIRY']++;
                    continue;
                }

                results.byTier[newTier.tier_code]++;

                // Check if tier changed
                const oldTierId = row.current_tier_id;
                const newTierId = newTier.id;

                if (oldTierId !== newTierId) {
                    // Tier regression guard: detect downgrade (moving to less urgent tier)
                    const oldRank = oldTierId !== null ? (tierRankMap.get(oldTierId) ?? -1) : -1;
                    const newRank = tierRankMap.get(newTierId) ?? -1;
                    const isRegression = oldTierId !== null && newRank < oldRank;

                    const change = {
                        variationId: row.variation_id,
                        itemName: row.item_name,
                        variationName: row.variation_name,
                        sku: row.sku,
                        daysUntilExpiry,
                        expirationDate: row.expiration_date,
                        oldTierId,
                        newTierId,
                        newTierCode: newTier.tier_code,
                        newTierName: newTier.tier_name,
                        discountPercent: newTier.discount_percent,
                        isAutoApply: newTier.is_auto_apply,
                        requiresReview: newTier.requires_review,
                        needsPull: newTier.tier_code === 'EXPIRED',
                        isRegression
                    };

                    if (oldTierId === null) {
                        results.newAssignments.push(change);
                    } else if (isRegression) {
                        // Regression: flag for manual review instead of auto-downgrading
                        results.regressionsFlagged.push(change);

                        if (!dryRun) {
                            logger.warn('Tier regression detected', {
                                variationId: row.variation_id,
                                sku: row.sku,
                                oldTierId,
                                newTierId,
                                newTierCode: newTier.tier_code,
                                daysUntilExpiry,
                                merchantId
                            });

                            // Flag for manual review — do NOT change the tier
                            await db.query(`
                                UPDATE variation_discount_status
                                SET needs_manual_review = TRUE,
                                    days_until_expiry = $1,
                                    last_evaluated_at = NOW(),
                                    updated_at = NOW()
                                WHERE variation_id = $2 AND merchant_id = $3
                            `, [daysUntilExpiry, row.variation_id, merchantId]);

                            await logAuditEvent({
                                merchantId,
                                variationId: row.variation_id,
                                action: 'REGRESSION_FLAGGED',
                                oldTierId,
                                newTierId,
                                daysUntilExpiry,
                                triggeredBy
                            });
                        }
                        continue; // Skip normal tier update
                    } else {
                        results.tierChanges.push(change);
                    }

                    if (!dryRun) {
                        // Update variation_discount_status
                        await db.query(`
                            INSERT INTO variation_discount_status (
                                variation_id, current_tier_id, days_until_expiry,
                                original_price_cents, needs_pull, needs_manual_review,
                                merchant_id, last_evaluated_at, updated_at
                            )
                            VALUES ($1, $2, $3, $4, $5, FALSE, $6, NOW(), NOW())
                            ON CONFLICT (variation_id, merchant_id) DO UPDATE SET
                                current_tier_id = EXCLUDED.current_tier_id,
                                days_until_expiry = EXCLUDED.days_until_expiry,
                                original_price_cents = COALESCE(variation_discount_status.original_price_cents, EXCLUDED.original_price_cents),
                                needs_pull = EXCLUDED.needs_pull,
                                needs_manual_review = FALSE,
                                last_evaluated_at = NOW(),
                                updated_at = NOW()
                        `, [
                            row.variation_id,
                            newTierId,
                            daysUntilExpiry,
                            row.current_price_cents,
                            change.needsPull,
                            merchantId
                        ]);

                        // Log to audit
                        await logAuditEvent({
                            merchantId,
                            variationId: row.variation_id,
                            action: oldTierId ? 'TIER_CHANGED' : 'TIER_ASSIGNED',
                            oldTierId,
                            newTierId,
                            daysUntilExpiry,
                            triggeredBy
                        });
                    }
                } else {
                    results.unchanged++;

                    // Still update the days_until_expiry cache if not dry run
                    if (!dryRun && row.current_tier_id !== null) {
                        await db.query(`
                            UPDATE variation_discount_status
                            SET days_until_expiry = $1, last_evaluated_at = NOW()
                            WHERE variation_id = $2
                        `, [daysUntilExpiry, row.variation_id]);
                    }
                }

            } catch (error) {
                results.errors.push({
                    variationId: row.variation_id,
                    error: error.message
                });
                logger.error('Error evaluating variation', {
                    variationId: row.variation_id,
                    error: error.message
                });
            }
        }

        logger.info('Expiry tier evaluation complete', {
            totalEvaluated: results.totalEvaluated,
            tierChanges: results.tierChanges.length,
            newAssignments: results.newAssignments.length,
            regressionsFlagged: results.regressionsFlagged.length,
            unchanged: results.unchanged,
            errors: results.errors.length,
            byTier: results.byTier
        });

        return results;

    } catch (error) {
        logger.error('Expiry tier evaluation failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Log an audit event
 * @param {Object} event - Audit event data
 * @param {number} event.merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 */
async function logAuditEvent(event) {
    if (!event.merchantId) {
        throw new Error('merchantId is required for logAuditEvent');
    }
    await db.query(`
        INSERT INTO expiry_discount_audit_log (
            merchant_id, variation_id, action, old_tier_id, new_tier_id,
            old_price_cents, new_price_cents, days_until_expiry,
            square_sync_status, square_error_message, triggered_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
        event.merchantId,
        event.variationId,
        event.action,
        event.oldTierId || null,
        event.newTierId || null,
        event.oldPriceCents || null,
        event.newPriceCents || null,
        event.daysUntilExpiry || null,
        event.squareSyncStatus || null,
        event.squareErrorMessage || null,
        event.triggeredBy || 'SYSTEM'
    ]);
}

/**
 * Create or update a Square discount catalog object
 * @param {Object} tier - Tier configuration
 * @returns {Promise<Object>} Created/updated discount object
 */
async function upsertSquareDiscount(tier) {
    const squareApiModule = getSquareApi();
    const accessToken = await squareApiModule.getMerchantToken(tier.merchant_id);

    logger.info('Upserting Square discount object', {
        tierCode: tier.tier_code,
        discountPercent: tier.discount_percent,
        existingId: tier.square_discount_id,
        merchantId: tier.merchant_id
    });

    try {
        const idempotencyKey = squareApiModule.generateIdempotencyKey(`discount-${tier.tier_code}`);

        // Build the discount object
        // Use tier_name as the customer-facing discount name (e.g., "Clearance Sale", "Special Savings")
        const discountData = {
            name: tier.tier_name,
            discount_type: 'FIXED_PERCENTAGE',
            percentage: tier.discount_percent.toString(),
            // Item-level discounts apply to specific catalog items
            // We'll update the pricing_rule_data separately if needed
        };

        let requestBody;

        if (tier.square_discount_id) {
            // Update existing - need to fetch version first
            try {
                const retrieveData = await squareApiModule.makeSquareRequest(
                    `/v2/catalog/object/${tier.square_discount_id}?include_related_objects=false`,
                    { accessToken }
                );

                if (retrieveData.object) {
                    requestBody = {
                        idempotency_key: idempotencyKey,
                        object: {
                            type: 'DISCOUNT',
                            id: tier.square_discount_id,
                            version: retrieveData.object.version,
                            discount_data: discountData
                        }
                    };
                }
            } catch (retrieveError) {
                // Discount was deleted in Square or doesn't exist - clear the old ID
                logger.warn('Existing discount not found in Square, will create new', {
                    tierCode: tier.tier_code,
                    oldId: tier.square_discount_id,
                    error: retrieveError.message
                });

                // Clear the stale ID from the database
                await db.query(`
                    UPDATE expiry_discount_tiers
                    SET square_discount_id = NULL, updated_at = NOW()
                    WHERE id = $1
                `, [tier.id]);

                tier.square_discount_id = null;
            }
        }

        if (!requestBody) {
            // Create new discount
            requestBody = {
                idempotency_key: idempotencyKey,
                object: {
                    type: 'DISCOUNT',
                    id: `#${tier.tier_code}`,  // Temporary ID for new objects
                    discount_data: discountData
                }
            };
        }

        const response = await squareApiModule.makeSquareRequest('/v2/catalog/object', {
            method: 'POST',
            accessToken,
            body: JSON.stringify(requestBody)
        });

        const discountId = response.catalog_object?.id;

        if (discountId && discountId !== tier.square_discount_id) {
            // Update our database with the new Square ID
            await db.query(`
                UPDATE expiry_discount_tiers
                SET square_discount_id = $1, updated_at = NOW()
                WHERE id = $2
            `, [discountId, tier.id]);
        }

        logger.info('Square discount object upserted', {
            tierCode: tier.tier_code,
            discountId,
            version: response.catalog_object?.version
        });

        return {
            success: true,
            discountId,
            catalogObject: response.catalog_object
        };

    } catch (error) {
        logger.error('Failed to upsert Square discount', {
            tierCode: tier.tier_code,
            error: error.message
        });
        throw error;
    }
}

/**
 * Initialize Square discount objects for all auto-apply tiers
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Object>} Initialization results
 */
async function initializeSquareDiscounts(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for initializeSquareDiscounts');
    }

    logger.info('Initializing Square discount objects', { merchantId });

    const results = {
        created: [],
        updated: [],
        errors: []
    };

    try {
        // Get all tiers that need Square discounts (auto-apply only) for this merchant
        const tiersResult = await db.query(`
            SELECT * FROM expiry_discount_tiers
            WHERE is_active = TRUE AND is_auto_apply = TRUE AND merchant_id = $1
            ORDER BY priority DESC
        `, [merchantId]);

        for (const tier of tiersResult.rows) {
            try {
                const wasNew = !tier.square_discount_id;
                const result = await upsertSquareDiscount(tier);

                if (wasNew) {
                    results.created.push({
                        tierCode: tier.tier_code,
                        discountId: result.discountId
                    });
                } else {
                    results.updated.push({
                        tierCode: tier.tier_code,
                        discountId: result.discountId
                    });
                }
            } catch (error) {
                results.errors.push({
                    tierCode: tier.tier_code,
                    error: error.message
                });
            }
        }

        logger.info('Square discount initialization complete', {
            created: results.created.length,
            updated: results.updated.length,
            errors: results.errors.length
        });

        return results;

    } catch (error) {
        logger.error('Square discount initialization failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Get items that need discount application (tier changed to an auto-apply tier)
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Array>} Array of variations needing discount updates
 */
async function getVariationsNeedingDiscountUpdate(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getVariationsNeedingDiscountUpdate');
    }
    const result = await db.query(`
        SELECT
            vds.variation_id,
            vds.current_tier_id,
            vds.original_price_cents,
            vds.discounted_price_cents,
            vds.discount_applied_at,
            v.price_money as current_square_price,
            edt.tier_code,
            edt.discount_percent,
            edt.is_auto_apply,
            edt.square_discount_id
        FROM variation_discount_status vds
        JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id AND edt.merchant_id = $1
        JOIN variations v ON vds.variation_id = v.id AND vds.merchant_id = $1 AND v.merchant_id = $1
        WHERE edt.is_auto_apply = TRUE
          AND edt.square_discount_id IS NOT NULL
          AND v.is_deleted = FALSE
    `, [merchantId]);

    return result.rows;
}

/**
 * Update Square discount object with list of item IDs to apply to
 * @param {string} tierCode - Tier code (e.g., 'AUTO50')
 * @param {Array<string>} variationIds - Array of variation IDs
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Object>} Update result
 */
async function updateDiscountAppliesTo(tierCode, variationIds, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateDiscountAppliesTo');
    }

    const squareApiModule = getSquareApi();
    const accessToken = await squareApiModule.getMerchantToken(merchantId);

    logger.info('Updating discount applies_to list', {
        tierCode,
        variationCount: variationIds.length,
        merchantId
    });

    try {
        // Get the tier and its Square discount ID
        const tier = await getTierByCode(tierCode, merchantId);

        if (!tier || !tier.square_discount_id) {
            throw new Error(`No Square discount found for tier: ${tierCode}`);
        }

        // Fetch current discount object
        const retrieveData = await squareApiModule.makeSquareRequest(
            `/v2/catalog/object/${tier.square_discount_id}?include_related_objects=false`,
            { accessToken }
        );

        if (!retrieveData.object) {
            throw new Error(`Discount object not found: ${tier.square_discount_id}`);
        }

        const currentObject = retrieveData.object;
        const idempotencyKey = squareApiModule.generateIdempotencyKey(`discount-items-${tierCode}`);

        // Build update with pricing rules
        // Note: Square item-level discounts work by creating pricing rules
        // that reference the discount and specify which items it applies to

        const requestBody = {
            idempotency_key: idempotencyKey,
            object: {
                type: 'DISCOUNT',
                id: tier.square_discount_id,
                version: currentObject.version,
                discount_data: {
                    ...currentObject.discount_data,
                    // Item-level discounts in Square can use modify_tax_basis
                    // and product_set_data to target specific items
                }
            }
        };

        const response = await squareApiModule.makeSquareRequest('/v2/catalog/object', {
            method: 'POST',
            accessToken,
            body: JSON.stringify(requestBody)
        });

        logger.info('Discount applies_to updated', {
            tierCode,
            discountId: tier.square_discount_id,
            variationCount: variationIds.length
        });

        return {
            success: true,
            discountId: tier.square_discount_id,
            variationIds
        };

    } catch (error) {
        logger.error('Failed to update discount applies_to', {
            tierCode,
            error: error.message
        });
        throw error;
    }
}

/**
 * Apply discounts to variations based on their current tier
 * Uses Square Pricing Rules to apply item-level discounts
 * @param {Object} options - Options
 * @param {number} options.merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @param {boolean} options.dryRun - If true, don't make any changes
 * @returns {Promise<Object>} Application results
 */
async function applyDiscounts(options = {}) {
    const { merchantId, dryRun = false } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for applyDiscounts');
    }

    const squareApiModule = getSquareApi();

    logger.info('Applying discounts to variations', { merchantId, dryRun });

    const results = {
        applied: [],
        removed: [],
        unchanged: [],
        errors: []
    };

    try {
        // Get all tiers with auto-apply for this merchant
        const tiersResult = await db.query(`
            SELECT * FROM expiry_discount_tiers
            WHERE is_active = TRUE AND is_auto_apply = TRUE AND merchant_id = $1
            ORDER BY priority DESC
        `, [merchantId]);

        for (const tier of tiersResult.rows) {
            // Get variations currently in this tier for this merchant
            const variationsResult = await db.query(`
                SELECT
                    vds.variation_id,
                    vds.original_price_cents,
                    v.price_money as current_price_cents,
                    v.sku,
                    i.name as item_name
                FROM variation_discount_status vds
                JOIN variations v ON vds.variation_id = v.id AND vds.merchant_id = $1 AND v.merchant_id = $1
                JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
                WHERE vds.current_tier_id = $2
                  AND v.is_deleted = FALSE
            `, [merchantId, tier.id]);

            const variationIds = variationsResult.rows.map(r => r.variation_id);

            logger.info(`Processing ${tier.tier_code} tier`, {
                variationCount: variationIds.length,
                discountPercent: tier.discount_percent
            });

            // For item-level discounts in Square, we need to create/update
            // a PRICING_RULE that applies the discount to specific items
            // IMPORTANT: We must update the pricing rule even if variationIds is empty,
            // to clear out items that moved to other tiers
            if (!dryRun && tier.square_discount_id) {
                try {
                    // Create/update pricing rule for this tier
                    // This will REPLACE the product set, removing items that moved to other tiers
                    const pricingRuleResult = await upsertPricingRule(tier, variationIds);

                    // If no variations in this tier, we're done (pricing rule was cleared)
                    if (variationIds.length === 0) {
                        logger.info(`Cleared pricing rule for empty tier ${tier.tier_code}`);
                        continue;
                    }

                    // Update local records
                    for (const row of variationsResult.rows) {
                        const originalPrice = row.original_price_cents || row.current_price_cents;
                        const discountedPrice = Math.round(originalPrice * (1 - tier.discount_percent / 100));

                        await db.query(`
                            UPDATE variation_discount_status
                            SET discounted_price_cents = $1,
                                discount_applied_at = NOW(),
                                updated_at = NOW()
                            WHERE variation_id = $2
                        `, [discountedPrice, row.variation_id]);

                        results.applied.push({
                            variationId: row.variation_id,
                            itemName: row.item_name,
                            sku: row.sku,
                            tierCode: tier.tier_code,
                            originalPrice: originalPrice,
                            discountedPrice: discountedPrice,
                            discountPercent: tier.discount_percent
                        });

                        await logAuditEvent({
                            merchantId,
                            variationId: row.variation_id,
                            action: 'DISCOUNT_APPLIED',
                            newTierId: tier.id,
                            oldPriceCents: originalPrice,
                            newPriceCents: discountedPrice,
                            squareSyncStatus: 'SUCCESS',
                            triggeredBy: 'SYSTEM'
                        });
                    }
                } catch (error) {
                    results.errors.push({
                        tierCode: tier.tier_code,
                        error: error.message
                    });
                    logger.error('Failed to apply discount for tier', {
                        tierCode: tier.tier_code,
                        error: error.message
                    });
                }
            }
        }

        // Handle removing discounts from items no longer in auto-apply tiers
        // (e.g., moved to OK or EXPIRED)
        const removedResult = await db.query(`
            SELECT
                vds.variation_id,
                vds.original_price_cents,
                vds.discounted_price_cents,
                vds.discount_applied_at,
                edt.tier_code,
                edt.is_auto_apply
            FROM variation_discount_status vds
            JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id AND edt.merchant_id = $1
            WHERE vds.merchant_id = $1
              AND vds.discount_applied_at IS NOT NULL
              AND edt.is_auto_apply = FALSE
        `, [merchantId]);

        if (removedResult.rows.length > 0 && !dryRun) {
            logger.info('Removing discounts from items no longer in auto-apply tiers', {
                count: removedResult.rows.length
            });

            for (const row of removedResult.rows) {
                // Remove from pricing rules (will be handled by updating rules above)
                await db.query(`
                    UPDATE variation_discount_status
                    SET discounted_price_cents = NULL,
                        discount_applied_at = NULL,
                        updated_at = NOW()
                    WHERE variation_id = $1
                `, [row.variation_id]);

                results.removed.push({
                    variationId: row.variation_id,
                    tierCode: row.tier_code
                });

                await logAuditEvent({
                    merchantId,
                    variationId: row.variation_id,
                    action: 'DISCOUNT_REMOVED',
                    oldPriceCents: row.discounted_price_cents,
                    newPriceCents: row.original_price_cents,
                    squareSyncStatus: 'SUCCESS',
                    triggeredBy: 'SYSTEM'
                });
            }
        }

        logger.info('Discount application complete', {
            applied: results.applied.length,
            removed: results.removed.length,
            errors: results.errors.length
        });

        return results;

    } catch (error) {
        logger.error('Discount application failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Filter variation IDs to only include those that exist in Square catalog
 * This handles cases where variations were deleted in Square but still exist in our DB
 * @param {Array<string>} variationIds - Array of variation IDs to check
 * @param {string} accessToken - Square API access token
 * @param {number} merchantId - Merchant ID for logging
 * @returns {Promise<Object>} Object with validIds array and invalidIds array
 */
async function filterValidVariations(variationIds, accessToken, merchantId) {
    if (variationIds.length === 0) {
        return { validIds: [], invalidIds: [] };
    }

    const squareApiModule = getSquareApi();
    const validIds = [];
    const invalidIds = [];

    // Square batch retrieve has a limit of 1000 objects per request
    const batchSize = 1000;
    for (let i = 0; i < variationIds.length; i += batchSize) {
        const batch = variationIds.slice(i, i + batchSize);

        try {
            const response = await squareApiModule.makeSquareRequest('/v2/catalog/batch-retrieve', {
                method: 'POST',
                accessToken,
                body: JSON.stringify({
                    object_ids: batch,
                    include_deleted_objects: false
                })
            });

            // Get the IDs that were actually returned (exist in Square)
            const returnedIds = new Set((response.objects || []).map(obj => obj.id));

            for (const id of batch) {
                if (returnedIds.has(id)) {
                    validIds.push(id);
                } else {
                    invalidIds.push(id);
                }
            }
        } catch (error) {
            logger.warn('Error validating variations batch, assuming all valid', {
                merchantId,
                batchStart: i,
                error: error.message
            });
            // On error, include all to avoid data loss
            validIds.push(...batch);
        }
    }

    if (invalidIds.length > 0) {
        logger.info('Filtered out invalid/deleted variations', {
            merchantId,
            validCount: validIds.length,
            invalidCount: invalidIds.length,
            invalidIds: invalidIds.slice(0, 10) // Log first 10 for debugging
        });

        // Mark these as deleted in our database
        if (invalidIds.length > 0) {
            try {
                await db.query(`
                    UPDATE variations SET is_deleted = TRUE, updated_at = NOW()
                    WHERE id = ANY($1) AND merchant_id = $2
                `, [invalidIds, merchantId]);

                // Also remove from variation_discount_status
                await db.query(`
                    DELETE FROM variation_discount_status
                    WHERE variation_id = ANY($1) AND merchant_id = $2
                `, [invalidIds, merchantId]);

                logger.info('Cleaned up deleted variations from database', {
                    merchantId,
                    cleanedCount: invalidIds.length
                });
            } catch (dbError) {
                logger.warn('Failed to clean up deleted variations', {
                    merchantId,
                    error: dbError.message
                });
            }
        }
    }

    return { validIds, invalidIds };
}

/**
 * Create or update a Square Pricing Rule for item-level discounts
 * @param {Object} tier - Tier configuration with square_discount_id
 * @param {Array<string>} variationIds - Variation IDs to apply discount to
 * @returns {Promise<Object>} Pricing rule result
 */
async function upsertPricingRule(tier, variationIds) {
    const squareApiModule = getSquareApi();
    const accessToken = await squareApiModule.getMerchantToken(tier.merchant_id);

    const pricingRuleKey = `expiry-${tier.tier_code.toLowerCase()}`;

    // Filter out any variations that no longer exist in Square
    const { validIds, invalidIds } = await filterValidVariations(variationIds, accessToken, tier.merchant_id);

    logger.info('Upserting pricing rule', {
        tierCode: tier.tier_code,
        pricingRuleKey,
        originalCount: variationIds.length,
        validCount: validIds.length,
        filteredOut: invalidIds.length,
        merchantId: tier.merchant_id
    });

    // Use validIds instead of variationIds from here on
    variationIds = validIds;

    try {
        // Check if pricing rule already exists
        let existingRule = null;
        let existingProductSet = null;

        // Search for existing pricing rule by name
        const searchResult = await squareApiModule.makeSquareRequest('/v2/catalog/search', {
            method: 'POST',
            accessToken,
            body: JSON.stringify({
                object_types: ['PRICING_RULE', 'PRODUCT_SET'],
                query: {
                    prefix_query: {
                        attribute_name: 'name',
                        attribute_prefix: pricingRuleKey
                    }
                }
            })
        });

        for (const obj of (searchResult.objects || [])) {
            if (obj.type === 'PRICING_RULE' && obj.pricing_rule_data?.name === pricingRuleKey) {
                existingRule = obj;
            }
            if (obj.type === 'PRODUCT_SET' && obj.product_set_data?.name === `${pricingRuleKey}-products`) {
                existingProductSet = obj;
            }
        }

        // If no variations and existing rule exists, delete the pricing rule to clear it
        if (variationIds.length === 0) {
            if (existingRule || existingProductSet) {
                logger.info('Deleting pricing rule for empty tier', {
                    tierCode: tier.tier_code,
                    hasRule: !!existingRule,
                    hasProductSet: !!existingProductSet
                });

                const objectsToDelete = [];
                if (existingRule?.id) objectsToDelete.push(existingRule.id);
                if (existingProductSet?.id) objectsToDelete.push(existingProductSet.id);

                if (objectsToDelete.length > 0) {
                    const deleteResult = await deleteCatalogObjects(
                        tier.merchant_id,
                        objectsToDelete,
                        { auditContext: `expiry-tier-clear-${tier.tier_code}` }
                    );
                    if (!deleteResult.success) {
                        logger.warn('Failed to delete pricing rule objects', {
                            tierCode: tier.tier_code,
                            errors: deleteResult.errors,
                        });
                    }
                }
            }

            return {
                success: true,
                pricingRule: null,
                message: 'No variations - pricing rule cleared'
            };
        }

        const idempotencyKey = squareApiModule.generateIdempotencyKey(`pricing-rule-${tier.tier_code}`);

        // Build the batch upsert with both product set and pricing rule
        const batches = [];
        const objects = [];

        // Product Set - defines which items the discount applies to
        const productSetId = existingProductSet?.id || `#${pricingRuleKey}-products`;
        objects.push({
            type: 'PRODUCT_SET',
            id: productSetId,
            version: existingProductSet?.version,
            product_set_data: {
                name: `${pricingRuleKey}-products`,
                product_ids_any: variationIds  // Apply to any of these variations
            }
        });

        // Pricing Rule - applies the discount to the product set
        const pricingRuleId = existingRule?.id || `#${pricingRuleKey}`;
        objects.push({
            type: 'PRICING_RULE',
            id: pricingRuleId,
            version: existingRule?.version,
            pricing_rule_data: {
                name: pricingRuleKey,
                discount_id: tier.square_discount_id,
                match_products_id: productSetId.startsWith('#') ? productSetId : existingProductSet?.id
            }
        });

        const response = await squareApiModule.makeSquareRequest('/v2/catalog/batch-upsert', {
            method: 'POST',
            accessToken,
            body: JSON.stringify({
                idempotency_key: idempotencyKey,
                batches: [{ objects }]
            })
        });

        // Store the pricing rule ID in the tier record
        const createdRule = response.objects?.find(o => o.type === 'PRICING_RULE');
        if (createdRule) {
            await db.query(`
                UPDATE expiry_discount_tiers
                SET updated_at = NOW()
                WHERE id = $1
            `, [tier.id]);
        }

        logger.info('Pricing rule upserted', {
            tierCode: tier.tier_code,
            pricingRuleId: createdRule?.id,
            productSetId: response.objects?.find(o => o.type === 'PRODUCT_SET')?.id
        });

        return {
            success: true,
            pricingRule: createdRule,
            objects: response.objects
        };

    } catch (error) {
        logger.error('Failed to upsert pricing rule', {
            tierCode: tier.tier_code,
            error: error.message
        });
        throw error;
    }
}

/**
 * Run the full expiry discount automation
 * This is called by the cron job
 * @param {Object} options - Options
 * @param {number} options.merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @param {boolean} options.dryRun - If true, don't make any changes
 * @returns {Promise<Object>} Full automation results
 */
async function runExpiryDiscountAutomation(options = {}) {
    const { merchantId, dryRun = false } = options;

    if (!merchantId) {
        throw new Error('merchantId is required for runExpiryDiscountAutomation');
    }

    logger.info('Starting expiry discount automation', { merchantId, dryRun });

    const startTime = Date.now();
    const results = {
        success: true,
        startTime: new Date().toISOString(),
        evaluation: null,
        discountInit: null,
        discountApplication: null,
        duration: 0,
        errors: []
    };

    try {
        // Step 1: Initialize/verify Square discount objects
        if (!dryRun) {
            try {
                results.discountInit = await initializeSquareDiscounts(merchantId);
            } catch (error) {
                results.errors.push({ step: 'discountInit', error: error.message });
                logger.error('Discount initialization failed', { error: error.message, stack: error.stack });
            }
        }

        // Step 2: Evaluate all variations and assign tiers
        results.evaluation = await evaluateAllVariations({
            merchantId,
            dryRun,
            triggeredBy: 'CRON'
        });

        if (results.evaluation.errors.length > 0) {
            results.errors.push(...results.evaluation.errors.map(e => ({
                step: 'evaluation',
                ...e
            })));
        }

        // Step 3: Apply discounts based on tier assignments
        if (!dryRun) {
            try {
                results.discountApplication = await applyDiscounts({ merchantId, dryRun });
            } catch (error) {
                results.errors.push({ step: 'discountApplication', error: error.message });
                logger.error('Discount application failed', { error: error.message, stack: error.stack });
            }
        }

        // Update last run timestamp
        if (!dryRun) {
            await updateSetting('last_run_at', new Date().toISOString(), merchantId);
        }

        results.duration = Date.now() - startTime;
        results.success = results.errors.length === 0;

        logger.info('Expiry discount automation complete', {
            merchantId,
            success: results.success,
            duration: results.duration,
            tierChanges: results.evaluation?.tierChanges?.length || 0,
            newAssignments: results.evaluation?.newAssignments?.length || 0,
            discountsApplied: results.discountApplication?.applied?.length || 0,
            errors: results.errors.length
        });

        return results;

    } catch (error) {
        results.success = false;
        results.errors.push({ step: 'main', error: error.message });
        results.duration = Date.now() - startTime;

        logger.error('Expiry discount automation failed', {
            error: error.message,
            stack: error.stack
        });

        return results;
    }
}

/**
 * Get summary of current discount status
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @returns {Promise<Object>} Status summary
 */
async function getDiscountStatusSummary(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getDiscountStatusSummary');
    }

    const summaryResult = await db.query(`
        SELECT
            edt.tier_code,
            edt.tier_name,
            edt.discount_percent,
            edt.color_code,
            edt.is_auto_apply,
            edt.requires_review,
            COUNT(vds.variation_id) as variation_count,
            SUM(CASE WHEN vds.needs_pull THEN 1 ELSE 0 END) as needs_pull_count,
            SUM(CASE WHEN vds.discount_applied_at IS NOT NULL THEN 1 ELSE 0 END) as discount_applied_count
        FROM expiry_discount_tiers edt
        LEFT JOIN variation_discount_status vds ON edt.id = vds.current_tier_id
        LEFT JOIN variations v ON vds.variation_id = v.id AND v.merchant_id = $1
        LEFT JOIN (
            SELECT catalog_object_id, SUM(quantity) as total_stock
            FROM inventory_counts
            WHERE state = 'IN_STOCK'
            GROUP BY catalog_object_id
        ) ic ON vds.variation_id = ic.catalog_object_id
        WHERE edt.is_active = TRUE AND edt.merchant_id = $1
          AND (vds.variation_id IS NULL OR COALESCE(v.is_deleted, FALSE) = FALSE)
          AND (vds.variation_id IS NULL OR COALESCE(ic.total_stock, 0) > 0)
        GROUP BY edt.id, edt.tier_code, edt.tier_name, edt.discount_percent,
                 edt.color_code, edt.is_auto_apply, edt.requires_review, edt.priority
        ORDER BY edt.priority DESC
    `, [merchantId]);

    const lastRunAt = await getSetting('last_run_at', merchantId);

    return {
        tiers: summaryResult.rows,
        lastRunAt,
        totalWithDiscounts: summaryResult.rows.reduce((sum, r) =>
            sum + (r.is_auto_apply ? parseInt(r.variation_count) : 0), 0
        ),
        totalNeedingPull: summaryResult.rows.reduce((sum, r) =>
            sum + parseInt(r.needs_pull_count || 0), 0
        )
    };
}

/**
 * Get variations in a specific tier with details
 * @param {string} tierCode - Tier code
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Variations in tier
 */
async function getVariationsInTier(tierCode, merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getVariationsInTier');
    }

    const { limit = 100, offset = 0 } = options;

    const result = await db.query(`
        SELECT
            vds.variation_id,
            vds.days_until_expiry,
            vds.original_price_cents,
            vds.discounted_price_cents,
            vds.discount_applied_at,
            vds.needs_pull,
            v.sku,
            v.name as variation_name,
            v.price_money as current_price_cents,
            i.name as item_name,
            i.id as item_id,
            ve.expiration_date,
            edt.tier_code,
            edt.tier_name,
            edt.discount_percent,
            edt.color_code
        FROM variation_discount_status vds
        JOIN variations v ON vds.variation_id = v.id AND vds.merchant_id = $1 AND v.merchant_id = $1
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id AND edt.merchant_id = $1
        LEFT JOIN variation_expiration ve ON v.id = ve.variation_id AND ve.merchant_id = $1
        WHERE edt.tier_code = $2
          AND v.is_deleted = FALSE
        ORDER BY vds.days_until_expiry ASC
        LIMIT $3 OFFSET $4
    `, [merchantId, tierCode, limit, offset]);

    return result.rows;
}

/**
 * Get recent audit log entries
 * @param {number} merchantId - REQUIRED: Merchant ID for multi-tenant filtering
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Audit log entries
 */
async function getAuditLog(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getAuditLog');
    }

    const { limit = 100, variationId = null } = options;

    let query = `
        SELECT
            al.*,
            v.sku,
            v.name as variation_name,
            i.name as item_name,
            old_tier.tier_code as old_tier_code,
            new_tier.tier_code as new_tier_code
        FROM expiry_discount_audit_log al
        LEFT JOIN variations v ON al.variation_id = v.id AND v.merchant_id = $1
        LEFT JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        LEFT JOIN expiry_discount_tiers old_tier ON al.old_tier_id = old_tier.id
        LEFT JOIN expiry_discount_tiers new_tier ON al.new_tier_id = new_tier.id
        WHERE al.merchant_id = $1
    `;

    const params = [merchantId];

    if (variationId) {
        query += ` AND al.variation_id = $2`;
        params.push(variationId);
    }

    query += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await db.query(query, params);
    return result.rows;
}

/**
 * Initialize default discount tiers for a new merchant
 * Creates the standard tier configuration if merchant has no tiers
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Result with created tiers
 */
async function initializeDefaultTiers(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for initializeDefaultTiers');
    }

    // Check if merchant already has tiers
    const existingTiers = await db.query(
        'SELECT COUNT(*) as count FROM expiry_discount_tiers WHERE merchant_id = $1',
        [merchantId]
    );

    if (parseInt(existingTiers.rows[0].count) > 0) {
        logger.info('Merchant already has discount tiers configured', { merchantId });
        return { created: false, message: 'Tiers already exist' };
    }

    logger.info('Creating default discount tiers for merchant', { merchantId });

    // Insert default tiers for this merchant
    const defaultTiers = [
        { tier_code: 'EXPIRED', tier_name: 'Expired - Pull from Shelf', min_days: null, max_days: 0, discount: 0, auto_apply: false, requires_review: false, color: '#991b1b', priority: 100 },
        { tier_code: 'AUTO50', tier_name: '50% Off - Critical Expiry', min_days: 1, max_days: 30, discount: 50, auto_apply: true, requires_review: false, color: '#dc2626', priority: 90 },
        { tier_code: 'AUTO25', tier_name: '25% Off - Approaching Expiry', min_days: 31, max_days: 89, discount: 25, auto_apply: true, requires_review: false, color: '#f59e0b', priority: 80 },
        { tier_code: 'REVIEW', tier_name: 'Review - Monitor Expiry', min_days: 90, max_days: 120, discount: 0, auto_apply: false, requires_review: true, color: '#3b82f6', priority: 70 },
        { tier_code: 'OK', tier_name: 'OK - No Action Needed', min_days: 121, max_days: null, discount: 0, auto_apply: false, requires_review: false, color: '#059669', priority: 10 }
    ];

    for (const tier of defaultTiers) {
        await db.query(`
            INSERT INTO expiry_discount_tiers (
                merchant_id, tier_code, tier_name, min_days_to_expiry, max_days_to_expiry,
                discount_percent, is_auto_apply, requires_review, color_code, priority, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
        `, [merchantId, tier.tier_code, tier.tier_name, tier.min_days, tier.max_days,
            tier.discount, tier.auto_apply, tier.requires_review, tier.color, tier.priority]);
    }

    // Also insert default settings for this merchant
    const defaultSettings = [
        { key: 'cron_schedule', value: '0 6 * * *', desc: 'Cron schedule for daily expiry evaluation (default: 6:00 AM)' },
        { key: 'timezone', value: 'America/Toronto', desc: 'Timezone for expiry calculations (EST)' },
        { key: 'auto_apply_enabled', value: 'true', desc: 'Whether to automatically apply discounts' },
        { key: 'email_notifications', value: 'true', desc: 'Send email alerts for tier changes' }
    ];

    for (const setting of defaultSettings) {
        await db.query(`
            INSERT INTO expiry_discount_settings (merchant_id, setting_key, setting_value, description)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (setting_key, merchant_id) DO NOTHING
        `, [merchantId, setting.key, setting.value, setting.desc]);
    }

    logger.info('Default discount tiers created for merchant', { merchantId, tierCount: defaultTiers.length });

    return { created: true, tierCount: defaultTiers.length };
}

/**
 * Ensure merchant has discount tiers, creating defaults if needed
 * Call this on first access to expiry-discounts page
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Result
 */
async function ensureMerchantTiers(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for ensureMerchantTiers');
    }

    const tiers = await getActiveTiers(merchantId);
    if (tiers.length === 0) {
        return await initializeDefaultTiers(merchantId);
    }
    return { created: false, tierCount: tiers.length };
}

/**
 * Validate and verify expiry discount configuration in Square
 * Checks that discount percentages match and pricing rules are correctly configured
 * @param {Object} options - Options
 * @param {number} options.merchantId - REQUIRED: Merchant ID
 * @param {boolean} [options.fix=false] - Whether to fix issues found
 * @returns {Promise<Object>} Validation results
 */
async function validateExpiryDiscounts({ merchantId, fix = false }) {
    if (!merchantId) {
        throw new Error('merchantId is required for validateExpiryDiscounts');
    }

    const squareApiModule = getSquareApi();
    const accessToken = await squareApiModule.getMerchantToken(merchantId);

    logger.info('Validating expiry discounts', { merchantId, fix });

    const results = {
        success: true,
        tiersChecked: 0,
        issues: [],
        fixed: []
    };

    try {
        // Get all auto-apply tiers
        const tiersResult = await db.query(`
            SELECT * FROM expiry_discount_tiers
            WHERE is_active = TRUE AND is_auto_apply = TRUE AND merchant_id = $1
            ORDER BY priority DESC
        `, [merchantId]);

        for (const tier of tiersResult.rows) {
            results.tiersChecked++;

            // Check 1: Verify Square discount object exists and has correct percentage
            if (tier.square_discount_id) {
                try {
                    const discountData = await squareApiModule.makeSquareRequest(
                        `/v2/catalog/object/${tier.square_discount_id}?include_related_objects=false`,
                        { accessToken }
                    );

                    const discountObj = discountData.object;
                    if (!discountObj) {
                        results.issues.push({
                            tierCode: tier.tier_code,
                            issue: 'DISCOUNT_NOT_FOUND',
                            message: 'Discount object not found in Square',
                            squareDiscountId: tier.square_discount_id
                        });

                        if (fix) {
                            // Clear stale ID and recreate
                            await db.query(`
                                UPDATE expiry_discount_tiers
                                SET square_discount_id = NULL, updated_at = NOW()
                                WHERE id = $1
                            `, [tier.id]);
                            tier.square_discount_id = null;
                            const createResult = await upsertSquareDiscount(tier);
                            if (createResult.success) {
                                results.fixed.push({
                                    tierCode: tier.tier_code,
                                    action: 'RECREATED_DISCOUNT',
                                    newDiscountId: createResult.discountId
                                });
                            }
                        }
                    } else if (discountObj.is_deleted) {
                        results.issues.push({
                            tierCode: tier.tier_code,
                            issue: 'DISCOUNT_DELETED',
                            message: 'Discount object was deleted in Square'
                        });

                        if (fix) {
                            await db.query(`
                                UPDATE expiry_discount_tiers
                                SET square_discount_id = NULL, updated_at = NOW()
                                WHERE id = $1
                            `, [tier.id]);
                            tier.square_discount_id = null;
                            const createResult = await upsertSquareDiscount(tier);
                            if (createResult.success) {
                                results.fixed.push({
                                    tierCode: tier.tier_code,
                                    action: 'RECREATED_DELETED_DISCOUNT',
                                    newDiscountId: createResult.discountId
                                });
                            }
                        }
                    } else {
                        // Verify percentage matches
                        const squarePercent = parseFloat(discountObj.discount_data?.percentage || '0');
                        const expectedPercent = parseFloat(tier.discount_percent);

                        if (Math.abs(squarePercent - expectedPercent) > 0.01) {
                            results.issues.push({
                                tierCode: tier.tier_code,
                                issue: 'PERCENTAGE_MISMATCH',
                                message: `Square has ${squarePercent}% but should be ${expectedPercent}%`,
                                squarePercent,
                                expectedPercent
                            });

                            if (fix) {
                                const updateResult = await upsertSquareDiscount(tier);
                                if (updateResult.success) {
                                    results.fixed.push({
                                        tierCode: tier.tier_code,
                                        action: 'UPDATED_PERCENTAGE',
                                        oldPercent: squarePercent,
                                        newPercent: expectedPercent
                                    });
                                }
                            }
                        }
                    }
                } catch (error) {
                    results.issues.push({
                        tierCode: tier.tier_code,
                        issue: 'API_ERROR',
                        message: error.message
                    });
                }
            } else {
                results.issues.push({
                    tierCode: tier.tier_code,
                    issue: 'MISSING_SQUARE_ID',
                    message: 'No Square discount ID configured'
                });

                if (fix) {
                    const createResult = await upsertSquareDiscount(tier);
                    if (createResult.success) {
                        results.fixed.push({
                            tierCode: tier.tier_code,
                            action: 'CREATED_DISCOUNT',
                            newDiscountId: createResult.discountId
                        });
                    }
                }
            }

            // Check 2: Verify pricing rule exists and has correct products
            const pricingRuleKey = `expiry-${tier.tier_code.toLowerCase()}`;
            try {
                const searchResult = await squareApiModule.makeSquareRequest('/v2/catalog/search', {
                    method: 'POST',
                    accessToken,
                    body: JSON.stringify({
                        object_types: ['PRICING_RULE', 'PRODUCT_SET'],
                        query: {
                            prefix_query: {
                                attribute_name: 'name',
                                attribute_prefix: pricingRuleKey
                            }
                        }
                    })
                });

                let existingRule = null;
                let existingProductSet = null;
                for (const obj of (searchResult.objects || [])) {
                    if (obj.type === 'PRICING_RULE' && obj.pricing_rule_data?.name === pricingRuleKey) {
                        existingRule = obj;
                    }
                    if (obj.type === 'PRODUCT_SET' && obj.product_set_data?.name === `${pricingRuleKey}-products`) {
                        existingProductSet = obj;
                    }
                }

                // Get expected variations for this tier
                const variationsResult = await db.query(`
                    SELECT variation_id FROM variation_discount_status
                    WHERE current_tier_id = $1 AND merchant_id = $2
                `, [tier.id, merchantId]);
                const expectedVariations = variationsResult.rows.map(r => r.variation_id);

                if (expectedVariations.length > 0) {
                    if (!existingRule) {
                        results.issues.push({
                            tierCode: tier.tier_code,
                            issue: 'MISSING_PRICING_RULE',
                            message: `Pricing rule not found but ${expectedVariations.length} items should have this discount`
                        });

                        if (fix) {
                            const ruleResult = await upsertPricingRule(tier, expectedVariations);
                            if (ruleResult.success) {
                                results.fixed.push({
                                    tierCode: tier.tier_code,
                                    action: 'CREATED_PRICING_RULE',
                                    variationCount: expectedVariations.length
                                });
                            }
                        }
                    } else if (existingProductSet) {
                        // Compare product sets
                        const squareProducts = existingProductSet.product_set_data?.product_ids_any || [];
                        const missingInSquare = expectedVariations.filter(v => !squareProducts.includes(v));
                        const extraInSquare = squareProducts.filter(v => !expectedVariations.includes(v));

                        if (missingInSquare.length > 0 || extraInSquare.length > 0) {
                            results.issues.push({
                                tierCode: tier.tier_code,
                                issue: 'PRODUCT_SET_MISMATCH',
                                message: `Product set mismatch: ${missingInSquare.length} missing, ${extraInSquare.length} extra`,
                                missingInSquare: missingInSquare.slice(0, 5),
                                extraInSquare: extraInSquare.slice(0, 5)
                            });

                            if (fix) {
                                const ruleResult = await upsertPricingRule(tier, expectedVariations);
                                if (ruleResult.success) {
                                    results.fixed.push({
                                        tierCode: tier.tier_code,
                                        action: 'UPDATED_PRODUCT_SET',
                                        addedCount: missingInSquare.length,
                                        removedCount: extraInSquare.length
                                    });
                                }
                            }
                        }
                    }
                } else if (existingRule) {
                    // Tier has no items but pricing rule exists - should be deleted
                    results.issues.push({
                        tierCode: tier.tier_code,
                        issue: 'ORPHAN_PRICING_RULE',
                        message: 'Pricing rule exists but tier has no items'
                    });

                    if (fix) {
                        const ruleResult = await upsertPricingRule(tier, []);
                        if (ruleResult.success) {
                            results.fixed.push({
                                tierCode: tier.tier_code,
                                action: 'DELETED_ORPHAN_RULE'
                            });
                        }
                    }
                }
            } catch (error) {
                results.issues.push({
                    tierCode: tier.tier_code,
                    issue: 'PRICING_RULE_API_ERROR',
                    message: error.message
                });
            }
        }

        logger.info('Expiry discount validation complete', {
            merchantId,
            tiersChecked: results.tiersChecked,
            issueCount: results.issues.length,
            fixedCount: results.fixed.length
        });

        return results;

    } catch (error) {
        logger.error('Expiry discount validation failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Clear expiry discount for a variation when it's being reordered
 *
 * Note: Discount catalog object deletion is consolidated in utils/square-catalog-cleanup.js
 * (BACKLOG-6, completed 2026-02-06). Both the loyalty and expiry systems use
 * deleteCatalogObjects() for Square cleanup.
 *
 * This function resets the variation's discount status to the OK tier and clears
 * the expiration date. The next applyDiscounts() call will rebuild the Square
 * pricing rules without this variation.
 *
 * @param {number} merchantId - Merchant ID
 * @param {string} variationId - Variation ID to clear
 * @returns {Promise<{cleared: boolean, previousTier: string|null, message: string}>}
 */
async function clearExpiryDiscountForReorder(merchantId, variationId) {
    if (!merchantId) {
        throw new Error('merchantId is required for clearExpiryDiscountForReorder');
    }
    if (!variationId) {
        throw new Error('variationId is required for clearExpiryDiscountForReorder');
    }

    try {
        // Get current discount status and tier info
        const statusResult = await db.query(`
            SELECT
                vds.id as status_id,
                vds.current_tier_id,
                vds.discounted_price_cents,
                vds.original_price_cents,
                vds.discount_applied_at,
                edt.tier_code,
                edt.is_auto_apply
            FROM variation_discount_status vds
            JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
            WHERE vds.variation_id = $1 AND vds.merchant_id = $2
        `, [variationId, merchantId]);

        // If no status record or not in an auto-apply tier, nothing to clear
        if (statusResult.rows.length === 0) {
            return { cleared: false, previousTier: null, message: 'No discount status found' };
        }

        const status = statusResult.rows[0];

        // Only clear if in an auto-apply discount tier (AUTO50, AUTO25, EXPIRED)
        if (!status.is_auto_apply || !['AUTO50', 'AUTO25', 'EXPIRED'].includes(status.tier_code)) {
            return { cleared: false, previousTier: status.tier_code, message: 'Not in an auto-apply discount tier' };
        }

        // Get the OK tier ID for this merchant
        const okTierResult = await db.query(`
            SELECT id FROM expiry_discount_tiers
            WHERE tier_code = 'OK' AND merchant_id = $1
        `, [merchantId]);

        if (okTierResult.rows.length === 0) {
            throw new Error('OK tier not found for merchant');
        }

        const okTierId = okTierResult.rows[0].id;

        // Use transaction to atomically update discount status and clear expiry date
        await db.transaction(async (client) => {
            // Reset variation_discount_status to OK tier
            await client.query(`
                UPDATE variation_discount_status SET
                    current_tier_id = $1,
                    discounted_price_cents = NULL,
                    discount_applied_at = NULL,
                    updated_at = NOW()
                WHERE variation_id = $2 AND merchant_id = $3
            `, [okTierId, variationId, merchantId]);

            // Clear expiration date so old date doesn't retrigger
            await client.query(`
                UPDATE variation_expiration SET
                    expiration_date = NULL,
                    updated_at = NOW()
                WHERE variation_id = $1 AND merchant_id = $2
            `, [variationId, merchantId]);

            // Log audit event
            await client.query(`
                INSERT INTO expiry_discount_audit_log (
                    merchant_id, variation_id, action, old_tier_id, new_tier_id,
                    old_price_cents, new_price_cents, days_until_expiry,
                    square_sync_status, triggered_by
                )
                VALUES ($1, $2, 'REORDER_CLEAR', $3, $4, $5, NULL, NULL, 'PENDING', 'REORDER')
            `, [
                merchantId,
                variationId,
                status.current_tier_id,
                okTierId,
                status.discounted_price_cents
            ]);
        });

        logger.info('Cleared expiry discount for reorder', {
            merchantId,
            variationId,
            previousTier: status.tier_code,
            hadDiscount: status.discount_applied_at !== null
        });

        return {
            cleared: true,
            previousTier: status.tier_code,
            message: `Cleared ${status.tier_code} discount and expiry date`
        };

    } catch (error) {
        logger.error('Failed to clear expiry discount for reorder', {
            merchantId,
            variationId,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Get variations flagged for manual review (tier regression detected)
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Array>} Flagged variations with tier info
 */
async function getFlaggedVariations(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getFlaggedVariations');
    }

    const result = await db.query(`
        SELECT
            vds.variation_id,
            vds.days_until_expiry,
            vds.original_price_cents,
            vds.discounted_price_cents,
            vds.needs_manual_review,
            vds.manually_overridden,
            vds.manual_override_at,
            vds.manual_override_note,
            vds.last_evaluated_at,
            v.sku,
            v.name as variation_name,
            i.name as item_name,
            edt.id as current_tier_id,
            edt.tier_code as current_tier_code,
            edt.tier_name as current_tier_name,
            edt.discount_percent as current_discount_percent,
            ve.expiration_date
        FROM variation_discount_status vds
        JOIN variations v ON vds.variation_id = v.id AND v.merchant_id = $1
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
        LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
        LEFT JOIN variation_expiration ve ON v.id = ve.variation_id AND ve.merchant_id = $1
        WHERE vds.needs_manual_review = TRUE AND vds.merchant_id = $1
          AND v.is_deleted = FALSE
        ORDER BY vds.days_until_expiry ASC NULLS LAST
    `, [merchantId]);

    // For each flagged item, also compute what the calculated tier would be
    const tiers = await getActiveTiers(merchantId);
    const timezone = await getSetting('timezone', merchantId) || 'America/Toronto';

    return result.rows.map(row => {
        const calculatedDays = row.expiration_date
            ? calculateDaysUntilExpiry(row.expiration_date, timezone)
            : row.days_until_expiry;
        const calculatedTier = determineTier(calculatedDays, tiers);
        return {
            ...row,
            calculated_tier_code: calculatedTier?.tier_code || null,
            calculated_tier_name: calculatedTier?.tier_name || null,
            calculated_tier_id: calculatedTier?.id || null,
            calculated_discount_percent: calculatedTier?.discount_percent || 0
        };
    });
}

/**
 * Resolve a flagged variation: apply new tier or keep current
 * @param {Object} params
 * @param {number} params.merchantId - Merchant ID
 * @param {string} params.variationId - Variation ID
 * @param {string} params.action - 'apply_new' or 'keep_current'
 * @param {string} params.note - Required note explaining the decision
 * @returns {Promise<Object>} Result
 */
async function resolveFlaggedVariation({ merchantId, variationId, action, note }) {
    if (!merchantId) throw new Error('merchantId is required');
    if (!variationId) throw new Error('variationId is required');
    if (!note || note.trim().length === 0) throw new Error('note is required for manual override resolution');

    // Get current state
    const current = await db.query(`
        SELECT vds.*, edt.tier_code as current_tier_code
        FROM variation_discount_status vds
        LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
        WHERE vds.variation_id = $1 AND vds.merchant_id = $2
    `, [variationId, merchantId]);

    if (current.rows.length === 0) {
        return { success: false, error: 'Variation not found' };
    }

    const row = current.rows[0];

    if (action === 'apply_new') {
        // Recalculate the tier and apply it
        const tiers = await getActiveTiers(merchantId);
        const timezone = await getSetting('timezone', merchantId) || 'America/Toronto';

        const veResult = await db.query(
            'SELECT expiration_date FROM variation_expiration WHERE variation_id = $1 AND merchant_id = $2',
            [variationId, merchantId]
        );
        const expirationDate = veResult.rows[0]?.expiration_date;
        const daysUntilExpiry = calculateDaysUntilExpiry(expirationDate, timezone);
        const newTier = determineTier(daysUntilExpiry, tiers);

        if (!newTier) {
            return { success: false, error: 'Could not determine tier' };
        }

        await db.query(`
            UPDATE variation_discount_status
            SET current_tier_id = $1,
                days_until_expiry = $2,
                needs_manual_review = FALSE,
                manually_overridden = TRUE,
                manual_override_at = NOW(),
                manual_override_note = $3,
                updated_at = NOW()
            WHERE variation_id = $4 AND merchant_id = $5
        `, [newTier.id, daysUntilExpiry, note.trim(), variationId, merchantId]);

        await logAuditEvent({
            merchantId,
            variationId,
            action: 'MANUAL_TIER_APPLY',
            oldTierId: row.current_tier_id,
            newTierId: newTier.id,
            daysUntilExpiry,
            triggeredBy: 'MANUAL_REVIEW'
        });

        return {
            success: true,
            action: 'applied',
            previousTier: row.current_tier_code,
            newTier: newTier.tier_code
        };

    } else if (action === 'keep_current') {
        // Keep the current tier, clear the flag
        await db.query(`
            UPDATE variation_discount_status
            SET needs_manual_review = FALSE,
                manually_overridden = TRUE,
                manual_override_at = NOW(),
                manual_override_note = $1,
                updated_at = NOW()
            WHERE variation_id = $2 AND merchant_id = $3
        `, [note.trim(), variationId, merchantId]);

        await logAuditEvent({
            merchantId,
            variationId,
            action: 'MANUAL_TIER_KEEP',
            oldTierId: row.current_tier_id,
            newTierId: row.current_tier_id,
            daysUntilExpiry: row.days_until_expiry,
            triggeredBy: 'MANUAL_REVIEW'
        });

        return {
            success: true,
            action: 'kept',
            currentTier: row.current_tier_code
        };
    }

    return { success: false, error: 'Invalid action. Use "apply_new" or "keep_current".' };
}

module.exports = {
    // Tier management
    getActiveTiers,
    initializeDefaultTiers,
    ensureMerchantTiers,
    getTierByCode,
    determineTier,
    calculateDaysUntilExpiry,
    buildTierRankMap,

    // Settings
    getSetting,
    updateSetting,

    // Evaluation
    evaluateAllVariations,

    // Square discount management
    initializeSquareDiscounts,
    upsertSquareDiscount,
    upsertPricingRule,
    updateDiscountAppliesTo,

    // Discount application
    applyDiscounts,
    getVariationsNeedingDiscountUpdate,
    clearExpiryDiscountForReorder,

    // Automation
    runExpiryDiscountAutomation,

    // Status and reporting
    getDiscountStatusSummary,
    getVariationsInTier,
    getAuditLog,

    // Flagged items (manual review)
    getFlaggedVariations,
    resolveFlaggedVariation,

    // Validation
    validateExpiryDiscounts,

    // Audit
    logAuditEvent
};
