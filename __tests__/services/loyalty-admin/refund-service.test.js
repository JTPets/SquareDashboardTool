/**
 * Tests for services/loyalty-admin/refund-service.js
 *
 * Extracted from purchase-service.test.js as part of module split.
 * Tests processRefund: refund processing, reward revocation, idempotency,
 * transaction client delegation, and Square discount cleanup.
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
const mockCleanupDiscount = jest.fn().mockResolvedValue({ success: true });
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: mockCreateDiscount,
    cleanupSquareCustomerGroupDiscount: mockCleanupDiscount
}));

const mockUpdateRewardProgress = jest.fn();
const mockMarkSyncPending = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/reward-progress-service', () => ({
    updateRewardProgress: mockUpdateRewardProgress,
    markSyncPendingIfRewardExists: mockMarkSyncPending
}));

const mockUpdateCustomerSummary = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-summary-service', () => ({
    updateCustomerSummary: mockUpdateCustomerSummary
}));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const { processRefund } = require('../../../services/loyalty-admin/refund-service');

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

/**
 * Standard mock implementation for refund flow.
 * Handles: BEGIN/COMMIT/ROLLBACK, original purchase lookup, INSERT refund,
 * earned reward check, locked quantity, revoke/unlock, updateRewardProgress
 * delegation, and updateCustomerSummary delegation.
 */
function setupMockClientForRefund(opts = {}) {
    const {
        originalPurchaseWindow = { window_start_date: '2026-01-01', window_end_date: '2027-01-01' },
        hasOriginalPurchase = true,
        earnedReward = null,
        lockedQuantityTotal = 0,
    } = opts;

    mockClient.query.mockImplementation(async (sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

        // Original purchase window lookup (LA-11)
        if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
            return { rows: hasOriginalPurchase ? [originalPurchaseWindow] : [] };
        }

        // INSERT refund event
        if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
            return { rows: [{ id: 101, quantity: params[6], offer_id: OFFER.id }] };
        }

        // Earned reward check
        if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
            return { rows: earnedReward ? [earnedReward] : [] };
        }

        // Locked quantity for earned reward
        if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id')) {
            return { rows: [{ total: lockedQuantityTotal }] };
        }

        // Revoke reward
        if (sql.includes("SET status = 'revoked'")) return { rows: [] };

        // Unlock purchase events
        if (sql.includes('SET reward_id = NULL') && sql.includes('WHERE reward_id')) return { rows: [] };

        // updateRewardProgress queries (delegated)
        if (sql.includes('total_quantity') && !sql.includes('reward_id')) {
            return { rows: [{ total_quantity: 0 }] };
        }
        if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };

        // updateCustomerSummary queries
        if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
            return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
        if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
        if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
            return { rows: [{ required_quantity: OFFER.required_quantity }] };
        if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };

        return { rows: [] };
    });
}

// ============================================================================
// TESTS — processRefund
// ============================================================================

