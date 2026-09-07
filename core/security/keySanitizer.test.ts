import test from 'ava';
import { sanitizePath, isProtectedPath, VAULT_GITIGNORE_ENTRIES } from './keySanitizer.js';

// ── sanitizePath ──

test('sanitizePath: normalna ścieżka', t => {
    t.is(sanitizePath('Projekty/notatka.md'), 'Projekty/notatka.md');
});

test('sanitizePath: backslash → slash', t => {
    t.is(sanitizePath('Projekty\\sub\\plik.md'), 'Projekty/sub/plik.md');
});

test('sanitizePath: podwójne slashe', t => {
    t.is(sanitizePath('Projekty//sub///plik.md'), 'Projekty/sub/plik.md');
});

test('sanitizePath: leading/trailing slashes stripped', t => {
    t.is(sanitizePath('/Projekty/plik.md/'), 'Projekty/plik.md');
});

test('sanitizePath: whitespace trim', t => {
    t.is(sanitizePath('  Projekty/plik.md  '), 'Projekty/plik.md');
});

test('sanitizePath: hidden folder OK (.pkm-assistant)', t => {
    t.is(sanitizePath('.pkm-assistant/agents/jaskier/memory/brain.md'), '.pkm-assistant/agents/jaskier/memory/brain.md');
});

test('sanitizePath: folder..name OK (dots in name)', t => {
    t.is(sanitizePath('folder..name/plik.md'), 'folder..name/plik.md');
});

// ── BLOKOWANE ──

test('sanitizePath: null/undefined/empty → null', t => {
    t.is(sanitizePath(null), null);
    t.is(sanitizePath(undefined), null);
    t.is(sanitizePath(''), null);
    t.is(sanitizePath('   '), null);
});

test('sanitizePath: .. traversal BLOCKED', t => {
    t.is(sanitizePath('foo/../bar'), null);
    t.is(sanitizePath('../etc/passwd'), null);
    t.is(sanitizePath('foo/../../bar'), null);
});

test('sanitizePath: absolute path BLOCKED (Windows)', t => {
    t.is(sanitizePath('C:/Users/data'), null);
    t.is(sanitizePath('D:\\folder\\file'), null);
});

test('sanitizePath: UNC path BLOCKED', t => {
    t.is(sanitizePath('//server/share'), null);
});

test('sanitizePath: null bytes BLOCKED', t => {
    t.is(sanitizePath('foo\0bar'), null);
});

test('sanitizePath: zero-width unicode BLOCKED', t => {
    t.is(sanitizePath('foo\u200Bbar'), null);  // zero-width space
    t.is(sanitizePath('foo\uFEFFbar'), null);  // BOM
});

test('sanitizePath: ZWNJ i ZWJ (pozostale dwa znaki z DANGEROUS_INVISIBLE_CHARS) BLOCKED', t => {
    // Naprawa no-misleading-character-class (2026-08-27): DANGEROUS_INVISIBLE_CHARS przepisany
    // z klasy znakow na alternacje o identycznej semantyce (fuzz-test 50k ciagow, zero
    // rozbieznosci). Te dwa znaki byly na liscie od poczatku, ale nie mialy wlasnego testu —
    // dopisane, zeby przybic zachowanie 1:1 przed i po zmianie zapisu regexu.
    t.is(sanitizePath('foo\u200Cbar'), null);  // zero-width non-joiner
    t.is(sanitizePath('foo\u200Dbar'), null);  // zero-width joiner
});

test('sanitizePath: emoji ZWJ sequence i znak skladajacy nie omijaja blokady', t => {
    // Kontekst naprawy: ESLint (no-misleading-character-class) ostrzegal, bo ZWNJ/ZWJ stojac
    // obok siebie W KLASIE ZNAKOW wygladaja jak zapis jednej zlozonej sekwencji — tak jak
    // w emoji ZWJ (np. rodzina). Zaden z tych ciagow nie jest samym regexem straznika — te
    // testy pilnuja, ze pojedynczy ZWJ w srodku takiej sekwencji nadal jest lapany jak kazdy
    // inny niebezpieczny znak, a surogat-pair emoji (bez ZWJ) i znak skladajacy (NFC) — nie.
    t.is(sanitizePath('Notatki/\u{1F468}\u200D\u{1F469}\u200D\u{1F466}.md'), null); // ZWJ w srodku sekwencji nadal blokuje
    t.is(sanitizePath('Cafe\u0301/plik.md'), 'Café/plik.md'); // e + acute -> NFC, przechodzi
    t.is(sanitizePath('Notatki/\u{1F44D}.md'), 'Notatki/\u{1F44D}.md'); // emoji (surrogate pair) OK
});

