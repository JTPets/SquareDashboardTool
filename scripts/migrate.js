#!/usr/bin/env node
/**
 * Migration Runner
 * Applies pending SQL migrations from database/migrations/ (not archive/).
 *
 * Usage: node scripts/migrate.js
 *
 * Fresh install detection: if schema_migrations table doesn't exist but core
 * tables do (created by schema-manager.js), creates schema_migrations with no
 * entries — clean baseline, no migrations to run.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../utils/database');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, '../database/migrations');

async function createMigrationsTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id SERIAL PRIMARY KEY,
            filename TEXT UNIQUE NOT NULL,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}

async function getMigrationsTableExists(client) {
    const result = await client.query(`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'schema_migrations'
        )
    `);
    return result.rows[0].exists;
}

async function getCoreTablesExist(client) {
    const result = await client.query(`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'merchants'
        )
    `);
    return result.rows[0].exists;
}

async function getAppliedMigrations(client) {
    const result = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
    return new Set(result.rows.map(r => r.filename));
}

function getMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        return [];
    }
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql') && /^\d+_/.test(f))
        .sort();
}

async function runMigration(client, filepath, filename) {
    const sql = fs.readFileSync(filepath, 'utf8');
    await client.query(sql);
    await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename]
    );
}

async function main() {
    let client;
    try {
        client = await db.getClient();
        await client.query('BEGIN');

        const migrationsTableExists = await getMigrationsTableExists(client);

        if (!migrationsTableExists) {
            const coreTablesExist = await getCoreTablesExist(client);
            if (coreTablesExist) {
                // Fresh install via schema-manager.js — create baseline with no entries
                logger.info('Fresh install detected (schema-manager created schema). Creating schema_migrations baseline...');
                await createMigrationsTable(client);
                await client.query('COMMIT');
                logger.info('schema_migrations table created. No migrations to run (clean baseline).');
                await client.release();
                process.exit(0);
            } else {
                await createMigrationsTable(client);
            }
        }

        const migrationFiles = getMigrationFiles();

        if (migrationFiles.length === 0) {
            await client.query('COMMIT');
            logger.info('No migration files found in database/migrations/');
            await client.release();
            process.exit(0);
        }

        const applied = await getAppliedMigrations(client);
        const pending = migrationFiles.filter(f => !applied.has(f));

        if (pending.length === 0) {
            await client.query('COMMIT');
            logger.info('All migrations already applied. Nothing to do.');
            await client.release();
            process.exit(0);
        }

        logger.info(`Found ${pending.length} pending migration(s): ${pending.join(', ')}`);
        await client.query('COMMIT');

        // Run each pending migration in its own transaction
        for (const filename of pending) {
            const filepath = path.join(MIGRATIONS_DIR, filename);
            logger.info(`Applying migration: ${filename}`);
            try {
                const migClient = await db.getClient();
                try {
                    await migClient.query('BEGIN');
                    await runMigration(migClient, filepath, filename);
                    await migClient.query('COMMIT');
                    logger.info(`Migration applied: ${filename}`);
                } catch (err) {
                    await migClient.query('ROLLBACK');
                    throw err;
                } finally {
                    migClient.release();
                }
            } catch (err) {
                logger.error(`Migration failed: ${filename}`, { error: err.message });
                process.exit(1);
            }
        }

        logger.info(`Migration complete. ${pending.length} migration(s) applied.`);
        await db.close();
        process.exit(0);

    } catch (err) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            client.release();
        }
        logger.error('Migration runner failed', { error: err.message, stack: err.stack });
        process.exit(1);
    }
}

main();