describe('processRefund', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetOfferForVariation.mockResolvedValue(OFFER);
        mockClient.query.mockReset();
        mockClient.release.mockReset();
        db.pool.connect.mockResolvedValue(mockClient);
        mockUpdateRewardProgress.mockResolvedValue({
            status: 'no_progress',
            currentQuantity: 0,
            earnedRewardIds: []
        });
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
        db.query.mockImplementation(async () => ({ rows: [] }));
        setupMockClientForRefund();

        // Override INSERT to capture quantity
        const originalImpl = mockClient.query.getMockImplementation();
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                const quantity = params[6];
                expect(quantity).toBeLessThan(0);
                return { rows: [{ id: 101, quantity }] };
            }
            return originalImpl(sql, params);
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
        db.query.mockImplementation(async () => ({ rows: [] }));

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
        db.query.mockImplementation(async () => ({ rows: [] }));
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
        db.query.mockImplementation(async () => ({ rows: [] }));
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
        db.query.mockImplementation(async () => ({ rows: [] }));
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

    // ========================================================================
    // HIGH-6: Square discount cleanup after reward revocation
    // ========================================================================

    it('HIGH-6: should call cleanupSquareCustomerGroupDiscount after reward revocation', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -3 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 50, offer_id: OFFER.id, square_customer_id: 'cust_1', status: 'earned' }] };
            }
            if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id')) {
                return { rows: [{ total: 10 }] }; // 10 < 12 required
            }
            if (sql.includes("SET status = 'revoked'")) return { rows: [] };
            if (sql.includes('SET reward_id = NULL') && sql.includes('WHERE reward_id')) return { rows: [] };
            if (sql.includes('total_quantity') && !sql.includes('reward_id')) return { rows: [{ total_quantity: 10 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
                return { rows: [{ id: 201, status: 'in_progress', current_quantity: 10, required_quantity: 12 }] };
            }
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: '2026-01-01', end_date: '2026-12-31' }] };
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

        // Cleanup must be called with correct params after transaction commits
        expect(mockCleanupDiscount).toHaveBeenCalledWith({
            merchantId: 1,
            squareCustomerId: 'cust_1',
            internalRewardId: 50
        });
    });

    it('HIGH-6: revocation should NOT be rolled back if cleanup fails', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));
        mockCleanupDiscount.mockRejectedValueOnce(new Error('Square API timeout'));

        let revokeCalled = false;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -3 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 50, offer_id: OFFER.id, square_customer_id: 'cust_1', status: 'earned' }] };
            }
            if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id')) {
                return { rows: [{ total: 10 }] };
            }
            if (sql.includes("SET status = 'revoked'")) { revokeCalled = true; return { rows: [] }; }
            if (sql.includes('SET reward_id = NULL') && sql.includes('WHERE reward_id')) return { rows: [] };
            if (sql.includes('total_quantity') && !sql.includes('reward_id')) return { rows: [{ total_quantity: 10 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
                return { rows: [{ id: 201, status: 'in_progress', current_quantity: 10, required_quantity: 12 }] };
            }
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: '2026-01-01', end_date: '2026-12-31' }] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'"))
                return { rows: [] };
            return { rows: [] };
        });

        // Should NOT throw even though cleanup fails
        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 3,
            refundedAt: new Date()
        });

        expect(result.processed).toBe(true);
        expect(revokeCalled).toBe(true);

        // Transaction was committed (not rolled back)
        const queries = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).toContain('COMMIT');
        expect(queries.filter(q => q === 'ROLLBACK')).toHaveLength(0);
    });

    it('HIGH-6: should log ERROR with structured fields on cleanup failure', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));
        mockCleanupDiscount.mockRejectedValueOnce(new Error('Square API timeout'));

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -3 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 50, offer_id: OFFER.id, square_customer_id: 'cust_1', status: 'earned' }] };
            }
            if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id')) {
                return { rows: [{ total: 10 }] };
            }
            if (sql.includes("SET status = 'revoked'")) return { rows: [] };
            if (sql.includes('SET reward_id = NULL') && sql.includes('WHERE reward_id')) return { rows: [] };
            if (sql.includes('total_quantity') && !sql.includes('reward_id')) return { rows: [{ total_quantity: 10 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
                return { rows: [{ id: 201, status: 'in_progress', current_quantity: 10, required_quantity: 12 }] };
            }
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: '2026-01-01', end_date: '2026-12-31' }] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'"))
                return { rows: [] };
            return { rows: [] };
        });

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 3,
            refundedAt: new Date()
        });

        expect(logger.error).toHaveBeenCalledWith(
            'Revocation cleanup failed',
            expect.objectContaining({
                event: 'revocation_cleanup_failed',
                customerId: 'cust_1',
                offerId: OFFER.id,
                merchantId: 1,
                rewardId: 50,
                error: 'Square API timeout'
            })
        );
    });

    it('HIGH-6: should log INFO on successful revocation and cleanup', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));
        mockCleanupDiscount.mockResolvedValueOnce({ success: true });

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -3 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 50, offer_id: OFFER.id, square_customer_id: 'cust_1', status: 'earned' }] };
            }
            if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id')) {
                return { rows: [{ total: 10 }] };
            }
            if (sql.includes("SET status = 'revoked'")) return { rows: [] };
            if (sql.includes('SET reward_id = NULL') && sql.includes('WHERE reward_id')) return { rows: [] };
            if (sql.includes('total_quantity') && !sql.includes('reward_id')) return { rows: [{ total_quantity: 10 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
                return { rows: [{ id: 201, status: 'in_progress', current_quantity: 10, required_quantity: 12 }] };
            }
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: '2026-01-01', end_date: '2026-12-31' }] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'"))
                return { rows: [] };
            return { rows: [] };
        });

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 3,
            refundedAt: new Date()
        });

        expect(logger.info).toHaveBeenCalledWith(
            'Reward revoked via refund',
            expect.objectContaining({
                event: 'reward_revoked_via_refund',
                customerId: 'cust_1',
                offerId: OFFER.id,
                merchantId: 1,
                rewardId: 50
            })
        );

        expect(logger.info).toHaveBeenCalledWith(
            'Revocation cleanup complete',
            expect.objectContaining({
                event: 'revocation_cleanup_complete',
                customerId: 'cust_1',
                offerId: OFFER.id,
                merchantId: 1,
                rewardId: 50
            })
        );
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

    // ========================================================================
    // HIGH-3: transactionClient parameter
    // ========================================================================

    it('HIGH-3: backward compat — processRefund without transactionClient still works', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
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

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date()
        });

        expect(result.processed).toBe(true);
        // Should manage its own transaction
        expect(db.pool.connect).toHaveBeenCalled();
        const queries = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).toContain('BEGIN');
        expect(queries).toContain('COMMIT');
        expect(mockClient.release).toHaveBeenCalled();
    });

    it('HIGH-3: with transactionClient — does not BEGIN/COMMIT/ROLLBACK or release', async () => {
        const externalClient = {
            query: jest.fn(),
            release: jest.fn()
        };

        // Idempotency check on external client
        externalClient.query.mockImplementation(async (sql, params) => {
            if (sql.includes('SELECT id FROM loyalty_purchase_events') && sql.includes('idempotency_key')) {
                return { rows: [] };
            }
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
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

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date()
        }, externalClient);

        expect(result.processed).toBe(true);
        // Should NOT acquire its own connection
        expect(db.pool.connect).not.toHaveBeenCalled();
        // Should NOT manage transaction lifecycle
        const queries = externalClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).not.toContain('BEGIN');
        expect(queries).not.toContain('COMMIT');
        expect(queries).not.toContain('ROLLBACK');
        expect(externalClient.release).not.toHaveBeenCalled();
    });

    it('HIGH-3: with transactionClient — error does not ROLLBACK (caller owns transaction)', async () => {
        const externalClient = {
            query: jest.fn(),
            release: jest.fn()
        };

        externalClient.query.mockImplementation(async (sql) => {
            if (sql.includes('SELECT id FROM loyalty_purchase_events') && sql.includes('idempotency_key')) {
                return { rows: [] };
            }
            if (sql.includes('SELECT window_start_date')) {
                throw new Error('Simulated DB error');
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
        }, externalClient)).rejects.toThrow('Simulated DB error');

        const queries = externalClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).not.toContain('ROLLBACK');
        expect(externalClient.release).not.toHaveBeenCalled();
    });

    it('HIGH-3: with transactionClient — revokedReward returned but Square cleanup deferred', async () => {
        const externalClient = {
            query: jest.fn(),
            release: jest.fn()
        };

        externalClient.query.mockImplementation(async (sql, params) => {
            if (sql.includes('SELECT id FROM loyalty_purchase_events') && sql.includes('idempotency_key')) {
                return { rows: [] };
            }
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -3 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 50, offer_id: OFFER.id, square_customer_id: 'cust_1', status: 'earned' }] };
            }
            if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id')) {
                return { rows: [{ total: 10 }] }; // 10 < 12 required
            }
            if (sql.includes("SET status = 'revoked'")) return { rows: [] };
            if (sql.includes('SET reward_id = NULL') && sql.includes('WHERE reward_id')) return { rows: [] };
            if (sql.includes('total_quantity') && !sql.includes('reward_id')) return { rows: [{ total_quantity: 10 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'")) {
                return { rows: [{ id: 201, status: 'in_progress', current_quantity: 10, required_quantity: 12 }] };
            }
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: '2026-01-01', end_date: '2026-12-31' }] };
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
        }, externalClient);

        expect(result.processed).toBe(true);
        expect(result.revokedReward).toBeTruthy();
        expect(result.revokedReward.id).toBe(50);
        // Square cleanup should NOT be called — caller owns the transaction
        expect(mockCleanupDiscount).not.toHaveBeenCalled();
    });
});

