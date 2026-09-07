/** Current semantics: assigned-only + empty focus_folders means zero vault access. */
export const ACCESS_POLICY_VERSION = 2;

export interface AccessPolicyYaml {
    access_policy_version?: unknown;
    focus_folders?: unknown;
    default_permissions?: Record<string, unknown>;
    [extra: string]: unknown;
}

export function normalizeAdminAccess(value: unknown) {
    return value === true;
}

/**
 * One-time compatibility migration from v1, where empty focus_folders meant whole vault.
 * Mutates the YAML-shaped object and reports whether it changed.
 */
export function migrateAccessPolicy<T extends AccessPolicyYaml>(data: T) {
    const accessVersion = Number(data?.access_policy_version) || 0;
    if (accessVersion >= ACCESS_POLICY_VERSION) {
        return { changed: false, messages: [] };
    }

    const messages = [];
    const hasFolders = Array.isArray(data.focus_folders) && data.focus_folders.length > 0;
    if (!hasFolders) {
        data.default_permissions = {
            ...(data.default_permissions || {}),
            guidance_mode: true,
        };
        messages.push('empty-focus->whole-vault');
    }
    data.access_policy_version = ACCESS_POLICY_VERSION;
    messages.push(`access-policy-v${ACCESS_POLICY_VERSION}`);
    return { changed: true, messages };
}
