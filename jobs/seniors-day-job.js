/**
 * Seniors Day Discount Job
 *
 * Daily cron job that manages the seniors discount pricing rule:
 * - 1st of month: Enable pricing rule, then run local-only age sweep
 * - 2nd of month: Disable pricing rule
 * - All other days: Verify state matches expectations, auto-correct if needed
 *
 * Uses America/Toronto timezone for all date calculations.
 *
 * @module jobs/seniors-day-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const emailNotifier = require('../utils/email-notifier');
const { SeniorsService } = require('../services/seniors');
const { SENIORS_DISCOUNT } = require('../config/constants');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Get today's date components in America/Toronto timezone
 * @returns {{ dayOfMonth: number, dateStr: string }}
 */
function getTodayToronto() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    const dayOfMonth = parseInt(dateStr.split('-')[2], 10);
    return { dayOfMonth, dateStr };
}

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get merchants with seniors discount configured and enabled
 * @returns {Promise<Array<{id: number, business_name: string}>>}
 */
async function getMerchantsWithSeniorsConfig() {
    try {
        const result = await db.query(
            `SELECT m.id, m.business_name, sdc.day_of_month
             FROM merchants m
             JOIN seniors_discount_config sdc ON sdc.merchant_id = m.id
             WHERE m.is_active = TRUE
               AND m.square_access_token IS NOT NULL
               AND sdc.is_enabled = TRUE
               AND sdc.square_pricing_rule_id IS NOT NULL`
        );
        return result.rows;
    } catch (error) {
        // Table doesn't exist yet — migration not run
        if (error.message?.includes('does not exist')) {
            return [];
        }
        throw error;
    }
}

/**
 * Enable pricing rule with retry logic
 *
 * Note: enablePricingRule() validates the batchUpsertCatalog response directly
 * and handles VERSION_MISMATCH internally. We trust the write response rather
 * than making a separate verification GET (which is subject to Square's
 * eventual consistency and caused false-negative failures).
 * The daily cron's "all other days" path verifies state as a safety net.
 *
 * @param {SeniorsService} service - Initialized seniors service
 * @param {number} merchantId
 * @returns {Promise<Object>} Enable result
 */
async function enableWithRetry(service, merchantId) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await service.enablePricingRule();
        } catch (error) {
            logger.warn('Seniors pricing rule enable attempt failed', {
                merchantId, attempt, maxRetries: MAX_RETRIES,
                error: error.message,
            });

            if (attempt === MAX_RETRIES) {
                throw error;
            }
            await sleep(RETRY_DELAY_MS * attempt);
        }
    }
}

/**
 * Disable pricing rule with retry logic
 *
 * Note: disablePricingRule() validates the batchUpsertCatalog response directly
 * and handles VERSION_MISMATCH internally. See enableWithRetry for rationale.
 *
 * @param {SeniorsService} service - Initialized seniors service
 * @param {number} merchantId
 * @returns {Promise<Object>} Disable result
 */
async function disableWithRetry(service, merchantId) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await service.disablePricingRule();
        } catch (error) {
            logger.warn('Seniors pricing rule disable attempt failed', {
                merchantId, attempt, maxRetries: MAX_RETRIES,
                error: error.message,
            });

            if (attempt === MAX_RETRIES) {
                throw error;
            }
            await sleep(RETRY_DELAY_MS * attempt);
        }
    }
}

/**
 * Run seniors discount check for a single merchant
 * @param {number} merchantId
 * @param {string} businessName
 * @param {number} [configDayOfMonth] - Per-tenant day of month (from DB)
 * @returns {Promise<Object>} Result for this merchant
 */
async function runSeniorsDiscountForMerchant(merchantId, businessName, configDayOfMonth) {
    const { dayOfMonth } = getTodayToronto();
    const seniorsDayOfMonth = configDayOfMonth || SENIORS_DISCOUNT.DAY_OF_MONTH;

    const service = new SeniorsService(merchantId);
    await service.initialize();

    const result = {
        merchantId,
        businessName,
        dayOfMonth,
        seniorsDayOfMonth,
        action: 'none',
    };

    if (dayOfMonth === seniorsDayOfMonth) {
        // 1st of month: enable pricing rule, then sweep local DB for age changes
        await enableWithRetry(service, merchantId);
        result.ageSweep = await service.sweepLocalAges();
        result.action = 'enabled';

        await service.logAudit('PRICING_RULE_ENABLED', null, {
            date: getTodayToronto().dateStr,
            ageSweep: result.ageSweep,
        }, 'CRON');

    } else if (dayOfMonth === seniorsDayOfMonth + 1) {
        // 2nd of month: disable
        await disableWithRetry(service, merchantId);
        result.action = 'disabled';

        await service.logAudit('PRICING_RULE_DISABLED', null, {
            date: getTodayToronto().dateStr,
        }, 'CRON');

    } else {
        // All other days: verify state is correct (should be disabled)
        // Trust local DB if we already verified disabled after last cycle
        const config = service.config;
        const alreadyVerifiedDisabled = config.last_verified_state === 'disabled'
            && config.last_verified_at
            && config.last_disabled_at
            && new Date(config.last_verified_at) >= new Date(config.last_disabled_at);

        if (alreadyVerifiedDisabled) {
            result.action = 'skipped_verified';
        } else {
            const verification = await service.verifyPricingRuleState(false);
            if (!verification.verified) {
                logger.warn('Seniors pricing rule state mismatch, auto-correcting', {
                    merchantId, ...verification,
                });
                await disableWithRetry(service, merchantId);
                result.action = 'auto_corrected';

                await service.logAudit('PRICING_RULE_DISABLED', null, {
                    date: getTodayToronto().dateStr,
                    reason: 'auto_correction',
                    previousState: verification.actual,
                }, 'CRON');
            }
        }
    }

    return result;
}

