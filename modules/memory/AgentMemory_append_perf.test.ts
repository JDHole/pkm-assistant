import test from 'ava';
import { AgentMemory, APPEND_VERIFY_EVERY_N } from './AgentMemory.js';
import type { MemoryVaultAdapterLike } from './AgentMemory.js';
import { formatSessionEvent, maxSeq } from './activeSessionFormat.js';
import { maskSensitiveData } from '../../core/index.js';

/**
 * AUD-wydajnosc-094 + AUD-wydajnosc-095 (fabryka W4, 2026-09-02).
 *
 * 094: `appendToActiveSession` czytała CAŁY plik sesji i przepisywała go w całości na KAŻDE
 * zdarzenie tury (200 zdarzeń = 110 MB zapisu na plik 1,1 MB — kwadratowy koszt względem
 * długości sesji). Naprawa: `adapter.append` (dopisanie ogona), pełny odczyt tylko RAZ na
 * ścieżkę (inicjalizacja cache numeracji `_nextSeq` + stanu „kończy się \n").
 *
 * 095: `ensureMemoryStructure()` (11× exists + list + 2× read) leciała bezwarunkowo na KAŻDE
 * zdarzenie przez `startActiveSession`. Naprawa: flaga „struktura sprawdzona" (memoizacja per
 * instancja) + `startActiveSession` ufa żywemu `activeSessionPath` bez ponownego sprawdzania.
 *
 * Review opusa (2026-09-02, ten sam dzień) — P1 BLOKER + P2 + P4:
 *  - P1: „ufam ścieżce" poprawione na „ufam ŻYWEMU CACHE dla tej ścieżki" — `activeSessionPath`
 *    bywa wskrzeszony z zewnątrz (chat_tabs.ts/chat_session.ts) po archiwizacji; zimny cache =
 *    jeden tani `probeFile`, potwierdzone „nie ma" = nowa sesja zamiast wywrócenia tury.
 *  - P2: ciepły cache dostaje periodyczny `exists()` co `APPEND_VERIFY_EVERY_N` zdarzeń (metadane,
 *    nie pełny odczyt) — łapie zewnętrzne skasowanie pliku między zdarzeniami, żeby `append`
 *    nie odtworzył pliku BEZ frontmattera.
 *  - P4: `writeBrainNote` resetuje `_structureEnsured` i próbuje raz jeszcze po pierwszym padzie
 *    zapisu (samonaprawa struktury skasowanej w trakcie sesji) — patrz `AgentMemory.test.ts`.
 * Te testy zostały zaktualizowane, żeby odzwierciedlić NOWE, zamierzone koszty (periodyczny
 * `exists`), i doszły dwa nowe scenariusze P1/P2 (wisząca ścieżka po archiwizacji, skasowanie
 * między zdarzeniami) + dwa golden na brzegach (plik bez `\n`, plik pusty).
 *
 * Testy tu NIE dublują `AgentMemory.test.ts` (kształt plików, migracje, itp.) — mierzą
 * WYŁĄCZNIE liczbę operacji adaptera i bajtową równoważność ze starym algorytmem.
 */

interface AdapterCounts {
    exists: number;
    read: number;
    write: number;
    append: number;
    list: number;
    mkdir: number;
}

function parentFoldersFor(path: string): string[] {
    const parts = path.split('/');
    const result: string[] = [];
    for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join('/'));
    return result;
}

/**
 * Atrapa adaptera licząca wywołania. `withAppend: true` daje natywny `adapter.append` (droga
 * główna — jak prawdziwy Obsidian DataAdapter); `false` wymusza fallback read+write w
 * `_appendSessionFile` (adapter bez metody `append`).
 *
 * `appendThrowsOnMissing` (review opusa P2): część implementacji `append` WYMAGA istniejącego
 * pliku i rzuca zamiast cicho zakładać go od nowa (w przeciwieństwie do domyślnego zachowania
 * tej atrapy, które naśladuje `fs` z flagą `a`). Obie ścieżki są w produkcji obsłużone inaczej —
 * ta flaga pozwala przetestować obie.
 */
