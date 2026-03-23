/**
 * Tests for services/catalog/audit-service.js
 *
 * Covers:
 *   - location_mismatch SQL: boolean flag check (variation_present_at_all=TRUE, item=FALSE)
 *   - location_mismatch SQL: array-intersection check (both flags FALSE, variation has
 *     location IDs not in item's list)
 *   - variation_present_at_location_ids selected in CTE so array check has data
 *   - enableItemAtAllLocations: syncs local items table and resolves health rows after fix
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.resolve(__dirname, '../../services/catalog/audit-service.js'),
    'utf8'
);

// ============================================================================
// enableItemAtAllLocations — local DB sync after Square fix
// ============================================================================
describe('enableItemAtAllLocations — local DB sync', () => {
    let db;
    let enableItemAtAllLocations;

    beforeEach(() => {
        jest.resetModules();

        jest.mock('../../utils/database');
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        }));
        jest.mock('../../utils/image-utils', () => ({
            batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()),
        }));
        jest.mock('../../services/square', () => ({
            fixLocationMismatches: jest.fn(),
            fixInventoryAlerts: jest.fn(),
            enableItemAtAllLocations: jest.fn().mockResolvedValue({
                success: true,
                itemId: 'ITEM_1',
                itemName: 'Dog Food',
                variationCount: 2
            }),
        }));

        db = require('../../utils/database');
        db.query.mockResolvedValue({ rows: [] });

        ({ enableItemAtAllLocations } = require('../../services/catalog/audit-service'));
    });

    test('updates local items table to present_at_all_locations=true after Square succeeds', async () => {
        await enableItemAtAllLocations('ITEM_1', 5);

        const itemsUpdate = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE items')
        );
        expect(itemsUpdate).toBeDefined();
        expect(itemsUpdate[0]).toContain('present_at_all_locations = true');
        expect(itemsUpdate[0]).toContain("present_at_location_ids   = '[]'::jsonb");
        expect(itemsUpdate[0]).toContain("absent_at_location_ids    = '[]'::jsonb");
        expect(itemsUpdate[1]).toEqual(['ITEM_1', 5]);
    });

    test('updates local variations table to present_at_all_locations=true after Square succeeds', async () => {
        await enableItemAtAllLocations('ITEM_1', 5);

        const variationsUpdate = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE variations')
        );
        expect(variationsUpdate).toBeDefined();
        expect(variationsUpdate[0]).toContain('present_at_all_locations = true');
        expect(variationsUpdate[0]).toContain("present_at_location_ids  = '[]'::jsonb");
        expect(variationsUpdate[0]).toContain("absent_at_location_ids   = '[]'::jsonb");
        expect(variationsUpdate[1]).toEqual(['ITEM_1', 5]);
    });

    test('resolves open location_mismatch health rows for the item after Square succeeds', async () => {
        await enableItemAtAllLocations('ITEM_1', 5);

        const healthUpdate = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE catalog_location_health')
        );
        expect(healthUpdate).toBeDefined();
        expect(healthUpdate[0]).toContain("check_type   = 'location_mismatch'");
        expect(healthUpdate[0]).toContain('resolved_at = NOW()');
        expect(healthUpdate[0]).toContain("status       = 'mismatch'");
        expect(healthUpdate[1]).toEqual([5, 'ITEM_1']);
    });

    test('does not update local DB when Square call throws', async () => {
        const squareApi = require('../../services/square');
        squareApi.enableItemAtAllLocations.mockRejectedValue(new Error('item not found'));

        const result = await enableItemAtAllLocations('ITEM_GONE', 5);

        expect(result.success).toBe(false);
        // No UPDATE items or UPDATE catalog_location_health calls
        const updateCalls = db.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE')
        );
        expect(updateCalls).toHaveLength(0);
    });

    test('updates local DB even when Square skips upsert because already enabled', async () => {
        // Square diagnostics returns success without performing an upsert (idempotent path).
        // audit-service must still sync items, variations, and health rows.
        const squareApi = require('../../services/square');
        squareApi.enableItemAtAllLocations.mockResolvedValue({
            success: true,
            itemId: 'ITEM_1',
            itemName: 'Dog Food',
            variationCount: 2
        });

        await enableItemAtAllLocations('ITEM_1', 5);

        const itemsUpdate = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE items')
        );
        const variationsUpdate = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE variations')
        );
        const healthUpdate = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE catalog_location_health')
        );
        expect(itemsUpdate).toBeDefined();
        expect(variationsUpdate).toBeDefined();
        expect(healthUpdate).toBeDefined();
    });

    test('does not update local DB when Square verification fails', async () => {
        const squareApi = require('../../services/square');
        squareApi.enableItemAtAllLocations.mockRejectedValue(
            new Error('Verification failed: Square did not commit present_at_all_locations=true for item ITEM_1 (got: false)')
        );

        const result = await enableItemAtAllLocations('ITEM_1', 5);

        expect(result.success).toBe(false);
        const updateCalls = db.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE')
        );
        expect(updateCalls).toHaveLength(0);
    });

    test('returns success with itemName from Square result', async () => {
        const result = await enableItemAtAllLocations('ITEM_1', 5);

        expect(result.success).toBe(true);
        expect(result.itemName).toBe('Dog Food');
        expect(result.itemId).toBe('ITEM_1');
    });
});

// ============================================================================
// location_mismatch SQL structure
// ============================================================================
describe('audit-service.js — location_mismatch SQL', () => {
    test('CTE selects variation_present_at_location_ids from variations table', () => {
        expect(source).toContain('v.present_at_location_ids as variation_present_at_location_ids');
    });

    test('location_mismatch includes boolean flag check (variation all=TRUE, item all=FALSE)', () => {
        expect(source).toContain('variation_present_at_all = TRUE AND item_present_at_all = FALSE');
    });

    test('location_mismatch includes array-intersection check when both flags are FALSE', () => {
        expect(source).toContain('variation_present_at_all = FALSE');
        expect(source).toContain('item_present_at_all = FALSE');
        expect(source).toContain('variation_present_at_location_ids IS NOT NULL');
        expect(source).toContain('jsonb_array_length(variation_present_at_location_ids) > 0');
    });

    test('array-intersection uses JSONB containment operator to detect non-subset', () => {
        // @> checks that left operand contains all elements of right operand;
        // NOT (@>) detects variation IDs absent from the item's list
        expect(source).toContain(
            'NOT (COALESCE(item_present_at_location_ids, \'[]\'::jsonb) @> variation_present_at_location_ids)'
        );
    });
});
