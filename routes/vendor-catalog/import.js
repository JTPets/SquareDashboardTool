const express = require('express');
const router = express.Router();
const vendorCatalog = require('../../services/vendor');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const validators = require('../../middleware/validators/vendor-catalog');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');
const { decodeFileData } = require('../../utils/file-decode');

router.post('/vendor-catalog/import', requireAuth, requireMerchant, requireWriteAccess, validators.importCatalog, asyncHandler(async (req, res) => {
    const { data, fileType, fileName, defaultVendorName } = req.body;
    if (!data) return sendError(res, 'Missing file data', 400);
    const { fileData, type } = decodeFileData(data, fileType, fileName);
    const result = await vendorCatalog.importVendorCatalog(fileData, type, {
        defaultVendorName: defaultVendorName || null,
        merchantId: req.merchantContext.id
    });
    if (!result.success) return sendError(res, result.error, 400);
    sendSuccess(res, {
        message: `Imported ${result.stats.imported} items from vendor catalog`,
        batchId: result.batchId, stats: result.stats,
        validationErrors: result.validationErrors, fieldMap: result.fieldMap, duration: result.duration
    });
}));

router.post('/vendor-catalog/preview', requireAuth, requireMerchant, requireWriteAccess, validators.previewFile, asyncHandler(async (req, res) => {
    const { data, fileType, fileName } = req.body;
    if (!data) return sendError(res, 'Missing file data', 400);
    const { fileData, type } = decodeFileData(data, fileType, fileName);
    const preview = await vendorCatalog.previewFile(fileData, type);
    const columns = preview.columns.map(c => c.originalHeader);
    const autoMappings = {};
    const sampleValues = {};
    preview.columns.forEach(c => {
        autoMappings[c.originalHeader] = c.suggestedMapping;
        sampleValues[c.originalHeader] = c.sampleValues;
    });
    sendSuccess(res, { totalRows: preview.totalRows, columns, autoMappings, sampleValues, fieldTypes: preview.fieldTypes });
}));

router.post('/vendor-catalog/import-mapped', requireAuth, requireMerchant, requireWriteAccess, validators.importMapped, asyncHandler(async (req, res) => {
    const { data, fileType, fileName, columnMappings, mappings, vendorId, vendorName, importName } = req.body;
    if (!data) return sendError(res, 'Missing file data', 400);
    if (!vendorId) return sendError(res, 'Missing vendor', 400);
    const { fileData, type } = decodeFileData(data, fileType, fileName);
    const result = await vendorCatalog.importWithMappings(fileData, type, {
        columnMappings: columnMappings || mappings || {},
        vendorId,
        vendorName: vendorName || 'Unknown Vendor',
        importName: importName || null,
        merchantId: req.merchantContext.id
    });
    if (!result.success) return sendError(res, result.error, 400);
    sendSuccess(res, {
        message: `Imported ${result.stats.imported} items from vendor catalog`,
        batchId: result.batchId, stats: result.stats, validationErrors: result.validationErrors,
        fieldMap: result.fieldMap, duration: result.duration,
        importName: result.importName, vendorName: result.vendorName
    });
}));

router.get('/vendor-catalog/field-types', requireAuth, requireMerchant, (req, res) => {
    sendSuccess(res, { fieldTypes: vendorCatalog.FIELD_TYPES });
});

router.get('/vendor-catalog/stats', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const stats = await vendorCatalog.getStats(req.merchantContext.id);
    sendSuccess(res, stats);
}));

module.exports = router;
