/**
 * MerchantDB - Database wrapper for multi-tenant queries
 * Automatically adds merchant_id filtering to all queries
 *
 * Usage:
 *   const MerchantDB = require('./utils/merchant-db');
 *   const merchantDb = new MerchantDB(req.merchantContext.id);
 *
 *   // Queries automatically filter by merchant
 *   const items = await merchantDb.getItems();
 *   const vendors = await merchantDb.query(
 *       'SELECT * FROM vendors WHERE merchant_id = $merchant_id AND name ILIKE $1',
 *       ['%coffee%']
 *   );
 */

const db = require('./database');
const logger = require('./logger');

class MerchantDB {
    /**
     * Create a new MerchantDB instance
     * @param {number} merchantId - The merchant ID for filtering
     */
    constructor(merchantId) {
        if (!merchantId) {
            throw new Error('MerchantDB requires a merchantId');
        }
        if (typeof merchantId !== 'number' || !Number.isInteger(merchantId)) {
            throw new Error('merchantId must be an integer');
        }
        this.merchantId = merchantId;
    }

    /**
     * Execute a query with automatic merchant_id parameter
     * Use $merchant_id placeholder in your query - it will be replaced with the actual parameter
     *
     * @param {string} text - SQL query with optional $merchant_id placeholder
     * @param {Array} params - Query parameters (do NOT include merchant_id)
     * @returns {Object} Query result
     */
    async query(text, params = []) {
        // Replace $merchant_id placeholder with the next parameter position
        const merchantParamIndex = params.length + 1;
        const modifiedText = text.replace(/\$merchant_id/g, `$${merchantParamIndex}`);

        // Only add merchantId if the query contains the placeholder
        const modifiedParams = text.includes('$merchant_id')
            ? [...params, this.merchantId]
            : params;

        return db.query(modifiedText, modifiedParams);
    }

    /**
     * Raw query without automatic merchant_id (use with caution)
     * Prefer using query() with $merchant_id placeholder
     */
    async rawQuery(text, params = []) {
        return db.query(text, params);
    }

    // =========================================================================
    // CATALOG QUERIES
    // =========================================================================

    /**
     * Get items for this merchant
     * @param {Object} options - Query options
     * @returns {Object} Query result with rows
     */
    async getItems(options = {}) {
        const {
            includeDeleted = false,
            categoryId = null,
            search = null,
            limit = 1000,
            offset = 0
        } = options;

        let query = `
            SELECT i.*, c.name as category_name
            FROM items i
            LEFT JOIN categories c ON c.id = i.category_id AND c.merchant_id = $merchant_id
            WHERE i.merchant_id = $merchant_id
        `;
        const params = [];

        if (!includeDeleted) {
            query += ` AND i.is_deleted = FALSE`;
        }

        if (categoryId) {
            params.push(categoryId);
            query += ` AND i.category_id = $${params.length}`;
        }

        if (search) {
            params.push(`%${search}%`);
            query += ` AND (i.name ILIKE $${params.length} OR i.description ILIKE $${params.length})`;
        }

        // Parameterize LIMIT and OFFSET to prevent SQL injection
        params.push(parseInt(limit) || 1000, parseInt(offset) || 0);
        query += ` ORDER BY i.name LIMIT $${params.length - 1} OFFSET $${params.length}`;

        return this.query(query, params);
    }

    /**
     * Get a single item by ID
     * @param {string} itemId - The item ID
     * @returns {Object|null} Item row or null
     */
    async getItemById(itemId) {
        const result = await this.query(
            `SELECT * FROM items WHERE id = $1 AND merchant_id = $merchant_id`,
            [itemId]
        );
        return result.rows[0] || null;
    }

    /**
     * Get variations for this merchant
     * @param {Object} options - Query options
     */
    async getVariations(options = {}) {
        const {
            itemId = null,
            includeDeleted = false,
            search = null,
            limit = 5000
        } = options;

        let query = `
            SELECT
                v.*,
                i.name as item_name,
                i.category_id,
                c.name as category_name
            FROM variations v
            JOIN items i ON i.id = v.item_id AND i.merchant_id = $merchant_id
            LEFT JOIN categories c ON c.id = i.category_id AND c.merchant_id = $merchant_id
            WHERE v.merchant_id = $merchant_id
        `;
        const params = [];

        if (!includeDeleted) {
            query += ` AND v.is_deleted = FALSE`;
        }

        if (itemId) {
            params.push(itemId);
            query += ` AND v.item_id = $${params.length}`;
        }

        if (search) {
            params.push(`%${search}%`);
            query += ` AND (v.name ILIKE $${params.length} OR v.sku ILIKE $${params.length} OR i.name ILIKE $${params.length})`;
        }

        // Parameterize LIMIT to prevent SQL injection
        params.push(parseInt(limit) || 5000);
        query += ` ORDER BY i.name, v.name LIMIT $${params.length}`;

        return this.query(query, params);
    }

