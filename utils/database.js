/**
 * Database Connection Pool Module
 * Provides PostgreSQL connection pool and query utilities
 */

const { Pool } = require('pg');
const logger = require('./logger');

// Track shutdown state to prevent queries after pool is closed
let isShuttingDown = false;
let activeQueries = 0;

// Create connection pool
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'square_dashboard_addon',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Handle pool errors — log but do not exit. The pool removes the errored client
// automatically and PM2 health checks will restart if the pool becomes unusable.
pool.on('error', (err, client) => {
    logger.error('Database pool error on idle client', { error: err.message, stack: err.stack });
});

// Log pool connection events for monitoring
pool.on('connect', () => {
    logger.debug('New client connected to pool', {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
    });
});

/**
 * Get pool statistics for monitoring
 * @returns {Object} Pool stats including total, idle, and waiting counts
 */
function getPoolStats() {
    return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        activeQueries
    };
}

/**
 * Execute a query with parameters
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
    // Prevent queries during shutdown to avoid "Cannot use a pool after calling end" errors
    if (isShuttingDown) {
        const error = new Error('Database is shutting down - query rejected');
        error.code = 'POOL_SHUTDOWN';
        logger.warn('Query rejected - database shutting down', {
            query: text.substring(0, 50)
        });
        throw error;
    }

    activeQueries++;
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
            paramCount: params?.length ?? 0
        });
        throw error;
    } finally {
        activeQueries--;
    }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<Object>} Client connection
 */
async function getClient() {
    // Prevent getting clients during shutdown
    if (isShuttingDown) {
        const error = new Error('Database is shutting down - cannot get client');
        error.code = 'POOL_SHUTDOWN';
        logger.warn('Client request rejected - database shutting down');
        throw error;
    }

    activeQueries++;
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
        activeQueries--;
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
        logger.error('Transaction error', { error: error.message, stack: error.stack });
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
        logger.error('Database connection failed', { error: error.message, stack: error.stack });
        return false;
    }
}

/**
 * Close all connections in the pool
 * Waits for active queries to complete before closing
 */
async function close() {
    isShuttingDown = true;
    logger.info('Database shutdown initiated', { activeQueries });

    // Wait for active queries to complete (up to 10 seconds)
    const maxWait = 10000;
    const startTime = Date.now();
    while (activeQueries > 0 && (Date.now() - startTime) < maxWait) {
        logger.info('Waiting for active queries to complete', { activeQueries });
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (activeQueries > 0) {
        logger.warn('Closing pool with active queries still pending', { activeQueries });
    }

    await pool.end();
    logger.info('Database pool closed');
}

/**
 * Check if the database pool is shutting down
 * @returns {boolean} True if shutdown is in progress
 */
function isPoolShuttingDown() {
    return isShuttingDown;
}

module.exports = {
    query,
    getClient,
    transaction,
    testConnection,
    close,
    pool,
    isPoolShuttingDown,
    getPoolStats,
};