// ============================================================================
// TESTS — CRIT-3: ON CONFLICT idempotency (concurrent duplicate handling)
// ============================================================================

describe('CRIT-3: processRefund — concurrent duplicate', () => {
    const EXISTING_REFUND = {
        id: 88,
        merchant_id: 1,
        offer_id: OFFER.id,
        square_order_id: 'ord_ref',
        variation_id: 'var_1',
        quantity: -1,
        is_refund: true,
        idempotency_key: 'refund:ord_ref:var_1:1'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetOfferForVariation.mockResolvedValue(OFFER);
        mockClient.query.mockReset();
        mockClient.release.mockReset();
        db.pool.connect.mockResolvedValue(mockClient);
        mockUpdateRewardProgress.mockResolvedValue({
            status: 'no_progress',
            currentQuantity: 0,
            earnedRewardIds: []
        });
    });

    function setupRefundConflictMock() {
        // db.query — idempotency SELECT passes (returns empty, simulating race)
        db.query.mockResolvedValueOnce({ rows: [] });

        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            // Original purchase window lookup
            if (sql.includes('window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }

            // INSERT returns 0 rows (ON CONFLICT DO NOTHING fired)
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('ON CONFLICT')) {
                return { rows: [] };
            }

            // Fetch existing row after conflict
            if (sql.includes('SELECT * FROM loyalty_purchase_events') && sql.includes('idempotency_key')) {
                return { rows: [EXISTING_REFUND] };
            }

            return { rows: [] };
        });
    }

    it('should return existing refund row with alreadyProcessed flag on conflict', async () => {
        setupRefundConflictMock();

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_ref',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: new Date('2026-03-01')
        });

        expect(result.processed).toBe(false);
        expect(result.reason).toBe('already_processed');
        expect(result.alreadyProcessed).toBe(true);
        expect(result.refundEvent).toEqual(EXISTING_REFUND);
    });

    it('should not create a duplicate refund row on conflict', async () => {
        setupRefundConflictMock();

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_ref',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: new Date('2026-03-01')
        });

        // No audit log or reward progress should follow a conflict
        expect(mockLogAuditEvent).not.toHaveBeenCalled();
    });

    it('should log INFO with correct structured fields on refund conflict', async () => {
        setupRefundConflictMock();

        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_ref',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: new Date('2026-03-01')
        });

        expect(logger.info).toHaveBeenCalledWith(
            'Concurrent duplicate detected via ON CONFLICT',
            expect.objectContaining({
                event: 'purchase_event_duplicate',
                idempotencyKey: 'refund:ord_ref:var_1:1',
                merchantId: 1,
                orderId: 'ord_ref'
            })
        );
    });

    it('should not affect normal refund insert path', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // idempotency SELECT

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            // Original purchase window lookup
            if (sql.includes('window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }

            // INSERT succeeds normally (returns a row)
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('RETURNING')) {
                return { rows: [{ id: 200, quantity: -1, offer_id: OFFER.id, is_refund: true }] };
            }

            // Earned reward check
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) {
                return { rows: [] };
            }

            // updateRewardProgress - quantity
            if (sql.includes('COALESCE(SUM(quantity), 0) as total_quantity')) {
                return { rows: [{ total_quantity: 5 }] };
            }

            // Get existing in_progress reward
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 300, status: 'in_progress', current_quantity: 6 }] };
            }

            // UPDATE reward quantity
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes('current_quantity')) {
                return { rows: [] };
            }

            // Window dates for reward
            if (sql.includes('MIN(window_start_date) as start_date')) {
                return { rows: [{ start_date: '2026-01-01', end_date: '2027-01-01' }] };
            }

            // updateCustomerSummary queries
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0, last_purchase: null, window_start: null, window_end: null }] };
            if (sql.includes('COUNT(*)'))
                return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: OFFER.required_quantity }] };
            if (sql.includes('SELECT id FROM loyalty_rewards') && sql.includes("status = 'earned'"))
                return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_customer_summary') || sql.includes('ON CONFLICT'))
                return { rows: [] };

            return { rows: [] };
        });

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_normal',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: new Date('2026-03-01')
        });

        expect(result.processed).toBe(true);
        expect(result.refundEvent).toBeDefined();
        expect(result.alreadyProcessed).toBeUndefined();
    });
});

