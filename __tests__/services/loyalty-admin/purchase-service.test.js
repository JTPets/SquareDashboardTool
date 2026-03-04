/**
 * Tests for services/loyalty-admin/purchase-service.js
 *
 * T-1: Financial/loyalty services — core financial logic.
 * Focus on boundary conditions: zero quantities, negative amounts,
 * partial refunds, duplicate events, idempotency.
 *
 * KNOWN BUG: processRefund idempotency key uses Date.now(), causing
 * non-deterministic keys that defeat dedup on duplicate webhook fire.
 * See docs/TECHNICAL_DEBT.md.
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

const mockClient = {
    query: jest.fn(),
    release: jest.fn()
};

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    pool: {
        connect: jest.fn().mockResolvedValue(mockClient)
    },
    _mockClient: mockClient
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: { debug: jest.fn(), audit: jest.fn(), error: jest.fn() }
}));

const mockGetOfferForVariation = jest.fn();
jest.mock('../../../services/loyalty-admin/variation-admin-service', () => ({
    getOfferForVariation: mockGetOfferForVariation
}));

const mockLogAuditEvent = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: mockLogAuditEvent
}));

const mockUpdateCustomerStats = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    updateCustomerStats: mockUpdateCustomerStats
}));

const mockCreateDiscount = jest.fn().mockResolvedValue({ success: true, groupId: 'g1', discountId: 'd1' });
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: mockCreateDiscount
}));

const db = require('../../../utils/database');
const {
    processQualifyingPurchase,
    processRefund,
    updateRewardProgress,
    updateCustomerSummary
} = require('../../../services/loyalty-admin/purchase-service');

// ============================================================================
// HELPERS
// ============================================================================

const OFFER = {
    id: 10,
    offer_name: 'Buy 12 Get 1 Free',
    required_quantity: 12,
    window_months: 12,
    merchant_id: 1
};

function setupMockClientForPurchase(opts = {}) {
    const {
        existingPurchaseEvent = false,
        existingPurchases = null,
        currentQuantity = 0,
        existingReward = null,
        windowDates = { start_date: null, end_date: null }
    } = opts;

    let callIndex = 0;
    mockClient.query.mockImplementation(async (sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return {};
        }

        // Idempotency check
        if (sql.includes('SELECT id FROM loyalty_purchase_events') && sql.includes('idempotency_key')) {
            return { rows: existingPurchaseEvent ? [{ id: 99 }] : [] };
        }

        // Existing purchases (window start)
        if (sql.includes('MIN(purchased_at) as first_purchase')) {
            return { rows: [existingPurchases || { first_purchase: null }] };
        }

        // INSERT purchase event (non-refund — has is_refund column but set to false)
        if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('RETURNING')) {
            return { rows: [{ id: 100, quantity: params[6], offer_id: OFFER.id }] };
        }

        // updateRewardProgress - quantity
        if (sql.includes('COALESCE(SUM(quantity), 0) as total_quantity')) {
            return { rows: [{ total_quantity: currentQuantity }] };
        }

        // Get existing in_progress reward
        if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
            return { rows: existingReward ? [existingReward] : [] };
        }

        // Create new in_progress reward
        if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
            return {
                rows: [{
                    id: 200,
                    status: 'in_progress',
                    current_quantity: currentQuantity,
                    required_quantity: OFFER.required_quantity
                }]
            };
        }

        // UPDATE reward quantity
        if (sql.includes('UPDATE loyalty_rewards') && sql.includes('current_quantity')) {
            return { rows: [] };
        }

        // Window dates for new reward
        if (sql.includes('MIN(window_start_date) as start_date')) {
            return { rows: [windowDates] };
        }

        // updateCustomerSummary queries
        if (sql.includes('current_quantity') && sql.includes('lifetime_purchases')) {
            return { rows: [{ current_quantity: 0, lifetime_purchases: 0, last_purchase: null, window_start: null, window_end: null }] };
        }
        if (sql.includes('COUNT(*)') && sql.includes("status = 'earned'")) {
            return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*)') && sql.includes("status = 'redeemed'")) {
            return { rows: [{ count: 0 }] };
        }
        if (sql.includes('COUNT(*)') && sql.includes("IN ('earned', 'redeemed')")) {
            return { rows: [{ count: 0 }] };
        }
        if (sql.includes('SELECT required_quantity FROM loyalty_offers')) {
            return { rows: [{ required_quantity: OFFER.required_quantity }] };
        }
        if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'")) {
            return { rows: [] };
        }
        if (sql.includes('INSERT INTO loyalty_customer_summary') || sql.includes('ON CONFLICT')) {
            return { rows: [] };
        }

        // Default fallback
        return { rows: [] };
    });
}

// ============================================================================
// TESTS — processQualifyingPurchase
// ============================================================================

describe('processQualifyingPurchase', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetOfferForVariation.mockResolvedValue(OFFER);
    });

    it('should throw when merchantId is missing', async () => {
        await expect(processQualifyingPurchase({
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            purchasedAt: new Date()
        })).rejects.toThrow('merchantId is required');
    });

    it('should skip when no customer ID provided', async () => {
        const result = await processQualifyingPurchase({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: null,
            variationId: 'var_1',
            quantity: 2,
            purchasedAt: new Date()
        });

        expect(result).toEqual({ processed: false, reason: 'no_customer' });
    });

    it('should skip when variation does not qualify for any offer', async () => {
        mockGetOfferForVariation.mockResolvedValue(null);

        const result = await processQualifyingPurchase({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'nonqualifying_var',
            quantity: 2,
            purchasedAt: new Date()
        });

        expect(result).toEqual({ processed: false, reason: 'variation_not_qualifying' });
    });

    it('should return already_processed for duplicate idempotency key', async () => {
        setupMockClientForPurchase({ existingPurchaseEvent: true });

        // Since there's no transactionClient, the idempotency check uses db.query
        db.query.mockResolvedValueOnce({ rows: [{ id: 99 }] });

        const result = await processQualifyingPurchase({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            purchasedAt: new Date()
        });

        expect(result).toEqual({ processed: false, reason: 'already_processed' });
    });

    it('should record purchase and update reward progress', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // idempotency check

        setupMockClientForPurchase({ currentQuantity: 5 });

        const result = await processQualifyingPurchase({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 3,
            unitPriceCents: 3999,
            totalPriceCents: 11997,
            purchasedAt: new Date('2026-01-15'),
            squareLocationId: 'loc_1',
            receiptUrl: 'https://squareup.com/receipt/123',
            customerSource: 'order',
            paymentType: 'CARD'
        });

        expect(result.processed).toBe(true);
        expect(result.purchaseEvent).toBeDefined();
        expect(result.reward).toBeDefined();

        // Verify BEGIN/COMMIT were called
        const queries = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).toContain('BEGIN');
        expect(queries).toContain('COMMIT');
    });

    it('should rollback on error during processing', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // idempotency check

        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN') return {};
            if (sql === 'ROLLBACK') return {};
            if (sql.includes('INSERT INTO loyalty_purchase_events')) {
                throw new Error('DB constraint violation');
            }
            return { rows: [] };
        });

        await expect(processQualifyingPurchase({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            purchasedAt: new Date()
        })).rejects.toThrow('DB constraint violation');

        // Verify ROLLBACK was called
        const queries = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).toContain('ROLLBACK');
    });

    it('should use transactionClient when provided (no own transaction)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // idempotency check - uses transactionClient

        const txClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
                // Idempotency check (uses txClient when provided)
                if (sql.includes('SELECT id FROM loyalty_purchase_events') && sql.includes('idempotency_key')) {
                    return { rows: [] };
                }
                if (sql.includes('MIN(purchased_at)')) {
                    return { rows: [{ first_purchase: null }] };
                }
                if (sql.includes('INSERT INTO loyalty_purchase_events')) {
                    return { rows: [{ id: 100, quantity: 2, offer_id: OFFER.id }] };
                }
                if (sql.includes('total_quantity')) {
                    return { rows: [{ total_quantity: 2 }] };
                }
                if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                    return { rows: [] };
                }
                if (sql.includes("INSERT INTO loyalty_rewards")) {
                    return { rows: [{ id: 200, status: 'in_progress', current_quantity: 2, required_quantity: 12 }] };
                }
                if (sql.includes('MIN(window_start_date)')) {
                    return { rows: [{ start_date: null, end_date: null }] };
                }
                // updateCustomerSummary queries
                if (sql.includes('current_quantity') && sql.includes('lifetime_purchases')) {
                    return { rows: [{ current_quantity: 0, lifetime_purchases: 0, last_purchase: null, window_start: null, window_end: null }] };
                }
                if (sql.includes('COUNT(*)')) {
                    return { rows: [{ count: 0 }] };
                }
                if (sql.includes('SELECT required_quantity')) {
                    return { rows: [{ required_quantity: 12 }] };
                }
                if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'")) {
                    return { rows: [] };
                }
                return { rows: [] };
            })
        };

        const result = await processQualifyingPurchase({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            purchasedAt: new Date()
        }, { transactionClient: txClient });

        expect(result.processed).toBe(true);

        // Should NOT call BEGIN/COMMIT on txClient (caller manages)
        const queries = txClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).not.toContain('BEGIN');
        expect(queries).not.toContain('COMMIT');

        // Should NOT acquire a pool connection
        expect(db.pool.connect).not.toHaveBeenCalled();
    });

    it('should calculate correct window dates', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // idempotency check

        setupMockClientForPurchase({ currentQuantity: 1 });

        const purchaseDate = new Date('2026-03-01');
        const result = await processQualifyingPurchase({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            purchasedAt: purchaseDate
        });

        expect(result.processed).toBe(true);

        // Find the INSERT call and verify window dates
        const insertCall = mockClient.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO loyalty_purchase_events')
                && c[0].includes('RETURNING')
        );
        expect(insertCall).toBeDefined();

        const params = insertCall[1];
        // window_start_date (param index 10) should be purchase date
        expect(params[10]).toBe('2026-03-01');
        // window_end_date (param index 11) should be 12 months later
        expect(params[11]).toBe('2027-03-01');
    });

    it('should handle zero quantity purchase gracefully', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // idempotency check

        setupMockClientForPurchase({ currentQuantity: 0 });

        const result = await processQualifyingPurchase({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 0,
            purchasedAt: new Date()
        });

        // Should still process (quantity=0 is valid, just won't affect reward progress)
        expect(result.processed).toBe(true);
    });
});

// ============================================================================
// TESTS — processRefund
// ============================================================================

describe('processRefund', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetOfferForVariation.mockResolvedValue(OFFER);
    });

    it('should throw when merchantId is missing', async () => {
        await expect(processRefund({
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date()
        })).rejects.toThrow('merchantId is required');
    });

    it('should skip when variation does not qualify for any offer', async () => {
        mockGetOfferForVariation.mockResolvedValue(null);

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'nonqualifying_var',
            quantity: 2,
            refundedAt: new Date()
        });

        expect(result).toEqual({ processed: false, reason: 'variation_not_qualifying' });
    });

    it('should ensure negative quantity for refund events', async () => {
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            // INSERT refund event
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                const quantity = params[6]; // quantity param
                expect(quantity).toBeLessThan(0);
                return { rows: [{ id: 101, quantity }] };
            }

            // Earned reward check
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return { rows: [] };
            }

            // updateRewardProgress
            if (sql.includes('total_quantity')) {
                return { rows: [{ total_quantity: 0 }] };
            }

            // in_progress reward
            if (sql.includes("status = 'in_progress'")) {
                return { rows: [] };
            }

            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases')) {
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            }
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity')) return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };

            return { rows: [] };
        });

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 3,  // Positive input
            refundedAt: new Date()
        });

        expect(result.processed).toBe(true);
    });

    it('should ensure negative quantity even when input is already negative', async () => {
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                const quantity = params[6];
                expect(quantity).toBe(-5); // Should be -5, not --5 = 5
                return { rows: [{ id: 101, quantity }] };
            }

            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 0 }] };
            if (sql.includes("status = 'in_progress'")) return { rows: [] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity')) return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: -5, // Already negative
            refundedAt: new Date()
        });
    });

    it('should revoke earned reward when refund reduces quantity below threshold', async () => {
        let revokedRewardId = null;
        let unlockedRewardId = null;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            // INSERT refund
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -3 }] };
            }

            // Earned reward check
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 50,
                        offer_id: OFFER.id,
                        square_customer_id: 'cust_1',
                        status: 'earned'
                    }]
                };
            }

            // Locked quantity — less than required after refund
            if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id')) {
                return { rows: [{ total: 10 }] }; // 10 < 12 required
            }

            // Revoke reward
            if (sql.includes("SET status = 'revoked'")) {
                revokedRewardId = params[0];
                return { rows: [] };
            }

            // Unlock purchase events
            if (sql.includes('SET reward_id = NULL') && sql.includes('WHERE reward_id')) {
                unlockedRewardId = params[0];
                return { rows: [] };
            }

            // updateRewardProgress
            if (sql.includes('total_quantity') && !sql.includes('reward_id')) {
                return { rows: [{ total_quantity: 10 }] };
            }
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                return { rows: [] };
            }
            // Create new in_progress since quantity > 0
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
                return { rows: [{ id: 201, status: 'in_progress', current_quantity: 10, required_quantity: 12 }] };
            }
            if (sql.includes('MIN(window_start_date)')) {
                return { rows: [{ start_date: '2026-01-01', end_date: '2026-12-31' }] };
            }

            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'"))
                return { rows: [] };
            return { rows: [] };
        });

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 3,
            refundedAt: new Date()
        });

        expect(result.processed).toBe(true);
        expect(result.rewardAffected).toBe(true);
        expect(revokedRewardId).toBe(50);
        expect(unlockedRewardId).toBe(50);
    });

    it('should rollback on error during refund processing', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN') return {};
            if (sql === 'ROLLBACK') return {};
            if (sql.includes('INSERT INTO loyalty_purchase_events')) {
                throw new Error('DB write failed');
            }
            return { rows: [] };
        });

        await expect(processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date()
        })).rejects.toThrow('DB write failed');

        const queries = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).toContain('ROLLBACK');
    });

    it('BUG: refund idempotency key uses Date.now() — duplicates not caught', async () => {
        // This test documents the known bug. The idempotency key for refunds
        // includes Date.now(), meaning two webhook fires for the same refund
        // get different keys and BOTH will be inserted.
        //
        // Compare with processQualifyingPurchase which uses deterministic keys:
        //   `${squareOrderId}:${variationId}:${quantity}`
        //
        // The refund key should be:
        //   `refund:${squareOrderId}:${variationId}:${quantity}`
        // WITHOUT Date.now().

        // We verify the bug exists by checking the source behavior:
        // If two refunds with identical data are processed, both should succeed
        // (because Date.now() makes keys unique) — this IS the bug.

        let insertCount = 0;
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                insertCount++;
                return { rows: [{ id: 100 + insertCount, quantity: -2 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 0 }] };
            if (sql.includes("status = 'in_progress'")) return { rows: [] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity')) return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const refundData = {
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date()
        };

        await processRefund(refundData);
        await processRefund(refundData);

        // BUG: Both refunds inserted (insertCount = 2).
        // Expected behavior: second should be deduped (insertCount = 1).
        expect(insertCount).toBe(2); // Documents the bug — this SHOULD be 1
    });

    it('should calculate negative total_price_cents for refund', async () => {
        let capturedTotalPrice = null;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                capturedTotalPrice = params[8]; // total_price_cents
                return { rows: [{ id: 101, quantity: params[6] }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 0 }] };
            if (sql.includes("status = 'in_progress'")) return { rows: [] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity')) return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 3,
            unitPriceCents: 1000,
            refundedAt: new Date()
        });

        // total = refundQuantity * unitPriceCents = -3 * 1000 = -3000
        expect(capturedTotalPrice).toBe(-3000);
    });
});

// ============================================================================
// TESTS — updateRewardProgress
// ============================================================================

describe('updateRewardProgress', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should create in_progress reward when no existing reward and quantity > 0', async () => {
        let createdReward = false;

        mockClient.query.mockImplementation(async (sql) => {
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 5 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes('MIN(window_start_date)')) {
                return { rows: [{ start_date: '2026-01-01', end_date: '2027-01-01' }] };
            }
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
                createdReward = true;
                return { rows: [{ id: 300, status: 'in_progress', current_quantity: 5, required_quantity: 12 }] };
            }
            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await updateRewardProgress(mockClient, {
            merchantId: 1,
            offerId: OFFER.id,
            squareCustomerId: 'cust_1',
            offer: OFFER
        });

        expect(createdReward).toBe(true);
        expect(result.status).toBe('in_progress');
        expect(result.currentQuantity).toBe(5);
    });

    it('should not create reward when quantity is 0', async () => {
        let createdReward = false;

        mockClient.query.mockImplementation(async (sql) => {
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 0 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes("INSERT INTO loyalty_rewards")) {
                createdReward = true;
                return { rows: [{ id: 300 }] };
            }
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await updateRewardProgress(mockClient, {
            merchantId: 1,
            offerId: OFFER.id,
            squareCustomerId: 'cust_1',
            offer: OFFER
        });

        expect(createdReward).toBe(false);
        expect(result.status).toBe('no_progress');
    });

    it('should transition to earned when quantity meets threshold', async () => {
        let earnedTransition = false;

        mockClient.query.mockImplementation(async (sql, params) => {
            // First quantity check
            if (sql.includes('total_quantity') && !earnedTransition) {
                return { rows: [{ total_quantity: 12 }] };
            }

            // Existing in_progress reward
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 200, status: 'in_progress',
                        current_quantity: 11, required_quantity: 12
                    }]
                };
            }

            // UPDATE quantity
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes('current_quantity = $1')) {
                return { rows: [] };
            }

            // Lock rows (split-row locking)
            if (sql.includes('UPDATE loyalty_purchase_events') && sql.includes('reward_id = $1')
                && sql.includes('cumulative_qty')) {
                return { rows: [{ id: 1, quantity: 12, cumulative_qty: 12 }] };
            }

            // Earn transition
            if (sql.includes("SET status = 'earned'")) {
                earnedTransition = true;
                return { rows: [] };
            }

            // Re-count after earning
            if (sql.includes('total_quantity') && earnedTransition) {
                return { rows: [{ total_quantity: 0 }] };
            }

            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'"))
                return { rows: [] };

            return { rows: [] };
        });

        const result = await updateRewardProgress(mockClient, {
            merchantId: 1,
            offerId: OFFER.id,
            squareCustomerId: 'cust_1',
            offer: OFFER
        });

        expect(earnedTransition).toBe(true);
        expect(result.status).toBe('earned');
    });

    it('should handle multi-threshold: 30 units toward "buy 12" earns 2 rewards with rollover', async () => {
        // Scenario: 30 units total, required 12 each
        // Expected: earn reward 1 (12 units), earn reward 2 (12 units), 6 rollover
        let earnCount = 0;
        let quantityQueryCount = 0;
        let rewardIds = [200, 201]; // Two rewards to be earned
        let inProgressQueried = false;

        mockClient.query.mockImplementation(async (sql, params) => {
            // Total quantity check (in updateRewardProgress — has reward_id IS NULL)
            if (sql.includes('total_quantity') && sql.includes('reward_id IS NULL')) {
                quantityQueryCount++;
                if (quantityQueryCount === 1) return { rows: [{ total_quantity: 30 }] };
                if (quantityQueryCount === 2) return { rows: [{ total_quantity: 18 }] };
                return { rows: [{ total_quantity: 6 }] };
            }

            // Get in_progress reward
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                if (!inProgressQueried) {
                    inProgressQueried = true;
                    return {
                        rows: [{
                            id: rewardIds[0], status: 'in_progress',
                            current_quantity: 30, required_quantity: 12
                        }]
                    };
                }
                return { rows: [] };
            }

            // UPDATE quantity
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes('current_quantity = $1')) {
                return { rows: [] };
            }

            // Lock rows
            if (sql.includes('UPDATE loyalty_purchase_events') && sql.includes('cumulative_qty')) {
                return { rows: [{ id: 1, quantity: 12, cumulative_qty: 12 }] };
            }

            // Earn transition
            if (sql.includes("SET status = 'earned'")) {
                earnCount++;
                return { rows: [] };
            }

            // Create next in_progress reward for second cycle
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
                return {
                    rows: [{
                        id: rewardIds[earnCount] || 202,
                        status: 'in_progress',
                        current_quantity: earnCount === 1 ? 18 : 6,
                        required_quantity: 12
                    }]
                };
            }

            // Window dates
            if (sql.includes('MIN(window_start_date) as start_date')) {
                return { rows: [{ start_date: '2026-01-01', end_date: '2027-01-01' }] };
            }

            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases') && sql.includes('last_purchase'))
                return { rows: [{ current_quantity: 6, lifetime_purchases: 30, last_purchase: null, window_start: null, window_end: null }] };
            if (sql.includes('COUNT(*)') && sql.includes("status = 'earned'") && !sql.includes("'redeemed'"))
                return { rows: [{ count: 2 }] };
            if (sql.includes('COUNT(*)') && sql.includes("status = 'redeemed'") && !sql.includes("'earned'"))
                return { rows: [{ count: 0 }] };
            if (sql.includes('COUNT(*)') && sql.includes("IN ('earned', 'redeemed')"))
                return { rows: [{ count: 2 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'")
                && sql.includes('ORDER BY'))
                return { rows: [{ id: 200 }] };
            if (sql.includes('INSERT INTO loyalty_customer_summary'))
                return { rows: [] };

            return { rows: [] };
        });

        const result = await updateRewardProgress(mockClient, {
            merchantId: 1,
            offerId: OFFER.id,
            squareCustomerId: 'cust_1',
            offer: OFFER
        });

        // Should have earned 2 rewards (while loop iterated twice)
        expect(earnCount).toBe(2);
        // Final state: 6 remaining units (not enough for a third reward)
        expect(result.currentQuantity).toBe(6);
    });

    it('should handle split-row crossing: lock full rows + split partial row', async () => {
        let splitCreated = false;
        let excessCreated = false;
        let quantityQueryCount = 0;

        mockClient.query.mockImplementation(async (sql, params) => {
            // Quantity check — 14 units available, 12 needed
            if (sql.includes('total_quantity') && sql.includes('reward_id IS NULL')) {
                quantityQueryCount++;
                if (quantityQueryCount === 1) return { rows: [{ total_quantity: 14 }] };
                return { rows: [{ total_quantity: 2 }] }; // After earning, 2 rollover
            }

            // Existing in_progress reward
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 200, status: 'in_progress',
                        current_quantity: 14, required_quantity: 12
                    }]
                };
            }

            // UPDATE quantity
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes('current_quantity = $1')) {
                return { rows: [] };
            }

            // Lock fully consumed rows — locked 10 out of 12 needed
            if (sql.includes('UPDATE loyalty_purchase_events') && sql.includes('cumulative_qty')) {
                return {
                    rows: [
                        { id: 1, quantity: 5, cumulative_qty: 5 },
                        { id: 2, quantity: 5, cumulative_qty: 10 }
                    ]
                };
            }

            // Crossing row query — find the row that straddles the threshold
            if (sql.includes('FROM loyalty_purchase_events lpe') && sql.includes('LIMIT 1')
                && sql.includes('reward_id IS NULL') && sql.includes('ORDER BY purchased_at ASC')) {
                return {
                    rows: [{
                        id: 3, quantity: 4, square_order_id: 'ord_3', variation_id: 'var_1',
                        unit_price_cents: 1000, total_price_cents: 4000,
                        purchased_at: '2026-01-15', idempotency_key: 'key_3',
                        window_start_date: '2026-01-01', window_end_date: '2027-01-01',
                        square_location_id: 'loc_1', receipt_url: null,
                        customer_source: 'order', payment_type: 'CARD'
                    }]
                };
            }

            // INSERT child rows (split_locked and split_excess are in idempotency_key param)
            // Locked child has 18 params (idempotency_key at index 14)
            // Excess child has 17 params (reward_id is NULL literal, idempotency_key at index 13)
            if (sql.includes('INSERT INTO loyalty_purchase_events') && params && Array.isArray(params)) {
                const paramsStr = JSON.stringify(params);
                if (paramsStr.includes('split_locked')) {
                    splitCreated = true;
                    return { rows: [{ id: 101 }] };
                }
                if (paramsStr.includes('split_excess')) {
                    excessCreated = true;
                    return { rows: [{ id: 102 }] };
                }
            }

            // Earn transition
            if (sql.includes("SET status = 'earned'")) {
                return { rows: [] };
            }

            // Window dates
            if (sql.includes('MIN(window_start_date)')) {
                return { rows: [{ start_date: '2026-01-01', end_date: '2027-01-01' }] };
            }

            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 2, lifetime_purchases: 14 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };

            return { rows: [] };
        });

        await updateRewardProgress(mockClient, {
            merchantId: 1,
            offerId: OFFER.id,
            squareCustomerId: 'cust_1',
            offer: OFFER
        });

        // Verify both split children were created
        expect(splitCreated).toBe(true);
        expect(excessCreated).toBe(true);
    });

    it('should update existing in_progress reward quantity', async () => {
        let updatedQuantity = null;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 8 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 200, status: 'in_progress',
                        current_quantity: 5, required_quantity: 12
                    }]
                };
            }
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes('current_quantity = $1')) {
                updatedQuantity = params[0];
                return { rows: [] };
            }
            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await updateRewardProgress(mockClient, {
            merchantId: 1,
            offerId: OFFER.id,
            squareCustomerId: 'cust_1',
            offer: OFFER
        });

        expect(updatedQuantity).toBe(8); // Updated from 5 to 8
        expect(result.currentQuantity).toBe(8);
        expect(result.status).toBe('in_progress');
    });
});

// ============================================================================
// TESTS — processRefund — additional edge cases
// ============================================================================

describe('processRefund — additional edge cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetOfferForVariation.mockResolvedValue(OFFER);
    });

    it('should NOT revoke earned reward when remaining quantity still meets threshold', async () => {
        let revokedReward = false;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            // INSERT refund
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -1 }] };
            }

            // Earned reward check — has one
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 50,
                        offer_id: OFFER.id,
                        square_customer_id: 'cust_1',
                        status: 'earned'
                    }]
                };
            }

            // Locked quantity — still above required (13 >= 12)
            if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id')) {
                return { rows: [{ total: 13 }] };
            }

            // Revoke — should NOT be called
            if (sql.includes("SET status = 'revoked'")) {
                revokedReward = true;
                return { rows: [] };
            }

            // updateRewardProgress
            if (sql.includes('COALESCE(SUM(quantity), 0) as total_quantity') && !sql.includes('reward_id =')) {
                return { rows: [{ total_quantity: 0 }] };
            }
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                return { rows: [] };
            }

            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: new Date()
        });

        expect(result.processed).toBe(true);
        expect(result.rewardAffected).toBe(true); // Earned reward exists
        expect(revokedReward).toBe(false); // But was NOT revoked
    });

    it('should handle refund where no earned reward exists', async () => {
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -2 }] };
            }

            // No earned reward
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return { rows: [] };
            }

            // updateRewardProgress
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 3 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 200, status: 'in_progress', current_quantity: 5, required_quantity: 12 }] };
            }
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes('current_quantity')) {
                return { rows: [] };
            }
            // updateCustomerSummary
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 3, lifetime_purchases: 5 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date()
        });

        expect(result.processed).toBe(true);
        expect(result.rewardAffected).toBe(false);
    });

    it('should handle zero quantity refund', async () => {
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                // Verify the quantity is -0 (still negative direction)
                expect(params[6]).toBe(-0);
                return { rows: [{ id: 101, quantity: -0 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 5 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'"))
                return { rows: [{ id: 200, status: 'in_progress', current_quantity: 5, required_quantity: 12 }] };
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: null, end_date: null }] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        // Should not throw
        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 0,
            refundedAt: new Date()
        });

        expect(result.processed).toBe(true);
    });

    it('should handle null unitPriceCents (total_price_cents should be null)', async () => {
        let capturedTotalPrice = 'NOT_SET';

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                capturedTotalPrice = params[8]; // total_price_cents
                return { rows: [{ id: 101, quantity: -2 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 0 }] };
            if (sql.includes("status = 'in_progress'")) return { rows: [] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity')) return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            unitPriceCents: undefined,
            refundedAt: new Date()
        });

        // When unitPriceCents is undefined, total should be null (not NaN)
        expect(capturedTotalPrice).toBeNull();
    });
});

// ============================================================================
// TESTS — updateCustomerSummary direct
// ============================================================================

describe('updateCustomerSummary', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should upsert customer summary with correct stats', async () => {
        let upsertParams = null;
        let queryIndex = 0;

        mockClient.query.mockImplementation(async (sql, params) => {
            queryIndex++;
            // Query 1: Stats query (has COALESCE + current_quantity + lifetime_purchases)
            if (sql.includes('COALESCE') && sql.includes('current_quantity') && sql.includes('lifetime_purchases')) {
                return {
                    rows: [{
                        current_quantity: 8,
                        lifetime_purchases: 20,
                        last_purchase: '2026-03-01',
                        window_start: '2026-01-01',
                        window_end: '2027-01-01'
                    }]
                };
            }
            // Query 2: Earned count
            if (sql.includes('COUNT(*)') && sql.includes("status = 'earned'") && !sql.includes("'redeemed'")) {
                return { rows: [{ count: 1 }] };
            }
            // Query 3: Redeemed count
            if (sql.includes('COUNT(*)') && sql.includes("status = 'redeemed'") && !sql.includes("'earned'")) {
                return { rows: [{ count: 2 }] };
            }
            // Query 4: Total earned+redeemed
            if (sql.includes('COUNT(*)') && sql.includes("IN ('earned', 'redeemed')")) {
                return { rows: [{ count: 3 }] };
            }
            // Query 5: Required quantity
            if (sql.includes('SELECT required_quantity FROM loyalty_offers')) {
                return { rows: [{ required_quantity: 12 }] };
            }
            // Query 6: Get earned reward ID
            if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'")) {
                return { rows: [{ id: 42 }] };
            }
            // Query 7: Upsert
            if (sql.includes('INSERT INTO loyalty_customer_summary')) {
                upsertParams = params;
                return { rows: [] };
            }
            return { rows: [] };
        });

        await updateCustomerSummary(mockClient, 1, 'cust_1', 10);

        expect(upsertParams).not.toBeNull();
        // Verify key fields:
        // [merchantId, customerId, offerId, current_quantity, required_quantity,
        //  window_start, window_end, has_earned, earned_reward_id,
        //  lifetime, total_earned, total_redeemed, last_purchase]
        expect(upsertParams[0]).toBe(1);           // merchantId
        expect(upsertParams[1]).toBe('cust_1');     // customerId
        expect(upsertParams[2]).toBe(10);           // offerId
        expect(upsertParams[3]).toBe(8);            // current_quantity
        expect(upsertParams[4]).toBe(12);           // required_quantity
        expect(upsertParams[7]).toBe(true);         // has_earned_reward
        expect(upsertParams[8]).toBe(42);           // earned_reward_id
        expect(upsertParams[9]).toBe(20);           // lifetime_purchases
        expect(upsertParams[10]).toBe(3);           // total_rewards_earned
        expect(upsertParams[11]).toBe(2);           // total_rewards_redeemed
    });
});
