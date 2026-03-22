/**
 * Utility Script Tag Regression Test
 *
 * Reads every HTML page and its corresponding JS file,
 * checks which utility functions the JS references, and
 * verifies the HTML includes the required utility script tag.
 *
 * Prevents the "formatNumber is undefined" class of bug from recurring.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const JS_DIR = path.join(PUBLIC_DIR, 'js');

// Map: utility function name → script file that provides it
const FUNCTION_TO_SCRIPT = {
    escapeHtml: 'escape.js',
    escapeAttr: 'escape.js',
    escapeHtmlAttr: 'escape.js',
    showToast: 'toast.js',
    formatCurrency: 'format-currency.js',
    formatDollars: 'format-currency.js',
    formatNumber: 'format-currency.js',
    formatDate: 'date-format.js',
    formatDateTime: 'date-format.js',
};

// Build regex that matches any utility function call
// Word boundary ensures we don't match substrings like "reFormatDate"
const FUNCTION_NAMES = Object.keys(FUNCTION_TO_SCRIPT);
const FUNCTION_REGEX = new RegExp(
    `\\b(${FUNCTION_NAMES.join('|')})\\s*\\(`,
    'g'
);

/**
 * Get all HTML files in public/
 */
function getHtmlFiles() {
    return fs.readdirSync(PUBLIC_DIR)
        .filter(f => f.endsWith('.html'))
        .map(f => path.join(PUBLIC_DIR, f));
}

/**
 * For a given HTML file, find its matching page JS file.
 * E.g. logs.html → js/logs.js
 */
function getPageJsFile(htmlPath) {
    const base = path.basename(htmlPath, '.html');
    const jsPath = path.join(JS_DIR, `${base}.js`);
    return fs.existsSync(jsPath) ? jsPath : null;
}

/**
 * Extract which utility scripts an HTML file includes.
 * Returns a Set of script filenames like "escape.js", "toast.js", etc.
 */
function getIncludedUtilScripts(htmlContent) {
    const regex = /src=["']\/js\/utils\/([^"']+)["']/g;
    const scripts = new Set();
    let match;
    while ((match = regex.exec(htmlContent)) !== null) {
        scripts.add(match[1]);
    }
    return scripts;
}

/**
 * Extract which utility functions a JS file references.
 * Returns a Set of function names.
 */
function getUsedFunctions(jsContent) {
    const used = new Set();
    let match;
    // Reset regex lastIndex
    FUNCTION_REGEX.lastIndex = 0;
    while ((match = FUNCTION_REGEX.exec(jsContent)) !== null) {
        used.add(match[1]);
    }
    return used;
}

/**
 * Determine which utility scripts are required by a JS file.
 * Returns a Set of script filenames.
 */
function getRequiredScripts(jsContent) {
    const used = getUsedFunctions(jsContent);
    const required = new Set();
    for (const fn of used) {
        required.add(FUNCTION_TO_SCRIPT[fn]);
    }
    return required;
}

describe('Utility script tags in HTML pages', () => {
    const htmlFiles = getHtmlFiles();

    // Generate one test per HTML file that has a matching JS file
    const testCases = htmlFiles
        .map(htmlPath => {
            const jsPath = getPageJsFile(htmlPath);
            return { htmlPath, jsPath, name: path.basename(htmlPath) };
        })
        .filter(tc => tc.jsPath !== null);

    test('found HTML files with matching JS files', () => {
        expect(testCases.length).toBeGreaterThan(0);
    });

    test.each(testCases.map(tc => [tc.name, tc]))(
        '%s includes all required utility scripts',
        (_name, { htmlPath, jsPath }) => {
            const htmlContent = fs.readFileSync(htmlPath, 'utf8');
            const jsContent = fs.readFileSync(jsPath, 'utf8');

            const included = getIncludedUtilScripts(htmlContent);
            const required = getRequiredScripts(jsContent);

            const missing = [];
            for (const script of required) {
                if (!included.has(script)) {
                    // Find which functions need this script
                    const fns = Object.entries(FUNCTION_TO_SCRIPT)
                        .filter(([, s]) => s === script)
                        .map(([fn]) => fn)
                        .filter(fn => getUsedFunctions(jsContent).has(fn));
                    missing.push(`${script} (provides: ${fns.join(', ')})`);
                }
            }

            expect(missing).toEqual([]);
        }
    );

    test('FUNCTION_TO_SCRIPT covers all utility files', () => {
        const utilDir = path.join(JS_DIR, 'utils');
        const utilFiles = fs.readdirSync(utilDir).filter(f => f.endsWith('.js'));

        // merchant-context.js has no callable functions, only sets globals
        const expectedFiles = utilFiles.filter(f => f !== 'merchant-context.js');
        const coveredFiles = new Set(Object.values(FUNCTION_TO_SCRIPT));

        for (const file of expectedFiles) {
            expect(coveredFiles.has(file)).toBe(true);
        }
    });
});
