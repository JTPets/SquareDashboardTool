'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const logger = require('../../utils/logger');

// We need to require the module fresh for each describe block that tests
// cloneRepo/pullRepo, because they reference childProcess.execSync directly.
// Use jest.spyOn to mock execSync within each test.

describe('Plugin Installer', () => {

    const originalEnv = process.env;
    let execSyncSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        execSyncSpy = jest.spyOn(childProcess, 'execSync').mockReturnValue(Buffer.from(''));
        process.env = { ...originalEnv };
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('PLUGIN_')) delete process.env[key];
        }
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    // Require after mocks are set up; module caching means this is fine
    // since installer.js uses childProcess.execSync (not destructured)
    const { installEnabledPlugins, discoverPlugins, cloneRepo, pullRepo, PLUGINS_DIR } = require('../../src/plugins/installer');

    describe('discoverPlugins()', () => {

        test('returns empty array when no PLUGIN_ env vars exist', () => {
            const plugins = discoverPlugins();
            expect(plugins).toEqual([]);
        });

        test('discovers enabled plugin with token and repo', () => {
            process.env.PLUGIN_SOCIAL_MEDIA_AUTOMATION = 'true';
            process.env.PLUGIN_SOCIAL_MEDIA_AUTOMATION_GIT_TOKEN = 'ghp_test123';
            process.env.PLUGIN_SOCIAL_MEDIA_AUTOMATION_REPO = 'https://github.com/org/repo.git';

            const plugins = discoverPlugins();

            expect(plugins).toHaveLength(1);
            expect(plugins[0]).toEqual({
                name: 'SOCIAL_MEDIA_AUTOMATION',
                dirName: 'social-media-automation',
                enabled: true,
                token: 'ghp_test123',
                repo: 'https://github.com/org/repo.git'
            });
        });

        test('discovers disabled plugin', () => {
            process.env.PLUGIN_MY_PLUGIN = 'false';

            const plugins = discoverPlugins();

            expect(plugins).toHaveLength(1);
            expect(plugins[0].enabled).toBe(false);
            expect(plugins[0].dirName).toBe('my-plugin');
        });

        test('handles plugin with missing token and repo', () => {
            process.env.PLUGIN_TEST_PLUGIN = 'true';

            const plugins = discoverPlugins();

            expect(plugins).toHaveLength(1);
            expect(plugins[0].token).toBeNull();
            expect(plugins[0].repo).toBeNull();
        });

        test('does not treat _GIT_TOKEN and _REPO vars as separate plugins', () => {
            process.env.PLUGIN_ABC = 'true';
            process.env.PLUGIN_ABC_GIT_TOKEN = 'tok';
            process.env.PLUGIN_ABC_REPO = 'url';

            const plugins = discoverPlugins();

            expect(plugins).toHaveLength(1);
            expect(plugins[0].name).toBe('ABC');
        });

        test('discovers multiple plugins', () => {
            process.env.PLUGIN_ALPHA = 'true';
            process.env.PLUGIN_ALPHA_GIT_TOKEN = 'tok1';
            process.env.PLUGIN_ALPHA_REPO = 'url1';
            process.env.PLUGIN_BETA = 'false';

            const plugins = discoverPlugins();

            expect(plugins).toHaveLength(2);
            const names = plugins.map(p => p.dirName);
            expect(names).toContain('alpha');
            expect(names).toContain('beta');
        });
    });

    describe('cloneRepo()', () => {

        test('calls execSync with auth-embedded URL', () => {
            cloneRepo('https://github.com/org/repo.git', 'mytoken', '/tmp/dest');

            expect(execSyncSpy).toHaveBeenCalledWith(
                'git clone --depth 1 "https://mytoken@github.com/org/repo.git" "/tmp/dest"',
                expect.objectContaining({ stdio: 'pipe', timeout: 60000 })
            );
        });

        test('throws sanitized error on failure', () => {
            execSyncSpy.mockImplementation(() => {
                const err = new Error('clone failed');
                err.stderr = Buffer.from('fatal: Authentication failed for https://secrettoken@github.com/org/repo.git');
                throw err;
            });

            expect(() => cloneRepo('https://github.com/org/repo.git', 'secrettoken', '/tmp/dest'))
                .toThrow(/\*\*\*/);
        });
    });

    describe('pullRepo()', () => {

        test('sets remote URL, pulls, then resets remote URL', () => {
            pullRepo('/tmp/plugin', 'tok', 'https://github.com/org/repo.git');

            expect(execSyncSpy).toHaveBeenCalledTimes(3);
            expect(execSyncSpy.mock.calls[0][0]).toContain('remote set-url origin "https://tok@github.com/org/repo.git"');
            expect(execSyncSpy.mock.calls[1][0]).toContain('pull origin main');
            expect(execSyncSpy.mock.calls[2][0]).toContain('remote set-url origin "https://github.com/org/repo.git"');
        });

        test('sanitizes token from error messages', () => {
            execSyncSpy.mockImplementation(() => {
                const err = new Error('pull failed');
                err.stderr = Buffer.from('error with mysecret in it');
                throw err;
            });

            expect(() => pullRepo('/tmp/p', 'mysecret', 'https://github.com/org/repo.git'))
                .toThrow(/\*\*\*/);
        });
    });

    describe('installEnabledPlugins()', () => {

        let existsSyncSpy, mkdirSyncSpy, rmSyncSpy;

        beforeEach(() => {
            existsSyncSpy = jest.spyOn(fs, 'existsSync');
            mkdirSyncSpy = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
            rmSyncSpy = jest.spyOn(fs, 'rmSync').mockReturnValue(undefined);
        });

        test('returns empty results when no plugins configured', async () => {
            existsSyncSpy.mockReturnValue(true);

            const results = await installEnabledPlugins();

            expect(results).toEqual({
                installed: [],
                updated: [],
                skipped: [],
                failed: []
            });
            expect(logger.info).toHaveBeenCalledWith('No plugins configured in environment');
        });

        test('skips disabled plugins', async () => {
            process.env.PLUGIN_FOO = 'false';
            existsSyncSpy.mockReturnValue(true);

            const results = await installEnabledPlugins();

            expect(results.skipped).toContain('foo');
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('foo'),
                expect.objectContaining({ plugin: 'foo' })
            );
        });

        test('fails when token is missing for enabled plugin', async () => {
            process.env.PLUGIN_BAR = 'true';
            process.env.PLUGIN_BAR_REPO = 'https://github.com/org/repo.git';
            existsSyncSpy.mockReturnValue(true);

            const results = await installEnabledPlugins();

            expect(results.failed).toContain('bar');
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('missing PLUGIN_BAR_GIT_TOKEN'),
                expect.any(Object)
            );
        });

        test('fails when repo is missing for enabled plugin', async () => {
            process.env.PLUGIN_BAZ = 'true';
            process.env.PLUGIN_BAZ_GIT_TOKEN = 'tok';
            existsSyncSpy.mockReturnValue(true);

            const results = await installEnabledPlugins();

            expect(results.failed).toContain('baz');
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('missing PLUGIN_BAZ_REPO'),
                expect.any(Object)
            );
        });

        test('clones plugin when not installed', async () => {
            process.env.PLUGIN_NEW = 'true';
            process.env.PLUGIN_NEW_GIT_TOKEN = 'tok';
            process.env.PLUGIN_NEW_REPO = 'https://github.com/org/new.git';

            existsSyncSpy.mockImplementation((p) => {
                if (p === PLUGINS_DIR) return true;
                return false;
            });

            const results = await installEnabledPlugins();

            expect(results.installed).toContain('new');
            expect(execSyncSpy).toHaveBeenCalledWith(
                expect.stringContaining('git clone'),
                expect.any(Object)
            );
        });

        test('pulls plugin when already installed', async () => {
            process.env.PLUGIN_EXISTING = 'true';
            process.env.PLUGIN_EXISTING_GIT_TOKEN = 'tok';
            process.env.PLUGIN_EXISTING_REPO = 'https://github.com/org/existing.git';

            existsSyncSpy.mockReturnValue(true);

            const results = await installEnabledPlugins();

            expect(results.updated).toContain('existing');
            expect(execSyncSpy).toHaveBeenCalledWith(
                expect.stringContaining('pull origin main'),
                expect.any(Object)
            );
        });

        test('handles clone failure gracefully', async () => {
            process.env.PLUGIN_FAIL = 'true';
            process.env.PLUGIN_FAIL_GIT_TOKEN = 'tok';
            process.env.PLUGIN_FAIL_REPO = 'https://github.com/org/fail.git';

            existsSyncSpy.mockImplementation((p) => {
                if (p === PLUGINS_DIR) return true;
                return false;
            });
            execSyncSpy.mockImplementation(() => {
                const err = new Error('network error');
                err.stderr = Buffer.from('network error');
                throw err;
            });

            const results = await installEnabledPlugins();

            expect(results.failed).toContain('fail');
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to install plugin fail'),
                expect.any(Object)
            );
        });

        test('creates plugins directory if it does not exist', async () => {
            existsSyncSpy.mockImplementation((p) => {
                if (p === PLUGINS_DIR) return false;
                return true;
            });

            await installEnabledPlugins();

            expect(mkdirSyncSpy).toHaveBeenCalledWith(PLUGINS_DIR, { recursive: true });
        });

        test('logs summary after processing', async () => {
            process.env.PLUGIN_A = 'false';
            existsSyncSpy.mockReturnValue(true);

            await installEnabledPlugins();

            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('Plugin installer complete'),
                expect.objectContaining({
                    installed: 0,
                    updated: 0,
                    skipped: 1,
                    failed: 0
                })
            );
        });
    });
});
