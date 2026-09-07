/**
 * `utils/releaseNotes.ts` — pliki notatek wydania (`releases/`).
 *
 * Podział ról jest tu sednem naprawy AUD-docs-009:
 *  - {@link latestReleaseFile} służy WYŁĄCZNIE do CZYTANIA poprzednich notatek
 *    i legalnie zwraca `null`, gdy w katalogu nie ma jeszcze pliku `X.Y.Z.md`;
 *  - {@link resolveNotesTarget} daje ZAWSZE-NIE-NULL ścieżkę ZAPISU i nie dotyka dysku,
 *    więc zapis w `release.js` nie ma jak dostać `null` jako celu;
 *  - {@link writePluginReleaseNotes} nadpisuje WYŁĄCZNIE `latest_release.md`; pliki
 *    `<wersja>.md` są kopiami trwałymi i ta funkcja ich nie dotyka.
 *
 * Plik jest świadomą sierotą grafu produkcyjnego — woła go wydanie, nie kod wtyczki.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Rozpoznawany kształt nazwy pliku notatek — DOKŁADNIE trzy segmenty semver + `.md`,
 * BEZ prefiksu `v`. `v2.0.1.md` i `2.0.md` są odrzucane.
 */
export const RELEASE_NOTES_FILENAME_PATTERN = /^(\d+)\.(\d+)\.(\d+)\.md$/;

/**
 * JEDYNY plik notatek NADPISYWANY przy każdym wydaniu (sformatowana wersja pod widok
 * w pluginie). Pliki `X.Y.Z.md` są kopiami trwałymi i nigdy nie są nadpisywane.
 */
export const LATEST_RELEASE_NOTES_FILENAME = 'latest_release.md';

/** Katalog notatek, względem roota repo. */
export const RELEASES_DIR_NAME = 'releases';

/** Tytuł, którym otwiera się sformatowana notatka pokazywana w pluginie. */
const NOTES_TITLE = 'PKM Assistant';

/** Nagłówek markdown otwierający sekcję konkretnej wersji (`## 2.1.0`, `### v2.0.0 …`). */
const VERSION_HEADING = /^#{1,6}\s+v?(\d+\.\d+\.\d+)\b/;

/** Trzy liczby wersji z nazwy pliku; `null`, gdy nazwa nie pasuje do wzorca. */
function versionTripleOf(filename: string): [number, number, number] | null {
    const match = RELEASE_NOTES_FILENAME_PATTERN.exec(filename);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Porównanie semver `X.Y.Z` (bez pre-release), użyte do wyboru „najnowszego" pliku notatek.
 * Porównanie NUMERYCZNE per segment, nie leksykalne (`1.9.5` < `1.10.0`).
 *
 * Segmenty nieliczbowe traktowane są jak `0` — funkcja ma szeregować nazwy plików,
 * nie walidować wersji (od walidacji jest `releaseTagName`).
 *
 * @returns liczba < 0 gdy `a < b`, 0 gdy równe, > 0 gdy `a > b`.
 */
export function compareSemver(a: string, b: string): number {
    const left = a.split('.');
    const right = b.split('.');
    const depth = Math.max(left.length, right.length);

    for (let i = 0; i < depth; i++) {
        const l = Number.parseInt(left[i] ?? '0', 10) || 0;
        const r = Number.parseInt(right[i] ?? '0', 10) || 0;
        if (l !== r) return l - r;
    }
    return 0;
}

/**
 * Znajduje ścieżkę do notatek NAJNOWSZEJ wersji w katalogu, POMIJAJĄC plik bieżącej
 * wersji. Służy WYŁĄCZNIE do CZYTANIA.
 *
 * - pusty katalog → `null`, nie rzuca;
 * - katalog z samymi nie-wersyjnymi plikami (`latest_release.md`, `README.md`) → `null`;
 * - NIEISTNIEJĄCY katalog → `null`, nie rzuca;
 * - ignoruje pliki niepasujące do wzorca (`v2.0.1.md`, `2.0.md`).
 *
 * Zwracana ścieżka jest złączona przez `path.join(dir, plik)`.
 */
export function latestReleaseFile(dir: string, currentVersion: string): string | null {
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return null; // nieistniejący / nieczytelny katalog to brak poprzednich notatek, nie awaria
    }

    const skip = `${currentVersion}.md`;
    let bestName: string | null = null;
    let bestTriple: [number, number, number] | null = null;

    for (const entry of entries) {
        if (entry === skip) continue;
        const triple = versionTripleOf(entry);
        if (!triple) continue;
        if (!bestTriple || compareTriples(triple, bestTriple) > 0) {
            bestTriple = triple;
            bestName = entry;
        }
    }

    return bestName === null ? null : path.join(dir, bestName);
}

