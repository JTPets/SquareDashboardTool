/**
 * Tests for webhook handlers
 *
 * These tests verify the webhook handler routing and core functionality.
 * Individual handler logic is tested more thoroughly with the appropriate mocks.
 */

// Mock all external dependencies before imports
jest.mock('../../utils/subscription-handler', () => ({
    handleSubscriptionWebhook: jest.fn().mockResolvedValue({ processed: true }),
    getSubscriberBySquareSubscriptionId: jest.fn().mockResolvedValue(null),
    getSubscriberBySquareCustomerId: jest.fn().mockResolvedValue(null),
    logEvent: jest.fn().mockResolvedValue()
}));

jest.mock('../../utils/square-api', () => ({
    syncCatalog: jest.fn().mockResolvedValue({ items: 10, variations: 20 }),
    deltaSyncCatalog: jest.fn().mockResolvedValue({ items: 10, variations: 20, deltaSync: true }),
    syncInventory: jest.fn().mockResolvedValue({ counts: 50 }),
    syncCommittedInventory: jest.fn().mockResolvedValue({ synced: true }),
    syncSalesVelocity: jest.fn().mockResolvedValue({ updated: true }),
    upsertVendor: jest.fn().mockResolvedValue(),
    syncLocation: jest.fn().mockResolvedValue()
}));

jest.mock('../../utils/loyalty-service', () => ({
    runLoyaltyCatchup: jest.fn().mockResolvedValue()
}));

jest.mock('../../services/loyalty/webhook-service', () => ({
    processOrderForLoyalty: jest.fn().mockResolvedValue(),
    detectRewardRedemptionFromOrder: jest.fn().mockResolvedValue(),
    processOrderRefundsForLoyalty: jest.fn().mockResolvedValue()
}));

const db = require('../../utils/database');
const {
    routeEvent,
    hasHandler,
    getRegisteredEventTypes,
    oauthHandler,
    catalogHandler,
    inventoryHandler
} = require('../../services/webhook-handlers');
const syncQueue = require('../../services/sync-queue');
const squareApi = require('../../utils/square-api');

describe('Webhook Handlers Index', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        syncQueue.clear();
    });

    describe('routeEvent', () => {
        it('should return handled: false for unknown event type', async () => {
            const context = { event: { type: 'unknown.event' }, merchantId: 1 };

            const result = await routeEvent('unknown.event', context);

            expect(result).toEqual({ handled: false, reason: 'unhandled_event_type' });
        });

        it('should route oauth.authorization.revoked to oauth handler', async () => {
            const context = {
                event: { type: 'oauth.authorization.revoked', merchant_id: 'sq-123' },
                merchantId: 1
            };
            db.query.mockResolvedValue({ rows: [] });

            const result = await routeEvent('oauth.authorization.revoked', context);

            expect(result.handled).toBe(true);
            expect(result.result.revoked).toBe(true);
        });

        it('should propagate handler errors', async () => {
            const context = {
                event: { type: 'oauth.authorization.revoked', merchant_id: 'sq-123' },
                merchantId: 1
            };
            db.query.mockRejectedValue(new Error('Database error'));

            await expect(routeEvent('oauth.authorization.revoked', context))
                .rejects.toThrow('Database error');
        });
    });

    describe('hasHandler', () => {
        it('should return true for registered event types', () => {
            const expectedEvents = [
                'oauth.authorization.revoked',
                'subscription.created',
                'subscription.updated',
                'invoice.payment_made',
                'invoice.payment_failed',
                'customer.deleted',
                'customer.updated',
                'catalog.version.updated',
                'vendor.created',
                'vendor.updated',
                'location.created',
                'location.updated',
                'inventory.count.updated',
                'order.created',
                'order.updated',
                'order.fulfillment.updated',
                'payment.created',
                'payment.updated',
                'refund.created',
                'refund.updated',
                'loyalty.event.created',
                'loyalty.account.updated',
                'loyalty.account.created',
                'loyalty.program.updated',
                'gift_card.customer_linked'
            ];

            expectedEvents.forEach(eventType => {
                expect(hasHandler(eventType)).toBe(true);
            });
        });

        it('should return false for unregistered events', () => {
            expect(hasHandler('unknown.event')).toBe(false);
            expect(hasHandler('')).toBe(false);
            expect(hasHandler('foo.bar')).toBe(false);
        });
    });

    describe('getRegisteredEventTypes', () => {
        it('should return all registered event types', () => {
            const eventTypes = getRegisteredEventTypes();

            expect(Array.isArray(eventTypes)).toBe(true);
            expect(eventTypes.length).toBe(25); // Total handlers registered
            expect(eventTypes).toContain('subscription.created');
            expect(eventTypes).toContain('order.created');
            expect(eventTypes).toContain('oauth.authorization.revoked');
            expect(eventTypes).toContain('loyalty.event.created');
        });
    });
});

