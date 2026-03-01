/**
 * TTL Cache
 *
 * In-memory cache with automatic time-to-live expiration.
 * Used for deduplication guards across webhook handlers.
 *
 * Per-process only — PM2 cluster mode would need Redis for
 * cross-process dedup. The DB checks remain authoritative.
 *
 * @module utils/ttl-cache
 */

class TTLCache {
    /**
     * @param {number} ttlMs - Time-to-live in milliseconds (default 120s)
     */
    constructor(ttlMs = 120000) {
        this.cache = new Map();
        this.ttlMs = ttlMs;
    }

    /**
     * Store a value with automatic expiration.
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
    }

    /**
     * Retrieve a value if it hasn't expired.
     * Expired entries are cleaned up lazily on access.
     * @param {string} key
     * @returns {*|null} The stored value or null if missing/expired
     */
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expires) {
            this.cache.delete(key);
            return null;
        }
        return entry.value;
    }

    /**
     * Check if a non-expired entry exists for the key.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return this.get(key) !== null;
    }

    /**
     * Remove all entries.
     */
    clear() {
        this.cache.clear();
    }

    /**
     * Get the number of entries (including potentially expired ones).
     * @returns {number}
     */
    get size() {
        return this.cache.size;
    }
}

module.exports = TTLCache;
