'use strict';

jest.mock('../../src/plugins/registry');

const { loadPlugins } = require('../../src/plugins/loader');
const { getInstalledPlugins } = require('../../src/plugins/registry');
const logger = require('../../utils/logger');

describe('Plugin Loader', () => {

    const mockApp = { use: jest.fn() };
    const mockDb = { query: jest.fn() };
    const mockConfig = { NODE_ENV: 'test' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns empty results when no plugins are installed', async () => {
        getInstalledPlugins.mockReturnValue({});

        const results = await loadPlugins(mockApp, mockDb, mockConfig);

        expect(results).toEqual({ loaded: [], skipped: [], failed: [] });
        expect(logger.info).toHaveBeenCalledWith(
            'No plugins installed — skipping plugin loading'
        );
    });

    test('skips disabled plugins', async () => {
        getInstalledPlugins.mockReturnValue({
            'my-plugin': {
                path: '/plugins/my-plugin',
                version: '1.0.0',
                name: 'my-plugin',
                enabled: false
            }
        });

        const results = await loadPlugins(mockApp, mockDb, mockConfig);

        expect(results.skipped).toContain('my-plugin');
        expect(results.loaded).toHaveLength(0);
    });

    test('loads enabled plugin with valid init function', async () => {
        const mockInit = jest.fn().mockResolvedValue();
        const pluginPath = '/tmp/test-plugins/good-plugin';

        getInstalledPlugins.mockReturnValue({
            'good-plugin': {
                path: pluginPath,
                version: '2.0.0',
                name: 'good-plugin',
                enabled: true
            }
        });

        // Mock require for the plugin entry point
        jest.doMock(pluginPath + '/src/index.js', () => ({
            name: '@jtpets/good-plugin',
            version: '2.0.0',
            init: mockInit
        }), { virtual: true });

        const results = await loadPlugins(mockApp, mockDb, mockConfig);

        expect(results.loaded).toContain('good-plugin');
        expect(mockInit).toHaveBeenCalledWith(mockApp, mockDb, mockConfig);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Loaded plugin: @jtpets/good-plugin v2.0.0'),
            expect.any(Object)
        );
    });

    test('fails when plugin has no init function', async () => {
        const pluginPath = '/tmp/test-plugins/no-init-plugin';

        getInstalledPlugins.mockReturnValue({
            'no-init-plugin': {
                path: pluginPath,
                version: '1.0.0',
                name: 'no-init-plugin',
                enabled: true
            }
        });

        jest.doMock(pluginPath + '/src/index.js', () => ({
            name: 'no-init-plugin',
            version: '1.0.0'
            // no init function
        }), { virtual: true });

        const results = await loadPlugins(mockApp, mockDb, mockConfig);

        expect(results.failed).toContain('no-init-plugin');
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('does not export an init function'),
            expect.any(Object)
        );
    });

    test('fails when plugin entry point cannot be required', async () => {
        const pluginPath = '/tmp/test-plugins/broken-plugin';

        getInstalledPlugins.mockReturnValue({
            'broken-plugin': {
                path: pluginPath,
                version: '1.0.0',
                name: 'broken-plugin',
                enabled: true
            }
        });

        // Don't mock the require — it will fail naturally since the path doesn't exist

        const results = await loadPlugins(mockApp, mockDb, mockConfig);

        expect(results.failed).toContain('broken-plugin');
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to load plugin broken-plugin'),
            expect.any(Object)
        );
    });

    test('continues loading other plugins when one fails', async () => {
        const brokenPath = '/tmp/test-plugins/broken';
        const goodPath = '/tmp/test-plugins/good';

        getInstalledPlugins.mockReturnValue({
            'broken': {
                path: brokenPath,
                version: '1.0.0',
                name: 'broken',
                enabled: true
            },
            'good': {
                path: goodPath,
                version: '1.0.0',
                name: 'good',
                enabled: true
            }
        });

        // broken has no mock, so require will fail
        jest.doMock(goodPath + '/src/index.js', () => ({
            name: 'good',
            version: '1.0.0',
            init: jest.fn().mockResolvedValue()
        }), { virtual: true });

        const results = await loadPlugins(mockApp, mockDb, mockConfig);

        expect(results.failed).toContain('broken');
        expect(results.loaded).toContain('good');
    });

    test('handles init throwing an error', async () => {
        const pluginPath = '/tmp/test-plugins/throw-plugin';

        getInstalledPlugins.mockReturnValue({
            'throw-plugin': {
                path: pluginPath,
                version: '1.0.0',
                name: 'throw-plugin',
                enabled: true
            }
        });

        jest.doMock(pluginPath + '/src/index.js', () => ({
            name: 'throw-plugin',
            version: '1.0.0',
            init: jest.fn().mockRejectedValue(new Error('init boom'))
        }), { virtual: true });

        const results = await loadPlugins(mockApp, mockDb, mockConfig);

        expect(results.failed).toContain('throw-plugin');
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('init boom'),
            expect.any(Object)
        );
    });

    test('logs summary after processing', async () => {
        getInstalledPlugins.mockReturnValue({
            'disabled': {
                path: '/tmp/test-plugins/disabled',
                version: '1.0.0',
                name: 'disabled',
                enabled: false
            }
        });

        await loadPlugins(mockApp, mockDb, mockConfig);

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Plugin loader complete'),
            expect.objectContaining({
                loaded: 0,
                skipped: 1,
                failed: 0
            })
        );
    });
});