function makeCountingVault(opts: { withAppend: boolean; appendThrowsOnMissing?: boolean }) {
    const files: Record<string, string> = {};
    const folders = new Set<string>();
    const counts: AdapterCounts = { exists: 0, read: 0, write: 0, append: 0, list: 0, mkdir: 0 };

    const adapter: MemoryVaultAdapterLike = {
        async exists(path: string) {
            counts.exists++;
            return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
        },
        async mkdir(path: string) {
            counts.mkdir++;
            folders.add(path);
        },
        async read(path: string) {
            counts.read++;
            if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
            return files[path];
        },
        async write(path: string, content: string) {
            counts.write++;
            for (const folder of parentFoldersFor(path)) folders.add(folder);
            files[path] = content;
        },
        async list(folder: string) {
            counts.list++;
            const prefix = `${folder}/`;
            return {
                files: Object.keys(files).filter(p => p.startsWith(prefix)),
                folders: [...folders].filter(p => p.startsWith(prefix) && p !== folder),
            };
        },
        async stat(path: string) {
            return Object.prototype.hasOwnProperty.call(files, path) ? { mtime: 1, size: files[path].length } : null;
        },
        async remove(path: string) {
            delete files[path];
        },
    };

    if (opts.withAppend) {
        adapter.append = async (path: string, data: string) => {
            counts.append++;
            const exists = Object.prototype.hasOwnProperty.call(files, path);
            if (!exists && opts.appendThrowsOnMissing) {
                throw new Error(`append: target does not exist: ${path}`);
            }
            // Natywny Obsidian DataAdapter.append dokleja do istniejącego pliku; brak pliku ==
            // dokleja od zera (jak fs `a`) — atrapa odzwierciedla to samo (chyba że
            // `appendThrowsOnMissing` wymusza drugi, bardziej rygorystyczny wariant wyżej).
            for (const folder of parentFoldersFor(path)) folders.add(folder);
            files[path] = exists ? files[path] + data : data;
        };
    }

    return { vault: { adapter }, files, folders, counts };
}

/** Kolejne zdarzenia testowe — treść bez znaków wyglądających jak sekrety (test golden nie
 * chce zależności od zachowania `maskSensitiveData` na granicach chunków). */
function makeEvents(n: number, baseTimestamp: string): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_, i) => ({
        type: i % 3 === 0 ? 'user_message' : i % 3 === 1 ? 'agent_message' : 'tool_result',
        content: `treść zdarzenia numer ${i} — ąćęłńóśźż`,
        ...(i % 3 === 2 ? { tool: 'search' } : {}),
        // Jawny timestamp — obie strony porównania (produkcja + referencja „starego" algorytmu)
        // używają TEGO SAMEGO znacznika czasu, bez zależności od zegara systemowego.
        timestamp: new Date(new Date(baseTimestamp).getTime() + i * 1000).toISOString(),
    }));
}

/**
 * Referencyjna implementacja STAREGO algorytmu (sprzed AUD-wydajnosc-094): pełny odczyt + pełny
 * zapis na każde zdarzenie. Używa TYCH SAMYCH funkcji formatujących co produkcja
 * (`formatSessionEvent`/`maxSeq`), więc test mierzy RÓŻNICĘ w mechanizmie zapisu (append vs
 * read+write), nie różnicę w formacie zdarzenia.
 */
function oldAppendAll(initialContent: string, events: Array<Record<string, unknown>>): string {
    let content = initialContent;
    let seq = maxSeq(content);
    for (const event of events) {
        seq += 1;
        const type = String(event.type || 'event');
        const timestamp = String(event.timestamp);
        const body = formatSessionEvent(type, { ...event, seq }, timestamp);
        content = content.endsWith('\n') ? content + body : `${content}\n${body}`;
        // Stary `_writeSessionFile` maskował CAŁĄ treść na każdym zapisie — na dysku po
        // zapisie N leżała `mask(content)`, a kolejny odczyt widział już zamaskowaną wersję.
        content = maskSensitiveData(content);
    }
    return content;
}

