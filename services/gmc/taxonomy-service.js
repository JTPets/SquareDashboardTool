/**
 * GMC Taxonomy Service
 *
 * Google taxonomy listing, category-to-taxonomy mappings, and the official
 * Google taxonomy fetch+import. Extracted from routes/gmc.js.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { escapeLikePattern } = require('../../utils/escape-like');

/** List google_taxonomy rows with optional ILIKE search and row limit. */
async function listTaxonomies({ search, limit } = {}) {
    let query = 'SELECT * FROM google_taxonomy';
    const params = [];
    if (search) {
        params.push(`%${escapeLikePattern(search)}%`);
        query += ` WHERE name ILIKE $${params.length}`;
    }
    query += ' ORDER BY name';
    if (limit) {
        params.push(parseInt(limit, 10));
        query += ` LIMIT $${params.length}`;
    }
    const result = await db.query(query, params);
    return { count: result.rows.length, taxonomy: result.rows };
}

/** All category→taxonomy mappings for a merchant (LEFT JOIN so unmapped categories appear). */
async function getMappings(merchantId) {
    const result = await db.query(`
        SELECT c.id AS category_id, c.name AS category_name,
               gt.id AS google_taxonomy_id, gt.name AS google_taxonomy_name
        FROM categories c
        LEFT JOIN category_taxonomy_mapping ctm
               ON c.id = ctm.category_id AND ctm.merchant_id = $1
        LEFT JOIN google_taxonomy gt ON ctm.google_taxonomy_id = gt.id
        WHERE c.merchant_id = $1
        ORDER BY c.name
    `, [merchantId]);
    return { count: result.rows.length, mappings: result.rows };
}

/**
 * Set (or remove) a taxonomy mapping for a category.
 * - Passing a falsy taxonomyId deletes the mapping.
 * - Returns { notFound: 'category' } when the category doesn't belong to the merchant.
 * - Returns { removed: true } on delete, {} on upsert.
 */
async function setMapping(merchantId, categoryId, taxonomyId) {
    const catCheck = await db.query(
        'SELECT id FROM categories WHERE id = $1 AND merchant_id = $2',
        [categoryId, merchantId]
    );
    if (catCheck.rows.length === 0) return { notFound: 'category' };

    if (!taxonomyId) {
        await db.query(
            'DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2',
            [categoryId, merchantId]
        );
        return { removed: true };
    }

    await db.query(`
        INSERT INTO category_taxonomy_mapping (category_id, google_taxonomy_id, merchant_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (category_id, merchant_id) DO UPDATE SET
            google_taxonomy_id = EXCLUDED.google_taxonomy_id,
            updated_at = CURRENT_TIMESTAMP
    `, [categoryId, taxonomyId, merchantId]);
    return {};
}

/** Remove a taxonomy mapping by categoryId. */
async function deleteMapping(merchantId, categoryId) {
    await db.query(
        'DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2',
        [categoryId, merchantId]
    );
}

/**
 * Fetch Google's official taxonomy file and upsert into google_taxonomy.
 * Throws if the HTTP request fails.
 * @returns {{ imported: number }}
 */
async function fetchGoogleTaxonomy() {
    const url = 'https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt';
    logger.info('Fetching Google taxonomy from official URL');
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch taxonomy: ${response.status} ${response.statusText}`);
    }
    const lines = (await response.text()).split('\n');
    let imported = 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const match = line.match(/^(\d+)\s*-\s*(.+)$/);
        if (match) {
            await db.query(
                'INSERT INTO google_taxonomy (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = $2',
                [parseInt(match[1], 10), match[2].trim()]
            );
            imported++;
        }
    }
    logger.info(`Imported ${imported} Google taxonomy entries`);
    return { imported };
}

/**
 * Map a category (looked up or created by name) to a taxonomy.
 * @returns {{ category_id: string }}
 */
async function setMappingByName(merchantId, categoryName, taxonomyId) {
    let catResult = await db.query(
        'SELECT id FROM categories WHERE name = $1 AND merchant_id = $2',
        [categoryName, merchantId]
    );
    let categoryId;
    if (catResult.rows.length === 0) {
        const ins = await db.query(
            'INSERT INTO categories (id, name, merchant_id) VALUES ($1, $2, $3) RETURNING id',
            [categoryName, categoryName, merchantId]
        );
        categoryId = ins.rows[0].id;
    } else {
        categoryId = catResult.rows[0].id;
    }
    await db.query(`
        INSERT INTO category_taxonomy_mapping (category_id, google_taxonomy_id, merchant_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (category_id, merchant_id) DO UPDATE SET
            google_taxonomy_id = EXCLUDED.google_taxonomy_id,
            updated_at = CURRENT_TIMESTAMP
    `, [categoryId, taxonomyId, merchantId]);
    return { category_id: categoryId };
}

/**
 * Remove a taxonomy mapping identified by category name.
 * Returns { notFound: 'category' } when the category doesn't exist for this merchant.
 */
async function deleteMappingByName(merchantId, categoryName) {
    const catResult = await db.query(
        'SELECT id FROM categories WHERE name = $1 AND merchant_id = $2',
        [categoryName, merchantId]
    );
    if (catResult.rows.length === 0) return { notFound: 'category' };
    await db.query(
        'DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2',
        [catResult.rows[0].id, merchantId]
    );
    return {};
}

module.exports = {
    listTaxonomies,
    getMappings,
    setMapping,
    deleteMapping,
    fetchGoogleTaxonomy,
    setMappingByName,
    deleteMappingByName,
};
