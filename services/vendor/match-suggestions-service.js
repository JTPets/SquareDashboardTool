/**
 * Vendor Match Suggestions Service — BACKLOG-114
 *
 * Cross-vendor product matching via UPC. When a vendor catalog item with a UPC
 * is imported, we check all other vendor catalogs for the same UPC and generate
 * PENDING suggestions. Merchants review and approve/reject each suggestion.
 *
 * Key rules:
 * - NEVER auto-link — all matches require merchant approval
 * - Rejected matches are stored permanently (don't resurface)
 * - Approved matches push vendor_information to Square AND create variation_vendors row
 * - merchant_id on everything (multi-tenant)
 *
 * Exports:
 *   generateMatchSuggestions(variationId, upc, sourceVendorId, merchantId)
 *   getPendingCount(merchantId)
 *   listSuggestions(merchantId, options)
 *   approveSuggestion(suggestionId, userId, merchantId)
 *   rejectSuggestion(suggestionId, userId, merchantId)
 *   bulkApprove(suggestionIds, userId, merchantId)
 *   runBackfillScan(merchantId)
 *   runBackfillScanAllMerchants()
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, generateIdempotencyKey } = require('../square/square-client');
const { ensureVendorsExist } = require('../square/square-vendors');

// ============================================================================
// SUGGESTION GENERATION
// ============================================================================

/**
 * Generate cross-vendor match suggestions for a variation + UPC.
 * Searches all vendor_catalog_items with the same UPC under different vendors,
 * skipping vendors already linked via variation_vendors.
 * Skips UPCs that have been previously rejected for this (variation, vendor) pair.
 *
 * @param {string} variationId - The matched variation ID
 * @param {string} upc - The UPC to search by
 * @param {string} sourceVendorId - The vendor that triggered the match
 * @param {number} merchantId - Merchant ID for multi-tenant isolation
 * @returns {Promise<number>} Number of new suggestions created
 */
