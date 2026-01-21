/**
 * GMC (Google Merchant Center) Routes
 *
 * Handles Google Merchant Center feed generation and management:
 * - Product feed generation (TSV format for GMC)
 * - Local inventory feed for multi-location inventory
 * - Brand management and auto-detection
 * - Google taxonomy mapping
 * - GMC API integration for direct product sync
 * - Feed URL and token management
 *
 * SECURITY CONSIDERATIONS:
 * - Feed endpoints support token-based auth for GMC polling
 * - Token regeneration is rate-limited (V006 fix)
 * - All operations are merchant-scoped (multi-tenant isolation)
 * - Admin endpoints require elevated permissions
 *
 * Endpoints: 32 total
 * - Feed: GET /feed, GET /feed.tsv, GET /feed-url, POST /regenerate-token
 * - Settings: GET, PUT
 * - Brands: GET, POST, POST /import, PUT /items/:id/brand, POST /auto-detect, POST /bulk-assign
 * - Taxonomy: GET, POST /import, PUT /categories/:id/taxonomy, DELETE /categories/:id/taxonomy
 * - Category Mappings: GET, PUT, DELETE
 * - Location Settings: GET, PUT /:locationId
 * - Local Inventory: GET /feed-url, GET /feed, GET /feed.tsv
 * - GMC API: GET /api-settings, PUT /api-settings, POST /api/test-connection,
 *            GET /api/data-source-info, POST /api/sync-products, GET /api/sync-status, GET /api/sync-history
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../utils/database');
const logger = require('../utils/logger');
const gmcFeed = require('../utils/gmc-feed');
const gmcApi = require('../utils/merchant-center-api');
const squareApi = require('../utils/square-api');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const { configureSensitiveOperationRateLimit } = require('../middleware/security');
const validators = require('../middleware/validators/gmc');

// Rate limiter for sensitive operations (token regeneration)
const sensitiveOperationRateLimit = configureSensitiveOperationRateLimit();

// ==================== FEED ENDPOINTS ====================

/**
 * GET /api/gmc/feed
 * Generate and return GMC feed data as JSON
 */
