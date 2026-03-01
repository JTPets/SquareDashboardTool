/**
 * Tests for handleExpiredPull — BACKLOG-37 partial-expiry workflow
 */

const db = require('../../../utils/database');

// Create mock fns we can reference in tests
const mockSetSquareInventoryCount = jest.fn().mockResolvedValue({ success: true });
const mockUpdateCustomAttributeValues = jest.fn().mockResolvedValue({ success: true });

// Mock square-api before any module loads it
jest.mock('../../../utils/square-api', () => ({
    setSquareInventoryCount: mockSetSquareInventoryCount,
    updateCustomAttributeValues: mockUpdateCustomAttributeValues,
}));

// Mock expiry-discount (used by saveExpirations internally)
jest.mock('../../../utils/expiry-discount', () => ({
    calculateDaysUntilExpiry: jest.fn().mockReturnValue(180),
    getActiveTiers: jest.fn().mockResolvedValue([
        { id: 1, tier_code: 'OK', min_days_to_expiry: 121, max_days_to_expiry: null, discount_percent: 0 },
    ]),
    determineTier: jest.fn().mockReturnValue({ id: 1, tier_code: 'OK', min_days_to_expiry: 121, max_days_to_expiry: null }),
}));

jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()),
}));

const { handleExpiredPull } = require('../../../services/catalog/inventory-service');

const MERCHANT_ID = 1;
const VARIATION_ID = 'VAR_ABC123';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('handleExpiredPull', () => {
    describe('input validation', () => {
        it('throws when merchantId is missing', async () => {
            await expect(handleExpiredPull(null, { variation_id: VARIATION_ID, all_expired: true }))
                .rejects.toThrow('merchantId is required');
        });

        it('returns 400 when variation_id is missing', async () => {
            const result = await handleExpiredPull(MERCHANT_ID, { all_expired: true });
            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
        });

        it('returns 404 when variation does not belong to merchant', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // variation check
            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: VARIATION_ID,
                all_expired: true,
            });
            expect(result.success).toBe(false);
            expect(result.status).toBe(404);
        });
    });

    describe('full pull (all_expired = true)', () => {
        beforeEach(() => {
            // variation check
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
            // inventory counts at locations
            db.query.mockResolvedValueOnce({
                rows: [
                    { catalog_object_id: VARIATION_ID, location_id: 'LOC_1', quantity: 3 },
                    { catalog_object_id: VARIATION_ID, location_id: 'LOC_2', quantity: 0 },
                ],
            });
        });

        it('zeros inventory at all locations with stock > 0', async () => {
            // local inventory update
            db.query.mockResolvedValueOnce({ rows: [] });
            // markExpirationsReviewed: validVariations check
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
            // markExpirationsReviewed: upsert
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: VARIATION_ID,
                all_expired: true,
                reviewed_by: 'Test User',
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe('full_pull');
            // Should call setSquareInventoryCount only for LOC_1 (qty > 0)
            expect(mockSetSquareInventoryCount).toHaveBeenCalledTimes(1);
            expect(mockSetSquareInventoryCount).toHaveBeenCalledWith(
                VARIATION_ID, 'LOC_1', 0,
                expect.any(String),
                MERCHANT_ID
            );
        });

        it('returns success even when no locations have stock', async () => {
            // Override: both locations have 0
            db.query.mockReset();
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] }); // variation check
            db.query.mockResolvedValueOnce({
                rows: [{ catalog_object_id: VARIATION_ID, location_id: 'LOC_1', quantity: 0 }],
            }); // inventory
            db.query.mockResolvedValueOnce({ rows: [] }); // local update
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] }); // markReviewed validate
            db.query.mockResolvedValueOnce({ rows: [] }); // markReviewed upsert

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: VARIATION_ID,
                all_expired: true,
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe('full_pull');
            expect(mockSetSquareInventoryCount).not.toHaveBeenCalled();
        });

        it('reports Square API failures without crashing', async () => {
            mockSetSquareInventoryCount.mockRejectedValueOnce(new Error('Square timeout'));
            db.query.mockResolvedValueOnce({ rows: [] }); // local update
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] }); // markReviewed validate
            db.query.mockResolvedValueOnce({ rows: [] }); // markReviewed upsert

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: VARIATION_ID,
                all_expired: true,
            });

            expect(result.success).toBe(true);
            expect(result.squareInventory.failed).toBe(1);
            expect(result.squareInventory.errors[0].error).toBe('Square timeout');
        });
    });

    describe('partial pull (all_expired = false)', () => {
        beforeEach(() => {
            // variation check
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
            // inventory counts
            db.query.mockResolvedValueOnce({
                rows: [
                    { catalog_object_id: VARIATION_ID, location_id: 'LOC_1', quantity: 5 },
                ],
            });
        });

        it('returns 400 when remaining_quantity is missing', async () => {
            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: VARIATION_ID,
                all_expired: false,
                new_expiry_date: '2026-12-15',
            });
            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
            expect(result.error).toMatch(/remaining_quantity/);
        });

        it('returns 400 when new_expiry_date is missing', async () => {
            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: VARIATION_ID,
                all_expired: false,
                remaining_quantity: 3,
            });
            expect(result.success).toBe(false);
            expect(result.status).toBe(400);
            expect(result.error).toMatch(/new_expiry_date/);
        });

        it('updates inventory to remaining quantity and sets new expiry', async () => {
            // local inventory update
            db.query.mockResolvedValueOnce({ rows: [] });
            // saveExpirations: variation check
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
            // saveExpirations: upsert variation_expiration
            db.query.mockResolvedValueOnce({ rows: [] });
            // saveExpirations: existing status check
            db.query.mockResolvedValueOnce({ rows: [] });
            // saveExpirations: update discount status
            db.query.mockResolvedValueOnce({ rows: [] });
            // markExpirationsReviewed: validVariations check
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] });
            // markExpirationsReviewed: upsert
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: VARIATION_ID,
                all_expired: false,
                remaining_quantity: 3,
                new_expiry_date: '2026-12-15',
                reviewed_by: 'Test User',
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe('partial_pull');
            expect(mockSetSquareInventoryCount).toHaveBeenCalledWith(
                VARIATION_ID, 'LOC_1', 3,
                expect.any(String),
                MERCHANT_ID
            );
        });

        it('accepts remaining_quantity of 0', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // local update
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] }); // saveExp: var check
            db.query.mockResolvedValueOnce({ rows: [] }); // saveExp: upsert
            db.query.mockResolvedValueOnce({ rows: [] }); // saveExp: existing status
            db.query.mockResolvedValueOnce({ rows: [] }); // saveExp: update discount
            db.query.mockResolvedValueOnce({ rows: [{ id: VARIATION_ID }] }); // markReviewed validate
            db.query.mockResolvedValueOnce({ rows: [] }); // markReviewed upsert

            const result = await handleExpiredPull(MERCHANT_ID, {
                variation_id: VARIATION_ID,
                all_expired: false,
                remaining_quantity: 0,
                new_expiry_date: '2026-12-15',
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe('partial_pull');
        });
    });
});
