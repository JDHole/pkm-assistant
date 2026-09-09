/**
 * vaultFs — pomocniki systemu plików na DataAdapterze (konsolidacja duplikatów).
 *
 * Wariant „adapterowy mkdir -p" żył w trzech kopiach: `modules/tools/vault_adapter_io.js`
 * (pętlowa, wzór tej implementacji), `modules/memory/MigrationV3.js` (rekurencyjna) oraz
 * domknięcie w `modules/crystal-soul/SettingsContent.js`. Tu jest JEDNA.
 *
 * Plik jest CZYSTY — zero importów (wzorem `core/utils/env_utils.js`) i duck-typuje adapter
 * (`{exists, mkdir}`), żeby konsumenci (tools / memory) dawali się testować w AVA bez
 * obsidiana i bez obsidianowego barrela `core/index.js`.
 */

/**
 * Minimalny kształt DataAdaptera, jakiego potrzebuje ten helper. Obie metody OPCJONALNE,
 * bo duck-typing jest tu częścią kontraktu: brak którejkolwiek = no-op (patrz niżej).
 */
export interface FolderCapableAdapter {
    exists?: (path: string) => unknown;
    mkdir?: (path: string) => unknown;
}

/**
 * Tworzy folder wraz z brakującymi rodzicami (`mkdir -p`) przez DataAdapter Obsidiana.
 *
 * Adapter jest duck-typowany: wystarczy `{exists(path), mkdir(path)}`. Brak którejkolwiek
 * z metod = ciche `return` (no-op) — wołacze UI nie muszą osłaniać się własnym guardem.
 * Istniejący segment ścieżki jest pomijany, więc powtórne wywołanie jest bezpieczne.
 *
 * ⚠️ Ścieżki są vault-relative. To NIE jest mostek do całego dysku i NIE zastępuje
 * walidacji (`sanitizePath` / `validateVaultPath`) — te robi wołacz PRZED tym helperem.
 *
 * @param adapter - DataAdapter (`app.vault.adapter`).
 * @param folderPath - Ścieżka folderu względem roota vaulta. Puste = no-op.
 */
export async function ensureAdapterFolder(
    adapter: FolderCapableAdapter | null | undefined,
    folderPath: string | null | undefined,
): Promise<void> {
    if (typeof adapter?.exists !== 'function' || typeof adapter?.mkdir !== 'function') return;
    const parts = String(folderPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!(await adapter.exists(current))) {
            await adapter.mkdir(current);
        }
    }
}

/** Trzy stany odpowiedzi na pytanie „czy ten plik jest?". `unknown` = sprawdzenie zawiodło. */
export type FileProbe = 'exists' | 'missing' | 'unknown';

/** Adapter w zakresie potrzebnym `probeFile`: `exists` do pytania, `read` do POTWIERDZENIA „nie ma". */
export interface ProbeCapableAdapter {
    exists?: (path: string) => unknown;
    read?: (path: string) => unknown;
}

/**
 * Czy plik istnieje — w TRZECH stanach, nie dwóch.
 *
 * DLACZEGO: `adapter.exists()` KŁAMIE na dyskach sieciowych i na Dysku Google (core/CLAUDE.md
 * gotcha 6b, „PANCERZ" w `load_settings`). Gołe `boolean` zmusza wołacza do wybrania jednej z dwóch odpowiedzi,
 * a jedna fałszywa `false` wystarczyła, żeby nadpisać brain.md / plik sesji / `.state.json`
 * domyślną treścią. „Nie wiem" musi dać się odróżnić od „nie ma".
 *
 * Kontrakt:
 *  - `exists()` rzuca → `'unknown'` (samo sprawdzenie padło),
 *  - `exists()` = true → `'exists'`,
 *  - `exists()` = false → POTWIERDZAMY odczytem: `read` rzuca → `'missing'` (dwa niezależne
 *    sygnały zgodne), `read` się udaje → `'unknown'` (sprzeczność: pliku „nie ma", a treść jest).
 *
 * ⚠️ Kosztuje jeden nieudany `read` na KAŻDE „nie ma", więc wołaj to na ścieżkach ZAPISU
 * (tam, gdzie od wyniku zależy nadpisanie), a nie w pętlach listujących.
 *
 * @param adapter - DataAdapter (`app.vault.adapter`); duck-typowany.
 * @param path - ścieżka vault-relative.
 */
export async function probeFile(
    adapter: ProbeCapableAdapter | null | undefined,
    path: string,
): Promise<FileProbe> {
    if (typeof adapter?.exists !== 'function') return 'unknown';
    let seen: boolean;
    try {
        seen = !!(await adapter.exists(path));
    } catch {
        return 'unknown';
    }
    if (seen) return 'exists';
    // Adapter bez `read` nie ma czym potwierdzić — zostaje przy słowie `exists()`.
    if (typeof adapter.read !== 'function') return 'missing';
    try {
        await adapter.read(path);
    } catch {
        return 'missing';
    }
    return 'unknown';
}

/**
 * Wynik `readIfExists` — jak `FileProbe`, ale trzeci stan niesie od razu przeczytaną TREŚĆ
 * (self-append i tak ją czyta, więc nie ma sensu pytać dwa razy).
 *  - `'content'` — plik dał się przeczytać JAKO STRING. Pusty string `''` JEST legalną treścią.
 *  - `'missing'` — POTWIERDZONE „nie ma" (przez `probeFile`) — wolno pisać od zera.
 *  - `'unreadable'` — sygnały SPRZECZNE (plik wygląda na obecny, ale się nie czyta) —
 *    fail-closed, wołacz NIE MA prawa nadpisać.
 *
 * `cause` (na `'missing'` i `'unreadable'`, opcjonalny) — błąd, który realnie padł przy próbie
 * odczytu (albo opisowy `Error` ze strażnika typu, patrz niżej), żeby wołacz miał czym
 * zdiagnozować incydent zamiast suchego „nie mogę odczytać X". Brak `cause` (adapter bez
 * `read` w ogóle) znaczy „nawet nie próbowaliśmy" — nie myl z „próba padła bez śladu".
 */