describe('OAuthHandler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('handleAuthorizationRevoked', () => {
        it('should mark merchant as disconnected', async () => {
            const context = {
                event: {
                    type: 'oauth.authorization.revoked',
                    merchant_id: 'square-merchant-123',
                    created_at: '2026-01-26T12:00:00Z'
                }
            };
            db.query.mockResolvedValue({ rows: [] });

            const result = await oauthHandler.handleAuthorizationRevoked(context);

            expect(result.handled).toBe(true);
            expect(result.revoked).toBe(true);
            expect(result.merchantId).toBe('square-merchant-123');

            // Verify database was updated
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE merchants'),
                ['square-merchant-123']
            );
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining("square_access_token = 'REVOKED'"),
                expect.any(Array)
            );
        });
    });
});

describe('CatalogHandler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        syncQueue.clear();
    });

    describe('handleCatalogVersionUpdated', () => {
        it('should skip sync when WEBHOOK_CATALOG_SYNC is disabled', async () => {
            const originalEnv = process.env.WEBHOOK_CATALOG_SYNC;
            process.env.WEBHOOK_CATALOG_SYNC = 'false';

            const context = {
                event: { type: 'catalog.version.updated' },
                merchantId: 1
            };

            const result = await catalogHandler.handleCatalogVersionUpdated(context);

            expect(result.skipped).toBe(true);
            expect(squareApi.deltaSyncCatalog).not.toHaveBeenCalled();

            process.env.WEBHOOK_CATALOG_SYNC = originalEnv;
        });

        it('should return error when merchantId is null', async () => {
            const context = {
                event: { type: 'catalog.version.updated' },
                merchantId: null
            };

            const result = await catalogHandler.handleCatalogVersionUpdated(context);

            expect(result.error).toBe('Merchant not found');
            expect(squareApi.deltaSyncCatalog).not.toHaveBeenCalled();
        });

        it('should execute catalog sync via queue', async () => {
            const context = {
                event: { type: 'catalog.version.updated' },
                merchantId: 1
            };

            const result = await catalogHandler.handleCatalogVersionUpdated(context);

            expect(squareApi.deltaSyncCatalog).toHaveBeenCalledWith(1);
            expect(result.catalog).toBeDefined();
        });

        it('should queue sync when already in progress', async () => {
            syncQueue.setCatalogSyncInProgress(1, true);

            const context = {
                event: { type: 'catalog.version.updated' },
                merchantId: 1
            };

            const result = await catalogHandler.handleCatalogVersionUpdated(context);

            expect(result.queued).toBe(true);
            expect(squareApi.deltaSyncCatalog).not.toHaveBeenCalled();
        });

        it('should run follow-up sync when pending webhooks arrived', async () => {
            squareApi.deltaSyncCatalog.mockImplementationOnce(async (merchantId) => {
                // Simulate webhook arriving during sync
                syncQueue.setCatalogSyncPending(merchantId, true);
                return { items: 10, variations: 20, deltaSync: true };
            });

            const context = {
                event: { type: 'catalog.version.updated' },
                merchantId: 1
            };

            const result = await catalogHandler.handleCatalogVersionUpdated(context);

            expect(squareApi.deltaSyncCatalog).toHaveBeenCalledTimes(2);
            expect(result.followUpSync).toBeDefined();
        });
    });
});

