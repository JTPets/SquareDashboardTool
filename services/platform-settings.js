/**
 * Platform Settings Service
 *
 * Reads/writes platform-level configuration from the platform_settings table.
 * Uses in-memory cache with 5-minute TTL to reduce database reads.
 *
 * @module services/platform-settings
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

// In-memory cache: { key: { value, cachedAt } }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get a platform setting by key
 * @param {string} key - Setting key
 * @param {string} [defaultValue=null] - Fallback if key not found
 * @returns {Promise<string|null>} Setting value or default
 */
async function getSetting(key, defaultValue = null) {
    // Check cache first
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached.value;
    }

    try {
        const result = await db.query(
            'SELECT value FROM platform_settings WHERE key = $1',
            [key]
        );

        const value = result.rows.length > 0 ? result.rows[0].value : defaultValue;

        // Update cache
        cache.set(key, { value, cachedAt: Date.now() });

        return value;
    } catch (error) {
        logger.error('Failed to read platform setting', { key, error: error.message });
        // Return cached value if available (even if stale), otherwise default
        if (cached) {
            return cached.value;
        }
        return defaultValue;
    }
}

/**
 * Set a platform setting
 * @param {string} key - Setting key
 * @param {string} value - Setting value
 * @returns {Promise<void>}
 */
async function setSetting(key, value) {
    await db.query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value]
    );

    // Invalidate cache for this key
    cache.delete(key);

    logger.info('Platform setting updated', { key });
}

/**
 * Get all platform settings
 * @returns {Promise<Array<{key: string, value: string, updated_at: string}>>}
 */
async function getAllSettings() {
    const result = await db.query(
        'SELECT key, value, updated_at FROM platform_settings ORDER BY key'
    );
    return result.rows;
}

/**
 * Clear the in-memory cache (for testing)
 */
function clearCache() {
    cache.clear();
}

module.exports = {
    getSetting,
    setSetting,
    getAllSettings,
    clearCache
};
