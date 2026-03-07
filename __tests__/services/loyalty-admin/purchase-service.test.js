/**
 * Tests for services/loyalty-admin/purchase-service.js
 *
 * T-1: Financial/loyalty services — core financial logic.
 * Focus on boundary conditions: zero quantities, negative amounts,
 * partial refunds, duplicate events, idempotency.
 *
 * FIXED BUG (T-3): processRefund idempotency key previously used Date.now(),
 * causing non-deterministic keys. Now uses deterministic key matching
 * the purchase path pattern. See docs/TECHNICAL_DEBT.md.
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
        // Reset mockClient implementations (clearAllMocks only clears calls, not implementations)
        mockClient.query.mockReset();
        mockClient.release.mockReset();
        db.pool.connect.mockResolvedValue(mockClient);
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
        db.query.mockImplementation(async () => ({ rows: [] })); // idempotency check
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
        db.query.mockImplementation(async () => ({ rows: [] })); // idempotency check
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
        db.query.mockImplementation(async () => ({ rows: [] })); // idempotency check
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
        db.query.mockImplementation(async () => ({ rows: [] })); // idempotency check
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

    it('should return already_processed for duplicate refund idempotency key', async () => {
        // Idempotency check returns existing row — refund already processed
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('idempotency_key')) {
                return { rows: [{ id: 99 }] };
            }
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

        expect(result).toEqual({ processed: false, reason: 'already_processed' });
        // Should not acquire a pool connection (deduped before transaction)
        expect(db.pool.connect).not.toHaveBeenCalled();
    });

    it('should use deterministic idempotency key (no Date.now())', async () => {
        let idempotencyKeyUsed = null;

        // First call: no existing event, processes normally
        db.query.mockImplementation(async (sql, params) => {
            if (sql.includes('idempotency_key')) {
                idempotencyKeyUsed = params[1];
                return { rows: [] };
            }
            return { rows: [] };
        });

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
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

        const refundData = {
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date()
        };

        const result1 = await processRefund(refundData);
        expect(result1.processed).toBe(true);

        // Verify deterministic key format — with returnLineItemUid it uses UID,
        // without it falls back to quantity
        expect(idempotencyKeyUsed).toBe('refund:ord_1:var_1:2');

        // Second call with same data: idempotency check finds existing row
        db.query.mockImplementation(async (sql, params) => {
            if (sql.includes('idempotency_key')) {
                // Same deterministic key → found existing row
                expect(params[1]).toBe('refund:ord_1:var_1:2');
                return { rows: [{ id: 101 }] };
            }
            return { rows: [] };
        });

        const result2 = await processRefund(refundData);
        expect(result2).toEqual({ processed: false, reason: 'already_processed' });
    });

    it('should calculate negative total_price_cents for refund', async () => {
        db.query.mockImplementation(async () => ({ rows: [] })); // idempotency check
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

    it('LA-5: should use returnLineItemUid in idempotency key when provided', async () => {
        let idempotencyKeyUsed = null;

        db.query.mockImplementation(async (sql, params) => {
            if (sql.includes('idempotency_key')) {
                idempotencyKeyUsed = params[1];
                return { rows: [] };
            }
            return { rows: [] };
        });

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
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
            quantity: 2,
            refundedAt: new Date(),
            returnLineItemUid: 'rli_ABC123'
        });

        // Key uses UID instead of quantity
        expect(idempotencyKeyUsed).toBe('refund:ord_1:var_1:rli_ABC123');
    });

    it('LA-5: two partial refunds of same quantity but different UIDs should not collide', async () => {
        const keysUsed = [];

        db.query.mockImplementation(async (sql, params) => {
            if (sql.includes('idempotency_key')) {
                keysUsed.push(params[1]);
                return { rows: [] }; // Not yet processed
            }
            return { rows: [] };
        });

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
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

        // First partial refund
        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: new Date(),
            returnLineItemUid: 'rli_FIRST'
        });

        // Second partial refund — same item, same quantity, different UID
        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: new Date(),
            returnLineItemUid: 'rli_SECOND'
        });

        expect(keysUsed).toHaveLength(2);
        expect(keysUsed[0]).toBe('refund:ord_1:var_1:rli_FIRST');
        expect(keysUsed[1]).toBe('refund:ord_1:var_1:rli_SECOND');
        expect(keysUsed[0]).not.toBe(keysUsed[1]);
    });

    it('LA-11: should use original purchase window dates for refund', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));

        let capturedWindowStart = null;
        let capturedWindowEnd = null;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            // Original purchase lookup (LA-11)
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return {
                    rows: [{
                        window_start_date: '2026-01-15',
                        window_end_date: '2027-01-15'
                    }]
                };
            }

            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                capturedWindowStart = params[10];
                capturedWindowEnd = params[11];
                return { rows: [{ id: 101, quantity: params[6] }] };
            }

            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 5 }] };
            if (sql.includes("status = 'in_progress'")) return { rows: [] };
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: null, end_date: null }] };
            if (sql.includes('INSERT INTO loyalty_rewards')) {
                return { rows: [{ id: 200, status: 'in_progress', current_quantity: 5, required_quantity: 12 }] };
            }
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            unitPriceCents: 3999,
            refundedAt: '2026-06-15T10:00:00Z', // 5 months after purchase
            squareLocationId: 'loc_1',
            returnLineItemUid: 'rli_123'
        });

        // Window dates should come from original purchase, NOT from refund date
        expect(capturedWindowStart).toBe('2026-01-15');
        expect(capturedWindowEnd).toBe('2027-01-15');
    });

    it('LA-11: should fall back to refund date when no original purchase found', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));

        let capturedWindowStart = null;
        let capturedWindowEnd = null;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            // No original purchase found
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [] };
            }

            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                capturedWindowStart = params[10];
                capturedWindowEnd = params[11];
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

        const logger = require('../../../utils/logger');

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_orphan',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: '2026-06-15T10:00:00Z',
            squareLocationId: 'loc_1',
            returnLineItemUid: 'rli_456'
        });

        // Fallback to refund date since no original purchase exists
        expect(capturedWindowStart).toBe('2026-06-15');
        expect(capturedWindowEnd).toBe('2027-06-15');

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('No original purchase event found'),
            expect.objectContaining({ merchantId: 1, squareOrderId: 'ord_orphan' })
        );
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
});
