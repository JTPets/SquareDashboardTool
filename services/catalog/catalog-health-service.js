/**
 * Catalog Health Service
 *
 * Full catalog health monitor that runs 8 check types against the Square Catalog API.
 * Debug tool scoped to merchant_id = 3 only. Permanent audit trail — rows never pruned.
 *
 * Check types:
 *   1. location_mismatch    — variation/item present_at_all_locations flag mismatch
 *   2. orphaned_variation   — variation with no matching parent ITEM
 *   3. deleted_parent       — variation whose parent ITEM is deleted
 *   4. category_orphan      — ITEM referencing non-existent or deleted CATEGORY
 *   5. image_orphan         — ITEM/VARIATION referencing non-existent or deleted IMAGE
 *   6. modifier_orphan      — ITEM referencing non-existent or deleted MODIFIER_LIST
 *   7. pricing_rule_orphan  — PRICING_RULE referencing non-existent objects
 *   8. missing_tax (warn)   — ITEM with no tax_ids
 *
 * Exports:
 *   runFullHealthCheck(merchantId)  → { checked, newIssues, resolved, existingOpen, durationMs }
 *   getHealthHistory(merchantId)    → all rows ordered by detected_at DESC
 *   getOpenIssues(merchantId)       → rows where resolved_at IS NULL
 *
 * @module services/catalog/catalog-health-service
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest } = require('../square/square-client');
const { SQUARE: { MAX_PAGINATION_ITERATIONS } } = require('../../config/constants');

const DEBUG_MERCHANT_ID = 3;

/**
 * Fetch all catalog objects via paginated ListCatalog call
 * Returns objects grouped by type in Maps
 */
async function fetchCatalogObjects(accessToken) {
    const types = 'ITEM,ITEM_VARIATION,CATEGORY,IMAGE,MODIFIER_LIST,PRICING_RULE,TAX';
    const items = new Map();
    const variations = new Map();
    const categories = new Map();
    const images = new Map();
    const modifiers = new Map();
    const pricingRules = new Map();
    const taxes = new Map();

    let cursor = null;
    let iterations = 0;

    do {
        if (++iterations > MAX_PAGINATION_ITERATIONS) {
            logger.warn('Catalog health: ListCatalog pagination limit reached', { iterations });
            break;
        }

        const endpoint = `/v2/catalog/list?types=${types}&include_deleted_objects=false${cursor ? `&cursor=${cursor}` : ''}`;
        const data = await makeSquareRequest(endpoint, { accessToken });

        for (const obj of (data.objects || [])) {
            switch (obj.type) {
                case 'ITEM':
                    items.set(obj.id, obj);
                    break;
                case 'ITEM_VARIATION':
                    variations.set(obj.id, obj);
                    break;
                case 'CATEGORY':
                    categories.set(obj.id, obj);
                    break;
                case 'IMAGE':
                    images.set(obj.id, obj);
                    break;
                case 'MODIFIER_LIST':
                    modifiers.set(obj.id, obj);
                    break;
                case 'PRICING_RULE':
                    pricingRules.set(obj.id, obj);
                    break;
                case 'TAX':
                    taxes.set(obj.id, obj);
                    break;
            }
        }

        cursor = data.cursor;
    } while (cursor);

    return { items, variations, categories, images, modifiers, pricingRules, taxes };
}

/**
 * Fetch deleted catalog objects via SearchCatalogObjects with include_deleted_objects=true
 * Returns a Set of deleted object IDs
 */
async function fetchDeletedObjectIds(accessToken) {
    const deletedIds = new Set();
    let cursor = null;
    let iterations = 0;

    do {
        if (++iterations > MAX_PAGINATION_ITERATIONS) {
            logger.warn('Catalog health: SearchCatalog deleted pagination limit reached', { iterations });
            break;
        }

        const body = {
            object_types: ['ITEM', 'CATEGORY', 'IMAGE', 'MODIFIER_LIST'],
            include_deleted_objects: true,
            limit: 1000
        };
        if (cursor) body.cursor = cursor;

        const data = await makeSquareRequest('/v2/catalog/search', {
            accessToken,
            method: 'POST',
            body: JSON.stringify(body)
        });

        for (const obj of (data.objects || [])) {
            if (obj.is_deleted) {
                deletedIds.add(obj.id);
            }
        }

        cursor = data.cursor;
    } while (cursor);

    return deletedIds;
}

