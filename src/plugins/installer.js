'use strict';

/**
 * Plugin Installer
 *
 * Installs and updates plugins from GitHub repositories via git clone/pull.
 * Reads PLUGIN_* environment variables to discover enabled plugins.
 * Gracefully handles all errors — never crashes the app.
 */

const childProcess = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');

const PLUGINS_DIR = path.join(__dirname, '../../plugins');

/**
 * Derive plugin config from environment variables.
 * Scans for PLUGIN_<NAME>=true and extracts token + repo URL.
 *
 * @returns {Array<{name: string, dirName: string, enabled: boolean, token: string|null, repo: string|null}>}
 */
function discoverPlugins() {
    const plugins = [];
    const seen = new Set();

    for (const [key, value] of Object.entries(process.env)) {
        // Match PLUGIN_<NAME>=true/false but NOT PLUGIN_<NAME>_GIT_TOKEN or _REPO
        const match = key.match(/^PLUGIN_([A-Z0-9_]+)$/);
        if (!match) continue;

        const rawName = match[1];
        // Skip if this is actually a sub-key (TOKEN, REPO)
        if (rawName.endsWith('_GIT_TOKEN') || rawName.endsWith('_REPO')) continue;
        if (seen.has(rawName)) continue;
        seen.add(rawName);

        const dirName = rawName.toLowerCase().replace(/_/g, '-');
        const enabled = value === 'true';
        const token = process.env[`PLUGIN_${rawName}_GIT_TOKEN`] || null;
        const repo = process.env[`PLUGIN_${rawName}_REPO`] || null;

        plugins.push({ name: rawName, dirName, enabled, token, repo });
    }

    return plugins;
}

/**
 * Clone a plugin repository into the plugins directory.
 *
 * @param {string} repo - Repository URL (https://github.com/...)
 * @param {string} token - GitHub personal access token
 * @param {string} destPath - Destination directory path
 * @returns {boolean} true if clone succeeded
 */
function cloneRepo(repo, token, destPath) {
    const authedUrl = repo.replace('https://', `https://${token}@`);
    try {
        childProcess.execSync(`git clone --depth 1 "${authedUrl}" "${destPath}"`, {
            stdio: 'pipe',
            timeout: 60000
        });
        return true;
    } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : err.message;
        // Sanitize token from error messages
        const safeError = stderr.replace(new RegExp(token, 'g'), '***');
        throw new Error(safeError);
    }
}

/**
 * Pull latest changes for an already-installed plugin.
 *
 * @param {string} pluginPath - Path to the plugin directory
 * @param {string} token - GitHub personal access token (for authenticated pulls)
 * @param {string} repo - Repository URL
 * @returns {boolean} true if pull succeeded
 */
function pullRepo(pluginPath, token, repo) {
    try {
        // Set the remote URL with auth token for the pull
        const authedUrl = repo.replace('https://', `https://${token}@`);
        childProcess.execSync(`git -C "${pluginPath}" remote set-url origin "${authedUrl}"`, {
            stdio: 'pipe',
            timeout: 10000
        });
        childProcess.execSync(`git -C "${pluginPath}" pull origin main`, {
            stdio: 'pipe',
            timeout: 60000
        });
        // Remove token from remote URL after pull
        childProcess.execSync(`git -C "${pluginPath}" remote set-url origin "${repo}"`, {
            stdio: 'pipe',
            timeout: 10000
        });
        return true;
    } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : err.message;
        const safeError = token ? stderr.replace(new RegExp(token, 'g'), '***') : stderr;
        throw new Error(safeError);
    }
}

/**
 * Install or update all enabled plugins.
 * Called during app startup. Never throws — logs errors and continues.
 *
 * @returns {Promise<{installed: string[], updated: string[], skipped: string[], failed: string[]}>}
 */
async function installEnabledPlugins() {
    const results = { installed: [], updated: [], skipped: [], failed: [] };

    // Ensure plugins directory exists
    if (!fs.existsSync(PLUGINS_DIR)) {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    }

    const plugins = discoverPlugins();

    if (plugins.length === 0) {
        logger.info('No plugins configured in environment');
        return results;
    }

    for (const plugin of plugins) {
        const pluginPath = path.join(PLUGINS_DIR, plugin.dirName);

        if (!plugin.enabled) {
            logger.info(`Plugin ${plugin.dirName} is disabled (skipped)`, {
                plugin: plugin.dirName
            });
            results.skipped.push(plugin.dirName);
            continue;
        }

        // Validate required config
        if (!plugin.token) {
            logger.warn(`Plugin ${plugin.dirName}: missing PLUGIN_${plugin.name}_GIT_TOKEN — skipped`, {
                plugin: plugin.dirName,
                hint: `Set PLUGIN_${plugin.name}_GIT_TOKEN in your .env file`
            });
            results.failed.push(plugin.dirName);
            continue;
        }

        if (!plugin.repo) {
            logger.warn(`Plugin ${plugin.dirName}: missing PLUGIN_${plugin.name}_REPO — skipped`, {
                plugin: plugin.dirName,
                hint: `Set PLUGIN_${plugin.name}_REPO in your .env file`
            });
            results.failed.push(plugin.dirName);
            continue;
        }

        try {
            const alreadyInstalled = fs.existsSync(pluginPath) &&
                fs.existsSync(path.join(pluginPath, '.git'));

            if (alreadyInstalled) {
                pullRepo(pluginPath, plugin.token, plugin.repo);
                logger.info(`Plugin ${plugin.dirName} updated`, {
                    plugin: plugin.dirName
                });
                results.updated.push(plugin.dirName);
            } else {
                // Remove directory if it exists but isn't a git repo
                if (fs.existsSync(pluginPath)) {
                    fs.rmSync(pluginPath, { recursive: true, force: true });
                }
                cloneRepo(plugin.repo, plugin.token, pluginPath);
                logger.info(`Plugin ${plugin.dirName} installed`, {
                    plugin: plugin.dirName
                });
                results.installed.push(plugin.dirName);
            }
        } catch (err) {
            logger.error(`Failed to install plugin ${plugin.dirName}: ${err.message}`, {
                plugin: plugin.dirName,
                error: err.message
            });
            results.failed.push(plugin.dirName);
        }
    }

    // Summary log
    const parts = [];
    if (results.installed.length) parts.push(`installed: ${results.installed.join(', ')}`);
    if (results.updated.length) parts.push(`updated: ${results.updated.join(', ')}`);
    if (results.skipped.length) parts.push(`skipped: ${results.skipped.join(', ')}`);
    if (results.failed.length) parts.push(`failed: ${results.failed.join(', ')}`);
    logger.info(`Plugin installer complete — ${parts.join('; ') || 'nothing to do'}`, {
        installed: results.installed.length,
        updated: results.updated.length,
        skipped: results.skipped.length,
        failed: results.failed.length
    });

    return results;
}

module.exports = {
    installEnabledPlugins,
    discoverPlugins,
    cloneRepo,
    pullRepo,
    PLUGINS_DIR
};
