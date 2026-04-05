const express = require('express');
const router = express.Router();
const db = require('../../utils/database');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const requireSuperAdmin = require('../../middleware/require-super-admin');
const validators = require('../../middleware/validators/subscriptions');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess } = require('../../utils/response-helper');

router.get('/webhooks/events', requireAuth, requireAdmin, requireSuperAdmin, validators.listWebhookEvents, asyncHandler(async (req, res) => {
    const { limit = 50, status, event_type } = req.query;
    let query = `
        SELECT id, square_event_id, event_type, merchant_id, square_merchant_id,
               status, received_at, processed_at, processing_time_ms,
               error_message, sync_results
        FROM webhook_events
        WHERE 1=1
    `;
    const params = [];
    if (status) {
        params.push(status);
        query += ` AND status = $${params.length}`;
    }
    if (event_type) {
        params.push(event_type);
        query += ` AND event_type = $${params.length}`;
    }
    params.push(parseInt(limit));
    query += ` ORDER BY received_at DESC LIMIT $${params.length}`;
    const result = await db.query(query, params);
    const stats = await db.query(`
        SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'completed') as completed,
            COUNT(*) FILTER (WHERE status = 'failed') as failed,
            COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
            AVG(processing_time_ms) FILTER (WHERE processing_time_ms IS NOT NULL) as avg_processing_ms
        FROM webhook_events
        WHERE received_at > NOW() - INTERVAL '24 hours'
    `);
    sendSuccess(res, { events: result.rows, stats: stats.rows[0] });
}));

module.exports = router;
