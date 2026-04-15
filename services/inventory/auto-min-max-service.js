/**
 * Auto Min/Max Stock Recommendation Service
 *
 * Generates conservative min-stock recommendations based on velocity and inventory.
 * Used by both the manual review API and the weekly cron job (BACKLOG-106 v2).
 *
 * Rules (Rule 3 wins over all):
 *   Rule 1 (OVERSTOCKED):       days_of_stock > 90 AND min > 0
 *                                AND (qty - min) <= vel * REORDER_PROXIMITY_DAYS → recommend min - 1
 *                                (env: REORDER_PROXIMITY_DAYS, default 14)
 *   Rule 2 (SOLDOUT_FAST_MOVER): qty=0, velocity>=0.02, min < ceil(vel*30) → min + 1
 *                                Restock gate: skips if last_received_at ≤ last auto-increase date
 *                                (prevents infinite ratchet on supply-constrained items)
 *   Rule 3 (EXPIRING):          tier IN (AUTO25, AUTO50, EXPIRED) → recommend 0
 *
 * Eligibility (skip if any):
 *   - min_stock_pinned = TRUE (merchant override — never auto-adjust)
 *   - item created < 91 days ago (insufficient sales history)
 *   - velocity_91d IS NULL or = 0 (no data — Rules 1 & 2 require reliable velocity)
 *
 * Weekly cron guardrails (applyWeeklyAdjustments only):
 *   1. Stale velocity: abort if sales_velocity not updated in 7+ days
 *   2. Circuit breaker: abort if reductions > 20% of all items with min > 0
 *
 * Note: sales_velocity has no last_sold_at column.
 * Recent-sales check uses loyalty_purchase_events.purchased_at (most recent non-refund sale).
 * Items with no loyalty data are considered "not recently sold" for the safety check.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const emailNotifier = require('../../utils/email-notifier');
const { pushMinStockThresholdsToSquare } = require('../square/square-inventory');

const EXPIRY_TIERS = new Set(['AUTO25', 'AUTO50', 'EXPIRED']);

// ==================== DATA QUERY ====================

const DATA_QUERY = `
    SELECT
        sv.variation_id,
        sv.location_id,
        v.name AS variation_name,
        i.name AS item_name,
        v.sku,
        sv.daily_avg_quantity AS velocity_91d,
        COALESCE(ic.quantity, 0) AS quantity,
        CASE
            WHEN sv.daily_avg_quantity > 0
            THEN COALESCE(ic.quantity, 0)::numeric / sv.daily_avg_quantity
            ELSE 999999
        END AS days_of_stock,
        COALESCE(vls.stock_alert_min, 0) AS current_min,
        COALESCE(vls.stock_alert_max, v.stock_alert_max) AS current_max,
        COALESCE(vls.min_stock_pinned, FALSE) AS min_stock_pinned,
        edt.tier_code AS expiry_tier,
        i.created_at AS item_created_at,
        (
            SELECT MAX(lpe.purchased_at)
            FROM loyalty_purchase_events lpe
            WHERE lpe.variation_id = sv.variation_id
              AND lpe.merchant_id = $1
              AND lpe.is_refund = FALSE
        ) AS last_sold_at,
        vls.last_received_at,
        (
            SELECT MAX(msa.created_at)
            FROM min_stock_audit msa
            WHERE msa.variation_id = sv.variation_id
              AND msa.location_id = sv.location_id
              AND msa.merchant_id = $1
              AND msa.new_min > msa.previous_min
        ) AS last_auto_increase_at
    FROM sales_velocity sv
    JOIN variations v ON v.id = sv.variation_id AND v.merchant_id = sv.merchant_id
    JOIN items i ON i.id = v.item_id AND i.merchant_id = sv.merchant_id
    LEFT JOIN inventory_counts ic
        ON ic.catalog_object_id = sv.variation_id
        AND ic.location_id = sv.location_id
        AND ic.state = 'IN_STOCK'
        AND ic.merchant_id = sv.merchant_id
    LEFT JOIN variation_location_settings vls
        ON vls.variation_id = sv.variation_id
        AND vls.location_id = sv.location_id
        AND vls.merchant_id = sv.merchant_id
    LEFT JOIN variation_discount_status vds
        ON vds.variation_id = sv.variation_id
        AND vds.merchant_id = sv.merchant_id
    LEFT JOIN expiry_discount_tiers edt
        ON edt.id = vds.current_tier_id
    WHERE sv.merchant_id = $1
      AND sv.period_days = 91
      AND v.is_deleted = FALSE
      AND i.is_deleted = FALSE
`;

// ==================== PUBLIC API ====================

/**
 * Generate min-stock recommendations for all variations.
 * Read-only — does not apply changes.
 * Includes skipped items (pinned, tooNew) with skipped reason for transparency.
 *
 * @param {number} merchantId
 * @returns {Promise<Array>} recommendations (includes skipped and warning items)
 */
