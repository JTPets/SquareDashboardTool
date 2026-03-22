'use strict';

/**
 * Staff Roles & Permissions — BACKLOG-41
 *
 * Feature × role permission matrix. Stored in code, not DB.
 * Permission levels: 'read', 'write', 'admin'
 *
 * Roles:
 *   owner    — full access to everything
 *   manager  — read/write/admin on most features; no admin on billing, staff, OAuth, subscription
 *   clerk    — limited read/write on scanning features; read-only on some; no access to sensitive
 *   readonly — read-only on dashboard, inventory, sales velocity, delivery status
 */

const { modules } = require('./feature-registry');

// All permission levels for convenience
const ALL = ['read', 'write', 'admin'];
const READ_WRITE = ['read', 'write'];
const READ_ONLY = ['read'];
const NONE = [];

/**
 * Features where manager does NOT get admin access.
 * Manager still gets read+write on these (except staff where they get read only).
 */
const MANAGER_NO_ADMIN = new Set([
    'billing', 'staff', 'oauth', 'subscription'
]);

/**
 * Features clerk can read+write (scanning/operational features)
 */
const CLERK_WRITE_FEATURES = new Set([
    'cycle_counts', 'delivery', 'expiry'
]);

/**
 * Features clerk can read only
 */
const CLERK_READ_FEATURES = new Set([
    'reorder', 'base'
]);

/**
 * Features clerk has NO access to
 */
const CLERK_DENIED = new Set([
    'loyalty', 'ai_tools', 'gmc'
]);

/**
 * Features readonly can read
 */
const READONLY_FEATURES = new Set([
    'base'
]);

/**
 * Permission matrix keyed by feature module key.
 * Each entry maps role → array of permission levels.
 */
const permissions = {};

// Build permissions for each feature module from feature-registry
for (const mod of Object.values(modules)) {
    permissions[mod.key] = {
        owner: ALL,
        manager: MANAGER_NO_ADMIN.has(mod.key) ? READ_WRITE : ALL,
        clerk: CLERK_WRITE_FEATURES.has(mod.key)
            ? READ_WRITE
            : CLERK_READ_FEATURES.has(mod.key)
                ? READ_ONLY
                : NONE,
        readonly: READONLY_FEATURES.has(mod.key) ? READ_ONLY : NONE,
    };
}

// Virtual feature keys not in feature-registry but used for access control
const virtualFeatures = {
    billing: {
        owner: ALL,
        manager: READ_ONLY,
        clerk: NONE,
        readonly: NONE,
    },
    staff: {
        owner: ALL,
        manager: READ_ONLY,
        clerk: NONE,
        readonly: NONE,
    },
    oauth: {
        owner: ALL,
        manager: READ_WRITE,
        clerk: NONE,
        readonly: NONE,
    },
    subscription: {
        owner: ALL,
        manager: READ_ONLY,
        clerk: NONE,
        readonly: NONE,
    },
};

// Merge virtual features
Object.assign(permissions, virtualFeatures);

/**
 * Check if a role has a specific permission level on a feature.
 *
 * @param {string} role - 'owner', 'manager', 'clerk', 'readonly'
 * @param {string} featureKey - Feature module key (e.g. 'cycle_counts', 'base')
 * @param {string} level - 'read', 'write', or 'admin'
 * @returns {boolean}
 */
function hasPermission(role, featureKey, level) {
    // 'user' is legacy default — treat as 'clerk' for backward compat
    const effectiveRole = role === 'user' ? 'clerk' : role;

    const featurePerms = permissions[featureKey];
    if (!featurePerms) {
        // Unknown feature — only owner gets access
        return effectiveRole === 'owner';
    }

    const rolePerms = featurePerms[effectiveRole];
    if (!rolePerms) {
        return false;
    }

    return rolePerms.includes(level);
}

module.exports = {
    permissions,
    hasPermission,
};
