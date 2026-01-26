/**
 * Google Merchant Center Service Layer
 *
 * Public API for GMC-related services. This module provides:
 * - Product feed generation (TSV format)
 * - Local inventory feed generation
 * - GMC API integration for product sync
 * - OAuth token management
 * - Sync logging and history
 *
 * This service was extracted from utils/gmc-feed.js and utils/merchant-center-api.js
 * as part of P1-3.
 *
 * Usage:
 *   // Feed generation (TSV)
 *   const { feedService } = require('./services/gmc');
 *   const feedData = await feedService.generateFeedData({ merchantId });
 *   const tsv = feedService.generateTsvContent(feedData.products);
 *
 *   // API sync
 *   const { merchantService } = require('./services/gmc');
 *   await merchantService.syncProductCatalog(merchantId);
 */

const feedService = require('./feed-service');
const merchantService = require('./merchant-service');

module.exports = {
    feedService,
    merchantService,
    // Re-export feed service functions at top level for backward compatibility
    ...feedService,
    // Re-export merchant service functions at top level for backward compatibility
    ...merchantService
};