async function generateRecommendations(merchantId) {
    if (!merchantId) throw new Error('merchantId is required');

    const result = await db.query(DATA_QUERY, [merchantId]);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ninetyOneDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);

    return result.rows
        .map(row => _evaluateRules(row, thirtyDaysAgo, ninetyOneDaysAgo))
        .filter(Boolean);
}

/**
 * Apply all non-pinned, non-new recommendations automatically (weekly cron use).
 * Applies changes directly — no approval step.
 *
 * Guardrail 1 — Stale velocity: aborts if sales_velocity not updated within 7 days.
 * Guardrail 2 — Circuit breaker: aborts if reductions > 20% of items with min > 0.
 *
 * @param {number} merchantId
 * @returns {Promise<
 *   {reduced: number, increased: number, skipped: number, pinned: number, tooNew: number,
 *    adjustments: Array<{variationId: string, locationId: string, newMin: number, previousMin: number}>} |
 *   {aborted: true, reason: string}
 * >}
 */
async function applyWeeklyAdjustments(merchantId) {
    if (!merchantId) throw new Error('merchantId is required');

    // Guardrail 1: abort if velocity data is stale (not updated in 7+ days)
    const syncResult = await db.query(
        'SELECT MAX(updated_at) AS last_sync FROM sales_velocity WHERE merchant_id = $1',
        [merchantId]
    );
    const lastSync = syncResult.rows[0]?.last_sync ?? null;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (!lastSync || new Date(lastSync) < sevenDaysAgo) {
        const syncDisplay = lastSync ? new Date(lastSync).toISOString() : 'never';
        const reason = `Velocity data stale — last sync ${syncDisplay}`;
        logger.warn('Auto min/max aborted: stale velocity data', { merchantId, lastSync });
        await emailNotifier.sendAlert(
            'Auto Min/Max Aborted — Stale Velocity Data',
            `${reason}\n\nMerchant ID: ${merchantId}\nReview at: /min-max-history.html`
        );
        return { aborted: true, reason };
    }

    const recs = await generateRecommendations(merchantId);

    const pinned = recs.filter(r => r.skipped === 'pinned').length;
    const tooNew = recs.filter(r => r.skipped === 'tooNew').length;
    const conflictRecs = recs.filter(r => r.skipped === 'min_would_meet_or_exceed_max');
    // Supplier-issue warnings (recommendedMin=null, no skipped flag) are also skipped
    const applicable = recs.filter(r => !r.skipped && r.recommendedMin !== null);
    const notApplicable = recs.filter(r => r.skipped || r.recommendedMin === null);
    const skipped = recs.length - applicable.length - pinned - tooNew;
    const conflicts = conflictRecs.map(r => ({
        variationId: r.variationId,
        locationId: r.locationId,
        itemName: r.itemName,
        variationName: r.variationName,
        sku: r.sku,
        currentMin: r.currentMin,
        conflictDetail: r.conflict_detail || null
    }));

    // Persist skipped items to min_max_audit_log for the suppression dashboard
    await _logSkippedItems(merchantId, notApplicable);

    // Guardrail 2: circuit breaker — abort if too many reductions
    const reductions = applicable.filter(r => r.recommendedMin < r.currentMin);
    if (reductions.length > 0) {
        const totalResult = await db.query(
            `SELECT COUNT(DISTINCT variation_id) AS total
             FROM variation_location_settings
             WHERE merchant_id = $1 AND stock_alert_min > 0`,
            [merchantId]
        );
        const total = parseInt(totalResult.rows[0]?.total) || 0;
        if (total > 0 && reductions.length / total > 0.20) {
            const pct = Math.round(reductions.length / total * 100);
            const reason = `Circuit breaker — ${pct}% of items would be reduced (${reductions.length}/${total})`;
            logger.warn('Auto min/max aborted: circuit breaker triggered', {
                merchantId, pct, reductions: reductions.length, total
            });
            await emailNotifier.sendAlert(
                'Auto Min/Max Aborted — Circuit Breaker',
                `${reason}\n\nMerchant ID: ${merchantId}\nReview recommendations at: /min-max-history.html`
            );
            return { aborted: true, reason };
        }
    }

    if (applicable.length === 0) {
        logger.info('No applicable min stock adjustments', { merchantId, pinned, tooNew, conflicts: conflicts.length });
        return { reduced: 0, increased: 0, skipped, pinned, tooNew, conflicts, adjustments: [] };
    }

    await db.transaction(async (client) => {
        for (const rec of applicable) {
            await _applyOne(
                client, merchantId,
                rec.variationId, rec.locationId, rec.recommendedMin,
                rec.rule, rec.reason,
                rec.velocity91d ?? null,
                rec.daysOfStock ?? null,
                rec.quantity ?? null
            );
        }
    });

    const reduced = applicable.filter(r => r.recommendedMin < r.currentMin).length;
    const increased = applicable.filter(r => r.recommendedMin > r.currentMin).length;
    const adjustments = applicable.map(r => ({
        variationId: r.variationId,
        locationId: r.locationId,
        newMin: r.recommendedMin,
        previousMin: r.currentMin
    }));

    logger.info('Applied weekly min stock adjustments',
        { merchantId, reduced, increased, skipped, pinned, tooNew, conflicts: conflicts.length });
    return { reduced, increased, skipped, pinned, tooNew, conflicts, adjustments };
}