async function generateMatchSuggestions(variationId, upc, sourceVendorId, merchantId) {
    if (!upc || !variationId || !sourceVendorId || !merchantId) {
        return 0;
    }

    // Find other vendors carrying this UPC (not the source vendor)
    const otherVendors = await db.query(`
        SELECT DISTINCT
            vci.vendor_id,
            vci.vendor_name,
            vci.vendor_item_number AS vendor_code,
            vci.cost_cents
        FROM vendor_catalog_items vci
        WHERE vci.merchant_id = $1
          AND vci.upc = $2
          AND vci.vendor_id != $3
    `, [merchantId, upc, sourceVendorId]);

    if (otherVendors.rows.length === 0) {
        return 0;
    }

    // Find vendors already linked to this variation
    const existingLinks = await db.query(`
        SELECT vendor_id FROM variation_vendors
        WHERE variation_id = $1 AND merchant_id = $2
    `, [variationId, merchantId]);
    const linkedVendorIds = new Set(existingLinks.rows.map(r => r.vendor_id));

    let created = 0;
    for (const row of otherVendors.rows) {
        // Skip vendors already linked
        if (linkedVendorIds.has(row.vendor_id)) {
            continue;
        }

        // INSERT ... ON CONFLICT DO NOTHING — don't overwrite rejected decisions
        const result = await db.query(`
            INSERT INTO vendor_match_suggestions (
                merchant_id, variation_id, upc,
                source_vendor_id, suggested_vendor_id,
                suggested_vendor_code, suggested_cost_cents
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (merchant_id, variation_id, suggested_vendor_id) DO NOTHING
            RETURNING id
        `, [
            merchantId,
            variationId,
            upc,
            sourceVendorId,
            row.vendor_id,
            row.vendor_code || null,
            row.cost_cents || null
        ]);

        if (result.rows.length > 0) {
            created++;
            logger.info('Created vendor match suggestion', {
                suggestionId: result.rows[0].id,
                variationId,
                upc,
                sourceVendorId,
                suggestedVendorId: row.vendor_id,
                merchantId
            });
        }
    }

    return created;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get count of pending suggestions for the badge display.
 * @param {number} merchantId
 * @returns {Promise<number>}
 */
async function getPendingCount(merchantId) {
    const result = await db.query(`
        SELECT COUNT(*) AS count
        FROM vendor_match_suggestions
        WHERE merchant_id = $1 AND status = 'pending'
    `, [merchantId]);
    return parseInt(result.rows[0].count, 10);
}

/**
 * List suggestions with full context for the review UI.
 * @param {number} merchantId
 * @param {Object} options
 * @param {string} [options.status='pending'] - Filter by status
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @returns {Promise<{suggestions: Array, total: number}>}
 */
async function listSuggestions(merchantId, options = {}) {
    const { status = 'pending', limit = 50, offset = 0 } = options;

    const countResult = await db.query(`
        SELECT COUNT(*) AS total
        FROM vendor_match_suggestions vms
        WHERE vms.merchant_id = $1 AND vms.status = $2
    `, [merchantId, status]);

    const rows = await db.query(`
        SELECT
            vms.id,
            vms.variation_id,
            vms.upc,
            vms.status,
            vms.suggested_vendor_code,
            vms.suggested_cost_cents,
            vms.created_at,
            vms.reviewed_at,
            -- Variation / item info
            v.sku          AS variation_sku,
            v.name         AS variation_name,
            i.name         AS item_name,
            -- Source vendor
            sv.id          AS source_vendor_id,
            sv.name        AS source_vendor_name,
            -- Existing cost from source vendor
            svv.unit_cost_money AS source_cost_cents,
            -- Suggested vendor
            dv.id          AS suggested_vendor_id,
            dv.name        AS suggested_vendor_name,
            -- Reviewer name
            u.name         AS reviewed_by_name
        FROM vendor_match_suggestions vms
        JOIN variations v   ON v.id = vms.variation_id AND v.merchant_id = $1
        LEFT JOIN items i   ON i.id = v.item_id AND i.merchant_id = $1
        JOIN vendors sv     ON sv.id = vms.source_vendor_id
        JOIN vendors dv     ON dv.id = vms.suggested_vendor_id
        LEFT JOIN variation_vendors svv
            ON svv.variation_id = vms.variation_id
            AND svv.vendor_id = vms.source_vendor_id
            AND svv.merchant_id = $1
        LEFT JOIN users u   ON u.id = vms.reviewed_by
        WHERE vms.merchant_id = $1 AND vms.status = $2
        ORDER BY vms.created_at DESC
        LIMIT $3 OFFSET $4
    `, [merchantId, status, limit, offset]);

    return {
        suggestions: rows.rows,
        total: parseInt(countResult.rows[0].total, 10)
    };
}

// ============================================================================
// APPROVAL / REJECTION
// ============================================================================

/**
 * Approve a suggestion: create variation_vendors row + push to Square.
 * @param {number} suggestionId
 * @param {number} userId - Who approved
 * @param {number} merchantId
 * @returns {Promise<Object>} Result
 */
async function approveSuggestion(suggestionId, userId, merchantId) {
    // Load suggestion with current status guard
    const sugResult = await db.query(`
        SELECT * FROM vendor_match_suggestions
        WHERE id = $1 AND merchant_id = $2
    `, [suggestionId, merchantId]);

    if (sugResult.rows.length === 0) {
        throw Object.assign(new Error('Suggestion not found'), { statusCode: 404 });
    }
    const sug = sugResult.rows[0];

    if (sug.status !== 'pending') {
        throw Object.assign(
            new Error(`Suggestion is already ${sug.status}`),
            { statusCode: 409 }
        );
    }

    // Ensure vendor record exists locally (Square vendor may not be in local DB)
    await ensureVendorsExist([sug.suggested_vendor_id], merchantId);

    // 1. Create local variation_vendors row
    await db.query(`
        INSERT INTO variation_vendors (
            variation_id, vendor_id, vendor_code,
            unit_cost_money, currency, merchant_id, updated_at
        ) VALUES ($1, $2, $3, $4, 'CAD', $5, CURRENT_TIMESTAMP)
        ON CONFLICT (variation_id, vendor_id, merchant_id) DO UPDATE SET
            vendor_code      = EXCLUDED.vendor_code,
            unit_cost_money  = EXCLUDED.unit_cost_money,
            updated_at       = CURRENT_TIMESTAMP
    `, [
        sug.variation_id,
        sug.suggested_vendor_id,
        sug.suggested_vendor_code || null,
        sug.suggested_cost_cents || null,
        merchantId
    ]);

    // 2. Push vendor_information to Square
    let squarePushError = null;
    try {
        await pushVendorToSquare(
            sug.variation_id,
            sug.suggested_vendor_id,
            sug.suggested_vendor_code,
            sug.suggested_cost_cents,
            merchantId
        );
    } catch (err) {
        // Log but don't fail the approval — local DB is the source of truth
        squarePushError = err.message;
        logger.error('Square push failed during suggestion approval', {
            suggestionId,
            variationId: sug.variation_id,
            suggestedVendorId: sug.suggested_vendor_id,
            error: err.message,
            merchantId
        });
    }

    // 3. Mark suggestion approved
    await db.query(`
        UPDATE vendor_match_suggestions
        SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
        WHERE id = $2 AND merchant_id = $3
    `, [userId, suggestionId, merchantId]);

    logger.info('Vendor match suggestion approved', {
        suggestionId,
        variationId: sug.variation_id,
        suggestedVendorId: sug.suggested_vendor_id,
        merchantId,
        squarePushError: squarePushError || undefined
    });

    return {
        approved: true,
        suggestionId,
        variationId: sug.variation_id,
        suggestedVendorId: sug.suggested_vendor_id,
        squarePushError
    };
}

/**
 * Reject a suggestion permanently (will not resurface on backfill).
 * @param {number} suggestionId
 * @param {number} userId
 * @param {number} merchantId
 * @returns {Promise<Object>}
 */
async function rejectSuggestion(suggestionId, userId, merchantId) {
    const result = await db.query(`
        UPDATE vendor_match_suggestions
        SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1
        WHERE id = $2 AND merchant_id = $3 AND status = 'pending'
        RETURNING id
    `, [userId, suggestionId, merchantId]);

    if (result.rows.length === 0) {
        // Check if it exists at all
        const existing = await db.query(
            'SELECT status FROM vendor_match_suggestions WHERE id = $1 AND merchant_id = $2',
            [suggestionId, merchantId]
        );
        if (existing.rows.length === 0) {
            throw Object.assign(new Error('Suggestion not found'), { statusCode: 404 });
        }
        throw Object.assign(
            new Error(`Suggestion is already ${existing.rows[0].status}`),
            { statusCode: 409 }
        );
    }

    logger.info('Vendor match suggestion rejected', { suggestionId, merchantId });
    return { rejected: true, suggestionId };
}

/**
 * Bulk approve multiple pending suggestions.
 * Processes each independently — partial success is allowed.
 * @param {number[]} suggestionIds
 * @param {number} userId
 * @param {number} merchantId
 * @returns {Promise<Object>} { approved, failed, errors }
 */
async function bulkApprove(suggestionIds, userId, merchantId) {
    const results = { approved: 0, failed: 0, errors: [] };

    for (const id of suggestionIds) {
        try {
            await approveSuggestion(id, userId, merchantId);
            results.approved++;
        } catch (err) {
            results.failed++;
            results.errors.push({ suggestionId: id, error: err.message });
            logger.warn('Bulk approve: failed for suggestion', {
                suggestionId: id,
                error: err.message,
                merchantId
            });
        }
    }

    return results;
}

// ============================================================================
// SQUARE PUSH (INTERNAL)
// ============================================================================

/**
 * Add a vendor entry to a Square catalog variation's vendor_information array.
 * Retrieves current object, upserts vendor entry, and saves back via catalog API.
 */
async function pushVendorToSquare(variationId, vendorId, vendorCode, costCents, merchantId) {
    const accessToken = await getMerchantToken(merchantId);

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Retrieve current variation (inside loop to get fresh version on retry)
        const retrieved = await makeSquareRequest(
            `/v2/catalog/object/${variationId}?include_related_objects=false`,
            { accessToken }
        );

        if (!retrieved.object) {
            throw new Error(`Square catalog object not found: ${variationId}`);
        }
        if (retrieved.object.type !== 'ITEM_VARIATION') {
            throw new Error(`Object is not a variation: ${retrieved.object.type}`);
        }

        const currentObject = retrieved.object;
        const currentData = currentObject.item_variation_data || {};
        const currentVendorInfo = currentData.vendor_information || [];

        // Build updated vendor_information (upsert the vendor entry)
        const existingIdx = currentVendorInfo.findIndex(v => v.vendor_id === vendorId);
        let updatedVendorInfo;
        if (existingIdx >= 0) {
            updatedVendorInfo = [...currentVendorInfo];
            updatedVendorInfo[existingIdx] = {
                ...updatedVendorInfo[existingIdx],
                ...(vendorCode ? { vendor_code: vendorCode } : {}),
                ...(costCents != null ? {
                    unit_cost_money: { amount: costCents, currency: 'CAD' }
                } : {})
            };
        } else {
            const newEntry = { vendor_id: vendorId };
            if (vendorCode) newEntry.vendor_code = vendorCode;
            if (costCents != null) {
                newEntry.unit_cost_money = { amount: costCents, currency: 'CAD' };
            }
            updatedVendorInfo = [...currentVendorInfo, newEntry];
        }

        const idempotencyKey = generateIdempotencyKey(`match-approve-${attempt}-${variationId}-${vendorId}`);

        try {
            await makeSquareRequest('/v2/catalog/object', {
                method: 'POST',
                body: JSON.stringify({
                    idempotency_key: idempotencyKey,
                    object: {
                        type: 'ITEM_VARIATION',
                        id: variationId,
                        version: currentObject.version,
                        item_variation_data: {
                            ...currentData,
                            vendor_information: updatedVendorInfo
                        }
                    }
                }),
                accessToken
            });

            logger.info('Pushed vendor to Square variation', {
                variationId, vendorId, attempt, merchantId
            });
            return;
        } catch (err) {
            // Retry on version conflict (409) or rate limit (429)
            const isRetryable = err.message?.includes('VERSION_MISMATCH') ||
                                err.message?.includes('429') ||
                                err.message?.includes('rate');
            if (attempt < MAX_RETRIES && isRetryable) {
                await new Promise(r => setTimeout(r, attempt * 1000));
                continue;
            }
            throw err;
        }
    }
}

