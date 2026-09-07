/**
 * artifactParser.js — parser + patcher artefaktów żywych (E2.9 FAZA A / A1).
 *
 * Pure module (zależność tylko od `core/utils/yamlParser` — silnik YAML wstrzykiwany przez
 * composition root, TS-4 2026-09-07; ZERO importów Obsidiana) → testowalny node'em. Wzór:
 * `modules/prompts/decisionTree.js` / `modules/prompts/skillIndex.js`.
 *
 * Dwie funkcje:
 *  - `parseArtifact(markdown)` → chudy JSON dla agenta (frontmatter + sekcje + checkboxy).
 *    Frontmatter to FALLBACK — w runtime store woli `metadataCache` (świeższy). Parser jest
 *    „głupi" (A14): raportuje strukturę, znaczenie checkboxa decyduje typ + slot promptu.
 *  - `applyPatch(markdown, ops[])` → { markdown, applied, errors } — strukturalny patch nakładany
 *    na ŚWIEŻY stan tekstu. Patch NIE dotyka sekcji, których nie adresuje (edycje usera przeżywają).
 *
 * Bezpieczeństwo egzekwowane TU (nie tylko w prompcie): agent NIGDY nie pisze bloków kodu
 * (`code_forbidden`) ani nagłówków poziomu 1-2 (`heading_forbidden` — rozbijałyby strukturę
 * sekcji), a klucze bazowe frontmattera są NIEZMIENIALNE (`protected_key`).
 *
 * Uwagi: CRLF-safe (repo na Windows); `zaktualizowano` NIE jest odświeżane tutaj (parser jest
 * bezczasowy/deterministyczny) — robi to store po udanym patchu (ma dostęp do daty).
 */
import { parseYaml, stringifyYaml } from '../../core/index.js';
import type { ArtifactFrontmatter, ArtifactPatchError, ArtifactScalar, ArtifactSection, ParsedArtifact } from './types.js';

/** Klucze bazowe frontmattera instancji, których agent NIE może zmienić (A1/A6). */
export const PROTECTED_FIELDS = ['pkm-artefakt', 'typ', 'agent', 'utworzono'];

/** Limit tekstu sekcji wstrzykiwanego do kontekstu agenta (A4 — `artifact_read`). */
export const ARTIFACT_CONTEXT_MAX_CHARS = 4000;

/**
 * Wykrycie bloku kodu — K10 (AUD-security-089).
 *
 * Wcześniej stał tu sam `/```/`, więc bramka `code_forbidden` widziała WYŁĄCZNIE potrójny
 * grawis. CommonMark (a za nim Obsidian) zna też fence tyldowy, a renderer Obsidiana przepuszcza
 * surowy HTML — ten sam ładunek (`~~~dataviewjs`, `<pre>`, `<script>`) wchodził więc do notatki
 * bokiem. Liczymy wszystkie nośniki, żeby obietnica „agent NIGDY nie pisze bloku kodu" (A3)
 * miała jedno miejsce prawdy.
 *
 * ŚWIADOMIE NIE liczymy wciętego bloku kodu (4 spacje / tab): w treści artefaktu tak wygląda
 * zagnieżdżony punkt listy, więc bramka odrzucałaby normalną pracę modelu. Wcięcie bez fence'a
 * nie jest też nośnikiem dla `dataviewjs` — procesory bloków Obsidiana czepiają się fence'a.
 */