// ============================================================================
// NEW TESTS — Additional coverage for refund-service extraction
// ============================================================================

describe('processRefund — additional coverage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetOfferForVariation.mockResolvedValue(OFFER);
        mockClient.query.mockReset();
        mockClient.release.mockReset();
        db.pool.connect.mockResolvedValue(mockClient);
        mockUpdateRewardProgress.mockResolvedValue({
            status: 'no_progress',
            currentQuantity: 0,
            earnedRewardIds: []
        });
    });

    it('LA-11: original purchase window dates are used (not recalculated from refund date)', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));

        let capturedWindowStart = null;
        let capturedWindowEnd = null;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return {
                    rows: [{
                        window_start_date: '2025-06-01',
                        window_end_date: '2026-06-01'
                    }]
                };
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

        // Refund is months after the original purchase
        await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_old',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: '2026-03-15T10:00:00Z'
        });

        // Should use the ORIGINAL purchase window, not derive from refundedAt
        expect(capturedWindowStart).toBe('2025-06-01');
        expect(capturedWindowEnd).toBe('2026-06-01');
    });

    it('LA-11: fallback logs warning when no original purchase found', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [] }; // No original purchase
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
            squareOrderId: 'ord_orphan2',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 1,
            refundedAt: '2026-03-15T10:00:00Z'
        });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('No original purchase event found for refund'),
            expect.objectContaining({
                merchantId: 1,
                squareOrderId: 'ord_orphan2',
                variationId: 'var_1'
            })
        );
    });

    it('idempotency: duplicate refund with same returnLineItemUid is rejected', async () => {
        // First call returns existing row
        db.query.mockImplementation(async (sql, params) => {
            if (sql.includes('idempotency_key')) {
                return { rows: [{ id: 200 }] };
            }
            return { rows: [] };
        });

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date(),
            returnLineItemUid: 'rli_DUP'
        });

        expect(result.processed).toBe(false);
        expect(result.reason).toBe('already_processed');
        expect(db.pool.connect).not.toHaveBeenCalled();
    });

    it('reward progress is recalculated after refund via updateRewardProgress', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                return { rows: [{ id: 101, quantity: -2 }] };
            }
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes('total_quantity')) return { rows: [{ total_quantity: 8 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 300, status: 'in_progress', current_quantity: 10 }] };
            }
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes('current_quantity')) return { rows: [] };
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: '2026-01-01', end_date: '2027-01-01' }] };
            if (sql.includes('current_quantity') && sql.includes('lifetime_purchases'))
                return { rows: [{ current_quantity: 0, lifetime_purchases: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.includes('required_quantity') && sql.includes('loyalty_offers'))
                return { rows: [{ required_quantity: 12 }] };
            if (sql.includes('SELECT id FROM loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        mockUpdateRewardProgress.mockResolvedValue({
            status: 'in_progress',
            currentQuantity: 8,
            earnedRewardIds: []
        });

        const result = await processRefund({
            merchantId: 1,
            squareOrderId: 'ord_progress',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: 2,
            refundedAt: new Date()
        });

        expect(result.processed).toBe(true);
        // updateRewardProgress was called with the transaction client
        expect(mockUpdateRewardProgress).toHaveBeenCalledWith(
            mockClient,
            expect.objectContaining({
                merchantId: 1,
                offerId: OFFER.id,
                squareCustomerId: 'cust_1',
                offer: OFFER
            })
        );
    });

    it('earned reward revocation does NOT call cleanupSquareCustomerGroupDiscount when transactionClient provided', async () => {
        const externalClient = { query: jest.fn(), release: jest.fn() };

        externalClient.query.mockImplementation(async (sql, params) => {
            if (sql.includes('SELECT id FROM loyalty_purchase_events') && sql.includes('idempotency_key'))
                return { rows: [] };
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE'))
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE'))
                return { rows: [{ id: 101, quantity: -5 }] };
            if (sql.includes("status = 'earned'") && sql.includes('FOR UPDATE'))
                return { rows: [{ id: 60, offer_id: OFFER.id, square_customer_id: 'cust_1', status: 'earned' }] };
            if (sql.includes('COALESCE(SUM(quantity), 0) as total') && sql.includes('reward_id'))
                return { rows: [{ total: 7 }] }; // 7 < 12 required → revoke
            if (sql.includes("SET status = 'revoked'")) return { rows: [] };
            if (sql.includes('SET reward_id = NULL')) return { rows: [] };
            if (sql.includes('total_quantity') && !sql.includes('reward_id')) return { rows: [{ total_quantity: 7 }] };
            if (sql.includes("status = 'in_progress'") && sql.includes('FOR UPDATE')) return { rows: [] };
            if (sql.includes("INSERT INTO loyalty_rewards") && sql.includes("'in_progress'"))
                return { rows: [{ id: 201, status: 'in_progress', current_quantity: 7, required_quantity: 12 }] };
            if (sql.includes('MIN(window_start_date)')) return { rows: [{ start_date: '2026-01-01', end_date: '2026-12-31' }] };
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
            quantity: 5,
            refundedAt: new Date()
        }, externalClient);

        expect(result.processed).toBe(true);
        expect(result.revokedReward).toBeTruthy();
        expect(result.revokedReward.id).toBe(60);
        // Cleanup deferred to caller
        expect(mockCleanupDiscount).not.toHaveBeenCalled();
    });

    it('partial refund with negative quantity input is handled correctly', async () => {
        db.query.mockImplementation(async () => ({ rows: [] }));
        let capturedQuantity = null;

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('SELECT window_start_date, window_end_date') && sql.includes('is_refund = FALSE')) {
                return { rows: [{ window_start_date: '2026-01-01', window_end_date: '2027-01-01' }] };
            }
            if (sql.includes('INSERT INTO loyalty_purchase_events') && sql.includes('TRUE')) {
                capturedQuantity = params[6];
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
            squareOrderId: 'ord_neg',
            squareCustomerId: 'cust_1',
            variationId: 'var_1',
            quantity: -3, // Already negative
            refundedAt: new Date()
        });

        // Math.abs(-3) * -1 = -3, not --3 = 3
        expect(capturedQuantity).toBe(-3);
    });
});