export type ReadIfExistsResult =
    | { state: 'content'; content: string }
    | { state: 'missing'; content: null; cause?: unknown }
    | { state: 'unreadable'; content: null; cause?: unknown };

/**
 * Odczyt WŁASNEGO, znanego pliku przed dopisaniem do niego — bramka „self-append"
 * (siostrzana wada `probeFile`).
 *
 * WZORZEC, KTÓRY TO ZASTĘPUJE: `if (await adapter.exists(path)) { existing =
 * await adapter.read(path); }` tuż przed dopisaniem nowego wpisu do własnego loga/pliku
 * (sesja, kronika, archiwum). Na Dysku Google `exists()` potrafi zwrócić `false` DLA PLIKU,
 * KTÓRY JEST — kod nigdy nie próbuje `read()`, traktuje plik jako
 * świeży, i zapis NADPISUJE całą dotychczasową treść jednym nowym wpisem.
 *
 * CZYM RÓŻNI SIĘ OD `probeFile`: tamten odpowiada na pytanie „czy TA ścieżka jest zajęta" dla
 * wołacza, który dobiera WOLNĄ NAZWĘ z kilku kandydatów (pętle sufiksów `_2`, `_3`...) — treść
 * pliku go nie interesuje, tylko fakt istnienia. Tu wołacz zna JEDNĄ, WŁASNĄ ścieżkę (swój log,
 * swoją aktywną sesję, swoje `brain_archive.md`) i chce jej TREŚĆ, żeby dopisać do niej nowy
 * wpis — pytanie o istnienie jest tu tylko środkiem do celu.
 *
 * DLACZEGO READ-FIRST: na szczęśliwej ścieżce self-append (plik JUŻ ISTNIEJE — to normalny
 * stan, bo dopisujemy do WŁASNEGO, wcześniej założonego pliku) to JEDNO wywołanie (`read`),
 * nie dwa (`exists` + `read`) jak w starym wzorcu. `exists()` nie ma szans skłamać, bo w ogóle
 * nie pytamy go jako pierwszego — próbujemy przeczytać, i dopiero gdy TO zawiedzie, pytamy
 * `probeFile` o werdykt „nie ma" kontra „coś jest nie tak".
 *
 * Kontrakt:
 *  - `read()` się udaje I zwraca STRING → `{state:'content', content}`, NIEZALEŻNIE od tego,
 *    co powiedziałby `exists()`. Pusty string `''` JEST legalną treścią (`'content'`, nie
 *    `'missing'`).
 *  - `read()` się udaje, ale zwraca coś INNEGO niż string (adapter fail-open — np. połamany
 *    mock albo `DataAdapter`, który przy błędzie resolvuje `undefined` zamiast rzucić) →
 *    **strażnik typu** traktuje to jak błąd odczytu, NIE jak sukces. Cichy fallback (np. na
 *    `''`) wyglądałby jak legalna pusta treść, a self-append dopisałby nowy wpis do dosłownego
 *    `"undefined"` w pliku. `cause` dostaje wtedy opisowy `Error` własnej roboty.
 *  - `read()` rzuca (albo strażnik typu wyżej się uruchomił) → pytamy `probeFile(adapter, path)`:
 *    - `'missing'` (oba niezależne sygnały zgodne: `exists()` mówi „nie ma", a potwierdzający
 *      `read()` też rzucił) → `{state:'missing', content:null, cause}` — wolno pisać od zera,
 *    - cokolwiek innego (`'exists'` — sprzeczność: nasz `read()` padł, a `exists()` twierdzi,
 *      że plik JEST; `'unknown'` — nawet `exists()` nie umiał odpowiedzieć) →
 *      `{state:'unreadable', content:null, cause}` — sygnały SPRZECZNE, wołacz NIE MA prawa
 *      nadpisać. `cause` niesie błąd z NASZEJ próby `read()` (nie z wewnętrznej próby
 *      `probeFile` — ten helper zwraca tylko etykietę, nie błąd).
 *
 * Kiedy używać: self-append do WŁASNEGO, znanego pliku (log, aktywna sesja, kronika audytu).
 * NIE do wyboru wolnej nazwy z kilku kandydatów — od tego jest `probeFile`.
 *
 * @param adapter - DataAdapter (`app.vault.adapter`); duck-typowany jak `probeFile`.
 * @param path - ścieżka vault-relative WŁASNEGO pliku.
 */
export async function readIfExists(
    adapter: ProbeCapableAdapter | null | undefined,
    path: string,
): Promise<ReadIfExistsResult> {
    let cause: unknown;
    if (typeof adapter?.read === 'function') {
        try {
            const content = await adapter.read(path);
            if (typeof content === 'string') {
                return { state: 'content', content };
            }
            // Fail-open: adapter NIE rzucił, ale oddał coś innego niż string. Traktujemy to
            // jak błąd odczytu (patrz kontrakt wyżej) — `cause` dostaje własny, opisowy Error,
            // bo tu nie ma cudzego wyjątku do przekazania dalej.
            cause = new Error(`readIfExists: adapter.read(${path}) zwrócił ${typeof content} zamiast string`);
        } catch (e) {
            // Read padł — może kłamie exists(), może pliku naprawdę nie ma. Pytamy dalej.
            cause = e;
        }
    }
    const probe = await probeFile(adapter, path);
    if (probe === 'missing') return { state: 'missing', content: null, cause };
    return { state: 'unreadable', content: null, cause };
}
