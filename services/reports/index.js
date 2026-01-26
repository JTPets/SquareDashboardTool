/**
 * Reports Service Layer
 *
 * Public API for report generation services. This module provides:
 * - Loyalty program vendor receipts (HTML for PDF conversion)
 * - Redemption audit exports (CSV)
 * - Program summary reports (CSV)
 * - Customer activity reports (CSV)
 *
 * This service was extracted from utils/loyalty-reports.js as part of P1-3.
 *
 * Usage:
 *   const { generateVendorReceipt, generateAuditCSV } = require('./services/reports');
 *
 *   const receipt = await generateVendorReceipt(redemptionId, merchantId);
 *   const audit = await generateAuditCSV(merchantId, { startDate, endDate });
 */

module.exports = require('./loyalty-reports');
