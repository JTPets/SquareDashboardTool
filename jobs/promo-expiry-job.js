/**
 * Promo Expiry Job
 *
 * Runs weekly. Finds active subscribers whose promotional pricing period
 * (promo_expires_at) has elapsed and reverts them to base plan pricing.
 * Clears promo_code_id, resets discount_applied_cents, and updates
 * price_cents to the base plan price.
 *
 * Supports dry-run mode for safe testing before live execution.
 *
 * @module jobs/promo-expiry-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

/**
 * Query subscribers whose promo has expired but subscription is still active.
 * Includes promo_code_id IS NOT NULL for idempotency (skip already-reverted).
 * @returns {Promise<Array>}
 */
async function getExpiredPromoSubscribers() {
    const result = await db.query(`
        SELECT id, email, business_name, promo_expires_at,
               subscription_plan, merchant_id, promo_code_id,
               discount_applied_cents, price_cents
        FROM subscribers
        WHERE subscription_status = 'active'
          AND promo_code_id IS NOT NULL
          AND promo_expires_at IS NOT NULL
          AND promo_expires_at < NOW()
        ORDER BY promo_expires_at ASC
    `);
    return result.rows;
}

/**
 * Look up the base plan price for a subscriber's plan.
 * @param {string} planKey - e.g. 'monthly', 'annual'
 * @param {number} merchantId
 * @returns {Promise<number|null>} price_cents or null if not found
 */
async function getBasePlanPrice(planKey, merchantId) {
    const result = await db.query(
        'SELECT price_cents FROM subscription_plans WHERE plan_key = $1 AND merchant_id = $2',
        [planKey, merchantId]
    );
    return result.rows[0]?.price_cents || null;
}

/**
 * Revert a single subscriber from promo pricing to base plan pricing.
 * Uses a transaction for atomicity. Logs audit event.
 * @param {Object} sub - Subscriber row from getExpiredPromoSubscribers
 * @returns {Promise<Object>} { reverted, basePriceCents, previousPriceCents }
 */
async function revertSubscriberPromo(sub) {
    const basePriceCents = await getBasePlanPrice(sub.subscription_plan, sub.merchant_id);

    if (!basePriceCents) {
        logger.error('Cannot revert promo: base plan price not found', {
            subscriberId: sub.id,
            merchantId: sub.merchant_id,
            plan: sub.subscription_plan
        });
        return { reverted: false };
    }

    await db.transaction(async (client) => {
        await client.query(`
            UPDATE subscribers
            SET promo_code_id = NULL,
                discount_applied_cents = 0,
                promo_expires_at = NULL,
                price_cents = $1,
                updated_at = NOW()
            WHERE id = $2 AND merchant_id = $3
        `, [basePriceCents, sub.id, sub.merchant_id]);

        await client.query(`
            INSERT INTO subscription_events
                (merchant_id, subscriber_id, event_type, event_data)
            VALUES ($1, $2, $3, $4)
        `, [
            sub.merchant_id,
            sub.id,
            'promo.expired_revert',
            JSON.stringify({
                previousPriceCents: sub.price_cents,
                newPriceCents: basePriceCents,
                previousPromoCodeId: sub.promo_code_id,
                discountRemovedCents: sub.discount_applied_cents,
                promoExpiredAt: sub.promo_expires_at
            })
        ]);
    });

    return { reverted: true, basePriceCents, previousPriceCents: sub.price_cents };
}

/**
 * Core expiry check logic — exported for direct invocation in tests.
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - If true, detect and log but do not revert
 * @returns {Promise<Object>} { flagged, reverted, errors, details }
 */
async function runPromoExpiryCheck({ dryRun = false } = {}) {
    const expired = await getExpiredPromoSubscribers();

    if (expired.length === 0) {
        logger.info('Promo expiry check: no expired promos found');
        return { flagged: 0, reverted: 0, errors: 0, details: [] };
    }

    const mode = dryRun ? '[DRY RUN] ' : '';
    let reverted = 0;
    let errors = 0;
    const details = [];

    for (const sub of expired) {
        logger.warn(`${mode}Promotional pricing expired`, {
            subscriberId: sub.id,
            merchantId: sub.merchant_id,
            promoExpiresAt: sub.promo_expires_at,
            plan: sub.subscription_plan,
            currentPriceCents: sub.price_cents,
            dryRun
        });

        if (dryRun) {
            details.push({ subscriberId: sub.id, action: 'would_revert' });
            continue;
        }

        try {
            const result = await revertSubscriberPromo(sub);
            if (result.reverted) {
                reverted++;
                logger.info('Promo billing reverted to base price', {
                    subscriberId: sub.id,
                    merchantId: sub.merchant_id,
                    previousPriceCents: result.previousPriceCents,
                    newPriceCents: result.basePriceCents
                });
                details.push({
                    subscriberId: sub.id,
                    action: 'reverted',
                    previousPriceCents: result.previousPriceCents,
                    newPriceCents: result.basePriceCents
                });
            } else {
                errors++;
                details.push({ subscriberId: sub.id, action: 'skipped_no_plan' });
            }
        } catch (error) {
            errors++;
            logger.error('Failed to revert promo for subscriber', {
                subscriberId: sub.id,
                merchantId: sub.merchant_id,
                error: error.message
            });
            details.push({ subscriberId: sub.id, action: 'error', error: error.message });
        }
    }

    logger.info(`${mode}Promo expiry check complete`, {
        flagged: expired.length,
        reverted,
        errors,
        dryRun
    });

    return { flagged: expired.length, reverted, errors, details };
}

/**
 * Scheduled entry point — catches errors so cron keeps running.
 */
async function runScheduledPromoExpiryCheck() {
    try {
        return await runPromoExpiryCheck();
    } catch (error) {
        logger.error('Promo expiry job failed', { error: error.message });
        return { flagged: 0, reverted: 0, errors: 0, details: [] };
    }
}

module.exports = {
    runPromoExpiryCheck,
    runScheduledPromoExpiryCheck,
    getExpiredPromoSubscribers,
    getBasePlanPrice,
    revertSubscriberPromo
};
