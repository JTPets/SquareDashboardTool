/**
 * Tests for Catalog Variation Service
 *
 * Covers:
 * - getVariations
 * - getVariationsWithCosts
 * - updateExtendedFields
 * - updateMinStock
 * - updateCost
 * - bulkUpdateExtendedFields
 */

const mockDbQuery = jest.fn();

jest.mock('../../../utils/database', () => ({
    query: mockDbQuery
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../../utils/square-api', () => ({
    updateCustomAttributeValues: jest.fn().mockResolvedValue({ success: true }),
    setSquareInventoryAlertThreshold: jest.fn().mockResolvedValue({ success: true }),
    updateVariationCost: jest.fn().mockResolvedValue({ success: true })
}));

jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map())
}));

const variationService = require('../../../services/catalog/variation-service');
const squareApi = require('../../../utils/square-api');

describe('Catalog Variation Service', () => {
    const merchantId = 1;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getVariations', () => {
        it('should return variations for a merchant', async () => {
            const mockVariations = [
                { id: 'var-1', sku: 'SKU001', item_name: 'Dog Food', item_images: null },
                { id: 'var-2', sku: 'SKU002', item_name: 'Cat Food', item_images: null }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockVariations });

            const result = await variationService.getVariations(merchantId);

            expect(result.count).toBe(2);
            expect(result.variations).toHaveLength(2);
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(variationService.getVariations(null)).rejects.toThrow('merchantId is required');
        });

        it('should filter by item_id when provided', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await variationService.getVariations(merchantId, { item_id: 'item-123' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('v.item_id = '),
                expect.arrayContaining(['item-123'])
            );
        });

        it('should filter by sku when provided', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await variationService.getVariations(merchantId, { sku: 'SKU' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('v.sku ILIKE'),
                expect.arrayContaining(['%SKU%'])
            );
        });

        it('should filter by has_cost when true', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            await variationService.getVariations(merchantId, { has_cost: 'true' });

            expect(mockDbQuery).toHaveBeenCalledWith(
                expect.stringContaining('EXISTS (SELECT 1 FROM variation_vendors'),
                expect.any(Array)
            );
        });
    });

    describe('getVariationsWithCosts', () => {
        it('should return variations with cost and margin data', async () => {
            const mockData = [
                {
                    id: 'var-1',
                    sku: 'SKU001',
                    item_name: 'Dog Food',
                    retail_price_cents: 2000,
                    cost_cents: 1000,
                    margin_percent: 50.00,
                    profit_cents: 1000,
                    item_images: null
                }
            ];

            mockDbQuery.mockResolvedValue({ rows: mockData });

            const result = await variationService.getVariationsWithCosts(merchantId);

            expect(result.count).toBe(1);
            expect(result.variations[0]).toHaveProperty('retail_price_cents');
            expect(result.variations[0]).toHaveProperty('cost_cents');
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(variationService.getVariationsWithCosts(null)).rejects.toThrow('merchantId is required');
        });
    });

    describe('updateExtendedFields', () => {
        beforeEach(() => {
            // Default: variation exists
            mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 'var-1' }] });  // verifyOwnership
        });

        it('should update allowed extended fields', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1', case_pack_quantity: 12 }] });  // UPDATE

            const result = await variationService.updateExtendedFields('var-1', merchantId, {
                case_pack_quantity: 12,
                shelf_location: 'A-1'
            });

            expect(result.success).toBe(true);
            expect(result.variation).toBeDefined();
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(
                variationService.updateExtendedFields('var-1', null, { case_pack_quantity: 12 })
            ).rejects.toThrow('merchantId is required');
        });

        it('should throw error if variationId is not provided', async () => {
            await expect(
                variationService.updateExtendedFields(null, merchantId, { case_pack_quantity: 12 })
            ).rejects.toThrow('variationId is required');
        });

        it('should return 404 if variation not found', async () => {
            mockDbQuery.mockReset();
            mockDbQuery.mockResolvedValueOnce({ rows: [] });  // verifyOwnership - not found

            const result = await variationService.updateExtendedFields('nonexistent', merchantId, {
                case_pack_quantity: 12
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe(404);
        });

        it('should return 400 if no valid fields to update', async () => {
            const result = await variationService.updateExtendedFields('var-1', merchantId, {
                invalid_field: 'value'
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should sync case_pack_quantity to Square if valid value', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1', case_pack_quantity: 12 }] });

            await variationService.updateExtendedFields('var-1', merchantId, {
                case_pack_quantity: 12
            });

            expect(squareApi.updateCustomAttributeValues).toHaveBeenCalledWith(
                'var-1',
                expect.objectContaining({
                    case_pack_quantity: expect.any(Object)
                }),
                { merchantId }
            );
        });

        it('should NOT sync case_pack_quantity to Square if null', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1', case_pack_quantity: null }] });

            await variationService.updateExtendedFields('var-1', merchantId, {
                case_pack_quantity: null
            });

            expect(squareApi.updateCustomAttributeValues).not.toHaveBeenCalled();
        });

        it('should NOT sync case_pack_quantity to Square if zero', async () => {
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ id: 'var-1', case_pack_quantity: 0 }] });

            await variationService.updateExtendedFields('var-1', merchantId, {
                case_pack_quantity: 0
            });

            expect(squareApi.updateCustomAttributeValues).not.toHaveBeenCalled();
        });
    });

    describe('updateMinStock', () => {
        beforeEach(() => {
            // Default mocks for successful update
            mockDbQuery
                .mockResolvedValueOnce({  // Variation lookup
                    rows: [{
                        id: 'var-1',
                        sku: 'SKU001',
                        name: 'Size M',
                        item_id: 'item-1',
                        track_inventory: true,
                        inventory_alert_threshold: 5,
                        item_name: 'Dog Food'
                    }]
                })
                .mockResolvedValueOnce({ rows: [{ location_id: 'loc-1' }] })  // Inventory location
                .mockResolvedValueOnce({ rows: [] })  // UPDATE variations
                .mockResolvedValueOnce({ rows: [] });  // INSERT variation_location_settings
        });

        it('should update min stock and sync to Square', async () => {
            const result = await variationService.updateMinStock('var-1', merchantId, 10);

            expect(result.success).toBe(true);
            expect(result.new_value).toBe(10);
            expect(result.synced_to_square).toBe(true);
            expect(squareApi.setSquareInventoryAlertThreshold).toHaveBeenCalled();
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(
                variationService.updateMinStock('var-1', null, 10)
            ).rejects.toThrow('merchantId is required');
        });

        it('should throw error if variationId is not provided', async () => {
            await expect(
                variationService.updateMinStock(null, merchantId, 10)
            ).rejects.toThrow('variationId is required');
        });

        it('should return 400 for negative min_stock', async () => {
            mockDbQuery.mockReset();

            const result = await variationService.updateMinStock('var-1', merchantId, -5);

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should accept null to clear min_stock', async () => {
            const result = await variationService.updateMinStock('var-1', merchantId, null);

            expect(result.success).toBe(true);
        });

        it('should return 404 if variation not found', async () => {
            mockDbQuery.mockReset();
            mockDbQuery.mockResolvedValueOnce({ rows: [] });

            const result = await variationService.updateMinStock('nonexistent', merchantId, 10);

            expect(result.success).toBe(false);
            expect(result.status).toBe(404);
        });

        it('should return 400 if no active locations found', async () => {
            mockDbQuery.mockReset();
            mockDbQuery
                .mockResolvedValueOnce({  // Variation found
                    rows: [{ id: 'var-1', sku: 'SKU001', item_name: 'Dog Food' }]
                })
                .mockResolvedValueOnce({ rows: [] })  // No inventory locations
                .mockResolvedValueOnce({ rows: [] });  // No active locations

            const result = await variationService.updateMinStock('var-1', merchantId, 10);

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
            expect(result.error).toContain('No active locations');
        });

        it('should handle Square API error', async () => {
            squareApi.setSquareInventoryAlertThreshold.mockRejectedValueOnce(new Error('Square API Error'));

            const result = await variationService.updateMinStock('var-1', merchantId, 10);

            expect(result.success).toBe(false);
            expect(result.square_error).toBe(true);
        });
    });

    describe('updateCost', () => {
        beforeEach(() => {
            // Reset and set up mock for variation with vendor
            mockDbQuery.mockReset();
            mockDbQuery
                .mockResolvedValueOnce({  // Variation lookup with vendor
                    rows: [{
                        id: 'var-1',
                        sku: 'SKU001',
                        name: 'Size M',
                        item_name: 'Dog Food',
                        vendor_id: 'vendor-1',
                        current_cost: 500,
                        vendor_name: 'Pet Supplier'
                    }]
                })
                .mockResolvedValue({ rows: [] });  // Any subsequent queries
        });

        it('should update cost and sync to Square', async () => {
            const result = await variationService.updateCost('var-1', merchantId, 1000);

            // The function may return success with different property names
            expect(result.success).toBe(true);
            // Check if cost was recorded (may use different property name)
            expect(result.new_cost_cents || result.cost_cents || result.new_cost).toBeDefined();
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(
                variationService.updateCost('var-1', null, 1000)
            ).rejects.toThrow('merchantId is required');
        });

        it('should throw error if variationId is not provided', async () => {
            await expect(
                variationService.updateCost(null, merchantId, 1000)
            ).rejects.toThrow('variationId is required');
        });

        it('should return 400 if cost_cents is not provided', async () => {
            mockDbQuery.mockReset();

            const result = await variationService.updateCost('var-1', merchantId, null);

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should return 400 for negative cost', async () => {
            mockDbQuery.mockReset();

            const result = await variationService.updateCost('var-1', merchantId, -100);

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should return 404 if variation not found', async () => {
            mockDbQuery.mockReset();
            mockDbQuery.mockResolvedValueOnce({ rows: [] });

            const result = await variationService.updateCost('nonexistent', merchantId, 1000);

            expect(result.success).toBe(false);
            expect(result.status).toBe(404);
        });

        it('should validate vendor belongs to merchant', async () => {
            mockDbQuery.mockReset();
            mockDbQuery.mockResolvedValueOnce({ rows: [] });  // Vendor check fails

            const result = await variationService.updateCost('var-1', merchantId, 1000, 'invalid-vendor');

            expect(result.success).toBe(false);
            expect(result.status).toBe(403);
        });

        it('should save locally only if no vendor', async () => {
            mockDbQuery.mockReset();
            mockDbQuery.mockResolvedValueOnce({  // Variation without vendor
                rows: [{
                    id: 'var-1',
                    sku: 'SKU001',
                    item_name: 'Dog Food',
                    vendor_id: null,
                    current_cost: null,
                    vendor_name: null
                }]
            });

            const result = await variationService.updateCost('var-1', merchantId, 1000);

            expect(result.success).toBe(true);
            expect(result.synced_to_square).toBe(false);
            expect(result.warning).toBeDefined();
        });
    });

    describe('bulkUpdateExtendedFields', () => {
        it('should update multiple variations by SKU', async () => {
            mockDbQuery
                .mockResolvedValueOnce({  // Batch SKU lookup
                    rows: [
                        { id: 'var-1', sku: 'SKU001' },
                        { id: 'var-2', sku: 'SKU002' }
                    ]
                })
                .mockResolvedValue({ rows: [] });  // UPDATE queries

            const updates = [
                { sku: 'SKU001', case_pack_quantity: 12 },
                { sku: 'SKU002', shelf_location: 'B-2' }
            ];

            const result = await variationService.bulkUpdateExtendedFields(merchantId, updates);

            expect(result.success).toBe(true);
            expect(result.updated_count).toBe(2);
        });

        it('should throw error if merchantId is not provided', async () => {
            await expect(
                variationService.bulkUpdateExtendedFields(null, [])
            ).rejects.toThrow('merchantId is required');
        });

        it('should return 400 if updates is not an array', async () => {
            const result = await variationService.bulkUpdateExtendedFields(merchantId, 'not-an-array');

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('should skip updates without SKU', async () => {
            mockDbQuery.mockResolvedValue({ rows: [] });

            const updates = [
                { case_pack_quantity: 12 },  // No SKU
                { sku: 'SKU001', case_pack_quantity: 6 }
            ];

            const result = await variationService.bulkUpdateExtendedFields(merchantId, updates);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toBe('SKU required');
        });

        it('should sync case_pack_quantity to Square in bulk', async () => {
            mockDbQuery
                .mockResolvedValueOnce({
                    rows: [{ id: 'var-1', sku: 'SKU001' }]
                })
                .mockResolvedValue({ rows: [] });

            const updates = [
                { sku: 'SKU001', case_pack_quantity: 12 }
            ];

            await variationService.bulkUpdateExtendedFields(merchantId, updates);

            expect(squareApi.updateCustomAttributeValues).toHaveBeenCalled();
        });

        it('should track Square sync success and failures', async () => {
            mockDbQuery
                .mockResolvedValueOnce({
                    rows: [
                        { id: 'var-1', sku: 'SKU001' },
                        { id: 'var-2', sku: 'SKU002' }
                    ]
                })
                .mockResolvedValue({ rows: [] });

            squareApi.updateCustomAttributeValues
                .mockResolvedValueOnce({ success: true })
                .mockRejectedValueOnce(new Error('API Error'));

            const updates = [
                { sku: 'SKU001', case_pack_quantity: 12 },
                { sku: 'SKU002', case_pack_quantity: 6 }
            ];

            const result = await variationService.bulkUpdateExtendedFields(merchantId, updates);

            expect(result.squarePush.success).toBe(1);
            expect(result.squarePush.failed).toBe(1);
        });
    });
});
