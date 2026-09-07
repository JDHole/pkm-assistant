/**
 * MemoryAccessGuard.test.ts — AUD-testy-023 (kanon; duplikat AUD-testy-057).
 *
 * `MemoryAccessGuard` nie miał WŁASNEGO pliku testowego — jedyny dotyk w testach całego repo
 * był pośredni, przez `ReadTool.test.ts` (trzy asercje na samo pole `code`). Mutacyjnie
 * potwierdzone (audyt testy 2026-09-01, runda 1+3): blok odmowy ścieżki
 * (`MemoryAccessGuard.ts:85-93` — null byte, `/`, `//`, litera dysku, segment `..`) idzie się
 * wyciąć w całości, a `../../../etc/passwd` i `C:/Users/x/secret.md` wciąż wpadają w SĄSIEDNIĄ
 * gałąź wielosegmentową i oddają TEN SAM kod `invalid_path` — asercja na samym `code` tego nie
 * łapie. Strażnik kształtu nazwy (`:107-109`, regex `/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/`) nie miał
 * w całym repo ANI JEDNEJ asercji odmowy — po wycięciu `read(scope:'memory')` przyjmowałby
 * dowolny jednosegmentowy ciąg (`archive`, `note.txt`, `C:x.md`) jako nazwę notatki w `brain/`.
 *
 * Ten plik testuje `validateNoteFilename` BEZPOŚREDNIO na czystej klasie (bez `ReadTool`), po
 * jednej asercji na każdy warunek odmowy, Z ROZRÓŻNIENIEM który kod błędu wraca — bo
 * `MemoryAccessGuard.ts` ma DWA różne kody (`invalid_path` i `cross_agent_access_denied`), nie
 * jeden wspólny. Każdy warunek ma też stronę „przepuszcza dobre wejście".
 */
import test from 'ava';
import { MemoryAccessGuard, MEMORY_V3_ERROR_CODES } from './MemoryAccessGuard.js';

const BASE_PATH = '.pkm-assistant/agents/jaskier/memory';

function guardFor(agentName = 'Jaskier') {
    return new MemoryAccessGuard(agentName);
}

// ─── strona „przepuszcza dobre wejście" ─────────────────────────────────────────────

test('validateNoteFilename: nazwa bazowa "ok.md" przechodzi i buduje ścieżkę pod brain/', t => {
    const decision = guardFor().validateNoteFilename('ok.md', BASE_PATH);

    t.true(decision.ok);
    if (decision.ok) {
        t.is(decision.filename, 'ok.md');
        t.is(decision.path, `${BASE_PATH}/brain/ok.md`);
    }
});

test('validateNoteFilename: znaki dozwolone przez regex (litery, cyfry, kropka, myślnik, podkreślnik) przechodzą', t => {
    const decision = guardFor().validateNoteFilename('user_kuba-dev.notatka.v2.md', BASE_PATH);

    t.true(decision.ok);
    if (decision.ok) t.is(decision.filename, 'user_kuba-dev.notatka.v2.md');
});

// ─── warunek 1: pusty string (przed blokiem odmowy ścieżki, ale ta sama rodzina „odmowa") ────

