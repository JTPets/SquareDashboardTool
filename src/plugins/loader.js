'use strict';

/**
 * Plugin Loader
 *
 * Loads and initializes enabled plugins. Each plugin must export:
 *   { name: string, version: string, init: async (app, db, config) => void }
 *
 * Plugins register their own routes, crons, and migrations via the init function.
 * Errors in one plugin do not block loading of other plugins.
 */

const path = require('path');
const logger = require('../../utils/logger');
const { getInstalledPlugins } = require('./registry');

/**
 * Load and initialize all enabled plugins.
 *
 * @param {Object} app - Express application instance
 * @param {Object} db - Database module (utils/database)
 * @param {Object} config - Application config (process.env or custom)
 * @returns {Promise<{loaded: string[], skipped: string[], failed: string[]}>}
 */
async function loadPlugins(app, db, config) {
    const results = { loaded: [], skipped: [], failed: [] };
    const registry = getInstalledPlugins();
    const pluginNames = Object.keys(registry);

    if (pluginNames.length === 0) {
        logger.info('No plugins installed — skipping plugin loading');
        return results;
    }

    for (const pluginName of pluginNames) {
        const pluginInfo = registry[pluginName];

        if (!pluginInfo.enabled) {
            logger.debug(`Plugin ${pluginName} is not enabled — skipping`, {
                plugin: pluginName
            });
            results.skipped.push(pluginName);
            continue;
        }

        try {
            const entryPoint = path.join(pluginInfo.path, 'src', 'index.js');

            // Require the plugin module
            let pluginModule;
            try {
                pluginModule = require(entryPoint);
            } catch (requireErr) {
                throw new Error(`Cannot load entry point src/index.js: ${requireErr.message}`);
            }

            // Validate exports
            if (typeof pluginModule.init !== 'function') {
                throw new Error('Plugin does not export an init function');
            }

            // Call plugin init
            await pluginModule.init(app, db, config);

            const displayName = pluginModule.name || pluginName;
            const displayVersion = pluginModule.version || pluginInfo.version;

            logger.info(`Loaded plugin: ${displayName} v${displayVersion}`, {
                plugin: pluginName,
                name: displayName,
                version: displayVersion
            });
            results.loaded.push(pluginName);
        } catch (err) {
            logger.error(`Failed to load plugin ${pluginName}: ${err.message}`, {
                plugin: pluginName,
                error: err.message
            });
            results.failed.push(pluginName);
        }
    }

    // Summary log
    const parts = [];
    if (results.loaded.length) parts.push(`loaded: ${results.loaded.join(', ')}`);
    if (results.skipped.length) parts.push(`skipped: ${results.skipped.join(', ')}`);
    if (results.failed.length) parts.push(`failed: ${results.failed.join(', ')}`);
    logger.info(`Plugin loader complete — ${parts.join('; ') || 'nothing to do'}`, {
        loaded: results.loaded.length,
        skipped: results.skipped.length,
        failed: results.failed.length
    });

    return results;
}

module.exports = { loadPlugins };
