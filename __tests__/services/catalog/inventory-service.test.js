/**
 * Tests for services/catalog/inventory-service.js
 *
 * Covers: getInventory, getLowStock, getDeletedItems, getExpirations,
 *         saveExpirations, markExpirationsReviewed, handleExpiredPull
 */

const db = require('../../../utils/database');

// Create mock fns we can reference in tests
const mockUpdateCustomAttributeValues = jest.fn().mockResolvedValue({ success: true });
const mockSetSquareInventoryCount = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../../services/square', () => ({
    updateCustomAttributeValues: mockUpdateCustomAttributeValues,
    setSquareInventoryCount: mockSetSquareInventoryCount,
}));

const mockCalculateDaysUntilExpiry = jest.fn().mockReturnValue(180);
const mockGetActiveTiers = jest.fn().mockResolvedValue([
    { id: 1, tier_code: 'OK', min_days_to_expiry: 121, max_days_to_expiry: null, discount_percent: 0 },
]);
const mockDetermineTier = jest.fn().mockReturnValue(
    { id: 1, tier_code: 'OK', min_days_to_expiry: 121, max_days_to_expiry: null }
);

jest.mock('../../../services/expiry', () => ({
    calculateDaysUntilExpiry: mockCalculateDaysUntilExpiry,
    getActiveTiers: mockGetActiveTiers,
    determineTier: mockDetermineTier,
}));

const mockBatchResolveImageUrls = jest.fn().mockResolvedValue(new Map());

jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: mockBatchResolveImageUrls,
}));

const {
    getInventory,
    getLowStock,
    getDeletedItems,
    getExpirations,
    saveExpirations,
    markExpirationsReviewed,
    handleExpiredPull,
} = require('../../../services/catalog/inventory-service');

const MERCHANT_ID = 1;

beforeEach(() => {
    jest.clearAllMocks();
});

// ==================== getInventory ====================
describe('getInventory', () => {
    it('throws when merchantId is missing', async () => {
        await expect(getInventory(null)).rejects.toThrow('merchantId is required');
        await expect(getInventory(undefined)).rejects.toThrow('merchantId is required');
        await expect(getInventory(0)).rejects.toThrow('merchantId is required');
    });

    it('returns inventory with count and resolves image URLs', async () => {
        const mockRows = [
            {
                variation_id: 'VAR1', quantity: 10, location_id: 'LOC1',
                item_name: 'Dog Food', variation_name: 'Large', sku: 'DF-L',
                images: '["IMG1"]', item_images: '["IMG2"]',
                daily_avg_quantity: 1.5, days_until_stockout: 6.7,
            },
            {
                variation_id: 'VAR2', quantity: 5, location_id: 'LOC1',
                item_name: 'Cat Food', variation_name: 'Small', sku: 'CF-S',
                images: '["IMG3"]', item_images: null,
                daily_avg_quantity: 0.5, days_until_stockout: 10,
            },
        ];
        db.query.mockResolvedValueOnce({ rows: mockRows });

        const imageMap = new Map();
        imageMap.set(0, ['https://img.example.com/img1.jpg', 'https://img.example.com/img2.jpg']);
        imageMap.set(1, ['https://img.example.com/img3.jpg']);
        mockBatchResolveImageUrls.mockResolvedValueOnce(imageMap);

        const result = await getInventory(MERCHANT_ID);

        expect(result.count).toBe(2);
        expect(result.inventory).toHaveLength(2);

        // Image URLs resolved
        expect(result.inventory[0].image_urls).toEqual([
            'https://img.example.com/img1.jpg',
            'https://img.example.com/img2.jpg',
        ]);
        expect(result.inventory[1].image_urls).toEqual(['https://img.example.com/img3.jpg']);

        // Raw image fields removed
        expect(result.inventory[0].images).toBeUndefined();
        expect(result.inventory[0].item_images).toBeUndefined();
        expect(result.inventory[1].images).toBeUndefined();
        expect(result.inventory[1].item_images).toBeUndefined();

        // merchant_id in query params
        expect(db.query.mock.calls[0][1]).toContain(MERCHANT_ID);
        // batchResolveImageUrls called with the rows
        expect(mockBatchResolveImageUrls).toHaveBeenCalledWith(mockRows, MERCHANT_ID);
    });

    it('applies location_id filter', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getInventory(MERCHANT_ID, { location_id: 'LOC_42' });

        const [query, params] = db.query.mock.calls[0];
        expect(params).toEqual([MERCHANT_ID, 'LOC_42']);
        expect(query).toContain('ic.location_id = $2');
    });

    it('applies low_stock filter as string "true"', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getInventory(MERCHANT_ID, { low_stock: 'true' });

        const [query] = db.query.mock.calls[0];
        expect(query).toContain('v.stock_alert_min IS NOT NULL');
        expect(query).toContain('ic.quantity < v.stock_alert_min');
    });

    it('applies low_stock filter as boolean true', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getInventory(MERCHANT_ID, { low_stock: true });

        const [query] = db.query.mock.calls[0];
        expect(query).toContain('ic.quantity < v.stock_alert_min');
    });

    it('returns empty array for image_urls when no images resolved', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ variation_id: 'VAR1', images: null, item_images: null }] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map()); // no entries

        const result = await getInventory(MERCHANT_ID);

        expect(result.inventory[0].image_urls).toEqual([]);
    });
});

