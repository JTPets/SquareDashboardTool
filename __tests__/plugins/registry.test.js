'use strict';

const fs = require('fs');
const path = require('path');
const { getInstalledPlugins, getPlugin, PLUGINS_DIR } = require('../../src/plugins/registry');
const logger = require('../../utils/logger');

describe('Plugin Registry', () => {

    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
        process.env = { ...originalEnv };
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('PLUGIN_')) delete process.env[key];
        }
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('getInstalledPlugins()', () => {

        test('returns empty object when plugins directory does not exist', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);

            const result = getInstalledPlugins();

            expect(result).toEqual({});
        });

        test('returns empty object when plugins directory is empty', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([]);

            const result = getInstalledPlugins();

            expect(result).toEqual({});
        });

        test('reads plugin metadata from package.json', () => {
            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (p === PLUGINS_DIR) return true;
                if (p.endsWith('package.json')) return true;
                return false;
            });
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: 'my-plugin', isDirectory: () => true }
            ]);
            jest.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ name: '@jtpets/my-plugin', version: '1.2.3' })
            );

            process.env.PLUGIN_MY_PLUGIN = 'true';

            const result = getInstalledPlugins();

            expect(result['my-plugin']).toEqual({
                path: path.join(PLUGINS_DIR, 'my-plugin'),
                version: '1.2.3',
                name: '@jtpets/my-plugin',
                enabled: true
            });
        });

        test('marks plugin as disabled when env var is not true', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: 'disabled-plugin', isDirectory: () => true }
            ]);
            jest.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ name: 'disabled-plugin', version: '0.1.0' })
            );

            process.env.PLUGIN_DISABLED_PLUGIN = 'false';

            const result = getInstalledPlugins();

            expect(result['disabled-plugin'].enabled).toBe(false);
        });

        test('marks plugin as disabled when env var is missing', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: 'no-env', isDirectory: () => true }
            ]);
            jest.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ name: 'no-env', version: '1.0.0' })
            );

            const result = getInstalledPlugins();

            expect(result['no-env'].enabled).toBe(false);
        });

        test('skips non-directory entries', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: '.gitkeep', isDirectory: () => false },
                { name: 'real-plugin', isDirectory: () => true }
            ]);
            jest.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ name: 'real-plugin', version: '1.0.0' })
            );

            const result = getInstalledPlugins();

            expect(Object.keys(result)).toEqual(['real-plugin']);
        });

        test('skips hidden directories', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: '.hidden', isDirectory: () => true }
            ]);

            const result = getInstalledPlugins();

            expect(result).toEqual({});
        });

        test('skips directories without package.json', () => {
            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (p === PLUGINS_DIR) return true;
                if (p.endsWith('package.json')) return false;
                return false;
            });
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: 'no-pkg', isDirectory: () => true }
            ]);

            const result = getInstalledPlugins();

            expect(result).toEqual({});
        });

        test('handles invalid package.json gracefully', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: 'bad-pkg', isDirectory: () => true }
            ]);
            jest.spyOn(fs, 'readFileSync').mockReturnValue('not json');

            const result = getInstalledPlugins();

            expect(result).toEqual({});
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Failed to read package.json for plugin bad-pkg'),
                expect.any(Object)
            );
        });

        test('defaults version to 0.0.0 when not in package.json', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: 'no-ver', isDirectory: () => true }
            ]);
            jest.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ name: 'no-ver' })
            );

            const result = getInstalledPlugins();

            expect(result['no-ver'].version).toBe('0.0.0');
        });

        test('handles readdir error gracefully', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
                throw new Error('permission denied');
            });

            const result = getInstalledPlugins();

            expect(result).toEqual({});
            expect(logger.error).toHaveBeenCalledWith(
                'Failed to read plugins directory',
                expect.any(Object)
            );
        });

        test('discovers multiple plugins', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: 'plugin-a', isDirectory: () => true },
                { name: 'plugin-b', isDirectory: () => true }
            ]);
            jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
                if (p.includes('plugin-a')) return JSON.stringify({ name: 'A', version: '1.0.0' });
                if (p.includes('plugin-b')) return JSON.stringify({ name: 'B', version: '2.0.0' });
                return '{}';
            });

            process.env.PLUGIN_PLUGIN_A = 'true';

            const result = getInstalledPlugins();

            expect(Object.keys(result)).toHaveLength(2);
            expect(result['plugin-a'].enabled).toBe(true);
            expect(result['plugin-b'].enabled).toBe(false);
        });
    });

    describe('getPlugin()', () => {

        test('returns null for non-existent plugin', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);

            const result = getPlugin('nonexistent');

            expect(result).toBeNull();
        });

        test('returns plugin info for installed plugin', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue([
                { name: 'test-plugin', isDirectory: () => true }
            ]);
            jest.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ name: 'test-plugin', version: '3.0.0' })
            );

            const result = getPlugin('test-plugin');

            expect(result).not.toBeNull();
            expect(result.version).toBe('3.0.0');
        });
    });
});