router.get('/feed', requireAuth, requireMerchant, validators.getFeed, async (req, res) => {
    try {
        const { location_id, include_products } = req.query;
        const merchantId = req.merchantContext.id;
        const { products, stats, settings } = await gmcFeed.generateFeedData({
            locationId: location_id,
            includeProducts: include_products === 'true',
            merchantId
        });

        res.json({
            success: true,
            stats,
            settings,
            products
        });
    } catch (error) {
        logger.error('GMC feed generation error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/feed.tsv
 * Download the current GMC feed as TSV
 * Supports multiple auth methods:
 *   1. Query param: ?token=xxx
 *   2. HTTP Basic Auth: password = token (GMC standard method)
 *   3. Session auth (for logged-in users)
 */
router.get('/feed.tsv', async (req, res) => {
    try {
        const { location_id, token } = req.query;
        let merchantId = null;
        let feedToken = token;

        // Check for HTTP Basic Auth (GMC's preferred method)
        const authHeader = req.headers.authorization;
        if (!feedToken && authHeader && authHeader.startsWith('Basic ')) {
            try {
                const base64Credentials = authHeader.split(' ')[1];
                const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
                const [, password] = credentials.split(':');
                if (password) {
                    feedToken = password;
                }
            } catch (e) {
                logger.warn('Failed to parse Basic Auth header', { error: e.message });
            }
        }

        // Check for feed token (query param or Basic Auth)
        if (feedToken) {
            const merchantResult = await db.query(
                'SELECT id FROM merchants WHERE gmc_feed_token = $1 AND is_active = TRUE',
                [feedToken]
            );
            if (merchantResult.rows.length === 0) {
                res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
                return res.status(401).json({ error: 'Invalid or expired feed token' });
            }
            merchantId = merchantResult.rows[0].id;
        }
        // Check for authenticated session
        else if (req.session?.user && req.merchantContext?.id) {
            merchantId = req.merchantContext.id;
        }
        // No auth provided - send Basic Auth challenge
        else {
            res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
            return res.status(401).json({
                error: 'Authentication required. Use ?token=<feed_token> or HTTP Basic Auth.'
            });
        }

        const { products } = await gmcFeed.generateFeedData({ locationId: location_id, merchantId });
        const tsvContent = gmcFeed.generateTsvContent(products);

        res.setHeader('Content-Type', 'text/tab-separated-values');
        res.setHeader('Content-Disposition', 'attachment; filename="gmc-feed.tsv"');
        res.send(tsvContent);
    } catch (error) {
        logger.error('GMC feed download error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/feed-url
 * Get the merchant's GMC feed URL with token for Google Merchant Center
 */
router.get('/feed-url', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const result = await db.query(
            'SELECT gmc_feed_token FROM merchants WHERE id = $1',
            [merchantId]
        );

        if (result.rows.length === 0 || !result.rows[0].gmc_feed_token) {
            return res.status(404).json({ error: 'Feed token not found. Please contact support.' });
        }

        const token = result.rows[0].gmc_feed_token;
        const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
        const feedUrl = `${baseUrl}/api/gmc/feed.tsv?token=${token}`;

        res.json({
            success: true,
            feedUrl,
            token,
            instructions: 'Use this URL in Google Merchant Center as your product feed URL. Keep the token secret.'
        });
    } catch (error) {
        logger.error('GMC feed URL error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/regenerate-token
 * Regenerate the GMC feed token (invalidates old feed URLs)
 * V006 fix: Rate limited to prevent abuse
 */
router.post('/regenerate-token', sensitiveOperationRateLimit, requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const newToken = crypto.randomBytes(32).toString('hex');

        await db.query(
            'UPDATE merchants SET gmc_feed_token = $1, updated_at = NOW() WHERE id = $2',
            [newToken, merchantId]
        );

        const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
        const feedUrl = `${baseUrl}/api/gmc/feed.tsv?token=${newToken}`;

        logger.info('GMC feed token regenerated', { merchantId });

        res.json({
            success: true,
            feedUrl,
            token: newToken,
            warning: 'Your previous feed URL is now invalid. Update Google Merchant Center with the new URL.'
        });
    } catch (error) {
        logger.error('GMC token regeneration error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== SETTINGS ENDPOINTS ====================

/**
 * GET /api/gmc/settings
 * Get GMC feed settings
 */
router.get('/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const settings = await gmcFeed.getSettings(merchantId);
        res.json({ settings });
    } catch (error) {
        logger.error('GMC settings error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/settings
 * Update GMC feed settings
 */
router.put('/settings', requireAuth, requireMerchant, validators.updateSettings, async (req, res) => {
    try {
        const { settings } = req.body;
        const merchantId = req.merchantContext.id;

        for (const [key, value] of Object.entries(settings)) {
            await db.query(`
                INSERT INTO gmc_settings (setting_key, setting_value, updated_at, merchant_id)
                VALUES ($1, $2, CURRENT_TIMESTAMP, $3)
                ON CONFLICT (setting_key, merchant_id) DO UPDATE SET
                    setting_value = EXCLUDED.setting_value,
                    updated_at = CURRENT_TIMESTAMP
            `, [key, value, merchantId]);
        }

        const updatedSettings = await gmcFeed.getSettings(merchantId);
        res.json({ success: true, settings: updatedSettings });
    } catch (error) {
        logger.error('GMC settings update error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== BRAND MANAGEMENT ====================

/**
 * GET /api/gmc/brands
 * List all brands
 */
router.get('/brands', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query('SELECT * FROM brands WHERE merchant_id = $1 ORDER BY name', [merchantId]);
        res.json({ count: result.rows.length, brands: result.rows });
    } catch (error) {
        logger.error('GMC brands error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/brands/import
 * Import brands from array
 */
router.post('/brands/import', requireAuth, requireMerchant, validators.importBrands, async (req, res) => {
    try {
        const { brands } = req.body;
        const merchantId = req.merchantContext.id;

        const imported = await gmcFeed.importBrands(brands, merchantId);
        res.json({ success: true, imported });
    } catch (error) {
        logger.error('GMC brands import error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/brands
 * Create a new brand
 */
router.post('/brands', requireAuth, requireMerchant, validators.createBrand, async (req, res) => {
    try {
        const { name, logo_url, website } = req.body;
        const merchantId = req.merchantContext.id;

        const result = await db.query(
            'INSERT INTO brands (name, logo_url, website, merchant_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, logo_url, website, merchantId]
        );
        res.json({ success: true, brand: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Brand already exists' });
        }
        logger.error('GMC brand create error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/items/:itemId/brand
 * Assign a brand to an item
 * Automatically syncs brand to Square custom attribute
 */
router.put('/items/:itemId/brand', requireAuth, requireMerchant, validators.assignItemBrand, async (req, res) => {
    try {
        const { itemId } = req.params;
        const { brand_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Verify item belongs to this merchant
        const itemCheck = await db.query('SELECT id FROM items WHERE id = $1 AND merchant_id = $2', [itemId, merchantId]);
        if (itemCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        let squareSyncResult = null;
        let brandName = null;

        if (!brand_id) {
            // Remove brand assignment
            await db.query('DELETE FROM item_brands WHERE item_id = $1 AND merchant_id = $2', [itemId, merchantId]);

            // Also remove from Square (set to empty string)
            try {
                squareSyncResult = await squareApi.updateCustomAttributeValues(itemId, {
                    brand: { string_value: '' }
                }, { merchantId });
                logger.info('Brand removed from Square', { item_id: itemId, merchantId });
            } catch (syncError) {
                logger.error('Failed to remove brand from Square', { item_id: itemId, merchantId, error: syncError.message });
                squareSyncResult = { success: false, error: syncError.message };
            }

            return res.json({ success: true, message: 'Brand removed from item', square_sync: squareSyncResult });
        }

        // Get brand name for Square sync
        const brandResult = await db.query('SELECT name FROM brands WHERE id = $1 AND merchant_id = $2', [brand_id, merchantId]);
        if (brandResult.rows.length === 0) {
            return res.status(404).json({ error: 'Brand not found' });
        }
        brandName = brandResult.rows[0].name;

        // Save to local database
        await db.query(`
            INSERT INTO item_brands (item_id, brand_id, merchant_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (item_id, merchant_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
        `, [itemId, brand_id, merchantId]);

        // Auto-sync brand to Square
        try {
            squareSyncResult = await squareApi.updateCustomAttributeValues(itemId, {
                brand: { string_value: brandName }
            }, { merchantId });
            logger.info('Brand synced to Square', { item_id: itemId, brand: brandName, merchantId });
        } catch (syncError) {
            logger.error('Failed to sync brand to Square', { item_id: itemId, merchantId, error: syncError.message });
            squareSyncResult = { success: false, error: syncError.message };
        }

        res.json({ success: true, brand_name: brandName, square_sync: squareSyncResult });
    } catch (error) {
        logger.error('GMC item brand assign error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/brands/auto-detect
 * Auto-detect brands from item names for items missing brand assignments
 */
router.post('/brands/auto-detect', requireAuth, requireMerchant, validators.autoDetectBrands, async (req, res) => {
    try {
        const { brands: brandList } = req.body;
        const merchantId = req.merchantContext.id;

        // Clean and normalize the master brand list
        const cleanedBrands = brandList
            .filter(b => b && typeof b === 'string' && b.trim())
            .map(b => b.trim());

        if (cleanedBrands.length === 0) {
            return res.status(400).json({ error: 'No valid brand names provided' });
        }

        // Ensure all brands exist in our brands table for this merchant
        for (const brandName of cleanedBrands) {
            await db.query(
                'INSERT INTO brands (name, merchant_id) VALUES ($1, $2) ON CONFLICT (name, merchant_id) DO NOTHING',
                [brandName, merchantId]
            );
        }

        // Get the brands from the master list with their DB IDs
        const brandsResult = await db.query(
            `SELECT id, name FROM brands WHERE name = ANY($1) AND merchant_id = $2 ORDER BY LENGTH(name) DESC`,
            [cleanedBrands, merchantId]
        );

        // Build matching structures
        const masterBrands = brandsResult.rows.map(b => ({
            id: b.id,
            name: b.name,
            nameLower: b.name.toLowerCase()
        }));

        // Get items without brand assignments
        const itemsResult = await db.query(`
            SELECT i.id, i.name, i.category_name
            FROM items i
            LEFT JOIN item_brands ib ON i.id = ib.item_id AND ib.merchant_id = $1
            WHERE ib.item_id IS NULL
              AND i.is_deleted = FALSE
              AND i.merchant_id = $1
            ORDER BY i.name
        `, [merchantId]);

        const detectedMatches = [];
        const noMatch = [];

        for (const item of itemsResult.rows) {
            const itemNameLower = item.name.toLowerCase();
            let matchedBrand = null;

            for (const brand of masterBrands) {
                if (itemNameLower.startsWith(brand.nameLower + ' ') ||
                    itemNameLower.startsWith(brand.nameLower + '-') ||
                    itemNameLower.startsWith(brand.nameLower + '_') ||
                    itemNameLower.startsWith(brand.nameLower + ':') ||
                    itemNameLower.startsWith(brand.nameLower + ',') ||
                    itemNameLower === brand.nameLower) {
                    matchedBrand = brand;
                    break;
                }
            }

            if (matchedBrand) {
                detectedMatches.push({
                    item_id: item.id,
                    item_name: item.name,
                    category: item.category_name,
                    detected_brand_id: matchedBrand.id,
                    detected_brand_name: matchedBrand.name,
                    selected: true
                });
            } else {
                noMatch.push({
                    item_id: item.id,
                    item_name: item.name,
                    category: item.category_name
                });
            }
        }

        res.json({
            success: true,
            master_brands_provided: cleanedBrands.length,
            total_items_without_brand: itemsResult.rows.length,
            detected_count: detectedMatches.length,
            no_match_count: noMatch.length,
            detected: detectedMatches,
            no_match: noMatch
        });
    } catch (error) {
        logger.error('Brand auto-detect error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/brands/bulk-assign
 * Bulk assign brands to items and sync to Square
 */
router.post('/brands/bulk-assign', requireAuth, requireMerchant, validators.bulkAssignBrands, async (req, res) => {
    try {
        const { assignments } = req.body;
        const merchantId = req.merchantContext.id;

        const results = {
            success: true,
            assigned: 0,
            synced_to_square: 0,
            failed: 0,
            errors: []
        };

        // Get brand names for Square sync
        const brandIds = [...new Set(assignments.map(a => a.brand_id))];
        const brandsResult = await db.query(
            `SELECT id, name FROM brands WHERE id = ANY($1)`,
            [brandIds]
        );
        const brandNamesMap = new Map(brandsResult.rows.map(b => [b.id, b.name]));

        // Prepare Square batch updates
        const squareUpdates = [];

        for (const assignment of assignments) {
            const { item_id, brand_id } = assignment;

            if (!item_id || !brand_id) {
                results.failed++;
                results.errors.push({ item_id, error: 'Missing item_id or brand_id' });
                continue;
            }

            try {
                // Save to local database
                await db.query(`
                    INSERT INTO item_brands (item_id, brand_id, merchant_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (item_id, merchant_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
                `, [item_id, brand_id, merchantId]);

                results.assigned++;

                // Prepare Square update
                const brandName = brandNamesMap.get(brand_id);
                if (brandName) {
                    squareUpdates.push({
                        catalogObjectId: item_id,
                        customAttributeValues: {
                            brand: { string_value: brandName }
                        }
                    });
                }
            } catch (error) {
                results.failed++;
                results.errors.push({ item_id, error: error.message });
            }
        }

        // Batch sync to Square
        if (squareUpdates.length > 0) {
            try {
                const squareResult = await squareApi.batchUpdateCustomAttributeValues(squareUpdates);
                results.synced_to_square = squareResult.updated || 0;
                results.square_sync = squareResult;

                if (squareResult.errors && squareResult.errors.length > 0) {
                    results.errors.push(...squareResult.errors.map(e => ({ type: 'square_sync', ...e })));
                }
            } catch (syncError) {
                logger.error('Square batch sync failed', { error: syncError.message });
                results.errors.push({ type: 'square_batch_sync', error: syncError.message });
            }
        }

        results.success = results.failed === 0;

        logger.info('Bulk brand assignment complete', {
            assigned: results.assigned,
            synced: results.synced_to_square,
            failed: results.failed
        });

        res.json(results);
    } catch (error) {
        logger.error('Bulk brand assign error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== TAXONOMY MANAGEMENT ====================

/**
 * GET /api/gmc/taxonomy
 * List Google taxonomy categories
 */
router.get('/taxonomy', requireAuth, validators.listTaxonomy, async (req, res) => {
    try {
        const { search, limit } = req.query;
        let query = 'SELECT * FROM google_taxonomy';
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            query += ` WHERE name ILIKE $${params.length}`;
        }

        query += ' ORDER BY name';

        if (limit) {
            params.push(parseInt(limit));
            query += ` LIMIT $${params.length}`;
        }

        const result = await db.query(query, params);
        res.json({ count: result.rows.length, taxonomy: result.rows });
    } catch (error) {
        logger.error('GMC taxonomy error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/taxonomy/import
 * Import Google taxonomy from array
 */
router.post('/taxonomy/import', requireAdmin, validators.importTaxonomy, async (req, res) => {
    try {
        const { taxonomy } = req.body;

        const imported = await gmcFeed.importGoogleTaxonomy(taxonomy);
        res.json({ success: true, imported });
    } catch (error) {
        logger.error('GMC taxonomy import error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/taxonomy/fetch-google
 * Fetch and import Google's official taxonomy file
 */
router.get('/taxonomy/fetch-google', requireAdmin, async (req, res) => {
    try {
        const taxonomyUrl = 'https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt';

        logger.info('Fetching Google taxonomy from official URL');

        const response = await fetch(taxonomyUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch taxonomy: ${response.status} ${response.statusText}`);
        }

        const text = await response.text();
        const lines = text.split('\n');

        let imported = 0;
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const match = line.match(/^(\d+)\s*-\s*(.+)$/);
            if (match) {
                const id = parseInt(match[1]);
                const name = match[2].trim();

                await db.query(`
                    INSERT INTO google_taxonomy (id, name)
                    VALUES ($1, $2)
                    ON CONFLICT (id) DO UPDATE SET name = $2
                `, [id, name]);
                imported++;
            }
        }

        logger.info(`Imported ${imported} Google taxonomy entries`);
        res.json({ success: true, imported, message: `Imported ${imported} taxonomy entries` });

    } catch (error) {
        logger.error('Google taxonomy fetch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/categories/:categoryId/taxonomy
 * Map a Square category to a Google taxonomy
 */
router.put('/categories/:categoryId/taxonomy', requireAuth, requireMerchant, validators.mapCategoryTaxonomy, async (req, res) => {
    try {
        const { categoryId } = req.params;
        const { google_taxonomy_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Verify category belongs to this merchant
        const catCheck = await db.query('SELECT id FROM categories WHERE id = $1 AND merchant_id = $2', [categoryId, merchantId]);
        if (catCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        if (!google_taxonomy_id) {
            await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2', [categoryId, merchantId]);
            return res.json({ success: true, message: 'Taxonomy mapping removed' });
        }

        await db.query(`
            INSERT INTO category_taxonomy_mapping (category_id, google_taxonomy_id, merchant_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (category_id, merchant_id) DO UPDATE SET
                google_taxonomy_id = EXCLUDED.google_taxonomy_id,
                updated_at = CURRENT_TIMESTAMP
        `, [categoryId, google_taxonomy_id, merchantId]);

        res.json({ success: true });
    } catch (error) {
        logger.error('GMC category taxonomy mapping error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/gmc/categories/:categoryId/taxonomy
 * Remove a category's Google taxonomy mapping
 */
router.delete('/categories/:categoryId/taxonomy', requireAuth, requireMerchant, validators.deleteCategoryTaxonomy, async (req, res) => {
    try {
        const { categoryId } = req.params;
        const merchantId = req.merchantContext.id;
        await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2', [categoryId, merchantId]);
        res.json({ success: true, message: 'Taxonomy mapping removed' });
    } catch (error) {
        logger.error('GMC category taxonomy delete error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/category-mappings
 * Get all category to taxonomy mappings
 */
router.get('/category-mappings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query(`
            SELECT
                c.id as category_id,
                c.name as category_name,
                gt.id as google_taxonomy_id,
                gt.name as google_taxonomy_name
            FROM categories c
            LEFT JOIN category_taxonomy_mapping ctm ON c.id = ctm.category_id AND ctm.merchant_id = $1
            LEFT JOIN google_taxonomy gt ON ctm.google_taxonomy_id = gt.id
            WHERE c.merchant_id = $1
            ORDER BY c.name
        `, [merchantId]);
        res.json({ count: result.rows.length, mappings: result.rows });
    } catch (error) {
        logger.error('GMC category mappings error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/category-taxonomy
 * Map a category (by name) to a Google taxonomy
 */
router.put('/category-taxonomy', requireAuth, requireMerchant, validators.mapCategoryTaxonomyByName, async (req, res) => {
    try {
        const { category_name, google_taxonomy_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Find or create the category by name for this merchant
        let categoryResult = await db.query(
            'SELECT id FROM categories WHERE name = $1 AND merchant_id = $2',
            [category_name, merchantId]
        );

        let categoryId;
        if (categoryResult.rows.length === 0) {
            const insertResult = await db.query(
                'INSERT INTO categories (id, name, merchant_id) VALUES ($1, $2, $3) RETURNING id',
                [category_name, category_name, merchantId]
            );
            categoryId = insertResult.rows[0].id;
        } else {
            categoryId = categoryResult.rows[0].id;
        }

        await db.query(`
            INSERT INTO category_taxonomy_mapping (category_id, google_taxonomy_id, merchant_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (category_id, merchant_id) DO UPDATE SET
                google_taxonomy_id = EXCLUDED.google_taxonomy_id,
                updated_at = CURRENT_TIMESTAMP
        `, [categoryId, google_taxonomy_id, merchantId]);

        res.json({ success: true, category_id: categoryId });
    } catch (error) {
        logger.error('GMC category taxonomy mapping error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/gmc/category-taxonomy
 * Remove a category's Google taxonomy mapping (by name)
 */
router.delete('/category-taxonomy', requireAuth, requireMerchant, validators.deleteCategoryTaxonomyByName, async (req, res) => {
    try {
        const { category_name } = req.body;
        const merchantId = req.merchantContext.id;

        const categoryResult = await db.query(
            'SELECT id FROM categories WHERE name = $1 AND merchant_id = $2',
            [category_name, merchantId]
        );

        if (categoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const categoryId = categoryResult.rows[0].id;
        await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2', [categoryId, merchantId]);

        res.json({ success: true, message: 'Taxonomy mapping removed' });
    } catch (error) {
        logger.error('GMC category taxonomy delete error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== LOCATION SETTINGS ====================

/**
 * GET /api/gmc/location-settings
 * Get GMC location settings (Google store codes) for all locations
 */
router.get('/location-settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const result = await db.query(`
            SELECT
                l.id as location_id,
                l.name as location_name,
                l.address as location_address,
                l.active,
                COALESCE(gls.google_store_code, '') as google_store_code,
                COALESCE(gls.enabled, true) as enabled
            FROM locations l
            LEFT JOIN gmc_location_settings gls ON l.id = gls.location_id AND gls.merchant_id = $1
            WHERE l.merchant_id = $1
            ORDER BY l.name
        `, [merchantId]);

        res.json({
            success: true,
            locations: result.rows
        });
    } catch (error) {
        logger.error('GMC location settings error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/location-settings/:locationId
 * Update GMC settings for a specific location
 */
router.put('/location-settings/:locationId', requireAuth, requireMerchant, validators.updateLocationSettings, async (req, res) => {
    try {
        const { locationId } = req.params;
        const { google_store_code, enabled } = req.body;
        const merchantId = req.merchantContext.id;

        // Verify location belongs to this merchant
        const locationCheck = await db.query(
            'SELECT id FROM locations WHERE id = $1 AND merchant_id = $2',
            [locationId, merchantId]
        );

        if (locationCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }

        await gmcFeed.saveLocationSettings(merchantId, locationId, {
            google_store_code,
            enabled
        });

        res.json({
            success: true,
            message: 'Location settings updated'
        });
    } catch (error) {
        logger.error('GMC location settings update error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== LOCAL INVENTORY FEED ====================

/**
 * GET /api/gmc/local-inventory-feed-url
 * Get the merchant's local inventory feed URL with token
 */
router.get('/local-inventory-feed-url', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const result = await db.query(
            'SELECT gmc_feed_token FROM merchants WHERE id = $1',
            [merchantId]
        );

        if (result.rows.length === 0 || !result.rows[0].gmc_feed_token) {
            return res.status(404).json({ error: 'Feed token not found. Please contact support.' });
        }

        const token = result.rows[0].gmc_feed_token;
        const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
        const feedUrl = `${baseUrl}/api/gmc/local-inventory-feed.tsv?token=${token}`;

        res.json({
            success: true,
            feedUrl,
            token,
            instructions: 'Use this URL in Google Merchant Center for local inventory. Keep the token secret.'
        });
    } catch (error) {
        logger.error('Local inventory feed URL error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/local-inventory-feed
 * Get local inventory feed data as JSON for preview
 */
router.get('/local-inventory-feed', requireAuth, requireMerchant, validators.getLocalInventoryFeed, async (req, res) => {
    try {
        const { location_id } = req.query;
        const merchantId = req.merchantContext.id;

        // Verify location belongs to this merchant
        const locationCheck = await db.query(
            'SELECT id FROM locations WHERE id = $1 AND merchant_id = $2',
            [location_id, merchantId]
        );

        if (locationCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }

        const feedData = await gmcFeed.generateLocalInventoryFeed({
            merchantId,
            locationId: location_id
        });

        res.json({
            success: true,
            items: feedData.items,
            location: feedData.location,
            stats: feedData.stats
        });
    } catch (error) {
        logger.error('Local inventory feed JSON error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/local-inventory-feed.tsv
 * Download combined local inventory feed TSV for all enabled locations
 */
router.get('/local-inventory-feed.tsv', async (req, res) => {
    try {
        const { token } = req.query;
        let merchantId = null;
        let feedToken = token;

        // Check for HTTP Basic Auth
        const authHeader = req.headers.authorization;
        if (!feedToken && authHeader && authHeader.startsWith('Basic ')) {
            try {
                const base64Credentials = authHeader.split(' ')[1];
                const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
                const [, password] = credentials.split(':');
                if (password) {
                    feedToken = password;
                }
            } catch (e) {
                logger.warn('Failed to parse Basic Auth header', { error: e.message });
            }
        }

        // Check for feed token
        if (feedToken) {
            const merchantResult = await db.query(
                'SELECT id FROM merchants WHERE gmc_feed_token = $1 AND is_active = TRUE',
                [feedToken]
            );
            if (merchantResult.rows.length === 0) {
                res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
                return res.status(401).json({ error: 'Invalid or expired feed token' });
            }
            merchantId = merchantResult.rows[0].id;
        }
        // Check for session auth
        else if (req.session?.user && req.merchantContext?.id) {
            merchantId = req.merchantContext.id;
        }
        // No auth provided
        else {
            res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
            return res.status(401).json({
                error: 'Authentication required. Use ?token=<feed_token> or HTTP Basic Auth.'
            });
        }

        // Get all enabled locations for this merchant
        const locationsResult = await db.query(`
            SELECT gls.location_id, gls.google_store_code
            FROM gmc_location_settings gls
            WHERE gls.merchant_id = $1 AND gls.enabled = TRUE AND gls.google_store_code IS NOT NULL AND gls.google_store_code != ''
        `, [merchantId]);

        if (locationsResult.rows.length === 0) {
            return res.status(400).json({
                error: 'No enabled locations with store codes found. Configure location settings first.'
            });
        }

        // Generate combined feed for all locations
        let allItems = [];
        for (const loc of locationsResult.rows) {
            try {
                const { items } = await gmcFeed.generateLocalInventoryFeed({
                    merchantId,
                    locationId: loc.location_id
                });
                allItems = allItems.concat(items);
            } catch (err) {
                logger.warn('Skipping location in combined feed', { locationId: loc.location_id, error: err.message });
            }
        }

        const tsvContent = gmcFeed.generateLocalInventoryTsvContent(allItems);

        res.setHeader('Content-Type', 'text/tab-separated-values');
        res.setHeader('Content-Disposition', 'attachment; filename="local-inventory-feed.tsv"');
        res.send(tsvContent);
    } catch (error) {
        logger.error('Combined local inventory TSV error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== GMC API INTEGRATION ====================

/**
 * GET /api/gmc/api-settings
 * Get GMC API settings (Merchant Center ID, etc.)
 */
router.get('/api-settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const settings = await gmcApi.getGmcApiSettings(merchantId);
        res.json({ success: true, settings });
    } catch (error) {
        logger.error('GMC API settings fetch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/api-settings
 * Save GMC API settings
 */
router.put('/api-settings', requireAuth, requireMerchant, validators.updateApiSettings, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { settings } = req.body;

        await gmcApi.saveGmcApiSettings(merchantId, settings);
        res.json({ success: true, message: 'GMC API settings saved' });
    } catch (error) {
        logger.error('GMC API settings save error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/api/test-connection
 * Test connection to Google Merchant Center API
 */
router.post('/api/test-connection', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await gmcApi.testConnection(merchantId);
        res.json(result);
    } catch (error) {
        logger.error('GMC API test connection error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/gmc/api/data-source-info
 * Get data source configuration from Google Merchant Center
 */
router.get('/api/data-source-info', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const settings = await gmcApi.getGmcApiSettings(merchantId);

        if (!settings.gmc_merchant_id || !settings.gmc_data_source_id) {
            return res.status(400).json({
                success: false,
                error: 'GMC Merchant ID and Data Source ID must be configured'
            });
        }

        const dataSourceInfo = await gmcApi.getDataSourceInfo(
            merchantId,
            settings.gmc_merchant_id,
            settings.gmc_data_source_id
        );

        res.json({ success: true, dataSource: dataSourceInfo, settings });
    } catch (error) {
        logger.error('GMC data source info error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/gmc/api/sync-products
 * Sync product catalog to Google Merchant Center
 */
router.post('/api/sync-products', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Return immediately, run sync in background
        res.json({ success: true, message: 'Sync started. Check Sync History for progress.', async: true });

        // Run sync in background (don't await)
        gmcApi.syncProductCatalog(merchantId).catch(err => {
            logger.error('Background GMC product sync error', { error: err.message, stack: err.stack });
        });
    } catch (error) {
        logger.error('GMC product sync error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/gmc/api/sync-status
 * Get last sync status for each sync type
 */
router.get('/api/sync-status', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const status = await gmcApi.getLastSyncStatus(merchantId);
        res.json({ success: true, status });
    } catch (error) {
        logger.error('Get GMC sync status error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/gmc/api/sync-history
 * Get sync history for the merchant
 */
router.get('/api/sync-history', requireAuth, requireMerchant, validators.getSyncHistory, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const limit = parseInt(req.query.limit) || 20;
        const history = await gmcApi.getSyncHistory(merchantId, limit);
        res.json({ success: true, history });
    } catch (error) {
        logger.error('Get GMC sync history error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
