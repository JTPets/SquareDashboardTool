/**
 * Tests for customer-summary-service.js
 *
 * Validates updateCustomerSummary: stats aggregation, upsert,
 * earned reward lookup, and merchant_id tenant isolation.
 *
 * MED-4: Updated for CTE-based query consolidation (6 queries -> 2).
 */

const { updateCustomerSummary } = require('../../../services/loyalty-admin/customer-summary-service');

const MERCHANT_ID = 1;
const CUSTOMER_ID = 'CUST_001';
const OFFER_ID = 5;

function makeMockClient(queryResults = []) {
    let callIndex = 0;
    return {
        query: jest.fn(async () => {
            return queryResults[callIndex++] || { rows: [] };
        })
    };
}

describe('customer-summary-service', () => {
    test('upserts summary with correct stats from purchase events', async () => {
        const client = makeMockClient([
            // Query 1: stats query (purchase events)
            { rows: [{ current_quantity: '5', lifetime_purchases: '10', last_purchase: '2026-01-15', window_start: '2025-07-15', window_end: '2026-07-15' }] },
            // Query 2: CTE reward counts + offer info
            { rows: [{ earned_count: '1', redeemed_count: '2', total_earned_redeemed: '3', earliest_earned_id: 42, required_quantity: 12 }] },
            // Query 3: upsert
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        // MED-4: Now only 3 queries (stats, CTE reward+offer, upsert)
        expect(client.query).toHaveBeenCalledTimes(3);

        // Verify the upsert call (last query)
        const upsertCall = client.query.mock.calls[2];
        const params = upsertCall[1];
        expect(params[0]).toBe(MERCHANT_ID);
        expect(params[1]).toBe(CUSTOMER_ID);
        expect(params[2]).toBe(OFFER_ID);
        expect(params[3]).toBe(5);  // current_quantity
        expect(params[4]).toBe(12); // required_quantity
        expect(params[7]).toBe(true); // has_earned_reward
        expect(params[8]).toBe(42);   // earned_reward_id
        expect(params[9]).toBe(10);   // lifetime_purchases
        expect(params[10]).toBe(3);   // total_rewards_earned
        expect(params[11]).toBe(2);   // total_rewards_redeemed
    });

    test('handles no earned rewards (earnedRewardId is null)', async () => {
        const client = makeMockClient([
            // stats query
            { rows: [{ current_quantity: '3', lifetime_purchases: '3', last_purchase: '2026-01-10', window_start: '2025-07-10', window_end: '2026-07-10' }] },
            // CTE: earned_count = 0, no earliest_earned_id
            { rows: [{ earned_count: '0', redeemed_count: '0', total_earned_redeemed: '0', earliest_earned_id: null, required_quantity: 12 }] },
            // upsert
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        // MED-4: 3 queries (no conditional earned reward ID lookup needed)
        expect(client.query).toHaveBeenCalledTimes(3);
        const upsertCall = client.query.mock.calls[2];
        const params = upsertCall[1];
        expect(params[7]).toBe(false); // has_earned_reward
        expect(params[8]).toBe(null);  // earned_reward_id
    });

    test('all queries include merchant_id for tenant isolation', async () => {
        const client = makeMockClient([
            { rows: [{ current_quantity: '0', lifetime_purchases: '0', last_purchase: null, window_start: null, window_end: null }] },
            { rows: [{ earned_count: '0', redeemed_count: '0', total_earned_redeemed: '0', earliest_earned_id: null, required_quantity: 10 }] },
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        // Verify merchant_id is in the stats query params
        expect(client.query.mock.calls[0][1]).toContain(MERCHANT_ID);
        // Verify merchant_id is in the CTE query params
        expect(client.query.mock.calls[1][1]).toContain(MERCHANT_ID);
        // The upsert also includes merchant_id
        expect(client.query.mock.calls[2][1][0]).toBe(MERCHANT_ID);
    });

    test('handles null/zero values gracefully', async () => {
        const client = makeMockClient([
            { rows: [{ current_quantity: null, lifetime_purchases: null, last_purchase: null, window_start: null, window_end: null }] },
            { rows: [{ earned_count: null, redeemed_count: null, total_earned_redeemed: null, earliest_earned_id: null, required_quantity: null }] },
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        const upsertParams = client.query.mock.calls[2][1];
        expect(upsertParams[3]).toBe(0); // current_quantity defaults to 0
        expect(upsertParams[4]).toBe(0); // required_quantity defaults to 0
        expect(upsertParams[9]).toBe(0); // lifetime_purchases defaults to 0
    });

    test('MED-4: uses CTE with reward_counts and offer_info', async () => {
        const client = makeMockClient([
            { rows: [{ current_quantity: '0', lifetime_purchases: '0', last_purchase: null, window_start: null, window_end: null }] },
            { rows: [{ earned_count: '2', redeemed_count: '1', total_earned_redeemed: '3', earliest_earned_id: 99, required_quantity: 12 }] },
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        // Second query should be the CTE
        const cteQuery = client.query.mock.calls[1][0];
        expect(cteQuery).toContain('WITH reward_counts AS');
        expect(cteQuery).toContain('offer_info AS');
        expect(cteQuery).toContain('earned_count');
        expect(cteQuery).toContain('redeemed_count');
        expect(cteQuery).toContain('total_earned_redeemed');
        expect(cteQuery).toContain('earliest_earned_id');
        expect(cteQuery).toContain('required_quantity');
    });

    test('MED-4: only 2 queries before upsert (was 5-6)', async () => {
        const client = makeMockClient([
            { rows: [{ current_quantity: '5', lifetime_purchases: '10', last_purchase: '2026-01-15', window_start: '2025-07-15', window_end: '2026-07-15' }] },
            { rows: [{ earned_count: '1', redeemed_count: '0', total_earned_redeemed: '1', earliest_earned_id: 10, required_quantity: 12 }] },
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        // Total: stats + CTE + upsert = 3 queries
        expect(client.query).toHaveBeenCalledTimes(3);
    });
});