// ============================================================================
// Individual check functions — each returns an array of issues
// ============================================================================

/**
 * CHECK 1: location_mismatch
 * ITEM_VARIATION whose present_at_all_locations/present_at_all_future_locations
 * flags differ from parent ITEM
 */
function checkLocationMismatches(items) {
    const issues = [];

    for (const [itemId, item] of items) {
        const itemVariations = item.item_data?.variations || [];
        for (const variation of itemVariations) {
            const mismatches = [];

            const itemPresentAll = item.present_at_all_locations === true;
            const varPresentAll = variation.present_at_all_locations === true;
            if (itemPresentAll !== varPresentAll) {
                mismatches.push('present_at_all_locations');
            }

            const itemFuture = item.present_at_all_future_locations;
            const varFuture = variation.present_at_all_future_locations;
            if ((itemFuture === true) !== (varFuture === true)) {
                mismatches.push('present_at_all_future_locations');
            }

            if (mismatches.length > 0) {
                issues.push({
                    check_type: 'location_mismatch',
                    object_id: variation.id,
                    object_type: 'ITEM_VARIATION',
                    parent_id: itemId,
                    severity: 'error',
                    notes: mismatches.join(', ')
                });
            }
        }
    }

    return issues;
}

/**
 * CHECK 2: orphaned_variation
 * ITEM_VARIATION whose item_id does not match any ITEM in the catalog
 */
function checkOrphanedVariations(variations, items) {
    const issues = [];

    for (const [varId, variation] of variations) {
        const parentItemId = variation.item_variation_data?.item_id;
        if (parentItemId && !items.has(parentItemId)) {
            issues.push({
                check_type: 'orphaned_variation',
                object_id: varId,
                object_type: 'ITEM_VARIATION',
                parent_id: parentItemId,
                severity: 'error',
                notes: `Parent item ${parentItemId} not found in catalog`
            });
        }
    }

    return issues;
}

/**
 * CHECK 3: deleted_parent
 * ITEM_VARIATION whose parent ITEM has is_deleted=true
 */
function checkDeletedParents(variations, items, deletedIds) {
    const issues = [];

    for (const [varId, variation] of variations) {
        const parentItemId = variation.item_variation_data?.item_id;
        if (parentItemId && !items.has(parentItemId) && deletedIds.has(parentItemId)) {
            issues.push({
                check_type: 'deleted_parent',
                object_id: varId,
                object_type: 'ITEM_VARIATION',
                parent_id: parentItemId,
                severity: 'error',
                notes: `Parent item ${parentItemId} is deleted`
            });
        }
    }

    return issues;
}

/**
 * CHECK 4: category_orphan
 * ITEM whose categories reference a CATEGORY that does not exist or is deleted
 */
function checkCategoryOrphans(items, categories, deletedIds) {
    const issues = [];

    for (const [itemId, item] of items) {
        const categoryIds = item.item_data?.categories?.map(c => c.id) || [];
        for (const catId of categoryIds) {
            if (!categories.has(catId) || deletedIds.has(catId)) {
                issues.push({
                    check_type: 'category_orphan',
                    object_id: itemId,
                    object_type: 'ITEM',
                    parent_id: null,
                    severity: 'error',
                    notes: `References missing/deleted category ${catId}`
                });
                break; // One issue per item even if multiple bad categories
            }
        }
    }

    return issues;
}

/**
 * CHECK 5: image_orphan
 * ITEM or ITEM_VARIATION whose image_ids contains an IMAGE that does not exist or is deleted
 */
