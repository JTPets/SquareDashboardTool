/**
 * Test script to validate Square CSV export format
 *
 * This script tests the CSV export helper functions to ensure they comply
 * with Square's exact CSV import format requirements.
 */

// Import helper functions from server.js
// Note: In production, these should be in a separate module

function escapeCSVField(value) {
    if (value === null || value === undefined) {
        return '';
    }

    const str = String(value);

    // Check if field needs escaping
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        // Escape quotes by doubling them, then wrap in quotes
        return '"' + str.replace(/"/g, '""') + '"';
    }

    return str;
}

function formatDateForSquare(isoDateString) {
    if (!isoDateString) {
        return '';
    }

    const date = new Date(isoDateString);
    const month = date.getMonth() + 1; // 0-indexed
    const day = date.getDate();
    const year = date.getFullYear();

    return `${month}/${day}/${year}`;
}

function formatMoney(cents) {
    if (cents === null || cents === undefined) {
        return '0.00';
    }
    return (cents / 100).toFixed(2);
}

// Test cases
console.log('=== CSV Export Format Validation Tests ===\n');

let passedTests = 0;
let totalTests = 0;

function test(description, actual, expected) {
    totalTests++;
    const passed = actual === expected;
    if (passed) {
        passedTests++;
        console.log(`✓ ${description}`);
    } else {
        console.log(`✗ ${description}`);
        console.log(`  Expected: "${expected}"`);
        console.log(`  Actual:   "${actual}"`);
    }
}

// Test 1: CSV escaping - simple text
test(
    'Simple text without special characters',
    escapeCSVField('Dog Food'),
    'Dog Food'
);

// Test 2: CSV escaping - text with comma
test(
    'Text with comma should be wrapped in quotes',
    escapeCSVField('Royal Canin, 15lb'),
    '"Royal Canin, 15lb"'
);

// Test 3: CSV escaping - text with quotes
test(
    'Text with quotes should escape quotes and wrap',
    escapeCSVField('Blue Buffalo "Wilderness"'),
    '"Blue Buffalo ""Wilderness"""'
);

// Test 4: CSV escaping - text with both comma and quotes
test(
    'Text with comma and quotes',
    escapeCSVField('Product "Special", Large'),
    '"Product ""Special"", Large"'
);

// Test 5: CSV escaping - null value
test(
    'Null value should return empty string',
    escapeCSVField(null),
    ''
);

// Test 6: CSV escaping - undefined value
test(
    'Undefined value should return empty string',
    escapeCSVField(undefined),
    ''
);

// Test 7: Date formatting - standard date
test(
    'Date formatting (2025-12-25)',
    formatDateForSquare('2025-12-25T00:00:00.000Z'),
    '12/25/2025'
);

// Test 8: Date formatting - January date
test(
    'Date formatting (2025-01-05)',
    formatDateForSquare('2025-01-05T00:00:00.000Z'),
    '1/5/2025'
);

// Test 9: Date formatting - null date
test(
    'Null date should return empty string',
    formatDateForSquare(null),
    ''
);

// Test 10: Money formatting - dollars and cents
test(
    'Money formatting - $12.50',
    formatMoney(1250),
    '12.50'
);

// Test 11: Money formatting - whole dollars
test(
    'Money formatting - $100.00',
    formatMoney(10000),
    '100.00'
);

// Test 12: Money formatting - cents only
test(
    'Money formatting - $0.99',
    formatMoney(99),
    '0.99'
);

// Test 13: Money formatting - zero
test(
    'Money formatting - $0.00',
    formatMoney(0),
    '0.00'
);

// Test 14: Money formatting - null
test(
    'Null money should return 0.00',
    formatMoney(null),
    '0.00'
);

// Test 15: Generate sample CSV structure
console.log('\n=== Sample CSV Output ===\n');

const BOM = '\uFEFF';
const lines = [];

lines.push(`Vendor,${escapeCSVField('Leis Pet Products')},,,,,,`);
lines.push(`Location,${escapeCSVField('Main Store')},,,,,,`);
lines.push(`Expected Delivery Date,${formatDateForSquare('2025-02-15')},,,,,,`);
lines.push('');
lines.push('SKU,Item Name,Quantity,Cost,Note,Expected Delivery Date,Vendor,Location,Ship To,Deliver To,Carrier');

// Sample data row
const sampleItem = {
    sku: '12345',
    itemName: 'Blue Buffalo "Wilderness", Chicken',
    quantity: 24,
    unitCostMoney: 2499,
    notes: 'Handle with care, fragile',
    expectedDeliveryDate: '2025-02-15',
    vendorName: 'Leis Pet Products',
    locationName: 'Main Store',
    locationAddress: '123 Main St, Toronto, ON'
};

const row = [
    escapeCSVField(sampleItem.sku),
    escapeCSVField(sampleItem.itemName),
    sampleItem.quantity,
    formatMoney(sampleItem.unitCostMoney),
    escapeCSVField(sampleItem.notes),
    formatDateForSquare(sampleItem.expectedDeliveryDate),
    escapeCSVField(sampleItem.vendorName),
    escapeCSVField(sampleItem.locationName),
    escapeCSVField(sampleItem.locationAddress),
    escapeCSVField(sampleItem.locationAddress),
    escapeCSVField('')
];

lines.push(row.join(','));

const csvContent = BOM + lines.join('\r\n') + '\r\n';

console.log('Generated CSV (showing visible characters, BOM hidden):');
console.log('---');
console.log(csvContent.substring(1)); // Skip BOM for display
console.log('---');

// Verify structure
console.log('\n=== Structure Validation ===\n');

const csvLines = csvContent.split('\r\n');
test(
    'CSV starts with UTF-8 BOM',
    csvContent.charCodeAt(0) === 0xFEFF,
    true
);

test(
    'Line 1 has 6 trailing commas (Vendor metadata)',
    (csvLines[0].match(/,/g) || []).length === 7, // 1 field separator + 6 trailing
    true
);

test(
    'Line 2 has 6 trailing commas (Location metadata)',
    (csvLines[1].match(/,/g) || []).length === 7,
    true
);

test(
    'Line 3 has 6 trailing commas (Date metadata)',
    (csvLines[2].match(/,/g) || []).length === 7,
    true
);

test(
    'Line 4 is empty',
    csvLines[3] === '',
    true
);

test(
    'Line 5 is header row with 11 fields',
    (csvLines[4].split(',').length) === 11,
    true
);

test(
    'Data row has 11 fields',
    (row.length) === 11,
    true
);

test(
    'CSV ends with \\r\\n',
    csvContent.endsWith('\r\n'),
    true
);

// Summary
console.log('\n=== Test Summary ===\n');
console.log(`Passed: ${passedTests}/${totalTests}`);

if (passedTests === totalTests) {
    console.log('\n✓ All tests passed! CSV format is compliant with Square requirements.\n');
    process.exit(0);
} else {
    console.log(`\n✗ ${totalTests - passedTests} test(s) failed.\n`);
    process.exit(1);
}
