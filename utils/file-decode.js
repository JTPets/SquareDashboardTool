/**
 * File Decode Utility
 *
 * Decodes base64-encoded file data from API request bodies.
 * Centralises the type-detection + decode logic used by all vendor catalog
 * import endpoints (previously duplicated 3× in routes/vendor-catalog.js).
 *
 * Usage:
 *   const { decodeFileData } = require('../utils/file-decode');
 *   const { fileData, type } = decodeFileData(data, fileType, fileName);
 */

/**
 * Detect file type from explicit param or filename extension.
 * Defaults to 'csv'.
 * @param {string|undefined} fileType - explicit 'csv' or 'xlsx'
 * @param {string|undefined} fileName - original filename, used when fileType absent
 * @returns {'csv'|'xlsx'}
 */
function detectFileType(fileType, fileName) {
    if (fileType) return fileType;
    if (fileName && fileName.toLowerCase().endsWith('.xlsx')) return 'xlsx';
    return 'csv';
}

/**
 * Decode base64 (or raw) file data into the right format for parsing.
 * - xlsx → Buffer
 * - csv  → UTF-8 string (falls back to raw value on decode failure)
 *
 * @param {string} data - base64-encoded or raw file content
 * @param {string|undefined} fileType - 'csv' or 'xlsx'
 * @param {string|undefined} fileName - original filename for type inference
 * @returns {{ fileData: Buffer|string, type: 'csv'|'xlsx' }}
 */
function decodeFileData(data, fileType, fileName) {
    const type = detectFileType(fileType, fileName);

    let fileData;
    if (type === 'xlsx') {
        fileData = Buffer.from(data, 'base64');
    } else {
        try {
            fileData = Buffer.from(data, 'base64').toString('utf-8');
        } catch {
            fileData = data;
        }
    }

    return { fileData, type };
}

module.exports = { decodeFileData, detectFileType };
