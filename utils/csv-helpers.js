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
 * Format money for Square CSV - WITH $ symbol
 * Square export format: $105.00
 * Examples: $105.00, $13.29, $315.00
 * @param {number} cents - Amount in cents
 * @returns {string} Formatted money string with $ prefix
 */
function formatMoney(cents) {
    if (cents === null || cents === undefined) {
        return '$0.00';
    }
    return '$' + (cents / 100).toFixed(2);
}

/**
 * Format GTIN/UPC to prevent Excel scientific notation
 * UPCs are 12-14 digit numbers that Excel converts to scientific notation (8.51655E+11)
 * Solution: Prefix with tab character to force Excel to treat as text
 * @param {string|number} value - GTIN/UPC value
 * @returns {string} Tab-prefixed string to prevent scientific notation
 */
function formatGTIN(value) {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    // Convert to string, handling potential scientific notation from database
    let str;
    if (typeof value === 'number') {
        // For large numbers, convert to string without scientific notation
        str = value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
    } else {
        str = String(value).trim();
    }

    // If empty after trimming, return empty
    if (!str) {
        return '';
    }

    // Prefix with tab to force Excel text interpretation (prevents 8.51655E+11)
    // The tab won't be visible but prevents Excel from converting to scientific notation
    return '\t' + str;
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