// ============================================================================
// BACKFILL SCAN
// ============================================================================

/**
 * Scan all matched vendor catalog items for one merchant.
 * For every UPC that appears in 2+ vendor catalogs, check if all vendors
 * are reflected in variation_vendors. Generate pending suggestions for gaps.
 * Skips previously rejected (variation, vendor) pairs.
 *
 * @param {number} merchantId
 * @returns {Promise<Object>} { scanned, suggestionsCreated }
 */
async function runBackfillScan(merchantId) {
    logger.info('Starting vendor match backfill scan', { merchantId });

    // Find UPCs present in 2+ vendor catalogs AND matched to a variation
    const upcs = await db.query(`
        SELECT
            vci.upc,
            vci.matched_variation_id AS variation_id,
            array_agg(DISTINCT vci.vendor_id) AS vendor_ids
        FROM vendor_catalog_items vci
        WHERE vci.merchant_id = $1
          AND vci.upc IS NOT NULL
          AND vci.matched_variation_id IS NOT NULL
        GROUP BY vci.upc, vci.matched_variation_id
        HAVING COUNT(DISTINCT vci.vendor_id) > 1
    `, [merchantId]);

    let scanned = 0;
    let suggestionsCreated = 0;

    for (const row of upcs.rows) {
        scanned++;
        const { upc, variation_id, vendor_ids } = row;

        // For each vendor carrying this UPC, try to generate suggestions
        for (const sourceVendorId of vendor_ids) {
            const created = await generateMatchSuggestions(
                variation_id,
                upc,
                sourceVendorId,
                merchantId
            );
            suggestionsCreated += created;
        }
    }

    logger.info('Vendor match backfill scan complete', {
        merchantId, scanned, suggestionsCreated
    });

    return { scanned, suggestionsCreated };
}

/**
 * Run backfill scan across all active merchants (for weekly cron).
 * @returns {Promise<Object>} { merchantCount, results, errors }
 */
async function runBackfillScanAllMerchants() {
    const merchants = await db.query(
        'SELECT id, business_name FROM merchants WHERE is_active = TRUE'
    );

    const results = [];
    const errors = [];

    for (const merchant of merchants.rows) {
        try {
            const result = await runBackfillScan(merchant.id);
            results.push({ merchantId: merchant.id, ...result });
        } catch (error) {
            errors.push({ merchantId: merchant.id, error: error.message });
            logger.error('Backfill scan failed for merchant', {
                merchantId: merchant.id,
                error: error.message
            });
        }
    }

    return {
        merchantCount: merchants.rows.length,
        results,
        errors
    };
}

module.exports = {
    generateMatchSuggestions,
    getPendingCount,
    listSuggestions,
    approveSuggestion,
    rejectSuggestion,
    bulkApprove,
    runBackfillScan,
    runBackfillScanAllMerchants
};
