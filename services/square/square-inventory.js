/**
 * Square Inventory Management
 *
 * Handles inventory counts, alerts, and committed inventory reconciliation
 * from Square's Inventory and Invoice APIs.
 *
 * Exports:
 *   syncInventory(merchantId)                     — bulk inventory count sync
 *   getSquareInventoryCount(catalogObjectId, locationId, merchantId) — single count
 *   setSquareInventoryCount(catalogObjectId, locationId, quantity, reason, merchantId)
 *   setSquareInventoryAlertThreshold(catalogObjectId, locationId, threshold, options)
 *   syncCommittedInventory(merchantId)            — invoice-based committed inventory
 *   cleanupInventory()                            — clear background timers
 *
 * Usage:
 *   const { syncInventory, syncCommittedInventory } = require('./square-inventory');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey } = require('./square-client');

const { SQUARE: { MAX_PAGINATION_ITERATIONS }, SYNC: { BATCH_DELAY_MS, INTER_BATCH_DELAY_MS } } = require('../../config/constants');

// Cache for merchants without INVOICES_READ scope (avoid repeated API calls and log spam)
// Map<merchantId, timestamp> - expires after 1 hour
const merchantsWithoutInvoicesScope = new Map();
const INVOICES_SCOPE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Prune expired cache entries to prevent memory leaks
function pruneInvoicesScopeCache() {
    const now = Date.now();
    for (const [merchantId, timestamp] of merchantsWithoutInvoicesScope) {
        if (now - timestamp > INVOICES_SCOPE_CACHE_TTL) {
            merchantsWithoutInvoicesScope.delete(merchantId);
        }
    }
}

// Run cache pruning every hour
// .unref() allows the process to exit even if this timer is still active
const invoicesCachePruneInterval = setInterval(pruneInvoicesScopeCache, INVOICES_SCOPE_CACHE_TTL);
invoicesCachePruneInterval.unref();

/**
 * Cleanup function for graceful shutdown — clears background timers.
 */
function cleanupInventory() {
    clearInterval(invoicesCachePruneInterval);
}

/**
 * Sync inventory counts from Square
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<number>} Number of inventory records synced
 */
