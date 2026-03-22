'use strict';

const { permissions, hasPermission } = require('../../config/permissions');
const { modules } = require('../../config/feature-registry');

describe('config/permissions', () => {

    describe('permissions matrix coverage', () => {

        test('every feature-registry module has a permissions entry', () => {
            for (const mod of Object.values(modules)) {
                expect(permissions).toHaveProperty(mod.key);
                expect(permissions[mod.key]).toHaveProperty('owner');
                expect(permissions[mod.key]).toHaveProperty('manager');
                expect(permissions[mod.key]).toHaveProperty('clerk');
                expect(permissions[mod.key]).toHaveProperty('readonly');
            }
        });

        test('owner always has admin on every feature', () => {
            for (const [key, perms] of Object.entries(permissions)) {
                expect(perms.owner).toContain('admin');
                expect(perms.owner).toContain('read');
                expect(perms.owner).toContain('write');
            }
        });

        test('clerk never has admin on any feature', () => {
            for (const [key, perms] of Object.entries(permissions)) {
                expect(perms.clerk).not.toContain('admin');
            }
        });

        test('readonly never has write on any feature', () => {
            for (const [key, perms] of Object.entries(permissions)) {
                expect(perms.readonly).not.toContain('write');
                expect(perms.readonly).not.toContain('admin');
            }
        });

        test('manager has admin on most features but not billing/staff/oauth/subscription', () => {
            const restricted = ['billing', 'staff', 'oauth', 'subscription'];
            for (const key of restricted) {
                if (permissions[key]) {
                    expect(permissions[key].manager).not.toContain('admin');
                }
            }
            // Manager should have admin on regular features
            expect(permissions.base.manager).toContain('admin');
            expect(permissions.cycle_counts.manager).toContain('admin');
        });
    });

    describe('hasPermission helper', () => {

        test('owner has admin on base', () => {
            expect(hasPermission('owner', 'base', 'admin')).toBe(true);
        });

        test('owner has read on everything', () => {
            for (const key of Object.keys(permissions)) {
                expect(hasPermission('owner', key, 'read')).toBe(true);
            }
        });

        test('clerk can write cycle_counts', () => {
            expect(hasPermission('clerk', 'cycle_counts', 'write')).toBe(true);
        });

        test('clerk can write delivery', () => {
            expect(hasPermission('clerk', 'delivery', 'write')).toBe(true);
        });

        test('clerk can read base (dashboard/inventory)', () => {
            expect(hasPermission('clerk', 'base', 'read')).toBe(true);
        });

        test('clerk cannot access loyalty', () => {
            expect(hasPermission('clerk', 'loyalty', 'read')).toBe(false);
        });

        test('clerk cannot access ai_tools', () => {
            expect(hasPermission('clerk', 'ai_tools', 'read')).toBe(false);
        });

        test('readonly can read base', () => {
            expect(hasPermission('readonly', 'base', 'read')).toBe(true);
        });

        test('readonly cannot read loyalty', () => {
            expect(hasPermission('readonly', 'loyalty', 'read')).toBe(false);
        });

        test('readonly cannot write anything', () => {
            for (const key of Object.keys(permissions)) {
                expect(hasPermission('readonly', key, 'write')).toBe(false);
            }
        });

        test('unknown feature — only owner gets access', () => {
            expect(hasPermission('owner', 'nonexistent_feature', 'admin')).toBe(true);
            expect(hasPermission('manager', 'nonexistent_feature', 'read')).toBe(false);
            expect(hasPermission('clerk', 'nonexistent_feature', 'read')).toBe(false);
        });

        test('legacy "user" role maps to clerk', () => {
            expect(hasPermission('user', 'cycle_counts', 'write')).toBe(true);
            expect(hasPermission('user', 'base', 'read')).toBe(true);
            expect(hasPermission('user', 'loyalty', 'read')).toBe(false);
        });

        test('manager has read+write on billing but not admin', () => {
            expect(hasPermission('manager', 'billing', 'read')).toBe(true);
            expect(hasPermission('manager', 'billing', 'write')).toBe(false);
            expect(hasPermission('manager', 'billing', 'admin')).toBe(false);
        });

        test('clerk can write expiry', () => {
            expect(hasPermission('clerk', 'expiry', 'write')).toBe(true);
        });

        test('clerk can read reorder but not write', () => {
            expect(hasPermission('clerk', 'reorder', 'read')).toBe(true);
            expect(hasPermission('clerk', 'reorder', 'write')).toBe(false);
        });
    });
});