test('validateNoteFilename: pusty string -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: sam whitespace (trim -> pusty) -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('   ', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

// ─── warunek: źle sformowany URI (decodeURIComponent rzuca) ──────────────────────────────────

test('validateNoteFilename: niepoprawna sekwencja procentowa (URI malformed) -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('%zz.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

// ─── warunek 2: null byte ─────────────────────────────────────────────────────────────────────

test('validateNoteFilename: null byte w nazwie -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('ok\0.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

// ─── warunek 3: ścieżka absolutna (start "/" i "//") ─────────────────────────────────────────

test('validateNoteFilename: ścieżka absolutna unixowa "/etc/x.md" -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('/etc/x.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: ścieżka UNC "//server/x.md" -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('//server/x.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

// ─── warunek 4: litera dysku Windows ──────────────────────────────────────────────────────────

test('validateNoteFilename: litera dysku "C:/x.md" -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('C:/x.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: litera dysku z backslashami "C:\\Users\\x\\secret.md" -> invalid_path (normalizacja \\ -> / przed testem)', t => {
    const decision = guardFor().validateNoteFilename('C:\\Users\\x\\secret.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

// ─── warunek 5: traversal (segment ".." dosłownie) ───────────────────────────────────────────

test('validateNoteFilename: traversal "../x.md" -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('../x.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: traversal głębszy "../../../etc/passwd" -> invalid_path', t => {
    const decision = guardFor().validateNoteFilename('../../../etc/passwd', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: traversal jako segment W ŚRODKU ścieżki "brain/../x.md" -> invalid_path (łapane PRZED gałęzią wielosegmentową)', t => {
    const decision = guardFor().validateNoteFilename('brain/../x.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: ".." jako PODCIĄG nazwy (nie cały segment) NIE jest traversal - "foo..bar.md" przechodzi', t => {
    // Kontrola dodatnia: `segment === '..'` sprawdza CAŁY segment, nie podciąg. Ten string ma
    // dwie kropki w środku jednego segmentu (nie jest równy '..'), więc omija warunek traversal
    // i trafia do regexu kształtu — który go przepuszcza (kropki są w dozwolonej klasie znaków).
    const decision = guardFor().validateNoteFilename('foo..bar.md', BASE_PATH);

    t.true(decision.ok);
});

// ─── warunek 6a: wielosegmentowa ścieżka - kształt cross-agent (RÓŻNY kod od invalid_path) ───

test('validateNoteFilename: wielosegmentowa "obcy/brain/x.md" z INNYM agentem -> cross_agent_access_denied (NIE invalid_path)', t => {
    const decision = guardFor('Jaskier').validateNoteFilename('tola/brain/x.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) {
        t.is(decision.code, MEMORY_V3_ERROR_CODES.CROSS_AGENT_ACCESS_DENIED);
        t.not(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH, 'cross-agent ma WŁASNY, rozróżnialny kod błędu');
    }
});

test('validateNoteFilename: TEN SAM kształt "jaskier/brain/x.md" ale WŁASNY agent -> invalid_path, nie cross_agent (dowód rozróżnienia kodów dla identycznego kształtu wejścia)', t => {
    // Ten sam wzór (segment[1]==='brain', 3 segmenty) co test wyżej, różni się TYLKO właścicielem
    // pierwszego segmentu. `segments[0] !== this.safeName` jest false (bo to WŁASNY agent), więc
    // gałąź cross-agent nie strzela - kod spada do generycznej odmowy wielosegmentowej.
    const decision = guardFor('Jaskier').validateNoteFilename('jaskier/brain/x.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) {
        t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
        t.not(decision.code, MEMORY_V3_ERROR_CODES.CROSS_AGENT_ACCESS_DENIED);
    }
});

// ─── warunek 6b: wielosegmentowa ścieżka - kształt zwykły (2 segmenty, nie brain/) ───────────

test('validateNoteFilename: wielosegmentowa zwykła "folder/x.md" -> invalid_path (memory_read accepts a filename, not a path)', t => {
    const decision = guardFor().validateNoteFilename('folder/x.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

// ─── warunek 7: kształt nazwy pliku (regex :107-109) — JEDYNA gałąź bez ŻADNEJ asercji w repo ─

test('validateNoteFilename: brak rozszerzenia .md ("note.txt") -> invalid_path (regex kształtu, bez pokrycia gdzie indziej w repo)', t => {
    const decision = guardFor().validateNoteFilename('note.txt', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: spacja w nazwie ("my note.md") -> invalid_path (regex kształtu)', t => {
    const decision = guardFor().validateNoteFilename('my note.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: dwukropek w nazwie ("note:1.md") -> invalid_path (regex kształtu, poza klasą [a-zA-Z0-9._-])', t => {
    const decision = guardFor().validateNoteFilename('note:1.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: nazwa zaczyna się od kropki (".hidden.md") -> invalid_path (pierwszy znak musi być [a-zA-Z0-9])', t => {
    const decision = guardFor().validateNoteFilename('.hidden.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: nazwa zaczyna się od myślnika ("-note.md") -> invalid_path (pierwszy znak musi być [a-zA-Z0-9])', t => {
    const decision = guardFor().validateNoteFilename('-note.md', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});

test('validateNoteFilename: jednosegmentowa nazwa folderu bez .md ("archive") -> invalid_path (dokładnie scenariusz z audytu: read(scope:memory) nie ma prawa przyjąć nazwy podfolderu jako pliku)', t => {
    const decision = guardFor().validateNoteFilename('archive', BASE_PATH);

    t.false(decision.ok);
    if (!decision.ok) t.is(decision.code, MEMORY_V3_ERROR_CODES.INVALID_PATH);
});
