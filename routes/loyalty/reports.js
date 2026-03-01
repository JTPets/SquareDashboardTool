/**
 * Loyalty Report Routes
 *
 * Report generation and CSV export endpoints:
 * - GET /reports - List available report endpoints
 * - GET /reports/vendor-receipt/:rewardId - Generate vendor receipt
 * - GET /reports/brand-redemptions - Brand redemption report (json/html/csv)
 * - GET /reports/redemptions/csv - Export redemptions as CSV
 * - GET /reports/audit/csv - Export audit log as CSV
 * - GET /reports/summary/csv - Export summary as CSV
 * - GET /reports/customers/csv - Export customer activity as CSV
 * - GET /reports/redemption/:rewardId - Get full redemption details
 */

const express = require('express');
const router = express.Router();
const loyaltyReports = require('../../utils/loyalty-reports');
const brandRedemptionReport = require('../../services/reports/brand-redemption-report');
const { requireAuth } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const validators = require('../../middleware/validators/loyalty');

/**
 * GET /api/loyalty/reports
 * List available report endpoints
 */
router.get('/reports', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    res.json({
        message: 'Loyalty Reports API',
        endpoints: {
            'GET /reports/brand-redemptions': 'Comprehensive brand redemption report - proof-of-purchase for brands (query: startDate, endDate, offerId, brandName, format=json|html|csv)',
            'GET /reports/vendor-receipt/:rewardId': 'Generate vendor receipt HTML for a redeemed reward',
            'GET /reports/redemption/:rewardId': 'Get full redemption details with contributing transactions',
            'GET /reports/redemptions/csv': 'Export redemptions as CSV (query: startDate, endDate, offerId, brandName)',
            'GET /reports/audit/csv': 'Export audit log as CSV (query: startDate, endDate, offerId, squareCustomerId)',
            'GET /reports/summary/csv': 'Export summary by brand/offer as CSV (query: startDate, endDate)',
            'GET /reports/customers/csv': 'Export customer activity as CSV (query: offerId, minPurchases)'
        }
    });
}));

/**
 * GET /api/loyalty/reports/vendor-receipt/:rewardId
 * Generate vendor receipt for a specific redemption (HTML/PDF)
 */
router.get('/reports/vendor-receipt/:rewardId', requireAuth, requireMerchant, validators.getVendorReceipt, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { format = 'html' } = req.query;

    const receipt = await loyaltyReports.generateVendorReceipt(req.params.rewardId, merchantId);

    if (format === 'html') {
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `inline; filename="${receipt.filename}"`);
        return res.send(receipt.html);
    }

    // Return data for client-side PDF generation or other processing
    res.json({
        html: receipt.html,
        data: receipt.data,
        filename: receipt.filename
    });
}));

/**
 * GET /api/loyalty/reports/brand-redemptions
 * Comprehensive brand redemption report - proof-of-purchase for brands
 *
 * Features:
 * - Privacy-aware customer info (first name + last initial, masked phone/email)
 * - Full order line items for each contributing purchase
 * - Summary metrics (total spend, average order value, time span, visits)
 *
 * Query params:
 * - startDate: Filter redemptions from this date (ISO 8601)
 * - endDate: Filter redemptions to this date (ISO 8601)
 * - offerId: Filter by specific offer UUID
 * - brandName: Filter by brand name
 * - format: Response format - 'json' (default), 'html', or 'csv'
 */
router.get('/reports/brand-redemptions', requireAuth, requireMerchant, validators.getBrandRedemptions, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { startDate, endDate, offerId, brandName, format = 'json' } = req.query;

    const filterOptions = {
        startDate,
        endDate,
        offerId,
        brandName
    };

    if (format === 'html') {
        const result = await brandRedemptionReport.generateBrandRedemptionHTML(merchantId, filterOptions);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${result.filename}"`);
        return res.send(result.html);
    }

    if (format === 'csv') {
        const result = await brandRedemptionReport.generateBrandRedemptionCSV(merchantId, filterOptions);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        return res.send(result.csv);
    }

    // Default: JSON response
    const report = await brandRedemptionReport.buildBrandRedemptionReport(merchantId, {
        ...filterOptions,
        includeFullOrders: true
    });

    res.json({
        success: true,
        report
    });
}));

/**
 * GET /api/loyalty/reports/redemptions/csv
 * Export redemptions as CSV
 */
router.get('/reports/redemptions/csv', requireAuth, requireMerchant, validators.exportRedemptionsCSV, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { startDate, endDate, offerId, brandName } = req.query;

    const result = await loyaltyReports.generateRedemptionsCSV(merchantId, {
        startDate,
        endDate,
        offerId,
        brandName
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
}));

/**
 * GET /api/loyalty/reports/audit/csv
 * Export detailed audit log as CSV
 */
router.get('/reports/audit/csv', requireAuth, requireMerchant, validators.exportAuditCSV, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { startDate, endDate, offerId, squareCustomerId } = req.query;

    const result = await loyaltyReports.generateAuditCSV(merchantId, {
        startDate,
        endDate,
        offerId,
        squareCustomerId
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
}));

/**
 * GET /api/loyalty/reports/summary/csv
 * Export summary by brand/offer as CSV
 */
router.get('/reports/summary/csv', requireAuth, requireMerchant, validators.exportSummaryCSV, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { startDate, endDate } = req.query;

    const result = await loyaltyReports.generateSummaryCSV(merchantId, {
        startDate,
        endDate
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
}));

/**
 * GET /api/loyalty/reports/customers/csv
 * Export customer activity as CSV
 */
router.get('/reports/customers/csv', requireAuth, requireMerchant, validators.exportCustomersCSV, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerId, minPurchases } = req.query;

    const result = await loyaltyReports.generateCustomerActivityCSV(merchantId, {
        offerId,
        minPurchases: minPurchases ? parseInt(minPurchases) : 1
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
}));

/**
 * GET /api/loyalty/reports/redemption/:rewardId
 * Get full redemption details with all contributing transactions
 */
router.get('/reports/redemption/:rewardId', requireAuth, requireMerchant, validators.getRedemptionDetails, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const details = await loyaltyReports.getRedemptionDetails(req.params.rewardId, merchantId);

    if (!details) {
        return res.status(404).json({ error: 'Redemption not found' });
    }

    res.json({ redemption: details });
}));

module.exports = router;
