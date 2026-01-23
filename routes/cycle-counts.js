/**
 * Cycle Count Routes
 *
 * Handles inventory cycle counting operations:
 * - Get pending items for counting
 * - Mark items as counted with accuracy tracking
 * - Sync inventory adjustments to Square
 * - Priority queue management
 * - Statistics and history
 * - Email reporting
 *
 * Endpoints:
 * - GET    /api/cycle-counts/pending          - Get pending items to count
 * - POST   /api/cycle-counts/:id/complete     - Mark item as counted
 * - POST   /api/cycle-counts/:id/sync-to-square - Push adjustment to Square
 * - POST   /api/cycle-counts/send-now         - Add items to priority queue
 * - GET    /api/cycle-counts/stats            - Get counting statistics
 * - GET    /api/cycle-counts/history          - Get historical count data
 * - POST   /api/cycle-counts/email-report     - Send completion report
 * - POST   /api/cycle-counts/generate-batch   - Manually generate daily batch
 * - POST   /api/cycle-counts/reset            - Reset count history
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const squareApi = require('../utils/square-api');
const { batchResolveImageUrls } = require('../utils/image-utils');
const { generateDailyBatch, sendCycleCountReport } = require('../utils/cycle-count-utils');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/cycle-counts');

/**
 * GET /api/cycle-counts/pending
 * Get pending items for cycle counting from daily batch queue
 */
