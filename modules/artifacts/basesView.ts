/**
 * basesView.js — generator pliku `.base` (Obsidian Bases) dla artefaktów żywych (S32 Z7).
 *
 * Pure module (ZERO importów Obsidiana / i18n) → node-testowalne. Buduje treść pliku `.base`
 * ręcznie jako template string, NIE przez `stringifyYaml` — kolejność kluczy i styl mają być
 * czytelne dla usera, który ten plik potem klika w GUI Bases (i może go dostosować).
 *
 * Zakres: TYLKO artefakty (widoczny folder vaulta). Archiwum SESJI żyje w ukrytym
 * `.pkm-assistant/`, którego Obsidian nie indeksuje — Bases go po prostu nie widzi,
 * więc nie ma czego pokazywać.
 *
 * Dwa widoki (oba `type: table`):
 *  - „Wszystkie" — wszystko z folderu artefaktów, co ma frontmatter `pkm-artefakt`
 *    (czyli tylko instancje; `.base`, README i inne notatki usera są odfiltrowane).
 *  - „Otwarte"   — jak wyżej minus status `zamkniety`.
 *
 * Filtr po `file.inFolder(...)` łapie także podfoldery per agent oraz `_archiwum`
 * (świadomie: archiwum artefaktów to nadal artefakty, a user może sobie dodać własny widok).
 */
import { DEFAULT_ARTIFACTS_FOLDER } from './ArtifactStore.js';
import { CLOSED_STATUS } from './artifactButtons.js';

/** Nazwa generowanego pliku (bez folderu). */
export const ARTIFACTS_BASE_FILENAME = 'Artefakty.base';

/** Kolumny obu widoków — bazowe klucze frontmattera artefaktu (A6, po polsku). */
const ORDER = ['file.name', 'typ', 'agent', 'status', 'utworzono', 'zaktualizowano'];

/**
 * Escape wartości do literału stringa WEWNĄTRZ wyrażenia Bases (podwójne cudzysłowy).
 * @param {string} value
 * @returns {string} np. `"PKM Assistant/Artefakty"`
 */
function baseStringLiteral(value: unknown): string {
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
}

/**
 * Escape wyrażenia do skalara YAML w apostrofach (w YAML `'` podwaja się do `''`).
 * Apostrofy używamy zawsze — wyrażenia zaczynają się od `!` albo zawierają `"`,
 * więc goły skalar byłby albo błędem parsera, albo pułapką.
 * @param {string} expr
 * @returns {string}
 */
function yamlSingleQuoted(expr: unknown): string {
    return `'${String(expr).replace(/'/g, "''")}'`;
}

/**
 * Normalizacja folderu: trim + zdjęcie ukośników z brzegów; pusty → default.
 * @param {string} [folder]
 * @returns {string}
 */
function normalizeFolder(folder: unknown): string {
    const trimmed = String(folder ?? '').trim().replace(/^\/+|\/+$/g, '');
    return trimmed || DEFAULT_ARTIFACTS_FOLDER;
}

/**
 * Ścieżka generowanego pliku `.base` w vaulcie (ta sama normalizacja folderu co treść).
 * @param {string} [folder]
 * @returns {string} np. `PKM Assistant/Artefakty/Artefakty.base`
 */
export function buildArtifactsBasePath(folder?: string): string {
    return `${normalizeFolder(folder)}/${ARTIFACTS_BASE_FILENAME}`;
}

/**
 * Zbuduj treść pliku `.base` z widokami artefaktów.
 *
 * @param {string} [folder] - folder artefaktów (`settings.pkmAssistant.artifactsFolder`)
 * @returns {string} treść pliku `.base` (YAML)
 */
export function buildArtifactsBaseContent(folder?: string): string {
    const root = normalizeFolder(folder);
    const inFolder = yamlSingleQuoted(`file.inFolder(${baseStringLiteral(root)})`);
    const isArtifact = yamlSingleQuoted('!note["pkm-artefakt"].isEmpty()');
    const notClosed = yamlSingleQuoted(`note["status"] != ${baseStringLiteral(CLOSED_STATUS)}`);

    const order = ORDER.map((prop) => `      - ${prop}`).join('\n');
    const sort = ['    sort:', '      - property: zaktualizowano', '        direction: DESC'].join('\n');

    const view = (name: string, filters: string[]) => [
        `  - type: table`,
        `    name: ${name}`,
        `    filters:`,
        `      and:`,
        ...filters.map((f: string) => `        - ${f}`),
        `    order:`,
        order,
        sort,
    ].join('\n');

    return [
        'properties:',
        '  file.name:',
        '    displayName: Notatka',
        'views:',
        view('Wszystkie', [inFolder, isArtifact]),
        view('Otwarte', [inFolder, isArtifact, notClosed]),
        '',
    ].join('\n');
}
