/**
 * Square API Integration Module
 * Handles all Square API calls and data synchronization
 */

const fetch = require('node-fetch');
const db = require('./database');
const logger = require('./logger');

// Square API configuration
const SQUARE_API_VERSION = '2024-10-17';
const SQUARE_BASE_URL = 'https://connect.squareup.com';
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

// Rate limiting and retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Make a Square API request with error handling and retry logic
 * @param {string} endpoint - API endpoint path
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Response data
 */
async function makeSquareRequest(endpoint, options = {}) {
    const url = `${SQUARE_BASE_URL}${endpoint}`;
    const headers = {
        'Square-Version': SQUARE_API_VERSION,
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        ...options.headers
    };

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers
            });

            const data = await response.json();

            if (!response.ok) {
                // Handle rate limiting
                if (response.status === 429) {
                    const retryAfter = parseInt(response.headers.get('retry-after') || '5');
                    logger.warn(`Rate limited. Retrying after ${retryAfter} seconds`);
                    await sleep(retryAfter * 1000);
                    continue;
                }

                // Handle auth errors
                if (response.status === 401) {
                    throw new Error('Square API authentication failed. Check your access token.');
                }

                throw new Error(`Square API error: ${response.status} - ${JSON.stringify(data.errors || data)}`);
            }

            return data;
        } catch (error) {
            lastError = error;
            if (attempt < MAX_RETRIES - 1) {
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                logger.warn(`Request failed, retrying in ${delay}ms`, { attempt: attempt + 1, max_retries: MAX_RETRIES });
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

/**
 * Sleep utility for delays
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sync locations from Square
 * @returns {Promise<number>} Number of locations synced
 */
async function syncLocations() {
    logger.info('Starting location sync');

    try {
        const data = await makeSquareRequest('/v2/locations');
        const locations = data.locations || [];

        let synced = 0;
        for (const loc of locations) {
            await db.query(`
                INSERT INTO locations (id, name, square_location_id, active, address, timezone, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    square_location_id = EXCLUDED.square_location_id,
                    active = EXCLUDED.active,
                    address = EXCLUDED.address,
                    timezone = EXCLUDED.timezone,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                loc.id,
                loc.name,
                loc.id,
                loc.status === 'ACTIVE',
                loc.address ? JSON.stringify(loc.address) : null,
                loc.timezone
            ]);
            synced++;
        }

        logger.info('Location sync complete', { count: synced });
        return synced;
    } catch (error) {
        logger.error('Location sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync vendors from Square
 * @returns {Promise<number>} Number of vendors synced
 */
async function syncVendors() {
    logger.info('Starting vendor sync');

    try {
        let cursor = null;
        let totalSynced = 0;

        do {
            const requestBody = {
                filter: {
                    status: ['ACTIVE', 'INACTIVE']  // ✅ CORRECT (singular, not plural)
                },
                limit: 100  // Add for better performance
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/vendors/search', {
                method: 'POST',
                body: JSON.stringify(requestBody)
            });

            const vendors = data.vendors || [];

            for (const vendor of vendors) {
                await db.query(`
                    INSERT INTO vendors (
                        id, name, status, contact_name, contact_email, contact_phone, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        status = EXCLUDED.status,
                        contact_name = EXCLUDED.contact_name,
                        contact_email = EXCLUDED.contact_email,
                        contact_phone = EXCLUDED.contact_phone,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    vendor.id,
                    vendor.name,
                    vendor.status,
                    vendor.contacts?.[0]?.name || null,
                    vendor.contacts?.[0]?.email_address || null,
                    vendor.contacts?.[0]?.phone_number || null
                ]);
                totalSynced++;
            }

            cursor = data.cursor;
            logger.info('Vendor sync progress', { count: totalSynced });

        } while (cursor);

        logger.info('Vendor sync complete', { count: totalSynced });
        return totalSynced;
    } catch (error) {
        logger.error('Vendor sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync catalog (categories, images, items, variations) from Square
 * @returns {Promise<Object>} Sync statistics
 */
async function syncCatalog() {
    logger.info('Starting catalog sync');

    const stats = {
        categories: 0,
        images: 0,
        items: 0,
        variations: 0,
        variationVendors: 0,
        items_deleted: 0,
        variations_deleted: 0,
        inventory_zeroed: 0
    };

    // Track all IDs returned by Square API
    const syncedItemIds = new Set();
    const syncedVariationIds = new Set();

    // Build a map of categories for looking up category names
    const categoriesMap = new Map();

    try {
        // Collect all objects from all pages first
        let cursor = null;
        const allObjects = [];

        do {
            const endpoint = `/v2/catalog/list?types=ITEM,ITEM_VARIATION,IMAGE,CATEGORY&include_deleted_objects=false${cursor ? `&cursor=${cursor}` : ''}`;
            const data = await makeSquareRequest(endpoint);

            const objects = data.objects || [];
            allObjects.push(...objects);

            cursor = data.cursor;
            logger.info('Fetching catalog objects', { fetched: allObjects.length });

        } while (cursor);

        logger.info('All catalog objects fetched', { total: allObjects.length });

        // Process in two passes to ensure categories are loaded before items

        // PASS 1: Process categories first to build the categoriesMap
        for (const obj of allObjects) {
            try {
                if (obj.type === 'CATEGORY') {
                    await syncCategory(obj);
                    // Store category object in map for lookup when processing items
                    categoriesMap.set(obj.id, obj.category_data || obj);
                    stats.categories++;
                }
            } catch (error) {
                logger.error(`Failed to sync ${obj.type}`, { id: obj.id, error: error.message });
            }
        }

        logger.info('Categories synced', { count: stats.categories });

        // PASS 2: Process items, variations, and images (categories are now all loaded)
        for (const obj of allObjects) {
            try {
                if (obj.type === 'IMAGE') {
                    await syncImage(obj);
                    stats.images++;
                } else if (obj.type === 'ITEM') {
                    syncedItemIds.add(obj.id);
                    await syncItem(obj, categoriesMap);
                    stats.items++;
                } else if (obj.type === 'ITEM_VARIATION') {
                    syncedVariationIds.add(obj.id);
                    const vendorCount = await syncVariation(obj);
                    stats.variations++;
                    stats.variationVendors += vendorCount;
                }
            } catch (error) {
                logger.error(`Failed to sync ${obj.type}`, { id: obj.id, error: error.message });
            }
        }

        logger.info('Catalog sync complete', stats);

        // ===== DETECT DELETIONS =====
        logger.info('Detecting deleted items');

        // Get all non-deleted items from database
        const dbItemsResult = await db.query(`
            SELECT id, name FROM items WHERE is_deleted = FALSE
        `);

        const dbVariationsResult = await db.query(`
            SELECT id, name, sku FROM variations WHERE is_deleted = FALSE
        `);

        // Find items in DB but NOT in Square sync (they were deleted)
        let itemsMarkedDeleted = 0;
        let variationsMarkedDeleted = 0;
        let inventoryZeroed = 0;

        for (const row of dbItemsResult.rows) {
            if (!syncedItemIds.has(row.id)) {
                // Item was deleted in Square
                await db.query(`
                    UPDATE items
                    SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [row.id]);

                // Zero inventory for all variations of this item
                const invResult = await db.query(`
                    UPDATE inventory_counts
                    SET quantity = 0, updated_at = CURRENT_TIMESTAMP
                    WHERE catalog_object_id IN (
                        SELECT id FROM variations WHERE item_id = $1
                    )
                `, [row.id]);

                inventoryZeroed += invResult.rowCount;
                itemsMarkedDeleted++;
                logger.info('Item marked as deleted', { name: row.name, id: row.id, locations_zeroed: invResult.rowCount });
            }
        }

        for (const row of dbVariationsResult.rows) {
            if (!syncedVariationIds.has(row.id)) {
                // Variation was deleted in Square
                await db.query(`
                    UPDATE variations
                    SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [row.id]);

                // Zero inventory for this variation
                const invResult = await db.query(`
                    UPDATE inventory_counts
                    SET quantity = 0, updated_at = CURRENT_TIMESTAMP
                    WHERE catalog_object_id = $1
                `, [row.id]);

                inventoryZeroed += invResult.rowCount;
                variationsMarkedDeleted++;
                logger.info('Variation marked as deleted', { name: row.name, sku: row.sku || 'N/A', locations_zeroed: invResult.rowCount });
            }
        }

        logger.info('Deletion detection complete', { items_deleted: itemsMarkedDeleted, variations_deleted: variationsMarkedDeleted });

        // Add to stats
        stats.items_deleted = itemsMarkedDeleted;
        stats.variations_deleted = variationsMarkedDeleted;
        stats.inventory_zeroed += inventoryZeroed;

        return stats;
    } catch (error) {
        logger.error('Catalog sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync a category object
 */
async function syncCategory(obj) {
    await db.query(`
        INSERT INTO categories (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name
    `, [
        obj.id,
        obj.category_data?.name || 'Uncategorized'
    ]);
}

/**
 * Sync an image object
 */
async function syncImage(obj) {
    await db.query(`
        INSERT INTO images (id, name, url, caption)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            url = EXCLUDED.url,
            caption = EXCLUDED.caption
    `, [
        obj.id,
        obj.image_data?.name || null,
        obj.image_data?.url || null,
        obj.image_data?.caption || null
    ]);
}

/**
 * Sync an item object
 * @param {Object} obj - Item object from Square API
 * @param {Map} categoriesMap - Map of category IDs to names
 */
async function syncItem(obj, categoriesMap) {
    const data = obj.item_data;

    // Look up category name from the map using category_id
    const category_name = data.category_id ? categoriesMap.get(data.category_id)?.name : null;

    await db.query(`
        INSERT INTO items (
            id, name, description, category_id, category_name, product_type,
            taxable, visibility, present_at_all_locations, present_at_location_ids,
            absent_at_location_ids, modifier_list_info, item_options, images,
            available_online, available_for_pickup, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            category_id = EXCLUDED.category_id,
            category_name = EXCLUDED.category_name,
            product_type = EXCLUDED.product_type,
            taxable = EXCLUDED.taxable,
            visibility = EXCLUDED.visibility,
            present_at_all_locations = EXCLUDED.present_at_all_locations,
            present_at_location_ids = EXCLUDED.present_at_location_ids,
            absent_at_location_ids = EXCLUDED.absent_at_location_ids,
            modifier_list_info = EXCLUDED.modifier_list_info,
            item_options = EXCLUDED.item_options,
            images = EXCLUDED.images,
            available_online = EXCLUDED.available_online,
            available_for_pickup = EXCLUDED.available_for_pickup,
            updated_at = CURRENT_TIMESTAMP
    `, [
        obj.id,
        data.name,
        data.description || null,
        data.category_id || null,
        category_name || null,
        data.product_type || null,
        data.is_taxable || false,
        obj.visibility || 'PRIVATE',
        obj.present_at_all_locations !== false,
        obj.present_at_location_ids ? JSON.stringify(obj.present_at_location_ids) : null,
        obj.absent_at_location_ids ? JSON.stringify(obj.absent_at_location_ids) : null,
        data.modifier_list_info ? JSON.stringify(data.modifier_list_info) : null,
        data.item_options ? JSON.stringify(data.item_options) : null,
        data.image_ids ? JSON.stringify(data.image_ids) : null,
        data.available_online || false,
        data.available_for_pickup || false
    ]);
}

/**
 * Sync a variation object and its vendor information
 * @returns {number} Number of vendor relationships created
 */
async function syncVariation(obj) {
    const data = obj.item_variation_data;
    let vendorCount = 0;

    // Insert/update variation
    await db.query(`
        INSERT INTO variations (
            id, item_id, name, sku, upc, price_money, currency, pricing_type,
            track_inventory, inventory_alert_type, inventory_alert_threshold,
            present_at_all_locations, present_at_location_ids, absent_at_location_ids,
            item_option_values, custom_attributes, images, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
            item_id = EXCLUDED.item_id,
            name = EXCLUDED.name,
            sku = EXCLUDED.sku,
            upc = EXCLUDED.upc,
            price_money = EXCLUDED.price_money,
            currency = EXCLUDED.currency,
            pricing_type = EXCLUDED.pricing_type,
            track_inventory = EXCLUDED.track_inventory,
            inventory_alert_type = EXCLUDED.inventory_alert_type,
            inventory_alert_threshold = EXCLUDED.inventory_alert_threshold,
            present_at_all_locations = EXCLUDED.present_at_all_locations,
            present_at_location_ids = EXCLUDED.present_at_location_ids,
            absent_at_location_ids = EXCLUDED.absent_at_location_ids,
            item_option_values = EXCLUDED.item_option_values,
            custom_attributes = EXCLUDED.custom_attributes,
            images = EXCLUDED.images,
            updated_at = CURRENT_TIMESTAMP
    `, [
        obj.id,
        data.item_id,
        data.name || 'Regular',
        data.sku || null,
        data.upc || null,
        data.price_money?.amount || null,
        data.price_money?.currency || 'CAD',
        data.pricing_type || 'FIXED_PRICING',
        data.track_inventory !== false,
        data.inventory_alert_type || null,
        data.inventory_alert_threshold || null,
        obj.present_at_all_locations !== false,
        obj.present_at_location_ids ? JSON.stringify(obj.present_at_location_ids) : null,
        obj.absent_at_location_ids ? JSON.stringify(obj.absent_at_location_ids) : null,
        data.item_option_values ? JSON.stringify(data.item_option_values) : null,
        obj.custom_attribute_values ? JSON.stringify(obj.custom_attribute_values) : null,
        data.image_ids ? JSON.stringify(data.image_ids) : null
    ]);

    // Sync location-specific settings from location_overrides
    if (data.location_overrides && Array.isArray(data.location_overrides)) {
        for (const override of data.location_overrides) {
            try {
                await db.query(`
                    INSERT INTO variation_location_settings (
                        variation_id, location_id,
                        stock_alert_min, stock_alert_max,
                        active, updated_at
                    )
                    VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP)
                    ON CONFLICT (variation_id, location_id) DO UPDATE SET
                        stock_alert_min = EXCLUDED.stock_alert_min,
                        stock_alert_max = EXCLUDED.stock_alert_max,
                        active = EXCLUDED.active,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    obj.id,
                    override.location_id,
                    override.inventory_alert_threshold || null,
                    null  // stock_alert_max not available in Square API
                ]);
            } catch (error) {
                logger.error('Error syncing location override', { variation_id: obj.id, location_id: override.location_id, error: error.message });
            }
        }
    }

    // Sync vendor information
    if (data.vendor_information && Array.isArray(data.vendor_information)) {
        for (const vendorInfo of data.vendor_information) {
            try {
                await db.query(`
                    INSERT INTO variation_vendors (
                        variation_id, vendor_id, vendor_code, unit_cost_money, currency, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                    ON CONFLICT (variation_id, vendor_id) DO UPDATE SET
                        vendor_code = EXCLUDED.vendor_code,
                        unit_cost_money = EXCLUDED.unit_cost_money,
                        currency = EXCLUDED.currency,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    obj.id,
                    vendorInfo.vendor_id,
                    vendorInfo.vendor_code || null,
                    vendorInfo.unit_cost_money?.amount || null,
                    vendorInfo.unit_cost_money?.currency || 'CAD'
                ]);
                vendorCount++;
            } catch (error) {
                // Vendor might not exist yet, skip
                logger.warn('Skipping vendor - not found in database', { vendor_id: vendorInfo.vendor_id, variation_id: obj.id });
            }
        }
    }

    return vendorCount;
}

/**
 * Sync inventory counts from Square
 * @returns {Promise<number>} Number of inventory records synced
 */
async function syncInventory() {
    logger.info('Starting inventory sync');

    try {
        // Get all locations
        const locationsResult = await db.query('SELECT id FROM locations WHERE active = TRUE');
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found. Run location sync first');
            return 0;
        }

        // Get all variation IDs from database
        const variationsResult = await db.query('SELECT id FROM variations');
        const catalogObjectIds = variationsResult.rows.map(r => r.id);

        if (catalogObjectIds.length === 0) {
            logger.warn('No variations found. Run catalog sync first');
            return 0;
        }

        let totalSynced = 0;

        // Process in batches of 100 (Square API limit)
        const batchSize = 100;
        for (let i = 0; i < catalogObjectIds.length; i += batchSize) {
            const batch = catalogObjectIds.slice(i, i + batchSize);

            const requestBody = {
                catalog_object_ids: batch,
                location_ids: locationIds,
                states: ['IN_STOCK']
            };

            try {
                const data = await makeSquareRequest('/v2/inventory/counts/batch-retrieve', {
                    method: 'POST',
                    body: JSON.stringify(requestBody)
                });

                const counts = data.counts || [];

                for (const count of counts) {
                    await db.query(`
                        INSERT INTO inventory_counts (
                            catalog_object_id, location_id, state, quantity, updated_at
                        )
                        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                        ON CONFLICT (catalog_object_id, location_id, state) DO UPDATE SET
                            quantity = EXCLUDED.quantity,
                            updated_at = CURRENT_TIMESTAMP
                    `, [
                        count.catalog_object_id,
                        count.location_id,
                        count.state,
                        parseInt(count.quantity) || 0
                    ]);
                    totalSynced++;
                }

                logger.info('Inventory sync batch complete', { batch: Math.floor(i / batchSize) + 1, total_synced: totalSynced });
            } catch (error) {
                logger.error('Inventory sync batch failed', { batch: Math.floor(i / batchSize) + 1, error: error.message });
                // Continue with next batch
            }

            // Small delay to avoid rate limiting
            await sleep(100);
        }

        logger.info('Inventory sync complete', { records: totalSynced });
        return totalSynced;
    } catch (error) {
        logger.error('Inventory sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync sales velocity for a specific time period
 * @param {number} periodDays - Number of days to analyze (91, 182, or 365)
 * @returns {Promise<number>} Number of variations with velocity data
 */
async function syncSalesVelocity(periodDays = 91) {
    logger.info('Starting sales velocity sync', { period_days: periodDays });

    try {
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - periodDays);

        // Get all active locations
        const locationsResult = await db.query('SELECT id FROM locations WHERE active = TRUE');
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found');
            return 0;
        }

        // Aggregate sales data by variation and location
        const salesData = new Map();

        let cursor = null;
        let ordersProcessed = 0;

        do {
            const requestBody = {
                location_ids: locationIds,
                query: {
                    filter: {
                        state_filter: {
                            states: ['COMPLETED']
                        },
                        date_time_filter: {
                            closed_at: {
                                start_at: startDate.toISOString(),
                                end_at: endDate.toISOString()
                            }
                        }
                    }
                },
                limit: 50
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/orders/search', {
                method: 'POST',
                body: JSON.stringify(requestBody)
            });

            const orders = data.orders || [];

            // Process each order
            for (const order of orders) {
                if (!order.line_items) continue;

                for (const lineItem of order.line_items) {
                    const variationId = lineItem.catalog_object_id;
                    const locationId = order.location_id;

                    if (!variationId || !locationId) continue;

                    const key = `${variationId}:${locationId}`;

                    if (!salesData.has(key)) {
                        salesData.set(key, {
                            variation_id: variationId,
                            location_id: locationId,
                            total_quantity: 0,
                            total_revenue: 0
                        });
                    }

                    const data = salesData.get(key);
                    data.total_quantity += parseFloat(lineItem.quantity) || 0;
                    data.total_revenue += parseInt(lineItem.total_money?.amount) || 0;
                }
            }

            ordersProcessed += orders.length;
            cursor = data.cursor;
            logger.info('Sales velocity sync progress', { orders_processed: ordersProcessed });

        } while (cursor);

        // Save velocity data to database
        let savedCount = 0;
        for (const [key, data] of salesData.entries()) {
            const dailyAvg = data.total_quantity / periodDays;
            const weeklyAvg = data.total_quantity / (periodDays / 7);
            const monthlyAvg = data.total_quantity / (periodDays / 30);
            const dailyRevenueAvg = data.total_revenue / periodDays;

            try {
                await db.query(`
                    INSERT INTO sales_velocity (
                        variation_id, location_id, period_days,
                        total_quantity_sold, total_revenue_cents,
                        period_start_date, period_end_date,
                        daily_avg_quantity, daily_avg_revenue_cents,
                        weekly_avg_quantity, monthly_avg_quantity,
                        updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
                    ON CONFLICT (variation_id, location_id, period_days) DO UPDATE SET
                        total_quantity_sold = EXCLUDED.total_quantity_sold,
                        total_revenue_cents = EXCLUDED.total_revenue_cents,
                        period_start_date = EXCLUDED.period_start_date,
                        period_end_date = EXCLUDED.period_end_date,
                        daily_avg_quantity = EXCLUDED.daily_avg_quantity,
                        daily_avg_revenue_cents = EXCLUDED.daily_avg_revenue_cents,
                        weekly_avg_quantity = EXCLUDED.weekly_avg_quantity,
                        monthly_avg_quantity = EXCLUDED.monthly_avg_quantity,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    data.variation_id,
                    data.location_id,
                    periodDays,
                    data.total_quantity,
                    data.total_revenue,
                    startDate,
                    endDate,
                    dailyAvg,
                    dailyRevenueAvg,
                    weeklyAvg,
                    monthlyAvg
                ]);
                savedCount++;
            } catch (error) {
                // Variation might not exist in our database
                logger.warn('Skipping velocity for variation - not found in database', { variation_id: data.variation_id });
            }
        }

        logger.info('Sales velocity sync complete', { combinations: savedCount, period_days: periodDays });
        return savedCount;
    } catch (error) {
        logger.error('Sales velocity sync failed', { period_days: periodDays, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Run full sync of all data from Square
 * @returns {Promise<Object>} Sync summary
 */
async function fullSync() {
    logger.info('Starting full Square sync');
    const startTime = Date.now();

    const summary = {
        success: true,
        errors: [],
        locations: 0,
        vendors: 0,
        catalog: {},
        inventory: 0,
        salesVelocity: {}
    };

    try {
        // Step 1: Sync locations
        try {
            summary.locations = await syncLocations();
        } catch (error) {
            summary.errors.push(`Locations: ${error.message}`);
        }

        // Step 2: Sync vendors
        try {
            summary.vendors = await syncVendors();
        } catch (error) {
            summary.errors.push(`Vendors: ${error.message}`);
        }

        // Step 3: Sync catalog
        try {
            summary.catalog = await syncCatalog();
        } catch (error) {
            summary.errors.push(`Catalog: ${error.message}`);
        }

        // Step 4: Sync inventory
        try {
            summary.inventory = await syncInventory();
        } catch (error) {
            summary.errors.push(`Inventory: ${error.message}`);
        }

        // Step 5: Sync sales velocity for multiple periods
        for (const days of [91, 182, 365]) {
            try {
                summary.salesVelocity[`${days}d`] = await syncSalesVelocity(days);
            } catch (error) {
                summary.errors.push(`Sales velocity (${days}d): ${error.message}`);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info('Full Square sync complete', { duration_seconds: duration });

        if (summary.errors.length > 0) {
            logger.warn('Errors encountered during full sync', { errors: summary.errors });
            summary.success = false;
        }

        return summary;
    } catch (error) {
        logger.error('Full sync failed', { error: error.message, stack: error.stack });
        summary.success = false;
        summary.errors.push(error.message);
        return summary;
    }
}

module.exports = {
    syncLocations,
    syncVendors,
    syncCatalog,
    syncInventory,
    syncSalesVelocity,
    fullSync
};