    /**
     * Get a single variation by ID
     */
    async getVariationById(variationId) {
        const result = await this.query(
            `SELECT v.*, i.name as item_name
             FROM variations v
             JOIN items i ON i.id = v.item_id
             WHERE v.id = $1 AND v.merchant_id = $merchant_id`,
            [variationId]
        );
        return result.rows[0] || null;
    }

    /**
     * Get categories for this merchant
     */
    async getCategories() {
        return this.query(
            `SELECT * FROM categories WHERE merchant_id = $merchant_id ORDER BY name`
        );
    }

    /**
     * Get locations for this merchant
     */
    async getLocations(activeOnly = true) {
        let query = `SELECT * FROM locations WHERE merchant_id = $merchant_id`;
        if (activeOnly) {
            query += ` AND active = TRUE`;
        }
        query += ` ORDER BY name`;
        return this.query(query);
    }

    // =========================================================================
    // INVENTORY QUERIES
    // =========================================================================

    /**
     * Get inventory counts for a location
     * @param {string} locationId - Location ID
     */
    async getInventory(locationId) {
        return this.query(`
            SELECT
                ic.*,
                v.name as variation_name,
                v.sku,
                i.name as item_name,
                i.category_id
            FROM inventory_counts ic
            JOIN variations v ON v.id = ic.catalog_object_id AND v.merchant_id = $merchant_id
            JOIN items i ON i.id = v.item_id AND i.merchant_id = $merchant_id
            WHERE ic.merchant_id = $merchant_id
                AND ic.location_id = $1
            ORDER BY i.name, v.name
        `, [locationId]);
    }

    /**
     * Get inventory for a specific variation across all locations
     */
    async getVariationInventory(variationId) {
        return this.query(`
            SELECT ic.*, l.name as location_name
            FROM inventory_counts ic
            JOIN locations l ON l.id = ic.location_id AND l.merchant_id = $merchant_id
            WHERE ic.catalog_object_id = $1 AND ic.merchant_id = $merchant_id
        `, [variationId]);
    }

    // =========================================================================
    // VENDOR QUERIES
    // =========================================================================

    /**
     * Get vendors for this merchant
     */
    async getVendors(options = {}) {
        const { search = null, status = null } = options;

        let query = `SELECT * FROM vendors WHERE merchant_id = $merchant_id`;
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }

        if (search) {
            params.push(`%${search}%`);
            query += ` AND name ILIKE $${params.length}`;
        }

        query += ` ORDER BY name`;

