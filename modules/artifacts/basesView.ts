/**
 * basesView.js — generator pliku `.base` (Obsidian Bases) dla artefaktów żywych.
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
 *  - „Otwarte"   — jak wyżej minus KAŻDY literał statusu domykającego. Plik `.base` jest
 *    STATYCZNĄ konfiguracją (Bases nie umie wywołać `closedStatusOf` w locie), więc lista
 *    literałów do wykluczenia jest liczona RAZ, przy generowaniu: oba literały roli `closed`
 *    (`'zamkniety'` PL i `'closed'` EN, ZAWSZE, niezależnie od tego, czy akurat załadowany typ
 *    ich używa) PLUS `closedStatusOf(type.statusy)` każdego typu przekazanego w `types`
 *    (własna nazwa końcowa typu usera, gdy nie ma rozpoznanej roli w jego liście). Duplikaty
 *    scalone (`Set`), każdy dostaje osobny warunek `!=` w tej samej klauzuli `and` (koniunkcja
 *    warunków `!=` = wykluczenie sumy zbiorów).
 *
 * Filtr po `file.inFolder(...)` łapie także podfoldery per agent oraz `_archiwum`
 * (świadomie: archiwum artefaktów to nadal artefakty, a user może sobie dodać własny widok).
 */
import { DEFAULT_ARTIFACTS_FOLDER } from './ArtifactStore.js';
import { CLOSED_STATUS } from './artifactButtons.js';
import { statusLiteral, closedStatusOf } from './artifactStatuses.js';
import type { ArtifactType } from './types.js';

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
function normalizeFolder(folder: string | undefined): string {
    const trimmed = (folder ?? '').trim().replace(/^\/+|\/+$/g, '');
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
 * Literały statusu „domknięty" do wykluczenia w widoku „Otwarte": oba literały roli `closed`
 * (zawsze) + `closedStatusOf` każdego typu przekazanego (deduplikowane, kolejność wstawienia).
 */
function closedStatusLiterals(types: ReadonlyArray<Pick<ArtifactType, 'statusy'>>): string[] {
    const set = new Set<string>([CLOSED_STATUS, statusLiteral('closed', 'en')]);
    for (const type of types) {
        const closed = closedStatusOf(type?.statusy || []);
        if (closed) set.add(closed);
    }
    return [...set];
}

/**
 * Zbuduj treść pliku `.base` z widokami artefaktów.
 *
 * @param {string} [folder] - folder artefaktów (`settings.pkmAssistant.artifactsFolder`)
 * @param {Array} [types] - typy ZAŁADOWANE w bibliotece (`ArtifactTypeLoader.getAllTypes()`) -
 *   ich `statusy` zasilają dodatkowe literały „domknięty" typów własnych usera. Pominięcie =
 *   sam rejestr wbudowany (`'zamkniety'`/`'closed'`), bezpieczne dla wołacza bez typeLoadera pod ręką.
 * @returns {string} treść pliku `.base` (YAML)
 */
export function buildArtifactsBaseContent(folder?: string, types: ReadonlyArray<Pick<ArtifactType, 'statusy'>> = []): string {
    const root = normalizeFolder(folder);
    const inFolder = yamlSingleQuoted(`file.inFolder(${baseStringLiteral(root)})`);
    const isArtifact = yamlSingleQuoted('!note["pkm-artefakt"].isEmpty()');
    const notClosedFilters = closedStatusLiterals(types)
        .map(literal => yamlSingleQuoted(`note["status"] != ${baseStringLiteral(literal)}`));

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
        view('Otwarte', [inFolder, isArtifact, ...notClosedFilters]),
        '',
    ].join('\n');
}
