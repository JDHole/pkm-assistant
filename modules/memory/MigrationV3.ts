import { makeMemoryNoteFilename } from './MemoryAccessGuard.js';
import { buildBrainIndex, INDEX_SECTIONS } from './BrainIndex.js';
// S30 Z3: adapterowy mkdir -p (dawna prywatna, rekurencyjna `ensureFolder` w tym pliku).
// Deep-import świadomy — barrel core/index.js wciąga obsidian, a memory jest node-testowane.
import { ensureAdapterFolder, probeFile } from '../../core/index.js';

import type { BrainNoteMeta, ForeignSection } from './BrainIndex.js';

/** Adapter FS vaulta w zakresie potrzebnym migracji (typowany STRUKTURALNIE — `AgentMemory` jest w `.js`). */
export interface MigrationVaultAdapterLike {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    list(path: string): Promise<{ files?: string[]; folders?: string[] } | null>;
    mkdir?(path: string): Promise<void>;
}

/** Fragment `AgentMemory`, na którym stoi migracja v2 → v3. */
export interface MigrationAgentMemoryLike {
    agentName: string;
    basePath: string;
    vault: { adapter: MigrationVaultAdapterLike };
    paths: { brain: string; brainNotes: string };
    stateManager: { read(): Promise<unknown> };
    ensureMemoryStructure(): Promise<unknown>;
}

/** Jedna notatka `brain/*.md` do utworzenia przez migrację. */
export interface MigrationNote {
    type: string;
    name: string;
    description: string;
    content: string;
    filename?: string;
}

/** Sekcja `## …` starego `brain.md`. */
export interface MigrationSection {
    title: string;
    lines: string[];
}

/** Plan migracji — user go zatwierdza (albo podmienia) w modalu. */
export interface MigrationPlan {
    version: number;
    created: string;
    notes: MigrationNote[];
    keepInBrain: string[];
    deletedSections: string[];
}

/** Co modal review oddaje z powrotem. */
export interface MigrationModalResult {
    action?: string;
    accepted?: boolean;
    plan?: MigrationPlan;
}

export interface MigrationModalLike {
    prompt?: () => Promise<MigrationModalResult | null | undefined>;
}

export interface MigrationV3Options {
    modalFactory?: ((payload: { plan: MigrationPlan; agentName: string }) => MigrationModalLike | null) | null;
    now?: () => string;
}

/**
 * Wynik `run()` — jedna z rozłącznych gałęzi (pominięta / anulowana / wykonana),
 * dlatego wszystkie pola są opcjonalne.
 */
export interface MigrationResult {
    skipped?: boolean;
    reason?: string;
    cancelled?: boolean;
    migrated?: boolean;
    backupPath?: string;
    plan?: MigrationPlan;
    notesCreated?: string[];
    deletedSections?: string[];
}

const SECTION_TYPES = new Map<string, string>([
    ['user', 'user'],
    ['preferencje', 'agent_rule'],
    ['ustalenia', 'project_context'],
    // Naprawa 2026-08-28 (znalezisko round-trip): te dwa nagłówki są emitowane przez
    // `BrainIndex.INDEX_SECTIONS`. Gdyby mimo bramki `looksLikeV3Index` w run() sekcja o takim
    // tytule i tak trafiła do buildPlan (np. stary v2 brain, który user ręcznie nazwał tak samo),
    // ma być policzona jako notatki — NIE jako keepInBrain, bo verbatim sekcja pod nagłówkiem
    // kolidującym z INDEX_SECTIONS zostałaby zjedzona przy najbliższym rebuildzie indeksu.
    ['workflow', 'skill_hint'],
    ['projekty i referencje', 'reference'],
]);

const LIVE_SECTION_KEYS = new Set(['biezace', 'bieżące']);
const ZOMBIE_SECTION_KEYS = new Set(['system', 'agora', 'vault-builder', 'vault builder', 'default rob']);

// Runda 2 (2026-08-28, weryfikacja opus, P3/Z8): sentinel (znak NUL na starcie stringa)
// zamiast literalu Preamble jako tytul bucketa tresci PRZED pierwszym ##. Literal
// kolidowal z realna, recznie dopisana sekcja usera ## Preamble - obie mialy ten sam
// tytul, wiec parseSections/buildPlan nie dawalo sie ich rozroznic. Znak NUL nigdy nie
// pojawia sie w naglowku markdown wpisanym przez czlowieka, wiec sentinel nie zderzy sie
// z zadnym prawdziwym tytulem sekcji.
const PREAMBLE_SENTINEL = '\u0000preamble';

