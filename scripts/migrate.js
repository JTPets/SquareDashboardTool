#!/usr/bin/env node
/**
 * Migration Runner
 * Applies pending SQL migrations from database/migrations/ (not archive/).
 *
 * Usage: node scripts/migrate.js
 *
 * Behavior:
 * 1. Create schema_migrations table if it doesn't exist
 * 2. Check which migrations in database/migrations/ are not in schema_migrations
 * 3. Run pending migrations in order, each in its own transaction
 * 4. Stop on first failure (do not run later migrations)
 *
 * Fresh installs (via schema-manager.js) have all tables but zero pending
 * migrations — schema_migrations is created, 001 is applied, done.
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

        if (!await getMigrationsTableExists(client)) {
            await createMigrationsTable(client);
        }

        const migrationFiles = getMigrationFiles();

        if (migrationFiles.length === 0) {
            client.release();
            logger.info('No migration files found in database/migrations/');
            await db.close();
            process.exit(0);
        }

        const applied = await getAppliedMigrations(client);
        client.release();
        client = null;

        const pending = migrationFiles.filter(f => !applied.has(f));

        if (pending.length === 0) {
            logger.info('All migrations already applied. Nothing to do.');
            await db.close();
            process.exit(0);
        }

        logger.info(`Found ${pending.length} pending migration(s): ${pending.join(', ')}`);

        // Run each pending migration in its own transaction
        for (const filename of pending) {
            const filepath = path.join(MIGRATIONS_DIR, filename);
            logger.info(`Applying migration: ${filename}`);
            const migClient = await db.getClient();
            try {
                await migClient.query('BEGIN');
                await runMigration(migClient, filepath, filename);
                await migClient.query('COMMIT');
                logger.info(`Migration applied: ${filename}`);
            } catch (err) {
                await migClient.query('ROLLBACK');
                migClient.release();
                logger.error(`Migration failed: ${filename}`, { error: err.message });
                await db.close();
                process.exit(1);
            }
            migClient.release();
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
        await db.close();
        process.exit(1);
    }
}

main();
