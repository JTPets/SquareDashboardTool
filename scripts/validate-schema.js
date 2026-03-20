#!/usr/bin/env node
/**
 * Schema Validation Script
 * Compares the production database against what schema-manager.js would create.
 * READ ONLY — safe to run against production.
 *
 * Usage: node scripts/validate-schema.js
 *
 * Output statuses:
 *   MATCH          — table/column exists in both DB and schema-manager
 *   MISSING IN DB  — schema-manager creates it but DB doesn't have it
 *   MISSING IN SCHEMA — DB has it but schema-manager doesn't create it
 *   TYPE MISMATCH  — column exists in both but type/nullable differs
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../utils/database');

const SCHEMA_MANAGER_PATH = path.join(__dirname, '../utils/schema-manager.js');

// Parse CREATE TABLE statements from a JS/SQL string
function parseTablesFromSource(source) {
    const tables = {};
    // Match CREATE TABLE IF NOT EXISTS name ( ... ) with balanced parens
    const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([^;]+?)\)\s*(?:;|`)/gi;
    let match;
    while ((match = tablePattern.exec(source)) !== null) {
        const tableName = match[1].toLowerCase();
        const body = match[2];
        tables[tableName] = parseColumns(body);
    }
    return tables;
}

function parseColumns(tableBody) {
    const columns = {};
    // Split by commas, but respect nested parens (for CHECK constraints)
    const lines = splitTopLevel(tableBody);
    for (const line of lines) {
        const trimmed = line.trim();
        // Skip constraint lines (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK, CONSTRAINT)
        if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(trimmed)) continue;
        // Column definition: name type ...
        const colMatch = trimmed.match(/^(\w+)\s+(\S+)/);
        if (colMatch) {
            const colName = colMatch[1].toLowerCase();
            const colType = normalizeType(colMatch[2]);
            // Skip SQL keywords that aren't columns
            if (['id', 'references', 'on', 'default', 'not', 'null', 'unique', 'check', 'constraint', 'primary', 'foreign'].includes(colName)) continue;
            columns[colName] = colType;
        }
    }
    return columns;
}

function splitTopLevel(str) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of str) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function normalizeType(pgType) {
    return pgType.toLowerCase()
        .replace(/varying/g, 'varying')
        .replace(/character varying/g, 'varchar')
        .replace(/^text$/g, 'text')
        .replace(/^integer$/g, 'integer')
        .replace(/^int$/g, 'integer')
        .replace(/^serial$/g, 'integer') // SERIAL becomes integer in information_schema
        .replace(/timestamptz/g, 'timestamp with time zone')
        .replace(/^boolean$/g, 'boolean');
}

function pgTypeNormalize(pgType) {
    return (pgType || '').toLowerCase()
        .replace(/character varying/g, 'varchar')
        .replace(/timestamp with time zone/g, 'timestamp with time zone')
        .replace(/timestamp without time zone/g, 'timestamp without time zone');
}

async function getDbTables(client) {
    const result = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);
    return result.rows.map(r => r.table_name);
}

async function getDbColumns(client, tableName) {
    const result = await client.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
    `, [tableName]);
    const cols = {};
    for (const row of result.rows) {
        cols[row.column_name] = {
            type: pgTypeNormalize(row.data_type),
            nullable: row.is_nullable === 'YES',
            default: row.column_default
        };
    }
    return cols;
}

async function main() {
    let client;
    try {
        const schemaManagerSource = fs.readFileSync(SCHEMA_MANAGER_PATH, 'utf8');
        const schemaTables = parseTablesFromSource(schemaManagerSource);

        client = await db.getClient();

        const dbTableNames = await getDbTables(client);
        const dbTableSet = new Set(dbTableNames);
        const schemaTableSet = new Set(Object.keys(schemaTables));

        const results = [];

        // Tables in schema-manager but not in DB
        for (const tbl of schemaTableSet) {
            if (!dbTableSet.has(tbl)) {
                results.push({ status: 'MISSING IN DB', table: tbl, detail: 'schema-manager creates this table but DB does not have it' });
            }
        }

        // Tables in DB but not in schema-manager
        const knownNonSchemaManagerTables = new Set([
            // Tables created by connect-pg-simple session store
            'sessions',
            // Tables that may exist from other tooling
        ]);
        for (const tbl of dbTableSet) {
            if (!schemaTableSet.has(tbl) && !knownNonSchemaManagerTables.has(tbl)) {
                results.push({ status: 'MISSING IN SCHEMA', table: tbl, detail: 'DB has this table but schema-manager does not create it (may be OK — document as known gap)' });
            }
        }

        // Column comparison for tables that exist in both
        for (const tbl of schemaTableSet) {
            if (!dbTableSet.has(tbl)) continue;

            const schemaCols = schemaTables[tbl];
            const dbCols = await getDbColumns(client, tbl);

            for (const [colName, schemaType] of Object.entries(schemaCols)) {
                if (!dbCols[colName]) {
                    results.push({ status: 'MISSING IN DB', table: tbl, column: colName, detail: `schema-manager defines column '${colName}' but DB does not have it` });
                } else {
                    const dbType = dbCols[colName].type;
                    const normSchema = normalizeType(schemaType);
                    // Loose type check — only flag clear mismatches
                    if (dbType !== normSchema && !typeCompatible(normSchema, dbType)) {
                        results.push({ status: 'TYPE MISMATCH', table: tbl, column: colName, detail: `schema-manager: ${normSchema}, DB: ${dbType}` });
                    } else {
                        results.push({ status: 'MATCH', table: tbl, column: colName, detail: dbType });
                    }
                }
            }
        }

        // Print report
        const missingInDb = results.filter(r => r.status === 'MISSING IN DB');
        const missingInSchema = results.filter(r => r.status === 'MISSING IN SCHEMA');
        const typeMismatch = results.filter(r => r.status === 'TYPE MISMATCH');
        const matches = results.filter(r => r.status === 'MATCH');

        console.log('\n=== Schema Validation Report ===\n');
        console.log(`MATCH:             ${matches.length}`);
        console.log(`MISSING IN DB:     ${missingInDb.length}`);
        console.log(`MISSING IN SCHEMA: ${missingInSchema.length}`);
        console.log(`TYPE MISMATCH:     ${typeMismatch.length}`);

        if (missingInDb.length > 0) {
            console.log('\n--- MISSING IN DB (schema-manager creates but DB lacks) ---');
            for (const r of missingInDb) {
                const loc = r.column ? `${r.table}.${r.column}` : r.table;
                console.log(`  ${loc}: ${r.detail}`);
            }
        }

        if (typeMismatch.length > 0) {
            console.log('\n--- TYPE MISMATCH ---');
            for (const r of typeMismatch) {
                console.log(`  ${r.table}.${r.column}: ${r.detail}`);
            }
        }

        if (missingInSchema.length > 0) {
            console.log('\n--- MISSING IN SCHEMA (DB has but schema-manager does not create — known gaps are OK) ---');
            for (const r of missingInSchema) {
                const loc = r.column ? `${r.table}.${r.column}` : r.table;
                console.log(`  ${loc}: ${r.detail}`);
            }
        }

        console.log('\n=== End Report ===\n');

        client.release();
        await db.close();
        process.exit(0);
    } catch (err) {
        console.error('validate-schema failed:', err.message);
        if (client) client.release();
        process.exit(0); // Always exit 0 — report tool, not a blocker
    }
}

function typeCompatible(schemaType, dbType) {
    // Strip varchar(N) size specifiers — varchar(64) is compatible with varchar
    const stripSize = t => t.replace(/\(\d+\)$/, '').trim();
    const normSchema = stripSize(schemaType);
    const normDb = stripSize(dbType);

    // text[] / varchar[] in schema appears as ARRAY in information_schema
    if (normSchema.endsWith('[]') && normDb === 'array') return true;
    if (normDb.endsWith('[]') && normSchema === 'array') return true;

    const compatMap = {
        'integer': ['integer', 'bigint', 'smallint', 'serial', 'bigserial'],
        'varchar': ['varchar', 'text', 'character varying', 'char', 'name'],
        'text': ['text', 'varchar', 'character varying', 'char', 'name'],
        'boolean': ['boolean'],
        'timestamp with time zone': ['timestamp with time zone', 'timestamptz'],
        'timestamp without time zone': ['timestamp without time zone', 'timestamp'],
        'jsonb': ['jsonb', 'json'],
        'decimal': ['decimal', 'numeric', 'real', 'double precision'],
        'uuid': ['uuid'],
    };
    for (const [base, variants] of Object.entries(compatMap)) {
        if ((normSchema.startsWith(base) || variants.includes(normSchema)) &&
            (normDb.startsWith(base) || variants.includes(normDb))) {
            return true;
        }
    }
    return false;
}

// Export for testing
module.exports = { parseTablesFromSource, parseColumns, normalizeType, typeCompatible };

if (require.main === module) {
    main();
}
