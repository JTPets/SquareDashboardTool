#!/usr/bin/env node
/**
 * Migration Runner Script
 * Runs database migrations using the application's database connection
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./utils/database');

async function runMigration() {
    try {
        console.log('🔄 Running cycle count migration...');

        // Read the migration file
        const migrationPath = path.join(__dirname, 'database/migrations/003_cycle_counts.sql');
        const sql = fs.readFileSync(migrationPath, 'utf-8');

        // Execute the migration
        await db.query(sql);

        console.log('✅ Migration completed successfully!');
        console.log('');
        console.log('Created tables:');
        console.log('  - count_history');
        console.log('  - count_queue_priority');
        console.log('  - count_sessions');

        // Verify tables were created
        const result = await db.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name IN ('count_history', 'count_queue_priority', 'count_sessions')
            ORDER BY table_name
        `);

        console.log('');
        console.log('Verified tables:');
        result.rows.forEach(row => {
            console.log(`  ✓ ${row.table_name}`);
        });

        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

runMigration();
