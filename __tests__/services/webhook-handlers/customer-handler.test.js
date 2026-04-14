/**
 * Tests for CustomerHandler webhook handler
 *
 * @module __tests__/services/webhook-handlers/customer-handler
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../utils/logger', () => logger);
jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../services/loyalty-admin', () => ({ runLoyaltyCatchup: jest.fn() }));

const mockSeniorsInstance = { initialize: jest.fn(), handleCustomerBirthdayUpdate: jest.fn() };
jest.mock('../../../services/seniors', () => ({
    SeniorsService: jest.fn().mockImplementation(() => mockSeniorsInstance)
}));

const mockGetMerchantToken = jest.fn();
const mockMakeSquareRequest = jest.fn();
jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: (...args) => mockGetMerchantToken(...args),
    makeSquareRequest: (...args) => mockMakeSquareRequest(...args),
}));

jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    cacheCustomerDetails: jest.fn()
}));

const db = require('../../../utils/database');
const loyaltyService = require('../../../services/loyalty-admin');
const { cacheCustomerDetails } = require('../../../services/loyalty-admin/customer-cache-service');
const CustomerHandler = require('../../../services/webhook-handlers/customer-handler');

describe('CustomerHandler', () => {
    let handler;

    beforeEach(() => {
        jest.clearAllMocks();
        handler = new CustomerHandler();

        // Default: runLoyaltyCatchup returns no new orders
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 0 });

        // Default: token resolves and Square returns no customer
        mockGetMerchantToken.mockResolvedValue('TOKEN_123');
        mockMakeSquareRequest.mockResolvedValue({ customer: null });

        // Default: no rows updated for note sync
        db.query.mockResolvedValue({ rowCount: 0, rows: [] });
    });

    describe('handleCustomerChange', () => {
        it('returns early when no merchantId', async () => {
            const result = await handler.handleCustomerChange({
                data: { customer: { id: 'CUST_1' } },
                merchantId: null,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(result).toEqual({ handled: true });
            expect(loyaltyService.runLoyaltyCatchup).not.toHaveBeenCalled();
        });

        it('returns early when no customerId (no entityId and no data.customer.id)', async () => {
            const result = await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: null,
                event: { type: 'customer.updated' }
            });

            expect(result).toEqual({ handled: true });
            expect(loyaltyService.runLoyaltyCatchup).not.toHaveBeenCalled();
        });

        it('syncs customer notes to delivery_orders when customer data present', async () => {
            // First call: UPDATE delivery_orders; second call: UPDATE loyalty_customers
            db.query.mockResolvedValueOnce({ rowCount: 2, rows: [] });
            db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
            mockMakeSquareRequest.mockResolvedValue({ customer: null });

            const result = await handler.handleCustomerChange({
                data: { customer: { id: 'CUST_1', note: 'Ring doorbell' } },
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE delivery_orders'),
                ['Ring doorbell', 1, 'CUST_1']
            );
            expect(result.customerNotes).toEqual({ customerId: 'CUST_1', ordersUpdated: 2 });
        });

        it('persists note to loyalty_customers on customer.updated webhook', async () => {
            db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // delivery_orders
            db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // loyalty_customers
            mockMakeSquareRequest.mockResolvedValue({ customer: null });

            await handler.handleCustomerChange({
                data: { customer: { id: 'CUST_1', note: 'Leave at back door' } },
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE loyalty_customers'),
                ['Leave at back door', 1, 'CUST_1']
            );
        });

        it('clears loyalty_customers note when customer note is removed', async () => {
            db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // delivery_orders
            db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // loyalty_customers
            mockMakeSquareRequest.mockResolvedValue({ customer: null });

            await handler.handleCustomerChange({
                data: { customer: { id: 'CUST_1' } }, // no note field
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE loyalty_customers'),
                [null, 1, 'CUST_1']
            );
        });

        it('does not set customerNotes when no rows updated', async () => {
            db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // delivery_orders
            db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // loyalty_customers
            mockMakeSquareRequest.mockResolvedValue({ customer: null });

            const result = await handler.handleCustomerChange({
                data: { customer: { id: 'CUST_1', note: 'Ring doorbell' } },
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(result.customerNotes).toBeUndefined();
        });

        it('runs loyalty catchup with correct params', async () => {
            loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 0 });
            mockMakeSquareRequest.mockResolvedValue({ customer: null });

            await handler.handleCustomerChange({
                data: {},
                merchantId: 5,
                entityId: 'CUST_99',
                event: { type: 'customer.created' }
            });

            expect(loyaltyService.runLoyaltyCatchup).toHaveBeenCalledWith({
                merchantId: 5,
                customerIds: ['CUST_99'],
                periodDays: 1,
                maxCustomers: 1,
            });
        });

        it('includes loyaltyCatchup in result when ordersNewlyTracked > 0', async () => {
            loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 3 });
            mockMakeSquareRequest.mockResolvedValue({ customer: null });

            const result = await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(result.loyaltyCatchup).toEqual({
                customerId: 'CUST_1',
                ordersNewlyTracked: 3,
            });
        });

        it('fetches and caches customer from Square', async () => {
            const customer = { id: 'CUST_1', givenName: 'Jane' };
            mockMakeSquareRequest.mockResolvedValue({ customer });

            await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(mockGetMerchantToken).toHaveBeenCalledWith(1);
            expect(mockMakeSquareRequest).toHaveBeenCalledWith(
                '/v2/customers/CUST_1',
                expect.objectContaining({
                    method: 'GET',
                    accessToken: 'TOKEN_123',
                    timeout: 10000,
                })
            );
            expect(cacheCustomerDetails).toHaveBeenCalledWith(customer, 1);
        });

        it('returns null from _fetchAndCacheCustomer on error (non-blocking)', async () => {
            mockMakeSquareRequest.mockRejectedValue(new Error('API down'));

            const result = await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(result.handled).toBe(true);
            expect(logger.warn).toHaveBeenCalledWith(
                'Failed to fetch/cache customer details',
                expect.objectContaining({ merchantId: 1, customerId: 'CUST_1' })
            );
        });

        it('checks seniors birthday when customer has birthday and config enabled', async () => {
            const customer = { id: 'CUST_1', birthday: '1950-05-15' };
            mockMakeSquareRequest.mockResolvedValue({ customer });

            // No data.customer so _syncCustomerNotes is skipped.
            // First db.query call is the seniors config check.
            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

            mockSeniorsInstance.handleCustomerBirthdayUpdate.mockResolvedValue({
                groupChanged: true,
                action: 'added',
                age: 75
            });

            const result = await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(mockSeniorsInstance.initialize).toHaveBeenCalled();
            expect(mockSeniorsInstance.handleCustomerBirthdayUpdate).toHaveBeenCalledWith({
                squareCustomerId: 'CUST_1',
                birthday: '1950-05-15',
            });
            expect(result.seniorsDiscount).toEqual({
                groupChanged: true,
                action: 'added',
                age: 75
            });
        });

        it('skips seniors when no birthday on customer', async () => {
            const customer = { id: 'CUST_1' }; // no birthday
            mockMakeSquareRequest.mockResolvedValue({ customer });

            const result = await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(mockSeniorsInstance.handleCustomerBirthdayUpdate).not.toHaveBeenCalled();
            expect(result.seniorsDiscount).toBeUndefined();
        });

        it('skips seniors when config not enabled (no rows in seniors_discount_config)', async () => {
            const customer = { id: 'CUST_1', birthday: '1950-05-15' };
            mockMakeSquareRequest.mockResolvedValue({ customer });

            // seniors config check returns empty (no enabled config)
            db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

            const result = await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(mockSeniorsInstance.handleCustomerBirthdayUpdate).not.toHaveBeenCalled();
            expect(result.seniorsDiscount).toBeUndefined();
        });

        it('returns seniorsDiscount result when groupChanged is true', async () => {
            const customer = { id: 'CUST_1', birthday: '1960-01-01' };
            mockMakeSquareRequest.mockResolvedValue({ customer });

            db.query.mockResolvedValue({ rowCount: 0, rows: [{ id: 1 }] });

            mockSeniorsInstance.handleCustomerBirthdayUpdate.mockResolvedValue({
                groupChanged: true,
                action: 'removed',
                age: 66
            });

            const result = await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(result.seniorsDiscount).toEqual({
                groupChanged: true,
                action: 'removed',
                age: 66
            });
        });

        it('returns null from _checkSeniorsBirthday on error (non-blocking)', async () => {
            const customer = { id: 'CUST_1', birthday: '1950-05-15' };
            mockMakeSquareRequest.mockResolvedValue({ customer });

            // No data.customer so _syncCustomerNotes is skipped.
            // First db.query call is the seniors config check — make it throw.
            db.query.mockRejectedValueOnce(new Error('DB connection lost'));

            const result = await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'CUST_1',
                event: { type: 'customer.updated' }
            });

            expect(result.handled).toBe(true);
            expect(result.seniorsDiscount).toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(
                'Failed to check seniors eligibility',
                expect.objectContaining({ merchantId: 1, customerId: 'CUST_1' })
            );
        });

        it('uses entityId when available, falls back to data.customer.id', async () => {
            // Use data without .customer so _syncCustomerNotes is skipped
            // and no extra db.query calls occur
            mockMakeSquareRequest.mockResolvedValue({ customer: null });

            // With entityId — takes priority over data.customer.id
            await handler.handleCustomerChange({
                data: {},
                merchantId: 1,
                entityId: 'ENTITY_ID',
                event: { type: 'customer.updated' }
            });

            expect(loyaltyService.runLoyaltyCatchup).toHaveBeenCalledWith(
                expect.objectContaining({ customerIds: ['ENTITY_ID'] })
            );

            jest.clearAllMocks();
            loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 0 });
            mockMakeSquareRequest.mockResolvedValue({ customer: null });
            db.query.mockResolvedValue({ rowCount: 0, rows: [] });

            // Without entityId — falls back to data.customer.id
            await handler.handleCustomerChange({
                data: { customer: { id: 'NESTED_ID' } },
                merchantId: 1,
                entityId: null,
                event: { type: 'customer.updated' }
            });

            expect(loyaltyService.runLoyaltyCatchup).toHaveBeenCalledWith(
                expect.objectContaining({ customerIds: ['NESTED_ID'] })
            );
        });
    });
});