// ==================== getLowStock ====================
describe('getLowStock', () => {
    it('throws when merchantId is missing', async () => {
        await expect(getLowStock(null)).rejects.toThrow('merchantId is required');
    });

    it('returns low stock items with resolved images', async () => {
        const mockRows = [
            {
                id: 'VAR1', sku: 'DF-L', item_name: 'Dog Food', variation_name: 'Large',
                current_stock: 2, stock_alert_min: 5, units_below_min: 3,
                location_name: 'Main Store', images: '["IMG1"]', item_images: null,
            },
        ];
        db.query.mockResolvedValueOnce({ rows: mockRows });

        const imageMap = new Map();
        imageMap.set(0, ['https://img.example.com/img1.jpg']);
        mockBatchResolveImageUrls.mockResolvedValueOnce(imageMap);

        const result = await getLowStock(MERCHANT_ID);

        expect(result.count).toBe(1);
        expect(result.low_stock_items).toHaveLength(1);
        expect(result.low_stock_items[0].image_urls).toEqual(['https://img.example.com/img1.jpg']);
        expect(result.low_stock_items[0].images).toBeUndefined();
        expect(result.low_stock_items[0].item_images).toBeUndefined();
        expect(db.query.mock.calls[0][1]).toEqual([MERCHANT_ID]);
    });

    it('handles empty results', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        const result = await getLowStock(MERCHANT_ID);

        expect(result.count).toBe(0);
        expect(result.low_stock_items).toEqual([]);
    });
});