async function syncInventory(merchantId) {
    logger.info('Starting inventory sync', { merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Get all locations for this merchant
        const locationsResult = await db.query('SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1', [merchantId]);
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found. Run location sync first', { merchantId });
            return 0;
        }

        // Get all variation IDs for this merchant
        const variationsResult = await db.query('SELECT id FROM variations WHERE merchant_id = $1', [merchantId]);
        const catalogObjectIds = variationsResult.rows.map(r => r.id);

        if (catalogObjectIds.length === 0) {
            logger.warn('No variations found. Run catalog sync first', { merchantId });
            return 0;
        }

        let totalSynced = 0;
        let totalBatches = 0;
        const aggregateStateCount = {};

        // Process in batches of 100 (Square API limit)
        const batchSize = 100;
        for (let i = 0; i < catalogObjectIds.length; i += batchSize) {
            const batch = catalogObjectIds.slice(i, i + batchSize);

            const requestBody = {
                catalog_object_ids: batch,
                location_ids: locationIds,
                states: ['IN_STOCK', 'RESERVED_FOR_SALE']
            };

            try {
                const data = await makeSquareRequest('/v2/inventory/counts/batch-retrieve', {
                    method: 'POST',
                    body: JSON.stringify(requestBody),
                    accessToken
                });

                const counts = data.counts || [];

                // Accumulate state counts for end-of-sync summary
                for (const c of counts) {
                    aggregateStateCount[c.state] = (aggregateStateCount[c.state] || 0) + 1;
                }

                for (const count of counts) {
                    await db.query(`
                        INSERT INTO inventory_counts (
                            catalog_object_id, location_id, state, quantity, merchant_id, updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                        ON CONFLICT (catalog_object_id, location_id, state, merchant_id) DO UPDATE SET
                            quantity = EXCLUDED.quantity,
                            updated_at = CURRENT_TIMESTAMP
                    `, [
                        count.catalog_object_id,
                        count.location_id,
                        count.state,
                        parseInt(count.quantity) || 0,
                        merchantId
                    ]);
                    totalSynced++;
                }

                totalBatches++;
            } catch (error) {
                logger.error('Inventory sync batch failed', { merchantId, batch: Math.floor(i / batchSize) + 1, error: error.message, stack: error.stack });
                // Continue with next batch
            }

            // Small delay to avoid rate limiting
            await sleep(BATCH_DELAY_MS);
        }

        logger.info('Inventory sync complete', {
            merchantId,
            variationsUpdated: totalSynced,
            batches: totalBatches,
            states: aggregateStateCount
        });
        return totalSynced;
    } catch (error) {
        logger.error('Inventory sync failed', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Get current inventory count from Square for a specific variation and location
 * @param {string} catalogObjectId - The variation ID
 * @param {string} locationId - The location ID
 * @param {number} merchantId - The merchant ID for multi-tenant token lookup
 * @returns {Promise<number>} Current quantity in Square
 */
async function getSquareInventoryCount(catalogObjectId, locationId, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getSquareInventoryCount');
    }
    logger.info('Fetching inventory count from Square', { catalogObjectId, locationId, merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);
        const requestBody = {
            catalog_object_ids: [catalogObjectId],
            location_ids: [locationId],
            states: ['IN_STOCK']
        };

        const data = await makeSquareRequest('/v2/inventory/counts/batch-retrieve', {
            method: 'POST',
            body: JSON.stringify(requestBody),
            accessToken
        });

        const counts = data.counts || [];

        // Find the matching count
        const count = counts.find(c =>
            c.catalog_object_id === catalogObjectId &&
            c.location_id === locationId &&
            c.state === 'IN_STOCK'
        );

        const quantity = count ? parseInt(count.quantity) || 0 : 0;
        logger.info('Square inventory count retrieved', { catalogObjectId, locationId, quantity });

        return quantity;
    } catch (error) {
        logger.error('Failed to get Square inventory count', {
            catalogObjectId,
            locationId,
            merchantId,
            error: error.message
        });
        throw error;
    }
}

/**
 * Adjust inventory in Square using physical count
 * Sets the inventory to the specified quantity (not a delta)
 * @param {string} catalogObjectId - The variation ID
 * @param {string} locationId - The location ID
 * @param {number} quantity - The new absolute quantity to set
 * @param {string} reason - Reason for the adjustment (for memo)
 * @param {number} merchantId - The merchant ID for multi-tenant token lookup
 * @returns {Promise<Object>} Result of the inventory change
 */
async function setSquareInventoryCount(catalogObjectId, locationId, quantity, reason = 'Cycle count adjustment', merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for setSquareInventoryCount');
    }
    logger.info('Setting Square inventory count', { catalogObjectId, locationId, quantity, reason, merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);
        // Generate idempotency key for the request
        const idempotencyKey = generateIdempotencyKey(`cycle-count-${catalogObjectId}-${locationId}`);

        const requestBody = {
            idempotency_key: idempotencyKey,
            changes: [{
                type: 'PHYSICAL_COUNT',
                physical_count: {
                    catalog_object_id: catalogObjectId,
                    state: 'IN_STOCK',
                    location_id: locationId,
                    quantity: quantity.toString(),
                    occurred_at: new Date().toISOString(),
                    reference_id: `cycle-count-${Date.now()}`
                }
            }]
        };

        const data = await makeSquareRequest('/v2/inventory/changes/batch-create', {
            method: 'POST',
            body: JSON.stringify(requestBody),
            accessToken
        });

        logger.info('Square inventory updated successfully', {
            catalogObjectId,
            locationId,
            newQuantity: quantity,
            changes: data.changes?.length || 0
        });

        return {
            success: true,
            changes: data.changes || [],
            counts: data.counts || []
        };
    } catch (error) {
        logger.error('Failed to set Square inventory count', {
            catalogObjectId,
            locationId,
            quantity,
            merchantId,
            error: error.message,
            squareErrors: error.squareErrors || [],
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Update inventory alert threshold (min stock) for a variation at a specific location in Square
 * Uses location_overrides to set location-specific low stock alerts
 * @param {string} catalogObjectId - The variation ID
 * @param {string} locationId - The location ID for the alert
 * @param {number|null} threshold - The new threshold value (null to disable alerts)
 * @param {Object} options - Options including merchantId
 * @param {number} options.merchantId - Required merchant ID for multi-tenant
 * @returns {Promise<Object>} Result of the catalog update
 */
async function setSquareInventoryAlertThreshold(catalogObjectId, locationId, threshold, options = {}) {
    const { merchantId } = options;
    const MAX_RETRIES = 3;

    if (!merchantId) {
        throw new Error('merchantId is required for setSquareInventoryAlertThreshold');
    }

    logger.info('Updating Square inventory alert threshold', { catalogObjectId, locationId, threshold, merchantId });

    // Get merchant-specific access token
    const accessToken = await getMerchantToken(merchantId);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Retrieve the current catalog object to get its version and existing overrides
            // This is done inside the retry loop to get the latest version on each attempt
            const retrieveData = await makeSquareRequest(`/v2/catalog/object/${catalogObjectId}?include_related_objects=false`, { accessToken });

            if (!retrieveData.object) {
                throw new Error(`Catalog object not found: ${catalogObjectId}`);
            }

            const currentObject = retrieveData.object;

            if (currentObject.type !== 'ITEM_VARIATION') {
                throw new Error(`Object is not a variation: ${currentObject.type}`);
            }

            const currentVariationData = currentObject.item_variation_data || {};
            const existingOverrides = currentVariationData.location_overrides || [];

            // Determine alert type based on threshold
            const alertType = (threshold !== null && threshold > 0) ? 'LOW_QUANTITY' : 'NONE';

            // Build new location_overrides array
            // Keep existing overrides for other locations, update/add the one for our location
            let newOverrides = existingOverrides.filter(o => o.location_id !== locationId);

            // Add/update the override for our target location
            const newOverride = {
                location_id: locationId,
                inventory_alert_type: alertType
            };

            if (alertType === 'LOW_QUANTITY' && threshold !== null) {
                newOverride.inventory_alert_threshold = threshold;
            }

            newOverrides.push(newOverride);

            // Build the update request - use unique key per attempt to avoid idempotency conflicts
            const idempotencyKey = generateIdempotencyKey(`inv-alert-v2-${attempt}`);

            logger.info('Generated idempotency key for alert threshold update', {
                idempotencyKey,
                catalogObjectId,
                locationId,
                version: currentObject.version,
                attempt
            });

            const updateBody = {
                idempotency_key: idempotencyKey,
                object: {
                    type: 'ITEM_VARIATION',
                    id: catalogObjectId,
                    version: currentObject.version,
                    item_variation_data: {
                        ...currentVariationData,
                        location_overrides: newOverrides
                    }
                }
            };

            const data = await makeSquareRequest('/v2/catalog/object', {
                method: 'POST',
                body: JSON.stringify(updateBody),
                accessToken
            });

            logger.info('Square inventory alert threshold updated (location-specific)', {
                catalogObjectId,
                locationId,
                threshold,
                alertType,
                newVersion: data.catalog_object?.version,
                attempts: attempt
            });

            return {
                success: true,
                catalog_object: data.catalog_object,
                id_mappings: data.id_mappings
            };
        } catch (error) {
            // Check if this is a VERSION_MISMATCH error that we can retry
            const isVersionMismatch = error.message && error.message.includes('VERSION_MISMATCH');

            if (isVersionMismatch && attempt < MAX_RETRIES) {
                logger.warn('VERSION_MISMATCH on inventory alert update, retrying with fresh version', {
                    catalogObjectId,
                    locationId,
                    attempt,
                    maxRetries: MAX_RETRIES
                });
                // Small delay before retry to allow concurrent updates to complete
                await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                continue;
            }

            logger.error('Failed to update Square inventory alert threshold', {
                catalogObjectId,
                locationId,
                threshold,
                error: error.message,
                stack: error.stack,
                attempts: attempt
            });
            throw error;
        }
    }
}

/**
 * Sync committed inventory from open/unpaid invoices.
 *
 * Reconciles the committed_inventory table against Square's Invoice API:
 * 1. Fetches ALL invoices from Square (paginated)
 * 2. Builds a Set of open invoice IDs (DRAFT/UNPAID/SCHEDULED/PARTIALLY_PAID)
 * 3. Upserts committed_inventory rows for each open invoice's order line items
 * 4. Deletes committed_inventory rows for invoices NOT in the open set
 * 5. Rebuilds RESERVED_FOR_SALE aggregate from committed_inventory
 *
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} Reconciliation result with detailed metrics
 */
async function syncCommittedInventory(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for syncCommittedInventory');
    }

    // Check if merchant is known to lack INVOICES_READ scope (cached)
    const cachedTimestamp = merchantsWithoutInvoicesScope.get(merchantId);
    if (cachedTimestamp && Date.now() - cachedTimestamp < INVOICES_SCOPE_CACHE_TTL) {
        return { skipped: true, reason: 'INVOICES_READ scope not authorized (cached)', count: 0 };
    }

    logger.info('Starting committed inventory reconciliation', { merchantId });

    const accessToken = await getMerchantToken(merchantId);

    // Get all active locations FOR THIS MERCHANT ONLY
    const locationsResult = await db.query(
        'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
        [merchantId]
    );
    const locationIds = locationsResult.rows.map(r => r.id);

    if (locationIds.length === 0) {
        logger.warn('No active locations found for committed inventory sync', { merchantId });
        return { skipped: true, reason: 'No active locations', count: 0 };
    }

    // Count existing committed_inventory rows BEFORE reconciliation
    const beforeResult = await db.query(
        'SELECT count(*)::int AS cnt FROM committed_inventory WHERE merchant_id = $1',
        [merchantId]
    );
    const rowsBefore = beforeResult.rows[0].cnt;

    // Fetch ALL invoices from Square (paginated) and classify by status
    const openStatuses = ['DRAFT', 'UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'];
    logger.info('Committed inventory reconciliation — invoice statuses treated as "open"', {
        merchantId,
        openStatuses
    });
    const openInvoiceIds = new Set();
    // Map<invoiceId, { orderId, status, locationId }> for open invoices
    const openInvoiceDetails = new Map();
    const statusCounts = {};
    let totalFetched = 0;
    let cursor = null;
    let paginationIterations = 0;

    do {
        if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
            logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/invoices/search' });
            break;
        }
        const requestBody = {
            query: {
                filter: { location_ids: locationIds },
                sort: { field: 'INVOICE_SORT_DATE', order: 'DESC' }
            },
            limit: 200
        };
        if (cursor) {
            requestBody.cursor = cursor;
        }

        let data;
        try {
            data = await makeSquareRequest('/v2/invoices/search', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                accessToken
            });
        } catch (apiError) {
            if (apiError.message && apiError.message.includes('INSUFFICIENT_SCOPES')) {
                merchantsWithoutInvoicesScope.set(merchantId, Date.now());
                logger.info('Skipping committed inventory sync - merchant does not have INVOICES_READ scope (will cache for 1 hour)', { merchantId });
                return { skipped: true, reason: 'INVOICES_READ scope not authorized', count: 0 };
            }
            throw apiError;
        }

        const invoices = data.invoices || [];
        cursor = data.cursor;

        for (const invoice of invoices) {
            totalFetched++;
            statusCounts[invoice.status] = (statusCounts[invoice.status] || 0) + 1;

            if (openStatuses.includes(invoice.status) && invoice.location_id) {
                openInvoiceIds.add(invoice.id);
                openInvoiceDetails.set(invoice.id, {
                    status: invoice.status,
                    locationId: invoice.location_id
                });
            }
        }

        if (cursor) await sleep(BATCH_DELAY_MS);
    } while (cursor);

    logger.info('Fetched invoices from Square for reconciliation', {
        merchantId,
        totalFetched,
        openCount: openInvoiceIds.size,
        statusCounts
    });

    // Delete stale committed_inventory rows — any invoice no longer in the open set
    const openIdArray = Array.from(openInvoiceIds);
    let staleDeleteResult;
    if (openIdArray.length > 0) {
        staleDeleteResult = await db.query(
            `DELETE FROM committed_inventory
             WHERE merchant_id = $1 AND NOT (square_invoice_id = ANY($2))
             RETURNING square_invoice_id, invoice_status`,
            [merchantId, openIdArray]
        );
    } else {
        // No open invoices — delete ALL committed_inventory for this merchant
        staleDeleteResult = await db.query(
            `DELETE FROM committed_inventory
             WHERE merchant_id = $1
             RETURNING square_invoice_id, invoice_status`,
            [merchantId]
        );
    }

    const rowsDeleted = staleDeleteResult.rowCount;
    const deletedInvoiceIds = [...new Set(staleDeleteResult.rows.map(r => r.square_invoice_id))];

    for (const row of staleDeleteResult.rows) {
        logger.info('Deleted stale committed_inventory row', {
            merchantId,
            invoiceId: row.square_invoice_id,
            oldStatus: row.invoice_status
        });
    }

    if (deletedInvoiceIds.length > 0) {
        logger.info('Stale committed_inventory cleanup summary', {
            merchantId,
            deletedInvoiceIds,
            rowsDeleted
        });
    }

    // For each open invoice, fetch order line items and upsert into committed_inventory
    let invoicesProcessed = 0;
    let invoiceErrors = 0;
    const matchCategories = { fullyMatched: 0, partiallyMatched: 0, fullyUnmatched: 0 };
    const committedQtyByVariation = new Map(); // variationId -> total quantity

    for (const [invoiceId, details] of openInvoiceDetails) {
        try {
            const invoiceDetail = await makeSquareRequest(`/v2/invoices/${invoiceId}`, {
                method: 'GET',
                accessToken
            });

            const fullInvoice = invoiceDetail.invoice;
            if (!fullInvoice || !fullInvoice.order_id) continue;

            // Extract invoice metadata for logging
            const primaryRecipient = fullInvoice.primary_recipient || {};
            const paymentRequest = (fullInvoice.payment_requests || [])[0] || {};
            const totalMoney = paymentRequest.computed_amount_money
                || paymentRequest.total_completed_amount_money || {};

            logger.info('Processing open invoice for committed inventory', {
                merchantId,
                invoiceId,
                orderId: fullInvoice.order_id,
                invoiceStatus: fullInvoice.status,
                customerId: primaryRecipient.customer_id || null,
                createdAt: fullInvoice.created_at || null,
                dueDate: paymentRequest.due_date || null,
                totalAmount: totalMoney.amount != null
                    ? `${totalMoney.amount} ${totalMoney.currency || ''}`
                    : null
            });

            const orderData = await makeSquareRequest(`/v2/orders/${fullInvoice.order_id}`, {
                method: 'GET',
                accessToken
            });

            const order = orderData.order;
            if (!order || !order.line_items) continue;

            // Upsert committed_inventory rows for this invoice (transaction)
            let invoiceMatchedCount = 0;
            let invoiceSkippedCount = 0;
            let invoiceTotalLineItems = 0;

            await db.transaction(async (client) => {
                // Delete existing rows for this invoice (handles line item changes)
                await client.query(
                    'DELETE FROM committed_inventory WHERE merchant_id = $1 AND square_invoice_id = $2',
                    [merchantId, invoiceId]
                );

                // Check which catalog_object_ids exist locally for orphan filtering
                const allVariationIds = order.line_items
                    .map(li => li.catalog_object_id)
                    .filter(Boolean);
                let knownVariationIds = new Set();
                if (allVariationIds.length > 0) {
                    const knownResult = await client.query(
                        'SELECT id FROM variations WHERE id = ANY($1) AND merchant_id = $2',
                        [allVariationIds, merchantId]
                    );
                    knownVariationIds = new Set(knownResult.rows.map(r => r.id));
                }

                for (const lineItem of order.line_items) {
                    const variationId = lineItem.catalog_object_id;
                    const locationId = order.location_id || details.locationId;
                    const quantity = parseInt(lineItem.quantity) || 0;
                    const itemName = lineItem.name || '(unnamed)';

                    if (!variationId || quantity <= 0 || !locationId) continue;

                    invoiceTotalLineItems++;
                    const matched = knownVariationIds.has(variationId);

                    logger.info('Invoice line item', {
                        merchantId,
                        invoiceId,
                        variationId,
                        itemName,
                        quantity,
                        matchedLocalVariation: matched
                    });

                    if (!matched) {
                        invoiceSkippedCount++;
                        logger.warn('ACTION REQUIRED: Invoice line item skipped — variation not in local catalog. Run catalog sync to resolve.', {
                            merchantId,
                            invoiceId,
                            orderId: fullInvoice.order_id,
                            invoiceStatus: fullInvoice.status,
                            variationId,
                            itemName,
                            quantity,
                            customerId: primaryRecipient.customer_id || null,
                            dueDate: paymentRequest.due_date || null
                        });
                        continue;
                    }

                    invoiceMatchedCount++;

                    // Track committed quantities for end-of-reconciliation summary
                    const prevQty = committedQtyByVariation.get(variationId) || 0;
                    committedQtyByVariation.set(variationId, prevQty + quantity);

                    await client.query(`
                        INSERT INTO committed_inventory
                            (merchant_id, square_invoice_id, square_order_id, catalog_object_id,
                             location_id, quantity, invoice_status, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                        ON CONFLICT (merchant_id, square_invoice_id, catalog_object_id, location_id)
                        DO UPDATE SET
                            quantity = committed_inventory.quantity + EXCLUDED.quantity,
                            updated_at = NOW()
                    `, [merchantId, invoiceId, fullInvoice.order_id, variationId,
                        locationId, quantity, details.status]);
                }
            });

            // Categorize invoice match result
            if (invoiceTotalLineItems > 0) {
                if (invoiceSkippedCount === 0) {
                    matchCategories.fullyMatched++;
                } else if (invoiceMatchedCount === 0) {
                    matchCategories.fullyUnmatched++;
                } else {
                    matchCategories.partiallyMatched++;
                }
            }

            invoicesProcessed++;
        } catch (error) {
            invoiceErrors++;
            logger.warn('Failed to process open invoice for committed inventory', {
                invoiceId,
                merchantId,
                error: error.message
            });
        }

        await sleep(INTER_BATCH_DELAY_MS);
    }

    // Rebuild RESERVED_FOR_SALE aggregate from committed_inventory
    // (matches webhook handler's _rebuildReservedForSaleAggregate pattern)
    // Filter out catalog_object_ids not in local variations table (orphans)
    await db.transaction(async (client) => {
        await client.query(
            "DELETE FROM inventory_counts WHERE state = 'RESERVED_FOR_SALE' AND merchant_id = $1",
            [merchantId]
        );

        await client.query(`
            INSERT INTO inventory_counts
                (catalog_object_id, location_id, state, quantity, merchant_id, updated_at)
            SELECT
                catalog_object_id,
                location_id,
                'RESERVED_FOR_SALE',
                SUM(quantity),
                $1,
                NOW()
            FROM committed_inventory
            WHERE merchant_id = $1
                AND catalog_object_id IN (SELECT id FROM variations WHERE merchant_id = $1)
            GROUP BY catalog_object_id, location_id
            ON CONFLICT (catalog_object_id, location_id, state, merchant_id)
            DO UPDATE SET
                quantity = EXCLUDED.quantity,
                updated_at = NOW()
        `, [merchantId]);
    });

    // Log warning for orphan variations in committed_inventory
    const orphanResult = await db.query(`
        SELECT DISTINCT ci.catalog_object_id, ci.square_invoice_id
        FROM committed_inventory ci
        WHERE ci.merchant_id = $1
            AND ci.catalog_object_id NOT IN (
                SELECT id FROM variations WHERE merchant_id = $1
            )
    `, [merchantId]);

    if (orphanResult.rows.length > 0) {
        const orphanIds = [...new Set(orphanResult.rows.map(r => r.catalog_object_id))];
        const invoiceIds = [...new Set(orphanResult.rows.map(r => r.square_invoice_id))];
        logger.warn(
            `Committed inventory references ${orphanIds.length} variation(s) not in local catalog — these items are excluded from RESERVED_FOR_SALE. Run a catalog sync to resolve.`,
            { merchantId, orphanVariationIds: orphanIds, invoiceIds }
        );
    }

    // Log reconciliation match summary
    logger.info('Committed inventory reconciliation — invoice match summary', {
        merchantId,
        invoicesFullyMatched: matchCategories.fullyMatched,
        invoicesPartiallyMatched: matchCategories.partiallyMatched,
        invoicesFullyUnmatched: matchCategories.fullyUnmatched,
        invoicesProcessed,
        invoiceErrors
    });

    if (committedQtyByVariation.size > 0) {
        const quantities = {};
        for (const [varId, qty] of committedQtyByVariation) {
            quantities[varId] = qty;
        }
        logger.info('Committed inventory reconciliation — total committed quantities by variation', {
            merchantId,
            variationCount: committedQtyByVariation.size,
            quantities
        });
    }

    // Count rows AFTER reconciliation
    const afterResult = await db.query(
        'SELECT count(*)::int AS cnt FROM committed_inventory WHERE merchant_id = $1',
        [merchantId]
    );
    const rowsRemaining = afterResult.rows[0].cnt;

    const result = {
        invoices_fetched: totalFetched,
        status_counts: statusCounts,
        open_invoices: openInvoiceIds.size,
        invoices_processed: invoicesProcessed,
        invoice_errors: invoiceErrors,
        rows_before: rowsBefore,
        rows_deleted: rowsDeleted,
        rows_remaining: rowsRemaining,
        deleted_invoice_ids: deletedInvoiceIds
    };

    // Warn if no changes were made despite existing committed records
    if (rowsBefore > 0 && rowsDeleted === 0) {
        logger.warn(`No stale rows deleted despite ${rowsBefore} committed records — verify invoice status sync`, {
            merchantId,
            rowsBefore,
            rowsRemaining,
            openInvoiceCount: openInvoiceIds.size
        });
    }

    logger.info('Committed inventory reconciliation complete', {
        merchantId,
        ...result,
        deleted_invoice_ids: deletedInvoiceIds.length > 0
            ? deletedInvoiceIds : '(none)'
    });

    return result;
}

module.exports = {
    syncInventory,
    getSquareInventoryCount,
    setSquareInventoryCount,
    setSquareInventoryAlertThreshold,
    syncCommittedInventory,
    cleanupInventory
};
