/**
 * Metadane notatki `brain/*.md` widziane przez budowniczego indeksu. Wszystko poza
 * `filename` bywa puste — pliki usera potrafią mieć niepełny frontmatter, a kod
 * broni się `||`/`?.` (kontrakt: NIE dodajemy walidacji).
 */
export interface BrainNoteMeta {
    filename: string;
    name?: string;
    description?: string;
    /**
     * typ notatki — w praktyce `MemoryNoteType`, ale kontrakt jest `string`:
     * plik usera może nieść cokolwiek, a nieznana wartość ląduje w „Projekty i referencje".
     */
    type?: string;
    status?: string;
    created?: string | number;
    mtime?: string | number;
}

/** Klucz sekcji „Na teraz" (pamięć krótkoterminowa brain.md). */
export type NaTerazKey = 'user' | 'environment';

/** Zawartość obu sekcji „Na teraz" — zawsze oba klucze, zawsze tablice. */
export type NaTerazSections = Record<NaTerazKey, string[]>;

/**
 * Operacja na sekcji „Na teraz". `oldContent`/`content` to LEGACY aliasy pól
 * (`remove`/`add`) przyjmowane od LLM-a — zostają, bo parser propozycji je produkuje.
 */
export interface NaTerazOp {
    section?: string | null;
    add?: string | null;
    remove?: string | null;
    content?: string | null;
    oldContent?: string | null;
}

const INDEX_SECTIONS = [
    '## Bieżące',
    '## User',
    '## Preferencje',
    '## Workflow',
    '## Projekty i referencje',
];

const NOTE_TYPE_TO_SECTION: Record<string, string> = {
    user: '## User',
    agent_rule: '## Preferencje',
    skill_hint: '## Workflow',
    project_context: '## Projekty i referencje',
    reference: '## Projekty i referencje',
};

const CURRENT_PROJECT_LIMIT = 3;

/**
 * E2.8 D2 (S22) — „Na teraz" short-term sections. Unlike the index sections (links to brain/*.md),
 * these hold plain-text bullets describing the CURRENT state of the user / environment „for today".
 * They live at the TOP of brain.md so the LLM sees them first every request. Order is fixed.
 */
const NA_TERAZ_SECTIONS: ReadonlyArray<{ key: NaTerazKey; heading: string }> = [
    { key: 'user', heading: '## Na teraz: User' },
    { key: 'environment', heading: '## Na teraz: Środowisko' },
];

/** Hard cap on entries per „Na teraz" section — oldest are trimmed (D2). */
const NA_TERAZ_MAX_ENTRIES = 10;

// CURRENT_PROJECT_LIMIT i NA_TERAZ_SECTIONS byly tu eksportowane bez ani jednego importera
// (dead-code sweep 2026-09-02, AUD-dead-code-045/226) — uzywane sa WYLACZNIE lokalnie w tym
// pliku (linie 228 i 246 nizej).
export {
    INDEX_SECTIONS,
    NOTE_TYPE_TO_SECTION,
    NA_TERAZ_MAX_ENTRIES,
};

/** Does this trimmed line open a „Na teraz" section? (case-insensitive; used by the .bak guard too) */
export function isNaTerazHeading(trimmedLine: unknown): boolean {
    return /^##\s+na teraz\b/i.test(String(trimmedLine || ''));
}

/** Map a free-form section label/heading to the canonical key, or null when it is neither. */
export function naTerazSectionKey(value: unknown): NaTerazKey | null {
    const s = String(value || '').toLowerCase();
    if (/\buser\b|użytkownik|uzytkownik/.test(s)) return 'user';
    if (/środow|srodow|environ|vault|system|otoczenie/.test(s)) return 'environment';
    return null;
}

