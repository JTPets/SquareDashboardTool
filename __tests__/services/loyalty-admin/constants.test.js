/**
 * Tests for services/loyalty-admin/constants.js
 *
 * Validates exported enums contain expected values and state machine integrity.
 */

const { RewardStatus, AuditActions, RedemptionTypes } = require('../../../services/loyalty-admin/constants');

describe('constants', () => {
    describe('RewardStatus', () => {
        test('has all expected statuses', () => {
            expect(RewardStatus.IN_PROGRESS).toBe('in_progress');
            expect(RewardStatus.EARNED).toBe('earned');
            expect(RewardStatus.REDEEMED).toBe('redeemed');
            expect(RewardStatus.REVOKED).toBe('revoked');
        });

        test('has exactly 4 statuses', () => {
            expect(Object.keys(RewardStatus)).toHaveLength(4);
        });

        test('values are lowercase strings', () => {
            Object.values(RewardStatus).forEach(value => {
                expect(value).toBe(value.toLowerCase());
                expect(typeof value).toBe('string');
            });
        });
    });

    describe('AuditActions', () => {
        test('has all expected actions', () => {
            const expectedActions = [
                'OFFER_CREATED', 'OFFER_UPDATED', 'OFFER_DEACTIVATED', 'OFFER_DELETED',
                'VARIATION_ADDED', 'VARIATION_REMOVED',
                'PURCHASE_RECORDED', 'REFUND_PROCESSED',
                'WINDOW_EXPIRED', 'REWARD_PROGRESS_UPDATED',
                'REWARD_EARNED', 'REWARD_REDEEMED', 'REWARD_REVOKED',
                'MANUAL_ADJUSTMENT'
            ];

            expectedActions.forEach(action => {
                expect(AuditActions[action]).toBe(action);
            });
        });

        test('has exactly 14 actions', () => {
            expect(Object.keys(AuditActions)).toHaveLength(14);
        });

        test('keys equal values (SCREAMING_SNAKE convention)', () => {
            Object.entries(AuditActions).forEach(([key, value]) => {
                expect(key).toBe(value);
            });
        });
    });

    describe('RedemptionTypes', () => {
        test('has all expected types', () => {
            expect(RedemptionTypes.ORDER_DISCOUNT).toBe('order_discount');
            expect(RedemptionTypes.MANUAL_ADMIN).toBe('manual_admin');
            expect(RedemptionTypes.AUTO_DETECTED).toBe('auto_detected');
        });

        test('has exactly 3 types', () => {
            expect(Object.keys(RedemptionTypes)).toHaveLength(3);
        });
    });
});