test('AUD-wydajnosc-094: 50 zdarzeń → append zamiast pełnego read+write; koszt odczytu/zapisu jest jednorazowy, nie per-zdarzenie', async t => {
    const { vault, counts } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');

    // Pierwsze zdarzenie płaci JEDNORAZOWY koszt bootstrapu: zapis `brain.md`, `.state.json`
    // (×2 — utworzenie + `addActiveSession`), `.active_session.json` I samego pliku sesji
    // (frontmatter + nagłówek, w `startActiveSession`, PRZED pierwszym appendem) — żaden z nich
    // nie jest „pełnym przepisaniem rosnącego pliku sesji na każde zdarzenie", czyli tym, co
    // naprawia AUD-wydajnosc-094. Test mierzy DELTĘ po tym punkcie, nie zero bezwzględne.
    await memory.appendToActiveSession(makeEvents(1, '2026-09-02T10:00:00.000Z')[0]);
    const afterFirst = { ...counts };

    for (const event of makeEvents(49, '2026-09-02T10:01:00.000Z')) {
        await memory.appendToActiveSession(event);
    }

    t.is(counts.append, 50, `append wołany raz na zdarzenie, było ${counts.append}`);
    // Zero DODATKOWYCH pełnych zapisów po pierwszym zdarzeniu — 49 kolejnych appendów nie
    // przepisuje niczego w całości (przed naprawą: +49 pełnych write, po 200 zdarzeniach 110 MB).
    t.is(counts.write, afterFirst.write, `zero dodatkowych pełnych write po pierwszym zdarzeniu, było +${counts.write - afterFirst.write}`);
    // Odczyty (bootstrap: `probeFile` na `brain.md`/`.state.json`/kolizji nazwy pliku sesji +
    // JEDEN prawdziwy odczyt treści sesji do zainicjowania cache numeracji) są kosztem
    // JEDNORAZOWYM pierwszego zdarzenia — zero DODATKOWYCH odczytów po nim (przed naprawą:
    // +1 pełny odczyt całego pliku sesji NA KAŻDE z pozostałych 49 zdarzeń).
    t.is(counts.read, afterFirst.read, `zero dodatkowych odczytów po pierwszym zdarzeniu, było +${counts.read - afterFirst.read}`);
});

test('AUD-wydajnosc-095: bootstrap (exists/list/mkdir) płaci się raz, nie rośnie z 50 zdarzeniami', async t => {
    const { vault, counts } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');

    await memory.appendToActiveSession({ type: 'user_message', content: 'pierwsze', timestamp: '2026-09-02T10:00:00.000Z' });
    const afterFirst: AdapterCounts = { ...counts };

    // Bootstrap jednorazowy: 11 folderów w pętli `ensureMemoryStructure` + kilka dodatkowych
    // (getBrain/.state.json/kolizja nazwy pliku sesji) — realny sufit, nie „nie licz w ogóle".
    t.true(afterFirst.exists <= 20, `exists po PIERWSZYM zdarzeniu powinien być stały bootstrap, było ${afterFirst.exists}`);

    const remaining = 49;
    for (const event of makeEvents(remaining, '2026-09-02T10:01:00.000Z')) {
        await memory.appendToActiveSession(event);
    }

    // Kolejne 49 zdarzeń (razem 50) NIE dokłada ani jednego list/mkdir/read — cała różnica
    // między naprawą a stanem sprzed niej jest właśnie tu (przed naprawą: 19 operacji × 50 = 950).
    // `exists` ROŚNIE, ale periodycznie, nie per-zdarzeniowo (review opusa P2): co
    // `APPEND_VERIFY_EVERY_N` appendów na ciepłym cache jeden tani `exists()` sprawdza, czy plik
    // wciąż istnieje (zewnętrzne skasowanie między zdarzeniami — patrz gotcha 13/14 w CLAUDE.md).
    const expectedVerifyExistsCalls = Math.floor(remaining / APPEND_VERIFY_EVERY_N);
    t.is(
        counts.exists, afterFirst.exists + expectedVerifyExistsCalls,
        `exists powinien rosnąć TYLKO co ${APPEND_VERIFY_EVERY_N} zdarzeń (P2), nie co zdarzenie — było +${counts.exists - afterFirst.exists}, oczekiwano +${expectedVerifyExistsCalls}`
    );
    t.is(counts.list, afterFirst.list, 'zero dodatkowych list po pierwszym zdarzeniu');
    t.is(counts.mkdir, afterFirst.mkdir, 'zero dodatkowych mkdir po pierwszym zdarzeniu');
    t.is(counts.read, afterFirst.read, 'zero dodatkowych pełnych read po pierwszym zdarzeniu (periodyczna weryfikacja P2 czyta tylko metadane, nie treść)');
});