        return this.query(query, params);
    }

    /**
     * Get vendor by ID
     */
    async getVendorById(vendorId) {
        const result = await this.query(
            `SELECT * FROM vendors WHERE id = $1 AND merchant_id = $merchant_id`,
            [vendorId]
        );
        return result.rows[0] || null;
    }

    /**
     * Get variation-vendor relationships
     */
    async getVariationVendors(variationId = null) {
        let query = `
            SELECT vv.*, v.name as vendor_name
            FROM variation_vendors vv
            JOIN vendors v ON v.id = vv.vendor_id AND v.merchant_id = $merchant_id
            WHERE vv.merchant_id = $merchant_id
        `;
        const params = [];

        if (variationId) {
            params.push(variationId);
            query += ` AND vv.variation_id = $${params.length}`;
        }

        return this.query(query, params);
    }

    // =========================================================================
    // PURCHASE ORDER QUERIES
    // =========================================================================

    /**
     * Get purchase orders
     */
    async getPurchaseOrders(options = {}) {
        const {
            status = null,
            vendorId = null,
            locationId = null,
            limit = 100
        } = options;

        let query = `
            SELECT
                po.*,
                v.name as vendor_name,
                l.name as location_name
            FROM purchase_orders po
            JOIN vendors v ON v.id = po.vendor_id AND v.merchant_id = $merchant_id
            JOIN locations l ON l.id = po.location_id AND l.merchant_id = $merchant_id
            WHERE po.merchant_id = $merchant_id
        `;
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND po.status = $${params.length}`;
        }

        if (vendorId) {
            params.push(vendorId);
            query += ` AND po.vendor_id = $${params.length}`;
        }

        if (locationId) {
            params.push(locationId);
            query += ` AND po.location_id = $${params.length}`;
        }

        // Parameterize LIMIT to prevent SQL injection
        params.push(parseInt(limit) || 100);
        query += ` ORDER BY po.created_at DESC LIMIT $${params.length}`;

        return this.query(query, params);
    }

    /**
     * Get purchase order by ID with line items
     */
    async getPurchaseOrderById(poId) {
        const poResult = await this.query(
            `SELECT po.*, v.name as vendor_name, l.name as location_name
             FROM purchase_orders po
             JOIN vendors v ON v.id = po.vendor_id
             JOIN locations l ON l.id = po.location_id
             WHERE po.id = $1 AND po.merchant_id = $merchant_id`,
            [poId]
        );

        if (poResult.rows.length === 0) {
            return null;
        }

        const itemsResult = await this.query(
            `SELECT poi.*, var.name as variation_name, var.sku, i.name as item_name
             FROM purchase_order_items poi
             JOIN variations var ON var.id = poi.variation_id
             JOIN items i ON i.id = var.item_id
             WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $merchant_id`,
            [poId]
        );

        return {
            ...poResult.rows[0],
            items: itemsResult.rows
        };
    }

    // =========================================================================
    // SALES VELOCITY QUERIES
    // =========================================================================

    /**
     * Get sales velocity data
     */
    async getSalesVelocity(options = {}) {
        const {
            locationId = null,
            variationId = null,
            periodDays = 91
        } = options;

        let query = `
            SELECT sv.*, v.name as variation_name, v.sku, i.name as item_name
            FROM sales_velocity sv
            JOIN variations v ON v.id = sv.variation_id AND v.merchant_id = $merchant_id
            JOIN items i ON i.id = v.item_id AND i.merchant_id = $merchant_id
            WHERE sv.merchant_id = $merchant_id AND sv.period_days = $1
        `;
        const params = [periodDays];

        if (locationId) {
            params.push(locationId);
            query += ` AND sv.location_id = $${params.length}`;
        }

        if (variationId) {
            params.push(variationId);
            query += ` AND sv.variation_id = $${params.length}`;
        }

        return this.query(query, params);
    }

    // =========================================================================
    // CRUD OPERATIONS
    // =========================================================================

    /**
     * Insert a new record with merchant_id automatically set
     * @param {string} table - Table name
     * @param {Object} data - Data to insert (merchant_id added automatically)
     * @returns {Object} Inserted row
     */
    async insert(table, data) {
        const dataWithMerchant = { ...data, merchant_id: this.merchantId };
        const columns = Object.keys(dataWithMerchant);
        const values = Object.values(dataWithMerchant);
        const placeholders = columns.map((_, i) => `$${i + 1}`);

        const query = `
            INSERT INTO ${this._sanitizeTableName(table)} (${columns.join(', ')})
            VALUES (${placeholders.join(', ')})
            RETURNING *
        `;

        const result = await db.query(query, values);
        return result.rows[0];
    }

    /**
     * Update records with merchant_id filter
     * @param {string} table - Table name
     * @param {string|number} id - Record ID
     * @param {Object} data - Data to update
     * @returns {Object|null} Updated row or null if not found
     */
    async update(table, id, data) {
        const columns = Object.keys(data);
        const values = Object.values(data);
        const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');

        const query = `
            UPDATE ${this._sanitizeTableName(table)}
            SET ${setClause}, updated_at = NOW()
            WHERE id = $${values.length + 1} AND merchant_id = $${values.length + 2}
            RETURNING *
        `;

        const result = await db.query(query, [...values, id, this.merchantId]);
        return result.rows[0] || null;
    }

    /**
     * Delete a record with merchant_id filter
     * @param {string} table - Table name
     * @param {string|number} id - Record ID
     * @returns {Object|null} Deleted row or null if not found
     */
    async delete(table, id) {
        const query = `
            DELETE FROM ${this._sanitizeTableName(table)}
            WHERE id = $1 AND merchant_id = $2
            RETURNING *
        `;

        const result = await db.query(query, [id, this.merchantId]);
        return result.rows[0] || null;
    }

    /**
     * Soft delete (set is_deleted = true)
     */
    async softDelete(table, id) {
        return this.update(table, id, {
            is_deleted: true,
            deleted_at: new Date()
        });
    }

    /**
     * Count records in a table
     */
    async count(table, where = {}) {
        let query = `SELECT COUNT(*) as count FROM ${this._sanitizeTableName(table)} WHERE merchant_id = $merchant_id`;
        const params = [];

        for (const [key, value] of Object.entries(where)) {
            // Validate column name to prevent SQL injection
            if (!this._isValidColumnName(key)) {
                throw new Error(`Invalid column name: ${key}`);
            }
            params.push(value);
            query += ` AND ${key} = $${params.length}`;
        }

        const result = await this.query(query, params);
        return parseInt(result.rows[0].count, 10);
    }

    /**
     * Check if a record exists
     */
    async exists(table, id) {
        const result = await this.query(
            `SELECT 1 FROM ${this._sanitizeTableName(table)} WHERE id = $1 AND merchant_id = $merchant_id`,
            [id]
        );
        return result.rows.length > 0;
    }

    /**
     * Get sync history for this merchant
     */
    async getSyncHistory(syncType = null, limit = 10) {
        let query = `
            SELECT * FROM sync_history
            WHERE merchant_id = $merchant_id
        `;
        const params = [];

        if (syncType) {
            params.push(syncType);
            query += ` AND sync_type = $${params.length}`;
        }

        // Parameterize LIMIT to prevent SQL injection
        params.push(parseInt(limit) || 10);
        query += ` ORDER BY started_at DESC LIMIT $${params.length}`;

        return this.query(query, params);
    }

    /**
     * Simple table name sanitization to prevent SQL injection
     * Only allows alphanumeric and underscore
     */
    _sanitizeTableName(table) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
            throw new Error(`Invalid table name: ${table}`);
        }
        return table;
    }

    /**
     * Validate column name to prevent SQL injection
     * Only allows alphanumeric and underscore, must start with letter or underscore
     */
    _isValidColumnName(column) {
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column);
    }
}

module.exports = MerchantDB;