const CODE_FENCE_RE = /```|~~~/;
/** Nośniki kodu w surowym HTML (Obsidian renderuje HTML w treści notatki). */
const HTML_CODE_RE = /<\s*\/?\s*(pre|code|script|iframe|object|embed)\b/i;
/** Komunikat odmowy bloku kodu (techniczny, dla modelu). */
const CODE_FORBIDDEN_MSG = 'Code blocks are not allowed in artifact content (``` / ~~~ / <pre> / <code> / <script>)';
/** Nagłówek Markdown ATX (poziom 1–6). */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
/** Podkreślenie setext: sama linia `=` (H1) albo `-` (H2), z tolerancją wcięcia CommonMark. */
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
/** Najgłębszy poziom nagłówka, który silnik uznaje za SEKCJĘ (`#`/`##`). */
const SECTION_HEADING_MAX_LEVEL = 2;
/** Checkbox listy: opcjonalne wcięcie, `- [ ]` / `- [x]`, treść, opcjonalny `^blockId`. */
const CHECKBOX_RE = /^(\s*)-\s+\[([ xX])\]\s+(.*?)(?:\s+\^([a-zA-Z0-9-]+))?\s*$/;
/**
 * Dowolny element listy (dla znalezienia końca listy w sekcji ORAZ wykluczenia setext
 * pod punktem — AUD-code-review-104). Bullet (`-`) i numerowany (`1.`/`1)`) — CommonMark
 * uznaje oba za akapit-przerywacz, więc `---`/`===` zaraz pod nimi to `hr`, nie nagłówek.
 */
const LIST_ITEM_RE = /^\s*(?:-\s+|\d+[.)]\s+)/;
/** Blok frontmattera na początku pliku. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Data lokalna w formacie `YYYY-MM-DD` (AUD-code-review-105) — JEDEN helper dla modułu.
 * `ArtifactStore._today()`/`_genId()` i `migrate_json_to_notes.ts` budowały to samo niezależnie
 * (getFullYear/getMonth/getDate + padStart); poprawka formatu/strefy = jedna kopia zamiast trzech.
 * Świadomie NIE `toISOString().slice(0,10)` — to UTC, a data instancji ma być LOKALNA (jak dotąd).
 * Sygnał z audytu: ten sam kształt YYYY-MM-DD żyje też w `modules/komunikator/KomunikatorManager.ts`
 * (`formatMessageDate`) — poza tym modułem, więc świadomie NIETKNIĘTY tutaj.
 */
export function formatYmd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Wykryj dominujące zakończenie linii (CRLF vs LF). */
function detectEol(text: unknown): string {
    return /\r\n/.test(String(text || '')) ? '\r\n' : '\n';
}

/**
 * Podziel na linie DOKŁADNIE tak, jak łamie je renderer.
 *
 * M (AUD-security-124): CommonMark (a za nim Obsidian) kończy linię także na SAMOTNYM `\r`.
 * Dopóki bramka dzieliła tylko po `\r?\n`, ładunek `'tekst\r## Sekcja'` był dla niej jedną
 * linią bez nagłówka, a w notatce renderował się jako nagłówek poziomu 2.
 */
function splitLines(text: unknown): string[] {
    return String(text ?? '').split(/\r\n|\r|\n/);
}

/** Nagłówek sekcji znaleziony w ciele: `start` = pierwsza linia nagłówka, `end` = ostatnia. */
interface SectionHeadingHit { level: number; title: string; start: number; end: number }

/**
 * M (AUD-security-122/124): JEDNA reguła „co jest nagłówkiem SEKCJI".
 *
 * Czytają ją WSZYSCY trzej: `parseArtifact` (struktura), `findSection` (adresowanie patcha)
 * i `hasSectionHeading` (bramka `heading_forbidden`). Do fali M każdy mierzył co innego —
 * bramka `#`/`##`, zlew `#`…`######` — więc podrobiony `### Uwagi usera` przechwytywał patch
 * adresowany do prawdziwej sekcji, a wersja setext (`Tytul` + `===`/`---`) przechodziła bramkę
 * i renderowała się w notatce jako nagłówek.
 *
 * Rozpoznajemy więc oba warianty CommonMarka, ale tylko do poziomu, który TWORZY sekcję:
 *  - ATX `#`/`##` (poziom 3+ to legalny podtytuł WEWNĄTRZ sekcji),
 *  - setext: niepusty akapit + linia samych `=` (H1) / `-` (H2).
 *
 * Setext wymaga akapitu nad kreską — kreska po pustej linii, po nagłówku, po elemencie listy
 * albo po drugiej kresce to zwykły separator (`hr`), nie nagłówek.
 */