test('AUD-wydajnosc-095: ensureMemoryStructure() jest memoizowana — druga wołka NIE dotyka adaptera wcale', async t => {
    // Niezależnie od `startActiveSession`: `listArchiveSessions`/`listActiveSessions`/MCP tools
    // (`ListTool`/`MemorySaveTool`/`MemoryDeleteTool`/`ReadTool`) wołają `ensureMemoryStructure()`
    // wprost na WŁASNYM wejściu, nie przez `appendToActiveSession`. Ta memoizacja jest dla nich.
    const { vault, counts } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');

    await memory.ensureMemoryStructure();
    const afterFirst = { ...counts };
    t.true(afterFirst.exists > 0, 'pierwsze wywołanie realnie sprawdza foldery');

    for (let i = 0; i < 10; i++) {
        await memory.ensureMemoryStructure();
    }

    t.is(counts.exists, afterFirst.exists, 'dziesięć kolejnych wywołań ensureMemoryStructure() nie dokłada exists');
    t.is(counts.list, afterFirst.list, 'ani list');
    t.is(counts.read, afterFirst.read, 'ani read');
    t.is(counts.mkdir, afterFirst.mkdir, 'ani mkdir');
});

test('AUD-wydajnosc-095: startActiveSession na ZIMNYM cache płaci jeden tani probeFile, na CIEPŁYM — zero (review opusa P1)', async t => {
    const { vault, counts } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');

    const first = await memory.startActiveSession('Jaskier');
    const afterCreate = { ...counts };

    // Cache ZIMNY (żadnego appendu jeszcze nie było na tej ścieżce — `_sessionSeqCache` pusty):
    // `startActiveSession` NIE MA PRAWA ufać samemu faktowi „pole niepuste" (P1, BLOKER) — płaci
    // JEDEN tani `probeFile` (exists, bez odczytu treści na trafieniu).
    const second = await memory.startActiveSession('Jaskier');
    t.is(second, first, 'ta sama ścieżka, żadnej nowej kolizji do rozstrzygania');
    t.is(counts.exists, afterCreate.exists + 1, 'zimny cache płaci DOKŁADNIE jeden probeFile na powtórne wołanie');
    t.is(counts.read, afterCreate.read, 'probeFile na trafieniu (exists()===true) nie czyta treści');
    const afterSecondCall = { ...counts };

    // Nagrzej cache PRAWDZIWYM appendem (tak jak w produkcji: appendToActiveSession → startActiveSession).
    await memory.appendToActiveSession({ type: 'user_message', content: 'pierwsze', timestamp: '2026-09-02T13:00:00.000Z' });
    const afterWarm = { ...counts };

    // Cache CIEPŁY: kolejne wołania `startActiveSession` (np. z appendToActiveSession na
    // następne zdarzenie) są TERAZ zerokosztowe — dokładnie zysk AUD-wydajnosc-095.
    const third = await memory.startActiveSession('Jaskier');
    t.is(third, first, 'wciąż ta sama ścieżka');
    t.is(counts.exists, afterWarm.exists, 'ciepły cache: zero dodatkowych exists na powtórne wołanie');
    t.is(counts.read, afterWarm.read, 'ciepły cache: zero dodatkowych read');
    t.true(afterSecondCall.exists > afterCreate.exists, 'sanity: zimna ścieżka rzeczywiście zapłaciła (kontrast z ciepłą)');
});

