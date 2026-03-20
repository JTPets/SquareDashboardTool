/**
 * Tests for CRIT-2/CRIT-4: Schema-level tenant isolation on subscription tables
 * Verifies merchant_id columns exist in schema definitions and migration.
 */

const fs = require('fs');
const path = require('path');

describe('CRIT-2/CRIT-4: Subscription table tenant isolation schema', () => {
    let schemaContent;
    let migrationContent;
    let schemaManagerContent;

    beforeAll(() => {
        schemaContent = fs.readFileSync(
            path.join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8'
        );
        migrationContent = fs.readFileSync(
            path.join(__dirname, '..', '..', 'database', 'migrations', 'archive',
                '074_add_merchant_id_to_subscription_tables.sql'), 'utf8'
        );
        schemaManagerContent = fs.readFileSync(
            path.join(__dirname, '..', '..', 'utils', 'schema-manager.js'), 'utf8'
        );
    });

    describe('schema.sql table definitions', () => {
        const tables = ['promo_codes', 'subscription_payments', 'subscription_events', 'subscription_plans'];

        test.each(tables)('%s has merchant_id NOT NULL', (table) => {
            // Extract the CREATE TABLE block
            const regex = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\([^;]+\\);`, 's');
            const match = schemaContent.match(regex);
            expect(match).not.toBeNull();
            expect(match[0]).toContain('merchant_id INTEGER NOT NULL REFERENCES merchants(id)');
        });

        test('platform_settings has nullable merchant_id', () => {
            const regex = /CREATE TABLE IF NOT EXISTS platform_settings\s*\([^;]+\);/s;
            const match = schemaContent.match(regex);
            expect(match).not.toBeNull();
            expect(match[0]).toContain('merchant_id INTEGER REFERENCES merchants(id)');
            expect(match[0]).not.toContain('merchant_id INTEGER NOT NULL');
        });

        test('oauth_states has merchant_id NOT NULL', () => {
            const regex = /CREATE TABLE oauth_states\s*\([^;]+\);/s;
            const match = schemaContent.match(regex);
            expect(match).not.toBeNull();
            expect(match[0]).toContain('merchant_id INTEGER NOT NULL REFERENCES merchants(id)');
        });

        test('promo_codes has composite unique on (merchant_id, code)', () => {
            const regex = /CREATE TABLE IF NOT EXISTS promo_codes\s*\([^;]+\);/s;
            const match = schemaContent.match(regex);
            expect(match[0]).toContain('UNIQUE(merchant_id, code)');
            // Should not have code alone as UNIQUE
            expect(match[0]).not.toMatch(/code TEXT NOT NULL UNIQUE/);
        });

        test('subscription_plans has composite unique on (merchant_id, plan_key)', () => {
            const regex = /CREATE TABLE IF NOT EXISTS subscription_plans\s*\([^;]+\);/s;
            const match = schemaContent.match(regex);
            expect(match[0]).toContain('UNIQUE(merchant_id, plan_key)');
            expect(match[0]).not.toMatch(/plan_key TEXT NOT NULL UNIQUE/);
        });
    });

    describe('schema-manager.js CREATE TABLE statements', () => {
        const tables = ['subscription_payments', 'subscription_events', 'subscription_plans', 'promo_codes'];

        test.each(tables)('%s CREATE TABLE includes merchant_id NOT NULL', (table) => {
            const regex = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\([^)]+\\)`, 's');
            const match = schemaManagerContent.match(regex);
            expect(match).not.toBeNull();
            expect(match[0]).toContain('merchant_id INTEGER NOT NULL REFERENCES merchants(id)');
        });
    });

    describe('migration 074', () => {
        test('is wrapped in BEGIN/COMMIT', () => {
            expect(migrationContent).toContain('BEGIN;');
            expect(migrationContent).toContain('COMMIT;');
        });

        const tables = ['promo_codes', 'subscription_payments', 'subscription_events', 'subscription_plans'];

        test.each(tables)('adds merchant_id to %s', (table) => {
            expect(migrationContent).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS merchant_id`);
        });

        test.each(tables)('backfills %s with merchant_id = 3', (table) => {
            expect(migrationContent).toContain(`UPDATE ${table} SET merchant_id = 3`);
        });

        test.each(tables)('sets %s merchant_id to NOT NULL after backfill', (table) => {
            expect(migrationContent).toContain(`ALTER TABLE ${table} ALTER COLUMN merchant_id SET NOT NULL`);
        });

        test('adds nullable merchant_id to platform_settings', () => {
            expect(migrationContent).toContain('ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS merchant_id');
            // Should NOT set NOT NULL on platform_settings
            expect(migrationContent).not.toContain('ALTER TABLE platform_settings ALTER COLUMN merchant_id SET NOT NULL');
        });

        test('sets oauth_states.merchant_id to NOT NULL', () => {
            expect(migrationContent).toContain('ALTER TABLE oauth_states ALTER COLUMN merchant_id SET NOT NULL');
        });

        test('creates composite indexes with merchant_id as leading column', () => {
            expect(migrationContent).toContain('idx_promo_codes_merchant_code ON promo_codes(merchant_id, code)');
            expect(migrationContent).toContain('idx_subscription_payments_merchant_subscriber ON subscription_payments(merchant_id, subscriber_id)');
            expect(migrationContent).toContain('idx_subscription_events_merchant_type ON subscription_events(merchant_id, event_type)');
        });
    });
});