test('sanitizePath: non-string BLOCKED', t => {
    t.is(sanitizePath(123), null);
    t.is(sanitizePath({}), null);
});

test('sanitizePath: URL-encoded traversal BLOCKED (%2e%2e)', t => {
    t.is(sanitizePath('%2e%2e/secret'), null);
    t.is(sanitizePath('folder/%2e%2e/etc'), null);
    t.is(sanitizePath('%2e%2e%2f%2e%2e%2fsecret'), null);
});

test('sanitizePath: URL-encoded null byte BLOCKED (%00)', t => {
    t.is(sanitizePath('foo%00bar'), null);
});

test('sanitizePath: Unicode NFC normalization', t => {
    t.is(sanitizePath('Cafe\u0301/notatka.md'), 'Café/notatka.md');
});

test('sanitizePath: single-script Greek/Cyrillic segments OK', t => {
    t.is(sanitizePath('grecja/λόγος.md'), 'grecja/λόγος.md');
    t.is(sanitizePath('rosja/поезерье.md'), 'rosja/поезерье.md');
});

test('sanitizePath: mixed-script homoglyph risk BLOCKED', t => {
    t.is(sanitizePath('Projekty/agent.md'), 'Projekty/agent.md');
    t.is(sanitizePath('Projekty/\u0430gent.md'), null);
    t.is(sanitizePath('Projekty/\u03bfmega.md'), null);
});

test('sanitizePath: Windows reserved filenames BLOCKED', t => {
    t.is(sanitizePath('CON'), null);
    t.is(sanitizePath('folder/prn.txt'), null);
    t.is(sanitizePath('folder/COM1.md'), null);
    t.is(sanitizePath('folder/LPT9'), null);
});

test('sanitizePath: segment length limit BLOCKED', t => {
    t.is(sanitizePath(`${'a'.repeat(256)}.md`), null);
});

test('sanitizePath: total length limit BLOCKED', t => {
    t.is(sanitizePath(`${'a'.repeat(4097)}.md`), null);
});

// ── isProtectedPath ──

test('isProtectedPath: .env protected', t => {
    t.true(isProtectedPath('.env'));
    t.true(isProtectedPath('data.json'));
});

test('isProtectedPath: settings E3.7 (.pkm-assistant) protected', t => {
    t.true(isProtectedPath('.pkm-assistant/settings.json'));
    t.true(isProtectedPath('.pkm-assistant/settings.last-good.json'));
    t.true(isProtectedPath('.pkm-assistant/backups'));
    t.true(isProtectedPath('.pkm-assistant/backups/settings-2026-07-28.json'));
});

test('isProtectedPath: subfolder protected', t => {
    t.true(isProtectedPath('.pkm-assistant/backups/settings-2026-07-28.json'));
    t.true(isProtectedPath('.pkm-assistant/logs/trace.log'));
});

test('isProtectedPath: normal files NOT protected', t => {
    t.false(isProtectedPath('Projekty/notatka.md'));
    t.false(isProtectedPath('.pkm-assistant/agents/test.md'));
});

test('isProtectedPath: null/empty → false', t => {
    t.false(isProtectedPath(null));
    t.false(isProtectedPath(''));
});

// ── K1 (AUD-security-014): forma kanoniczna — segmenty `.` znikają ──

test('K1 sanitizePath: segmenty `.` są wycinane (kanonizacja)', t => {
    t.is(sanitizePath('./.pkm-assistant/./settings.json'), '.pkm-assistant/settings.json');
    t.is(sanitizePath('a/./b'), 'a/b');
    t.is(sanitizePath('./Notes/./a.md'), 'Notes/a.md');
    t.is(sanitizePath('Prywatne/./d.md'), 'Prywatne/d.md');
});

test('K1 sanitizePath: sama kropka / sam separator → null', t => {
    t.is(sanitizePath('.'), null);
    t.is(sanitizePath('./'), null);
    t.is(sanitizePath('/'), null);
    t.is(sanitizePath('././.'), null);
});

test('K1 sanitizePath: pozostałe formy kanoniczne', t => {
    t.is(sanitizePath('%2e%2e/x'), null);
    t.is(sanitizePath('/x'), 'x');
    t.is(sanitizePath('x\\y'), 'x/y');
});