function scanSectionHeadings(lines: string[]): SectionHeadingHit[] {
    const out: SectionHeadingHit[] = [];
    for (let i = 0; i < lines.length; i++) {
        const atx = HEADING_RE.exec(lines[i]);
        if (atx) {
            if (atx[1].length <= SECTION_HEADING_MAX_LEVEL) {
                out.push({ level: atx[1].length, title: atx[2].trim(), start: i, end: i });
            }
            continue;
        }
        const setext = SETEXT_RE.exec(lines[i]);
        if (!setext || i === 0) continue;
        const prev = lines[i - 1];
        if (prev.trim() === '') continue;                       // kreska po pustej linii = hr
        if (HEADING_RE.test(prev) || SETEXT_RE.test(prev)) continue;
        if (LIST_ITEM_RE.test(prev)) continue;                  // setext nie przerywa listy
        if (out.length > 0 && out[out.length - 1].end === i - 1) continue; // akapit zjedzony wyżej
        out.push({ level: setext[1].startsWith('=') ? 1 : 2, title: prev.trim(), start: i - 1, end: i });
    }
    return out;
}

/**
 * Rozdziel frontmatter od ciała.
 * @returns {{ hasFm: boolean, fmText: string, body: string }}
 */
function splitFrontmatter(text: unknown): { hasFm: boolean; fmText: string; body: string } {
    const m = String(text ?? '').match(FRONTMATTER_RE);
    if (!m) return { hasFm: false, fmText: '', body: String(text ?? '') };
    return { hasFm: true, fmText: m[1], body: String(text ?? '').slice(m[0].length) };
}

/** Zbuduj plik z frontmattera (obiekt) + ciała, znormalizowany do danego EOL. */
function rebuild(fmObject: ArtifactFrontmatter, body: string, eol: string): string {
    const yaml = stringifyYaml(fmObject);
    const raw = `---\n${yaml}---\n${body}`;
    return normalizeEol(raw, eol);
}

/** Ujednolić EOL w całym tekście do zadanego. */
function normalizeEol(text: unknown, eol: string): string {
    return String(text ?? '').replace(/\r?\n/g, eol);
}

/**
 * Sparsuj artefakt do chudego JSON-a.
 * @param {string} markdown
 * @returns {{ frontmatter: Object, sections: Array<{heading:string, level:number, text:string, items:Array<{blockId:string|null, text:string, checked:boolean}>}>, buttons: boolean }}
 */
