/**
 * Vault folder groups (E2.8 B1 / S19b) — pure, node-safe helper.
 *
 * A "group" is a named, reusable bundle of folders defined in Settings→Vault
 * (`settings.pkmAssistant.vaultGroups = [{ name, folders: [{path, access}] }]`).
 *
 * An agent's `focus_folders` may hold a reference entry `{group: 'NazwaGrupy'}`.
 * We DO NOT expand that reference when the agent is normalized — the reference is
 * stored as-is, and only resolved to concrete folders at the moment of use
 * (AccessGuard._normalizeEntries + PromptBuilder._buildEnvironment). This way a group
 * edited in Settings is instantly reflected for every agent that references it.
 *
 * A reference to a group that no longer exists is skipped (logged), never a crash.
 */
import { log } from '../utils/Logger.js';

/** Wpis folderu w whiteliscie / w grupie: `{path, access}`. */
export interface FocusFolder {
    path?: string;
    /** `'read'` albo `'readwrite'` — ale pochodzi z YAML/ustawień usera, więc typ jest szeroki. */
    access?: string;
}

/** Pojedynczy wpis `focus_folders` agenta: goły folder, `{path, access}` albo referencja `{group}`. */
export type FocusEntry = string | (FocusFolder & { group?: string });

/** Grupa folderów zdefiniowana przez usera w Settings→Vault. */
export interface VaultGroup {
    name?: string;
    folders?: Array<string | FocusFolder>;
}

/**
 * Rozwinięty wpis: ścieżka + poziom dostępu.
 * `access` jest STRINGIEM, nie unią `'read'|'readwrite'` jak mówił stary JSDoc — runtime
 * przepuszcza dokładnie to, co user wpisał w ustawieniach, i niczego nie waliduje.
 */
export interface ExpandedFocusEntry {
    path: string;
    access: string;
}

/**
 * Expand a list of focus entries to concrete `{path, access}` entries, resolving any
 * `{group}` references against the provided groups list.
 *
 * Accepts mixed input: plain strings, `{path, access}` objects, and `{group}` references.
 *
 * @param entries
 * @param groups
 */
export function expandFocusEntries(
    entries: FocusEntry[] | null | undefined,
    groups: VaultGroup[] | null | undefined = [],
): ExpandedFocusEntry[] {
    if (!Array.isArray(entries)) return [];
    const groupList = Array.isArray(groups) ? groups : [];
    const out: ExpandedFocusEntry[] = [];

    for (const entry of entries) {
        if (!entry) continue;

        if (typeof entry === 'string') {
            out.push({ path: entry, access: 'readwrite' });
            continue;
        }

        if (entry.group) {
            const grp = groupList.find(g => g && g.name === entry.group);
            if (!grp) {
                log.debug('vaultGroups', `focus group "${entry.group}" nie istnieje w Settings→Vault — wpis pominięty`);
                continue;
            }
            for (const folder of (Array.isArray(grp.folders) ? grp.folders : [])) {
                if (!folder) continue;
                if (typeof folder === 'string') {
                    out.push({ path: folder, access: 'readwrite' });
                } else if (folder.path) {
                    out.push({ path: folder.path, access: folder.access || 'readwrite' });
                }
            }
            continue;
        }

        if (entry.path) {
            out.push({ path: entry.path, access: entry.access || 'readwrite' });
        }
    }

    return out;
}