describe('InventoryHandler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        syncQueue.clear();
    });

    describe('handleInventoryCountUpdated', () => {
        it('should skip sync when WEBHOOK_INVENTORY_SYNC is disabled', async () => {
            const originalEnv = process.env.WEBHOOK_INVENTORY_SYNC;
            process.env.WEBHOOK_INVENTORY_SYNC = 'false';

            const context = {
                event: { type: 'inventory.count.updated' },
                merchantId: 1
            };

            const result = await inventoryHandler.handleInventoryCountUpdated(context);

            expect(result.skipped).toBe(true);
            expect(squareApi.syncInventory).not.toHaveBeenCalled();

            process.env.WEBHOOK_INVENTORY_SYNC = originalEnv;
        });

        it('should return error when merchantId is null', async () => {
            const context = {
                event: { type: 'inventory.count.updated' },
                merchantId: null
            };

            const result = await inventoryHandler.handleInventoryCountUpdated(context);

            expect(result.error).toBe('Merchant not found');
            expect(squareApi.syncInventory).not.toHaveBeenCalled();
        });

        it('should execute inventory sync via queue', async () => {
            const context = {
                event: { type: 'inventory.count.updated' },
                data: { inventory_count: { catalog_object_id: 'var-123', quantity: '10' } },
                merchantId: 1
            };

            const result = await inventoryHandler.handleInventoryCountUpdated(context);

            expect(squareApi.syncInventory).toHaveBeenCalledWith(1);
            expect(result.inventory).toBeDefined();
        });

        it('should queue sync when already in progress', async () => {
            syncQueue.setInventorySyncInProgress(1, true);

            const context = {
                event: { type: 'inventory.count.updated' },
                data: { inventory_count: { catalog_object_id: 'var-123', quantity: '10' } },
                merchantId: 1
            };

            const result = await inventoryHandler.handleInventoryCountUpdated(context);

            expect(result.queued).toBe(true);
            expect(squareApi.syncInventory).not.toHaveBeenCalled();
        });
    });
});

describe('Handler Integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        syncQueue.clear();
    });

    it('should route multiple event types correctly', async () => {
        const events = [
            { type: 'catalog.version.updated', merchantId: 1, data: {} },
            { type: 'inventory.count.updated', merchantId: 2, data: { inventory_count: { catalog_object_id: 'var-123' } } },
            { type: 'oauth.authorization.revoked', merchant_id: 'sq-123', data: {} }
        ];

        db.query.mockResolvedValue({ rows: [] });

        for (const eventConfig of events) {
            const context = {
                event: { type: eventConfig.type, merchant_id: eventConfig.merchant_id },
                data: eventConfig.data,
                merchantId: eventConfig.merchantId
            };

            const result = await routeEvent(eventConfig.type, context);
            expect(result.handled).toBe(true);
        }
    });

    it('should isolate sync state between merchants', async () => {
        // Start sync for merchant 1
        syncQueue.setCatalogSyncInProgress(1, true);

        // Merchant 2 should still be able to sync
        const context1 = {
            event: { type: 'catalog.version.updated' },
            merchantId: 1
        };
        const context2 = {
            event: { type: 'catalog.version.updated' },
            merchantId: 2
        };

        const result1 = await catalogHandler.handleCatalogVersionUpdated(context1);
        const result2 = await catalogHandler.handleCatalogVersionUpdated(context2);

        expect(result1.queued).toBe(true);
        expect(result2.catalog).toBeDefined();
        expect(squareApi.deltaSyncCatalog).toHaveBeenCalledWith(2);
        expect(squareApi.deltaSyncCatalog).not.toHaveBeenCalledWith(1);
    });
});
