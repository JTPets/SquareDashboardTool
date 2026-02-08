/**
 * ZPL Label Generator Service
 *
 * Generates ZPL II commands for Zebra label printers.
 * Supports multiple label sizes via merchant-configurable templates.
 * Labels include: product name, variation, price, and UPC/barcode.
 *
 * Templates use {{placeholder}} syntax for field substitution.
 * Barcode source priority: UPC > SKU (ensures staff can scan to identify products).
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

/**
 * Get all label templates for a merchant
 */
async function getTemplates(merchantId) {
    const result = await db.query(
        `SELECT id, name, description, label_width_mm, label_height_mm, dpi,
                template_zpl, fields, is_default, created_at
         FROM label_templates
         WHERE merchant_id = $1
         ORDER BY is_default DESC, name`,
        [merchantId]
    );
    return result.rows;
}

/**
 * Get a specific template (or the default)
 */
async function getTemplate(merchantId, templateId) {
    if (templateId) {
        const result = await db.query(
            `SELECT id, name, description, label_width_mm, label_height_mm, dpi,
                    template_zpl, fields, is_default
             FROM label_templates
             WHERE id = $1 AND merchant_id = $2`,
            [templateId, merchantId]
        );
        return result.rows[0] || null;
    }

    // Fall back to default template
    const result = await db.query(
        `SELECT id, name, description, label_width_mm, label_height_mm, dpi,
                template_zpl, fields, is_default
         FROM label_templates
         WHERE merchant_id = $1 AND is_default = true`,
        [merchantId]
    );
    return result.rows[0] || null;
}

/**
 * Set a template as the default for a merchant
 */
async function setDefaultTemplate(merchantId, templateId) {
    return db.transaction(async (client) => {
        // Clear existing default
        await client.query(
            `UPDATE label_templates SET is_default = false, updated_at = CURRENT_TIMESTAMP
             WHERE merchant_id = $1 AND is_default = true`,
            [merchantId]
        );
        // Set new default
        const result = await client.query(
            `UPDATE label_templates SET is_default = true, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND merchant_id = $2
             RETURNING id, name`,
            [templateId, merchantId]
        );
        return result.rows[0] || null;
    });
}

/**
 * Fetch variation data needed for label generation
 */
async function getVariationLabelData(merchantId, variationIds) {
    const result = await db.query(
        `SELECT
            v.id AS variation_id,
            v.name AS variation_name,
            v.sku,
            v.upc,
            v.price_money,
            v.currency,
            i.name AS item_name
         FROM variations v
         JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
         WHERE v.id = ANY($1)
           AND v.merchant_id = $2
           AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)`,
        [variationIds, merchantId]
    );
    return result.rows;
}

/**
 * Build the field values map for a single variation
 */
function buildFieldValues(variation) {
    const priceCents = variation.price_money || 0;
    const priceDisplay = (priceCents / 100).toFixed(2);
    // Barcode priority: UPC if available, otherwise SKU
    const barcode = variation.upc || variation.sku || '';

    return {
        itemName: sanitizeZpl(variation.item_name || ''),
        variationName: sanitizeZpl(variation.variation_name || ''),
        price: priceDisplay,
        sku: sanitizeZpl(variation.sku || ''),
        upc: sanitizeZpl(variation.upc || ''),
        barcode: sanitizeZpl(barcode),
        currency: variation.currency || 'CAD'
    };
}

/**
 * Sanitize a string for safe ZPL embedding.
 * Removes characters that could break ZPL commands.
 */
function sanitizeZpl(str) {
    if (!str) return '';
    return String(str)
        .replace(/\^/g, '')
        .replace(/~/g, '')
        .replace(/\\/g, '');
}

/**
 * Apply field values to a ZPL template
 */