test('K1 sanitizePath: idempotencja dla typowych wariantów zapisu ścieżki', t => {
    // K13 (2026-08-23): idempotencja jest dziś własnością OGÓLNĄ funkcji (wynik liczony do
    // punktu stałego), a nie tylko tej rodziny zapisów. Ten test zostaje jako czytelny
    // spis wariantów, które model realnie produkuje; ogólnej własności pilnuje test niżej.
    const warianty = [
        'Prywatne/d.md',
        '/Prywatne/d.md',
        './Prywatne/./d.md',
        'Prywatne//d.md',
        'Prywatne\\d.md',
        './.pkm-assistant/./settings.json',
        '.pkm-assistant/settings.json',
        'a/./b/c.md',
        'Notes/a.md/',
        '  Notes/a.md  ',
    ];
    for (const p of warianty) {
        const once = sanitizePath(p);
        t.not(once, null, `wariant "${p}" powinien być poprawny`);
        t.is(sanitizePath(once), once, `idempotencja poległa dla "${p}"`);
    }
});

test('K13: sanitizePath jest idempotentna — sanitizePath(sanitizePath(x)) === sanitizePath(x)', t => {
    // Te osiem ciągów to KONTRPRZYKŁADY z K12 (2026-08-23). Wtedy każdy z nich zmieniał się
    // dopiero w DRUGIM przebiegu (`trim()` działał raz na całym ciągu, `decodeURIComponent`
    // robił jeden przebieg), więc bramka — licząca kanonizację drugi raz — oceniała INNY tekst
    // niż ten, który wołacz podmienił w argumentach narzędzia. Od K13 wynik jest liczony do
    // PUNKTU STAŁEGO, więc drugi przebieg nie ma już czego poprawić.
    const dawne_kontrprzyklady = [
        './ A/B.md',
        'x.md%20',
        '.pkm-assistant/x.md%20',
        'a%252e%252e/x.md',
        '%252e%252e/x.md',
        'A/ B.md',
        'A/B.md ',
        'Sekrety/./x.md',
    ];
    for (const p of dawne_kontrprzyklady) {
        const raz = sanitizePath(p);
        // `null` też jest punktem stałym: sanitizePath(null) === null.
        t.is(sanitizePath(raz), raz, `idempotencja poległa dla "${p}"`);
    }
});

test('K13: wartości po ustabilizowaniu — podwójne kodowanie dekoduje się do końca albo odpada', t => {
    // Wiodące `./` znika w pierwszym przebiegu, a odsłonięta spacja — w drugim. Skutek
    // ŚWIADOMY: `'./ A/B.md'` i `' A/B.md'` to dziś ten sam plik `A/B.md`, nie sąsiedni
    // folder o nazwie ze spacją z przodu.
    t.is(sanitizePath('./ A/B.md'), 'A/B.md');
    t.is(sanitizePath(' A/B.md'), 'A/B.md');
    // Podwójnie zakodowany traversal rozwija się do końca i ODPADA (wcześniej przechodził
    // jako niewinnie wyglądający plik `%2e%2e`).
    t.is(sanitizePath('%252e%252e/x.md'), null);
    // Segment `a..` to LEGALNA nazwa pliku, nie wyjście w górę — przechodzi.
    t.is(sanitizePath('a%252e%252e/x.md'), 'a../x.md');
    t.is(sanitizePath('x.md%20'), 'x.md');
});

test('K13: własność — idempotencja na 3000 wygenerowanych ciągach', t => {
    // Generator DETERMINISTYCZNY (LCG, Numerical Recipes) — żadnego `Math.random`, żeby
    // czerwony test dawało się powtórzyć co do ciągu. Alfabet celowo mieszany: znaki
    // sterujące ścieżką (`.`, `/`, `\`), materiał na `%XX` i `%25XX` (`%`, `2`, `e`, `5`, `0`),
    // spacja, znaki spoza ASCII i zero-width.
    const ALFABET = ['a', 'A', '.', '/', '\\', '%', '2', 'e', '5', '0', ' ', 'ł', 'ä', '\u200B', '-', '_'];
    let seed = 20260823;
    const next = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0);
    // ⚠️ Bierzemy STARSZE bity: w LCG mod 2^32 bit nr k ma okres 2^(k+1), więc `next() % 16`
    // chodziłoby w kółko po szesnastu wartościach i próbka nie tknęłaby kontrprzykładów.
    const losuj = (n: number) => (next() >>> 16) % n;

    let poprawnych = 0;
    for (let i = 0; i < 3000; i++) {
        const dlugosc = 1 + losuj(24);
        let s = '';
        for (let j = 0; j < dlugosc; j++) s += ALFABET[losuj(ALFABET.length)];
        const raz = sanitizePath(s);
        t.is(sanitizePath(raz), raz, `idempotencja poległa dla ${JSON.stringify(s)}`);
        if (raz !== null) poprawnych++;
    }
    // Bezpiecznik na sam test: gdyby generator produkował same odrzuty, powyższe pętla
    // sprawdzałaby wyłącznie `null === null`.
    t.true(poprawnych > 100, `za mało poprawnych ścieżek w próbce (${poprawnych}) — test nic nie sprawdza`);
});