function checkImageOrphans(items, variations, images, deletedIds) {
    const issues = [];

    for (const [itemId, item] of items) {
        const imageIds = item.item_data?.image_ids || [];
        for (const imgId of imageIds) {
            if (!images.has(imgId) || deletedIds.has(imgId)) {
                issues.push({
                    check_type: 'image_orphan',
                    object_id: itemId,
                    object_type: 'ITEM',
                    parent_id: null,
                    severity: 'error',
                    notes: `References missing/deleted image ${imgId}`
                });
                break;
            }
        }
    }

    for (const [varId, variation] of variations) {
        const imageIds = variation.item_variation_data?.image_ids || [];
        for (const imgId of imageIds) {
            if (!images.has(imgId) || deletedIds.has(imgId)) {
                issues.push({
                    check_type: 'image_orphan',
                    object_id: varId,
                    object_type: 'ITEM_VARIATION',
                    parent_id: variation.item_variation_data?.item_id || null,
                    severity: 'error',
                    notes: `References missing/deleted image ${imgId}`
                });
                break;
            }
        }
    }

    return issues;
}

/**
 * CHECK 6: modifier_orphan
 * ITEM whose modifier_list_info references a MODIFIER_LIST that does not exist or is deleted
 */
function checkModifierOrphans(items, modifiers, deletedIds) {
    const issues = [];

    for (const [itemId, item] of items) {
        const modifierInfos = item.item_data?.modifier_list_info || [];
        for (const modInfo of modifierInfos) {
            const modId = modInfo.modifier_list_id;
            if (modId && (!modifiers.has(modId) || deletedIds.has(modId))) {
                issues.push({
                    check_type: 'modifier_orphan',
                    object_id: itemId,
                    object_type: 'ITEM',
                    parent_id: null,
                    severity: 'error',
                    notes: `References missing/deleted modifier list ${modId}`
                });
                break;
            }
        }
    }

    return issues;
}

/**
 * CHECK 7: pricing_rule_orphan
 * PRICING_RULE that references a non-existent product set or discount
 */
function checkPricingRuleOrphans(pricingRules, items, deletedIds) {
    const issues = [];

    for (const [ruleId, rule] of pricingRules) {
        const ruleData = rule.pricing_rule_data || {};
        const refs = [
            ruleData.match_products_id,
            ruleData.exclude_products_id,
            ruleData.discount_id
        ].filter(Boolean);

        for (const refId of refs) {
            if (deletedIds.has(refId)) {
                issues.push({
                    check_type: 'pricing_rule_orphan',
                    object_id: ruleId,
                    object_type: 'PRICING_RULE',
                    parent_id: null,
                    severity: 'error',
                    notes: `References deleted object ${refId}`
                });
                break;
            }
        }
    }

    return issues;
}

/**
 * CHECK 8: missing_tax (severity=warn)
 * ITEM where tax_ids is null or empty — will under-charge customers
 */
function checkMissingTax(items) {
    const issues = [];

    for (const [itemId, item] of items) {
        const taxIds = item.item_data?.tax_ids || [];
        if (taxIds.length === 0) {
            issues.push({
                check_type: 'missing_tax',
                object_id: itemId,
                object_type: 'ITEM',
                parent_id: null,
                severity: 'warn',
                notes: 'No tax IDs assigned'
            });
        }
    }

    return issues;
}

// ============================================================================
// Main orchestrator + DB persistence
// ============================================================================

/**
 * Run all 8 health checks against the Square catalog
 *
 * @param {number} merchantId - Must be DEBUG_MERCHANT_ID (3)
 * @returns {Promise<Object>} { checked, newIssues, resolved, existingOpen, durationMs }
 */
