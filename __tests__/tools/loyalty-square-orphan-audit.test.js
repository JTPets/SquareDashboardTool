/**
 * Tests for Loyalty Square Orphan Audit Tool
 *
 * Validates orphan detection logic: Square customer groups and pricing rules
 * that exist in Square but have no matching loyalty_rewards DB record.
 */

const db = require('../../utils/database');

// Mock dependencies before requiring the module
jest.mock('../../utils/database');
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));
jest.mock('../../services/square/api', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn()
}));
jest.mock('../../services/loyalty-admin/square-discount-service', () => ({
    cleanupSquareCustomerGroupDiscount: jest.fn()
}));

const { makeSquareRequest } = require('../../services/square/api');
const { cleanupSquareCustomerGroupDiscount } = require('../../services/loyalty-admin/square-discount-service');

const {
    fetchSquareCustomerGroups,
    fetchSquarePricingRules,
    getKnownSquareIds,
    auditMerchant
} = require('../../tools/loyalty-square-orphan-audit');

beforeEach(() => {
    jest.clearAllMocks();
});

// ============================================================================
// fetchSquareCustomerGroups
// ============================================================================

describe('fetchSquareCustomerGroups', () => {
    it('should fetch all groups with pagination', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                groups: [{ id: 'g1', name: 'Group 1' }],
                cursor: 'page2'
            })
            .mockResolvedValueOnce({
                groups: [{ id: 'g2', name: 'Group 2' }],
                cursor: null
            });

        const groups = await fetchSquareCustomerGroups(1);

        expect(groups).toHaveLength(2);
        expect(groups[0].id).toBe('g1');
        expect(groups[1].id).toBe('g2');
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    it('should handle empty response', async () => {
        makeSquareRequest.mockResolvedValueOnce({});

        const groups = await fetchSquareCustomerGroups(1);

        expect(groups).toHaveLength(0);
    });
});

// ============================================================================
// fetchSquarePricingRules
// ============================================================================

describe('fetchSquarePricingRules', () => {
    it('should fetch pricing rules with type filter', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [
                { id: 'pr1', type: 'PRICING_RULE', pricingRuleData: { name: 'Loyalty Rule' } }
            ]
        });

        const rules = await fetchSquarePricingRules(1);

        expect(rules).toHaveLength(1);
        expect(rules[0].id).toBe('pr1');
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/list?types=PRICING_RULE',
            { accessToken: 'test-token' }
        );
    });

    it('should paginate through all results', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                objects: [{ id: 'pr1', pricingRuleData: {} }],
                cursor: 'next'
            })
            .mockResolvedValueOnce({
                objects: [{ id: 'pr2', pricingRuleData: {} }]
            });

        const rules = await fetchSquarePricingRules(1);

        expect(rules).toHaveLength(2);
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });
});

// ============================================================================
// getKnownSquareIds
// ============================================================================

describe('getKnownSquareIds', () => {
    it('should return sets of known group and pricing rule IDs', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { square_group_id: 'g1', square_pricing_rule_id: 'pr1' },
                { square_group_id: 'g2', square_pricing_rule_id: null },
                { square_group_id: null, square_pricing_rule_id: 'pr2' }
            ]
        });

        const { groupIds, pricingRuleIds } = await getKnownSquareIds(1);

        expect(groupIds.size).toBe(2);
        expect(groupIds.has('g1')).toBe(true);
        expect(groupIds.has('g2')).toBe(true);
        expect(pricingRuleIds.size).toBe(2);
        expect(pricingRuleIds.has('pr1')).toBe(true);
        expect(pricingRuleIds.has('pr2')).toBe(true);
    });

    it('should return empty sets when no rewards exist', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const { groupIds, pricingRuleIds } = await getKnownSquareIds(1);

        expect(groupIds.size).toBe(0);
        expect(pricingRuleIds.size).toBe(0);
    });
});

