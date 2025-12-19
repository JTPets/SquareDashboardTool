/**
 * PM2 Ecosystem Configuration
 *
 * All file writes are consolidated into the /output directory:
 * - output/logs/    - Application logs (Winston rotating logs)
 * - output/feeds/   - Generated GMC feed files
 * - output/temp/    - Temporary files (DB imports, etc.)
 *
 * This configuration excludes the output folder from watch mode
 * to prevent restart loops when files are generated.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --env production
 */

module.exports = {
  apps: [{
    name: 'square-dashboard-addon',
    script: 'server.js',

    // Watch mode configuration
    watch: true,
    ignore_watch: [
      'node_modules',
      'output',           // All generated files (logs, feeds, temp)
      'logs',             // Legacy path (if any)
      'temp',             // Legacy path (if any)
      '.git',
      '*.log',
      '.env'              // Environment file changes are intentional
    ],
    watch_options: {
      followSymlinks: false,
      usePolling: false   // Set to true if on network filesystem
    },

    // Instance configuration
    instances: 1,
    exec_mode: 'fork',

    // Restart behavior
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '500M',

    // Logging - PM2's own logs (separate from app Winston logs)
    log_file: './output/logs/pm2-combined.log',
    out_file: './output/logs/pm2-out.log',
    error_file: './output/logs/pm2-error.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

    // Environment variables
    env: {
      NODE_ENV: 'development',
      PORT: 5001
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 5001
    }
  }]
};