async function runFullHealthCheck(merchantId) {
    if (merchantId !== DEBUG_MERCHANT_ID) {
        throw new Error('Catalog health check is debug-only, merchant 3 only');
    }

    const startTime = Date.now();
    logger.info('Starting full catalog health check', { merchantId });

    const accessToken = await getMerchantToken(merchantId);

    // Fetch all live catalog objects
    const catalog = await fetchCatalogObjects(accessToken);

    // Fetch deleted object IDs for orphan checks
    const deletedIds = await fetchDeletedObjectIds(accessToken);

    // Run all 8 checks
    const allIssues = [
        ...checkLocationMismatches(catalog.items),
        ...checkOrphanedVariations(catalog.variations, catalog.items),
        ...checkDeletedParents(catalog.variations, catalog.items, deletedIds),
        ...checkCategoryOrphans(catalog.items, catalog.categories, deletedIds),
        ...checkImageOrphans(catalog.items, catalog.variations, catalog.images, deletedIds),
        ...checkModifierOrphans(catalog.items, catalog.modifiers, deletedIds),
        ...checkPricingRuleOrphans(catalog.pricingRules, catalog.items, deletedIds),
        ...checkMissingTax(catalog.items)
    ];

    // Load existing open issues from DB
    const openResult = await db.query(
        `SELECT id, check_type, variation_id, item_id
         FROM catalog_location_health
         WHERE merchant_id = $1 AND status = 'mismatch' AND resolved_at IS NULL`,
        [merchantId]
    );

    // Build lookup: "check_type:object_id" → row
    const openByKey = new Map();
    for (const row of openResult.rows) {
        // variation_id stores the object_id for all check types
        const key = `${row.check_type}:${row.variation_id}`;
        openByKey.set(key, row);
    }

    // Build set of current issue keys
    const currentIssueKeys = new Set();
    const newIssues = [];

    for (const issue of allIssues) {
        const key = `${issue.check_type}:${issue.object_id}`;
        currentIssueKeys.add(key);

        if (!openByKey.has(key)) {
            // New issue — INSERT
            await db.query(
                `INSERT INTO catalog_location_health
                 (merchant_id, variation_id, item_id, status, mismatch_type, check_type, object_type, parent_id, severity, notes)
                 VALUES ($1, $2, $3, 'mismatch', $4, $5, $6, $7, $8, $9)`,
                [
                    merchantId,
                    issue.object_id,
                    issue.parent_id || issue.object_id,
                    issue.check_type,
                    issue.check_type,
                    issue.object_type,
                    issue.parent_id,
                    issue.severity,
                    issue.notes
                ]
            );
            newIssues.push({
                check_type: issue.check_type,
                object_id: issue.object_id,
                severity: issue.severity,
                object_type: issue.object_type
            });
        }
    }

    // Resolve previously open issues that are no longer detected
    const resolved = [];
    for (const [key, row] of openByKey) {
        if (!currentIssueKeys.has(key)) {
            await db.query(
                `UPDATE catalog_location_health
                 SET resolved_at = NOW(), status = 'valid'
                 WHERE id = $1`,
                [row.id]
            );
            resolved.push({
                check_type: row.check_type,
                object_id: row.variation_id
            });
        }
    }

    const existingOpen = currentIssueKeys.size - newIssues.length;
    const durationMs = Date.now() - startTime;

    const summary = {
        checked: {
            items: catalog.items.size,
            variations: catalog.variations.size,
            categories: catalog.categories.size,
            images: catalog.images.size,
            modifiers: catalog.modifiers.size,
            pricingRules: catalog.pricingRules.size
        },
        newIssues,
        resolved,
        existingOpen,
        durationMs
    };

    logger.info('Full catalog health check complete', {
        merchantId,
        newIssues: newIssues.length,
        resolved: resolved.length,
        existingOpen,
        durationMs
    });

    return summary;
}

/**
 * Get full health issue history for a merchant
 *
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Array>} All health rows ordered by detected_at DESC
 */
async function getHealthHistory(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getHealthHistory');
    }

    const result = await db.query(
        `SELECT id, merchant_id, variation_id, item_id, status, mismatch_type,
                check_type, object_type, parent_id, severity,
                detected_at, resolved_at, notes
         FROM catalog_location_health
         WHERE merchant_id = $1
         ORDER BY detected_at DESC`,
        [merchantId]
    );
    return result.rows;
}

/**
 * Get currently open issues for a merchant
 *
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Array>} Open issue rows
 */
async function getOpenIssues(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getOpenIssues');
    }

    const result = await db.query(
        `SELECT id, merchant_id, variation_id, item_id, status, mismatch_type,
                check_type, object_type, parent_id, severity,
                detected_at, notes
         FROM catalog_location_health
         WHERE merchant_id = $1 AND status = 'mismatch' AND resolved_at IS NULL
         ORDER BY severity ASC, check_type, detected_at DESC`,
        [merchantId]
    );
    return result.rows;
}

module.exports = {
    runFullHealthCheck,
    getHealthHistory,
    getOpenIssues
};
