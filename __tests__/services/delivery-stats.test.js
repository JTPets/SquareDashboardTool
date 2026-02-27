/**
 * Delivery Stats Service Tests
 *
 * Tests for customer info, customer stats, customer note update,
 * and dashboard stats extracted from routes/delivery.js (Package 8, A-2).
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../services/delivery/delivery-service', () => ({
    getOrderById: jest.fn(),
    updateOrder: jest.fn(),
    getActiveRoute: jest.fn(),
}));

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn(),
}));

const db = require('../../utils/database');
const deliveryApi = require('../../services/delivery/delivery-service');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const deliveryStats = require('../../services/delivery/delivery-stats');

describe('Delivery Stats Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== getLocationIds ====================

    describe('getLocationIds', () => {
        test('returns array of Square location IDs', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { square_location_id: 'LOC_1' },
                    { square_location_id: 'LOC_2' },
                ]
            });

            const result = await deliveryStats.getLocationIds(1);

            expect(result).toEqual(['LOC_1', 'LOC_2']);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('locations'),
                [1]
            );
        });

        test('returns empty array when no active locations', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await deliveryStats.getLocationIds(1);

            expect(result).toEqual([]);
        });
    });

    // ==================== getCustomerInfo ====================

    describe('getCustomerInfo', () => {
        test('returns null order when order not found', async () => {
            deliveryApi.getOrderById.mockResolvedValue(null);

            const result = await deliveryStats.getCustomerInfo(1, 'order-1');

            expect(result.order).toBeNull();
            expect(result.customerData).toBeNull();
        });

        test('returns cached data when order has no Square customer ID', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                notes: 'Deliver before 5pm',
                customer_note: 'VIP customer',
                square_customer_id: null
            });

            const result = await deliveryStats.getCustomerInfo(1, 'order-1');

            expect(result.order).toBeTruthy();
            expect(result.customerData.order_notes).toBe('Deliver before 5pm');
            expect(result.customerData.customer_note).toBe('VIP customer');
            expect(result.customerData.square_customer_id).toBeNull();
        });

        test('fetches and merges Square customer data', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                notes: null,
                customer_note: 'Old note',
                square_customer_id: 'CUST_123'
            });
            deliveryApi.updateOrder.mockResolvedValue({});

            const mockSquareClient = {
                customers: {
                    get: jest.fn().mockResolvedValue({
                        customer: {
                            note: 'Updated note',
                            emailAddress: 'test@example.com',
                            phoneNumber: '+15551234567',
                            givenName: 'John',
                            familyName: 'Doe',
                            companyName: 'JT Pets'
                        }
                    })
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            const result = await deliveryStats.getCustomerInfo(1, 'order-1');

            expect(result.customerData.customer_name).toBe('John Doe');
            expect(result.customerData.customer_email).toBe('test@example.com');
            expect(result.customerData.customer_phone).toBe('+15551234567');
            expect(result.customerData.customer_company).toBe('JT Pets');
            expect(result.customerData.customer_note).toBe('Updated note');
        });

        test('syncs cached note when Square note differs', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                notes: null,
                customer_note: 'Old note',
                square_customer_id: 'CUST_123'
            });
            deliveryApi.updateOrder.mockResolvedValue({});

            const mockSquareClient = {
                customers: {
                    get: jest.fn().mockResolvedValue({
                        customer: { note: 'New note from Square', givenName: 'Test' }
                    })
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            await deliveryStats.getCustomerInfo(1, 'order-1');

            expect(deliveryApi.updateOrder).toHaveBeenCalledWith(1, 'order-1', {
                customerNote: 'New note from Square'
            });
        });

        test('does not sync note when Square note matches cached', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                notes: null,
                customer_note: 'Same note',
                square_customer_id: 'CUST_123'
            });

            const mockSquareClient = {
                customers: {
                    get: jest.fn().mockResolvedValue({
                        customer: { note: 'Same note', givenName: 'Test' }
                    })
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            await deliveryStats.getCustomerInfo(1, 'order-1');

            expect(deliveryApi.updateOrder).not.toHaveBeenCalled();
        });

        test('falls back to cached data on Square API error', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                notes: 'Notes here',
                customer_note: 'Cached note',
                square_customer_id: 'CUST_123'
            });

            const mockSquareClient = {
                customers: {
                    get: jest.fn().mockRejectedValue(new Error('Square API down'))
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            const result = await deliveryStats.getCustomerInfo(1, 'order-1');

            expect(result.customerData.customer_note).toBe('Cached note');
            expect(result.customerData.order_notes).toBe('Notes here');
        });
    });

    // ==================== updateCustomerNote ====================

    describe('updateCustomerNote', () => {
        test('returns null order when order not found', async () => {
            deliveryApi.getOrderById.mockResolvedValue(null);

            const result = await deliveryStats.updateCustomerNote(1, 'order-1', 'New note');

            expect(result.order).toBeNull();
            expect(result.error).toBe('Order not found');
        });

        test('returns error when no Square customer linked', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: null
            });

            const result = await deliveryStats.updateCustomerNote(1, 'order-1', 'Note');

            expect(result.order).toBeTruthy();
            expect(result.error).toBe('No Square customer linked to this order');
            expect(result.squareSynced).toBe(false);
        });

        test('updates note in Square and local cache', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123'
            });
            deliveryApi.updateOrder.mockResolvedValue({});

            const mockSquareClient = {
                customers: {
                    get: jest.fn().mockResolvedValue({
                        customer: { version: 5 }
                    }),
                    update: jest.fn().mockResolvedValue({})
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            const result = await deliveryStats.updateCustomerNote(1, 'order-1', 'New note');

            expect(result.squareSynced).toBe(true);
            expect(result.error).toBeNull();
            expect(mockSquareClient.customers.update).toHaveBeenCalledWith({
                customerId: 'CUST_123',
                note: 'New note',
                version: 5
            });
            expect(deliveryApi.updateOrder).toHaveBeenCalledWith(1, 'order-1', {
                customerNote: 'New note'
            });
        });

        test('updates local cache even when Square sync fails', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123'
            });
            deliveryApi.updateOrder.mockResolvedValue({});

            const mockSquareClient = {
                customers: {
                    get: jest.fn().mockRejectedValue(new Error('Square error')),
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            const result = await deliveryStats.updateCustomerNote(1, 'order-1', 'Note');

            expect(result.squareSynced).toBe(false);
            expect(result.error).toBeNull();
            expect(deliveryApi.updateOrder).toHaveBeenCalledWith(1, 'order-1', {
                customerNote: 'Note'
            });
        });

        test('handles null note (clearing note)', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123'
            });
            deliveryApi.updateOrder.mockResolvedValue({});

            const mockSquareClient = {
                customers: {
                    get: jest.fn().mockResolvedValue({ customer: { version: 1 } }),
                    update: jest.fn().mockResolvedValue({})
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            const result = await deliveryStats.updateCustomerNote(1, 'order-1', null);

            expect(mockSquareClient.customers.update).toHaveBeenCalledWith({
                customerId: 'CUST_123',
                note: null,
                version: 1
            });
            expect(deliveryApi.updateOrder).toHaveBeenCalledWith(1, 'order-1', {
                customerNote: null
            });
            expect(result.squareSynced).toBe(true);
        });
    });

    // ==================== getCustomerStats ====================

    describe('getCustomerStats', () => {
        test('returns null order when order not found', async () => {
            deliveryApi.getOrderById.mockResolvedValue(null);

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            expect(result.order).toBeNull();
            expect(result.stats).toBeNull();
        });

        test('returns default stats when no customer ID and no phone', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: null,
                phone: null,
                customer_name: 'Unknown'
            });

            const mockSquareClient = { customers: { search: jest.fn() } };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            expect(result.stats.order_count).toBe(0);
            expect(result.stats.is_repeat_customer).toBe(false);
            expect(result.stats.is_loyalty_member).toBe(false);
            expect(result.stats.payment_status).toBe('unknown');
        });

        test('looks up customer by phone when no customer ID', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: null,
                phone: '+15551234567',
                customer_name: 'John'
            });

            const mockSquareClient = {
                customers: {
                    search: jest.fn().mockResolvedValue({
                        customers: [{ id: 'CUST_FOUND', givenName: 'John' }]
                    })
                },
                orders: {
                    search: jest.fn().mockResolvedValue({ orders: [] }),
                    get: jest.fn()
                },
                loyalty: {
                    programs: {
                        get: jest.fn().mockRejectedValue(new Error('NOT_FOUND'))
                    }
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            db.query.mockResolvedValue({
                rows: [{ square_location_id: 'LOC_1' }]
            });

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            expect(mockSquareClient.customers.search).toHaveBeenCalledWith(
                expect.objectContaining({
                    query: {
                        filter: {
                            phoneNumber: { exact: '+15551234567' }
                        }
                    }
                })
            );
            expect(result.order).toBeTruthy();
        });

        test('returns default stats when no locations found', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123',
                customer_name: 'John'
            });

            const mockSquareClient = { customers: { search: jest.fn() } };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            db.query.mockResolvedValue({ rows: [] });

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            expect(result.stats.order_count).toBe(0);
            expect(result.stats.payment_status).toBe('unknown');
        });

        test('populates full stats with order count, loyalty, and payment', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123',
                square_order_id: 'SQ_ORDER_1',
                customer_name: 'John'
            });

            const mockSquareClient = {
                customers: { search: jest.fn() },
                orders: {
                    search: jest.fn().mockResolvedValue({
                        orders: [{ id: 'O1' }, { id: 'O2' }, { id: 'O3' }]
                    }),
                    get: jest.fn().mockResolvedValue({
                        order: {
                            totalMoney: { amount: BigInt(5000) },
                            tenders: [
                                { amountMoney: { amount: BigInt(5000) } }
                            ]
                        }
                    })
                },
                loyalty: {
                    programs: {
                        get: jest.fn().mockResolvedValue({ program: { id: 'P1' } })
                    },
                    accounts: {
                        search: jest.fn().mockResolvedValue({
                            loyaltyAccounts: [{ balance: 150 }]
                        })
                    }
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            db.query.mockResolvedValue({
                rows: [{ square_location_id: 'LOC_1' }]
            });

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            expect(result.stats.order_count).toBe(3);
            expect(result.stats.is_repeat_customer).toBe(true);
            expect(result.stats.is_loyalty_member).toBe(true);
            expect(result.stats.loyalty_balance).toBe(150);
            expect(result.stats.payment_status).toBe('paid');
            expect(result.stats.total_amount).toBe(5000);
            expect(result.stats.amount_paid).toBe(5000);
        });

        test('detects partial payment status', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123',
                square_order_id: 'SQ_ORDER_1'
            });

            const mockSquareClient = {
                customers: { search: jest.fn() },
                orders: {
                    search: jest.fn().mockResolvedValue({ orders: [] }),
                    get: jest.fn().mockResolvedValue({
                        order: {
                            totalMoney: { amount: BigInt(5000) },
                            tenders: [
                                { amountMoney: { amount: BigInt(2000) } }
                            ]
                        }
                    })
                },
                loyalty: {
                    programs: {
                        get: jest.fn().mockRejectedValue(new Error('NOT_FOUND'))
                    }
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            db.query.mockResolvedValue({
                rows: [{ square_location_id: 'LOC_1' }]
            });

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            expect(result.stats.payment_status).toBe('partial');
            expect(result.stats.total_amount).toBe(5000);
            expect(result.stats.amount_paid).toBe(2000);
        });

        test('detects unpaid payment status', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123',
                square_order_id: 'SQ_ORDER_1'
            });

            const mockSquareClient = {
                customers: { search: jest.fn() },
                orders: {
                    search: jest.fn().mockResolvedValue({ orders: [] }),
                    get: jest.fn().mockResolvedValue({
                        order: {
                            totalMoney: { amount: BigInt(5000) },
                            tenders: []
                        }
                    })
                },
                loyalty: {
                    programs: {
                        get: jest.fn().mockRejectedValue(new Error('NOT_FOUND'))
                    }
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            db.query.mockResolvedValue({
                rows: [{ square_location_id: 'LOC_1' }]
            });

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            expect(result.stats.payment_status).toBe('unpaid');
        });

        test('handles graceful degradation when Square APIs reject', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123',
                square_order_id: 'SQ_ORDER_1'
            });

            const mockSquareClient = {
                customers: { search: jest.fn() },
                orders: {
                    search: jest.fn().mockRejectedValue(new Error('orders.search failed')),
                    get: jest.fn().mockRejectedValue(new Error('orders.get failed'))
                },
                loyalty: {
                    programs: {
                        get: jest.fn().mockRejectedValue(new Error('loyalty failed'))
                    }
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            db.query.mockResolvedValue({
                rows: [{ square_location_id: 'LOC_1' }]
            });

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            // All API calls rejected but service should still return default stats
            expect(result.stats.order_count).toBe(0);
            expect(result.stats.is_loyalty_member).toBe(false);
            expect(result.stats.payment_status).toBe('unknown');
        });

        test('skips Square order fetch when no square_order_id', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'order-1',
                square_customer_id: 'CUST_123',
                square_order_id: null
            });

            const mockSquareClient = {
                customers: { search: jest.fn() },
                orders: {
                    search: jest.fn().mockResolvedValue({ orders: [{ id: 'O1' }] }),
                    get: jest.fn()
                },
                loyalty: {
                    programs: {
                        get: jest.fn().mockRejectedValue(new Error('NOT_FOUND'))
                    }
                }
            };
            getSquareClientForMerchant.mockResolvedValue(mockSquareClient);

            db.query.mockResolvedValue({
                rows: [{ square_location_id: 'LOC_1' }]
            });

            const result = await deliveryStats.getCustomerStats(1, 'order-1');

            expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
            expect(result.stats.payment_status).toBe('unknown');
        });
    });

    // ==================== getDashboardStats ====================

    describe('getDashboardStats', () => {
        test('returns aggregated dashboard stats', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [
                        { status: 'pending', count: '5' },
                        { status: 'completed', count: '12' },
                        { status: 'skipped', count: '2' }
                    ]
                })
                .mockResolvedValueOnce({
                    rows: [{ count: '3' }]
                });

            deliveryApi.getActiveRoute.mockResolvedValue({
                id: 'route-1',
                order_count: 8,
                completed_count: 5,
                skipped_count: 1
            });

            const result = await deliveryStats.getDashboardStats(1);

            expect(result.byStatus).toEqual({
                pending: 5,
                completed: 12,
                skipped: 2
            });
            expect(result.activeRoute).toEqual({
                id: 'route-1',
                totalStops: 8,
                completedStops: 5,
                skippedStops: 1
            });
            expect(result.completedToday).toBe(3);
        });

        test('returns null activeRoute when no route exists', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ count: '0' }] });

            deliveryApi.getActiveRoute.mockResolvedValue(null);

            const result = await deliveryStats.getDashboardStats(1);

            expect(result.byStatus).toEqual({});
            expect(result.activeRoute).toBeNull();
            expect(result.completedToday).toBe(0);
        });

        test('queries use merchant_id parameter', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ count: '0' }] });

            deliveryApi.getActiveRoute.mockResolvedValue(null);

            await deliveryStats.getDashboardStats(42);

            // Status counts query
            expect(db.query.mock.calls[0][1]).toEqual([42]);
            // Today completions query
            expect(db.query.mock.calls[1][1]).toEqual([42]);
            // Active route
            expect(deliveryApi.getActiveRoute).toHaveBeenCalledWith(42, expect.any(String));
        });
    });

    // ==================== resolveCustomerId ====================

    describe('resolveCustomerId', () => {
        test('returns order customer ID when present', async () => {
            const order = { square_customer_id: 'CUST_123', phone: '+15551234567' };
            const squareClient = { customers: { search: jest.fn() } };

            const result = await deliveryStats.resolveCustomerId(squareClient, order, 1);

            expect(result).toBe('CUST_123');
            expect(squareClient.customers.search).not.toHaveBeenCalled();
        });

        test('searches by phone when no customer ID', async () => {
            const order = { id: 'order-1', square_customer_id: null, phone: '+15551234567' };
            const squareClient = {
                customers: {
                    search: jest.fn().mockResolvedValue({
                        customers: [{ id: 'CUST_FOUND', givenName: 'Jane' }]
                    })
                }
            };

            const result = await deliveryStats.resolveCustomerId(squareClient, order, 1);

            expect(result).toBe('CUST_FOUND');
        });

        test('returns null when no customer ID and no phone', async () => {
            const order = { id: 'order-1', square_customer_id: null, phone: null };
            const squareClient = { customers: { search: jest.fn() } };

            const result = await deliveryStats.resolveCustomerId(squareClient, order, 1);

            expect(result).toBeNull();
        });

        test('returns null when phone search finds no match', async () => {
            const order = { id: 'order-1', square_customer_id: null, phone: '+15559999999' };
            const squareClient = {
                customers: {
                    search: jest.fn().mockResolvedValue({ customers: [] })
                }
            };

            const result = await deliveryStats.resolveCustomerId(squareClient, order, 1);

            expect(result).toBeNull();
        });

        test('returns null when phone search fails', async () => {
            const order = { id: 'order-1', square_customer_id: null, phone: '+15551234567' };
            const squareClient = {
                customers: {
                    search: jest.fn().mockRejectedValue(new Error('API error'))
                }
            };

            const result = await deliveryStats.resolveCustomerId(squareClient, order, 1);

            expect(result).toBeNull();
        });
    });
});