/**
 * Apply a single recommendation — updates variation_location_settings and logs audit.
 *
 * @param {number} merchantId
 * @param {string} variationId
 * @param {string} locationId
 * @param {number} newMin - non-negative integer
 */
async function applyRecommendation(merchantId, variationId, locationId, newMin) {
    _validateApplyArgs(merchantId, variationId, locationId, newMin);
    const result = await db.transaction(async (client) => {
        return _applyOne(client, merchantId, variationId, locationId, newMin,
            'MANUAL_APPLY', 'Applied via API', null, null, null);
    });
    // Push to Square — fire-and-forget, local DB is source of truth
    _pushToSquare(merchantId, [{ variationId, locationId, newMin }]);
    return result;
}

/**
 * Apply all passed recommendations in a single transaction.
 *
 * @param {number} merchantId
 * @param {Array<{variationId, locationId, newMin, rule, reason, velocity91d, daysOfStock, quantity}>} recommendations
 * @returns {Promise<{applied: number, failed: number, errors: Array}>}
 */
async function applyAllRecommendations(merchantId, recommendations) {
    if (!merchantId) throw new Error('merchantId is required');
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
        return { applied: 0, failed: 0, errors: [] };
    }

    let applied = 0;
    await db.transaction(async (client) => {
        for (const rec of recommendations) {
            await _applyOne(
                client, merchantId,
                rec.variationId, rec.locationId, rec.newMin,
                rec.rule || 'UNKNOWN', rec.reason || '',
                rec.velocity91d ?? null,
                rec.daysOfStock ?? null,
                rec.quantity ?? null
            );
            applied++;
        }
    });

    // Push to Square — fire-and-forget, local DB is source of truth
    const squareChanges = recommendations.map(r => ({
        variationId: r.variationId,
        locationId: r.locationId,
        newMin: r.newMin
    }));
    _pushToSquare(merchantId, squareChanges);

    logger.info('Applied all min stock recommendations', { merchantId, applied });
    return { applied, failed: 0, errors: [] };
}

/**
 * Set the min_stock_pinned flag for a variation+location.
 * Pinned items are skipped by the weekly cron auto-adjustment.
 *
 * @param {number} merchantId
 * @param {string} variationId
 * @param {string} locationId
 * @param {boolean} pinned
 * @returns {Promise<{variationId, locationId, pinned}>}
 */
async function pinVariation(merchantId, variationId, locationId, pinned) {
    if (!merchantId || !variationId || !locationId) {
        throw new Error('merchantId, variationId, and locationId are required');
    }
    if (typeof pinned !== 'boolean') {
        throw new Error('pinned must be a boolean');
    }

    await db.query(
        `INSERT INTO variation_location_settings
             (variation_id, location_id, merchant_id, min_stock_pinned, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (variation_id, location_id, merchant_id)
         DO UPDATE SET min_stock_pinned = $4, updated_at = NOW()`,
        [variationId, locationId, merchantId, pinned]
    );

    logger.info('Variation min_stock_pinned updated', { merchantId, variationId, locationId, pinned });
    return { variationId, locationId, pinned };
}

