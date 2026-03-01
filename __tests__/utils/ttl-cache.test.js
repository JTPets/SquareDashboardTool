/**
 * Tests for TTL Cache utility
 */

const TTLCache = require('../../utils/ttl-cache');

describe('TTLCache', () => {
    let cache;

    beforeEach(() => {
        cache = new TTLCache(100); // 100ms TTL for fast tests
    });

    afterEach(() => {
        cache.clear();
    });

    it('should store and retrieve values', () => {
        cache.set('key1', 'value1');
        expect(cache.get('key1')).toBe('value1');
    });

    it('should return null for missing keys', () => {
        expect(cache.get('nonexistent')).toBeNull();
    });

    it('should return null for expired keys', async () => {
        cache.set('key1', 'value1');
        expect(cache.get('key1')).toBe('value1');

        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 150));

        expect(cache.get('key1')).toBeNull();
    });

    it('should report has() correctly for live entries', () => {
        cache.set('key1', 'value1');
        expect(cache.has('key1')).toBe(true);
        expect(cache.has('nonexistent')).toBe(false);
    });

    it('should report has() as false for expired entries', async () => {
        cache.set('key1', 'value1');
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(cache.has('key1')).toBe(false);
    });

    it('should support object values', () => {
        const obj = { customerId: 'cust_123', awarded: true };
        cache.set('order:abc', obj);
        expect(cache.get('order:abc')).toEqual(obj);
    });

    it('should clear all entries', () => {
        cache.set('key1', 'a');
        cache.set('key2', 'b');
        expect(cache.size).toBe(2);

        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.get('key1')).toBeNull();
    });

    it('should use default 120s TTL when none specified', () => {
        const defaultCache = new TTLCache();
        expect(defaultCache.ttlMs).toBe(120000);
    });

    it('should overwrite existing entries', () => {
        cache.set('key1', 'first');
        cache.set('key1', 'second');
        expect(cache.get('key1')).toBe('second');
    });

    it('should handle different keys independently', () => {
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        expect(cache.get('key1')).toBe('value1');
        expect(cache.get('key2')).toBe('value2');
    });

    it('should clean up expired entries on get()', async () => {
        cache.set('key1', 'value1');
        await new Promise(resolve => setTimeout(resolve, 150));

        // get() should delete the expired entry
        cache.get('key1');
        expect(cache.size).toBe(0);
    });
});
