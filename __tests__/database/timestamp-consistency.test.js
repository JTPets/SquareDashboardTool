/**
 * Tests for DB-7: TIMESTAMP to TIMESTAMPTZ consistency
 * Verifies no bare TIMESTAMP columns remain in schema definitions.
 */

const fs = require('fs');
const path = require('path');

describe('DB-7: TIMESTAMP to TIMESTAMPTZ consistency', () => {
    let schemaContent;
    let schemaManagerContent;

    beforeAll(() => {
        schemaContent = fs.readFileSync(
            path.join(__dirname, '..', '..', 'database', 'schema.sql'),
            'utf8'
        );
        schemaManagerContent = fs.readFileSync(
            path.join(__dirname, '..', '..', 'utils', 'schema-manager.js'),
            'utf8'
        );
    });

    test('schema.sql has no bare TIMESTAMP column definitions', () => {
        const lines = schemaContent.split('\n');
        const bareTimestampLines = lines.filter((line, i) => {
            // Skip comments and DROP statements
            if (line.trim().startsWith('--') || line.includes('DROP TABLE')) {
                return false;
            }
            // Match bare TIMESTAMP not followed by TZ
            return /\bTIMESTAMP\b/.test(line) && !/TIMESTAMPTZ/.test(line);
        });

        if (bareTimestampLines.length > 0) {
            fail(
                `Found ${bareTimestampLines.length} bare TIMESTAMP column(s) in schema.sql:\n` +
                bareTimestampLines.map(l => `  ${l.trim()}`).join('\n')
            );
        }
    });

    test('schema-manager.js has no bare TIMESTAMP column definitions', () => {
        const lines = schemaManagerContent.split('\n');
        const bareTimestampLines = lines.filter((line, i) => {
            if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
                return false;
            }
            return /\bTIMESTAMP\b/.test(line) && !/TIMESTAMPTZ/.test(line);
        });

        if (bareTimestampLines.length > 0) {
            fail(
                `Found ${bareTimestampLines.length} bare TIMESTAMP column(s) in schema-manager.js:\n` +
                bareTimestampLines.map(l => `  ${l.trim()}`).join('\n')
            );
        }
    });

    test('schema.sql uses NOW() instead of CURRENT_TIMESTAMP for defaults', () => {
        const lines = schemaContent.split('\n');
        const currentTimestampLines = lines.filter((line) => {
            if (line.trim().startsWith('--') || line.includes('DROP TABLE')) {
                return false;
            }
            return /CURRENT_TIMESTAMP/.test(line);
        });

        if (currentTimestampLines.length > 0) {
            fail(
                `Found ${currentTimestampLines.length} CURRENT_TIMESTAMP usage(s) — use NOW() instead:\n` +
                currentTimestampLines.map(l => `  ${l.trim()}`).join('\n')
            );
        }
    });

    test('migration 073 exists and is wrapped in BEGIN/COMMIT', () => {
        const migrationPath = path.join(
            __dirname, '..', '..', 'database', 'migrations',
            '073_timestamp_to_timestamptz.sql'
        );
        const migration = fs.readFileSync(migrationPath, 'utf8');

        expect(migration).toContain('BEGIN;');
        expect(migration).toContain('COMMIT;');
        expect(migration).toContain('TYPE TIMESTAMPTZ');
    });

    test('migration 073 covers all 31 affected tables', () => {
        const migrationPath = path.join(
            __dirname, '..', '..', 'database', 'migrations',
            '073_timestamp_to_timestamptz.sql'
        );
        const migration = fs.readFileSync(migrationPath, 'utf8');

        const expectedTables = [
            'sync_history', 'locations', 'vendors', 'categories', 'images',
            'items', 'variations', 'variation_vendors', 'inventory_counts',
            'sales_velocity', 'variation_location_settings', 'purchase_orders',
            'purchase_order_items', 'count_history', 'count_queue_priority',
            'count_queue_daily', 'count_sessions', 'vendor_catalog_items',
            'brands', 'google_taxonomy', 'category_taxonomy_mapping',
            'item_brands', 'gmc_settings', 'gmc_feed_history', 'promo_codes',
            'subscribers', 'subscription_payments', 'subscription_events',
            'subscription_plans', 'promo_code_uses', 'loyalty_customers',
        ];

        for (const table of expectedTables) {
            expect(migration).toContain(`ALTER TABLE ${table}`);
        }
    });
});