// ==================== getDeletedItems ====================
describe('getDeletedItems', () => {
    it('throws when merchantId is missing', async () => {
        await expect(getDeletedItems(null)).rejects.toThrow('merchantId is required');
    });

    it('returns deleted items with default status=all', async () => {
        const mockRows = [
            { id: 'V1', item_name: 'Old Item', status: 'deleted', images: null, item_images: null },
            { id: 'V2', item_name: 'Archived Item', status: 'archived', images: null, item_images: null },
        ];
        db.query.mockResolvedValueOnce({ rows: mockRows });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        const result = await getDeletedItems(MERCHANT_ID);

        expect(result.count).toBe(2);
        expect(result.deleted_count).toBe(1);
        expect(result.archived_count).toBe(1);
        expect(result.deleted_items).toHaveLength(2);

        // Default status=all uses OR condition
        const [query] = db.query.mock.calls[0];
        expect(query).toContain('v.is_deleted = TRUE OR');
    });

    it('filters by status=deleted', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getDeletedItems(MERCHANT_ID, { status: 'deleted' });

        const [query] = db.query.mock.calls[0];
        expect(query).toContain('v.is_deleted = TRUE AND COALESCE(i.is_archived, FALSE) = FALSE');
    });

    it('filters by status=archived', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getDeletedItems(MERCHANT_ID, { status: 'archived' });

        const [query] = db.query.mock.calls[0];
        expect(query).toContain('COALESCE(i.is_archived, FALSE) = TRUE AND COALESCE(v.is_deleted, FALSE) = FALSE');
    });

    it('applies age_months filter with parameterized query', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getDeletedItems(MERCHANT_ID, { age_months: '6' });

        const [query, params] = db.query.mock.calls[0];
        expect(params).toEqual([MERCHANT_ID, 6]);
        expect(query).toContain(`|| ' months')::interval`);
    });

    it('ignores invalid age_months (NaN, negative, > 120)', async () => {
        for (const bad of ['abc', '-1', '121', '0']) {
            jest.clearAllMocks();
            db.query.mockResolvedValueOnce({ rows: [] });
            mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

            await getDeletedItems(MERCHANT_ID, { age_months: bad });

            const [, params] = db.query.mock.calls[0];
            // Only merchantId param, no age_months added
            expect(params).toEqual([MERCHANT_ID]);
        }
    });

    it('counts deleted and archived separately', async () => {
        const mockRows = [
            { id: 'V1', status: 'deleted', images: null, item_images: null },
            { id: 'V2', status: 'deleted', images: null, item_images: null },
            { id: 'V3', status: 'archived', images: null, item_images: null },
        ];
        db.query.mockResolvedValueOnce({ rows: mockRows });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        const result = await getDeletedItems(MERCHANT_ID);

        expect(result.count).toBe(3);
        expect(result.deleted_count).toBe(2);
        expect(result.archived_count).toBe(1);
    });
});

// ==================== getExpirations ====================
describe('getExpirations', () => {
    it('throws when merchantId is missing', async () => {
        await expect(getExpirations(null)).rejects.toThrow('merchantId is required');
    });

    it('returns all expirations with no filter', async () => {
        const mockRows = [
            {
                identifier: 'VAR1', name: 'Dog Food', variation: 'Large',
                expiration_date: '2026-06-01', does_not_expire: false,
                quantity: 10, images: null, item_images: null,
            },
        ];
        db.query.mockResolvedValueOnce({ rows: mockRows });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        const result = await getExpirations(MERCHANT_ID);

        expect(result.count).toBe(1);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].images).toBeUndefined();
        expect(db.query.mock.calls[0][1]).toEqual([MERCHANT_ID]);
    });

    it('filters by expiry=no-expiry (no date set and not marked never-expires)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getExpirations(MERCHANT_ID, { expiry: 'no-expiry' });

        const [query] = db.query.mock.calls[0];
        expect(query).toContain('ve.expiration_date IS NULL');
        expect(query).toContain('ve.does_not_expire IS NULL OR ve.does_not_expire = FALSE');
    });

    it('filters by expiry=never-expires', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getExpirations(MERCHANT_ID, { expiry: 'never-expires' });

        const [query] = db.query.mock.calls[0];
        expect(query).toContain('ve.does_not_expire = TRUE');
    });

    it('filters by expiry=review (90-120 days, not recently reviewed)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getExpirations(MERCHANT_ID, { expiry: 'review' });

        const [query] = db.query.mock.calls[0];
        expect(query).toContain("INTERVAL '90 days'");
        expect(query).toContain("INTERVAL '120 days'");
        expect(query).toContain("INTERVAL '30 days'");
    });

    it('filters by numeric expiry days', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getExpirations(MERCHANT_ID, { expiry: '30' });

        const [query, params] = db.query.mock.calls[0];
        expect(params).toEqual([MERCHANT_ID, 30]);
        expect(query).toContain("|| ' days')::interval");
        expect(query).toContain('ve.expiration_date >= NOW()');
    });

    it('ignores invalid numeric expiry (negative, > 3650)', async () => {
        for (const bad of ['-1', '3651', 'abc']) {
            jest.clearAllMocks();
            db.query.mockResolvedValueOnce({ rows: [] });
            mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

            await getExpirations(MERCHANT_ID, { expiry: bad });

            const [, params] = db.query.mock.calls[0];
            expect(params).toEqual([MERCHANT_ID]);
        }
    });

    it('applies category filter with ILIKE', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        mockBatchResolveImageUrls.mockResolvedValueOnce(new Map());

        await getExpirations(MERCHANT_ID, { category: 'Dog Food' });

        const [query, params] = db.query.mock.calls[0];
        expect(params).toEqual([MERCHANT_ID, '%Dog Food%']);
        expect(query).toContain('i.category_name ILIKE');
    });

    it('resolves image URLs and removes raw fields', async () => {
        const mockRows = [
            { identifier: 'VAR1', images: '["IMG1"]', item_images: '["IMG2"]' },
        ];
        db.query.mockResolvedValueOnce({ rows: mockRows });

        const imageMap = new Map();
        imageMap.set(0, ['https://img.example.com/resolved.jpg']);
        mockBatchResolveImageUrls.mockResolvedValueOnce(imageMap);

        const result = await getExpirations(MERCHANT_ID);

        expect(result.items[0].image_urls).toEqual(['https://img.example.com/resolved.jpg']);
        expect(result.items[0].images).toBeUndefined();
        expect(result.items[0].item_images).toBeUndefined();
    });
});