/**
 * Pin or unpin a variation from auto-adjustment with cross-tenant ownership check
 * and audit logging. Exposed on the suppression dashboard.
 *
 * Parameter order matches the UI call pattern: variation first, merchant last.
 *
 * @param {string} variationId
 * @param {string} locationId
 * @param {number} merchantId
 * @param {boolean} pinned
 * @returns {Promise<{variationId, locationId, pinned}>}
 */
async function toggleMinStockPin(variationId, locationId, merchantId, pinned) {
    if (!merchantId || !variationId || !locationId) {
        throw new Error('variationId, locationId, and merchantId are required');
    }
    if (typeof pinned !== 'boolean') {
        throw new Error('pinned must be a boolean');
    }

    // Cross-tenant ownership check — prevents variation hijacking across merchants
    const varCheck = await db.query(
        'SELECT 1 FROM variations WHERE id = $1 AND merchant_id = $2',
        [variationId, merchantId]
    );
    if (!varCheck.rows.length) {
        throw new Error('Variation not found for this merchant');
    }

    // Read current min for audit record (old_min = new_min — min is unchanged by a pin toggle)
    const current = await db.query(
        `SELECT COALESCE(stock_alert_min, 0) AS stock_alert_min
         FROM variation_location_settings
         WHERE variation_id = $1 AND location_id = $2 AND merchant_id = $3`,
        [variationId, locationId, merchantId]
    );
    const currentMin = current.rows.length > 0
        ? parseInt(current.rows[0].stock_alert_min) || 0
        : 0;

    await db.query(
        `INSERT INTO variation_location_settings
             (variation_id, location_id, merchant_id, min_stock_pinned, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (variation_id, location_id, merchant_id)
         DO UPDATE SET min_stock_pinned = $4, updated_at = NOW()`,
        [variationId, locationId, merchantId, pinned]
    );

    const auditReason = pinned
        ? 'Manually pinned — excluded from auto-adjustment'
        : 'Pin removed — eligible for auto-adjustment';

    await db.query(
        `INSERT INTO min_max_audit_log
             (merchant_id, variation_id, location_id, old_min, new_min, reason, skipped, skip_reason)
         VALUES ($1, $2, $3, $4, $4, $5, FALSE, NULL)`,
        [merchantId, variationId, locationId, currentMin, auditReason]
    );

    logger.info('Variation min_stock_pinned toggled', { merchantId, variationId, locationId, pinned });
    return { variationId, locationId, pinned };
}

/**
 * Return items that were skipped during the most recent auto-adjustment run.
 * "Last run" = all skipped entries created within 1 hour of the latest skipped entry.
 * Includes current pin state so the UI can render pin/unpin buttons correctly.
 *
 * @param {number} merchantId
 * @returns {Promise<Array>}
 */
async function getSuppressedItems(merchantId) {
    if (!merchantId) throw new Error('merchantId is required');

    const result = await db.query(
        `WITH last_run AS (
             SELECT MAX(created_at) AS max_at
             FROM min_max_audit_log
             WHERE merchant_id = $1 AND skipped = TRUE
         )
         SELECT
             a.variation_id, a.location_id, a.old_min, a.skip_reason, a.created_at,
             v.name AS variation_name, i.name AS item_name, v.sku,
             COALESCE(vls.min_stock_pinned, FALSE) AS min_stock_pinned
         FROM min_max_audit_log a
         JOIN last_run lr ON a.created_at >= lr.max_at - INTERVAL '1 hour'
         LEFT JOIN variations v
             ON v.id = a.variation_id AND v.merchant_id = a.merchant_id
         LEFT JOIN items i
             ON i.id = v.item_id AND i.merchant_id = a.merchant_id
         LEFT JOIN variation_location_settings vls
             ON vls.variation_id = a.variation_id
             AND vls.location_id = a.location_id
             AND vls.merchant_id = a.merchant_id
         WHERE a.merchant_id = $1 AND a.skipped = TRUE
         ORDER BY a.created_at DESC`,
        [merchantId]
    );

    return result.rows;
}