export class MigrationV3 {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare memory: MigrationAgentMemoryLike;
    declare modalFactory: MigrationV3Options['modalFactory'];
    declare now: () => string;

    constructor(agentMemory: MigrationAgentMemoryLike, options: MigrationV3Options = {}) {
        this.memory = agentMemory;
        this.modalFactory = options.modalFactory || null;
        this.now = options.now || (() => new Date().toISOString());
    }

    async needsMigration(): Promise<boolean> {
        if (await this.memory.vault.adapter.exists(this.memory.paths.brainNotes)) return false;
        if (!(await this.memory.vault.adapter.exists(this.memory.paths.brain))) return false;
        // Naprawa 2026-08-28 (znalezisko #4): brak folderu `brain/` NIE znaczy automatycznie
        // "to pamięć v2" — świeży klon / niedosynchronizowany sync może mieć `brain.md` już
        // w formacie v3. Doczytaj i rozstrzygnij po kształcie treści.
        try {
            const content = await this.memory.vault.adapter.read(this.memory.paths.brain);
            return !looksLikeV3Index(content);
        } catch {
            // Pad odczytu — zachowaj dotychczasowy wynik (istnienie brain.md bez brain/ = potrzebna migracja).
            return true;
        }
    }

    async run(options: { interactive?: boolean } = {}): Promise<MigrationResult> {
        const interactive = options.interactive !== false;

        if (await this.memory.vault.adapter.exists(this.memory.paths.brainNotes)) {
            return { skipped: true, reason: 'already_v3' };
        }

        if (!(await this.memory.vault.adapter.exists(this.memory.paths.brain))) {
            await this.memory.ensureMemoryStructure();
            return { skipped: true, reason: 'fresh_install' };
        }

        const originalBrain = await this.memory.vault.adapter.read(this.memory.paths.brain);

        // Naprawa 2026-08-28 (znalezisko #4, round-trip): brain.md już w formacie v3 nie jest
        // migrowany, nawet jeśli folder brain/ akurat brakuje (świeży klon, desync). Sam plik
        // NIE jest przepisywany przez migrator.
        // Runda 2 (2026-08-28, weryfikacja opus, P2/Z1b): mimo to robimy backup PRZED
        // `ensureMemoryStructure()` — ta metoda woła `getBrain()`, który może dokleić brakujące
        // nagłówki indeksu, i potrafi domigrować płaski `sessions/` do archiwum. Backup daje
        // odwrót, gdyby heurystyka `looksLikeV3Index` się jednak myliła.
        if (looksLikeV3Index(originalBrain)) {
            const backupPath = await this.backupMemoryFolder();
            await this.memory.ensureMemoryStructure();
            return { skipped: true, reason: 'already_v3_format', backupPath };
        }

        const backupPath = await this.backupMemoryFolder();
        const plan = this.buildPlan(originalBrain);
        const decision = await this._reviewPlan(plan, interactive, originalBrain);

        if (decision?.cancelled) {
            return { cancelled: true, backupPath, plan };
        }

        const applied = await this.applyPlan(decision?.plan || plan, originalBrain);
        return {
            migrated: true,
            backupPath,
            ...applied,
        };
    }