// ==================== saveExpirations ====================
describe('saveExpirations', () => {
    it('throws when merchantId is missing', async () => {
        await expect(saveExpirations(null, [])).rejects.toThrow('merchantId is required');
    });

    it('returns error when changes is not an array', async () => {
        const result = await saveExpirations(MERCHANT_ID, 'not-an-array');
        expect(result.success).toBe(false);
        expect(result.status).toBe(400);
    });

    it('saves expiration with date and pushes to Square', async () => {
        // variation check
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        // INSERT/UPSERT expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // existing discount status check
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1', expiration_date: '2026-09-01' },
        ]);

        expect(result.success).toBe(true);
        expect(result.message).toContain('1 expiration record');
        expect(result.squarePush.success).toBe(1);
        expect(result.squarePush.failed).toBe(0);

        // Verify Square push
        expect(mockUpdateCustomAttributeValues).toHaveBeenCalledWith(
            'VAR1',
            expect.objectContaining({
                expiration_date: { string_value: '2026-09-01' },
                does_not_expire: { boolean_value: false },
            }),
            { merchantId: MERCHANT_ID }
        );

        // Verify merchant_id in variation check
        expect(db.query.mock.calls[0][1]).toEqual(['VAR1', MERCHANT_ID]);
    });

    it('saves with does_not_expire=true and deletes discount status', async () => {
        // variation check
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        // INSERT/UPSERT expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // DELETE from variation_discount_status
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1', does_not_expire: true },
        ]);

        expect(result.success).toBe(true);
        expect(result.squarePush.success).toBe(1);

        // Verify does_not_expire pushed to Square as true
        expect(mockUpdateCustomAttributeValues).toHaveBeenCalledWith(
            'VAR1',
            expect.objectContaining({
                does_not_expire: { boolean_value: true },
            }),
            { merchantId: MERCHANT_ID }
        );

        // Verify DELETE query was called with merchant_id
        const deleteCall = db.query.mock.calls.find(c =>
            c[0].includes('DELETE FROM variation_discount_status')
        );
        expect(deleteCall).toBeTruthy();
        expect(deleteCall[1]).toContain(MERCHANT_ID);
    });

    it('skips entries with no variation_id', async () => {
        const result = await saveExpirations(MERCHANT_ID, [
            { expiration_date: '2026-09-01' }, // missing variation_id
        ]);

        expect(result.success).toBe(true);
        expect(result.message).toContain('0 expiration record');
        expect(db.query).not.toHaveBeenCalled();
    });

    it('skips variation not belonging to merchant', async () => {
        // variation check returns empty
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR_OTHER', expiration_date: '2026-09-01' },
        ]);

        expect(result.success).toBe(true);
        expect(result.message).toContain('0 expiration record');
        expect(mockUpdateCustomAttributeValues).not.toHaveBeenCalled();
    });

    it('handles Square push failure gracefully', async () => {
        // variation check
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        // INSERT/UPSERT expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // existing discount status check
        db.query.mockResolvedValueOnce({ rows: [] });

        mockUpdateCustomAttributeValues.mockRejectedValueOnce(new Error('Square API timeout'));

        const result = await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1', expiration_date: '2026-09-01' },
        ]);

        expect(result.success).toBe(true); // overall save still succeeds
        expect(result.squarePush.success).toBe(0);
        expect(result.squarePush.failed).toBe(1);
        expect(result.squarePush.errors[0]).toEqual({
            variation_id: 'VAR1',
            error: 'Square API timeout',
        });
    });

    it('records tier overrides when item had a non-OK discount tier', async () => {
        // variation check
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        // INSERT/UPSERT expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // existing discount status check — has AUTO25
        db.query.mockResolvedValueOnce({
            rows: [{ current_tier_id: 2, tier_code: 'AUTO25' }],
        });
        // UPDATE variation_discount_status (manual override)
        db.query.mockResolvedValueOnce({ rows: [] });
        // INSERT/UPDATE variation_discount_status (new tier)
        db.query.mockResolvedValueOnce({ rows: [] });

        mockDetermineTier.mockReturnValueOnce({
            id: 1, tier_code: 'OK', min_days_to_expiry: 121, max_days_to_expiry: null,
        });

        const result = await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1', expiration_date: '2027-01-01' },
        ]);

        expect(result.tierOverrides).toBeDefined();
        expect(result.tierOverrides).toHaveLength(1);
        expect(result.tierOverrides[0].variation_id).toBe('VAR1');
        expect(result.tierOverrides[0].previous_tier).toBe('AUTO25');
        expect(result.tierOverrides[0].calculated_tier).toBe('OK');
    });

    it('clears reviewed_at when tier changes to AUTO25 after successful Square push', async () => {
        // variation check
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        // INSERT/UPSERT expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // existing discount status — was OK
        db.query.mockResolvedValueOnce({
            rows: [{ current_tier_id: 1, tier_code: 'OK' }],
        });
        // INSERT/UPDATE variation_discount_status (new tier)
        db.query.mockResolvedValueOnce({ rows: [] });
        // Clear reviewed_at (after Square push)
        db.query.mockResolvedValueOnce({ rows: [] });

        mockCalculateDaysUntilExpiry.mockReturnValueOnce(30);
        mockDetermineTier.mockReturnValueOnce({
            id: 3, tier_code: 'AUTO25', min_days_to_expiry: 15, max_days_to_expiry: 60,
        });

        const result = await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1', expiration_date: '2026-04-15' },
        ]);

        expect(result.success).toBe(true);

        // Find the reviewed_at clear query
        const clearCall = db.query.mock.calls.find(c =>
            c[0].includes('reviewed_at = NULL') && c[0].includes('variation_expiration')
        );
        expect(clearCall).toBeTruthy();
        expect(clearCall[1]).toEqual(['VAR1', MERCHANT_ID]);
    });

    it('does NOT clear reviewed_at when tier is unchanged', async () => {
        // variation check
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        // INSERT/UPSERT expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // existing discount status — already AUTO25
        db.query.mockResolvedValueOnce({
            rows: [{ current_tier_id: 3, tier_code: 'AUTO25' }],
        });
        // INSERT/UPDATE variation_discount_status (same tier)
        db.query.mockResolvedValueOnce({ rows: [] });

        mockCalculateDaysUntilExpiry.mockReturnValueOnce(30);
        mockDetermineTier.mockReturnValueOnce({
            id: 3, tier_code: 'AUTO25', min_days_to_expiry: 15, max_days_to_expiry: 60,
        });

        await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1', expiration_date: '2026-04-15' },
        ]);

        // No reviewed_at clear query should appear
        const clearCall = db.query.mock.calls.find(c =>
            c[0].includes('reviewed_at = NULL') && c[0].includes('variation_expiration')
        );
        expect(clearCall).toBeUndefined();
    });

    it('does NOT clear reviewed_at when Square push fails', async () => {
        // variation check
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        // INSERT/UPSERT expiration
        db.query.mockResolvedValueOnce({ rows: [] });
        // existing discount status — was OK
        db.query.mockResolvedValueOnce({
            rows: [{ current_tier_id: 1, tier_code: 'OK' }],
        });
        // INSERT/UPDATE variation_discount_status (new tier)
        db.query.mockResolvedValueOnce({ rows: [] });

        mockCalculateDaysUntilExpiry.mockReturnValueOnce(30);
        mockDetermineTier.mockReturnValueOnce({
            id: 3, tier_code: 'AUTO25', min_days_to_expiry: 15, max_days_to_expiry: 60,
        });
        mockUpdateCustomAttributeValues.mockRejectedValueOnce(new Error('Square 400'));

        await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1', expiration_date: '2026-04-15' },
        ]);

        // No reviewed_at clear query should appear since Square push failed
        const clearCall = db.query.mock.calls.find(c =>
            c[0].includes('reviewed_at = NULL') && c[0].includes('variation_expiration')
        );
        expect(clearCall).toBeUndefined();
    });

    it('uses 2020-01-01 as fallback date when no date and not does_not_expire', async () => {
        // variation check
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        // INSERT/UPSERT expiration
        db.query.mockResolvedValueOnce({ rows: [] });

        await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1' }, // no date, no does_not_expire
        ]);

        // Check the upsert used 2020-01-01
        const upsertCall = db.query.mock.calls.find(c =>
            c[0].includes('INSERT INTO variation_expiration')
        );
        expect(upsertCall[1]).toContain('2020-01-01');

        // Square push also uses 2020-01-01
        expect(mockUpdateCustomAttributeValues).toHaveBeenCalledWith(
            'VAR1',
            expect.objectContaining({
                expiration_date: { string_value: '2020-01-01' },
            }),
            { merchantId: MERCHANT_ID }
        );
    });

    it('processes multiple changes and tracks counts', async () => {
        // First variation
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] }); // check
        db.query.mockResolvedValueOnce({ rows: [] }); // upsert
        db.query.mockResolvedValueOnce({ rows: [] }); // existing status

        // Second variation - not found
        db.query.mockResolvedValueOnce({ rows: [] }); // check fails

        // Third variation
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR3' }] }); // check
        db.query.mockResolvedValueOnce({ rows: [] }); // upsert
        db.query.mockResolvedValueOnce({ rows: [] }); // delete discount status

        const result = await saveExpirations(MERCHANT_ID, [
            { variation_id: 'VAR1', expiration_date: '2026-09-01' },
            { variation_id: 'VAR2', expiration_date: '2026-10-01' }, // not found
            { variation_id: 'VAR3', does_not_expire: true },
        ]);

        expect(result.success).toBe(true);
        expect(result.message).toContain('2 expiration record');
        // 2 Square pushes (VAR1 and VAR3)
        expect(mockUpdateCustomAttributeValues).toHaveBeenCalledTimes(2);
    });
});

