/**
 * Database Connection Pool Module
 * Provides PostgreSQL connection pool and query utilities
 */

const { Pool } = require('pg');
const logger = require('./logger');

// Create connection pool
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'jtpets_beta',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Handle pool errors
pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle client', { error: err.message, stack: err.stack });
    process.exit(-1);
});

/**
 * Execute a query with parameters
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;

        // Log slow queries (> 1 second)
        if (duration > 1000) {
            logger.warn('Slow query detected', {
                text: text.substring(0, 100),
                duration,
                rows: res.rowCount
            });
        }

        return res;
    } catch (error) {
        logger.error('Database query error', {
            message: error.message,
            query: text.substring(0, 100),
            params: params
        });
        throw error;
    }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<Object>} Client connection
 */
async function getClient() {
    const client = await pool.connect();
    const originalQuery = client.query;
    const originalRelease = client.release;

    // Set a timeout of 5 seconds, after which we will log this client's last query
    const timeout = setTimeout(() => {
        logger.warn('A client has been checked out for more than 5 seconds');
    }, 5000);

    // Monkey patch the query method to keep track of the last query executed
    client.query = (...args) => {
        client.lastQuery = args;
        return originalQuery.apply(client, args);
    };

    client.release = () => {
        clearTimeout(timeout);
        client.query = originalQuery;
        client.release = originalRelease;
        return originalRelease.apply(client);
    };

    return client;
}

/**
 * Execute multiple queries in a transaction
 * @param {Function} callback - Async function that receives client and executes queries
 * @returns {Promise<*>} Result of callback function
 */
async function transaction(callback) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Transaction error', { error: error.message });
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Batch upsert helper for syncing data
 * @param {string} table - Table name
 * @param {Array<Object>} records - Array of records to upsert
 * @param {Array<string>} conflictColumns - Columns for conflict detection
 * @param {Array<string>} updateColumns - Columns to update on conflict
 * @returns {Promise<number>} Number of records affected
 */
async function batchUpsert(table, records, conflictColumns, updateColumns) {
    if (!records || records.length === 0) {
        return 0;
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');
        let totalAffected = 0;

        // Process in batches of 100 to avoid parameter limits
        const batchSize = 100;
        for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize);

            // Build column list from first record
            const columns = Object.keys(batch[0]);
            const conflictClause = conflictColumns.join(', ');
            const updateClause = updateColumns
                .map(col => `${col} = EXCLUDED.${col}`)
                .join(', ');

            // Build value placeholders
            const values = [];
            const placeholders = batch.map((record, idx) => {
                const recordValues = columns.map(col => {
                    const value = record[col];
                    values.push(value);
                    return `$${values.length}`;
                });
                return `(${recordValues.join(', ')})`;
            }).join(', ');

            const sql = `
                INSERT INTO ${table} (${columns.join(', ')})
                VALUES ${placeholders}
                ON CONFLICT (${conflictClause})
                DO UPDATE SET ${updateClause}, updated_at = CURRENT_TIMESTAMP
            `;

            const result = await client.query(sql, values);
            totalAffected += result.rowCount;
        }

        await client.query('COMMIT');
        return totalAffected;
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Batch upsert error', { error: error.message });
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Test database connection
 * @returns {Promise<boolean>} True if connection successful
 */
async function testConnection() {
    try {
        const result = await query('SELECT NOW() as now');
        logger.info('Database connection successful', { timestamp: result.rows[0].now });
        return true;
    } catch (error) {
        logger.error('Database connection failed', { error: error.message });
        return false;
    }
}

/**
 * Close all connections in the pool
 */
async function close() {
    await pool.end();
    logger.info('Database pool closed');
}

/**
 * Ensure database schema is up to date
 * Runs on server startup to apply any missing columns/tables
 */