/**
 * Return the most recent applied min-stock changes from min_max_audit_log.
 *
 * @param {number} merchantId
 * @param {number} limit - max rows to return (1–200, default 50)
 * @returns {Promise<Array>}
 */
async function getAuditLog(merchantId, limit = 50) {
    if (!merchantId) throw new Error('merchantId is required');
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);

    const result = await db.query(
        `SELECT
             a.variation_id, a.location_id, a.old_min, a.new_min,
             a.reason, a.created_at,
             v.name AS variation_name, i.name AS item_name, v.sku
         FROM min_max_audit_log a
         LEFT JOIN variations v
             ON v.id = a.variation_id AND v.merchant_id = a.merchant_id
         LEFT JOIN items i
             ON i.id = v.item_id AND i.merchant_id = a.merchant_id
         WHERE a.merchant_id = $1 AND a.skipped = FALSE
         ORDER BY a.created_at DESC
         LIMIT $2`,
        [merchantId, safeLimit]
    );

    return result.rows;
}

/**
 * Query the min_stock_audit table with optional date/rule filters.
 *
 * @param {number} merchantId
 * @param {object} opts - { startDate, endDate, rule, limit, offset }
 * @returns {Promise<{items, total, limit, offset}>}
 */
async function getHistory(merchantId, { startDate, endDate, rule, limit = 50, offset = 0 } = {}) {
    if (!merchantId) throw new Error('merchantId is required');

    const params = [merchantId];
    let whereExtra = '';

    if (startDate) {
        params.push(startDate);
        whereExtra += ` AND a.created_at >= $${params.length}`;
    }
    if (endDate) {
        params.push(endDate);
        whereExtra += ` AND a.created_at <= $${params.length}`;
    }
    if (rule) {
        params.push(rule);
        whereExtra += ` AND a.rule = $${params.length}`;
    }

    const dataParams = [...params, limit, offset];
    const [rowsResult, totalResult] = await Promise.all([
        db.query(
            `SELECT a.*, v.name AS variation_name, i.name AS item_name, v.sku
             FROM min_stock_audit a
             LEFT JOIN variations v ON v.id = a.variation_id AND v.merchant_id = a.merchant_id
             LEFT JOIN items i ON i.id = v.item_id AND i.merchant_id = a.merchant_id
             WHERE a.merchant_id = $1${whereExtra}
             ORDER BY a.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            dataParams
        ),
        db.query(
            `SELECT COUNT(*) AS total FROM min_stock_audit a WHERE a.merchant_id = $1${whereExtra}`,
            params
        )
    ]);

    return {
        items: rowsResult.rows,
        total: parseInt(totalResult.rows[0].total),
        limit,
        offset
    };
}

// ==================== INTERNALS ====================

/**
 * Evaluate eligibility and business rules for a single data row.
 * Returns a recommendation object, a skip object, or null if no change needed.
 */
function _evaluateRules(row, thirtyDaysAgo, ninetyOneDaysAgo) {
    // Eligibility: skip items with < 91 days of history (checked first — data quality gate)
    const itemAge = row.item_created_at ? new Date(row.item_created_at) : null;
    if (!itemAge || itemAge > ninetyOneDaysAgo) {
        return _buildRec(row, null, null, 'Item created less than 91 days ago — insufficient history', 'tooNew');
    }

    // Eligibility: skip pinned items (checked after new-item — pin is a merchant override)
    if (row.min_stock_pinned) {
        return _buildRec(row, null, null, 'Min pinned by merchant — skipping auto-adjustment', 'pinned');
    }

    const min = parseInt(row.current_min) || 0;

    // Rule 3 (highest priority): active expiry discount → min = 0
    // Checked before velocity guard — expiry applies regardless of velocity data
    if (row.expiry_tier && EXPIRY_TIERS.has(row.expiry_tier)) {
        if (min === 0) return null;
        return _buildRec(row, 0, 'EXPIRING',
            `Active expiry discount (${row.expiry_tier}) — do not reorder`);
    }

    // Eligibility: skip null or zero velocity — insufficient data for Rules 1 & 2
    // Zero velocity gives days_of_stock=999999 which would wrongly fire Rule 1
    if (row.velocity_91d === null || row.velocity_91d === undefined) return null;
    const vel = parseFloat(row.velocity_91d);
    if (vel === 0) return null;

    const qty = parseInt(row.quantity) || 0;
    // Use isNaN check — parseFloat(null)=NaN, parseFloat('0')=0 (must not use || here)
    const rawDos = parseFloat(row.days_of_stock);
    const dos = isNaN(rawDos) ? 999999 : rawDos;

    // Rule 1: overstocked slow mover → min - 1
    // Only fires when the item is close enough to its min that the min could trigger a reorder
    // within REORDER_PROXIMITY_DAYS days (default 14 = 2 order cycles). Items with stock far
    // above min won't reorder for months — adjusting their min changes nothing useful.
    const proximityDays = parseInt(process.env.REORDER_PROXIMITY_DAYS) || 14;
    if (dos > 90 && min > 0 && (qty - min) <= vel * proximityDays) {
        return _buildRec(row, min - 1, 'OVERSTOCKED',
            `Overstocked (${Math.round(dos)} days) and min would trigger reorder within ${proximityDays} days`);
    }

    // Rule 2: sold-out fast mover → min + 1
    // Threshold: 0.02/day = ~1 unit/week (daily_avg_quantity from sales_velocity)
    // Note: reorder page displays weekly_avg_quantity — 0.14/week ≈ 0.02/day
    if (qty === 0 && vel >= 0.02) {
        const cap = Math.ceil(vel * 30);
        if (min >= cap) return null;

        const recentlySold = row.last_sold_at &&
            new Date(row.last_sold_at) >= thirtyDaysAgo;

        if (!recentlySold) {
            return _buildRec(row, null, 'SOLDOUT_FAST_MOVER',
                'Sold out but no recent sales — possible supplier issue');
        }

        // Restock gate: prevent ratcheting min upward on persistently out-of-stock items.
        // Allow only if this is the first auto-increase ever, OR a new receipt arrived
        // after the last auto-increase (variation_location_settings.last_received_at).
        const lastIncreaseAt = row.last_auto_increase_at
            ? new Date(row.last_auto_increase_at) : null;
        const lastReceivedAt = row.last_received_at
            ? new Date(row.last_received_at) : null;

        if (lastIncreaseAt !== null) {
            if (!lastReceivedAt || lastReceivedAt <= lastIncreaseAt) {
                return _buildRec(row, null, 'SOLDOUT_FAST_MOVER',
                    'No restock since last auto-increase — skipping to prevent ratchet',
                    'no_restock_since_last_increase');
            }
        }

        const recommended = Math.min(min + 1, cap);
        if (recommended <= min) return null;

        // Conflict guard: do not raise min to or above an existing max.
        // Auto-bumping the max would trample merchant intent, so we skip and surface
        // the conflict for manual review. current_max NULL or 0 means "no ceiling set"
        // — allow the increase but flag with 'no_max_set' so merchants see the gap.
        const maxRaw = row.current_max;
        const currentMax = (maxRaw === null || maxRaw === undefined || maxRaw === '')
            ? null : parseInt(maxRaw);
        if (currentMax !== null && currentMax > 0 && recommended >= currentMax) {
            return _buildRec(row, null, 'SOLDOUT_FAST_MOVER',
                `Recommended min ${recommended} would meet or exceed current max ${currentMax} — review required`,
                'min_would_meet_or_exceed_max',
                { new_min: recommended, current_max: currentMax });
        }

        const rec = _buildRec(row, recommended, 'SOLDOUT_FAST_MOVER',
            `Sold out with ${vel.toFixed(2)} daily sales — increase min`);
        if (currentMax === null || currentMax === 0) {
            rec.warning = 'no_max_set';
        }
        return rec;
    }

    return null;
}

function _buildRec(row, recommendedMin, rule, reason, skipped = null, conflictDetail = null) {
    const rec = {
        variationId: row.variation_id,
        locationId: row.location_id,
        variationName: row.variation_name,
        itemName: row.item_name,
        sku: row.sku,
        currentMin: parseInt(row.current_min) || 0,
        recommendedMin,
        rule,
        reason,
        velocity91d: parseFloat(row.velocity_91d) || 0,
        daysOfStock: row.days_of_stock != null ? parseFloat(row.days_of_stock) : null,
        quantity: parseInt(row.quantity) || 0,
    };
    if (skipped) rec.skipped = skipped;
    if (conflictDetail) rec.conflict_detail = conflictDetail;
    return rec;
}

async function _applyOne(client, merchantId, variationId, locationId, newMin,
    rule, reason, velocity91d, daysOfStock, quantity) {
    const current = await client.query(
        `SELECT COALESCE(stock_alert_min, 0) AS stock_alert_min
         FROM variation_location_settings
         WHERE variation_id = $1 AND location_id = $2 AND merchant_id = $3`,
        [variationId, locationId, merchantId]
    );
    const previousMin = current.rows.length > 0
        ? parseInt(current.rows[0].stock_alert_min) || 0
        : 0;

    await client.query(
        `INSERT INTO variation_location_settings
             (variation_id, location_id, merchant_id, stock_alert_min, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (variation_id, location_id, merchant_id)
         DO UPDATE SET stock_alert_min = $4, updated_at = NOW()`,
        [variationId, locationId, merchantId, newMin]
    );

    await client.query(
        `INSERT INTO min_stock_audit
             (merchant_id, variation_id, location_id, previous_min, new_min,
              rule, reason, velocity_91d, days_of_stock, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [merchantId, variationId, locationId, previousMin, newMin,
            rule, reason, velocity91d, daysOfStock, quantity]
    );

    await client.query(
        `INSERT INTO min_max_audit_log
             (merchant_id, variation_id, location_id, old_min, new_min, reason, skipped, skip_reason)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, NULL)`,
        [merchantId, variationId, locationId, previousMin, newMin, reason]
    );

    return { variationId, locationId, previousMin, newMin };
}

/**
 * Write skipped/non-applicable recommendation records to min_max_audit_log.
 * Called by applyWeeklyAdjustments for all items the cron chose not to apply.
 *
 * @param {number} merchantId
 * @param {Array} recs - recommendation objects with skipped flag or null recommendedMin
 */
async function _logSkippedItems(merchantId, recs) {
    if (!recs.length) return;
    const now = new Date().toISOString();
    for (const rec of recs) {
        // Conflict skips carry a machine-readable code so the audit UI can render
        // a distinct warning style. Prose (with conflict_detail) goes into `reason`
        // so downstream viewers get context without parsing skip_reason.
        const isConflict = rec.skipped === 'min_would_meet_or_exceed_max';
        const skipReason = isConflict
            ? 'min_would_meet_or_exceed_max'
            : (rec.reason || 'No recommendation applicable');
        const reasonCol = isConflict ? (rec.reason || null) : null;

        await db.query(
            `INSERT INTO min_max_audit_log
                 (merchant_id, variation_id, location_id, old_min, new_min,
                  reason, skipped, skip_reason, created_at)
             VALUES ($1, $2, $3, $4, NULL, $5, TRUE, $6, $7)`,
            [merchantId, rec.variationId, rec.locationId, rec.currentMin,
                reasonCol, skipReason, now]
        );

        // Conflict skips must appear in the merchant-facing history UI with a
        // warning style. getHistory reads min_stock_audit, so we record a no-op
        // row there (new_min = previous_min) with rule='SKIPPED_CONFLICT'.
        if (isConflict) {
            await db.query(
                `INSERT INTO min_stock_audit
                     (merchant_id, variation_id, location_id, previous_min, new_min,
                      rule, reason, velocity_91d, days_of_stock, quantity, created_at)
                 VALUES ($1, $2, $3, $4, $4, 'SKIPPED_CONFLICT', $5, NULL, NULL, NULL, $6)`,
                [merchantId, rec.variationId, rec.locationId, rec.currentMin,
                    rec.reason || 'Min would meet or exceed max — review required', now]
            );
        }
    }
}

function _validateApplyArgs(merchantId, variationId, locationId, newMin) {
    if (!merchantId || !variationId || !locationId) {
        throw new Error('merchantId, variationId, and locationId are required');
    }
    if (!Number.isInteger(newMin) || newMin < 0) {
        throw new Error('newMin must be a non-negative integer');
    }
}

/**
 * Fire-and-forget Square push for min stock thresholds.
 * Local DB is source of truth — failures are logged as warnings only.
 */
function _pushToSquare(merchantId, changes) {
    pushMinStockThresholdsToSquare(merchantId, changes).catch(err => {
        logger.warn('pushMinStockThresholdsToSquare unexpected error', {
            merchantId, error: err.message
        });
    });
}

module.exports = {
    generateRecommendations,
    applyWeeklyAdjustments,
    applyRecommendation,
    applyAllRecommendations,
    pinVariation,
    toggleMinStockPin,
    getSuppressedItems,
    getAuditLog,
    getHistory
};