// ============================================================================
// auditMerchant — orphan detection
// ============================================================================

describe('auditMerchant', () => {
    it('should detect orphaned groups with no DB match', async () => {
        // makeSquareRequest: groups page, then pricing rules page
        makeSquareRequest
            .mockResolvedValueOnce({
                groups: [
                    { id: 'g-known', name: 'Loyalty Reward abc - Offer - Customer' },
                    { id: 'g-orphan', name: 'Loyalty Reward def - Offer - Customer' }
                ]
            })
            .mockResolvedValueOnce({ objects: [] });

        // DB: known IDs
        db.query.mockResolvedValueOnce({
            rows: [{ square_group_id: 'g-known', square_pricing_rule_id: null }]
        });

        const result = await auditMerchant(1);

        expect(result.orphanedGroups).toHaveLength(1);
        expect(result.orphanedGroups[0].square_group_id).toBe('g-orphan');
        expect(result.orphanedGroups[0].reason).toBe('No matching loyalty_rewards record');
    });

    it('should detect orphaned pricing rules with no DB match', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({ groups: [] })
            .mockResolvedValueOnce({
                objects: [
                    { id: 'pr-known', pricingRuleData: { name: 'Loyalty rule 1' } },
                    { id: 'pr-orphan', pricingRuleData: { name: 'Loyalty rule 2' } }
                ]
            });

        db.query.mockResolvedValueOnce({
            rows: [{ square_group_id: null, square_pricing_rule_id: 'pr-known' }]
        });

        const result = await auditMerchant(1);

        expect(result.orphanedRules).toHaveLength(1);
        expect(result.orphanedRules[0].square_pricing_rule_id).toBe('pr-orphan');
    });

    it('should ignore non-loyalty customer groups', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                groups: [
                    { id: 'g1', name: 'VIP Customers' },
                    { id: 'g2', name: 'Newsletter Subscribers' }
                ]
            })
            .mockResolvedValueOnce({ objects: [] });

        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await auditMerchant(1);

        expect(result.orphanedGroups).toHaveLength(0);
    });

    it('should ignore non-loyalty pricing rules', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({ groups: [] })
            .mockResolvedValueOnce({
                objects: [
                    { id: 'pr1', pricingRuleData: { name: 'Holiday Sale 10% off' } },
                    { id: 'pr2', pricingRuleData: { name: 'Clearance Discount' } }
                ]
            });

        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await auditMerchant(1);

        expect(result.orphanedRules).toHaveLength(0);
    });

    it('should report no orphans when all Square objects have DB matches', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                groups: [
                    { id: 'g1', name: 'Loyalty Reward abc - Offer - Customer' }
                ]
            })
            .mockResolvedValueOnce({
                objects: [
                    { id: 'pr1', pricingRuleData: { name: 'Loyalty rule' } }
                ]
            });

        db.query.mockResolvedValueOnce({
            rows: [{ square_group_id: 'g1', square_pricing_rule_id: 'pr1' }]
        });

        const result = await auditMerchant(1);

        expect(result.orphanedGroups).toHaveLength(0);
        expect(result.orphanedRules).toHaveLength(0);
    });

    it('should handle API errors gracefully', async () => {
        makeSquareRequest.mockRejectedValueOnce(new Error('Square API timeout'));

        const result = await auditMerchant(1);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toBe('Square API timeout');
        expect(result.orphanedGroups).toHaveLength(0);
    });

    it('should report both orphaned groups and rules in same audit', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                groups: [
                    { id: 'g-orphan', name: 'Loyalty Reward 123 - Offer - Jane' }
                ]
            })
            .mockResolvedValueOnce({
                objects: [
                    { id: 'pr-orphan', pricingRuleData: { name: 'Loyalty pricing rule' } }
                ]
            });

        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await auditMerchant(1);

        expect(result.orphanedGroups).toHaveLength(1);
        expect(result.orphanedRules).toHaveLength(1);
    });
});
