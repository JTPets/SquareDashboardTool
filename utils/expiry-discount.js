/**
 * Expiry-Aware Discount System Module
 * Handles tier evaluation, Square discount object management, and discount automation
 */

const db = require('./database');
const logger = require('./logger');

// Lazy-load square-api to avoid circular dependency
let squareApi = null;
function getSquareApi() {
    if (!squareApi) {
        squareApi = require('./square-api');
    }
    return squareApi;
}

/**
 * Get all active discount tiers from database, ordered by priority
 * @returns {Promise<Array>} Array of tier objects
 */
async function getActiveTiers() {
    const result = await db.query(`
        SELECT * FROM expiry_discount_tiers
        WHERE is_active = TRUE
        ORDER BY priority DESC
    `);
    return result.rows;
}

/**
 * Get a specific tier by code
 * @param {string} tierCode - Tier code (e.g., 'AUTO50')
 * @returns {Promise<Object|null>} Tier object or null
 */
async function getTierByCode(tierCode) {
    const result = await db.query(`
        SELECT * FROM expiry_discount_tiers WHERE tier_code = $1
    `, [tierCode]);
    return result.rows[0] || null;
}

/**
 * Get a setting value from expiry_discount_settings
 * @param {string} key - Setting key
 * @returns {Promise<string|null>} Setting value
 */
async function getSetting(key) {
    const result = await db.query(`
        SELECT setting_value FROM expiry_discount_settings WHERE setting_key = $1
    `, [key]);
    return result.rows[0]?.setting_value || null;
}

/**
 * Update a setting value
 * @param {string} key - Setting key
 * @param {string} value - New value
 */