/**
 * Run seniors discount check for all configured merchants
 * @returns {Promise<Object>} Results for all merchants
 */
async function runSeniorsDiscountForAllMerchants() {
    const merchants = await getMerchantsWithSeniorsConfig();

    if (merchants.length === 0) {
        logger.info('No merchants configured for seniors discount');
        return { merchantCount: 0, results: [] };
    }

    logger.info('Running seniors discount check', {
        merchantCount: merchants.length,
        dayOfMonth: getTodayToronto().dayOfMonth,
    });

    const results = [];
    for (const merchant of merchants) {
        try {
            const result = await runSeniorsDiscountForMerchant(
                merchant.id, merchant.business_name, merchant.day_of_month
            );
            results.push(result);
        } catch (error) {
            logger.error('Seniors discount check failed for merchant', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: error.message,
                stack: error.stack,
            });

            // Alert on final failure (retries exhausted)
            try {
                await emailNotifier.sendAlert(
                    `Seniors Discount Failed - ${merchant.business_name}`,
                    `Failed to manage seniors pricing rule:\n\n` +
                    `Merchant: ${merchant.business_name} (${merchant.id})\n` +
                    `Day: ${getTodayToronto().dateStr}\n` +
                    `Error: ${error.message}\n\n` +
                    `Stack: ${error.stack}`
                );
            } catch (emailError) {
                logger.error('Failed to send seniors discount alert email', {
                    error: emailError.message,
                });
            }

            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: error.message,
            });
        }
    }

    return { merchantCount: merchants.length, results };
}

/**
 * Verify pricing rule state on startup — auto-correct if mismatched
 * Called during cron initialization to handle cases where
 * the server was offline during a scheduled enable/disable
 * @returns {Promise<void>}
 */
async function verifyStateOnStartup() {
    try {
        const merchants = await getMerchantsWithSeniorsConfig();
        if (merchants.length === 0) return;

        const { dayOfMonth } = getTodayToronto();

        for (const merchant of merchants) {
            try {
                const seniorsDayOfMonth = merchant.day_of_month || SENIORS_DISCOUNT.DAY_OF_MONTH;
                const expectedEnabled = dayOfMonth === seniorsDayOfMonth;

                const service = new SeniorsService(merchant.id);
                await service.initialize();

                // On non-seniors days, trust local state if already verified disabled
                if (!expectedEnabled) {
                    const cfg = service.config;
                    const alreadyVerifiedDisabled = cfg.last_verified_state === 'disabled'
                        && cfg.last_verified_at
                        && cfg.last_disabled_at
                        && new Date(cfg.last_verified_at) >= new Date(cfg.last_disabled_at);

                    if (alreadyVerifiedDisabled) {
                        logger.info('Seniors startup check: local state trusted (disabled)', {
                            merchantId: merchant.id,
                        });
                        continue;
                    }
                }

                const verification = await service.verifyPricingRuleState(expectedEnabled);
                if (!verification.verified) {
                    logger.warn('Seniors pricing rule state mismatch on startup, correcting', {
                        merchantId: merchant.id, ...verification,
                    });

                    if (expectedEnabled) {
                        await enableWithRetry(service, merchant.id);
                    } else {
                        await disableWithRetry(service, merchant.id);
                    }

                    await service.logAudit(
                        expectedEnabled ? 'PRICING_RULE_ENABLED' : 'PRICING_RULE_DISABLED',
                        null,
                        { reason: 'startup_correction', previousState: verification.actual },
                        'CRON'
                    );
                }
            } catch (error) {
                logger.error('Seniors startup state check failed for merchant', {
                    merchantId: merchant.id, error: error.message,
                });
            }
        }
    } catch (error) {
        // Don't log error-level if tables simply don't exist yet
        if (error.message?.includes('does not exist')) {
            logger.info('Seniors discount tables not created yet — skipping startup check');
            return;
        }
        logger.error('Seniors startup state verification failed', {
            error: error.message,
        });
    }
}

/**
 * Cron job entry point — wraps with error handling
 * @returns {Promise<void>}
 */
async function runScheduledSeniorsDiscount() {
    try {
        await runSeniorsDiscountForAllMerchants();
    } catch (error) {
        logger.error('Scheduled seniors discount check failed', {
            error: error.message, stack: error.stack,
        });
        try {
            await emailNotifier.sendAlert(
                'Seniors Discount Automation Failed',
                `Failed to run scheduled seniors discount check:\n\n` +
                `${error.message}\n\nStack: ${error.stack}`
            );
        } catch (emailError) {
            logger.error('Failed to send seniors discount failure alert', {
                error: emailError.message,
            });
        }
    }
}

module.exports = {
    runSeniorsDiscountForMerchant,
    runSeniorsDiscountForAllMerchants,
    runScheduledSeniorsDiscount,
    verifyStateOnStartup,
    getMerchantsWithSeniorsConfig,
};