test('AUD-wydajnosc-094: append daje BAJTOWO tę samą treść co stary read+pełny-write dla tej samej sekwencji zdarzeń', async t => {
    const { vault, files } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');

    // Faza 1: załóż plik sesji (frontmatter + nagłówek), bez żadnego zdarzenia jeszcze —
    // to jest punkt zerowy, z którego startują OBA algorytmy (nowy realnie, stary jako referencja).
    const path = await memory.startActiveSession('Jaskier');
    const initialContent = files[path];
    t.truthy(initialContent, 'plik sesji istnieje po startActiveSession');

    const events = makeEvents(50, '2026-09-02T10:00:00.000Z');
    const expected = oldAppendAll(initialContent, events);

    // Faza 2: te same zdarzenia przez PRAWDZIWY `appendToActiveSession` (append, nie read+write).
    for (const event of events) {
        await memory.appendToActiveSession(event);
    }

    t.is(files[path], expected, 'treść pliku po 50 appendach identyczna z referencyjnym read+write');
});

test('AUD-wydajnosc-094: fallback read+write (adapter bez natywnego append) daje tę samą treść', async t => {
    const { vault, files } = makeCountingVault({ withAppend: false });
    const memory = new AgentMemory(vault, 'Jaskier');

    const path = await memory.startActiveSession('Jaskier');
    const initialContent = files[path];

    const events = makeEvents(12, '2026-09-02T11:00:00.000Z');
    const expected = oldAppendAll(initialContent, events);

    for (const event of events) {
        await memory.appendToActiveSession(event);
    }

    t.is(files[path], expected, 'fallback (bez adapter.append) daje tę samą treść co referencja');
});

test('AUD-wydajnosc-094: fallback bez adapter.append NIE nadpisuje pliku, gdy odczyt jest niepewny (K4)', async t => {
    const { vault, files } = makeCountingVault({ withAppend: false });
    const memory = new AgentMemory(vault, 'Jaskier');
    await memory.startActiveSession('Jaskier');

    // Pierwsze zdarzenie normalnie — nagrzewa cache numeracji/„kończy się \n", więc DALSZE
    // appendy nie robią już zewnętrznego odczytu w `appendToActiveSession` (cache hit) i lecą
    // WYŁĄCZNIE przez `_appendSessionFile` — to jej fallback ma tu być pod testem, nie
    // zewnętrzny odczyt cache-miss.
    const path = await memory.appendToActiveSession({ type: 'user_message', content: 'pierwsze', timestamp: '2026-09-02T12:00:00.000Z' });
    const before = files[path];

    // Symuluj sprzeczne sygnały: `exists()` mówi „jest", ale `read()` rzuca — dokładnie klasa
    // błędu K4/gotcha 12, przed którą fallback MUSI się bronić (nie ma prawa cichcem zacząć
    // pliku od zera i skasować dotychczasową rozmowę).
    const adapter = vault.adapter;
    const realRead = adapter.read.bind(adapter);
    adapter.read = async (p: string) => {
        if (p === path) throw new Error('symulowany pad odczytu (Dysk Google)');
        return realRead(p);
    };

    await t.throwsAsync(
        () => memory.appendToActiveSession({ type: 'user_message', content: 'to nie powinno nadpisać', timestamp: '2026-09-02T12:00:01.000Z' }),
        undefined,
        'fallback (adapter bez append) z niepewnym odczytem ma rzucić, nie nadpisać'
    );
    t.is(files[path], before, 'plik sesji NIE został nadpisany mimo padniętego odczytu');
});

// ═══════════════════════ Review opusa (2026-09-02) — P1 BLOKER + P2 ═══════════════════════

