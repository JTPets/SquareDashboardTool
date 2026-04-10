# Plugin Architecture

SqTools supports dynamic plugins that are installed from private GitHub repositories at startup and loaded into the Express application.

## Overview

```
Startup Sequence:
  1. Load config / connect database / run schema migrations
  2. installEnabledPlugins()  — clone or pull from GitHub
  3. loadPlugins(app, db, config)  — require + init each plugin
  4. Register core routes / start server
```

Plugins live in the `plugins/` directory (git-ignored). The infrastructure code lives in `src/plugins/`.

## File Structure

```
src/plugins/
  installer.js    — Clones/pulls plugin repos based on PLUGIN_* env vars
  registry.js     — Scans plugins/ folder, reads package.json metadata
  loader.js       — Requires and initializes enabled plugins
  featureGate.js  — Middleware to gate plugin routes by subscription

plugins/
  .gitkeep
  social-media-automation/    (installed at runtime, git-ignored)
    package.json
    src/
      index.js               (plugin entry point)
```

## Environment Variables

Each plugin requires three env vars:

```bash
PLUGIN_<NAME>=true|false
PLUGIN_<NAME>_GIT_TOKEN=ghp_xxxxxxxxxxxx
PLUGIN_<NAME>_REPO=https://github.com/org/repo.git
```

Example for a social media automation plugin:

```bash
PLUGIN_SOCIAL_MEDIA_AUTOMATION=true
PLUGIN_SOCIAL_MEDIA_AUTOMATION_GIT_TOKEN=ghp_abc123
PLUGIN_SOCIAL_MEDIA_AUTOMATION_REPO=https://github.com/jtpets/jtpets-retail-automation.git
```

The `<NAME>` portion maps to the directory name: underscores become hyphens, lowercase. `SOCIAL_MEDIA_AUTOMATION` becomes `social-media-automation`.

## Writing a Plugin

A plugin is a Node.js package with this structure:

```
my-plugin/
  package.json      { "name": "@jtpets/my-plugin", "version": "1.0.0" }
  src/
    index.js        Entry point — must export { name, version, init }
```

### Plugin Entry Point

```javascript
// src/index.js
module.exports = {
    name: '@jtpets/my-plugin',
    version: '1.0.0',

    async init(app, db, config) {
        // Register routes
        const routes = require('./routes');
        const { requirePluginFeature } = require('../../src/plugins/featureGate');
        app.use('/api/plugins/my-plugin', requirePluginFeature('my_plugin'), routes);

        // Register cron jobs, run migrations, etc.
    }
};
```

### What `init` receives

| Argument | Type | Description |
|----------|------|-------------|
| `app` | Express | The Express application — register routes with `app.use()` |
| `db` | Object | Database module (`utils/database`) — use `db.query()`, `db.transaction()` |
| `config` | Object | `process.env` — read any configuration values |

### Rules

- **Never crash the app.** If your init fails, it's caught and logged — other plugins still load.
- **Use parameterized SQL.** Same rules as core: `db.query('SELECT * FROM x WHERE id = $1', [id])`.
- **Multi-tenant isolation.** Always filter by `merchant_id`.
- **Use `requirePluginFeature()`** to gate your routes by merchant subscription.

## Feature Gate

The `requirePluginFeature(featureName)` middleware checks if a merchant's subscription includes the named feature. Platform owners bypass all checks.

```javascript
const { requirePluginFeature } = require('../../src/plugins/featureGate');

// In plugin init:
app.use('/api/plugins/retail-automation',
    requirePluginFeature('retail_automation'),
    routes
);
```

Returns `403` with code `PLUGIN_FEATURE_REQUIRED` if the merchant doesn't have the feature.

## Installer Behavior

| Scenario | Result |
|----------|--------|
| `PLUGIN_X=false` | Skipped — logged as disabled |
| `PLUGIN_X=true`, no token | Warning logged, skipped |
| `PLUGIN_X=true`, no repo | Warning logged, skipped |
| `PLUGIN_X=true`, valid token, not installed | `git clone --depth 1` into `plugins/x` |
| `PLUGIN_X=true`, valid token, already installed | `git pull origin main` |
| Clone/pull fails | Error logged, app continues |

## Registry

`getInstalledPlugins()` returns a map of all plugins found in `plugins/`:

```javascript
{
  'social-media-automation': {
    path: '/absolute/path/to/plugins/social-media-automation',
    version: '1.0.0',
    name: '@jtpets/retail-automation',
    enabled: true
  }
}
```

Reads `package.json` from each subdirectory. No code is required/executed.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Plugin not installing | Check that `PLUGIN_<NAME>=true`, `_GIT_TOKEN`, and `_REPO` are set |
| Auth failure on clone | Verify the GitHub token has `repo` scope and hasn't expired |
| Plugin not loading | Ensure `src/index.js` exists and exports `{ name, version, init }` |
| Feature gate blocking | Check merchant's subscription features include the plugin's feature key |
| Plugin errors on startup | Check logs — plugin errors are caught and don't crash the app |
