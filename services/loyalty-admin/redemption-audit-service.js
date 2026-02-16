/**
 * Missed Redemption Audit Service
 *
 * Re-scans recent orders through all three detection strategies to catch
 * missed reward redemptions. Used as a one-time diagnostic/remediation tool.
 *
 * Strategies (in priority order):
 * 1. Catalog ID match — exact discount ID
 * 2. Free item — item is $0, variation matches offer
 * 3. Discount amount — total discount on qualifying items ≈ reward value
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { encryptToken, decryptToken, isEncryptedToken } = require('../../utils/token-encryption');
const { RedemptionTypes } = require('./constants');
const { detectRewardRedemptionFromOrder, redeemReward } = require('./reward-service');

/**
 * Fetch a single order from Square API with raw fetch.
 * @param {string} orderId - Square order ID
 * @param {string} accessToken - Decrypted Square access token
 * @returns {Promise<Object|null>} Order object or null
 */
async function fetchOrderFromSquare(orderId, accessToken) {
    try {
        const response = await fetch(`https://connect.squareup.com/v2/orders/${orderId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            }
        });

        if (!response.ok) {
            logger.warn('Audit: Square API returned non-OK status', {
                orderId, status: response.status, statusText: response.statusText
            });
            return null;
        }
        const data = await response.json();
        return data.order || null;
    } catch (err) {
        logger.error('Audit: Square API fetch threw', {
            orderId, error: err.message, code: err.code || err.cause?.code
        });
        return null;
    }
}

/**
 * Small delay helper for rate limiting Square API calls.
 * @param {number} ms - Milliseconds to wait
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Audit missed redemptions by re-scanning recent orders.
 *
 * @param {Object} params
 * @param {number} params.merchantId - Internal merchant ID
 * @param {number} [params.days=7] - How far back to scan
 * @param {boolean} [params.dryRun=true] - If true, report only. If false, redeem.
 * @returns {Promise<Object>} Audit results
 */
async function auditMissedRedemptions({ merchantId, days = 7, dryRun = true }) {
    // Get decrypted Square access token
    const tokenResult = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );
    if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
        throw new Error('No Square access token configured for this merchant');
    }
    const rawToken = tokenResult.rows[0].square_access_token;
    const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

    // Get all earned (not redeemed) rewards for the merchant
    const earnedResult = await db.query(`
        SELECT r.id AS reward_id, r.offer_id, r.square_customer_id, o.offer_name
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1 AND r.status = 'earned'
    `, [merchantId]);

    const earnedRewards = earnedResult.rows;

    logger.info('Audit: earned rewards found', {
        merchantId,
        count: earnedRewards.length,
        rewards: earnedRewards.map(r => ({
            reward_id: r.reward_id,
            square_customer_id: r.square_customer_id,
            offer_id: r.offer_id,
            offer_name: r.offer_name
        }))
    });

    if (earnedRewards.length === 0) {
        return { scanned: { rewards: 0, orders: 0 }, matches: [], dryRun };
    }

    // For each earned reward, find recent orders for that customer.
    // Date filter applied in code so we can log orders excluded by date.
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    logger.info('Audit: date filter', {
        merchantId,
        days,
        cutoffDate: cutoffDate.toISOString()
    });

    const allOrderIds = new Set();
    const rewardOrderMap = new Map(); // orderId -> Set<rewardId>

    for (const reward of earnedRewards) {
        const ordersResult = await db.query(`
            SELECT DISTINCT lpo.square_order_id, lpo.processed_at, lpo.created_at,
                            lpo.result_type, lpo.source
            FROM loyalty_processed_orders lpo
            WHERE lpo.merchant_id = $1
              AND lpo.square_customer_id = $2
        `, [merchantId, reward.square_customer_id]);

        const withinWindow = [];
        const outsideWindow = [];

        for (const row of ordersResult.rows) {
            if (new Date(row.processed_at) >= cutoffDate) {
                withinWindow.push(row);
            } else {
                outsideWindow.push(row);
            }
        }

        logger.info('Audit: orders for customer', {
            merchantId,
            reward_id: reward.reward_id,
            square_customer_id: reward.square_customer_id,
            totalOrders: ordersResult.rows.length,
            withinWindow: withinWindow.length,
            outsideWindow: outsideWindow.length,
            orders: ordersResult.rows.map(r => ({
                square_order_id: r.square_order_id,
                processed_at: r.processed_at,
                created_at: r.created_at,
                result_type: r.result_type,
                source: r.source,
                in_window: new Date(r.processed_at) >= cutoffDate
            }))
        });

        for (const row of withinWindow) {
            allOrderIds.add(row.square_order_id);
            if (!rewardOrderMap.has(row.square_order_id)) {
                rewardOrderMap.set(row.square_order_id, new Set());
            }
            rewardOrderMap.get(row.square_order_id).add(reward.reward_id);
        }
    }

    // Filter out orders that already triggered a redemption
    const orderIdArray = Array.from(allOrderIds);
    let unredeemedOrderIds = orderIdArray;

    logger.info('Audit: unique orders before redemption filter', {
        merchantId,
        count: orderIdArray.length,
        orderIds: orderIdArray
    });

    if (orderIdArray.length > 0) {
        const redeemedResult = await db.query(`
            SELECT DISTINCT square_order_id
            FROM loyalty_redemptions
            WHERE merchant_id = $1 AND square_order_id = ANY($2)
        `, [merchantId, orderIdArray]);

        const redeemedSet = new Set(redeemedResult.rows.map(r => r.square_order_id));
        unredeemedOrderIds = orderIdArray.filter(id => !redeemedSet.has(id));

        if (redeemedSet.size > 0) {
            logger.info('Audit: orders already redeemed (filtered out)', {
                merchantId,
                filteredCount: redeemedSet.size,
                filteredOrderIds: Array.from(redeemedSet)
            });
        }
    }

    logger.info('Audit: final orders to scan', {
        merchantId,
        count: unredeemedOrderIds.length,
        orderIds: unredeemedOrderIds
    });

    const matches = [];
    let ordersScanned = 0;

    // Fetch each order from Square and run detection via canonical function
    for (const orderId of unredeemedOrderIds) {
        logger.info('Audit: fetching order from Square', { orderId, merchantId });

        try {
            // Rate limiting: 200ms between Square API calls
            if (ordersScanned > 0) {
                await delay(200);
            }

            const order = await fetchOrderFromSquare(orderId, accessToken);
            ordersScanned++;

            if (!order) {
                logger.warn('Audit: could not fetch order from Square', { orderId, merchantId });
                continue;
            }

            // Log full order data so we can see exactly what Square returned
            logger.info('Audit: order fetched, running detection', {
                orderId,
                merchantId,
                customerId: order.customer_id,
                discounts: (order.discounts || []).map(d => ({
                    uid: d.uid,
                    name: d.name,
                    type: d.type,
                    catalog_object_id: d.catalog_object_id || null,
                    pricing_rule_id: d.pricing_rule_id || null,
                    applied_money: d.applied_money,
                    scope: d.scope
                })),
                lineItems: (order.line_items || []).map(li => ({
                    uid: li.uid,
                    name: li.name,
                    catalog_object_id: li.catalog_object_id || null,
                    variation_name: li.variation_name,
                    quantity: li.quantity,
                    base_price_money: li.base_price_money,
                    total_money: li.total_money,
                    total_discount_money: li.total_discount_money
                }))
            });

            // Use the canonical detection function (has DIAGNOSTIC logging)
            // dryRun=true: detect only, don't redeem inside detectRewardRedemptionFromOrder
            const detection = await detectRewardRedemptionFromOrder(
                order, merchantId, { dryRun: true }
            );

            if (!detection.detected) {
                logger.info('Audit: no detection match for order', {
                    orderId, merchantId, detectionError: detection.error || null
                });
                continue;
            }

            // If audit is not in dry-run, redeem the reward
            let redeemed = false;
            if (!dryRun) {
                try {
                    await redeemReward({
                        merchantId,
                        rewardId: detection.rewardId,
                        squareOrderId: order.id,
                        squareCustomerId: detection.squareCustomerId,
                        redemptionType: RedemptionTypes.AUTO_DETECTED,
                        redeemedValueCents: detection.discountDetails?.totalDiscountCents
                            || Number(detection.discountDetails?.appliedMoney?.amount || 0),
                        squareLocationId: order.location_id,
                        adminNotes: `Audit remediation (Strategy: ${detection.detectionMethod})`
                    });
                    redeemed = true;
                } catch (err) {
                    logger.error('Audit: failed to redeem reward', {
                        rewardId: detection.rewardId, orderId, error: err.message
                    });
                }
            }

            // Look up customer name for reporting
            let customerName = null;
            try {
                const custResult = await db.query(
                    `SELECT display_name FROM loyalty_customer_cache
                     WHERE merchant_id = $1 AND square_customer_id = $2`,
                    [merchantId, detection.squareCustomerId]
                );
                customerName = custResult.rows[0]?.display_name || null;
            } catch (_) { /* non-critical */ }

            const matchRecord = {
                rewardId: detection.rewardId,
                orderId: order.id,
                orderDate: order.created_at,
                customerName,
                offerName: detection.offerName,
                strategy: detection.detectionMethod,
                discountDetails: detection.discountDetails,
                redeemed
            };

            matches.push(matchRecord);

            logger.info('Audit: missed redemption found', {
                ...matchRecord,
                merchantId,
                dryRun
            });
        } catch (err) {
            logger.error('Audit: unexpected error processing order', {
                orderId, merchantId, error: err.message, stack: err.stack
            });
        }
    }

    return {
        scanned: { rewards: earnedRewards.length, orders: ordersScanned },
        matches,
        dryRun
    };
}

module.exports = {
    auditMissedRedemptions
};