// ==================== markExpirationsReviewed ====================
describe('markExpirationsReviewed', () => {
    it('throws when merchantId is missing', async () => {
        await expect(markExpirationsReviewed(null, ['VAR1']))
            .rejects.toThrow('merchantId is required');
    });

    it('returns error for empty array', async () => {
        const result = await markExpirationsReviewed(MERCHANT_ID, []);
        expect(result.success).toBe(false);
        expect(result.status).toBe(400);
    });

    it('returns error for non-array input', async () => {
        const result = await markExpirationsReviewed(MERCHANT_ID, 'VAR1');
        expect(result.success).toBe(false);
        expect(result.status).toBe(400);
    });

    it('marks valid variations as reviewed and pushes to Square', async () => {
        // batch verify variations
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }, { id: 'VAR2' }] });
        // batch upsert
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await markExpirationsReviewed(MERCHANT_ID, ['VAR1', 'VAR2'], 'Jane');

        expect(result.success).toBe(true);
        expect(result.reviewed_count).toBe(2);
        expect(result.squarePush.success).toBe(2);

        // Verify batch verify query uses ANY($1) and merchant_id
        expect(db.query.mock.calls[0][1]).toEqual([['VAR1', 'VAR2'], MERCHANT_ID]);

        // Square push for each valid variation
        expect(mockUpdateCustomAttributeValues).toHaveBeenCalledTimes(2);
        expect(mockUpdateCustomAttributeValues).toHaveBeenCalledWith(
            'VAR1',
            expect.objectContaining({
                expiry_reviewed_by: { string_value: 'Jane' },
            }),
            { merchantId: MERCHANT_ID }
        );
    });

    it('returns error when no valid variations found', async () => {
        // batch verify returns empty
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await markExpirationsReviewed(MERCHANT_ID, ['VAR_UNKNOWN']);

        expect(result.success).toBe(false);
        expect(result.error).toContain('No valid variations');
        expect(result.status).toBe(400);
        expect(mockUpdateCustomAttributeValues).not.toHaveBeenCalled();
    });

    it('handles Square push failure for individual variations', async () => {
        // batch verify
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }, { id: 'VAR2' }] });
        // batch upsert
        db.query.mockResolvedValueOnce({ rows: [] });

        mockUpdateCustomAttributeValues
            .mockResolvedValueOnce({ success: true }) // VAR1 succeeds
            .mockRejectedValueOnce(new Error('Square error')); // VAR2 fails

        const result = await markExpirationsReviewed(MERCHANT_ID, ['VAR1', 'VAR2']);

        expect(result.success).toBe(true); // DB update succeeded
        expect(result.reviewed_count).toBe(2);
        expect(result.squarePush.success).toBe(1);
        expect(result.squarePush.failed).toBe(1);
        expect(result.squarePush.errors).toHaveLength(1);
    });

    it('uses default reviewedBy when not provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await markExpirationsReviewed(MERCHANT_ID, ['VAR1']);

        // Default reviewedBy is 'User'
        expect(result.success).toBe(true);
        // Check the upsert query used 'User'
        expect(db.query.mock.calls[1][1]).toContain('User');
    });
});

