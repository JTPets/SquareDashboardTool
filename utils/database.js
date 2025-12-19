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
    database: process.env.DB_NAME || 'square_dashboard_addon',
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

        // Review tracking for expiration items (91-120 day review window)
        { table: 'variation_expiration', column: 'reviewed_at', sql: 'ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ' },
        { table: 'variation_expiration', column: 'reviewed_by', sql: 'ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS reviewed_by TEXT' },
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

    // ==================== GOOGLE MERCHANT CENTER TABLES ====================

    // Check if brands table exists
    const brandsCheck = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'brands'
    `);

    if (brandsCheck.rows.length === 0) {
        logger.info('Creating GMC tables (brands, google_taxonomy, etc.)...');

        // 1. Brands table
        await query(`
            CREATE TABLE IF NOT EXISTS brands (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                logo_url TEXT,
                website TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name)');

        // 2. Google Taxonomy table
        await query(`
            CREATE TABLE IF NOT EXISTS google_taxonomy (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id INTEGER REFERENCES google_taxonomy(id),
                level INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_google_taxonomy_parent ON google_taxonomy(parent_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_google_taxonomy_name ON google_taxonomy(name)');

        // 3. Category to Google Taxonomy mapping
        await query(`
            CREATE TABLE IF NOT EXISTS category_taxonomy_mapping (
                id SERIAL PRIMARY KEY,
                category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
                google_taxonomy_id INTEGER NOT NULL REFERENCES google_taxonomy(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(category_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_category_taxonomy_category ON category_taxonomy_mapping(category_id)');

        // 4. Item brands assignment
        await query(`
            CREATE TABLE IF NOT EXISTS item_brands (
                id SERIAL PRIMARY KEY,
                item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(item_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_item_brands_item ON item_brands(item_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_item_brands_brand ON item_brands(brand_id)');

        // 5. GMC Settings
        await query(`
            CREATE TABLE IF NOT EXISTS gmc_settings (
                id SERIAL PRIMARY KEY,
                setting_key TEXT NOT NULL UNIQUE,
                setting_value TEXT,
                description TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insert default settings
        await query(`
            INSERT INTO gmc_settings (setting_key, setting_value, description) VALUES
                ('website_base_url', 'https://your-store-url.com', 'Base URL for product links'),
                ('product_url_pattern', '/product/{slug}/{variation_id}', 'URL pattern for products'),
                ('default_condition', 'new', 'Default product condition'),
                ('default_availability', 'in_stock', 'Default availability when stock > 0'),
                ('currency', 'CAD', 'Default currency code'),
                ('feed_title', 'Product Feed', 'Feed title for GMC'),
                ('adult_content', 'no', 'Default adult content flag'),
                ('is_bundle', 'no', 'Default bundle flag')
            ON CONFLICT (setting_key) DO NOTHING
        `);

        // 6. GMC Feed History
        await query(`
            CREATE TABLE IF NOT EXISTS gmc_feed_history (
                id SERIAL PRIMARY KEY,
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                total_products INTEGER,
                products_with_errors INTEGER DEFAULT 0,
                tsv_file_path TEXT,
                google_sheet_url TEXT,
                duration_seconds INTEGER,
                status TEXT DEFAULT 'success',
                error_message TEXT
            )
        `);

        // 7. Google OAuth tokens storage
        await query(`
            CREATE TABLE IF NOT EXISTS google_oauth_tokens (
                id SERIAL PRIMARY KEY,
                user_id TEXT DEFAULT 'default',
                access_token TEXT,
                refresh_token TEXT,
                token_type TEXT,
                expiry_date BIGINT,
                scope TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            )
        `);

        logger.info('Created GMC tables with indexes');
        appliedCount++;
    }

    // ==================== SUBSCRIPTION TABLES ====================

    // Check if subscribers table exists
    const subscribersCheck = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'subscribers'
    `);

    if (subscribersCheck.rows.length === 0) {
        logger.info('Creating subscription tables...');

        // 1. Subscribers table
        await query(`
            CREATE TABLE IF NOT EXISTS subscribers (
                id SERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                business_name TEXT,
                square_customer_id TEXT UNIQUE,
                square_subscription_id TEXT UNIQUE,
                subscription_status TEXT DEFAULT 'trial',
                subscription_plan TEXT DEFAULT 'monthly',
                price_cents INTEGER NOT NULL DEFAULT 999,
                trial_start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                trial_end_date TIMESTAMP,
                subscription_start_date TIMESTAMP,
                subscription_end_date TIMESTAMP,
                next_billing_date TIMESTAMP,
                canceled_at TIMESTAMP,
                card_brand TEXT,
                card_last_four TEXT,
                card_id TEXT,
                is_intro_pricing BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email)');
        await query('CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(subscription_status)');
        await query('CREATE INDEX IF NOT EXISTS idx_subscribers_square_customer ON subscribers(square_customer_id)');

        // 2. Subscription payments table
        await query(`
            CREATE TABLE IF NOT EXISTS subscription_payments (
                id SERIAL PRIMARY KEY,
                subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
                square_payment_id TEXT UNIQUE,
                square_invoice_id TEXT,
                amount_cents INTEGER NOT NULL,
                currency TEXT DEFAULT 'CAD',
                status TEXT NOT NULL,
                payment_type TEXT DEFAULT 'subscription',
                billing_period_start TIMESTAMP,
                billing_period_end TIMESTAMP,
                refund_amount_cents INTEGER,
                refund_reason TEXT,
                refunded_at TIMESTAMP,
                receipt_url TEXT,
                failure_reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscriber ON subscription_payments(subscriber_id)');

        // 3. Subscription events table
        await query(`
            CREATE TABLE IF NOT EXISTS subscription_events (
                id SERIAL PRIMARY KEY,
                subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
                event_type TEXT NOT NULL,
                event_data JSONB,
                square_event_id TEXT,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_subscription_events_subscriber ON subscription_events(subscriber_id)');

        // 4. Subscription plans table
        await query(`
            CREATE TABLE IF NOT EXISTS subscription_plans (
                id SERIAL PRIMARY KEY,
                plan_key TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                price_cents INTEGER NOT NULL,
                billing_frequency TEXT NOT NULL,
                square_plan_id TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                is_intro_pricing BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insert default plans (intro pricing)
        await query(`
            INSERT INTO subscription_plans (plan_key, name, description, price_cents, billing_frequency, is_intro_pricing) VALUES
                ('monthly', 'Monthly Plan (Intro)', 'Full feature access - billed monthly. Introductory pricing!', 999, 'MONTHLY', TRUE),
                ('annual', 'Annual Plan (Intro)', 'Full feature access - billed annually. Save $20/year!', 9999, 'ANNUAL', TRUE)
            ON CONFLICT (plan_key) DO NOTHING
        `);

        logger.info('Created subscription tables with indexes');
        appliedCount++;
    }

    // ==================== EXPIRY DISCOUNT TABLES ====================

    // Check if expiry_discount_tiers table exists
    const expiryTiersCheck = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'expiry_discount_tiers'
    `);

    if (expiryTiersCheck.rows.length === 0) {
        logger.info('Creating expiry discount tables...');

        // 1. Expiry Discount Tiers - configurable discount tiers
        await query(`
            CREATE TABLE IF NOT EXISTS expiry_discount_tiers (
                id SERIAL PRIMARY KEY,
                tier_code TEXT NOT NULL UNIQUE,
                tier_name TEXT NOT NULL,
                min_days_to_expiry INTEGER,
                max_days_to_expiry INTEGER,
                discount_percent DECIMAL(5,2) DEFAULT 0,
                is_auto_apply BOOLEAN DEFAULT FALSE,
                requires_review BOOLEAN DEFAULT FALSE,
                square_discount_id TEXT,
                color_code TEXT DEFAULT '#6b7280',
                priority INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_tiers_code ON expiry_discount_tiers(tier_code)');
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_tiers_active ON expiry_discount_tiers(is_active)');

        // Insert default tier configurations
        // tier_name is customer-facing (shown in Square POS/receipts), tier_code is internal
        await query(`
            INSERT INTO expiry_discount_tiers (tier_code, tier_name, min_days_to_expiry, max_days_to_expiry, discount_percent, is_auto_apply, requires_review, color_code, priority) VALUES
                ('EXPIRED', 'Staff Only - Remove', NULL, 0, 0, FALSE, FALSE, '#991b1b', 100),
                ('AUTO50', 'Clearance Sale', 1, 30, 50, TRUE, FALSE, '#dc2626', 90),
                ('AUTO25', 'Special Savings', 31, 89, 25, TRUE, FALSE, '#f59e0b', 80),
                ('REVIEW', 'Staff Review', 90, 120, 0, FALSE, TRUE, '#3b82f6', 70),
                ('OK', 'Regular Stock', 121, NULL, 0, FALSE, FALSE, '#059669', 10)
            ON CONFLICT (tier_code) DO NOTHING
        `);

        // 2. Variation Discount Status - tracks current discount state per variation
        await query(`
            CREATE TABLE IF NOT EXISTS variation_discount_status (
                variation_id TEXT PRIMARY KEY REFERENCES variations(id) ON DELETE CASCADE,
                current_tier_id INTEGER REFERENCES expiry_discount_tiers(id) ON DELETE SET NULL,
                days_until_expiry INTEGER,
                original_price_cents INTEGER,
                discounted_price_cents INTEGER,
                discount_applied_at TIMESTAMPTZ,
                last_evaluated_at TIMESTAMPTZ DEFAULT NOW(),
                needs_pull BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_variation_discount_tier ON variation_discount_status(current_tier_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_variation_discount_needs_pull ON variation_discount_status(needs_pull) WHERE needs_pull = TRUE');
        await query('CREATE INDEX IF NOT EXISTS idx_variation_discount_days ON variation_discount_status(days_until_expiry)');

        // 3. Expiry Discount Audit Log - tracks all changes for accountability
        await query(`
            CREATE TABLE IF NOT EXISTS expiry_discount_audit_log (
                id SERIAL PRIMARY KEY,
                variation_id TEXT NOT NULL,
                action TEXT NOT NULL,
                old_tier_id INTEGER,
                new_tier_id INTEGER,
                old_price_cents INTEGER,
                new_price_cents INTEGER,
                days_until_expiry INTEGER,
                square_sync_status TEXT,
                square_error_message TEXT,
                triggered_by TEXT DEFAULT 'SYSTEM',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_audit_variation ON expiry_discount_audit_log(variation_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_audit_action ON expiry_discount_audit_log(action)');
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_audit_created ON expiry_discount_audit_log(created_at DESC)');

        // 4. Expiry Discount Settings - global settings
        await query(`
            CREATE TABLE IF NOT EXISTS expiry_discount_settings (
                id SERIAL PRIMARY KEY,
                setting_key TEXT NOT NULL UNIQUE,
                setting_value TEXT,
                description TEXT,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // Insert default settings
        await query(`
            INSERT INTO expiry_discount_settings (setting_key, setting_value, description) VALUES
                ('automation_enabled', 'true', 'Enable/disable automatic discount application'),
                ('email_notifications', 'true', 'Send email notifications for tier changes'),
                ('notification_email', '', 'Email address for notifications'),
                ('dry_run_mode', 'false', 'Run in dry-run mode (no actual changes)'),
                ('last_run_at', NULL, 'Timestamp of last automation run'),
                ('last_run_status', NULL, 'Status of last automation run')
            ON CONFLICT (setting_key) DO NOTHING
        `);

        logger.info('Created expiry discount tables with indexes');
        appliedCount++;
    } else {
        // Table exists - check if it has the wrong schema (old_tier_code instead of old_tier_id)
        const wrongSchemaCheck = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'expiry_discount_audit_log' AND column_name = 'old_tier_code'
        `);

        if (wrongSchemaCheck.rows.length > 0) {
            logger.info('Fixing expiry_discount_audit_log schema (wrong column names detected)...');

            // Drop the old table and recreate with correct schema
            await query('DROP TABLE IF EXISTS expiry_discount_audit_log CASCADE');
            await query(`
                CREATE TABLE expiry_discount_audit_log (
                    id SERIAL PRIMARY KEY,
                    variation_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    old_tier_id INTEGER,
                    new_tier_id INTEGER,
                    old_price_cents INTEGER,
                    new_price_cents INTEGER,
                    days_until_expiry INTEGER,
                    square_sync_status TEXT,
                    square_error_message TEXT,
                    triggered_by TEXT DEFAULT 'SYSTEM',
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query('CREATE INDEX IF NOT EXISTS idx_expiry_audit_variation ON expiry_discount_audit_log(variation_id)');
            await query('CREATE INDEX IF NOT EXISTS idx_expiry_audit_action ON expiry_discount_audit_log(action)');
            await query('CREATE INDEX IF NOT EXISTS idx_expiry_audit_created ON expiry_discount_audit_log(created_at DESC)');

            logger.info('Fixed expiry_discount_audit_log schema');
            appliedCount++;
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
