'use strict';

/**
 * Plugin Registry
 *
 * Scans the plugins/ directory for installed plugins.
 * Reads each plugin's package.json to extract metadata.
 * Pure file scanning — no side effects, no require() of plugin code.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');

const PLUGINS_DIR = path.join(__dirname, '../../plugins');

/**
 * Scan the plugins directory and return a map of installed plugins.
 *
 * Each entry contains:
 *   - path: absolute path to the plugin directory
 *   - version: from package.json
 *   - name: from package.json (or directory name)
 *   - enabled: whether PLUGIN_<NAME>=true in env
 *
 * @returns {Object<string, {path: string, version: string, name: string, enabled: boolean}>}
 */
function getInstalledPlugins() {
    const registry = {};

    if (!fs.existsSync(PLUGINS_DIR)) {
        return registry;
    }

    let entries;
    try {
        entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    } catch (err) {
        logger.error('Failed to read plugins directory', {
            error: err.message,
            path: PLUGINS_DIR
        });
        return registry;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;

        const pluginDir = path.join(PLUGINS_DIR, entry.name);
        const pkgPath = path.join(pluginDir, 'package.json');

        if (!fs.existsSync(pkgPath)) {
            logger.debug(`Skipping ${entry.name}: no package.json found`, {
                plugin: entry.name
            });
            continue;
        }

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const envKey = entry.name.replace(/-/g, '_').toUpperCase();
            const enabled = process.env[`PLUGIN_${envKey}`] === 'true';

            registry[entry.name] = {
                path: pluginDir,
                version: pkg.version || '0.0.0',
                name: pkg.name || entry.name,
                enabled
            };
        } catch (err) {
            logger.warn(`Failed to read package.json for plugin ${entry.name}`, {
                plugin: entry.name,
                error: err.message
            });
        }
    }

    return registry;
}

/**
 * Get a specific plugin's info from the registry.
 *
 * @param {string} pluginName - The plugin directory name (e.g. 'social-media-automation')
 * @returns {Object|null} Plugin info or null if not found
 */
function getPlugin(pluginName) {
    const registry = getInstalledPlugins();
    return registry[pluginName] || null;
}

module.exports = {
    getInstalledPlugins,
    getPlugin,
    PLUGINS_DIR
};
