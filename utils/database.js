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
    console.error('FATAL: Database pool error on idle client:', err.message);
    console.error(err.stack);
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
    try {
    logger.info('Checking database schema...');

    const migrations = [
        // Soft delete tracking (added in earlier migration)
        { table: 'items', column: 'is_deleted', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE' },
        { table: 'items', column: 'deleted_at', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP' },
        { table: 'variations', column: 'is_deleted', sql: 'ALTER TABLE variations ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE' },
        { table: 'variations', column: 'deleted_at', sql: 'ALTER TABLE variations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP' },

        // Archive status from Square (archived items are hidden in Square but still operational)
        { table: 'items', column: 'is_archived', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE' },
        { table: 'items', column: 'archived_at', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP' },
        { table: 'variations', column: 'is_archived', sql: 'ALTER TABLE variations ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE' },
        { table: 'variations', column: 'archived_at', sql: 'ALTER TABLE variations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP' },

        // SEO and tax fields from Square API
        { table: 'items', column: 'tax_ids', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS tax_ids JSONB' },
        { table: 'items', column: 'seo_title', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS seo_title TEXT' },
        { table: 'items', column: 'seo_description', sql: 'ALTER TABLE items ADD COLUMN IF NOT EXISTS seo_description TEXT' },

        // Review tracking for expiration items (91-120 day review window)
        { table: 'variation_expiration', column: 'reviewed_at', sql: 'ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ' },
        { table: 'variation_expiration', column: 'reviewed_by', sql: 'ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS reviewed_by TEXT' },
    ];

    let appliedCount = 0;

    // ==================== VARIATION EXPIRATION TABLE ====================
    // Ensure variation_expiration table exists (needed for review tracking columns)
    const expirationTableCheck = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'variation_expiration'
    `);

    if (expirationTableCheck.rows.length === 0) {
        logger.info('Creating variation_expiration table...');
        await query(`
            CREATE TABLE IF NOT EXISTS variation_expiration (
                variation_id TEXT PRIMARY KEY REFERENCES variations(id) ON DELETE CASCADE,
                expiration_date TIMESTAMPTZ,
                does_not_expire BOOLEAN DEFAULT FALSE,
                reviewed_at TIMESTAMPTZ,
                reviewed_by TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_variation_expiration_date ON variation_expiration(expiration_date) WHERE expiration_date IS NOT NULL');
        await query('CREATE INDEX IF NOT EXISTS idx_variation_does_not_expire ON variation_expiration(does_not_expire) WHERE does_not_expire = TRUE');
        await query('CREATE INDEX IF NOT EXISTS idx_variation_expiration_reviewed ON variation_expiration(reviewed_at) WHERE reviewed_at IS NOT NULL');
        logger.info('Created variation_expiration table with indexes');
        appliedCount++;
    } else {
        // Table exists - ensure review tracking columns exist
        // These may be missing if table was created before review feature was added
        const reviewColumnMigrations = [
            { column: 'reviewed_at', sql: 'ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ' },
            { column: 'reviewed_by', sql: 'ALTER TABLE variation_expiration ADD COLUMN IF NOT EXISTS reviewed_by TEXT' }
        ];

        for (const migration of reviewColumnMigrations) {
            try {
                const colCheck = await query(`
                    SELECT column_name FROM information_schema.columns
                    WHERE table_name = 'variation_expiration' AND column_name = $1
                `, [migration.column]);

                if (colCheck.rows.length === 0) {
                    await query(migration.sql);
                    logger.info(`Added ${migration.column} column to variation_expiration`);
                    appliedCount++;
                }
            } catch (err) {
                // If ALTER fails due to permissions, try to provide helpful guidance
                if (err.message.includes('must be owner') || err.message.includes('permission denied')) {
                    logger.error(`Permission denied adding ${migration.column} column. Run as database owner:`, {
                        sql: migration.sql,
                        error: err.message
                    });
                } else {
                    logger.error(`Failed to add ${migration.column} column to variation_expiration`, { error: err.message });
                }
            }
        }

        // Ensure index exists for reviewed_at
        try {
            await query('CREATE INDEX IF NOT EXISTS idx_variation_expiration_reviewed ON variation_expiration(reviewed_at) WHERE reviewed_at IS NOT NULL');
        } catch (err) {
            // Index may already exist or permissions issue
        }
    }


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

        // 6b. GMC Location Settings - stores Google store codes and per-location settings
        await query(`
            CREATE TABLE IF NOT EXISTS gmc_location_settings (
                id SERIAL PRIMARY KEY,
                merchant_id INTEGER REFERENCES merchants(id) ON DELETE CASCADE,
                location_id TEXT NOT NULL,
                google_store_code TEXT,
                enabled BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(merchant_id, location_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_gmc_location_settings_merchant ON gmc_location_settings(merchant_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_gmc_location_settings_location ON gmc_location_settings(location_id)');

        // 7. Google OAuth tokens storage (per-merchant)
        await query(`
            CREATE TABLE IF NOT EXISTS google_oauth_tokens (
                id SERIAL PRIMARY KEY,
                merchant_id INTEGER REFERENCES merchants(id) ON DELETE CASCADE,
                access_token TEXT,
                refresh_token TEXT,
                token_type TEXT,
                expiry_date BIGINT,
                scope TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(merchant_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_google_oauth_merchant ON google_oauth_tokens(merchant_id)');

        logger.info('Created GMC tables with indexes');
        appliedCount++;
    }

    // ==================== GOOGLE OAUTH MIGRATION ====================
    // Migrate google_oauth_tokens from user_id to merchant_id
    try {
        const userIdColumnCheck = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'google_oauth_tokens' AND column_name = 'user_id'
        `);

        if (userIdColumnCheck.rows.length > 0) {
            logger.info('Migrating google_oauth_tokens from user_id to merchant_id...');

            // Add merchant_id column if not exists
            await query(`ALTER TABLE google_oauth_tokens ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id) ON DELETE CASCADE`);

            // Drop old user_id column and constraint
            await query(`ALTER TABLE google_oauth_tokens DROP CONSTRAINT IF EXISTS google_oauth_tokens_user_id_key`);
            await query(`ALTER TABLE google_oauth_tokens DROP COLUMN IF EXISTS user_id`);

            // Add unique constraint on merchant_id
            await query(`ALTER TABLE google_oauth_tokens ADD CONSTRAINT google_oauth_tokens_merchant_id_key UNIQUE (merchant_id)`);
            await query('CREATE INDEX IF NOT EXISTS idx_google_oauth_merchant ON google_oauth_tokens(merchant_id)');

            logger.info('Migrated google_oauth_tokens to use merchant_id');
            appliedCount++;
        }
    } catch (error) {
        logger.error('Failed to migrate google_oauth_tokens:', error.message);
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
    } else {
        // Add promo code columns to subscribers if missing
        const promoColCheck = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'subscribers' AND column_name = 'promo_code_id'
        `);
        if (promoColCheck.rows.length === 0) {
            await query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS promo_code_id INTEGER');
            await query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS discount_applied_cents INTEGER DEFAULT 0');
            logger.info('Added promo code columns to subscribers');
            appliedCount++;
        }

        // Add user_id column to subscribers if missing (links subscription to user account)
        const userIdColCheck = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'subscribers' AND column_name = 'user_id'
        `);
        if (userIdColCheck.rows.length === 0) {
            await query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)');
            await query('CREATE INDEX IF NOT EXISTS idx_subscribers_user ON subscribers(user_id)');
            logger.info('Added user_id column to subscribers');
            appliedCount++;
        }
    }

    // ==================== PROMO CODES TABLES ====================

    // Check if promo_codes table exists
    const promoCodesCheck = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'promo_codes'
    `);

    if (promoCodesCheck.rows.length === 0) {
        logger.info('Creating promo codes tables...');

        // 1. Promo codes table
        await query(`
            CREATE TABLE IF NOT EXISTS promo_codes (
                id SERIAL PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                description TEXT,
                discount_type TEXT NOT NULL DEFAULT 'percent',
                discount_value INTEGER NOT NULL,
                max_uses INTEGER,
                times_used INTEGER DEFAULT 0,
                min_purchase_cents INTEGER DEFAULT 0,
                valid_from TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                valid_until TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE,
                applies_to_plans TEXT[],
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code)');
        await query('CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active)');

        // 2. Promo code uses tracking
        await query(`
            CREATE TABLE IF NOT EXISTS promo_code_uses (
                id SERIAL PRIMARY KEY,
                promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
                subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
                discount_applied_cents INTEGER NOT NULL,
                used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(promo_code_id, subscriber_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_promo_code_uses_code ON promo_code_uses(promo_code_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_promo_code_uses_subscriber ON promo_code_uses(subscriber_id)');

        // Insert default promo codes for testing
        await query(`
            INSERT INTO promo_codes (code, description, discount_type, discount_value, max_uses, created_by) VALUES
                ('BETA100', 'Beta tester - 100% off first payment', 'percent', 100, 50, 'system'),
                ('HALFOFF', '50% off first month', 'percent', 50, NULL, 'system'),
                ('SAVE5', '$5 off any plan', 'fixed', 500, NULL, 'system')
            ON CONFLICT (code) DO NOTHING
        `);

        // Add foreign key to subscribers if promo_codes table now exists
        try {
            await query(`
                ALTER TABLE subscribers
                ADD CONSTRAINT fk_subscribers_promo_code
                FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id)
            `);
        } catch (e) {
            // Constraint may already exist
        }

        logger.info('Created promo codes tables with indexes');
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
                tier_code TEXT NOT NULL,
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
                merchant_id INTEGER REFERENCES merchants(id),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(tier_code, merchant_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_tiers_code ON expiry_discount_tiers(tier_code)');
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_tiers_active ON expiry_discount_tiers(is_active)');
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_tiers_merchant ON expiry_discount_tiers(merchant_id)');

        // Note: Default tier configurations are now created per-merchant by ensureMerchantTiers()
        // in utils/expiry-discount.js when a merchant first accesses the expiry discounts page

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
                setting_key TEXT NOT NULL,
                setting_value TEXT,
                description TEXT,
                merchant_id INTEGER REFERENCES merchants(id),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(setting_key, merchant_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_expiry_settings_merchant ON expiry_discount_settings(merchant_id)');

        // Note: Default settings are now created per-merchant by initializeDefaultTiers()
        // in utils/expiry-discount.js when a merchant first accesses the expiry discounts page

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

        // Note: expiry_discount_settings are now created per-merchant by ensureMerchantTiers()
        // in utils/expiry-discount.js when a merchant first accesses the expiry discounts page.
        // Legacy global settings migration removed as the table now uses (setting_key, merchant_id) unique constraint.
    }

    // ==================== USER AUTHENTICATION TABLES ====================

    // Check if users table exists
    const usersCheck = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
    `);

    if (usersCheck.rows.length === 0) {
        logger.info('Creating user authentication tables...');

        // 1. Users table
        await query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                name TEXT,
                role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'readonly')),
                is_active BOOLEAN DEFAULT TRUE,
                failed_login_attempts INTEGER DEFAULT 0,
                locked_until TIMESTAMPTZ,
                last_login TIMESTAMPTZ,
                password_changed_at TIMESTAMPTZ DEFAULT NOW(),
                terms_accepted_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
        await query('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
        await query('CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = TRUE');

        // 2. Sessions table (for connect-pg-simple)
        await query(`
            CREATE TABLE IF NOT EXISTS sessions (
                sid VARCHAR NOT NULL PRIMARY KEY,
                sess JSON NOT NULL,
                expire TIMESTAMPTZ NOT NULL
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)');

        // 3. Auth audit log table
        await query(`
            CREATE TABLE IF NOT EXISTS auth_audit_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                event_type TEXT NOT NULL,
                ip_address TEXT,
                user_agent TEXT,
                details JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit_log(user_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_auth_audit_event ON auth_audit_log(event_type)');
        await query('CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at DESC)');

        // 4. Password reset tokens table
        await query(`
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token TEXT NOT NULL UNIQUE,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token)');
        await query('CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at)');

        logger.info('Created user authentication tables with indexes');
        appliedCount++;
    } else {
        // Check if password_reset_tokens table exists (may need to add to existing installs)
        const resetTokensCheck = await query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'password_reset_tokens'
        `);

        if (resetTokensCheck.rows.length === 0) {
            await query(`
                CREATE TABLE IF NOT EXISTS password_reset_tokens (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token TEXT NOT NULL UNIQUE,
                    expires_at TIMESTAMPTZ NOT NULL,
                    used_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query('CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token)');
            await query('CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id)');
            await query('CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at)');
            logger.info('Created password_reset_tokens table');
            appliedCount++;
        }
    }

    // ==================== WEBHOOK EVENTS TABLE ====================
    const webhookTableExists = await query(`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = 'webhook_events'
        )
    `);

    if (!webhookTableExists.rows[0].exists) {
        await query(`
            CREATE TABLE IF NOT EXISTS webhook_events (
                id SERIAL PRIMARY KEY,
                square_event_id TEXT UNIQUE,
                event_type TEXT NOT NULL,
                merchant_id TEXT,
                event_data JSONB,
                status TEXT NOT NULL DEFAULT 'received',
                processed_at TIMESTAMPTZ,
                error_message TEXT,
                sync_results JSONB,
                received_at TIMESTAMPTZ DEFAULT NOW(),
                processing_time_ms INTEGER,
                CONSTRAINT valid_webhook_status CHECK (status IN ('received', 'processing', 'completed', 'failed', 'skipped'))
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events(event_type)');
        await query('CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status)');
        await query('CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at DESC)');
        await query('CREATE INDEX IF NOT EXISTS idx_webhook_events_square_id ON webhook_events(square_event_id)');

        logger.info('Created webhook_events table with indexes');
        appliedCount++;
    }

    // ==================== MULTI-TENANT TABLES ====================
    // These tables support the multi-merchant OAuth system

    const merchantsTableExists = await query(`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = 'merchants'
        )
    `);

    if (!merchantsTableExists.rows[0].exists) {
        logger.info('Creating multi-tenant tables...');

        // 1. Merchants table - Core tenant table storing Square OAuth credentials
        await query(`
            CREATE TABLE IF NOT EXISTS merchants (
                id SERIAL PRIMARY KEY,
                square_merchant_id TEXT UNIQUE NOT NULL,
                business_name TEXT NOT NULL,
                business_email TEXT,
                square_access_token TEXT NOT NULL,
                square_refresh_token TEXT,
                square_token_expires_at TIMESTAMPTZ,
                square_token_scopes TEXT[],
                subscription_status TEXT DEFAULT 'trial',
                subscription_plan_id INTEGER,
                trial_ends_at TIMESTAMPTZ,
                subscription_ends_at TIMESTAMPTZ,
                timezone TEXT DEFAULT 'America/New_York',
                currency TEXT DEFAULT 'USD',
                settings JSONB DEFAULT '{}',
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                last_sync_at TIMESTAMPTZ,
                CONSTRAINT valid_subscription_status CHECK (
                    subscription_status IN ('trial', 'active', 'cancelled', 'expired', 'suspended')
                )
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_merchants_square_id ON merchants(square_merchant_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_merchants_subscription ON merchants(subscription_status, is_active)');
        await query('CREATE INDEX IF NOT EXISTS idx_merchants_active ON merchants(is_active) WHERE is_active = TRUE');

        // 2. User-Merchant relationships
        await query(`
            CREATE TABLE IF NOT EXISTS user_merchants (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
                role TEXT NOT NULL DEFAULT 'user',
                is_primary BOOLEAN DEFAULT FALSE,
                invited_by INTEGER REFERENCES users(id),
                invited_at TIMESTAMPTZ DEFAULT NOW(),
                accepted_at TIMESTAMPTZ,
                UNIQUE(user_id, merchant_id),
                CONSTRAINT valid_role CHECK (role IN ('owner', 'admin', 'user', 'readonly'))
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_user_merchants_user ON user_merchants(user_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_user_merchants_merchant ON user_merchants(merchant_id)');
        await query('CREATE INDEX IF NOT EXISTS idx_user_merchants_primary ON user_merchants(user_id, is_primary) WHERE is_primary = TRUE');

        // 3. Merchant invitations
        await query(`
            CREATE TABLE IF NOT EXISTS merchant_invitations (
                id SERIAL PRIMARY KEY,
                merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                token TEXT UNIQUE NOT NULL,
                invited_by INTEGER REFERENCES users(id),
                expires_at TIMESTAMPTZ NOT NULL,
                accepted_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_merchant_invitations_token ON merchant_invitations(token)');
        await query('CREATE INDEX IF NOT EXISTS idx_merchant_invitations_email ON merchant_invitations(email)');
        await query('CREATE INDEX IF NOT EXISTS idx_merchant_invitations_merchant ON merchant_invitations(merchant_id)');

        // 4. OAuth states for CSRF protection
        await query(`
            CREATE TABLE IF NOT EXISTS oauth_states (
                id SERIAL PRIMARY KEY,
                state TEXT UNIQUE NOT NULL,
                user_id INTEGER REFERENCES users(id),
                redirect_uri TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state)');
        await query('CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at)');

        logger.info('Created multi-tenant tables with indexes');
        appliedCount++;
    }

    // ==================== MULTI-TENANT COLUMN MIGRATIONS ====================
    // Add merchant_id to existing tables if not present

    const tablesToAddMerchantId = [
        'locations', 'categories', 'items', 'variations', 'images', 'inventory_counts',
        'vendors', 'variation_vendors', 'vendor_catalog_items',
        'purchase_orders', 'purchase_order_items',
        'sales_velocity', 'variation_location_settings',
        'count_history', 'count_queue_priority', 'count_queue_daily', 'count_sessions',
        'variation_expiration', 'expiry_discount_tiers', 'variation_discount_status',
        'expiry_discount_audit_log', 'expiry_discount_settings',
        'brands', 'category_taxonomy_mapping', 'item_brands', 'gmc_settings', 'gmc_feed_history',
        'sync_history'
    ];

    for (const tableName of tablesToAddMerchantId) {
        try {
            const columnCheck = await query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = $1 AND column_name = 'merchant_id'
            `, [tableName]);

            if (columnCheck.rows.length === 0) {
                // Check if table exists first
                const tableCheck = await query(`
                    SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)
                `, [tableName]);

                if (tableCheck.rows[0].exists) {
                    await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id)`);
                    await query(`CREATE INDEX IF NOT EXISTS idx_${tableName}_merchant ON ${tableName}(merchant_id)`);
                    logger.info(`Added merchant_id column to ${tableName}`);
                    appliedCount++;
                }
            }
        } catch (error) {
            logger.error(`Failed to add merchant_id to ${tableName}:`, error.message);
        }
    }

    // Add merchant_id to auth_audit_log (no foreign key - for flexibility)
    try {
        const auditMerchantCheck = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'auth_audit_log' AND column_name = 'merchant_id'
        `);
        if (auditMerchantCheck.rows.length === 0) {
            await query('ALTER TABLE auth_audit_log ADD COLUMN IF NOT EXISTS merchant_id INTEGER');
            logger.info('Added merchant_id column to auth_audit_log');
            appliedCount++;
        }
    } catch (error) {
        logger.error('Failed to add merchant_id to auth_audit_log:', error.message);
    }

    // Add email column to auth_audit_log (needed for audit logging)
    try {
        const emailColumnCheck = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'auth_audit_log' AND column_name = 'email'
        `);
        if (emailColumnCheck.rows.length === 0) {
            await query('ALTER TABLE auth_audit_log ADD COLUMN IF NOT EXISTS email TEXT');
            logger.info('Added email column to auth_audit_log');
            appliedCount++;
        }
    } catch (error) {
        logger.error('Failed to add email to auth_audit_log:', error.message);
    }

    // Add terms_accepted_at column to users table for legal compliance
    try {
        const termsColumnCheck = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'terms_accepted_at'
        `);
        if (termsColumnCheck.rows.length === 0) {
            await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ');
            logger.info('Added terms_accepted_at column to users');
            appliedCount++;
        }
    } catch (error) {
        logger.error('Failed to add terms_accepted_at to users:', error.message);
    }

    // Add gmc_feed_token column to merchants table for secure GMC feed access
    try {
        const feedTokenCheck = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'merchants' AND column_name = 'gmc_feed_token'
        `);
        if (feedTokenCheck.rows.length === 0) {
            await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS gmc_feed_token TEXT UNIQUE`);
            // Generate tokens for existing merchants
            const merchants = await query('SELECT id FROM merchants WHERE gmc_feed_token IS NULL');
            for (const merchant of merchants.rows) {
                const token = require('crypto').randomBytes(32).toString('hex');
                await query('UPDATE merchants SET gmc_feed_token = $1 WHERE id = $2', [token, merchant.id]);
            }
            logger.info('Added gmc_feed_token column to merchants and generated tokens');
            appliedCount++;
        }
    } catch (error) {
        logger.error('Failed to add gmc_feed_token to merchants:', error.message);
    }

    // ==================== MULTI-TENANT CONSTRAINT MIGRATIONS ====================
    // Update unique constraints to include merchant_id for multi-tenant support

    // count_sessions: Update unique constraint from (session_date) to (session_date, merchant_id)
    try {
        const countSessionsTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'count_sessions')
        `);

        if (countSessionsTableCheck.rows[0].exists) {
            // Check if old constraint exists
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'count_sessions' AND constraint_name = 'count_sessions_session_date_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                // Drop old constraint and create new one with merchant_id
                await query('ALTER TABLE count_sessions DROP CONSTRAINT IF EXISTS count_sessions_session_date_key');
                await query('ALTER TABLE count_sessions ADD CONSTRAINT count_sessions_session_date_merchant_key UNIQUE (session_date, merchant_id)');
                logger.info('Updated count_sessions unique constraint to include merchant_id');
                appliedCount++;
            } else {
                // Check if new constraint exists, if not create it
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'count_sessions' AND constraint_name = 'count_sessions_session_date_merchant_key'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    await query('ALTER TABLE count_sessions ADD CONSTRAINT count_sessions_session_date_merchant_key UNIQUE (session_date, merchant_id)');
                    logger.info('Added count_sessions unique constraint on (session_date, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update count_sessions constraint:', error.message);
    }

    // count_history: Update unique constraint from (catalog_object_id) to (catalog_object_id, merchant_id)
    try {
        const countHistoryTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'count_history')
        `);

        if (countHistoryTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'count_history' AND constraint_name = 'count_history_catalog_object_id_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE count_history DROP CONSTRAINT count_history_catalog_object_id_key');
                await query('ALTER TABLE count_history ADD CONSTRAINT count_history_catalog_merchant_unique UNIQUE (catalog_object_id, merchant_id)');
                logger.info('Updated count_history unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'count_history' AND constraint_name = 'count_history_catalog_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    await query('ALTER TABLE count_history ADD CONSTRAINT count_history_catalog_merchant_unique UNIQUE (catalog_object_id, merchant_id)');
                    logger.info('Added count_history unique constraint on (catalog_object_id, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update count_history constraint:', error.message);
    }

    // count_queue_daily: Update unique constraint to include merchant_id
    try {
        const countQueueDailyTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'count_queue_daily')
        `);

        if (countQueueDailyTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'count_queue_daily' AND constraint_name = 'count_queue_daily_catalog_object_id_batch_date_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE count_queue_daily DROP CONSTRAINT count_queue_daily_catalog_object_id_batch_date_key');
                await query('ALTER TABLE count_queue_daily ADD CONSTRAINT count_queue_daily_catalog_batch_merchant_unique UNIQUE (catalog_object_id, batch_date, merchant_id)');
                logger.info('Updated count_queue_daily unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'count_queue_daily' AND constraint_name = 'count_queue_daily_catalog_batch_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    await query('ALTER TABLE count_queue_daily ADD CONSTRAINT count_queue_daily_catalog_batch_merchant_unique UNIQUE (catalog_object_id, batch_date, merchant_id)');
                    logger.info('Added count_queue_daily unique constraint on (catalog_object_id, batch_date, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update count_queue_daily constraint:', error.message);
    }

    // inventory_counts: Update unique constraint to include merchant_id
    try {
        const inventoryCountsTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'inventory_counts')
        `);

        if (inventoryCountsTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'inventory_counts' AND constraint_name = 'inventory_counts_catalog_object_id_location_id_state_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE inventory_counts DROP CONSTRAINT inventory_counts_catalog_object_id_location_id_state_key');
                await query('ALTER TABLE inventory_counts ADD CONSTRAINT inventory_counts_catalog_location_state_merchant_unique UNIQUE (catalog_object_id, location_id, state, merchant_id)');
                logger.info('Updated inventory_counts unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'inventory_counts' AND constraint_name = 'inventory_counts_catalog_location_state_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    await query('ALTER TABLE inventory_counts ADD CONSTRAINT inventory_counts_catalog_location_state_merchant_unique UNIQUE (catalog_object_id, location_id, state, merchant_id)');
                    logger.info('Added inventory_counts unique constraint');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update inventory_counts constraint:', error.message);
    }

    // brands: Update unique constraint from (name) to (name, merchant_id)
    try {
        const brandsTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'brands')
        `);

        if (brandsTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'brands' AND constraint_name = 'brands_name_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE brands DROP CONSTRAINT brands_name_key');
                await query('ALTER TABLE brands ADD CONSTRAINT brands_name_merchant_unique UNIQUE (name, merchant_id)');
                logger.info('Updated brands unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'brands' AND constraint_name = 'brands_name_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    await query('ALTER TABLE brands ADD CONSTRAINT brands_name_merchant_unique UNIQUE (name, merchant_id)');
                    logger.info('Added brands unique constraint on (name, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update brands constraint:', error.message);
    }

    // category_taxonomy_mapping: Update unique constraint to include merchant_id
    try {
        const categoryMappingTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'category_taxonomy_mapping')
        `);

        if (categoryMappingTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'category_taxonomy_mapping' AND constraint_name = 'category_taxonomy_mapping_category_id_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE category_taxonomy_mapping DROP CONSTRAINT category_taxonomy_mapping_category_id_key');
                await query('ALTER TABLE category_taxonomy_mapping ADD CONSTRAINT category_taxonomy_mapping_category_merchant_unique UNIQUE (category_id, merchant_id)');
                logger.info('Updated category_taxonomy_mapping unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'category_taxonomy_mapping' AND constraint_name = 'category_taxonomy_mapping_category_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    await query('ALTER TABLE category_taxonomy_mapping ADD CONSTRAINT category_taxonomy_mapping_category_merchant_unique UNIQUE (category_id, merchant_id)');
                    logger.info('Added category_taxonomy_mapping unique constraint on (category_id, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update category_taxonomy_mapping constraint:', error.message);
    }

    // item_brands: Update unique constraint to include merchant_id
    try {
        const itemBrandsTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'item_brands')
        `);

        if (itemBrandsTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'item_brands' AND constraint_name = 'item_brands_item_id_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE item_brands DROP CONSTRAINT item_brands_item_id_key');
                await query('ALTER TABLE item_brands ADD CONSTRAINT item_brands_item_merchant_unique UNIQUE (item_id, merchant_id)');
                logger.info('Updated item_brands unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'item_brands' AND constraint_name = 'item_brands_item_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    await query('ALTER TABLE item_brands ADD CONSTRAINT item_brands_item_merchant_unique UNIQUE (item_id, merchant_id)');
                    logger.info('Added item_brands unique constraint on (item_id, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update item_brands constraint:', error.message);
    }

    // gmc_settings: Update unique constraint to include merchant_id
    try {
        const gmcSettingsTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'gmc_settings')
        `);

        if (gmcSettingsTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'gmc_settings' AND constraint_name = 'gmc_settings_setting_key_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE gmc_settings DROP CONSTRAINT gmc_settings_setting_key_key');
                await query('ALTER TABLE gmc_settings ADD CONSTRAINT gmc_settings_key_merchant_unique UNIQUE (setting_key, merchant_id)');
                logger.info('Updated gmc_settings unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'gmc_settings' AND constraint_name = 'gmc_settings_key_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    await query('ALTER TABLE gmc_settings ADD CONSTRAINT gmc_settings_key_merchant_unique UNIQUE (setting_key, merchant_id)');
                    logger.info('Added gmc_settings unique constraint on (setting_key, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update gmc_settings constraint:', error.message);
    }

    // expiry_discount_tiers: Update unique constraint from (tier_code) to (tier_code, merchant_id)
    try {
        const tiersTableExists = await query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_name = 'expiry_discount_tiers'
        `);

        if (tiersTableExists.rows.length > 0) {
            // Check if old constraint exists
            const oldTiersConstraint = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'expiry_discount_tiers' AND constraint_name = 'expiry_discount_tiers_tier_code_key'
            `);

            if (oldTiersConstraint.rows.length > 0) {
                // Drop old constraint and create new one with merchant_id
                await query('ALTER TABLE expiry_discount_tiers DROP CONSTRAINT expiry_discount_tiers_tier_code_key');
                await query('ALTER TABLE expiry_discount_tiers ADD CONSTRAINT expiry_discount_tiers_code_merchant_unique UNIQUE (tier_code, merchant_id)');
                logger.info('Updated expiry_discount_tiers unique constraint to include merchant_id');
                appliedCount++;
            } else {
                // Check if new constraint exists, if not create it
                const newTiersConstraint = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'expiry_discount_tiers' AND constraint_name = 'expiry_discount_tiers_code_merchant_unique'
                `);
                if (newTiersConstraint.rows.length === 0) {
                    await query('ALTER TABLE expiry_discount_tiers ADD CONSTRAINT expiry_discount_tiers_code_merchant_unique UNIQUE (tier_code, merchant_id)');
                    logger.info('Added expiry_discount_tiers unique constraint on (tier_code, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update expiry_discount_tiers constraint:', error.message);
    }

    // expiry_discount_settings: Update unique constraint from (setting_key) to (setting_key, merchant_id)
    try {
        const settingsTableExists = await query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_name = 'expiry_discount_settings'
        `);

        if (settingsTableExists.rows.length > 0) {
            // Check if old constraint exists
            const oldSettingsConstraint = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'expiry_discount_settings' AND constraint_name = 'expiry_discount_settings_setting_key_key'
            `);

            if (oldSettingsConstraint.rows.length > 0) {
                // Drop old constraint and create new one with merchant_id
                await query('ALTER TABLE expiry_discount_settings DROP CONSTRAINT expiry_discount_settings_setting_key_key');
                await query('ALTER TABLE expiry_discount_settings ADD CONSTRAINT expiry_discount_settings_key_merchant_unique UNIQUE (setting_key, merchant_id)');
                logger.info('Updated expiry_discount_settings unique constraint to include merchant_id');
                appliedCount++;
            } else {
                // Check if new constraint exists, if not create it
                const newSettingsConstraint = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'expiry_discount_settings' AND constraint_name = 'expiry_discount_settings_key_merchant_unique'
                `);
                if (newSettingsConstraint.rows.length === 0) {
                    await query('ALTER TABLE expiry_discount_settings ADD CONSTRAINT expiry_discount_settings_key_merchant_unique UNIQUE (setting_key, merchant_id)');
                    logger.info('Added expiry_discount_settings unique constraint on (setting_key, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update expiry_discount_settings constraint:', error.message);
    }

    // variation_location_settings: Update unique constraint to include merchant_id
    try {
        const vlsTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'variation_location_settings')
        `);

        if (vlsTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'variation_location_settings' AND constraint_name = 'variation_location_settings_variation_id_location_id_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE variation_location_settings DROP CONSTRAINT variation_location_settings_variation_id_location_id_key');
                await query('ALTER TABLE variation_location_settings ADD CONSTRAINT variation_location_settings_var_loc_merchant_unique UNIQUE (variation_id, location_id, merchant_id)');
                logger.info('Updated variation_location_settings unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'variation_location_settings' AND constraint_name = 'variation_location_settings_var_loc_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    // Check if any constraint exists on these columns before adding
                    const anyConstraint = await query(`
                        SELECT constraint_name FROM information_schema.table_constraints tc
                        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
                        WHERE tc.table_name = 'variation_location_settings' AND tc.constraint_type = 'UNIQUE'
                        AND ccu.column_name IN ('variation_id', 'location_id')
                    `);
                    if (anyConstraint.rows.length === 0) {
                        await query('ALTER TABLE variation_location_settings ADD CONSTRAINT variation_location_settings_var_loc_merchant_unique UNIQUE (variation_id, location_id, merchant_id)');
                        logger.info('Added variation_location_settings unique constraint on (variation_id, location_id, merchant_id)');
                        appliedCount++;
                    }
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update variation_location_settings constraint:', error.message);
    }

    // variation_vendors: Update unique constraint to include merchant_id
    try {
        const vvTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'variation_vendors')
        `);

        if (vvTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'variation_vendors' AND constraint_name = 'variation_vendors_variation_id_vendor_id_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE variation_vendors DROP CONSTRAINT variation_vendors_variation_id_vendor_id_key');
                await query('ALTER TABLE variation_vendors ADD CONSTRAINT variation_vendors_var_vendor_merchant_unique UNIQUE (variation_id, vendor_id, merchant_id)');
                logger.info('Updated variation_vendors unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'variation_vendors' AND constraint_name = 'variation_vendors_var_vendor_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    const anyConstraint = await query(`
                        SELECT constraint_name FROM information_schema.table_constraints tc
                        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
                        WHERE tc.table_name = 'variation_vendors' AND tc.constraint_type = 'UNIQUE'
                        AND ccu.column_name IN ('variation_id', 'vendor_id')
                    `);
                    if (anyConstraint.rows.length === 0) {
                        await query('ALTER TABLE variation_vendors ADD CONSTRAINT variation_vendors_var_vendor_merchant_unique UNIQUE (variation_id, vendor_id, merchant_id)');
                        logger.info('Added variation_vendors unique constraint on (variation_id, vendor_id, merchant_id)');
                        appliedCount++;
                    }
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update variation_vendors constraint:', error.message);
    }

    // sales_velocity: Update unique constraint to include merchant_id
    try {
        const svTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'sales_velocity')
        `);

        if (svTableCheck.rows[0].exists) {
            const oldConstraintCheck = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'sales_velocity' AND constraint_name = 'sales_velocity_variation_id_location_id_period_days_key'
            `);

            if (oldConstraintCheck.rows.length > 0) {
                await query('ALTER TABLE sales_velocity DROP CONSTRAINT sales_velocity_variation_id_location_id_period_days_key');
                await query('ALTER TABLE sales_velocity ADD CONSTRAINT sales_velocity_var_loc_period_merchant_unique UNIQUE (variation_id, location_id, period_days, merchant_id)');
                logger.info('Updated sales_velocity unique constraint to include merchant_id');
                appliedCount++;
            } else {
                const newConstraintCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'sales_velocity' AND constraint_name = 'sales_velocity_var_loc_period_merchant_unique'
                `);

                if (newConstraintCheck.rows.length === 0) {
                    const anyConstraint = await query(`
                        SELECT constraint_name FROM information_schema.table_constraints tc
                        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
                        WHERE tc.table_name = 'sales_velocity' AND tc.constraint_type = 'UNIQUE'
                        AND ccu.column_name IN ('variation_id', 'location_id', 'period_days')
                    `);
                    if (anyConstraint.rows.length === 0) {
                        await query('ALTER TABLE sales_velocity ADD CONSTRAINT sales_velocity_var_loc_period_merchant_unique UNIQUE (variation_id, location_id, period_days, merchant_id)');
                        logger.info('Added sales_velocity unique constraint on (variation_id, location_id, period_days, merchant_id)');
                        appliedCount++;
                    }
                }
            }
        }
    } catch (error) {
        logger.error('Failed to update sales_velocity constraint:', error.message);
    }

    // variation_expiration: Restructure from PRIMARY KEY(variation_id) to support multi-tenant
    // Need to: add id column, change PK, add unique constraint on (variation_id, merchant_id)
    try {
        const veTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'variation_expiration')
        `);

        if (veTableCheck.rows[0].exists) {
            // Check if we already have the new unique constraint (migration already done)
            const newConstraintExists = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'variation_expiration' AND constraint_name = 'variation_expiration_var_merchant_unique'
            `);

            if (newConstraintExists.rows.length === 0) {
                // Check if variation_id is still the primary key
                const pkCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'variation_expiration' AND constraint_type = 'PRIMARY KEY'
                    AND constraint_name = 'variation_expiration_pkey'
                `);

                if (pkCheck.rows.length > 0) {
                    // Check if id column exists
                    const idColCheck = await query(`
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'variation_expiration' AND column_name = 'id'
                    `);

                    if (idColCheck.rows.length === 0) {
                        // Add id column
                        await query('ALTER TABLE variation_expiration ADD COLUMN id SERIAL');
                        logger.info('Added id column to variation_expiration');
                    }

                    // Drop the old primary key
                    await query('ALTER TABLE variation_expiration DROP CONSTRAINT variation_expiration_pkey');
                    logger.info('Dropped old variation_expiration primary key');

                    // Add new primary key on id
                    await query('ALTER TABLE variation_expiration ADD PRIMARY KEY (id)');
                    logger.info('Added new primary key on id for variation_expiration');

                    // Add unique constraint on (variation_id, merchant_id)
                    await query('ALTER TABLE variation_expiration ADD CONSTRAINT variation_expiration_var_merchant_unique UNIQUE (variation_id, merchant_id)');
                    logger.info('Added variation_expiration unique constraint on (variation_id, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to restructure variation_expiration:', error.message);
    }

    // variation_discount_status: Restructure from PRIMARY KEY(variation_id) to support multi-tenant
    // Also need to add merchant_id column if missing
    try {
        const vdsTableCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'variation_discount_status')
        `);

        if (vdsTableCheck.rows[0].exists) {
            // First, ensure merchant_id column exists
            const merchantIdCheck = await query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'variation_discount_status' AND column_name = 'merchant_id'
            `);

            if (merchantIdCheck.rows.length === 0) {
                await query('ALTER TABLE variation_discount_status ADD COLUMN merchant_id INTEGER REFERENCES merchants(id)');
                logger.info('Added merchant_id column to variation_discount_status');

                // Backfill merchant_id from variations table
                await query(`
                    UPDATE variation_discount_status vds
                    SET merchant_id = v.merchant_id
                    FROM variations v
                    WHERE vds.variation_id = v.id AND vds.merchant_id IS NULL
                `);
                logger.info('Backfilled merchant_id in variation_discount_status from variations table');
            }

            // Check if we already have the new unique constraint
            const newConstraintExists = await query(`
                SELECT constraint_name FROM information_schema.table_constraints
                WHERE table_name = 'variation_discount_status' AND constraint_name = 'variation_discount_status_var_merchant_unique'
            `);

            if (newConstraintExists.rows.length === 0) {
                // Check if variation_id is still the primary key
                const pkCheck = await query(`
                    SELECT constraint_name FROM information_schema.table_constraints
                    WHERE table_name = 'variation_discount_status' AND constraint_type = 'PRIMARY KEY'
                    AND constraint_name = 'variation_discount_status_pkey'
                `);

                if (pkCheck.rows.length > 0) {
                    // Check if id column exists
                    const idColCheck = await query(`
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'variation_discount_status' AND column_name = 'id'
                    `);

                    if (idColCheck.rows.length === 0) {
                        await query('ALTER TABLE variation_discount_status ADD COLUMN id SERIAL');
                        logger.info('Added id column to variation_discount_status');
                    }

                    // Drop the old primary key
                    await query('ALTER TABLE variation_discount_status DROP CONSTRAINT variation_discount_status_pkey');
                    logger.info('Dropped old variation_discount_status primary key');

                    // Add new primary key on id
                    await query('ALTER TABLE variation_discount_status ADD PRIMARY KEY (id)');
                    logger.info('Added new primary key on id for variation_discount_status');

                    // Add unique constraint on (variation_id, merchant_id)
                    await query('ALTER TABLE variation_discount_status ADD CONSTRAINT variation_discount_status_var_merchant_unique UNIQUE (variation_id, merchant_id)');
                    logger.info('Added variation_discount_status unique constraint on (variation_id, merchant_id)');
                    appliedCount++;
                }
            }
        }
    } catch (error) {
        logger.error('Failed to restructure variation_discount_status:', error.message);
    }

    // ==================== MERCHANT SETTINGS TABLE ====================
    // Per-merchant configurable business rules (reorder thresholds, cycle count settings, etc.)
    // These settings override global env var defaults on a per-merchant basis
    const merchantSettingsCheck = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'merchant_settings'
    `);

    if (merchantSettingsCheck.rows.length === 0) {
        logger.info('Creating merchant_settings table...');

        await query(`
            CREATE TABLE IF NOT EXISTS merchant_settings (
                id SERIAL PRIMARY KEY,
                merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,

                -- Reorder Business Rules
                reorder_safety_days INTEGER DEFAULT 7,
                default_supply_days INTEGER DEFAULT 45,
                reorder_priority_urgent_days INTEGER DEFAULT 0,
                reorder_priority_high_days INTEGER DEFAULT 7,
                reorder_priority_medium_days INTEGER DEFAULT 14,
                reorder_priority_low_days INTEGER DEFAULT 30,

                -- Cycle Count Settings
                daily_count_target INTEGER DEFAULT 30,
                cycle_count_email_enabled BOOLEAN DEFAULT TRUE,
                cycle_count_report_email BOOLEAN DEFAULT TRUE,
                additional_cycle_count_email TEXT,

                -- Notification Settings
                notification_email TEXT,
                low_stock_alerts_enabled BOOLEAN DEFAULT TRUE,

                -- Timestamps
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),

                UNIQUE(merchant_id)
            )
        `);
        await query('CREATE INDEX IF NOT EXISTS idx_merchant_settings_merchant ON merchant_settings(merchant_id)');

        logger.info('Created merchant_settings table');
        appliedCount++;
    } else {
        // Ensure all columns exist for existing installations
        const settingsColumnMigrations = [
            { column: 'additional_cycle_count_email', sql: 'ALTER TABLE merchant_settings ADD COLUMN IF NOT EXISTS additional_cycle_count_email TEXT' },
            { column: 'notification_email', sql: 'ALTER TABLE merchant_settings ADD COLUMN IF NOT EXISTS notification_email TEXT' },
            { column: 'low_stock_alerts_enabled', sql: 'ALTER TABLE merchant_settings ADD COLUMN IF NOT EXISTS low_stock_alerts_enabled BOOLEAN DEFAULT TRUE' }
        ];

        for (const migration of settingsColumnMigrations) {
            try {
                const colCheck = await query(`
                    SELECT column_name FROM information_schema.columns
                    WHERE table_name = 'merchant_settings' AND column_name = $1
                `, [migration.column]);

                if (colCheck.rows.length === 0) {
                    await query(migration.sql);
                    logger.info(`Added ${migration.column} column to merchant_settings`);
                    appliedCount++;
                }
            } catch (err) {
                logger.error(`Failed to add ${migration.column} column to merchant_settings`, { error: err.message });
            }
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

    // Create gmc_location_settings table if it doesn't exist (for multi-tenant GMC feeds)
    try {
        const gmcLocationSettingsCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'gmc_location_settings')
        `);

        if (!gmcLocationSettingsCheck.rows[0].exists) {
            await query(`
                CREATE TABLE gmc_location_settings (
                    id SERIAL PRIMARY KEY,
                    merchant_id INTEGER REFERENCES merchants(id) ON DELETE CASCADE,
                    location_id TEXT NOT NULL,
                    google_store_code TEXT,
                    enabled BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(merchant_id, location_id)
                )
            `);
            await query('CREATE INDEX IF NOT EXISTS idx_gmc_location_settings_merchant ON gmc_location_settings(merchant_id)');
            await query('CREATE INDEX IF NOT EXISTS idx_gmc_location_settings_location ON gmc_location_settings(location_id)');
            logger.info('Created gmc_location_settings table for multi-tenant GMC feeds');
            appliedCount++;
        }
    } catch (error) {
        logger.error('Failed to create gmc_location_settings table:', error.message);
    }

    // Create gmc_sync_logs table if it doesn't exist (for tracking GMC sync history)
    try {
        const gmcSyncLogsCheck = await query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'gmc_sync_logs')
        `);

        if (!gmcSyncLogsCheck.rows[0].exists) {
            await query(`
                CREATE TABLE gmc_sync_logs (
                    id SERIAL PRIMARY KEY,
                    merchant_id INTEGER REFERENCES merchants(id) ON DELETE CASCADE,
                    sync_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    total_items INTEGER DEFAULT 0,
                    succeeded INTEGER DEFAULT 0,
                    failed INTEGER DEFAULT 0,
                    error_details JSONB,
                    location_id TEXT,
                    location_name TEXT,
                    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    completed_at TIMESTAMP,
                    duration_ms INTEGER
                )
            `);
            await query('CREATE INDEX IF NOT EXISTS idx_gmc_sync_logs_merchant ON gmc_sync_logs(merchant_id)');
            await query('CREATE INDEX IF NOT EXISTS idx_gmc_sync_logs_started ON gmc_sync_logs(started_at DESC)');
            logger.info('Created gmc_sync_logs table for tracking GMC sync history');
            appliedCount++;
        }
    } catch (error) {
        logger.error('Failed to create gmc_sync_logs table:', error.message);
    }

    if (appliedCount > 0) {
        logger.info(`Schema check complete: ${appliedCount} migrations applied`);
    } else {
        logger.info('Schema check complete: database is up to date');
    }

    return appliedCount;
    } catch (error) {
        console.error('FATAL: ensureSchema() failed:', error.message);
        console.error(error.stack);
        throw error;
    }
}

// ==================== MERCHANT SETTINGS FUNCTIONS ====================

/**
 * Default merchant settings values (fallback to env vars or hardcoded defaults)
 */
const DEFAULT_MERCHANT_SETTINGS = {
    reorder_safety_days: parseInt(process.env.REORDER_SAFETY_DAYS) || 7,
    default_supply_days: parseInt(process.env.DEFAULT_SUPPLY_DAYS) || 45,
    reorder_priority_urgent_days: parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS) || 0,
    reorder_priority_high_days: parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS) || 7,
    reorder_priority_medium_days: parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS) || 14,
    reorder_priority_low_days: parseInt(process.env.REORDER_PRIORITY_LOW_DAYS) || 30,
    daily_count_target: parseInt(process.env.DAILY_COUNT_TARGET) || 30,
    cycle_count_email_enabled: process.env.CYCLE_COUNT_EMAIL_ENABLED !== 'false',
    cycle_count_report_email: process.env.CYCLE_COUNT_REPORT_EMAIL !== 'false',
    additional_cycle_count_email: process.env.ADDITIONAL_CYCLE_COUNT_REPORT_EMAIL || null,
    notification_email: process.env.EMAIL_TO || null,
    low_stock_alerts_enabled: true
};

/**
 * Get merchant settings from database with fallback to env var defaults
 * Creates default settings for merchant if none exist
 *
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Object>} Merchant settings object
 */
async function getMerchantSettings(merchantId) {
    if (!merchantId) {
        // No merchant context - return defaults from env vars
        return { ...DEFAULT_MERCHANT_SETTINGS };
    }

    try {
        // Try to get existing settings
        const result = await query(`
            SELECT * FROM merchant_settings WHERE merchant_id = $1
        `, [merchantId]);

        if (result.rows.length > 0) {
            // Merge with defaults (in case new columns were added)
            return {
                ...DEFAULT_MERCHANT_SETTINGS,
                ...result.rows[0]
            };
        }

        // No settings exist - create defaults for this merchant
        const insertResult = await query(`
            INSERT INTO merchant_settings (
                merchant_id,
                reorder_safety_days,
                default_supply_days,
                reorder_priority_urgent_days,
                reorder_priority_high_days,
                reorder_priority_medium_days,
                reorder_priority_low_days,
                daily_count_target,
                cycle_count_email_enabled,
                cycle_count_report_email,
                additional_cycle_count_email,
                notification_email,
                low_stock_alerts_enabled
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (merchant_id) DO UPDATE SET updated_at = NOW()
            RETURNING *
        `, [
            merchantId,
            DEFAULT_MERCHANT_SETTINGS.reorder_safety_days,
            DEFAULT_MERCHANT_SETTINGS.default_supply_days,
            DEFAULT_MERCHANT_SETTINGS.reorder_priority_urgent_days,
            DEFAULT_MERCHANT_SETTINGS.reorder_priority_high_days,
            DEFAULT_MERCHANT_SETTINGS.reorder_priority_medium_days,
            DEFAULT_MERCHANT_SETTINGS.reorder_priority_low_days,
            DEFAULT_MERCHANT_SETTINGS.daily_count_target,
            DEFAULT_MERCHANT_SETTINGS.cycle_count_email_enabled,
            DEFAULT_MERCHANT_SETTINGS.cycle_count_report_email,
            DEFAULT_MERCHANT_SETTINGS.additional_cycle_count_email,
            DEFAULT_MERCHANT_SETTINGS.notification_email,
            DEFAULT_MERCHANT_SETTINGS.low_stock_alerts_enabled
        ]);

        logger.info('Created default merchant settings', { merchantId });
        return insertResult.rows[0];

    } catch (error) {
        // If table doesn't exist yet (pre-migration), return defaults
        if (error.message.includes('relation "merchant_settings" does not exist')) {
            logger.warn('merchant_settings table does not exist yet, using defaults');
            return { ...DEFAULT_MERCHANT_SETTINGS };
        }
        logger.error('Failed to get merchant settings', { merchantId, error: error.message });
        return { ...DEFAULT_MERCHANT_SETTINGS };
    }
}

/**
 * Update merchant settings
 *
 * @param {number} merchantId - The merchant ID
 * @param {Object} settings - Settings to update
 * @returns {Promise<Object>} Updated settings
 */
async function updateMerchantSettings(merchantId, settings) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    // Build dynamic update query based on provided settings
    const allowedFields = [
        'reorder_safety_days', 'default_supply_days',
        'reorder_priority_urgent_days', 'reorder_priority_high_days',
        'reorder_priority_medium_days', 'reorder_priority_low_days',
        'daily_count_target', 'cycle_count_email_enabled',
        'cycle_count_report_email', 'additional_cycle_count_email',
        'notification_email', 'low_stock_alerts_enabled'
    ];

    const updates = [];
    const values = [merchantId];
    let paramIndex = 2;

    for (const field of allowedFields) {
        if (settings.hasOwnProperty(field)) {
            updates.push(`${field} = $${paramIndex}`);
            values.push(settings[field]);
            paramIndex++;
        }
    }

    if (updates.length === 0) {
        // No valid updates - just return current settings
        return getMerchantSettings(merchantId);
    }

    updates.push('updated_at = NOW()');

    const result = await query(`
        UPDATE merchant_settings
        SET ${updates.join(', ')}
        WHERE merchant_id = $1
        RETURNING *
    `, values);

    if (result.rows.length === 0) {
        // Settings don't exist - create them first, then update
        await getMerchantSettings(merchantId); // This creates defaults
        return updateMerchantSettings(merchantId, settings); // Retry update
    }

    logger.info('Updated merchant settings', { merchantId, fields: Object.keys(settings) });
    return result.rows[0];
}

/**
 * Get a specific setting value with fallback
 *
 * @param {number} merchantId - The merchant ID
 * @param {string} settingKey - The setting key (e.g., 'reorder_safety_days')
 * @returns {Promise<any>} The setting value
 */
async function getMerchantSetting(merchantId, settingKey) {
    const settings = await getMerchantSettings(merchantId);
    return settings[settingKey] ?? DEFAULT_MERCHANT_SETTINGS[settingKey];
}

module.exports = {
    query,
    getClient,
    transaction,
    batchUpsert,
    testConnection,
    ensureSchema,
    close,
    pool,
    // Merchant settings functions
    getMerchantSettings,
    updateMerchantSettings,
    getMerchantSetting,
    DEFAULT_MERCHANT_SETTINGS
};
