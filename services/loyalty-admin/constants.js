/**
 * Loyalty Admin Constants
 *
 * Shared constants for the loyalty admin service layer.
 * These define the state machine for rewards and audit action types.
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

/**
 * Reward status state machine
 * Rewards progress: in_progress -> earned -> redeemed
 * Can also be revoked from any state (refund scenarios)
 */
const RewardStatus = {
    IN_PROGRESS: 'in_progress',
    EARNED: 'earned',
    REDEEMED: 'redeemed',
    REVOKED: 'revoked'
};

/**
 * Audit action types for loyalty operations
 * All loyalty operations must be auditable for compliance
 */
const AuditActions = {
    OFFER_CREATED: 'OFFER_CREATED',
    OFFER_UPDATED: 'OFFER_UPDATED',
    OFFER_DEACTIVATED: 'OFFER_DEACTIVATED',
    OFFER_DELETED: 'OFFER_DELETED',
    VARIATION_ADDED: 'VARIATION_ADDED',
    VARIATION_REMOVED: 'VARIATION_REMOVED',
    PURCHASE_RECORDED: 'PURCHASE_RECORDED',
    REFUND_PROCESSED: 'REFUND_PROCESSED',
    WINDOW_EXPIRED: 'WINDOW_EXPIRED',
    REWARD_PROGRESS_UPDATED: 'REWARD_PROGRESS_UPDATED',
    REWARD_EARNED: 'REWARD_EARNED',
    REWARD_REDEEMED: 'REWARD_REDEEMED',
    REWARD_REVOKED: 'REWARD_REVOKED',
    MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT'
};

/**
 * Redemption types for tracking how rewards were redeemed
 */
const RedemptionTypes = {
    ORDER_DISCOUNT: 'order_discount',
    MANUAL_ADMIN: 'manual_admin',
    AUTO_DETECTED: 'auto_detected'
};

module.exports = {
    RewardStatus,
    AuditActions,
    RedemptionTypes
};
