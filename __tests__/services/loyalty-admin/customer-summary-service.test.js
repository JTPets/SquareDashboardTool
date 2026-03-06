/**
 * Tests for customer-summary-service.js
 *
 * Validates updateCustomerSummary: stats aggregation, upsert,
 * earned reward lookup, and merchant_id tenant isolation.
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
            // stats query
            { rows: [{ current_quantity: '5', lifetime_purchases: '10', last_purchase: '2026-01-15', window_start: '2025-07-15', window_end: '2026-07-15' }] },
            // earned rewards count
            { rows: [{ count: '1' }] },
            // redeemed rewards count
            { rows: [{ count: '2' }] },
            // total earned+redeemed count
            { rows: [{ count: '3' }] },
            // offer required_quantity
            { rows: [{ required_quantity: 12 }] },
            // earned reward ID lookup
            { rows: [{ id: 42 }] },
            // upsert
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        expect(client.query).toHaveBeenCalledTimes(7);

        // Verify the upsert call (last query)
        const upsertCall = client.query.mock.calls[6];
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

    test('handles no earned rewards (skips reward ID lookup)', async () => {
        const client = makeMockClient([
            // stats query
            { rows: [{ current_quantity: '3', lifetime_purchases: '3', last_purchase: '2026-01-10', window_start: '2025-07-10', window_end: '2026-07-10' }] },
            // earned rewards count = 0
            { rows: [{ count: '0' }] },
            // redeemed rewards count
            { rows: [{ count: '0' }] },
            // total earned+redeemed count
            { rows: [{ count: '0' }] },
            // offer required_quantity
            { rows: [{ required_quantity: 12 }] },
            // upsert (no earned reward ID lookup needed)
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        // Should be 6 queries (no earned reward ID lookup)
        expect(client.query).toHaveBeenCalledTimes(6);
        const upsertCall = client.query.mock.calls[5];
        const params = upsertCall[1];
        expect(params[7]).toBe(false); // has_earned_reward
        expect(params[8]).toBe(null);  // earned_reward_id
    });

    test('all queries include merchant_id for tenant isolation', async () => {
        const client = makeMockClient([
            { rows: [{ current_quantity: '0', lifetime_purchases: '0', last_purchase: null, window_start: null, window_end: null }] },
            { rows: [{ count: '0' }] },
            { rows: [{ count: '0' }] },
            { rows: [{ count: '0' }] },
            { rows: [{ required_quantity: 10 }] },
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        // Verify merchant_id is in all parameterized queries
        for (let i = 0; i < 4; i++) {
            expect(client.query.mock.calls[i][1]).toContain(MERCHANT_ID);
        }
        // The upsert also includes merchant_id
        expect(client.query.mock.calls[5][1][0]).toBe(MERCHANT_ID);
    });

    test('handles null/zero values gracefully', async () => {
        const client = makeMockClient([
            { rows: [{ current_quantity: null, lifetime_purchases: null, last_purchase: null, window_start: null, window_end: null }] },
            { rows: [{ count: null }] },
            { rows: [{ count: null }] },
            { rows: [{ count: null }] },
            { rows: [] }, // no offer found
            { rows: [] }
        ]);

        await updateCustomerSummary(client, MERCHANT_ID, CUSTOMER_ID, OFFER_ID);

        const upsertParams = client.query.mock.calls[5][1];
        expect(upsertParams[3]).toBe(0); // current_quantity defaults to 0
        expect(upsertParams[4]).toBe(0); // required_quantity defaults to 0
        expect(upsertParams[9]).toBe(0); // lifetime_purchases defaults to 0
    });
});