test('Review opusa P1 (BLOKER): sesja zarchiwizowana + wskrzeszona z zewnątrz activeSessionPath → append zakłada NOWĄ sesję z frontmatterem, nie ENOENT', async t => {
    const { vault, files } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');

    // 1) Normalna tura: append tworzy i nagrzewa plik #1 (ciepły cache).
    const firstPath = await memory.appendToActiveSession({ type: 'user_message', content: 'pierwsza rozmowa', timestamp: '2026-09-02T09:00:00.000Z' });
    t.truthy(files[firstPath]);

    // 2) `/save_session` z akcją `archive`: `archiveActiveSession` przenosi plik do
    //    `sessions/archive/` (kasuje źródło) i ZERUJE `activeSessionPath` U SIEBIE — jak w produkcji.
    const archivedPath = await memory.archiveActiveSession(firstPath);
    t.truthy(archivedPath);
    t.falsy(files[firstPath], 'oryginalny plik active USUNIĘTY po archiwizacji');
    t.is(memory.activeSessionPath, null, 'archiveActiveSession zerowuje wskaźnik u siebie');

    // 3) BUG odtworzony (opisany w reviewie): przełączenie zakładki tam i z powrotem
    //    (`chat_tabs.ts:126` / `chat_session.ts:237`/`244` — patrz gotcha P3 przy polu
    //    `activeSessionPath` w AgentMemory.ts) PODSTAWIA WPROST starą, teraz martwą ścieżkę —
    //    z pominięciem `startActiveSession`/`saveSession`, bez sprawdzenia czy plik wciąż istnieje.
    memory.activeSessionPath = firstPath;

    // 4) Kolejna wiadomość usera. Na main (i na W4 PRZED tą poprawką) `startActiveSession` ufał
    //    samemu faktowi „pole niepuste" i `appendToActiveSession` leciał `read()`/`append()` na
    //    plik, którego nie ma — tura padała, wiadomość usera ginęła. Tu MA przejść: wykryć
    //    martwą ścieżkę i założyć NOWĄ sesję z frontmatterem, tak jak main robi od zera.
    const newPath = await memory.appendToActiveSession({ type: 'user_message', content: 'wiadomość po wiszącej ścieżce', timestamp: '2026-09-02T09:05:00.000Z' });

    // Uwaga: `newPath` MOŻE wyjść identyczna jak `firstPath` — nazwa ma rozdzielczość minutową
    // (`_generateActiveSessionFilename`), a stara ścieżka zwolniła się dokładnie w tym momencie
    // (archiwizacja ją usunęła), więc `findFreeCollisionPath` legalnie ją odzyskuje. To NIE jest
    // to, co sprawdzamy — sprawdzamy, że plik pod `newPath` jest PRAWDZIWĄ, świeżą sesją.
    t.truthy(files[newPath], 'nowy plik istnieje');
    t.true(files[newPath].startsWith('---\ntype: active_session'), 'nowy plik ma PRAWDZIWY frontmatter, nie goły blok zdarzenia');
    t.true(files[newPath].includes('wiadomość po wiszącej ścieżce'), 'zdarzenie zostało zapisane, nie zgubione');
    t.false(files[newPath].includes('pierwsza rozmowa'), 'nowy plik NIE niesie treści starej, zarchiwizowanej sesji — to naprawdę świeży plik, nie doklejka na niczym');
    t.is(memory.activeSessionPath, newPath, 'wskaźnik wskazuje na nową, żywą sesję');
});

test('Review opusa P2: plik skasowany MIĘDZY zdarzeniami na ciepłym cache — periodyczna weryfikacja odtwarza frontmatter (adapter, który cicho zakłada plik od nowa)', async t => {
    const { vault, files } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');

    const path = await memory.appendToActiveSession({ type: 'user_message', content: 'pierwsze', timestamp: '2026-09-02T14:00:00.000Z' });
    t.truthy(files[path]);

    // Symuluj: ktoś (user w Obsidianie, sync na Dysku Google) skasował plik z dysku MIĘDZY
    // zdarzeniami, mimo że cache tej instancji jest wciąż ciepły. Wymuszamy też, że periodyczna
    // weryfikacja (P2) trafi na TĘ KONKRETNĄ próbę appendu — inaczej ten konkretny adapter
    // (cicho zakłada plik od nowa jak `fs` z flagą `a`) odtworzyłby plik BEZ nagłówka i test nie
    // miałby czego złapać. To jest realne, udokumentowane ograniczenie periodycznej weryfikacji
    // (patrz komentarz przy `APPEND_VERIFY_EVERY_N` w AgentMemory.ts) — okno trafienia jest 1/N,
    // nie każde skasowanie zostanie złapane NATYCHMIAST tą drogą (adapter, który RZUCA na
    // append do brakującego pliku, jest łapany natychmiast — patrz test niżej).
    delete files[path];
    memory._appendsSinceVerify.set(path, APPEND_VERIFY_EVERY_N - 1);

    const newPath = await memory.appendToActiveSession({ type: 'user_message', content: 'drugie, po skasowaniu', timestamp: '2026-09-02T14:00:05.000Z' });

    // Uwaga: `newPath` może wyjść identyczna jak `path` (nazwa ma rozdzielczość minutową i
    // zwolniła się dokładnie w tym momencie) — to legalne i NIE jest przedmiotem testu.
    // Przedmiotem jest: plik pod `newPath` to PRAWDZIWA, świeża sesja z nagłówkiem, nie goły
    // fragment zdarzenia bez `type: active_session` (dokładnie to, co P2 miało zapobiec).
    t.truthy(files[newPath]);
    t.true(files[newPath].startsWith('---\ntype: active_session'), 'odtworzony plik MA frontmatter, nie goły blok zdarzenia');
    t.true(files[newPath].includes('drugie, po skasowaniu'));
});