router.get('/cycle-counts/pending', requireAuth, requireMerchant, async (req, res) => {
    try {
        const dailyTarget = parseInt(process.env.DAILY_COUNT_TARGET || '30');
        const merchantId = req.merchantContext.id;

        // Get today's session or create it
        await db.query(
            `INSERT INTO count_sessions (session_date, items_expected, merchant_id)
             VALUES (CURRENT_DATE, $1, $2)
             ON CONFLICT (session_date, merchant_id) DO NOTHING`,
            [dailyTarget, merchantId]
        );

        // Get priority queue items
        const priorityQuery = `
            SELECT DISTINCT
                v.*, i.name as item_name, i.category_name, i.images as item_images,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0) as current_inventory,
                COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as committed_quantity,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0)
                    - COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as available_quantity,
                TRUE as is_priority, ch.last_counted_date, ch.counted_by,
                cqp.added_date as priority_added_date, cqp.notes as priority_notes
            FROM count_queue_priority cqp
            JOIN variations v ON cqp.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE') AND ic.merchant_id = $1
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id AND ch.merchant_id = $1
            WHERE cqp.completed = FALSE AND cqp.merchant_id = $1
              AND COALESCE(v.is_deleted, FALSE) = FALSE AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
            GROUP BY v.id, i.name, i.category_name, i.images, ch.last_counted_date, ch.counted_by, cqp.added_date, cqp.notes
            ORDER BY i.name ASC, v.name ASC
        `;

        const priorityItems = await db.query(priorityQuery, [merchantId]);

        // Get daily batch items
        const dailyBatchQuery = `
            SELECT DISTINCT
                v.*, i.name as item_name, i.category_name, i.images as item_images,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0) as current_inventory,
                COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as committed_quantity,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0)
                    - COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as available_quantity,
                FALSE as is_priority, ch.last_counted_date, ch.counted_by,
                cqd.batch_date, cqd.added_date as batch_added_date
            FROM count_queue_daily cqd
            JOIN variations v ON cqd.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE') AND ic.merchant_id = $1
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id AND ch.merchant_id = $1
            LEFT JOIN count_queue_priority cqp ON v.id = cqp.catalog_object_id AND cqp.completed = FALSE AND cqp.merchant_id = $1
            WHERE cqd.completed = FALSE AND cqd.merchant_id = $1
              AND COALESCE(v.is_deleted, FALSE) = FALSE AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE AND cqp.id IS NULL
            GROUP BY v.id, i.name, i.category_name, i.images, ch.last_counted_date, ch.counted_by, cqd.batch_date, cqd.added_date
            ORDER BY i.name ASC, v.name ASC
        `;

        const dailyBatchItems = await db.query(dailyBatchQuery, [merchantId]);

        // Combine and resolve images
        const allItems = [...priorityItems.rows, ...dailyBatchItems.rows];
        const imageUrlMap = await batchResolveImageUrls(allItems);

        const itemsWithImages = allItems.map((item, index) => ({
            ...item,
            variation_name: item.name,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,
            item_images: undefined,
            name: undefined
        }));

        const validItems = itemsWithImages.filter(item => item.id);

        res.json({
            count: validItems.length,
            target: dailyTarget,
            priority_count: priorityItems.rows.length,
            daily_batch_count: dailyBatchItems.rows.length,
            items: validItems
        });

    } catch (error) {
        logger.error('Get pending cycle counts error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/:id/complete
 * Mark an item as counted with accuracy tracking
 */
router.post('/cycle-counts/:id/complete', requireAuth, requireMerchant, validators.complete, async (req, res) => {
    try {
        const { id } = req.params;
        const { counted_by, is_accurate, actual_quantity, expected_quantity, notes } = req.body;
        const merchantId = req.merchantContext.id;

        if (!id || id === 'null' || id === 'undefined') {
            return res.status(400).json({ error: 'Invalid item ID. Please refresh the page and try again.' });
        }

        // Verify variation belongs to this merchant
        const varCheck = await db.query('SELECT id FROM variations WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
        if (varCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        // Calculate variance
        let variance = null;
        if (actual_quantity !== null && actual_quantity !== undefined &&
            expected_quantity !== null && expected_quantity !== undefined) {
            variance = actual_quantity - expected_quantity;
        }

        // Insert or update count history
        await db.query(
            `INSERT INTO count_history (catalog_object_id, last_counted_date, counted_by, is_accurate, actual_quantity, expected_quantity, variance, notes, merchant_id)
             VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (catalog_object_id, merchant_id) DO UPDATE SET
                last_counted_date = CURRENT_TIMESTAMP, counted_by = EXCLUDED.counted_by, is_accurate = EXCLUDED.is_accurate,
                actual_quantity = EXCLUDED.actual_quantity, expected_quantity = EXCLUDED.expected_quantity,
                variance = EXCLUDED.variance, notes = EXCLUDED.notes`,
            [id, counted_by || 'System', is_accurate, actual_quantity, expected_quantity, variance, notes, merchantId]
        );

        // Mark as completed in queues
        await db.query(`UPDATE count_queue_priority SET completed = TRUE, completed_date = CURRENT_TIMESTAMP WHERE catalog_object_id = $1 AND completed = FALSE AND merchant_id = $2`, [id, merchantId]);
        await db.query(`UPDATE count_queue_daily SET completed = TRUE, completed_date = CURRENT_TIMESTAMP WHERE catalog_object_id = $1 AND completed = FALSE AND merchant_id = $2`, [id, merchantId]);

        // Update session
        await db.query(`UPDATE count_sessions SET items_completed = items_completed + 1, completion_rate = (items_completed + 1)::DECIMAL / items_expected * 100 WHERE session_date = CURRENT_DATE AND merchant_id = $1`, [merchantId]);

        // Check completion status
        const completionCheck = await db.query(`
            SELECT COUNT(*) FILTER (WHERE completed = FALSE) as pending_count, COUNT(*) as total_count
            FROM (SELECT catalog_object_id, completed FROM count_queue_daily WHERE batch_date <= CURRENT_DATE AND merchant_id = $1
                  UNION SELECT catalog_object_id, completed FROM count_queue_priority WHERE merchant_id = $1) combined
        `, [merchantId]);

        const pendingCount = parseInt(completionCheck.rows[0]?.pending_count || 0);
        const isFullyComplete = pendingCount === 0 && completionCheck.rows[0]?.total_count > 0;

        if (isFullyComplete) {
            sendCycleCountReport(merchantId).catch(error => {
                logger.error('Auto email report failed', { error: error.message });
            });
        }

        res.json({ success: true, catalog_object_id: id, is_complete: isFullyComplete, pending_count: pendingCount });

    } catch (error) {
        logger.error('Complete cycle count error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/:id/sync-to-square
 * Push the cycle count adjustment to Square
 */
router.post('/cycle-counts/:id/sync-to-square', requireAuth, requireMerchant, validators.syncToSquare, async (req, res) => {
    try {
        const { id } = req.params;
        const { actual_quantity, location_id } = req.body;
        const merchantId = req.merchantContext.id;

        if (!id || id === 'null' || id === 'undefined') {
            return res.status(400).json({ error: 'Invalid item ID.' });
        }

        if (actual_quantity === null || actual_quantity === undefined || isNaN(parseInt(actual_quantity))) {
            return res.status(400).json({ error: 'Actual quantity is required for Square sync.' });
        }

        const actualQty = parseInt(actual_quantity);

        // Get variation details
        const variationResult = await db.query(
            `SELECT v.id, v.sku, v.name, v.item_id, i.name as item_name, v.track_inventory
             FROM variations v JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
             WHERE v.id = $1 AND v.merchant_id = $2`, [id, merchantId]);

        if (variationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        const variation = variationResult.rows[0];

        if (!variation.track_inventory) {
            return res.status(400).json({ error: 'Inventory tracking is not enabled for this item.' });
        }

        // Determine location
        let targetLocationId = location_id;
        if (!targetLocationId) {
            const locationResult = await db.query('SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1 ORDER BY name LIMIT 1', [merchantId]);
            if (locationResult.rows.length === 0) {
                return res.status(400).json({ error: 'No active locations found.' });
            }
            targetLocationId = locationResult.rows[0].id;
        }

        // Get DB inventory
        const dbInventoryResult = await db.query(
            `SELECT quantity, updated_at FROM inventory_counts WHERE catalog_object_id = $1 AND location_id = $2 AND state = 'IN_STOCK' AND merchant_id = $3`,
            [id, targetLocationId, merchantId]);

        const dbQuantity = dbInventoryResult.rows.length > 0 ? parseInt(dbInventoryResult.rows[0].quantity) || 0 : 0;
        const dbUpdatedAt = dbInventoryResult.rows.length > 0 ? dbInventoryResult.rows[0].updated_at : null;

        // Verify Square inventory matches
        const squareQuantity = await squareApi.getSquareInventoryCount(id, targetLocationId, merchantId);

        if (squareQuantity !== dbQuantity) {
            return res.status(409).json({
                error: 'Inventory has changed in Square since last sync. Please sync inventory first.',
                details: { square_quantity: squareQuantity, database_quantity: dbQuantity, last_synced: dbUpdatedAt },
                action_required: 'sync_inventory'
            });
        }

        // Update Square
        await squareApi.setSquareInventoryCount(id, targetLocationId, actualQty, `Cycle count adjustment - SKU: ${variation.sku || 'N/A'}`, merchantId);

        // Update local DB
        await db.query(
            `INSERT INTO inventory_counts (catalog_object_id, location_id, state, quantity, updated_at, merchant_id)
             VALUES ($1, $2, 'IN_STOCK', $3, CURRENT_TIMESTAMP, $4)
             ON CONFLICT (catalog_object_id, location_id, state, merchant_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
            [id, targetLocationId, actualQty, merchantId]);

        await db.query(`UPDATE count_history SET notes = COALESCE(notes, '') || ' [Synced to Square at ' || TO_CHAR(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') || ']' WHERE catalog_object_id = $1 AND merchant_id = $2`, [id, merchantId]);

        res.json({
            success: true, catalog_object_id: id, sku: variation.sku, item_name: variation.item_name,
            location_id: targetLocationId, previous_quantity: squareQuantity, new_quantity: actualQty, variance: actualQty - squareQuantity
        });

    } catch (error) {
        logger.error('Sync to Square error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/send-now
 * Add item(s) to priority queue
 */
router.post('/cycle-counts/send-now', requireAuth, requireMerchant, validators.sendNow, async (req, res) => {
    try {
        const { skus, added_by, notes } = req.body;
        const merchantId = req.merchantContext.id;

        if (!skus || !Array.isArray(skus) || skus.length === 0) {
            return res.status(400).json({ error: 'SKUs array is required' });
        }

        const variations = await db.query(
            `SELECT id, sku FROM variations WHERE sku = ANY($1::text[]) AND COALESCE(is_deleted, FALSE) = FALSE AND merchant_id = $2`,
            [skus, merchantId]);

        if (variations.rows.length === 0) {
            return res.status(404).json({ error: 'No valid SKUs found' });
        }

        const insertPromises = variations.rows.map(row =>
            db.query(
                `INSERT INTO count_queue_priority (catalog_object_id, added_by, notes, merchant_id)
                 SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM count_queue_priority WHERE catalog_object_id = $1 AND completed = FALSE AND merchant_id = $4)`,
                [row.id, added_by || 'System', notes || null, merchantId]
            )
        );

        await Promise.all(insertPromises);

        res.json({ success: true, items_added: variations.rows.length, skus: variations.rows.map(r => r.sku) });

    } catch (error) {
        logger.error('Add to priority queue error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cycle-counts/stats
 * Get cycle count statistics and history
 */
router.get('/cycle-counts/stats', requireAuth, requireMerchant, validators.getStats, async (req, res) => {
    try {
        const { days } = req.query;
        const lookbackDays = parseInt(days || '30');
        const merchantId = req.merchantContext.id;

        const sessions = await db.query(`
            SELECT session_date, items_expected, items_completed, completion_rate, started_at, completed_at
            FROM count_sessions WHERE session_date >= CURRENT_DATE - INTERVAL '1 day' * $1 AND merchant_id = $2 ORDER BY session_date DESC
        `, [lookbackDays, merchantId]);

        const overall = await db.query(`
            SELECT COUNT(DISTINCT catalog_object_id) as total_items_counted, MAX(last_counted_date) as most_recent_count,
                MIN(last_counted_date) as oldest_count, COUNT(DISTINCT catalog_object_id) FILTER (WHERE last_counted_date >= CURRENT_DATE - INTERVAL '30 days') as counted_last_30_days
            FROM count_history WHERE merchant_id = $1
        `, [merchantId]);

        const total = await db.query(`SELECT COUNT(*) as total_variations FROM variations WHERE COALESCE(is_deleted, FALSE) = FALSE AND track_inventory = TRUE AND merchant_id = $1`, [merchantId]);

        const totalVariations = parseInt(total.rows[0].total_variations);
        const itemsCounted = parseInt(overall.rows[0].total_items_counted);
        const coveragePercent = totalVariations > 0 ? ((itemsCounted / totalVariations) * 100).toFixed(2) : 0;

        res.json({
            sessions: sessions.rows,
            overall: { ...overall.rows[0], total_variations: totalVariations, coverage_percent: coveragePercent }
        });

    } catch (error) {
        logger.error('Get cycle count stats error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cycle-counts/history
 * Get historical cycle count data with variance details
 */
router.get('/cycle-counts/history', requireAuth, requireMerchant, validators.getHistory, async (req, res) => {
    try {
        const { date, start_date, end_date } = req.query;
        const merchantId = req.merchantContext.id;

        let dateFilter = '';
        const params = [merchantId];

        if (date) {
            params.push(date);
            dateFilter = `AND DATE(ch.last_counted_date) = $${params.length}`;
        } else if (start_date && end_date) {
            params.push(start_date, end_date);
            dateFilter = `AND DATE(ch.last_counted_date) BETWEEN $${params.length - 1} AND $${params.length}`;
        } else if (start_date) {
            params.push(start_date);
            dateFilter = `AND DATE(ch.last_counted_date) >= $${params.length}`;
        } else {
            dateFilter = `AND ch.last_counted_date >= CURRENT_DATE - INTERVAL '30 days'`;
        }

        const result = await db.query(`
            SELECT ch.id, ch.catalog_object_id, v.name as variation_name, v.sku, i.name as item_name, i.category_name,
                ch.last_counted_date, ch.counted_by, ch.is_accurate, ch.actual_quantity, ch.expected_quantity, ch.variance, ch.notes,
                v.price_money, v.currency,
                CASE WHEN ch.variance IS NOT NULL AND v.price_money IS NOT NULL THEN (ch.variance * v.price_money / 100.0) ELSE 0 END as variance_value
            FROM count_history ch
            JOIN variations v ON ch.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            WHERE ch.merchant_id = $1 ${dateFilter}
            ORDER BY ch.last_counted_date DESC, ABS(COALESCE(ch.variance, 0)) DESC
        `, params);

        const totalCounts = result.rows.length;
        const accurateCounts = result.rows.filter(r => r.is_accurate).length;
        const inaccurateCounts = result.rows.filter(r => r.is_accurate === false).length;
        const totalVariance = result.rows.reduce((sum, r) => sum + Math.abs(r.variance || 0), 0);
        const totalVarianceValue = result.rows.reduce((sum, r) => sum + Math.abs(r.variance_value || 0), 0);
        const accuracyRate = totalCounts > 0 ? ((accurateCounts / totalCounts) * 100).toFixed(2) : 0;

        res.json({
            summary: {
                total_counts: totalCounts, accurate_counts: accurateCounts, inaccurate_counts: inaccurateCounts,
                accuracy_rate: parseFloat(accuracyRate), total_variance_units: totalVariance, total_variance_value: totalVarianceValue
            },
            items: result.rows.map(row => ({ ...row, variance_value: parseFloat((Number(row.variance_value) || 0).toFixed(2)) }))
        });

    } catch (error) {
        logger.error('Get cycle count history error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/email-report
 * Send completion report email
 */
router.post('/cycle-counts/email-report', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await sendCycleCountReport(merchantId);

        if (!result.sent) {
            return res.status(400).json({ error: result.reason || 'Email reporting is disabled' });
        }

        res.json({ success: true, message: 'Report sent successfully', ...result });

    } catch (error) {
        logger.error('Send cycle count report error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/generate-batch
 * Manually trigger daily batch generation
 */
router.post('/cycle-counts/generate-batch', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Manual batch generation requested', { merchantId });
        const result = await generateDailyBatch(merchantId);

        res.json({ success: true, message: 'Batch generated successfully', ...result });

    } catch (error) {
        logger.error('Manual batch generation failed', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/reset
 * Admin function to rebuild count history from current catalog
 */
router.post('/cycle-counts/reset', requireAuth, requireMerchant, validators.reset, async (req, res) => {
    try {
        const { preserve_history } = req.body;
        const merchantId = req.merchantContext.id;

        if (preserve_history !== false) {
            await db.query(`
                INSERT INTO count_history (catalog_object_id, last_counted_date, counted_by, merchant_id)
                SELECT v.id, '1970-01-01'::timestamp, 'System Reset', $1
                FROM variations v WHERE COALESCE(v.is_deleted, FALSE) = FALSE AND v.track_inventory = TRUE AND v.merchant_id = $1
                AND NOT EXISTS (SELECT 1 FROM count_history ch WHERE ch.catalog_object_id = v.id AND ch.merchant_id = $1)
            `, [merchantId]);
        } else {
            await db.query('DELETE FROM count_history WHERE merchant_id = $1', [merchantId]);
            await db.query('DELETE FROM count_queue_priority WHERE merchant_id = $1', [merchantId]);
            await db.query('DELETE FROM count_sessions WHERE merchant_id = $1', [merchantId]);

            await db.query(`
                INSERT INTO count_history (catalog_object_id, last_counted_date, counted_by, merchant_id)
                SELECT id, '1970-01-01'::timestamp, 'System Reset', $1
                FROM variations WHERE COALESCE(is_deleted, FALSE) = FALSE AND track_inventory = TRUE AND merchant_id = $1
            `, [merchantId]);
        }

        const countResult = await db.query('SELECT COUNT(*) as count FROM count_history WHERE merchant_id = $1', [merchantId]);

        res.json({
            success: true,
            message: preserve_history ? 'Added new items to count history' : 'Count history reset complete',
            total_items: parseInt(countResult.rows[0].count)
        });

    } catch (error) {
        logger.error('Reset count history error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
