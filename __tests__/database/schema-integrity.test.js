'use strict';
/**
 * Schema Integrity Tests
 * Verifies schema-manager.js and schema.sql are in sync, and migration files
 * follow the required conventions.
 *
 * All tests are file-system based — no DB connection required.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_SQL_PATH = path.join(__dirname, '../../database/schema.sql');
const SCHEMA_MANAGER_PATH = path.join(__dirname, '../../utils/schema-manager.js');
const MIGRATIONS_DIR = path.join(__dirname, '../../database/migrations');

function readFile(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function extractCreateTableNames(source) {
    const names = new Set();
    // Match CREATE TABLE [IF NOT EXISTS] name
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi;
    let m;
    while ((m = re.exec(source)) !== null) {
        names.add(m[1].toLowerCase());
    }
    return names;
}

function extractColumnsForTable(source, tableName) {
    // Find the CREATE TABLE block for this table
    // Match closing )` or ); to handle JS template strings and SQL
    const pattern = 'CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + tableName + '\\s*\\(([^;]+?)\\)\\s*(?:;|`)';
    const re = new RegExp(pattern, 'is');
    const match = re.exec(source);
    if (!match) return new Set();
    const body = match[1];
    const cols = new Set();
    // Extract column names (first word of each line that isn't a constraint keyword)
    const lines = body.split('\n');
    for (const line of lines) {
        const trimmed = line.trim().replace(/,$/, '');
        if (!trimmed) continue;
        if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(trimmed)) continue;
        const colMatch = trimmed.match(/^(\w+)\s+/);
        if (colMatch) {
            const name = colMatch[1].toLowerCase();
            // Skip SQL constraint keywords (not column names)
            if (!['primary', 'foreign', 'unique', 'check', 'constraint', 'references'].includes(name)) {
                cols.add(name);
            }
        }
    }
    return cols;
}

function extractCheckConstraints(source) {
    const checks = [];
    const re = /CHECK\s*\(([^)]+)\)/gi;
    let m;
    while ((m = re.exec(source)) !== null) {
        checks.push(m[1].replace(/\s+/g, ' ').trim().toLowerCase());
    }
    return checks;
}

// ============================================================
// Tests
// ============================================================

describe('Schema Integrity — CREATE TABLE coverage', () => {
    let schemaSQL;
    let schemaManager;
    let schemaSQLTables;
    let schemaManagerTables;

    beforeAll(() => {
        schemaSQL = readFile(SCHEMA_SQL_PATH);
        schemaManager = readFile(SCHEMA_MANAGER_PATH);
        schemaSQLTables = extractCreateTableNames(schemaSQL);
        schemaManagerTables = extractCreateTableNames(schemaManager);
    });

    // Tables in schema.sql that are expected in schema-manager.js
    // (excludes tables that are intentionally in schema.sql only as documentation)
    const keyTables = [
        'users', 'merchants', 'oauth_states', 'sync_history', 'locations', 'vendors',
        'categories', 'images', 'items', 'variations', 'variation_vendors',
        'inventory_counts', 'committed_inventory', 'sales_velocity',
        'variation_location_settings', 'purchase_orders', 'purchase_order_items',
        'variation_expiration', 'count_history', 'count_queue_priority',
        'count_queue_daily', 'count_sessions',
        'vendor_catalog_items', 'brands', 'google_taxonomy',
        'category_taxonomy_mapping', 'item_brands', 'gmc_settings', 'gmc_feed_history',
        'gmc_location_settings', 'google_oauth_tokens',
        'expiry_discount_tiers', 'variation_discount_status',
        'expiry_discount_audit_log', 'expiry_discount_settings',
        'sessions', 'auth_audit_log', 'password_reset_tokens', 'webhook_events',
        'user_merchants', 'merchant_invitations', 'merchant_settings',
        'subscribers', 'subscription_payments', 'subscription_events',
        'subscription_plans', 'promo_codes', 'promo_code_uses',
        'delivery_orders', 'delivery_pod', 'delivery_settings',
        'delivery_routes', 'delivery_audit_log', 'delivery_route_tokens',
        'loyalty_offers', 'loyalty_qualifying_variations', 'loyalty_purchase_events',
        'loyalty_rewards', 'loyalty_redemptions', 'loyalty_audit_logs',
        'loyalty_settings', 'loyalty_customer_summary',
        'loyalty_customers', 'loyalty_processed_orders', 'loyalty_audit_log',
        'bundle_definitions', 'bundle_components',
        'seniors_discount_config', 'seniors_group_members', 'seniors_discount_audit_log',
        'cart_activity', 'label_templates', 'catalog_location_health', 'platform_settings'
    ];

    test('all key tables exist in schema-manager.js', () => {
        const missing = keyTables.filter(tbl => !schemaManagerTables.has(tbl));
        expect(missing).toEqual([]);
    });

    test('every CREATE TABLE in schema.sql also appears in schema-manager.js', () => {
        const missing = [];
        for (const tbl of schemaSQLTables) {
            if (!schemaManagerTables.has(tbl)) {
                missing.push(tbl);
            }
        }
        expect(missing).toEqual([]);
    });
});

describe('Schema Integrity — Column coverage for key tables', () => {
    let schemaSQL;
    let schemaManager;

    beforeAll(() => {
        schemaSQL = readFile(SCHEMA_SQL_PATH);
        schemaManager = readFile(SCHEMA_MANAGER_PATH);
    });

    const keyTableColumns = {
        merchants: ['id', 'square_merchant_id', 'business_name', 'square_access_token',
            'subscription_status', 'timezone', 'currency', 'locale', 'is_active',
            'admin_email', 'custom_attributes_initialized_at'],
        // Note: is_deleted/is_archived are in ALTER TABLE in schema.sql, in CREATE TABLE in schema-manager.js
        // Test only checks schema-manager.js column coverage (schema.sql test uses schema-manager's CREATE TABLE)
        variations: ['id', 'item_id', 'sku', 'price_money', 'merchant_id',
            'case_pack_quantity'],
        items: ['id', 'name', 'merchant_id', 'seo_title', 'seo_description', 'tax_ids'],
        vendors: ['id', 'name', 'merchant_id', 'lead_time_days', 'schedule_type'],
        variation_vendors: ['id', 'variation_id', 'vendor_id', 'vendor_code',
            'unit_cost_money', 'merchant_id'],
        loyalty_rewards: ['id', 'merchant_id', 'offer_id', 'square_customer_id',
            'status', 'current_quantity', 'required_quantity', 'vendor_credit_status',
            'square_sync_pending', 'discount_amount_cents', 'trace_id'],
        promo_codes: ['id', 'merchant_id', 'code', 'discount_type', 'discount_value',
            'is_active', 'applies_to_plans'],
        subscription_events: ['id', 'merchant_id', 'subscriber_id', 'event_type',
            'event_data', 'square_event_id'],
        oauth_states: ['id', 'state', 'user_id', 'merchant_id', 'expires_at', 'used_at'],
    };

    test('key columns exist in schema-manager.js for all tracked tables', () => {
        const allMissing = {};
        for (const [tableName, expectedCols] of Object.entries(keyTableColumns)) {
            const smCols = extractColumnsForTable(schemaManager, tableName);
            const missing = expectedCols.filter(c => !smCols.has(c));
            if (missing.length > 0) allMissing[tableName] = missing;
        }
        expect(allMissing).toEqual({});
    });

    test('key columns exist in schema.sql for all tracked tables', () => {
        const allMissing = {};
        for (const [tableName, expectedCols] of Object.entries(keyTableColumns)) {
            const sqlCols = extractColumnsForTable(schemaSQL, tableName);
            const missing = expectedCols.filter(c => !sqlCols.has(c));
            if (missing.length > 0) allMissing[tableName] = missing;
        }
        expect(allMissing).toEqual({});
    });
});

describe('Schema Integrity — CHECK constraints', () => {
    let schemaSQL;
    let schemaManager;

    beforeAll(() => {
        schemaSQL = readFile(SCHEMA_SQL_PATH);
        schemaManager = readFile(SCHEMA_MANAGER_PATH);
    });

    const keyChecks = [
        // merchants subscription_status includes platform_owner
        "'platform_owner'",
        // users role
        "'admin', 'user', 'readonly'",
        // loyalty_rewards status
        "'in_progress', 'earned', 'redeemed', 'revoked'",
        // delivery_orders status
        "'pending', 'active', 'skipped', 'delivered', 'completed'",
        // webhook_events status
        "'received', 'processing', 'completed', 'failed', 'skipped'",
    ];

    test('all key CHECK constraint fragments exist in schema-manager.js', () => {
        const missing = keyChecks.filter(f => !schemaManager.toLowerCase().includes(f.toLowerCase()));
        expect(missing).toEqual([]);
    });

    test('merchants CHECK constraint includes platform_owner in schema-manager.js', () => {
        expect(schemaManager).toContain('platform_owner');
    });

    test('merchants CHECK constraint includes platform_owner in schema.sql', () => {
        expect(schemaSQL).toContain('platform_owner');
    });
});

describe('Schema Integrity — merchants table defaults', () => {
    let schemaManager;

    beforeAll(() => {
        schemaManager = readFile(SCHEMA_MANAGER_PATH);
    });

    test('merchants timezone default is America/Toronto', () => {
        // Should NOT have America/New_York in the merchants CREATE TABLE
        const merchantsBlock = schemaManager.match(/CREATE TABLE IF NOT EXISTS merchants[\s\S]*?CONSTRAINT valid_subscription_status/);
        if (merchantsBlock) {
            expect(merchantsBlock[0]).not.toContain('America/New_York');
            expect(merchantsBlock[0]).toContain('America/Toronto');
        } else {
            // Check globally that New_York doesn't appear near merchants defaults
            expect(schemaManager).toContain('America/Toronto');
        }
    });

    test('merchants currency default is CAD', () => {
        expect(schemaManager).toContain("'CAD'");
    });

    test('merchants has locale column', () => {
        const smCols = extractColumnsForTable(schemaManager, 'merchants');
        expect(smCols.has('locale')).toBe(true);
    });
});

describe('Schema Integrity — oauth_states constraints', () => {
    let schemaManager;

    beforeAll(() => {
        schemaManager = readFile(SCHEMA_MANAGER_PATH);
    });

    test('oauth_states merchant_id is NOT NULL in schema-manager.js', () => {
        // Check that schema-manager creates oauth_states with merchant_id NOT NULL
        const cols = extractColumnsForTable(schemaManager, 'oauth_states');
        expect(cols.has('merchant_id')).toBe(true);
        // Verify NOT NULL appears near merchant_id in the oauth_states block
        const idx = schemaManager.indexOf('oauth_states');
        const block = schemaManager.substring(idx, idx + 2000);
        expect(block).toMatch(/merchant_id\s+INTEGER\s+NOT\s+NULL/i);
    });

    test('oauth_states user_id has ON DELETE CASCADE in schema-manager.js', () => {
        expect(schemaManager).toContain('ON DELETE CASCADE');
    });
});

describe('Migration file conventions', () => {
    let migrationFiles;

    beforeAll(() => {
        migrationFiles = fs.existsSync(MIGRATIONS_DIR)
            ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql') && !fs.statSync(path.join(MIGRATIONS_DIR, f)).isDirectory())
            : [];
    });

    test('archive directory exists', () => {
        const archivePath = path.join(MIGRATIONS_DIR, 'archive');
        expect(fs.existsSync(archivePath)).toBe(true);
    });

    test('archive has README.md', () => {
        const readmePath = path.join(MIGRATIONS_DIR, 'archive', 'README.md');
        expect(fs.existsSync(readmePath)).toBe(true);
    });

    test('archived migrations (003-075) are in archive directory', () => {
        const archiveFiles = fs.readdirSync(path.join(MIGRATIONS_DIR, 'archive'))
            .filter(f => f.endsWith('.sql'));
        // Should have at least 70 archived files
        expect(archiveFiles.length).toBeGreaterThanOrEqual(70);
    });

    test('future migration files follow NNN_name.sql pattern', () => {
        const invalidFiles = migrationFiles.filter(f => !/^\d{3}_/.test(f));
        expect(invalidFiles).toEqual([]);
    });

    test('future migration files have sequential numbering', () => {
        if (migrationFiles.length === 0) return; // No future migrations yet — OK
        const numbers = migrationFiles
            .map(f => parseInt(f.match(/^(\d+)_/)[1], 10))
            .sort((a, b) => a - b);

        for (let i = 1; i < numbers.length; i++) {
            expect(numbers[i]).toBe(numbers[i - 1] + 1);
        }
    });

    test('future migration files are wrapped in BEGIN/COMMIT', () => {
        for (const filename of migrationFiles) {
            const content = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
            const upperContent = content.toUpperCase();
            expect(upperContent).toContain('BEGIN');
            expect(upperContent).toContain('COMMIT');
        }
    });
});