function cleanEntry(value: unknown): string {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Sekcja H2 brain.md spoza katalogu zarządzanych (ręcznie dopisana, np. `## AKTYWNY TEST`).
 * `lines` = body verbatim (bez końcowych pustych linii).
 */
export interface ForeignSection {
    heading: string;
    lines: string[];
}

/**
 * Incydent 2026-08-15: ręcznie dopisana sekcja `## AKTYWNY TEST` znikała przy każdej przebudowie
 * indeksu (rebuild odtwarzał plik wyłącznie z „Na teraz" + metadanych brain/*.md, resztę odkładał
 * do `.bak`). Ten parser wyciąga KAŻDĄ sekcję H2, której nagłówek nie jest ani sekcją indeksu
 * (INDEX_SECTIONS), ani „Na teraz" — rebuild przenosi je verbatim na KONIEC nowego pliku,
 * z zachowaniem kolejności względnej. Body łapane jest surowymi liniami aż do następnego H2.
 */
export function parseForeignSections(content: string | null | undefined): ForeignSection[] {
    const out: ForeignSection[] = [];
    if (!content) return out;
    let current: ForeignSection | null = null;
    for (const line of String(content).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (/^##\s+/.test(trimmed)) {
            const managed = isNaTerazHeading(trimmed) || INDEX_SECTIONS.includes(trimmed);
            current = managed ? null : { heading: trimmed, lines: [] };
            if (current) out.push(current);
            continue;
        }
        if (current) current.lines.push(line);
    }
    // Końcowe puste linie precz — emisja dokłada własny separator, a stabilny kształt
    // gwarantuje idempotencję (druga przebudowa = identyczny plik).
    for (const section of out) {
        while (section.lines.length && !(section.lines[section.lines.length - 1] || '').trim()) {
            section.lines.pop();
        }
    }
    return out;
}

/** Coerce any shape into `{ user: string[], environment: string[] }` with cleaned, deduped bullets. */
function normalizeNaTeraz(naTeraz: Partial<NaTerazSections> | null | undefined): NaTerazSections {
    const src = naTeraz || {};
    const clean = (arr: unknown): string[] => {
        const out: string[] = [];
        for (const raw of Array.isArray(arr) ? arr : []) {
            const text = cleanEntry(raw);
            if (text && !out.some(e => e.toLowerCase() === text.toLowerCase())) out.push(text);
        }
        return out;
    };
    return { user: clean(src.user), environment: clean(src.environment) };
}

/**
 * Parse the „Na teraz" sections out of an existing brain.md. Returns `{ user, environment }`.
 * Everything else in the file is ignored (the index is regenerated from brain/*.md).
 */
export function parseNaTerazSections(content: string | null | undefined): NaTerazSections {
    const result: NaTerazSections = { user: [], environment: [] };
    if (!content) return result;
    let key: NaTerazKey | null = null;
    for (const line of String(content).split(/\r?\n/)) {
        const trimmed = line.trim();
        const h2 = trimmed.match(/^##\s+(.+)$/);
        if (h2) {
            key = isNaTerazHeading(trimmed) ? naTerazSectionKey(h2[1]) : null;
            continue;
        }
        if (!key) continue;
        const bullet = trimmed.match(/^-\s+(.+)$/);
        if (bullet) {
            const text = cleanEntry(bullet[1]);
            if (text && !result[key].some(e => e.toLowerCase() === text.toLowerCase())) {
                result[key].push(text);
            }
        }
    }
    return result;
}

/**
 * Apply add/remove ops to the „Na teraz" sections (pure). Each op: `{ section, add?, remove? }`.
 * - `remove`: drops entries that equal or contain the (case-insensitive) needle — used to purge
 *   outdated state (this is the ONE place brain-memory is mutated in place, not create-only — S22).
 * - `add`: appends a new bullet (deduped, newest last).
 * Oldest entries beyond `max` are trimmed off the front. Returns `{ naTeraz, trimmed }`.
 */
export function applyNaTerazOps(
    naTeraz: Partial<NaTerazSections> | null | undefined,
    ops: NaTerazOp | NaTerazOp[] | null | undefined = [],
    { max = NA_TERAZ_MAX_ENTRIES }: { max?: number } = {},
): { naTeraz: NaTerazSections; trimmed: number } {
    const next = normalizeNaTeraz(naTeraz);
    const list: NaTerazOp[] = Array.isArray(ops) ? ops : (ops ? [ops] : []);
    let trimmed = 0;
    for (const op of list) {
        if (!op) continue;
        const key = naTerazSectionKey(op.section);
        if (!key) continue;
        const bucket = next[key];
        const removeText = cleanEntry(op.remove ?? op.oldContent ?? '').toLowerCase();
        if (removeText) {
            for (let i = bucket.length - 1; i >= 0; i--) {
                const entry = bucket[i].toLowerCase();
                if (entry === removeText || entry.includes(removeText)) bucket.splice(i, 1);
            }
        }
        const addText = cleanEntry(op.add ?? op.content ?? '');
        if (addText && !bucket.some(e => e.toLowerCase() === addText.toLowerCase())) {
            bucket.push(addText);
        }
        while (bucket.length > max) { bucket.shift(); trimmed++; }
    }
    return { naTeraz: next, trimmed };
}

/** Wejście budowniczego `brain.md`. */
export interface BuildBrainIndexInput {
    agentName?: string | null;
    notes?: BrainNoteMeta[];
    /** własny nagłówek H1; domyślnie „# <agent> brain" */
    header?: string | null;
    naTeraz?: Partial<NaTerazSections> | null;
    /** sekcje spoza katalogu zarządzanych (`parseForeignSections`) — emitowane verbatim NA KOŃCU */
    foreign?: ForeignSection[] | null;
}

export function buildBrainIndex({ agentName, notes = [], header = null, naTeraz = null, foreign = null }: BuildBrainIndexInput = {}): string {
    const safeHeader = header || `# ${agentName || 'Agent'} brain`;
    const activeNotes = notes.filter(note => !isArchivedNote(note));
    const currentProjects = activeNotes
        .filter(note => note.type === 'project_context')
        .sort(compareNotesNewestFirst)
        .slice(0, CURRENT_PROJECT_LIMIT);
    const currentProjectNames = new Set(currentProjects.map(note => note.filename));

    const sections = new Map<string, string[]>(INDEX_SECTIONS.map(section => [section, []]));
    for (const note of currentProjects) {
        sections.get('## Bieżące')!.push(formatIndexLine(note));
    }

    for (const note of activeNotes.sort(compareNotesByFilename)) {
        if (currentProjectNames.has(note.filename)) continue;
        const section = NOTE_TYPE_TO_SECTION[note.type!] || NOTE_TYPE_TO_SECTION.reference;
        sections.get(section)!.push(formatIndexLine(note));
    }

    const parts: string[] = [safeHeader, ''];
    // D2 (S22): „Na teraz" sections go first, above the index. Empty sections are omitted, so an
    // old brain.md without them migrates cleanly (the sections appear on the first ephemeral write).
    const nt = normalizeNaTeraz(naTeraz);
    for (const { key, heading } of NA_TERAZ_SECTIONS) {
        const entries = nt[key];
        if (!entries.length) continue;
        parts.push(heading);
        for (const entry of entries) parts.push(`- ${entry}`);
        parts.push('');
    }
    for (const section of INDEX_SECTIONS) {
        parts.push(section);
        const lines = sections.get(section) || [];
        if (lines.length > 0) parts.push(...lines);
        parts.push('');
    }

    // Incydent 2026-08-15: sekcje spoza katalogu zarządzanych wracają do pliku — na końcu, verbatim.
    for (const section of foreign || []) {
        if (!section?.heading) continue;
        parts.push(section.heading);
        parts.push(...(section.lines || []));
        parts.push('');
    }

    return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function formatIndexLine(note: BrainNoteMeta): string {
    const description = oneLineDescription(note.description || note.name || note.filename);
    return `- [[brain/${note.filename}]] — ${description}`;
}

function isArchivedNote(note: BrainNoteMeta | null | undefined): boolean {
    const status = String(note?.status || '').toLowerCase();
    return status === 'archived' || status === 'archive';
}

function compareNotesNewestFirst(a: BrainNoteMeta, b: BrainNoteMeta): number {
    const aTime = noteTimestamp(a);
    const bTime = noteTimestamp(b);
    if (aTime !== bTime) return bTime - aTime;
    return compareNotesByFilename(a, b);
}

function compareNotesByFilename(a: BrainNoteMeta, b: BrainNoteMeta): number {
    return String(a?.filename || '').localeCompare(String(b?.filename || ''));
}

function noteTimestamp(note: BrainNoteMeta | null | undefined): number {
    const raw = note?.created || note?.mtime || '';
    const parsed = Date.parse(raw as string);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number(raw || 0);
    return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Zwiń opis do JEDNEJ linii i przytnij do 220 znaków.
 *
 * K9 (AUD-security-035): `description` notatki `brain/` wraca z frontmattera przez `JSON.parse`
 * z PRAWDZIWYMI znakami nowej linii — wstawiony niesklejony do promptu potrafi otworzyć własny
 * nagłówek/sekcję. Każdy emiter opisu do promptu MUSI przejść tędy.
 */
export function oneLineDescription(value: unknown): string {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
}
