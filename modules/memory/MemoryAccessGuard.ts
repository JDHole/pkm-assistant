import { getAgentSafeName } from '../../core/index.js';

/** Kanoniczne typy notatek `brain/` (Memory v3). */
export type MemoryNoteType = 'user' | 'agent_rule' | 'skill_hint' | 'project_context' | 'reference';

const NOTE_TYPES = new Set<string>(['user', 'agent_rule', 'skill_hint', 'project_context', 'reference']);

export const MEMORY_V3_ERROR_CODES = {
    CROSS_AGENT_ACCESS_DENIED: 'cross_agent_access_denied',
    INVALID_PATH: 'invalid_path',
    NOTE_ALREADY_EXISTS: 'note_already_exists',
    NOTE_NOT_FOUND: 'note_not_found',
} as const;

/** Kod błędu Memory v3 zwracany przez guard i narzędzia pamięci. */
export type MemoryV3ErrorCode = (typeof MEMORY_V3_ERROR_CODES)[keyof typeof MEMORY_V3_ERROR_CODES];

/** Wynik walidacji nazwy notatki: albo ścieżka do pliku, albo powód odmowy. */
export type NoteFilenameDecision =
    | { ok: true; filename: string; path: string }
    | { ok: false; code: MemoryV3ErrorCode; error: string };

// AUD-code-review-029: kanoniczne źródło to `core/utils/agentSlug.ts` (musi stać w `core/`, bo
// jeden z konsumentów duplikatu — `core/security/AccessGuard` — nie może importować z modułów).
// Ta funkcja zostaje jako cienki wrapper: jest już 1 (jedyny) wewnątrzmodułowy wołacz
// (`MemoryAccessGuard` konstruktor) i wycięta z barrela w S30 Z4 — dotykanie tego kontraktu
// jest poza zakresem tej naprawy (czysty dedup, zero zmian API).
export function getSafeAgentName(agentName: unknown): string {
    return getAgentSafeName(agentName);
}

/** Type guard: czy wartość jest jednym z pięciu typów notatek. */
export function isValidNoteType(type: unknown): type is MemoryNoteType {
    return NOTE_TYPES.has(type as string);
}

export function makeMemoryNoteFilename(type: unknown, name: unknown): string {
    const safeType = NOTE_TYPES.has(type as string) ? (type as MemoryNoteType) : 'reference';
    let safeName = String(name || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\.md$/, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    // Strip leading type prefix if caller already passed something like "agent_rule_polski" as name
    // \u2014 without this guard ArchiveWorkflow merges produced files like
    // `agent_rule_agent_rule_polski_merged.md`. Idempotent.
    const prefix = `${safeType}_`;
    while (safeName.startsWith(prefix)) {
        safeName = safeName.slice(prefix.length);
    }
    return `${safeType}_${safeName || 'note'}.md`;
}

export class MemoryAccessGuard {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare agentName: string;
    declare safeName: string;

    constructor(agentName: string) {
        this.agentName = agentName;
        this.safeName = getSafeAgentName(agentName);
    }

    brainPath(basePath: string): string {
        return `${basePath}/brain`;
    }

    validateNoteFilename(filename: unknown, basePath: string): NoteFilenameDecision {
        const raw = String(filename || '').trim();
        if (!raw) {
            return this._deny(MEMORY_V3_ERROR_CODES.INVALID_PATH, 'filename is required');
        }

        let decoded = raw;
        try {
            decoded = decodeURIComponent(raw);
        } catch {
            return this._deny(MEMORY_V3_ERROR_CODES.INVALID_PATH, 'filename is not valid URI text');
        }

        const normalized = decoded.replace(/\\/g, '/');
        if (
            normalized.includes('\0') ||
            normalized.startsWith('/') ||
            normalized.startsWith('//') ||
            /^[a-zA-Z]:\//.test(normalized) ||
            normalized.split('/').some(segment => segment === '..')
        ) {
            return this._deny(MEMORY_V3_ERROR_CODES.INVALID_PATH, 'absolute paths and traversal are not allowed');
        }

        const segments = normalized.split('/').filter(Boolean);
        if (segments.length > 1) {
            if (segments.length >= 3 && segments[1] === 'brain' && segments[0] !== this.safeName) {
                return this._deny(
                    MEMORY_V3_ERROR_CODES.CROSS_AGENT_ACCESS_DENIED,
                    'Memory v3 enforces per-agent isolation. To access another agent brain, use that agent.'
                );
            }
            return this._deny(MEMORY_V3_ERROR_CODES.INVALID_PATH, 'memory_read accepts a filename, not a path');
        }

        const clean = segments[0];
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(clean)) {
            return this._deny(MEMORY_V3_ERROR_CODES.INVALID_PATH, 'filename must be a safe .md filename');
        }

        return {
            ok: true,
            filename: clean,
            path: `${this.brainPath(basePath)}/${clean}`,
        };
    }

    private _deny(code: MemoryV3ErrorCode, message: string): NoteFilenameDecision {
        return { ok: false, code, error: message };
    }
}
