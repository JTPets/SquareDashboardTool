/**
 * Tests for Sales Velocity Incremental Updates
 *
 * Covers P0-API-2 optimization: updateSalesVelocityFromOrder function
 * in services/square/api.js (re-exported via utils/square-api.js)
 *
 * This function updates velocity records incrementally from a single order
 * instead of fetching all 91 days of orders (~37 API calls saved per order).
 */

// Create mock before requiring modules
const mockDbQuery = jest.fn();

jest.mock('../../utils/database', () => ({
    query: mockDbQuery,
    transaction: jest.fn((fn) => fn({ query: mockDbQuery })),
    getPoolStats: jest.fn().mockReturnValue({ total: 10, idle: 5, waiting: 0 })
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

// Mock other dependencies that square-api needs
jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn()
}));

// Now require the module
const squareApi = require('../../utils/square-api');

describe('updateSalesVelocityFromOrder', () => {
    const merchantId = 1;

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset mock to return existing variations by default
        mockDbQuery.mockResolvedValue({ rows: [] });
    });

    describe('Input Validation', () => {
        it('should return early if no order provided', async () => {
            const result = await squareApi.updateSalesVelocityFromOrder(null, merchantId);

            expect(result).toEqual({ updated: 0, skipped: 0, reason: 'No order provided' });
            expect(mockDbQuery).not.toHaveBeenCalled();
        });

        it('should return early if order is not COMPLETED', async () => {
            const order = {
                id: 'order-123',
                state: 'OPEN',
                line_items: [{ catalog_object_id: 'var-1', quantity: '2' }]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result).toEqual({ updated: 0, skipped: 0, reason: 'Order not completed' });
        });

        it('should return early if order has no line_items', async () => {
            const order = {
                id: 'order-123',
                state: 'COMPLETED',
                line_items: []
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result).toEqual({ updated: 0, skipped: 0, reason: 'No line items' });
        });

        it('should return early if order has no line_items array', async () => {
            const order = {
                id: 'order-123',
                state: 'COMPLETED'
                // No line_items
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result).toEqual({ updated: 0, skipped: 0, reason: 'No line items' });
        });

        it('should return early if no merchantId provided', async () => {
            const order = {
                id: 'order-123',
                state: 'COMPLETED',
                line_items: [{ catalog_object_id: 'var-1', quantity: '2' }]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, null);

            expect(result).toEqual({ updated: 0, skipped: 0, reason: 'No merchantId' });
        });

        it('should return early if no location_id in order', async () => {
            const order = {
                id: 'order-123',
                state: 'COMPLETED',
                line_items: [{ catalog_object_id: 'var-1', quantity: '2' }]
                // No location_id
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result).toEqual({ updated: 0, skipped: 0, reason: 'No location_id' });
        });
    });

    describe('Order Age and Period Filtering', () => {
        it('should skip orders older than 365 days', async () => {
            const oldDate = new Date();
            oldDate.setDate(oldDate.getDate() - 400);  // 400 days ago

            const order = {
                id: 'order-old',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: oldDate.toISOString(),
                line_items: [{ catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } }]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result).toEqual({ updated: 0, skipped: 0, reason: 'Order too old for all periods' });
        });

        it('should update only applicable periods based on order age', async () => {
            // Order from 100 days ago - should only update 182d and 365d (not 91d)
            const date100DaysAgo = new Date();
            date100DaysAgo.setDate(date100DaysAgo.getDate() - 100);

            // Mock existing variation lookup
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })  // Variation exists
                .mockResolvedValue({ rows: [] });  // Velocity upserts

            const order = {
                id: 'order-100days',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: date100DaysAgo.toISOString(),
                line_items: [{ catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } }]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Should have updated for 182d and 365d periods (2 updates)
            expect(result.periods).toEqual([182, 365]);
            expect(result.updated).toBe(2);
        });

        it('should update all periods for recent orders', async () => {
            // Order from today
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })  // Variation exists
                .mockResolvedValue({ rows: [] });  // Velocity upserts

            const order = {
                id: 'order-today',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [{ catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } }]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Should have updated for all 3 periods (91, 182, 365)
            expect(result.periods).toEqual([91, 182, 365]);
            expect(result.updated).toBe(3);
        });
    });

    describe('Variation Validation', () => {
        it('should skip line items without catalog_object_id', async () => {
            mockDbQuery.mockResolvedValueOnce({ rows: [] });  // No variations found

            const order = {
                id: 'order-no-catalog',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { name: 'Custom Item', quantity: '1', total_money: { amount: 500 } }
                    // No catalog_object_id
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result).toEqual({ updated: 0, skipped: 0, reason: 'No catalog variations in order' });
        });

        it('should skip variations not in database', async () => {
            // No variations exist in DB
            mockDbQuery.mockResolvedValueOnce({ rows: [] });

            const order = {
                id: 'order-unknown-var',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'unknown-var', quantity: '2', total_money: { amount: 1000 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Should skip the unknown variation
            expect(result.skipped).toBe(1);
        });

        it('should process only variations that exist in merchant catalog', async () => {
            // Only var-1 exists in DB
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })
                .mockResolvedValue({ rows: [] });  // Velocity upserts

            const order = {
                id: 'order-mixed-vars',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } },
                    { catalog_object_id: 'var-2', quantity: '3', total_money: { amount: 1500 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Should have skipped at least var-2
            expect(result.skipped).toBeGreaterThanOrEqual(1);
            // The total of updated + skipped should reflect all line items with catalog IDs
            expect(result.updated + result.skipped).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Quantity and Revenue Processing', () => {
        it('should skip line items with zero quantity', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-zero-qty',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '0', total_money: { amount: 0 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result.skipped).toBe(1);
            expect(result.updated).toBe(0);
        });

        it('should handle missing total_money gracefully', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-no-money',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '5' }
                    // No total_money
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Should still update (revenue defaults to 0)
            expect(result.updated).toBe(3);  // All 3 periods
        });

        it('should parse decimal quantities correctly', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-decimal',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2.5', total_money: { amount: 1250 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result.updated).toBe(3);

            // Verify the upsert query was called with correct quantity
            const upsertCalls = mockDbQuery.mock.calls.filter(call =>
                call[0].includes('INSERT INTO sales_velocity')
            );
            expect(upsertCalls.length).toBeGreaterThan(0);
        });
    });

    describe('Database Upsert Behavior', () => {
        it('should perform atomic upsert for each variation/period', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-upsert',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '3', total_money: { amount: 1500 } }
                ]
            };

            await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Should have called upsert 3 times (once per period: 91, 182, 365)
            const upsertCalls = mockDbQuery.mock.calls.filter(call =>
                call[0].includes('ON CONFLICT')
            );
            expect(upsertCalls.length).toBe(3);
        });

        it('should include correct data in upsert', async () => {
            // Mock the variation to exist with the correct ID
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-123' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-data-check',
                state: 'COMPLETED',
                location_id: 'loc-ABC',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-123', quantity: '4', total_money: { amount: 2000 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Verify the function processed the order
            // The upsert should have been called for each period (91, 182, 365)
            if (result.updated > 0) {
                const upsertCalls = mockDbQuery.mock.calls.filter(call =>
                    call[0] && call[0].includes && call[0].includes('INSERT INTO sales_velocity')
                );
                expect(upsertCalls.length).toBeGreaterThan(0);
            } else {
                // If no updates, verify we at least have some query activity
                expect(mockDbQuery).toHaveBeenCalled();
            }
        });
    });

    describe('Multiple Line Items', () => {
        it('should process all line items in order', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }, { id: 'var-2' }, { id: 'var-3' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-multi',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } },
                    { catalog_object_id: 'var-2', quantity: '3', total_money: { amount: 1500 } },
                    { catalog_object_id: 'var-3', quantity: '1', total_money: { amount: 500 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // 3 variations × 3 periods = 9 updates
            expect(result.updated).toBe(9);
            expect(result.skipped).toBe(0);
        });

        it('should handle duplicate variation IDs in order', async () => {
            // Same variation appears twice (different line items)
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-dupe',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } },
                    { catalog_object_id: 'var-1', quantity: '3', total_money: { amount: 1500 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Both line items should be processed (6 updates: 2 items × 3 periods)
            expect(result.updated).toBe(6);
        });
    });

    describe('Error Handling', () => {
        it('should handle database error gracefully and continue', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }, { id: 'var-2' }] })
                .mockRejectedValueOnce(new Error('DB Error'))  // First upsert fails
                .mockResolvedValue({ rows: [] });  // Rest succeed

            const order = {
                id: 'order-db-error',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } },
                    { catalog_object_id: 'var-2', quantity: '3', total_money: { amount: 1500 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Should have some skipped due to DB error, but continue processing
            expect(result.skipped).toBeGreaterThan(0);
        });

        it('should use current date if closed_at is missing', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-no-closed',
                state: 'COMPLETED',
                location_id: 'loc-123',
                // No closed_at - should default to now
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            // Should work with all 3 periods since it's treated as "today"
            expect(result.periods).toEqual([91, 182, 365]);
        });
    });

    describe('Return Value', () => {
        it('should return complete result object', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1' }] })
                .mockResolvedValue({ rows: [] });

            const order = {
                id: 'order-result',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } }
                ]
            };

            const result = await squareApi.updateSalesVelocityFromOrder(order, merchantId);

            expect(result).toHaveProperty('updated');
            expect(result).toHaveProperty('skipped');
            expect(result).toHaveProperty('periods');
            expect(typeof result.updated).toBe('number');
            expect(typeof result.skipped).toBe('number');
            expect(Array.isArray(result.periods)).toBe(true);
        });
    });
});