test('Review opusa P2: adapter.append RZUCA na brakujący plik — natychmiastowe odtworzenie, niezależnie od periodycznej weryfikacji', async t => {
    const { vault, files } = makeCountingVault({ withAppend: true, appendThrowsOnMissing: true });
    const memory = new AgentMemory(vault, 'Jaskier');

    const path = await memory.appendToActiveSession({ type: 'user_message', content: 'pierwsze', timestamp: '2026-09-02T15:00:00.000Z' });
    delete files[path]; // zewnętrzne skasowanie; licznik periodycznej weryfikacji ZOSTAJE daleko od progu

    // BEZ manipulacji `_appendsSinceVerify` — adapter, który rzuca na append do brakującego
    // pliku, jest łapany NATYCHMIAST przez `_appendSessionFile` (`probeFile` potwierdza
    // 'missing'), zanim periodyczna weryfikacja w ogóle miałaby szansę zadziałać.
    const newPath = await memory.appendToActiveSession({ type: 'user_message', content: 'drugie', timestamp: '2026-09-02T15:00:05.000Z' });

    // (Ścieżka może legalnie wyjść identyczna jak `path` — patrz komentarz w teście wyżej.)
    t.true(files[newPath].startsWith('---\ntype: active_session'));
    t.true(files[newPath].includes('drugie'));
});

test('AUD-wydajnosc-094: golden — plik istniejący BEZ końcowego \\n (ręcznie edytowany) daje tę samą treść co stary algorytm', async t => {
    const { vault, files } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');
    const path = '.pkm-assistant/agents/jaskier/memory/sessions/active/jaskier_2026-09-02_16-00.md';
    // Celowo BEZ końcowego \n — jak plik, który user otworzył i zapisał ręcznie w Obsidianie.
    const initialContent = '---\ntype: active_session\nagent: Jaskier\ncreated: 2026-09-02T16:00:00.000Z\n---\n\n# Jaskier session 2026-09-02T16:00:00.000Z';
    files[path] = initialContent;
    memory.activeSessionPath = path;

    const events = makeEvents(8, '2026-09-02T16:01:00.000Z');
    const expected = oldAppendAll(initialContent, events);

    for (const event of events) {
        await memory.appendToActiveSession(event);
    }

    t.is(files[path], expected, 'brak końcowego \\n w istniejącym pliku obsłużony identycznie jak stary algorytm');
});

test('AUD-wydajnosc-094: golden — plik PUSTY (istnieje, zero bajtów) daje tę samą treść co stary algorytm', async t => {
    const { vault, files } = makeCountingVault({ withAppend: true });
    const memory = new AgentMemory(vault, 'Jaskier');
    const path = '.pkm-assistant/agents/jaskier/memory/sessions/active/jaskier_2026-09-02_17-00.md';
    // Plik ISTNIEJE (klucz obecny w `files`), ale pusty — inny stan niż „nie ma pliku"
    // (`readIfExists` musi zwrócić `state:'content'`, content:'', NIE `state:'missing'`).
    files[path] = '';
    memory.activeSessionPath = path;

    const events = makeEvents(5, '2026-09-02T17:01:00.000Z');
    const expected = oldAppendAll('', events);

    for (const event of events) {
        await memory.appendToActiveSession(event);
    }

    t.is(files[path], expected, 'plik pusty na starcie obsłużony identycznie jak stary algorytm');
});
