/**
 * Square Sync Orchestrator Tests
 *
 * Tests for full sync orchestration across all Square data domains.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/square/square-locations', () => ({
    syncLocations: jest.fn(),
}));

jest.mock('../../../services/square/square-vendors', () => ({
    syncVendors: jest.fn(),
}));

jest.mock('../../../services/square/square-catalog-sync', () => ({
    syncCatalog: jest.fn(),
}));

jest.mock('../../../services/square/square-inventory', () => ({
    syncInventory: jest.fn(),
    syncCommittedInventory: jest.fn(),
}));

jest.mock('../../../services/square/square-velocity', () => ({
    syncSalesVelocityAllPeriods: jest.fn(),
}));

const { syncLocations } = require('../../../services/square/square-locations');
const { syncVendors } = require('../../../services/square/square-vendors');
const { syncCatalog } = require('../../../services/square/square-catalog-sync');
const { syncInventory, syncCommittedInventory } = require('../../../services/square/square-inventory');
const { syncSalesVelocityAllPeriods } = require('../../../services/square/square-velocity');
const { fullSync } = require('../../../services/square/square-sync-orchestrator');

describe('Square Sync Orchestrator', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('fullSync', () => {
        test('throws if merchantId is missing', async () => {
            await expect(fullSync(null)).rejects.toThrow('merchantId is required');
        });

        test('runs all sync operations and returns summary', async () => {
            syncLocations.mockResolvedValue(3);
            syncVendors.mockResolvedValue(5);
            syncCatalog.mockResolvedValue({ items: 100, variations: 200 });
            syncInventory.mockResolvedValue(200);
            syncCommittedInventory.mockResolvedValue(10);
            syncSalesVelocityAllPeriods.mockResolvedValue({ periods: 3 });

            const summary = await fullSync(1);

            expect(summary.success).toBe(true);
            expect(summary.errors).toHaveLength(0);
            expect(summary.locations).toBe(3);
            expect(summary.vendors).toBe(5);
            expect(summary.catalog).toEqual({ items: 100, variations: 200 });
            expect(summary.inventory).toBe(200);
            expect(summary.committedInventory).toBe(10);
            expect(summary.salesVelocity).toEqual({ periods: 3 });
        });

        test('continues after individual step failures', async () => {
            syncLocations.mockRejectedValue(new Error('Location sync failed'));
            syncVendors.mockResolvedValue(5);
            syncCatalog.mockRejectedValue(new Error('Catalog sync failed'));
            syncInventory.mockResolvedValue(100);
            syncCommittedInventory.mockResolvedValue(0);
            syncSalesVelocityAllPeriods.mockResolvedValue({});

            const summary = await fullSync(1);

            expect(summary.success).toBe(false);
            expect(summary.errors).toHaveLength(2);
            expect(summary.errors[0]).toContain('Locations');
            expect(summary.errors[1]).toContain('Catalog');
            expect(summary.vendors).toBe(5);
            expect(summary.inventory).toBe(100);
        });

        test('captures all step errors without stopping', async () => {
            syncLocations.mockRejectedValue(new Error('fail1'));
            syncVendors.mockRejectedValue(new Error('fail2'));
            syncCatalog.mockRejectedValue(new Error('fail3'));
            syncInventory.mockRejectedValue(new Error('fail4'));
            syncCommittedInventory.mockRejectedValue(new Error('fail5'));
            syncSalesVelocityAllPeriods.mockRejectedValue(new Error('fail6'));

            const summary = await fullSync(1);

            expect(summary.success).toBe(false);
            expect(summary.errors).toHaveLength(6);
        });

        test('calls sync steps with merchantId', async () => {
            syncLocations.mockResolvedValue(0);
            syncVendors.mockResolvedValue(0);
            syncCatalog.mockResolvedValue({});
            syncInventory.mockResolvedValue(0);
            syncCommittedInventory.mockResolvedValue(0);
            syncSalesVelocityAllPeriods.mockResolvedValue({});

            await fullSync(42);

            expect(syncLocations).toHaveBeenCalledWith(42);
            expect(syncVendors).toHaveBeenCalledWith(42);
            expect(syncCatalog).toHaveBeenCalledWith(42);
            expect(syncInventory).toHaveBeenCalledWith(42);
            expect(syncCommittedInventory).toHaveBeenCalledWith(42);
            expect(syncSalesVelocityAllPeriods).toHaveBeenCalledWith(42);
        });

        test('success is true only when zero errors', async () => {
            syncLocations.mockResolvedValue(1);
            syncVendors.mockResolvedValue(1);
            syncCatalog.mockResolvedValue({});
            syncInventory.mockResolvedValue(1);
            syncCommittedInventory.mockResolvedValue(0);
            syncSalesVelocityAllPeriods.mockResolvedValue({});

            const summary = await fullSync(1);
            expect(summary.success).toBe(true);
            expect(summary.errors).toEqual([]);
        });
    });
});