async function ensureSchema() {
    logger.info('Checking database schema...');

    const migrations = [
        // Soft delete tracking (added in earlier migration)
        { table: 'items', column: 'is_deleted', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE' },
        { table: 'items', column: 'deleted_at', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP' },
        { table: 'variations', column: 'is_deleted', sql: 'ALTER TABLE variations ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE' },
        { table: 'variations', column: 'deleted_at', sql: 'ALTER TABLE variations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP' },

        // SEO and tax fields from Square API
        { table: 'items', column: 'tax_ids', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS tax_ids JSONB' },
        { table: 'items', column: 'seo_title', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS seo_title TEXT' },
        { table: 'items', column: 'seo_description', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS seo_description TEXT' },
    ];

    let appliedCount = 0;

    // Check if vendor_catalog_items table exists
    const tableCheck = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'vendor_catalog_items'
    `);

    if (tableCheck.rows.length === 0) {
        logger.info('Creating vendor_catalog_items table...');
        await query(`
            CREATE TABLE IF NOT EXISTS vendor_catalog_items (
                id SERIAL PRIMARY KEY,
                vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
                vendor_name TEXT NOT NULL,
                brand TEXT,
                vendor_item_number TEXT NOT NULL,
                product_name TEXT NOT NULL,
                upc TEXT,
                cost_cents INTEGER NOT NULL,
                price_cents INTEGER,
                margin_percent DECIMAL(5,2),
                matched_variation_id TEXT REFERENCES variations(id) ON DELETE SET NULL,
                match_method TEXT,
                import_batch_id TEXT,
                import_name TEXT,
                is_archived BOOLEAN DEFAULT FALSE,
                imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(vendor_id, vendor_item_number, import_batch_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_vendor_catalog_vendor ON vendor_catalog_items(vendor_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_vendor_catalog_upc ON vendor_catalog_items(upc) WHERE upc IS NOT NULL');
        await query('CREATE INDEX IF NOT EXISTS idx_vendor_catalog_vendor_item ON vendor_catalog_items(vendor_item_number)');
        await query('CREATE INDEX IF NOT EXISTS idx_vendor_catalog_matched ON vendor_catalog_items(matched_variation_id) WHERE matched_variation_id IS NOT NULL');
        await query('CREATE INDEX IF NOT EXISTS idx_vendor_catalog_batch ON vendor_catalog_items(import_batch_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_vendor_catalog_imported ON vendor_catalog_items(imported_at DESC)');
        await query('CREATE INDEX IF NOT EXISTS idx_vendor_catalog_archived ON vendor_catalog_items(is_archived) WHERE is_archived = TRUE');
        logger.info('Created vendor_catalog_items table with indexes');
        appliedCount++;
    } else {
        // Add new columns to existing table if they don't exist
        const columnMigrations = [
            { column: 'brand', sql: 'ALTER TABLE vendor_catalog_items ADD COLUMN IF NOT EXISTS brand TEXT' },
            { column: 'import_name', sql: 'ALTER TABLE vendor_catalog_items ADD COLUMN IF NOT EXISTS import_name TEXT' },
            { column: 'is_archived', sql: 'ALTER TABLE vendor_catalog_items ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE' }
        ];

        for (const migration of columnMigrations) {
            try {
                const colCheck = await query(`
                    SELECT column_name FROM information_schema.columns
                    WHERE table_name = 'vendor_catalog_items' AND column_name = $1
                `, [migration.column]);

                if (colCheck.rows.length === 0) {
                    await query(migration.sql);
                    logger.info(`Added ${migration.column} column to vendor_catalog_items`);
                    appliedCount++;
                }
            } catch (err) {
                logger.error(`Failed to add ${migration.column} column`, { error: err.message });
            }
        }

        // Add archived index if missing
        try {
            await query('CREATE INDEX IF NOT EXISTS idx_vendor_catalog_archived ON vendor_catalog_items(is_archived) WHERE is_archived = TRUE');
        } catch (err) {
            // Index may already exist
        }
    }

    for (const migration of migrations) {
        try {
            // Check if column exists
            const checkResult = await query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = $1 AND column_name = $2
            `, [migration.table, migration.column]);

            if (checkResult.rows.length === 0) {
                // Column doesn't exist, apply migration
                await query(migration.sql);
                logger.info(`Schema migration applied: ${migration.table}.${migration.column}`);
                appliedCount++;
            }
        } catch (error) {
            logger.error(`Schema migration failed: ${migration.table}.${migration.column}`, {
                error: error.message
            });
            // Continue with other migrations, don't fail completely
        }
    }

    if (appliedCount > 0) {
        logger.info(`Schema check complete: ${appliedCount} migrations applied`);
    } else {
        logger.info('Schema check complete: database is up to date');
    }

    return appliedCount;
}

module.exports = {
    query,
    getClient,
    transaction,
    batchUpsert,
    testConnection,
    ensureSchema,
    close,
    pool
};