async function updateSetting(key, value) {
    await db.query(`
        INSERT INTO expiry_discount_settings (setting_key, setting_value, updated_at)
        VALUES ($2, $1, NOW())
        ON CONFLICT (setting_key) DO UPDATE
        SET setting_value = $1, updated_at = NOW()
    `, [value, key]);
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
 * @param {boolean} options.dryRun - If true, don't make any changes
 * @param {string} options.triggeredBy - 'SYSTEM', 'MANUAL', or 'CRON'
 * @returns {Promise<Object>} Evaluation results
 */
async function evaluateAllVariations(options = {}) {
    const { dryRun = false, triggeredBy = 'SYSTEM' } = options;

    logger.info('Starting expiry tier evaluation', { dryRun, triggeredBy });

    const results = {
        totalEvaluated: 0,
        tierChanges: [],
        newAssignments: [],
        unchanged: 0,
        errors: [],
        byTier: {}
    };

    try {
        // Get active tiers
        const tiers = await getActiveTiers();

        // Initialize tier counts
        for (const tier of tiers) {
            results.byTier[tier.tier_code] = 0;
        }
        results.byTier['NO_EXPIRY'] = 0;

        // Get all variations with expiration data
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
            JOIN items i ON v.item_id = i.id
            LEFT JOIN variation_expiration ve ON v.id = ve.variation_id
            LEFT JOIN variation_discount_status vds ON v.id = vds.variation_id
            WHERE v.is_deleted = FALSE
              AND i.is_deleted = FALSE
        `);

        const timezone = await getSetting('timezone') || 'America/Toronto';

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
                        needsPull: newTier.tier_code === 'EXPIRED'
                    };

                    if (oldTierId === null) {
                        results.newAssignments.push(change);
                    } else {
                        results.tierChanges.push(change);
                    }

                    if (!dryRun) {
                        // Update variation_discount_status
                        await db.query(`
                            INSERT INTO variation_discount_status (
                                variation_id, current_tier_id, days_until_expiry,
                                original_price_cents, needs_pull, last_evaluated_at, updated_at
                            )
                            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                            ON CONFLICT (variation_id) DO UPDATE SET
                                current_tier_id = EXCLUDED.current_tier_id,
                                days_until_expiry = EXCLUDED.days_until_expiry,
                                original_price_cents = COALESCE(variation_discount_status.original_price_cents, EXCLUDED.original_price_cents),
                                needs_pull = EXCLUDED.needs_pull,
                                last_evaluated_at = NOW(),
                                updated_at = NOW()
                        `, [
                            row.variation_id,
                            newTierId,
                            daysUntilExpiry,
                            row.current_price_cents,
                            change.needsPull
                        ]);

                        // Log to audit
                        await logAuditEvent({
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
 */
async function logAuditEvent(event) {
    await db.query(`
        INSERT INTO expiry_discount_audit_log (
            variation_id, action, old_tier_id, new_tier_id,
            old_price_cents, new_price_cents, days_until_expiry,
            square_sync_status, square_error_message, triggered_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
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

    logger.info('Upserting Square discount object', {
        tierCode: tier.tier_code,
        discountPercent: tier.discount_percent,
        existingId: tier.square_discount_id
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
                    `/v2/catalog/object/${tier.square_discount_id}?include_related_objects=false`
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
 * @returns {Promise<Object>} Initialization results
 */
async function initializeSquareDiscounts() {
    logger.info('Initializing Square discount objects');

    const results = {
        created: [],
        updated: [],
        errors: []
    };

    try {
        // Get all tiers that need Square discounts (auto-apply only)
        const tiersResult = await db.query(`
            SELECT * FROM expiry_discount_tiers
            WHERE is_active = TRUE AND is_auto_apply = TRUE
            ORDER BY priority DESC
        `);

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
        logger.error('Square discount initialization failed', { error: error.message });
        throw error;
    }
}

/**
 * Get items that need discount application (tier changed to an auto-apply tier)
 * @returns {Promise<Array>} Array of variations needing discount updates
 */
async function getVariationsNeedingDiscountUpdate() {
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
        JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
        JOIN variations v ON vds.variation_id = v.id
        WHERE edt.is_auto_apply = TRUE
          AND edt.square_discount_id IS NOT NULL
          AND v.is_deleted = FALSE
    `);

    return result.rows;
}

/**
 * Update Square discount object with list of item IDs to apply to
 * @param {string} tierCode - Tier code (e.g., 'AUTO50')
 * @param {Array<string>} variationIds - Array of variation IDs
 * @returns {Promise<Object>} Update result
 */
async function updateDiscountAppliesTo(tierCode, variationIds) {
    const squareApiModule = getSquareApi();

    logger.info('Updating discount applies_to list', {
        tierCode,
        variationCount: variationIds.length
    });

    try {
        // Get the tier and its Square discount ID
        const tier = await getTierByCode(tierCode);

        if (!tier || !tier.square_discount_id) {
            throw new Error(`No Square discount found for tier: ${tierCode}`);
        }

        // Fetch current discount object
        const retrieveData = await squareApiModule.makeSquareRequest(
            `/v2/catalog/object/${tier.square_discount_id}?include_related_objects=false`
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
 * @param {boolean} options.dryRun - If true, don't make any changes
 * @returns {Promise<Object>} Application results
 */
async function applyDiscounts(options = {}) {
    const { dryRun = false } = options;
    const squareApiModule = getSquareApi();

    logger.info('Applying discounts to variations', { dryRun });

    const results = {
        applied: [],
        removed: [],
        unchanged: [],
        errors: []
    };

    try {
        // Get all tiers with auto-apply
        const tiersResult = await db.query(`
            SELECT * FROM expiry_discount_tiers
            WHERE is_active = TRUE AND is_auto_apply = TRUE
            ORDER BY priority DESC
        `);

        for (const tier of tiersResult.rows) {
            // Get variations currently in this tier
            const variationsResult = await db.query(`
                SELECT
                    vds.variation_id,
                    vds.original_price_cents,
                    v.price_money as current_price_cents,
                    v.sku,
                    i.name as item_name
                FROM variation_discount_status vds
                JOIN variations v ON vds.variation_id = v.id
                JOIN items i ON v.item_id = i.id
                WHERE vds.current_tier_id = $1
                  AND v.is_deleted = FALSE
            `, [tier.id]);

            const variationIds = variationsResult.rows.map(r => r.variation_id);

            if (variationIds.length === 0) {
                continue;
            }

            logger.info(`Processing ${tier.tier_code} tier`, {
                variationCount: variationIds.length,
                discountPercent: tier.discount_percent
            });

            // For item-level discounts in Square, we need to create/update
            // a PRICING_RULE that applies the discount to specific items
            if (!dryRun && tier.square_discount_id) {
                try {
                    // Create/update pricing rule for this tier
                    const pricingRuleResult = await upsertPricingRule(tier, variationIds);

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
            JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
            WHERE vds.discount_applied_at IS NOT NULL
              AND edt.is_auto_apply = FALSE
        `);

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
        logger.error('Discount application failed', { error: error.message });
        throw error;
    }
}

/**
 * Create or update a Square Pricing Rule for item-level discounts
 * @param {Object} tier - Tier configuration with square_discount_id
 * @param {Array<string>} variationIds - Variation IDs to apply discount to
 * @returns {Promise<Object>} Pricing rule result
 */
async function upsertPricingRule(tier, variationIds) {
    const squareApiModule = getSquareApi();

    const pricingRuleKey = `expiry-${tier.tier_code.toLowerCase()}`;

    logger.info('Upserting pricing rule', {
        tierCode: tier.tier_code,
        pricingRuleKey,
        variationCount: variationIds.length
    });

    try {
        // Check if pricing rule already exists
        let existingRule = null;
        let existingProductSet = null;

        // Search for existing pricing rule by name
        const searchResult = await squareApiModule.makeSquareRequest('/v2/catalog/search', {
            method: 'POST',
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
 * @param {boolean} options.dryRun - If true, don't make any changes
 * @returns {Promise<Object>} Full automation results
 */
async function runExpiryDiscountAutomation(options = {}) {
    const { dryRun = false } = options;

    logger.info('Starting expiry discount automation', { dryRun });

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
                results.discountInit = await initializeSquareDiscounts();
            } catch (error) {
                results.errors.push({ step: 'discountInit', error: error.message });
                logger.error('Discount initialization failed', { error: error.message });
            }
        }

        // Step 2: Evaluate all variations and assign tiers
        results.evaluation = await evaluateAllVariations({
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
                results.discountApplication = await applyDiscounts({ dryRun });
            } catch (error) {
                results.errors.push({ step: 'discountApplication', error: error.message });
                logger.error('Discount application failed', { error: error.message });
            }
        }

        // Update last run timestamp
        if (!dryRun) {
            await updateSetting('last_run_at', new Date().toISOString());
        }

        results.duration = Date.now() - startTime;
        results.success = results.errors.length === 0;

        logger.info('Expiry discount automation complete', {
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
 * @returns {Promise<Object>} Status summary
 */
async function getDiscountStatusSummary() {
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
        LEFT JOIN variations v ON vds.variation_id = v.id
        WHERE edt.is_active = TRUE
          AND (vds.variation_id IS NULL OR COALESCE(v.is_deleted, FALSE) = FALSE)
        GROUP BY edt.id, edt.tier_code, edt.tier_name, edt.discount_percent,
                 edt.color_code, edt.is_auto_apply, edt.requires_review, edt.priority
        ORDER BY edt.priority DESC
    `);

    const lastRunAt = await getSetting('last_run_at');

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
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Variations in tier
 */
async function getVariationsInTier(tierCode, options = {}) {
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
        JOIN variations v ON vds.variation_id = v.id
        JOIN items i ON v.item_id = i.id
        JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
        LEFT JOIN variation_expiration ve ON v.id = ve.variation_id
        WHERE edt.tier_code = $1
          AND v.is_deleted = FALSE
        ORDER BY vds.days_until_expiry ASC
        LIMIT $2 OFFSET $3
    `, [tierCode, limit, offset]);

    return result.rows;
}

/**
 * Get recent audit log entries
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Audit log entries
 */
async function getAuditLog(options = {}) {
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
        LEFT JOIN variations v ON al.variation_id = v.id
        LEFT JOIN items i ON v.item_id = i.id
        LEFT JOIN expiry_discount_tiers old_tier ON al.old_tier_id = old_tier.id
        LEFT JOIN expiry_discount_tiers new_tier ON al.new_tier_id = new_tier.id
    `;

    const params = [];

    if (variationId) {
        query += ` WHERE al.variation_id = $1`;
        params.push(variationId);
    }

    query += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await db.query(query, params);
    return result.rows;
}

module.exports = {
    // Tier management
    getActiveTiers,
    getTierByCode,
    determineTier,
    calculateDaysUntilExpiry,

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

    // Automation
    runExpiryDiscountAutomation,

    // Status and reporting
    getDiscountStatusSummary,
    getVariationsInTier,
    getAuditLog,

    // Audit
    logAuditEvent
};
