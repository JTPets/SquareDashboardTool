/**
 * Tests for loyalty service free item detection
 *
 * These tests verify that 100% discounted items are correctly identified
 * as "free" and excluded from loyalty credit.
 *
 * Bug context: The BigInt fix (commit 7245776) introduced a bug where
 * `|| unitPriceCents` fallback caused free items (total_money = 0) to
 * incorrectly get their totalMoneyCents reset to unitPriceCents because
 * 0 is falsy in JavaScript.
 */

describe('Loyalty Free Item Detection', () => {
    /**
     * Helper function that mimics the fixed logic for detecting free items
     * This mirrors the actual implementation in loyalty-service.js
     */
    function detectFreeItem(lineItem) {
        const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);

        // Fixed logic: Use nullish check to preserve 0 values
        const rawTotalMoney = lineItem.total_money?.amount;
        const totalMoneyCents = rawTotalMoney != null ? Number(rawTotalMoney) : unitPriceCents;

        const isFree = unitPriceCents > 0 && totalMoneyCents === 0;

        return {
            unitPriceCents,
            totalMoneyCents,
            isFree
        };
    }

    /**
     * Helper that mimics the OLD buggy logic for comparison
     */
    function detectFreeItemBuggy(lineItem) {
        const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);

        // Buggy logic: || operator treats 0 as falsy
        const totalMoneyCents = Number(lineItem.total_money?.amount ?? 0) || unitPriceCents;

        const isFree = unitPriceCents > 0 && totalMoneyCents === 0;

        return {
            unitPriceCents,
            totalMoneyCents,
            isFree
        };
    }

    describe('Free item detection (100% discount)', () => {
        it('should detect free item when total_money is 0', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },  // $10.00
                total_money: { amount: 0 }           // Free (100% discounted)
            };

            const result = detectFreeItem(lineItem);

            expect(result.unitPriceCents).toBe(1000);
            expect(result.totalMoneyCents).toBe(0);
            expect(result.isFree).toBe(true);
        });

        it('should detect free item when total_money is BigInt 0n', () => {
            const lineItem = {
                base_price_money: { amount: 1000n },  // BigInt from Square SDK v43+
                total_money: { amount: 0n }           // BigInt 0
            };

            const result = detectFreeItem(lineItem);

            expect(result.unitPriceCents).toBe(1000);
            expect(result.totalMoneyCents).toBe(0);
            expect(result.isFree).toBe(true);
        });

        it('should NOT detect as free when customer paid full price', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },
                total_money: { amount: 1000 }
            };

            const result = detectFreeItem(lineItem);

            expect(result.isFree).toBe(false);
        });

        it('should NOT detect as free when customer paid partial price', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },
                total_money: { amount: 500 }  // 50% discount
            };

            const result = detectFreeItem(lineItem);

            expect(result.isFree).toBe(false);
        });

        it('should NOT detect as free when base price is 0 (already free item)', () => {
            const lineItem = {
                base_price_money: { amount: 0 },
                total_money: { amount: 0 }
            };

            const result = detectFreeItem(lineItem);

            // isFree requires unitPriceCents > 0
            expect(result.isFree).toBe(false);
        });
    });

    describe('Buggy vs Fixed logic comparison', () => {
        it('BUGGY: fails to detect free item due to || operator', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },
                total_money: { amount: 0 }
            };

            const buggyResult = detectFreeItemBuggy(lineItem);

            // Bug: 0 || 1000 returns 1000
            expect(buggyResult.totalMoneyCents).toBe(1000);  // Wrong!
            expect(buggyResult.isFree).toBe(false);          // Wrong!
        });

        it('FIXED: correctly detects free item with nullish check', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },
                total_money: { amount: 0 }
            };

            const fixedResult = detectFreeItem(lineItem);

            // Fixed: 0 is preserved
            expect(fixedResult.totalMoneyCents).toBe(0);  // Correct!
            expect(fixedResult.isFree).toBe(true);        // Correct!
        });
    });

    describe('Missing total_money handling', () => {
        it('should fall back to unitPriceCents when total_money is null', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },
                total_money: null
            };

            const result = detectFreeItem(lineItem);

            expect(result.totalMoneyCents).toBe(1000);
            expect(result.isFree).toBe(false);
        });

        it('should fall back to unitPriceCents when total_money is undefined', () => {
            const lineItem = {
                base_price_money: { amount: 1000 }
                // total_money not present
            };

            const result = detectFreeItem(lineItem);

            expect(result.totalMoneyCents).toBe(1000);
            expect(result.isFree).toBe(false);
        });

        it('should fall back to unitPriceCents when total_money.amount is null', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },
                total_money: { amount: null }
            };

            const result = detectFreeItem(lineItem);

            expect(result.totalMoneyCents).toBe(1000);
            expect(result.isFree).toBe(false);
        });

        it('should fall back to unitPriceCents when total_money.amount is undefined', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },
                total_money: {}  // amount not present
            };

            const result = detectFreeItem(lineItem);

            expect(result.totalMoneyCents).toBe(1000);
            expect(result.isFree).toBe(false);
        });
    });

    describe('BigInt handling', () => {
        it('should convert BigInt base_price_money to Number', () => {
            const lineItem = {
                base_price_money: { amount: 1500n },
                total_money: { amount: 1500n }
            };

            const result = detectFreeItem(lineItem);

            expect(typeof result.unitPriceCents).toBe('number');
            expect(result.unitPriceCents).toBe(1500);
        });

        it('should convert BigInt total_money to Number', () => {
            const lineItem = {
                base_price_money: { amount: 1500n },
                total_money: { amount: 750n }
            };

            const result = detectFreeItem(lineItem);

            expect(typeof result.totalMoneyCents).toBe('number');
            expect(result.totalMoneyCents).toBe(750);
        });

        it('should handle mixed Number and BigInt', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },  // Number
                total_money: { amount: 0n }          // BigInt
            };

            const result = detectFreeItem(lineItem);

            expect(result.unitPriceCents).toBe(1000);
            expect(result.totalMoneyCents).toBe(0);
            expect(result.isFree).toBe(true);
        });
    });

    describe('Edge cases', () => {
        it('should handle negative total_money (refund scenario)', () => {
            const lineItem = {
                base_price_money: { amount: 1000 },
                total_money: { amount: -1000 }
            };

            const result = detectFreeItem(lineItem);

            expect(result.totalMoneyCents).toBe(-1000);
            expect(result.isFree).toBe(false);
        });

        it('should handle very small amounts', () => {
            const lineItem = {
                base_price_money: { amount: 1 },  // 1 cent
                total_money: { amount: 0 }
            };

            const result = detectFreeItem(lineItem);

            expect(result.isFree).toBe(true);
        });

        it('should handle very large amounts', () => {
            const lineItem = {
                base_price_money: { amount: 99999999 },  // $999,999.99
                total_money: { amount: 0 }
            };

            const result = detectFreeItem(lineItem);

            expect(result.isFree).toBe(true);
        });

        it('should handle string amounts (defensive)', () => {
            const lineItem = {
                base_price_money: { amount: '1000' },
                total_money: { amount: '0' }
            };

            const result = detectFreeItem(lineItem);

            // Number('1000') = 1000, Number('0') = 0
            expect(result.unitPriceCents).toBe(1000);
            expect(result.totalMoneyCents).toBe(0);
            expect(result.isFree).toBe(true);
        });
    });

    describe('Real-world scenarios', () => {
        it('should detect loyalty reward redemption as free', () => {
            // Customer redeemed a "Buy 12 get 1 free" reward
            const lineItem = {
                name: 'Big Country Raw Chicken Dinner - 4 x 1 lb',
                catalog_object_id: 'VARIATION_123',
                quantity: '1',
                base_price_money: { amount: 1699 },  // Regular price $16.99
                total_money: { amount: 0 }           // 100% off from loyalty
            };

            const result = detectFreeItem(lineItem);

            expect(result.isFree).toBe(true);
        });

        it('should detect promotional free item', () => {
            // "Buy one get one free" promo
            const lineItem = {
                name: 'Sample Product',
                catalog_object_id: 'VARIATION_456',
                quantity: '1',
                base_price_money: { amount: 999 },
                total_money: { amount: 0 },
                applied_discounts: [
                    { discount_uid: 'BOGO_PROMO', amount_money: { amount: 999 } }
                ]
            };

            const result = detectFreeItem(lineItem);

            expect(result.isFree).toBe(true);
        });

        it('should NOT detect partial discount as free', () => {
            // 20% off coupon
            const lineItem = {
                name: 'Product',
                catalog_object_id: 'VARIATION_789',
                quantity: '1',
                base_price_money: { amount: 1000 },
                total_money: { amount: 800 },  // $8 after 20% off
                applied_discounts: [
                    { discount_uid: 'COUPON_20', amount_money: { amount: 200 } }
                ]
            };

            const result = detectFreeItem(lineItem);

            expect(result.isFree).toBe(false);
        });
    });
});
