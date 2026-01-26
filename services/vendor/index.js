/**
 * Vendor Service Layer
 *
 * Public API for vendor-related services. This module provides:
 * - Vendor catalog import (CSV/XLSX)
 * - Price comparison and margin tracking
 * - UPC/SKU matching to existing catalog
 * - Import batch management
 *
 * This service was extracted from utils/vendor-catalog.js as part of P1-3.
 *
 * Usage:
 *   const { importVendorCatalog, searchVendorCatalog } = require('./services/vendor');
 *
 *   const result = await importVendorCatalog(data, 'xlsx', { merchantId });
 *   const items = await searchVendorCatalog({ merchantId, search: 'dog food' });
 */

module.exports = require('./catalog-service');
