/**
 * CSV Export Helper Functions
 * Utilities for generating CSV files compliant with Square and Excel standards
 */

/**
 * Escape a CSV field according to RFC 4180
 * - Trim whitespace and hidden characters
 * - Wrap in quotes if contains comma, quote, or newline
 * - Escape internal quotes by doubling them
 * @param {*} value - Value to escape
 * @returns {string} Escaped CSV field
 */
function escapeCSVField(value) {
    if (value === null || value === undefined) {
        return '';
    }

    // Convert to string and trim all whitespace/hidden characters
    const str = String(value).trim();

    // Check if field needs escaping
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        // Escape quotes by doubling them, then wrap in quotes
        return '"' + str.replace(/"/g, '""') + '"';
    }

    return str;
}

/**
 * Format date for Square CSV (M/D/YYYY - no zero padding)
 * @param {string} isoDateString - ISO date string
 * @returns {string} Formatted date string
 */
function formatDateForSquare(isoDateString) {
    if (!isoDateString) {
        return '';
    }

    const date = new Date(isoDateString);
    const month = date.getMonth() + 1; // 0-indexed, no padding
    const day = date.getDate(); // no padding
    const year = date.getFullYear();

    return `${month}/${day}/${year}`;
}

/**
 * Format money for Square CSV - decimal format WITHOUT $ symbol
 * Square import expects: 105.00 (not $105.00)
 * Examples: 105.00, 13.29, 315.00
 * @param {number} cents - Amount in cents
 * @returns {string} Formatted money string (no $ prefix for import)
 */
function formatMoney(cents) {
    if (cents === null || cents === undefined) {
        return '0.00';
    }
    return (cents / 100).toFixed(2);
}

/**
 * Format GTIN/UPC as plain text to avoid scientific notation
 * UPCs are typically 12-14 digit numbers that Excel may display in scientific notation
 * Output plain string with NO prefix, NO quotes (unless field contains special chars)
 * @param {string|number} value - GTIN/UPC value
 * @returns {string} Plain text GTIN with no scientific notation
 */
function formatGTIN(value) {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    // Convert to string, handling potential scientific notation
    // For numbers, use toFixed(0) to avoid scientific notation, then convert to string
    let str;
    if (typeof value === 'number') {
        // toFixed returns string with decimals, so we parse as int then convert to string
        str = Math.floor(value).toString();
    } else {
        str = String(value).trim();
    }

    // If empty after trimming, return empty
    if (!str) {
        return '';
    }

    // Return plain string - escapeCSVField will handle quoting if needed
    return str;
}

/**
 * UTF-8 BOM (Byte Order Mark) for proper Excel UTF-8 handling
 */
const UTF8_BOM = '\uFEFF';

module.exports = {
    escapeCSVField,
    formatDateForSquare,
    formatMoney,
    formatGTIN,
    UTF8_BOM
};