/** Porównanie rozłożonych trójek — tańsze niż sklejanie ich z powrotem w string. */
function compareTriples(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/**
 * Treść notatek poprzedniego wydania, doklejana przed nowy opis, gdy
 * `releases/<wersja>.md` jeszcze nie istnieje.
 *
 * @returns treść pliku, albo `''` gdy {@link latestReleaseFile} dał `null`
 *          (funkcja NIE RZUCA na pustym ani nieistniejącym katalogu).
 */
export function priorNotes(dir: string, currentVersion: string): string {
    const file = latestReleaseFile(dir, currentVersion);
    if (!file) return '';
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

/**
 * ZAWSZE-NIE-NULL ścieżka ZAPISU notatek. Funkcja NIE DOTYKA DYSKU, więc fizycznie
 * nie ma jak zwrócić `null` — i o to chodzi (AUD-docs-009).
 *
 * Kształt wywołania: `resolveNotesTarget(releasesDir, '2.1.0')` → `<dir>/2.1.0.md`.
 */
export function resolveNotesTarget(dir: string, version: string): string {
    return path.join(dir, `${version}.md`);
}

/** Jedna sekcja notatek: nagłówek wersji (albo jego brak) plus tekst pod nim. */
interface NotesSection {
    /** Wersja z nagłówka albo `null` dla tekstu przed pierwszym nagłówkiem wersji. */
    readonly version: string | null;
    /** Pełny tekst sekcji razem z nagłówkiem. */
    readonly text: string;
    /** Tekst sekcji BEZ linii nagłówka — używany przy zwijaniu. */
    readonly body: string;
}

/** Rozbija markdown na sekcje po nagłówkach wersji; zachowuje kolejność wejścia. */
function splitVersionSections(markdown: string): NotesSection[] {
    const sections: NotesSection[] = [];
    let currentVersion: string | null = null;
    let heading: string | null = null;
    let buffer: string[] = [];

    const flush = (): void => {
        const body = buffer.join('\n').trim();
        const text = heading ? [heading, body].filter(Boolean).join('\n\n') : body;
        if (text) sections.push({ version: currentVersion, text, body });
    };

    for (const line of markdown.split(/\r?\n/)) {
        const match = VERSION_HEADING.exec(line);
        if (match) {
            flush();
            currentVersion = match[1];
            heading = line.trim();
            buffer = [];
            continue;
        }
        buffer.push(line);
    }
    flush();

    return sections;
}

/**
 * Przerobienie surowych notatek na wersję POD WIDOK W PLUGINIE: tytuł z bieżącą
 * wersją na górze, sekcja bieżącej wersji otwarta, starsze sekcje zwinięte
 * w `<details>` (żeby ekran „co nowego" nie był ścianą tekstu z pięciu wydań).
 *
 * Czysta funkcja, zero dysku. Format jest treścią redakcyjną, nie kontraktem —
 * wiąże tylko: wynik jest niepusty, zawiera `currentVersion` i nie rzuca dla
 * pustego wejścia.
 */
export function formatReleaseNotesContent(markdown: string, currentVersion: string): string {
    const blocks: string[] = [`# ${NOTES_TITLE} ${currentVersion}`];

    for (const section of splitVersionSections(markdown)) {
        if (section.version === null || section.version === currentVersion) {
            blocks.push(section.text);
            continue;
        }
        blocks.push(`<details>\n<summary>${section.version}</summary>\n\n${section.body}\n\n</details>`);
    }

    return `${blocks.join('\n\n')}\n`;
}

/**
 * Zapisuje GOTOWE notatki do `<dir>/latest_release.md` — JEDYNEGO pliku
 * NADPISYWANEGO przy każdym wydaniu. Pliki `<wersja>.md` są kopiami trwałymi i ta
 * funkcja ich NIE DOTYKA.
 *
 * Treść wchodzi tu już sformatowana ({@link formatReleaseNotesContent}), dlatego
 * `_version` nie jest używana w ciele — zostaje w sygnaturze, bo bez niej wołacz
 * traci jedyny ślad tego, CZYJĄ notatkę właśnie nadpisuje.
 *
 * @returns ścieżka zapisanego pliku (`path.join(dir, LATEST_RELEASE_NOTES_FILENAME)`)
 */
export function writePluginReleaseNotes(dir: string, _version: string, notes: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, LATEST_RELEASE_NOTES_FILENAME);
    fs.writeFileSync(target, notes, 'utf8');
    return target;
}
