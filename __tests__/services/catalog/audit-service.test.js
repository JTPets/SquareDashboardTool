/**
 * Tests for services/catalog/audit-service.js
 *
 * Covers: getCatalogAudit — location_mismatch SQL condition coverage,
 *         stat aggregation, and issue labelling.
 *
 * The SQL is built as a string and sent to PostgreSQL; tests verify:
 *   1. The query string contains each required condition (including the new
 *      "item=TRUE, variation=FALSE" case added to fix the 1 vs 0 discrepancy).
 *   2. The service correctly aggregates location_mismatch from mock DB rows.
 */

const db = require('../../../utils/database');

jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../../../services/square', () => ({
    enableItemAtAllLocations: jest.fn(),
    fixLocationMismatches: jest.fn(),
}));

const { getCatalogAudit } = require('../../../services/catalog/audit-service');

const MERCHANT_ID = 1;

// Helper: build a minimal row as PostgreSQL would return it from the audit query.
// The SQL computes all boolean flags server-side; in tests we supply them directly
// via mock DB rows.
function makeRow(overrides = {}) {
    return {
        variation_id: 'VAR_1',
        item_id: 'ITEM_1',
        item_name: 'Test Item',
        variation_name: 'Default',
        sku: 'SKU-1',
        upc: null,
        price_money: { amount: 1000, currency: 'CAD' },
        currency: 'CAD',
        description: 'A description',
        category_id: 'CAT_1',
        category_name: 'Test Category',
        product_type: 'REGULAR',
        taxable: true,
        tax_ids: ['TAX_1'],
        track_inventory: true,
        inventory_alert_type: 'LOW_QUANTITY',
        inventory_alert_threshold: 5,
        stock_alert_min: 5,
        visibility: 'PRIVATE',
        available_online: true,
        available_for_pickup: true,
        seo_title: 'Test SEO',
        seo_description: 'Test SEO desc',
        variation_images: null,
        item_images: null,
        vendor_count: 1,
        unit_cost_cents: 500,
        // Audit boolean flags (computed by SQL; provided here by mock)
        missing_category: false,
        not_taxable: false,
        missing_price: false,
        missing_description: false,
        missing_item_image: false,
        missing_variation_image: false,
        missing_sku: false,
        missing_upc: false,
        stock_tracking_off: false,
        inventory_alerts_off: false,
        no_reorder_threshold: false,
        missing_vendor: false,
        missing_cost: false,
        missing_seo_title: false,
        missing_seo_description: false,
        no_tax_ids: false,
        location_mismatch: false,
        any_channel_off: false,
        pos_disabled: false,
        online_disabled: false,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('getCatalogAudit', () => {
    it('throws when merchantId is missing', async () => {
        await expect(getCatalogAudit(null)).rejects.toThrow('merchantId is required');
        await expect(getCatalogAudit(undefined)).rejects.toThrow('merchantId is required');
    });

    // =========================================================================
    // location_mismatch SQL condition — all three cases must be present
    // =========================================================================
    describe('location_mismatch SQL condition', () => {
        beforeEach(() => {
            db.query.mockResolvedValue({ rows: [] });
        });

        it('contains condition for variation=TRUE item=FALSE (variation too permissive)', async () => {
            await getCatalogAudit(MERCHANT_ID);
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('variation_present_at_all = TRUE AND item_present_at_all = FALSE');
        });

        it('contains condition for item=TRUE variation=FALSE (variation too restrictive — bug fix)', async () => {
            // This was the missing case: item at all locations but variation still restricted.
            // Square rejects writes for this item (cost updates fail with ITEM_AT_LOCATION error)
            // yet the old query reported 0 mismatches because only the inverse was checked.
            await getCatalogAudit(MERCHANT_ID);
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('item_present_at_all = TRUE AND variation_present_at_all = FALSE');
        });

        it('contains condition for location ID set mismatch when both flags are FALSE', async () => {
            await getCatalogAudit(MERCHANT_ID);
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('variation_present_at_all = FALSE');
            expect(sql).toContain('item_present_at_all = FALSE');
            expect(sql).toContain('variation_present_at_location_ids');
        });
    });

    // =========================================================================
    // Stat aggregation
    // =========================================================================
    describe('stats.location_mismatch count', () => {
        it('returns 0 when no rows have location_mismatch', async () => {
            db.query.mockResolvedValueOnce({ rows: [makeRow()] });
            const result = await getCatalogAudit(MERCHANT_ID);
            expect(result.stats.location_mismatch).toBe(0);
        });

        it('counts all rows where location_mismatch is true', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    makeRow({ location_mismatch: true }),
                    makeRow({ variation_id: 'VAR_2', location_mismatch: false }),
                    makeRow({ variation_id: 'VAR_3', location_mismatch: true }),
                ],
            });
            const result = await getCatalogAudit(MERCHANT_ID);
            expect(result.stats.location_mismatch).toBe(2);
        });

        it('includes location_mismatch rows in items_with_issues count', async () => {
            db.query.mockResolvedValueOnce({
                rows: [makeRow({ location_mismatch: true })],
            });
            const result = await getCatalogAudit(MERCHANT_ID);
            expect(result.stats.items_with_issues).toBe(1);
        });
    });

    // =========================================================================
    // Issue label on returned items
    // =========================================================================
    describe('location_mismatch issue label', () => {
        it('adds "Location Mismatch" to issues and increments issue_count', async () => {
            db.query.mockResolvedValueOnce({ rows: [makeRow({ location_mismatch: true })] });
            const result = await getCatalogAudit(MERCHANT_ID);
            expect(result.items[0].issues).toContain('Location Mismatch');
            expect(result.items[0].issue_count).toBeGreaterThanOrEqual(1);
        });

        it('does not add "Location Mismatch" when flag is false', async () => {
            db.query.mockResolvedValueOnce({ rows: [makeRow({ location_mismatch: false })] });
            const result = await getCatalogAudit(MERCHANT_ID);
            expect(result.items[0].issues).not.toContain('Location Mismatch');
        });
    });
});
