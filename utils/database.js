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

module.exports = {
    query,
    getClient,
    transaction,
    batchUpsert,
    testConnection,
    close,
    pool
};
