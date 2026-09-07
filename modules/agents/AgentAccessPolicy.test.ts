import test from 'ava';
import {
    ACCESS_POLICY_VERSION,
    migrateAccessPolicy,
    normalizeAdminAccess,
} from './accessPolicy.js';
import type { AccessPolicyYaml } from './accessPolicy.js';

test('A1 admin_access jest true wyłącznie dla jawnego boolean true', t => {
    t.true(normalizeAdminAccess(true));
    t.false(normalizeAdminAccess(false));
    t.false(normalizeAdminAccess('true'));
    t.false(normalizeAdminAccess(1));
    t.false(normalizeAdminAccess(undefined));
});

test('A2: stary pusty workspace migruje do whole-vault dokładnie raz', t => {
    const legacy: AccessPolicyYaml & {
        access_policy_version?: number;
        default_permissions: Record<string, unknown>;
    } = { name: 'Legacy', focus_folders: [], default_permissions: {} };
    const first = migrateAccessPolicy(legacy);
    t.true(first.changed);
    t.true(legacy.default_permissions.guidance_mode);
    t.is(legacy.access_policy_version, ACCESS_POLICY_VERSION);

    const second = migrateAccessPolicy(legacy);
    t.false(second.messages.includes('empty-focus->whole-vault'));
});

test('A2: nowy v2 pusty workspace pozostaje strict (zero dostępu)', t => {
    const current = {
        name: 'Strict',
        access_policy_version: ACCESS_POLICY_VERSION,
        focus_folders: [],
        default_permissions: { guidance_mode: false },
    };
    migrateAccessPolicy(current);
    t.false(current.default_permissions.guidance_mode);
});
