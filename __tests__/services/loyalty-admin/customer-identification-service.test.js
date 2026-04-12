/**
 * Tests for services/loyalty-admin/customer-identification-service.js
 * and services/loyalty-admin/customer-details-service.js
 *
 * Covers:
 * - 6-method fallback chain order
 * - Per-method edge cases
 * - Customer details fetch + caching (extracted to customer-details-service.js)
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

const mockMakeSquareRequest = jest.fn();
const mockGetMerchantToken = jest.fn();

jest.mock('../../../services/square/square-client', () => ({
    makeSquareRequest: mockMakeSquareRequest,
    getMerchantToken: mockGetMerchantToken,
}));

const mockDbQuery = jest.fn();
jest.mock('../../../utils/database', () => ({
    query: mockDbQuery,
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: {
        customer: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        squareApi: jest.fn(),
    }
}));

const { LoyaltyCustomerService } = require('../../../services/loyalty-admin/customer-identification-service');
const { getCustomerDetails, cacheCustomerDetails } = require('../../../services/loyalty-admin/customer-details-service');

// ============================================================================
// HELPERS
// ============================================================================

const MERCHANT_ID = 1;

async function createService() {
    const service = new LoyaltyCustomerService(MERCHANT_ID);
    await service.initialize();
    return service;
}

function makeOrder(overrides = {}) {
    return {
        id: 'order-1',
        ...overrides,
    };
}

// Convenience mock helpers that mirror the call shapes of the old SquareApiClient
// but speak the underlying `makeSquareRequest` wire format.
function mockSearchLoyaltyEvents(events = []) {
    // POST /v2/loyalty/events/search — paginated, single page returns cursor=null
    mockMakeSquareRequest.mockResolvedValueOnce({ events, cursor: null });
}

function mockGetLoyaltyAccount(account) {
    // GET /v2/loyalty/accounts/{id} — returns { loyalty_account }
    mockMakeSquareRequest.mockResolvedValueOnce({ loyalty_account: account });
}

function mockSearchCustomers(customers = []) {
    // POST /v2/customers/search — paginated, single page returns cursor=null
    mockMakeSquareRequest.mockResolvedValueOnce({ customers, cursor: null });
}

function mockGetCustomer(customer) {
    // GET /v2/customers/{id} — returns { customer }
    mockMakeSquareRequest.mockResolvedValueOnce({ customer });
}

// ============================================================================
// TESTS — Fallback Chain Order
// ============================================================================

describe('identifyCustomerFromOrder — fallback chain', () => {
    let service;

    beforeEach(async () => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
        service = await createService();
    });

    test('order.customer_id present → returns immediately, no API calls', async () => {
        const order = makeOrder({ customer_id: 'cust-direct' });

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
            customerId: 'cust-direct',
            method: 'ORDER_CUSTOMER_ID',
            success: true,
        });
        // No Square API calls made
        expect(mockMakeSquareRequest).not.toHaveBeenCalled();
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('no customer_id, tender has customer_id → returns from tenders', async () => {
        const order = makeOrder({
            tenders: [{ id: 't1', customer_id: 'cust-tender' }],
        });

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
            customerId: 'cust-tender',
            method: 'TENDER_CUSTOMER_ID',
            success: true,
        });
        expect(mockMakeSquareRequest).not.toHaveBeenCalled();
    });

    test('no tender match, loyalty event found → returns from loyalty API', async () => {
        const order = makeOrder({
            tenders: [{ id: 't1' }], // no customer_id on tender
        });

        mockSearchLoyaltyEvents([{ loyalty_account_id: 'acct-1' }]);
        mockGetLoyaltyAccount({ customer_id: 'cust-loyalty' });

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
            customerId: 'cust-loyalty',
            method: 'LOYALTY_API',
            success: true,
        });
    });

    test('no loyalty event, order reward found → returns from order rewards', async () => {
        const order = makeOrder({
            tenders: [{ id: 't1' }],
            rewards: [{ id: 'reward-1' }],
        });

        // Method 3: loyalty events → empty
        mockSearchLoyaltyEvents([]);
        // Method 4: order rewards search → found
        mockSearchLoyaltyEvents([{ loyalty_account_id: 'acct-2' }]);
        mockGetLoyaltyAccount({ customer_id: 'cust-rewards' });

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
            customerId: 'cust-rewards',
            method: 'ORDER_REWARDS',
            success: true,
        });
    });

    test('no reward, fulfillment has phone → returns from customer search', async () => {
        const order = makeOrder({
            tenders: [{ id: 't1' }],
            fulfillments: [{
                pickup_details: {
                    recipient: { phone_number: '+16135551234' }
                }
            }],
        });

        // Method 3: loyalty events → empty
        mockSearchLoyaltyEvents([]);
        // Method 4: no rewards → skip
        // Method 5: phone search
        mockSearchCustomers([{ id: 'cust-phone' }]);

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
            customerId: 'cust-phone',
            method: 'FULFILLMENT_RECIPIENT',
            success: true,
        });
    });

    test('no fulfillment, loyalty discount matches DB → returns from DB', async () => {
        const order = makeOrder({
            tenders: [{ id: 't1' }],
            discounts: [{ catalog_object_id: 'disc-cat-1' }],
        });

        // Methods 3-5 fail
        mockSearchLoyaltyEvents([]);
        // No rewards, no fulfillments
        // Method 6: DB lookup
        mockDbQuery.mockResolvedValueOnce({
            rows: [{
                square_customer_id: 'cust-discount',
                reward_id: 'r-1',
                offer_name: 'Buy 12'
            }]
        });

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
            customerId: 'cust-discount',
            method: 'LOYALTY_DISCOUNT',
            success: true,
        });
    });

    test('all 6 methods fail → returns { customerId: null, method: NONE }', async () => {
        const order = makeOrder({
            tenders: [{ id: 't1' }], // no customer_id
        });

        // Method 3: empty
        mockSearchLoyaltyEvents([]);
        // Method 4: no rewards (empty array default)
        // Method 5: no fulfillments
        // Method 6: no discounts

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
            customerId: null,
            method: 'NONE',
            success: false,
        });
    });
});

// ============================================================================
// TESTS — Per-method Edge Cases
// ============================================================================

describe('identifyFromTenders — edge cases', () => {
    let service;

    beforeEach(async () => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
        service = await createService();
    });

    test('multiple tenders, only second has customer_id', async () => {
        const result = await service.identifyFromTenders(makeOrder({
            tenders: [
                { id: 't1' }, // no customer_id
                { id: 't2', customer_id: 'cust-second' },
            ],
        }));

        expect(result).toEqual({
            customerId: 'cust-second',
            method: 'TENDER_CUSTOMER_ID',
            success: true,
        });
    });

    test('tenders array is empty', async () => {
        const result = await service.identifyFromTenders(makeOrder({ tenders: [] }));
        expect(result.success).toBe(false);
    });

    test('tenders is undefined', async () => {
        const result = await service.identifyFromTenders(makeOrder());
        expect(result.success).toBe(false);
    });
});

describe('identifyFromLoyaltyEvents — edge cases', () => {
    let service;

    beforeEach(async () => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
        service = await createService();
    });

    test('Square API returns no events', async () => {
        mockSearchLoyaltyEvents([]);

        const result = await service.identifyFromLoyaltyEvents(makeOrder());

        expect(result.success).toBe(false);
        expect(result.method).toBe('LOYALTY_API');
    });

    test('Square API throws 429 → caught, falls through', async () => {
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('Rate limited (429)'));

        const result = await service.identifyFromLoyaltyEvents(makeOrder());

        expect(result.success).toBe(false);
        expect(result.method).toBe('LOYALTY_API');
    });

    test('loyalty event has no loyalty_account_id', async () => {
        mockSearchLoyaltyEvents([{ id: 'evt-1' }]); // no loyalty_account_id

        const result = await service.identifyFromLoyaltyEvents(makeOrder());

        expect(result.success).toBe(false);
    });
});

describe('identifyFromFulfillmentRecipient — edge cases', () => {
    let service;

    beforeEach(async () => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
        service = await createService();
    });

    test('phone search returns no results, email search succeeds', async () => {
        const order = makeOrder({
            fulfillments: [{
                pickup_details: {
                    recipient: {
                        phone_number: '+16135551234',
                        email_address: 'test@example.com',
                    }
                }
            }],
        });

        // Phone search → no match
        mockSearchCustomers([]);
        // Email search → match
        mockSearchCustomers([{ id: 'cust-email' }]);

        const result = await service.identifyFromFulfillmentRecipient(order);

        expect(result).toEqual({
            customerId: 'cust-email',
            method: 'FULFILLMENT_RECIPIENT',
            success: true,
        });
        // Both searches hit the customers/search endpoint
        expect(mockMakeSquareRequest).toHaveBeenCalledTimes(2);
    });

    test('no phone or email on fulfillment', async () => {
        const order = makeOrder({
            fulfillments: [{
                pickup_details: {
                    recipient: { display_name: 'John' } // no phone, no email
                }
            }],
        });

        const result = await service.identifyFromFulfillmentRecipient(order);

        expect(result.success).toBe(false);
        expect(mockMakeSquareRequest).not.toHaveBeenCalled();
    });

    test('delivery_details recipient extracted correctly', async () => {
        const order = makeOrder({
            fulfillments: [{
                delivery_details: {
                    recipient: { phone_number: '+16135559999' }
                }
            }],
        });

        mockSearchCustomers([{ id: 'cust-delivery' }]);

        const result = await service.identifyFromFulfillmentRecipient(order);

        expect(result.success).toBe(true);
        expect(result.customerId).toBe('cust-delivery');
    });
});

describe('identifyFromLoyaltyDiscount — edge cases', () => {
    let service;

    beforeEach(async () => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
        service = await createService();
    });

    test('discount catalog_object_id matches earned reward in DB', async () => {
        const order = makeOrder({
            discounts: [{ catalog_object_id: 'disc-123' }],
        });

        mockDbQuery.mockResolvedValueOnce({
            rows: [{ square_customer_id: 'cust-disc', reward_id: 'r-1', offer_name: 'Buy 10' }]
        });

        const result = await service.identifyFromLoyaltyDiscount(order);

        expect(result).toEqual({
            customerId: 'cust-disc',
            method: 'LOYALTY_DISCOUNT',
            success: true,
        });
        // Verify merchant_id tenant isolation in query
        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('merchant_id = $1'),
            [MERCHANT_ID, ['disc-123']]
        );
    });

    test('no discounts on order', async () => {
        const result = await service.identifyFromLoyaltyDiscount(makeOrder());
        expect(result.success).toBe(false);
        expect(mockDbQuery).not.toHaveBeenCalled();
    });

    test('handles camelCase catalogObjectId (SDK format)', async () => {
        const order = makeOrder({
            discounts: [{ catalogObjectId: 'disc-camel' }],
        });

        mockDbQuery.mockResolvedValueOnce({ rows: [] });

        await service.identifyFromLoyaltyDiscount(order);

        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.any(String),
            [MERCHANT_ID, ['disc-camel']]
        );
    });

    test('discounts with no catalog_object_id are filtered', async () => {
        const order = makeOrder({
            discounts: [
                { name: 'Manual discount' }, // no catalog_object_id
                { catalog_object_id: 'disc-real' },
            ],
        });

        mockDbQuery.mockResolvedValueOnce({ rows: [] });

        await service.identifyFromLoyaltyDiscount(order);

        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.any(String),
            [MERCHANT_ID, ['disc-real']]
        );
    });

    test('DB error → caught gracefully, returns failure', async () => {
        const order = makeOrder({
            discounts: [{ catalog_object_id: 'disc-err' }],
        });

        mockDbQuery.mockRejectedValueOnce(new Error('connection refused'));

        const result = await service.identifyFromLoyaltyDiscount(order);

        expect(result.success).toBe(false);
        expect(result.method).toBe('LOYALTY_DISCOUNT');
    });
});

// ============================================================================
// TESTS — Customer Details Service (extracted)
// ============================================================================

describe('getCustomerDetails (customer-details-service)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
    });

    test('returns Square customer profile', async () => {
        mockGetCustomer({
            id: 'cust-1',
            given_name: 'Jane',
            family_name: 'Doe',
            email_address: 'jane@example.com',
            phone_number: '+16135551234',
            company_name: null,
            created_at: '2026-01-01',
            updated_at: '2026-03-01',
        });

        const result = await getCustomerDetails('cust-1', MERCHANT_ID);

        expect(result).toEqual({
            id: 'cust-1',
            givenName: 'Jane',
            familyName: 'Doe',
            displayName: 'Jane Doe',
            email: 'jane@example.com',
            phone: '+16135551234',
            companyName: null,
            birthday: null,
            note: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-03-01',
        });
    });

    test('displayName falls back to company_name when no given/family name', async () => {
        mockGetCustomer({
            id: 'cust-2',
            company_name: 'JTPets Inc',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
        });

        const result = await getCustomerDetails('cust-2', MERCHANT_ID);

        expect(result.displayName).toBe('JTPets Inc');
    });

    test('Square API error → returns null', async () => {
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('NOT_FOUND'));

        const result = await getCustomerDetails('cust-bad', MERCHANT_ID);

        expect(result).toBeNull();
    });
});

describe('cacheCustomerDetails (customer-details-service)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
    });

    test('cache hit (exists in loyalty_customers) → no API call', async () => {
        mockDbQuery.mockResolvedValueOnce({
            rows: [{ phone_number: '+16135551111' }]
        });

        const result = await cacheCustomerDetails('cust-cached', MERCHANT_ID);

        expect(result).toEqual({
            id: 'cust-cached',
            phone: '+16135551111',
            cached: true,
        });
        expect(mockMakeSquareRequest).not.toHaveBeenCalled();
    });

    test('cache miss → fetches from Square, upserts to DB', async () => {
        // Cache check → no rows
        mockDbQuery.mockResolvedValueOnce({ rows: [] });

        // Square API fetch
        mockGetCustomer({
            id: 'cust-new',
            given_name: 'Bob',
            family_name: 'Smith',
            phone_number: '+16135552222',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
        });

        // Upsert
        mockDbQuery.mockResolvedValueOnce({ rows: [] });

        const result = await cacheCustomerDetails('cust-new', MERCHANT_ID);

        expect(result.id).toBe('cust-new');
        expect(result.givenName).toBe('Bob');
        // Verify upsert was called with ON CONFLICT
        expect(mockDbQuery).toHaveBeenCalledTimes(2);
        const upsertCall = mockDbQuery.mock.calls[1];
        expect(upsertCall[0]).toContain('ON CONFLICT');
        expect(upsertCall[0]).toContain('merchant_id');
    });

    test('cache exists but no phone → re-fetches from Square', async () => {
        // Cache check → row exists but phone is null
        mockDbQuery.mockResolvedValueOnce({
            rows: [{ phone_number: null }]
        });

        mockGetCustomer({
            id: 'cust-nophone',
            given_name: 'Alice',
            phone_number: '+16135553333',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
        });

        mockDbQuery.mockResolvedValueOnce({ rows: [] }); // upsert

        const result = await cacheCustomerDetails('cust-nophone', MERCHANT_ID);

        expect(result.phone).toBe('+16135553333');
        expect(mockMakeSquareRequest).toHaveBeenCalled();
    });

    test('Square API fails → returns null gracefully', async () => {
        mockDbQuery.mockResolvedValueOnce({ rows: [] }); // cache miss
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('UNAUTHORIZED'));

        const result = await cacheCustomerDetails('cust-err', MERCHANT_ID);

        expect(result).toBeNull();
    });
});
