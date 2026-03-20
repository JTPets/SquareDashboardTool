'use strict';
/**
 * Tests for scripts/validate-schema.js parsing and comparison logic.
 * No DB connection — tests the exported utility functions only.
 */

const { parseTablesFromSource, normalizeType, typeCompatible } = require('../../scripts/validate-schema');

describe('parseTablesFromSource', () => {
    test('extracts simple CREATE TABLE', () => {
        const source = `
            await query(\`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    email TEXT NOT NULL,
                    name TEXT
                )
            \`);
        `;
        const tables = parseTablesFromSource(source);
        expect(tables).toHaveProperty('users');
        expect(tables.users).toHaveProperty('email');
        expect(tables.users).toHaveProperty('name');
    });

    test('extracts multiple CREATE TABLE statements', () => {
        const source = `
            await query(\`CREATE TABLE IF NOT EXISTS merchants (
                id SERIAL PRIMARY KEY,
                business_name TEXT NOT NULL,
                timezone TEXT DEFAULT 'America/Toronto'
            )\`);
            await query(\`CREATE TABLE IF NOT EXISTS locations (
                id TEXT PRIMARY KEY,
                name TEXT,
                merchant_id INTEGER NOT NULL
            )\`);
        `;
        const tables = parseTablesFromSource(source);
        expect(Object.keys(tables)).toContain('merchants');
        expect(Object.keys(tables)).toContain('locations');
    });

    test('returns empty object for source with no tables', () => {
        const tables = parseTablesFromSource('const x = 1; // no tables here');
        expect(Object.keys(tables).length).toBe(0);
    });

    test('ignores constraint lines when parsing columns', () => {
        const source = `
            await query(\`CREATE TABLE IF NOT EXISTS test_table (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                merchant_id INTEGER NOT NULL,
                CONSTRAINT test_unique UNIQUE(name, merchant_id),
                FOREIGN KEY (merchant_id) REFERENCES merchants(id)
            )\`);
        `;
        const tables = parseTablesFromSource(source);
        expect(tables).toHaveProperty('test_table');
        // Should have columns but not constraint lines as columns
        expect(tables.test_table).toHaveProperty('name');
        expect(tables.test_table).toHaveProperty('merchant_id');
        // CONSTRAINT should not appear as a column
        expect(tables.test_table).not.toHaveProperty('constraint');
    });

    test('handles table names in lowercase', () => {
        const source = `
            await query(\`CREATE TABLE IF NOT EXISTS MyTable (
                id SERIAL PRIMARY KEY
            )\`);
        `;
        const tables = parseTablesFromSource(source);
        expect(tables).toHaveProperty('mytable');
    });
});

describe('normalizeType', () => {
    test('normalizes SERIAL to integer', () => {
        expect(normalizeType('SERIAL')).toBe('integer');
    });

    test('normalizes INT to integer', () => {
        expect(normalizeType('INT')).toBe('integer');
    });

    test('normalizes TIMESTAMPTZ to timestamp with time zone', () => {
        expect(normalizeType('TIMESTAMPTZ')).toBe('timestamp with time zone');
    });

    test('normalizes TEXT to text', () => {
        expect(normalizeType('TEXT')).toBe('text');
    });

    test('normalizes BOOLEAN to boolean', () => {
        expect(normalizeType('BOOLEAN')).toBe('boolean');
    });
});

describe('typeCompatible', () => {
    test('integer types are compatible', () => {
        expect(typeCompatible('integer', 'bigint')).toBe(true);
        expect(typeCompatible('integer', 'integer')).toBe(true);
        expect(typeCompatible('integer', 'smallint')).toBe(true);
    });

    test('text types are compatible', () => {
        expect(typeCompatible('text', 'varchar')).toBe(true);
        expect(typeCompatible('text', 'character varying')).toBe(true);
        expect(typeCompatible('text', 'text')).toBe(true);
    });

    test('timestamp types are compatible', () => {
        expect(typeCompatible('timestamp with time zone', 'timestamp with time zone')).toBe(true);
    });

    test('incompatible types return false', () => {
        expect(typeCompatible('text', 'integer')).toBe(false);
        expect(typeCompatible('boolean', 'integer')).toBe(false);
        expect(typeCompatible('uuid', 'text')).toBe(false);
    });

    test('jsonb types are compatible', () => {
        expect(typeCompatible('jsonb', 'json')).toBe(true);
        expect(typeCompatible('jsonb', 'jsonb')).toBe(true);
    });

    test('varchar(N) is compatible with varchar (size specifier stripped)', () => {
        expect(typeCompatible('varchar(64)', 'varchar')).toBe(true);
        expect(typeCompatible('varchar(255)', 'character varying')).toBe(true);
        expect(typeCompatible('varchar(20)', 'text')).toBe(true);
    });

    test('text[] is compatible with array (PostgreSQL reports as ARRAY)', () => {
        expect(typeCompatible('text[]', 'array')).toBe(true);
        expect(typeCompatible('varchar[]', 'array')).toBe(true);
    });
});