// ── K8 (AUD-security-029): logi pluginu i pliki sesji pamięci są chronione ──

test('K8: .pkm-assistant/logs/ jest ścieżką chronioną', t => {
    t.true(isProtectedPath('.pkm-assistant/logs'));
    t.true(isProtectedPath('.pkm-assistant/logs/pkm-assistant.log'));
    t.true(isProtectedPath('.pkm-assistant/logs/pkm-assistant.log.old'));
    t.true(isProtectedPath('.pkm-assistant/logs/trace.log'));
    // Wariant windowsowy (backslashe) — normalizacja w isProtectedPath ma go sprowadzić.
    t.true(isProtectedPath('.pkm-assistant\\logs\\pkm-assistant.log'));
});

test('K8: katalog sesji pamięci agenta jest chroniony (dowolny slug)', t => {
    t.true(isProtectedPath('.pkm-assistant/agents/klara/memory/sessions'));
    t.true(isProtectedPath('.pkm-assistant/agents/klara/memory/sessions/active/2026-08-22.md'));
    t.true(isProtectedPath('.pkm-assistant/agents/Tola/memory/sessions/archive/x.md'));
});

test('K8: reszta .pkm-assistant/agents nadal NIE jest „protected" (bez zmiany zakresu)', t => {
    t.false(isProtectedPath('.pkm-assistant/agents/test.md'));
    t.false(isProtectedPath('.pkm-assistant/agents/klara/memory/brain.md'));
    t.false(isProtectedPath('Projekty/logs/notatka.md'));
});

test('K8: lista wpisów .gitignore obejmuje logi (i settings sprzed K8)', t => {
    t.true(VAULT_GITIGNORE_ENTRIES.includes('.pkm-assistant/logs/'));
    // Regresja: wpisy sprzed K8 zostają.
    for (const legacy of ['.pkm-assistant/settings.json', '.pkm-assistant/settings.last-good.json', '.pkm-assistant/backups/']) {
        t.true(VAULT_GITIGNORE_ENTRIES.includes(legacy), `zgubiony wpis ${legacy}`);
    }
});

test('K12: pliki sesji NIE są w .gitignore — pamięć agentów podróżuje z repo vaulta', t => {
    // Decyzja Kuby 2026-08-23: sesje wracają do gita (synchronizacja między urządzeniami),
    // a ryzyko sekretu w treści błędu zdejmuje maska PRZY ZAPISIE (`AgentMemory`).
    t.false(VAULT_GITIGNORE_ENTRIES.some(e => e.includes('memory/sessions')),
        'wpis sessions/ ma NIE wracać na listę');
    // ...ale narzędzia agenta dalej ich nie widzą — to osobna oś i zostaje bez zmian.
    t.true(isProtectedPath('.pkm-assistant/agents/klara/memory/sessions/active/2026-08-22.md'));
});

// ── K22 (AUD-security-104): gwiazdka nie jest nazwą pliku ──────────────────

test('K22: sanitizePath odrzuca gwiazdkę — cel „wiele plików" nie udaje jednego', t => {
    t.is(sanitizePath('*'), null);
    t.is(sanitizePath('Notes/*.md'), null);
    t.is(sanitizePath('Notes/*'), null);
    t.is(sanitizePath('**'), null);
    // Warianty przez które model mógłby ją przemycić — pętla do punktu stałego je rozpakowuje.
    t.is(sanitizePath('%2A'), null, 'zakodowana gwiazdka też odpada');
    t.is(sanitizePath('./Notes/*.md'), null);
});

test('K22: pozostałe znaki „windowsowo zakazane" ZOSTAJĄ legalne (żadnej regresji dla macOS/Linux)', t => {
    // Świadoma granica: blokujemy WYŁĄCZNIE `*`, bo to jedyny znak o znaczeniu STERUJĄCYM
    // w tym kodzie (glob whitelisty w `AccessGuard._matchesEntry`, wieloznacznik reguł zgody).
    // `?` i `[` `]` żadnego znaczenia nie mają, a w tytułach notatek są pospolite.
    t.is(sanitizePath('Notatki/Czy to działa?.md'), 'Notatki/Czy to działa?.md');
    t.is(sanitizePath('Notatki/Plan [szkic].md'), 'Notatki/Plan [szkic].md');
    t.is(sanitizePath('Notatki/100% bawełny.md'), 'Notatki/100% bawełny.md');
});
