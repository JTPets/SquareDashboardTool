/**
 * Tests for services/catalog/audit-service.js
 *
 * Covers:
 *   - location_mismatch SQL: boolean flag check (variation_present_at_all=TRUE, item=FALSE)
 *   - location_mismatch SQL: array-intersection check (both flags FALSE, variation has
 *     location IDs not in item's list)
 *   - variation_present_at_location_ids selected in CTE so array check has data
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.resolve(__dirname, '../../services/catalog/audit-service.js'),
    'utf8'
);

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