export function parseArtifact(markdown: unknown): ParsedArtifact {
    const { fmText, body } = splitFrontmatter(markdown);
    const frontmatter = ((fmText ? parseYaml(fmText) : null) || {}) as ArtifactFrontmatter;

    const lines = splitLines(body);
    const sections: Array<Omit<ArtifactSection, 'text'> & { _proseLines: string[] }> = [];
    let current: (Omit<ArtifactSection, 'text'> & { _proseLines: string[] }) | null = null;

    // M: struktura liczona TYM SAMYM skanerem co bramka i `findSection` (patrz `scanSectionHeadings`).
    const heads = scanSectionHeadings(lines);
    const headByLastLine = new Map(heads.map(h => [h.end, h]));
    const headTitleLines = new Set(heads.filter(h => h.start !== h.end).map(h => h.start));

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const head = headByLastLine.get(i);
        if (head) {
            // Nowa sekcja zaczyna się na `#`/`##` (albo podkreśleniu setext); `###+` to treść.
            current = { heading: head.title, level: head.level, _proseLines: [], items: [] };
            sections.push(current);
            continue;
        }
        if (headTitleLines.has(i)) continue; // tytuł nad kreską setext = część nagłówka
        if (!current) continue; // preambuła przed pierwszym nagłówkiem — pomijana w sekcjach
        const cb = CHECKBOX_RE.exec(line);
        if (cb) {
            current.items.push({
                blockId: cb[4] || null,
                text: cb[3].trim(),
                checked: cb[2].toLowerCase() === 'x',
            });
        } else {
            current._proseLines.push(line);
        }
    }

    const cleaned = sections.map(s => ({
        heading: s.heading,
        level: s.level,
        text: s._proseLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        items: s.items,
    }));

    return {
        frontmatter,
        sections: cleaned,
        // K10 (AUD-security-089): detektor liczy te same fence'y co bramka — inaczej blok
        // napisany tyldami jest w pliku, a chudy JSON (i UI) raportują `buttons: false`.
        buttons: /^(?:```+|~~~+)\s*pkm-artefakt\b/m.test(body),
    };
}

/**
 * Znajdź granice sekcji po nagłówku (case-insensitive, trim). Zwraca indeksy w tablicy linii ciała.
 * Sekcja = od nagłówka do następnego nagłówka tego samego/wyższego poziomu (lub końca).
 *
 * M (AUD-security-122): szukamy WYŁĄCZNIE wśród nagłówków, które `parseArtifact` uznaje za
 * sekcje (`scanSectionHeadings`). Wcześniej dopasowywał się tu KAŻDY poziom, więc podrobiony
 * `### Uwagi usera` — legalny podtytuł, którego bramka świadomie nie blokuje — przechwytywał
 * patch adresowany do prawdziwej sekcji `## Uwagi usera` i kasował cudzą treść aż do niej.
 *
 * `start` to OSTATNIA linia nagłówka (przy setext: podkreślenie), żeby `slice(0, start+1)`
 * zachował go w całości; `end` to PIERWSZA linia następnego nagłówka (przy setext: jego tytuł).
 * @returns {{ start:number, end:number, level:number }|null}
 */
function findSection(bodyLines: string[], heading: unknown): { start: number; end: number; level: number } | null {
    const target = String(heading ?? '').trim().toLowerCase();
    if (!target) return null;
    const heads = scanSectionHeadings(bodyLines);
    for (let n = 0; n < heads.length; n++) {
        const hit = heads[n];
        if (hit.title.toLowerCase() !== target) continue;
        const next = heads.slice(n + 1).find(h => h.level <= hit.level);
        return { start: hit.end, end: next ? next.start : bodyLines.length, level: hit.level };
    }
    return null;
}

/** Pierwszy wolny blockId `k<n>` w pliku (skan istniejących `^k<num>`). */
function nextBlockId(text: string): string {
    const used = new Set<number>();
    const re = /\^k(\d+)\b/g;
    let m;
    while ((m = re.exec(text)) !== null) used.add(Number(m[1]));
    let n = 1;
    while (used.has(n)) n++;
    return `k${n}`;
}

/** Znajdź indeks linii checkboxa po blockId. */
function findItemLine(bodyLines: string[], blockId: unknown): number {
    const id = String(blockId ?? '');
    if (!id) return -1;
    for (let i = 0; i < bodyLines.length; i++) {
        const cb = CHECKBOX_RE.exec(bodyLines[i]);
        if (cb && cb[4] === id) return i;
    }
    return -1;
}

function err(op: unknown, code: string, message: string): { error: ArtifactPatchError } {
    return { error: { op, code, message } };
}

/**
 * Czy tekst od agenta niesie linię, którą `parseArtifact` uzna za NOWĄ SEKCJĘ (`#`/`##`)?
 *
 * Poziomy 1-2 tworzą sekcje, więc wpisanie takiej linii do TREŚCI sekcji rozbija strukturę
 * artefaktu: powstaje drugi nagłówek o tej samej nazwie, a `findSection` zwraca PIERWSZE
 * trafienie — oryginalna sekcja zostaje osierocona na zawsze. `###` i głębsze są DOZWOLONE
 * (model legalnie używa ich jako podtytułów wewnątrz sekcji).
 *
 * M (AUD-security-124): bramka i zlew liczą nagłówki TĄ SAMĄ funkcją (`scanSectionHeadings`),
 * więc obejmuje też setext (`Tytul` + `===`/`---`) i łamanie linii samotnym `\r` — oba
 * renderują się w notatce jako nagłówek, a bramka ich wcześniej nie widziała.
 */
function hasSectionHeading(text: string): boolean {
    return scanSectionHeadings(splitLines(text)).length > 0;
}

/** Komunikat odmowy nagłówka (techniczny, dla modelu — jak sąsiednie `code_forbidden`). */
const HEADING_FORBIDDEN_MSG = 'Headings level 1-2 (# / ## or setext ===/---) are not allowed in artifact content — they would create a new section. Use ### or deeper for subheadings.';

/**
 * K10 (AUD-security-061): JEDYNA bramka treści, którą AGENT wpisuje do ciała artefaktu.
 *
 * Każda droga zapisu ma przez nią przejść — opsy patcha (`set_section`/`add_item`) ORAZ wartości
 * `pola` podstawiane do szablonu typu przy `artifact_create` (`ArtifactStore.applyFieldsValidated`).
 * Wcześniej reguły stały tylko w `applyOne`, więc `pola` były drugą, niepilnowaną drogą: fence
 * kodu i nagłówek `##` lądowały w notatce vaultu, a narzędzie raportowało pełny sukces.
 *
 * Nie dotyczy treści USERA (szablon typu, wartości domyślne pól, `importInstance` migratora) —
 * tam kod jest legalny i świadomy (A3).
 *
 * @param {string} text - kandydat na treść
 * @returns {{code:string, message:string}|null} - `null` = wolno
 */
export function validateArtifactBodyText(text: unknown): { code: string; message: string } | null {
    const s = String(text ?? '');
    if (CODE_FENCE_RE.test(s) || HTML_CODE_RE.test(s)) return { code: 'code_forbidden', message: CODE_FORBIDDEN_MSG };
    if (hasSectionHeading(s)) return { code: 'heading_forbidden', message: HEADING_FORBIDDEN_MSG };
    return null;
}

/** Komunikat odmowy nie-skalara (techniczny, dla modelu). */
export const INVALID_VALUE_MSG = 'set_field accepts only scalar values (string/number/bool)';

/**
 * M (AUD-security-125): JEDEN kontrakt „co wolno wpisać jako WARTOŚĆ pola".
 *
 * Czytają go OBA wejścia wartości od modelu: op `set_field` w `applyOne` oraz `pola` przy
 * `artifact_create` (`ArtifactStore.applyFieldsValidated`). Wcześniej reguła stała tylko
 * w `applyOne`, a druga droga walidowała `String(value)` — zagnieżdżony obiekt zamieniał się
 * w `"[object Object]"`, przechodził bramkę treści i lądował w frontmatterze notatki SUROWY
 * (razem z blokiem kodu). Walidator ma oglądać to samo, co ląduje w pliku.
 */
export function isArtifactScalar(value: unknown): value is ArtifactScalar {
    return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Zastosuj pojedynczy op do tekstu. Zwraca { text } albo { error }. */
function applyOne(text: string, op: Record<string, unknown> | null, eol: string): { text: string } | { error: ArtifactPatchError } {
    if (!op || typeof op !== 'object' || !op.op) {
        return err(op, 'invalid_op', 'Missing op type');
    }

    // ── set_field: TYLKO frontmatter, tylko skalary, klucze bazowe niezmienialne ──
    if (op.op === 'set_field') {
        const key = op.key;
        if (!key || typeof key !== 'string') return err(op, 'invalid_op', 'set_field requires a string key');
        if (PROTECTED_FIELDS.includes(key)) return err(op, 'protected_key', `Field "${key}" is immutable`);
        const v = op.value;
        if (!isArtifactScalar(v)) return err(op, 'invalid_value', INVALID_VALUE_MSG);
        const { hasFm, fmText, body } = splitFrontmatter(text);
        const fmObject = ((hasFm && fmText ? parseYaml(fmText) : null) || {}) as ArtifactFrontmatter;
        fmObject[key] = v;
        return { text: rebuild(fmObject, body, eol) };
    }

    // ── Operacje na ciele (sekcje / checkboxy) ──
    const { hasFm, fmText, body } = splitFrontmatter(text);
    const bodyLines = splitLines(body);
    const fmPrefix = hasFm ? `---\n${fmText}\n---\n` : '';
    const wrap = (newBodyLines: string[]) => normalizeEol(fmPrefix + newBodyLines.join('\n'), eol);

    if (op.op === 'set_section') {
        if (typeof op.text !== 'string') return err(op, 'invalid_op', 'set_section requires text');
        const bad = validateArtifactBodyText(op.text);
        if (bad) return err(op, bad.code, bad.message);
        const sec = findSection(bodyLines, op.heading);
        if (!sec) return err(op, 'not_found', `Section "${op.heading as string}" not found`);
        const newTextLines = op.text === '' ? [''] : splitLines(op.text);
        const next = [
            ...bodyLines.slice(0, sec.start + 1),
            ...newTextLines,
            ...bodyLines.slice(sec.end),
        ];
        return { text: wrap(next) };
    }

    if (op.op === 'add_item') {
        if (typeof op.text !== 'string' || !op.text.trim()) return err(op, 'invalid_op', 'add_item requires non-empty text');
        const bad = validateArtifactBodyText(op.text);
        if (bad) return err(op, bad.code, bad.message);
        // M (AUD-security-124): „jedna linia" liczona tak, jak łamie ją renderer — samotny `\r`
        // też kończy linię, więc `'punkt\r## Sekcja'` nie jest jednolinijkowcem.
        if (/[\r\n]/.test(op.text)) return err(op, 'multiline_forbidden', 'add_item text must be a single line');
        const sec = findSection(bodyLines, op.heading);
        if (!sec) return err(op, 'not_found', `Section "${op.heading as string}" not found`);
        const blockId = nextBlockId(text);
        const newLine = `- [ ] ${op.text.trim()} ^${blockId}`;
        // Wstaw po ostatnim elemencie listy w sekcji; gdy brak — po ostatniej niepustej linii.
        let insertAt = -1;
        for (let i = sec.start + 1; i < sec.end; i++) {
            if (LIST_ITEM_RE.test(bodyLines[i])) insertAt = i;
        }
        if (insertAt === -1) {
            let last = sec.start;
            for (let i = sec.start + 1; i < sec.end; i++) {
                if (bodyLines[i].trim() !== '') last = i;
            }
            insertAt = last;
        }
        const next = [
            ...bodyLines.slice(0, insertAt + 1),
            newLine,
            ...bodyLines.slice(insertAt + 1),
        ];
        return { text: wrap(next) };
    }

    if (op.op === 'check_item' || op.op === 'uncheck_item') {
        const idx = findItemLine(bodyLines, op.blockId);
        if (idx === -1) return err(op, 'not_found', `Block id "${op.blockId as string}" not found`);
        const mark = op.op === 'check_item' ? 'x' : ' ';
        bodyLines[idx] = bodyLines[idx].replace(/^(\s*-\s+\[)[ xX](\])/, `$1${mark}$2`);
        return { text: wrap(bodyLines) };
    }

    if (op.op === 'remove_item') {
        const idx = findItemLine(bodyLines, op.blockId);
        if (idx === -1) return err(op, 'not_found', `Block id "${op.blockId as string}" not found`);
        bodyLines.splice(idx, 1);
        return { text: wrap(bodyLines) };
    }

    return err(op, 'invalid_op', `Unknown op "${op.op as string}"`);
}

/**
 * Nałóż listę opsów na tekst artefaktu. Ops niepoprawne trafiają do `errors`; poprawne aplikowane
 * po kolei na wynik poprzednich. Sekcje nieadresowane pozostają nietknięte.
 * @param {string} markdown
 * @param {Array<Object>} ops
 * @returns {{ markdown: string, applied: number, errors: Array<{op:Object, code:string, message:string}> }}
 */
export function applyPatch(markdown: unknown, ops: unknown = []): { markdown: string; applied: number; errors: ArtifactPatchError[] } {
    const eol = detectEol(markdown);
    let text = String(markdown ?? '');
    const errors: ArtifactPatchError[] = [];
    let applied = 0;

    for (const op of Array.isArray(ops) ? ops : []) {
        const res = applyOne(text, op as Record<string, unknown> | null, eol);
        if ((res as { error?: ArtifactPatchError }).error) {
            errors.push((res as { error: ArtifactPatchError }).error);
        } else {
            text = (res as { text: string }).text;
            applied++;
        }
    }

    return { markdown: text, applied, errors };
}
