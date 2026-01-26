/**
 * Cycle Count Service
 *
 * Business logic for cycle count batch generation and reporting.
 * Provides:
 * - Daily batch generation for cycle counting
 * - Automatic re-queue of inaccurate counts
 * - Cycle count completion reports via email
 *
 * This service was extracted from utils/cycle-count-utils.js as part of P1-3.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const emailNotifier = require('../../utils/email-notifier');

/**
 * Generate daily batch for cycle counting
 *
 * This function:
 * 1. Adds 30 NEW items every day (or DAILY_COUNT_TARGET)
 * 2. Uncompleted items from previous batches remain in queue
 * 3. Ensures backlog grows if days are skipped to stay on 30/day target
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 */
async function generateDailyBatch(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for generateDailyBatch');
    }
    try {
        logger.info('Starting daily cycle count batch generation', { merchantId });
        const dailyTarget = parseInt(process.env.DAILY_COUNT_TARGET || '30');

        // Create today's session
        await db.query(
            `INSERT INTO count_sessions (session_date, items_expected, merchant_id)
             VALUES (CURRENT_DATE, $1, $2)
             ON CONFLICT (session_date, merchant_id) DO NOTHING`,
            [dailyTarget, merchantId]
        );

        // STEP 1: Auto-add recent inaccurate counts to priority queue for verification
        const recentInaccurateQuery = `
            SELECT DISTINCT ch.catalog_object_id, v.sku, i.name as item_name,
                   DATE(ch.last_counted_date) as count_date
            FROM count_history ch
            JOIN variations v ON ch.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN count_queue_priority cqp ON ch.catalog_object_id = cqp.catalog_object_id
                AND cqp.completed = FALSE AND cqp.merchant_id = $1
            WHERE ch.merchant_id = $1
              AND ch.is_accurate = FALSE
              AND ch.last_counted_date >= CURRENT_DATE - INTERVAL '7 days'
              AND ch.last_counted_date < CURRENT_DATE
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
              AND cqp.id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM count_history ch2
                WHERE ch2.catalog_object_id = ch.catalog_object_id
                  AND ch2.merchant_id = $1
                  AND ch2.last_counted_date > ch.last_counted_date
              )
        `;

        const recentInaccurate = await db.query(recentInaccurateQuery, [merchantId]);
        const recentInaccurateCount = recentInaccurate.rows.length;

        if (recentInaccurateCount > 0) {
            logger.info(`Found ${recentInaccurateCount} inaccurate counts from the past 7 days to recount`, { merchantId });

            const priorityInserts = recentInaccurate.rows.map(item => {
                const daysAgo = item.count_date ? Math.floor((Date.now() - new Date(item.count_date)) / (1000 * 60 * 60 * 24)) : 1;
                const timeRef = daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;
                return db.query(
                    `INSERT INTO count_queue_priority (catalog_object_id, notes, added_by, added_date, merchant_id)
                     SELECT $1, $2, 'System', CURRENT_TIMESTAMP, $3
                     WHERE NOT EXISTS (
                         SELECT 1 FROM count_queue_priority
                         WHERE catalog_object_id = $1 AND completed = FALSE AND merchant_id = $3
                     )`,
                    [item.catalog_object_id, `Recount - Inaccurate ${timeRef} (${item.sku})`, merchantId]
                );
            });

            await Promise.all(priorityInserts);
            logger.info(`Added ${recentInaccurateCount} items from recent inaccurate counts to priority queue`, { merchantId });
        } else {
            logger.info('No recent inaccurate counts to recount', { merchantId });
        }

        // Count uncompleted items from previous batches
        const uncompletedResult = await db.query(`
            SELECT COUNT(DISTINCT catalog_object_id) as count
            FROM count_queue_daily
            WHERE completed = FALSE AND merchant_id = $1
        `, [merchantId]);
        const uncompletedCount = parseInt(uncompletedResult.rows[0]?.count || 0);

        logger.info(`Found ${uncompletedCount} uncompleted items from previous batches`, { merchantId });

        const itemsToAdd = dailyTarget;

        // Get items to add (oldest count dates first)
        const newItemsQuery = `
            SELECT v.id
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id AND ch.merchant_id = $2
            LEFT JOIN count_queue_daily cqd ON v.id = cqd.catalog_object_id AND cqd.completed = FALSE AND cqd.merchant_id = $2
            LEFT JOIN count_queue_priority cqp ON v.id = cqp.catalog_object_id AND cqp.completed = FALSE AND cqp.merchant_id = $2
            WHERE v.merchant_id = $2
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
              AND cqd.id IS NULL
              AND cqp.id IS NULL
            ORDER BY ch.last_counted_date ASC NULLS FIRST, i.name, v.name
            LIMIT $1
        `;

        const newItems = await db.query(newItemsQuery, [itemsToAdd, merchantId]);

        if (newItems.rows.length === 0) {
            logger.info('No new items available to add to batch', { merchantId });
            return {
                success: true,
                uncompleted: uncompletedCount,
                new_items_added: 0,
                yesterday_inaccurate_added: recentInaccurateCount,
                total_in_batch: uncompletedCount
            };
        }

        // Insert new items into daily batch queue
        const insertPromises = newItems.rows.map(item =>
            db.query(
                `INSERT INTO count_queue_daily (catalog_object_id, batch_date, notes, merchant_id)
                 VALUES ($1, CURRENT_DATE, 'Auto-generated daily batch', $2)
                 ON CONFLICT (catalog_object_id, batch_date, merchant_id) DO NOTHING`,
                [item.id, merchantId]
            )
        );

        await Promise.all(insertPromises);

        logger.info(`Successfully added ${newItems.rows.length} new items to daily batch`, { merchantId });

        return {
            success: true,
            uncompleted: uncompletedCount,
            new_items_added: newItems.rows.length,
            yesterday_inaccurate_added: recentInaccurateCount,
            total_in_batch: uncompletedCount + newItems.rows.length
        };

    } catch (error) {
        logger.error('Daily batch generation failed', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Send cycle count completion report email
 * Includes accuracy tracking and variance data
 * @param {number} [merchantId] - Optional merchant ID for filtering
 */
async function sendCycleCountReport(merchantId) {
    try {
        const emailEnabled = process.env.EMAIL_ENABLED === 'true';
        const reportEnabled = process.env.CYCLE_COUNT_REPORT_EMAIL === 'true';

        if (!emailEnabled || !reportEnabled) {
            logger.info('Email reporting disabled in configuration');
            return { sent: false, reason: 'Email reporting disabled' };
        }

        // Get today's session data
        let sessionQuery = `
            SELECT
                session_date,
                items_expected,
                items_completed,
                completion_rate
            FROM count_sessions
            WHERE session_date = CURRENT_DATE
        `;
        const sessionParams = [];
        if (merchantId) {
            sessionQuery += ' AND merchant_id = $1';
            sessionParams.push(merchantId);
        }

        const session = await db.query(sessionQuery, sessionParams);

        if (session.rows.length === 0) {
            logger.warn('No session data for today - cannot send report');
            return { sent: false, reason: 'No session data' };
        }

        const sessionData = session.rows[0];

        // Get items counted today with accuracy data
        let itemsQuery = `
            SELECT
                v.sku,
                i.name as item_name,
                v.name as variation_name,
                ch.last_counted_date,
                ch.counted_by,
                ch.is_accurate,
                ch.actual_quantity,
                ch.expected_quantity,
                ch.variance,
                ch.notes
            FROM count_history ch
            JOIN variations v ON ch.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            WHERE DATE(ch.last_counted_date) = CURRENT_DATE
        `;
        const itemsParams = [];
        if (merchantId) {
            itemsQuery += ' AND ch.merchant_id = $1 AND v.merchant_id = $1 AND i.merchant_id = $1';
            itemsParams.push(merchantId);
        }
        itemsQuery += ' ORDER BY ch.is_accurate ASC NULLS LAST, ABS(COALESCE(ch.variance, 0)) DESC, ch.last_counted_date DESC';

        const items = await db.query(itemsQuery, itemsParams);

        // Calculate accuracy statistics
        const accurateCount = items.rows.filter(item => item.is_accurate === true).length;
        const inaccurateCount = items.rows.filter(item => item.is_accurate === false).length;
        const totalWithData = accurateCount + inaccurateCount;
        const accuracyRate = totalWithData > 0 ? ((accurateCount / totalWithData) * 100).toFixed(1) : 'N/A';

        // Calculate total variance
        const totalVariance = items.rows.reduce((sum, item) => sum + Math.abs(item.variance || 0), 0);

        // Build email content
        const emailSubject = `Cycle Count Report - ${sessionData.session_date} ${sessionData.completion_rate >= 100 ? '✅ COMPLETE' : ''}`;
        const emailBody = buildCycleCountEmailBody(sessionData, items.rows, accurateCount, inaccurateCount, totalWithData, accuracyRate, totalVariance);

        // Send email
        await emailNotifier.sendAlert(emailSubject, emailBody);
        logger.info('Cycle count report email sent successfully');

        // Send to additional email if configured
        const additionalEmail = process.env.ADDITIONAL_CYCLE_COUNT_REPORT_EMAIL;
        if (additionalEmail && additionalEmail.trim()) {
            try {
                const originalEmailTo = process.env.EMAIL_TO;
                process.env.EMAIL_TO = additionalEmail.trim();
                await emailNotifier.sendAlert(emailSubject, emailBody);
                logger.info('Cycle count report sent to additional email', { email: additionalEmail });
                process.env.EMAIL_TO = originalEmailTo;
            } catch (error) {
                logger.error('Failed to send cycle count report to additional email', {
                    email: additionalEmail,
                    error: error.message
                });
            }
        }

        return { sent: true, items_count: items.rows.length, accuracy_rate: accuracyRate };

    } catch (error) {
        logger.error('Send cycle count report failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Build the HTML email body for cycle count report
 */
function buildCycleCountEmailBody(sessionData, items, accurateCount, inaccurateCount, totalWithData, accuracyRate, totalVariance) {
    return `
        <h2>Daily Cycle Count Report</h2>
        <p><strong>Date:</strong> ${sessionData.session_date}</p>
        <p><strong>Status:</strong> ${sessionData.completion_rate >= 100 ? '✅ 100% COMPLETE' : '⏳ In Progress'}</p>

        <h3>Summary</h3>
        <table border="1" cellpadding="8" style="border-collapse: collapse; margin-bottom: 20px;">
            <tr><td><strong>Items Expected:</strong></td><td>${sessionData.items_expected}</td></tr>
            <tr><td><strong>Items Completed:</strong></td><td>${sessionData.items_completed}</td></tr>
            <tr><td><strong>Completion Rate:</strong></td><td>${sessionData.completion_rate}%</td></tr>
            <tr><td><strong>Accuracy Rate:</strong></td><td>${accuracyRate}% (${accurateCount}/${totalWithData} accurate)</td></tr>
            <tr style="background-color: ${inaccurateCount > 0 ? '#fff3cd' : '#d4edda'};">
                <td><strong>Discrepancies Found:</strong></td><td>${inaccurateCount} items</td>
            </tr>
            <tr><td><strong>Total Variance:</strong></td><td>${totalVariance} units</td></tr>
        </table>

        ${inaccurateCount > 0 ? `
            <h3>⚠️ Discrepancies (${inaccurateCount} items)</h3>
            <table border="1" cellpadding="5" style="border-collapse: collapse; margin-bottom: 20px; background-color: #fff3cd;">
                <thead>
                    <tr style="background-color: #ffc107; color: #000;">
                        <th>SKU</th><th>Product</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Notes</th><th>Counted By</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.filter(item => item.is_accurate === false).map(item => `
                        <tr>
                            <td>${item.sku || 'N/A'}</td>
                            <td>${item.item_name}${item.variation_name ? ' - ' + item.variation_name : ''}</td>
                            <td>${item.expected_quantity !== null ? item.expected_quantity : 'N/A'}</td>
                            <td><strong>${item.actual_quantity !== null ? item.actual_quantity : 'N/A'}</strong></td>
                            <td style="color: ${item.variance > 0 ? '#28a745' : '#dc3545'}; font-weight: bold;">
                                ${item.variance !== null ? (item.variance > 0 ? '+' : '') + item.variance : 'N/A'}
                            </td>
                            <td>${item.notes || '-'}</td>
                            <td>${item.counted_by || 'System'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        ` : ''}

        <h3>All Items Counted Today (${items.length})</h3>
        <table border="1" cellpadding="5" style="border-collapse: collapse;">
            <thead>
                <tr><th>SKU</th><th>Product</th><th>Status</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Counted By</th><th>Time</th></tr>
            </thead>
            <tbody>
                ${items.map(item => {
                    const rowColor = item.is_accurate === false ? '#fff3cd' :
                                   item.is_accurate === true ? '#d4edda' : '#ffffff';
                    return `
                    <tr style="background-color: ${rowColor};">
                        <td>${item.sku || 'N/A'}</td>
                        <td>${item.item_name}${item.variation_name ? ' - ' + item.variation_name : ''}</td>
                        <td>${item.is_accurate === true ? '✅ Accurate' :
                              item.is_accurate === false ? '⚠️ Discrepancy' : '-'}</td>
                        <td>${item.expected_quantity !== null ? item.expected_quantity : '-'}</td>
                        <td>${item.actual_quantity !== null ? item.actual_quantity : '-'}</td>
                        <td style="color: ${item.variance > 0 ? '#28a745' : item.variance < 0 ? '#dc3545' : '#000'};">
                            ${item.variance !== null ? (item.variance > 0 ? '+' : '') + item.variance : '-'}
                        </td>
                        <td>${item.counted_by || 'System'}</td>
                        <td>${new Date(item.last_counted_date).toLocaleTimeString()}</td>
                    </tr>
                `}).join('')}
            </tbody>
        </table>

        <p style="margin-top: 20px; font-size: 12px; color: #666;">
            <em>This report was generated automatically by Square Dashboard Addon Tool.</em>
        </p>
    `;
}

module.exports = {
    generateDailyBatch,
    sendCycleCountReport
};