function applyTemplate(templateZpl, fieldValues) {
    let zpl = templateZpl;
    for (const [key, value] of Object.entries(fieldValues)) {
        zpl = zpl.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return zpl;
}

/**
 * Generate ZPL for multiple variations using a template.
 * Returns a single ZPL string with all labels concatenated.
 *
 * @param {number} merchantId
 * @param {string[]} variationIds
 * @param {object} options - { templateId, copies }
 * @returns {object} { zpl, labelCount, template }
 */
async function generateLabels(merchantId, variationIds, options = {}) {
    const { templateId = null, copies = 1 } = options;

    // Get template
    const template = await getTemplate(merchantId, templateId);
    if (!template) {
        throw new Error('No label template found. Please create a label template first.');
    }

    // Get variation data
    const variations = await getVariationLabelData(merchantId, variationIds);

    if (variations.length === 0) {
        throw new Error('No matching variations found for the provided IDs.');
    }

    // Log any missing variations
    const foundIds = new Set(variations.map(v => v.variation_id));
    const missing = variationIds.filter(id => !foundIds.has(id));
    if (missing.length > 0) {
        logger.warn('Some variations not found for label generation', {
            merchantId,
            missingCount: missing.length,
            missingIds: missing.slice(0, 10)
        });
    }

    // Generate ZPL for each variation
    const zplParts = [];
    for (const variation of variations) {
        const fieldValues = buildFieldValues(variation);
        const labelZpl = applyTemplate(template.template_zpl, fieldValues);

        // Repeat for requested copies
        for (let c = 0; c < copies; c++) {
            zplParts.push(labelZpl);
        }
    }

    const zpl = zplParts.join('\n');

    logger.info('Generated labels', {
        merchantId,
        labelCount: variations.length,
        copies,
        templateId: template.id,
        templateName: template.name
    });

    return {
        zpl,
        labelCount: variations.length,
        totalLabels: variations.length * copies,
        template: {
            id: template.id,
            name: template.name,
            labelWidth: template.label_width_mm,
            labelHeight: template.label_height_mm
        },
        missingVariations: missing
    };
}

/**
 * Generate ZPL for variations with override prices (used after price push).
 * Instead of reading price from DB, uses the new price from the price change.
 *
 * @param {number} merchantId
 * @param {Array<{variationId, newPriceCents}>} priceChanges
 * @param {object} options - { templateId, copies }
 */
async function generateLabelsWithPrices(merchantId, priceChanges, options = {}) {
    const { templateId = null, copies = 1 } = options;

    const template = await getTemplate(merchantId, templateId);
    if (!template) {
        throw new Error('No label template found. Please create a label template first.');
    }

    const variationIds = priceChanges.map(pc => pc.variationId);
    const variations = await getVariationLabelData(merchantId, variationIds);

    // Build price lookup from the price changes
    const priceMap = new Map();
    for (const pc of priceChanges) {
        priceMap.set(pc.variationId, pc.newPriceCents);
    }

    const zplParts = [];
    const foundIds = new Set();

    for (const variation of variations) {
        foundIds.add(variation.variation_id);
        // Override price if provided
        const overridePrice = priceMap.get(variation.variation_id);
        if (overridePrice !== undefined) {
            variation.price_money = overridePrice;
        }

        const fieldValues = buildFieldValues(variation);
        const labelZpl = applyTemplate(template.template_zpl, fieldValues);

        for (let c = 0; c < copies; c++) {
            zplParts.push(labelZpl);
        }
    }

    const missing = variationIds.filter(id => !foundIds.has(id));

    return {
        zpl: zplParts.join('\n'),
        labelCount: variations.length,
        totalLabels: variations.length * copies,
        template: {
            id: template.id,
            name: template.name,
            labelWidth: template.label_width_mm,
            labelHeight: template.label_height_mm
        },
        missingVariations: missing
    };
}

module.exports = {
    getTemplates,
    getTemplate,
    setDefaultTemplate,
    generateLabels,
    generateLabelsWithPrices
};