// ==================== handleExpiredPull ====================
describe('handleExpiredPull', () => {
    it('throws when merchantId is missing', async () => {
        await expect(handleExpiredPull(null, { variation_id: 'VAR1', all_expired: true }))
            .rejects.toThrow('merchantId is required');
    });

    it('returns 400 when variation_id is missing', async () => {
        const result = await handleExpiredPull(MERCHANT_ID, { all_expired: true });
        expect(result.success).toBe(false);
        expect(result.status).toBe(400);
    });

    it('returns 404 when variation does not belong to merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await handleExpiredPull(MERCHANT_ID, {
            variation_id: 'VAR_OTHER',
            all_expired: true,
        });
        expect(result.success).toBe(false);
        expect(result.status).toBe(404);
    });

    describe('full pull (all_expired=true)', () => {
        it('zeros inventory at all locations with stock > 0', async () => {
            // variation check
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            // inventory counts
            db.query.mockResolvedValueOnce({
                rows: [
                    { catalog_object_id: 'VAR1', location_id: 'LOC1', quantity: 5 },
                    { catalog_object_id: 'VAR1', location_id: 'LOC2', quantity: 0 },
                ],
            });
            // local inventory update
            db.query.mockResolvedValueOnce({ rows: [] });
            // markExpirationsReviewed: batch verify
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            // markExpirationsReviewed: batch upsert
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: 'VAR1',
                all_expired: true,
                reviewed_by: 'Admin',
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe('full_pull');
            expect(result.squareInventory.success).toBe(1); // only LOC1 had stock

            // Square called to zero inventory only for LOC1 (quantity > 0)
            expect(mockSetSquareInventoryCount).toHaveBeenCalledTimes(1);
            expect(mockSetSquareInventoryCount).toHaveBeenCalledWith(
                'VAR1', 'LOC1', 0,
                expect.stringContaining('all units expired'),
                MERCHANT_ID
            );
        });

        it('skips Square call for locations with 0 stock', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            db.query.mockResolvedValueOnce({
                rows: [
                    { catalog_object_id: 'VAR1', location_id: 'LOC1', quantity: 0 },
                ],
            });
            db.query.mockResolvedValueOnce({ rows: [] }); // local update
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] }); // markReviewed verify
            db.query.mockResolvedValueOnce({ rows: [] }); // markReviewed upsert

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: 'VAR1',
                all_expired: true,
            });

            expect(result.success).toBe(true);
            expect(mockSetSquareInventoryCount).not.toHaveBeenCalled();
        });
    });

    describe('partial pull (all_expired=false)', () => {
        it('returns 400 when remaining_quantity is missing', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] }); // variation check
            db.query.mockResolvedValueOnce({ rows: [{ catalog_object_id: 'VAR1', location_id: 'LOC1', quantity: 5 }] }); // inventory

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: 'VAR1',
                all_expired: false,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('remaining_quantity is required');
            expect(result.status).toBe(400);
        });

        it('returns 400 when remaining_quantity is negative', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            db.query.mockResolvedValueOnce({ rows: [{ catalog_object_id: 'VAR1', location_id: 'LOC1', quantity: 5 }] });

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: 'VAR1',
                all_expired: false,
                remaining_quantity: -1,
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('returns 400 when new_expiry_date is missing for partial', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            db.query.mockResolvedValueOnce({ rows: [{ catalog_object_id: 'VAR1', location_id: 'LOC1', quantity: 5 }] });

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: 'VAR1',
                all_expired: false,
                remaining_quantity: 3,
                // missing new_expiry_date
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('new_expiry_date is required');
            expect(result.status).toBe(400);
        });

        it('updates inventory to remaining_quantity and saves new expiry', async () => {
            // variation check
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            // inventory counts
            db.query.mockResolvedValueOnce({
                rows: [
                    { catalog_object_id: 'VAR1', location_id: 'LOC1', quantity: 10 },
                ],
            });
            // local inventory update
            db.query.mockResolvedValueOnce({ rows: [] });

            // saveExpirations internal calls:
            // variation check for saveExpirations
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            // INSERT/UPSERT expiration
            db.query.mockResolvedValueOnce({ rows: [] });
            // existing discount status
            db.query.mockResolvedValueOnce({ rows: [] });

            // markExpirationsReviewed: batch verify
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            // markExpirationsReviewed: batch upsert
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: 'VAR1',
                all_expired: false,
                remaining_quantity: 3,
                new_expiry_date: '2026-08-01',
                reviewed_by: 'Staff',
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe('partial_pull');
            expect(result.message).toContain('3 units remain');
            expect(result.squareInventory.success).toBe(1);
            expect(result.expiryUpdate).toBeDefined();

            // Square inventory set to remaining quantity
            expect(mockSetSquareInventoryCount).toHaveBeenCalledWith(
                'VAR1', 'LOC1', 3,
                expect.stringContaining('partial pull'),
                MERCHANT_ID
            );
        });
    });
});