    buildPlan(brainContent: string): MigrationPlan {
        const sections = this.parseSections(brainContent);
        const notes: MigrationNote[] = [];
        const preambleNotes: MigrationNote[] = [];
        const keepInBrain: string[] = [];
        const deletedSections: string[] = [];

        for (const section of sections) {
            // Runda 2 (2026-08-28, weryfikacja opus, P4/Z2): sentinel „Preamble" = treść PRZED
            // pierwszym `##` (auto-generowany nagłówek H1 `# <agent> brain`, ale też realny
            // wstęp dopisany pod H1). Sam H1 to nie treść — odfiltrowujemy go; reszta trafia do
            // osobnego koszyka i wchodzi do planu dopiero POD spodem, obok prawdziwych sekcji.
            if (section.title === PREAMBLE_SENTINEL) {
                const withoutHeading = section.lines.filter(line => !/^#\s/.test(line));
                if (withoutHeading.some(line => String(line || '').trim())) {
                    preambleNotes.push(...this._notesFromSection({ title: 'Preamble', lines: withoutHeading }, 'reference'));
                }
                continue;
            }
            const key = normalizeSectionName(section.title);
            if (SECTION_TYPES.has(key)) {
                const sectionNotes = this._notesFromSection(section, SECTION_TYPES.get(key)!);
                // Runda 2 (P7/Z7a): sekcja ROZPOZNANA, ale bez treści (zero bloków) jest policzona
                // jako usunięta — inaczej znikała bez śladu z planu (ani notatka, ani keepInBrain,
                // ani deletedSections).
                if (sectionNotes.length) notes.push(...sectionNotes);
                else deletedSections.push(section.title);
                continue;
            }
            if (LIVE_SECTION_KEYS.has(key) || key.startsWith('bie')) {
                const sectionNotes = this._notesFromSection(section, 'project_context');
                if (sectionNotes.length) notes.push(...sectionNotes);
                else deletedSections.push(section.title);
                continue;
            }
            if (ZOMBIE_SECTION_KEYS.has(key) || looksLikeZombie(section)) {
                deletedSections.push(section.title);
                continue;
            }
            // Naprawa 2026-08-28 (znalezisko #1): KAŻDA pozostała sekcja musi być policzona w
            // planie — notatka, keepInBrain albo deletedSections. Dotąd sekcja spoza trzech gałęzi
            // znikała bez śladu (nie trafiała do żadnej z list, które user zatwierdza w modalu).
            if (section.lines.join('').trim()) {
                keepInBrain.push(section.title);
            } else {
                deletedSections.push(section.title);
            }
        }

        // Wstęp spod H1 wchodzi do planu TYLKO obok prawdziwych sekcji. Plik bez ani jednego
        // `##` (brain-bezkształt) ma iść w całości w dump niżej — kopia 1:1 pod przewidywalną
        // nazwą `reference_legacy_brain_dump.md` to udokumentowany kontrakt modułu, dla takiego
        // pliku bezpieczniejszy niż cięcie na akapitowe notatki.
        if (notes.length > 0 && preambleNotes.length > 0) {
            notes.unshift(...preambleNotes);
        }

        // Runda 2 (P8/Z7b): dump „Legacy brain dump" tylko przy REALNEJ treści — sam szkielet
        // nagłówków (indeks v3 z pustymi sekcjami, albo v2 brain z samymi tytułami sekcji) nie ma
        // co dumpować. `brainContent.trim()` łapał też brain zbudowany WYŁĄCZNIE z nagłówków.
        if (notes.length === 0 && hasNonHeadingContent(brainContent)) {
            notes.push({
                type: 'reference',
                name: 'Legacy brain dump',
                description: 'Fallback copy of the old brain.md because automatic parsing found no clean notes.',
                content: brainContent.trim(),
                filename: 'reference_legacy_brain_dump.md',
            });
        }

        return {
            version: 3,
            created: this.now(),
            notes: dedupeNotes(notes),
            keepInBrain,
            deletedSections,
        };
    }

    parseSections(brainContent: string): MigrationSection[] {
        const sections: MigrationSection[] = [];
        let current: MigrationSection = { title: PREAMBLE_SENTINEL, lines: [] };
        for (const rawLine of String(brainContent || '').split(/\r?\n/)) {
            const match = rawLine.match(/^##\s+(.+?)\s*$/);
            if (match) {
                sections.push(current);
                current = { title: match[1].trim(), lines: [] };
            } else {
                current.lines.push(rawLine);
            }
        }
        sections.push(current);
        // P3: porównanie z sentinelem, nie z literałem 'Preamble' — realna sekcja usera
        // `## Preamble` ma normalny tytuł 'Preamble' i przechodzi tędy bez filtrowania.
        return sections.filter(section => section.title !== PREAMBLE_SENTINEL || section.lines.join('').trim());
    }

    async backupMemoryFolder(): Promise<string> {
        const source = this.memory.basePath;
        const backup = source.replace(/\/memory$/, '/memory.v2.backup');
        await ensureAdapterFolder(this.memory.vault.adapter, backup);

        try {
            await copyFolder(this.memory.vault.adapter, source, backup);
        } catch (error) {
            throw new Error(`Memory v3 backup failed: ${(error as { message?: string }).message as string}`);
        }

        return backup;
    }

    // Naprawa 2026-08-28 (znalezisko #3): `originalBrain` wraca jako drugi argument — bez niej
    // `keepInBrain` (tytuły sekcji zatwierdzone do zachowania) nie da się odtworzyć z powrotem
    // do treści; plan niesie same tytuły, nie body. `run()` podaje treść, którą i tak przeczytał
    // przed backupem.
    // Runda 2 (2026-08-28, weryfikacja opus, P9): FAIL-CLOSED zamiast cichego ignorowania.
    // Wołacz spoza `run()`, który pominie `originalBrain` przy niepustym `plan.keepInBrain`,
    // dostaje rzut zamiast planu, który po cichu GUBI sekcje zatwierdzone przez usera do
    // zachowania — `keepInBrain` bez treści źródłowej nie da się odtworzyć w `formatNewBrain`.
    async applyPlan(plan: MigrationPlan, originalBrain = ''): Promise<{ notesCreated: string[]; deletedSections: string[] }> {
        if ((plan.keepInBrain?.length ?? 0) > 0 && !originalBrain) {
            throw new Error('MigrationV3.applyPlan: plan has keepInBrain sections but originalBrain was not provided');
        }
        await this.memory.ensureMemoryStructure();

        const createdNotes: string[] = [];
        for (const note of plan.notes || []) {
            const filename = safeFilename(note);
            const path = `${this.memory.paths.brainNotes}/${filename}`;
            // K4 (AUD-bledy-061): jak w AgentMemory — „nie wiem" liczy się jako ZAJĘTĄ, żeby
            // kłamiący exists() nie kazał migracji nadpisać notatki, która już naprawdę tam leży.
            if ((await probeFile(this.memory.vault.adapter, path)) !== 'missing') continue;
            await this.memory.vault.adapter.write(path, formatBrainNote(note, filename, this.now()));
            createdNotes.push(path);
        }

        const keep = new Set(plan.keepInBrain || []);
        const kept: MigrationSection[] = (keep.size && originalBrain)
            ? this.parseSections(originalBrain).filter(section => keep.has(section.title))
            : [];

        const brain = formatNewBrain(this.memory.agentName, plan, createdNotes, kept);
        await this.memory.vault.adapter.write(this.memory.paths.brain, brain);
        await this.memory.stateManager.read();

        return {
            notesCreated: createdNotes,
            deletedSections: plan.deletedSections || [],
        };
    }

    // Naprawa 2026-08-28 (znalezisko #2): jednostka migracji to AKAPIT/BULLET, nie linia.
    // Zawinięty akapit (trzy linie markdown z hard-wrapem) dawał dotąd trzy notatki, każda
    // z urwanym fragmentem zdania. `groupSectionIntoBlocks` grupuje linie w bloki (pusta linia
    // albo nowy bullet/numeracja zaczyna nowy blok; reszta to kontynuacje), a każdy blok staje
    // się JEDNĄ notatką. Jednolinijkowe bullety (dotychczasowy, częsty kształt) dają identyczny
    // wynik co dawny kod per-linię — każdy bullet sam otwiera i od razu zamyka własny blok.
    private _notesFromSection(section: MigrationSection, type: string): MigrationNote[] {
        const blocks = groupSectionIntoBlocks(section.lines)
            .map(flattenBlock)
            .filter(Boolean);
        return blocks.map((flat, index) => {
            const name = shortName(flat, section.title, index + 1);
            return {
                type,
                name,
                description: flat.slice(0, 140),
                content: flat,
                filename: makeMemoryNoteFilename(type, name),
            };
        });
    }

    // Weryfikacja opus (2026-08-27): `originalBrain` idzie tu jako ARGUMENT, nie
    // `result.originalBrain` — modal (`MigrationModal._resolveWith`) nigdy nie odsyla tresci
    // z powrotem, wiec poleganie na polu w wyniku dawalo pusty string na galezi 'fallback'
    // (dump nadpisywal brain.md pusta notatka, prawdziwa tresc przezywala tylko w backupie).
    // `run()` ma juz prawdziwa tresc lokalnie (przeczytana przed backupem) — mniejszy diff niz
    // uczenie modala, zeby ja pamietal i oddawal.
    private async _reviewPlan(plan: MigrationPlan, interactive: boolean, originalBrain: string): Promise<{ plan?: MigrationPlan; cancelled?: boolean }> {
        if (!interactive || !this.modalFactory) return { plan };
        const modal = this.modalFactory({ plan, agentName: this.memory.agentName });
        if (!modal?.prompt) return { plan };
        const result = await modal.prompt();
        if (result?.action === 'cancel' || result?.accepted === false) return { cancelled: true };
        if (result?.action === 'fallback') {
            return {
                plan: {
                    ...plan,
                    notes: [{
                        type: 'reference',
                        name: 'Legacy brain dump',
                        description: 'Manual fallback selected during Memory v3 migration.',
                        content: originalBrain,
                        filename: 'reference_legacy_brain_dump.md',
                    }],
                    keepInBrain: [],
                }
            };
        }
        return { plan: result?.plan || plan };
    }
}

// Runda 2 (2026-08-28, weryfikacja opus, P1 — BLOKER Z1): sygnał A jest silny i wystarcza
// sam (kanoniczny wikilink notatki brain/, ktory umie wyemitowac WYLACZNIE `buildBrainIndex`).
// Sygnał B (samo „## Na teraz") jest za slaby sam w sobie — recznie dopisany naglowek w starym
// v2 brainie dawal fałszywy pozytyw. Liczy sie tylko RAZEM z co najmniej dwoma naglowkami
// `INDEX_SECTIONS` jako dokladnymi liniami (po trim) — realny v3 zawsze ma je wszystkie.
const V3_CANONICAL_WIKILINK_RE = /^\s*-\s*\[\[brain\/(user|agent_rule|skill_hint|project_context|reference)_[^\]\n]+\.md/m;
const NA_TERAZ_HEADING_RE = /^##\s+na teraz\b/im;

/**
 * Naprawa 2026-08-28 (znalezisko #4): true, gdy treść wygląda jak JUŻ zmigrowany indeks v3.
 *
 * Runda 2 (2026-08-28, weryfikacja opus, P1): pojedynczy słaby sygnał fałszywie wygaszał
 * migrację (zwykły `- [[brain/mapa_projektu]]` niekanoniczny wikilink, albo samotne ręczne
 * `## Na teraz` w starym v2 brainie). Teraz wymagana jest KORROBORACJA:
 *   - sygnał A (silny, wystarcza sam): kanoniczny wikilink notatki `brain/*.md`,
 *   - sygnał B (słaby, wymaga korroboracji): nagłówek „Na teraz" WYSTĘPUJE RAZEM z co
 *     najmniej dwoma nagłówkami z `INDEX_SECTIONS` (dokładna linia, po trim).
 * Świadome ograniczenie zostaje: brain zbudowany WYŁĄCZNIE z gołego tekstu (żadna notatka,
 * żadna sekcja „Na teraz" nietknięta) jest nieodróżnialny od v2 — pozostaje `true`
 * (needsMigration), co jest bezpieczne, bo `buildPlan` poprawnie sparsuje jego sekcje.
 */
function looksLikeV3Index(content: string): boolean {
    const text = String(content || '');
    if (V3_CANONICAL_WIKILINK_RE.test(text)) return true;
    if (!NA_TERAZ_HEADING_RE.test(text)) return false;
    const lines = new Set(text.split(/\r?\n/).map(line => line.trim()));
    let matches = 0;
    for (const heading of INDEX_SECTIONS) {
        if (lines.has(heading)) matches++;
    }
    return matches >= 2;
}

/** P8: czy poza liniami nagłówków (`#`..`######`, w tym gołe `#` bez tekstu) i pustymi liniami zostaje jakakolwiek treść. */
function hasNonHeadingContent(content: string): boolean {
    return String(content || '')
        .split(/\r?\n/)
        .some(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            if (/^#{1,6}\s/.test(trimmed)) return false;
            if (/^#+$/.test(trimmed)) return false;
            return true;
        });
}

function normalizeSectionName(title: string): string {
    return String(title || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9ąćęłńóśźż -]+/gi, '')
        .trim();
}

function looksLikeZombie(section: MigrationSection): boolean {
    const text = `${section.title}\n${section.lines.join('\n')}`.toLowerCase();
    return text.includes('agora') || text.includes('vault-builder') || text.includes('default rob');
}

function cleanLegacyLine(line: string): string {
    return String(line || '')
        .replace(/^\s*[-*]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .trim();
}

// TOP_* = bullet/numeracja BEZ wcięcia — jedyne, co otwiera NOWY blok. Wersja z dowolnym
// wcięciem (`cleanLegacyLine` niżej) nadal zdejmuje marker z dowolnie zagnieżdżonej linii —
// to dwie różne role tego samego kształtu znaczników.
const TOP_BULLET_START_RE = /^[-*]\s+/;
const TOP_NUMBERED_START_RE = /^\d+[.)]\s+/;
const HR_LINE_RE = /^-{3,}$/;
const FENCE_LINE_RE = /^```/;
const SUBHEADING_RE = /^#{2,6}\s+(.+?)\s*$/;

/** Blok = jedna jednostka migracji (akapit/bullet); `prefix` = tekst nagłówka H3-H6, który go poprzedzał (P6). */
interface SectionBlock {
    lines: string[];
    prefix?: string;
}

/**
 * Naprawa 2026-08-28 (znalezisko #2): grupuje linie sekcji w bloki — jednostka migracji to
 * akapit/bullet, nie linia. Pusta linia zamyka blok; linia otwierająca NOWY bullet/numerację
 * zamyka poprzedni blok i zaczyna nowy (z sobą jako pierwszą linią); pozostałe linie to
 * kontynuacje zawiniętego tekstu i doklejają się do bieżącego bloku.
 *
 * Runda 2 (2026-08-28, weryfikacja opus, P6/Z4) dołożyła cztery reguły:
 *   - WCIĘTY bullet/numeracja (sub-bullet) NIE zaczyna nowego bloku — to kontekst rodzica,
 *     dokleja się do bieżącego bloku jak zwykła kontynuacja;
 *   - pozioma kreska (`---`) działa jak pusta linia (separator), nie wchodzi do treści;
 *   - sam znacznik fence (```` ``` ````, z ewentualnym językiem) jest pomijany — treść kodu
 *     zostaje w bloku. Świadomy kompromis: pusta linia W ŚRODKU bloku kodu nadal tnie blok
 *     (grupowanie jest proste, line-by-line, i nie śledzi „czy jesteśmy w fence");
 *   - nagłówek `###`-`######` wewnątrz sekcji domyka bieżący blok, a jego tekst staje się
 *     PREFIXEM następnego bloku (`flattenBlock`: `"<prefix>: <flat>"`); nagłówek, po którym
 *     nie ma żadnej treści (koniec sekcji albo od razu kolejny nagłówek), jest pomijany —
 *     `pendingPrefix` jest konsumowany (i czyszczony) tylko wtedy, gdy faktycznie trafia
 *     na blok z treścią; kolejny nagłówek go po prostu nadpisuje.
 */
function groupSectionIntoBlocks(lines: string[]): SectionBlock[] {
    const blocks: SectionBlock[] = [];
    let current: string[] = [];
    let pendingPrefix: string | undefined;
    const flush = () => {
        if (current.length) {
            blocks.push(pendingPrefix !== undefined ? { lines: current, prefix: pendingPrefix } : { lines: current });
            pendingPrefix = undefined;
        }
        current = [];
    };
    for (const rawLine of lines) {
        const line = String(rawLine || '');
        const trimmed = line.trim();

        if (!trimmed) {
            flush();
            continue;
        }
        if (HR_LINE_RE.test(trimmed)) {
            flush();
            continue;
        }
        if (FENCE_LINE_RE.test(trimmed)) {
            continue;
        }
        const heading = line.match(SUBHEADING_RE);
        if (heading) {
            flush();
            pendingPrefix = heading[1].trim();
            continue;
        }
        if (TOP_BULLET_START_RE.test(line) || TOP_NUMBERED_START_RE.test(line)) {
            flush();
            current = [line];
            continue;
        }
        // Kontynuacja zawiniętego tekstu ALBO wcięty sub-bullet — obie doklejają się do
        // bieżącego bloku zamiast otwierać nowy.
        current.push(line);
    }
    flush();
    return blocks;
}

/** Sklej blok linii w jedną myśl: `cleanLegacyLine` per linia, spacja jako separator, redukcja wielospacji. Prefix nagłówka (P6) idzie z przodu jako `"<prefix>: <flat>"`. */
function flattenBlock(block: SectionBlock): string {
    const flat = block.lines
        .map(cleanLegacyLine)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    return block.prefix && flat ? `${block.prefix}: ${flat}` : flat;
}

function shortName(line: string, sectionTitle: string, index: number): string {
    const withoutMeta = line.replace(/^([^:]{1,40}):\s*/, '$1 ');
    const words = withoutMeta.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
    return words || `${sectionTitle} ${index}`;
}

// Runda 2 (2026-08-28, weryfikacja opus, P5/Z3): kolizja nazwy dostaje sufiks (`_2`, `_3`, …)
// zamiast być cicho porzucona — dwa różne akapity o identycznych pierwszych 6 słowach (stąd
// identyczny `makeMemoryNoteFilename`) ZOSTAJĄ oba w planie, żaden nie znika.
function dedupeNotes(notes: MigrationNote[]): MigrationNote[] {
    const seen = new Set<string>();
    const result: MigrationNote[] = [];
    for (const note of notes) {
        let filename = safeFilename(note);
        if (seen.has(filename)) filename = nextFreeFilename(filename, seen);
        seen.add(filename);
        result.push({ ...note, filename });
    }
    return result;
}

function nextFreeFilename(filename: string, taken: Set<string>): string {
    const match = filename.match(/^(.*)(\.md)$/);
    const base = match ? match[1] : filename;
    const ext = match ? match[2] : '';
    let i = 2;
    let candidate = `${base}_${i}${ext}`;
    while (taken.has(candidate)) {
        i++;
        candidate = `${base}_${i}${ext}`;
    }
    return candidate;
}

function safeFilename(note: MigrationNote): string {
    return note.filename || makeMemoryNoteFilename(note.type, note.name);
}

function formatBrainNote(note: MigrationNote, filename: string, created: string): string {
    return `---
name: ${escapeFrontmatter(note.name || filename.replace(/\.md$/, ''))}
description: ${escapeFrontmatter(note.description || '')}
type: ${note.type || 'reference'}
created: ${created}
source: memory_v2_migration
---

${note.content || ''}
`;
}

function escapeFrontmatter(value: unknown): string {
    return String(value || '').replace(/\r?\n/g, ' ').replace(/:/g, ' -');
}

// Naprawa 2026-08-28 (znalezisko #3): `keptSections` (tytuły z `plan.keepInBrain`, body z
// `applyPlan`) wchodzą do `buildBrainIndex` jako `foreign` — dokładnie ten sam mechanizm, który
// od incydentu 2026-08-15 chroni ręcznie dopisane sekcje (`## AKTYWNY TEST`) przy zwykłym
// rebuildzie indeksu. Końcowe puste linie ucięte, wzorem `parseForeignSections` w `BrainIndex.ts`.
function formatNewBrain(agentName: string, plan: MigrationPlan, createdNotes: string[], keptSections: MigrationSection[] = []): string {
    const createdNames = new Set(createdNotes.map(path => path.split('/').pop()));
    const notes: BrainNoteMeta[] = (plan.notes || [])
        .map(note => ({
            filename: safeFilename(note),
            name: note.name || safeFilename(note).replace(/\.md$/, ''),
            description: note.description || note.content || '',
            type: note.type || 'reference',
            created: plan.created || ''
        }))
        .filter(note => createdNames.has(note.filename));
    const foreign: ForeignSection[] = keptSections.map(section => ({
        heading: `## ${section.title}`,
        lines: trimTrailingEmptyLines(section.lines),
    }));
    return buildBrainIndex({ agentName, notes, foreign });
}

function trimTrailingEmptyLines(lines: string[]): string[] {
    const copy = [...lines];
    while (copy.length && !(copy[copy.length - 1] || '').trim()) copy.pop();
    return copy;
}

async function copyFolder(adapter: MigrationVaultAdapterLike, source: string, backup: string): Promise<void> {
    const listed = await adapter.list(source);
    const files = listed?.files || [];
    for (const file of files) {
        const target = `${backup}/${file.slice(source.length + 1)}`;
        await ensureAdapterFolder(adapter, parentPath(target));
        await adapter.write(target, await adapter.read(file));
    }

    const folders = listed?.folders || [];
    for (const folder of folders) {
        const target = `${backup}/${folder.slice(source.length + 1)}`;
        await ensureAdapterFolder(adapter, target);
        await copyFolder(adapter, folder, target);
    }
}

function parentPath(path: string): string {
    const normalized = String(path || '').replace(/\/+$/, '');
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return '';
    return normalized.slice(0, idx);
}
