/**
 * chat_streaming.limits — strażnik OKABLOWANIA tury czatu: sufit wyniku suba (runda 2) ORAZ
 * zatrzask Stopu wchodzący do pętli (AUD-testy-026).
 *
 * Dlaczego test po ŹRÓDLE, a nie po zachowaniu: `chat_streaming.ts` wisi na `obsidian`
 * (import runtime'u wtyczki), więc AVA nie zaimportuje tego modułu — to samo ograniczenie,
 * które opisuje komentarz w pliku produkcyjnym. Konwencja repo na taki przypadek już istnieje:
 * `modules/prompts/PromptBuilder.cache.test.ts` czyta własne źródło przez `fs.readFileSync`
 * i asertuje na treści. Ten plik idzie dokładnie tym wzorem.
 *
 * Czego pilnuje (runda 2, 2026-08-17): wynik sub-agenta jest DELIVERABLE, nie zrzutem
 * narzędzia — `delegate` i `agent_delegate` dostają w pętli głównej własny sufit
 * `subagent_result_max_chars` (60k) zamiast wspólnego `max_tool_result_length` (15k).
 * Mechanizm per-tool w samej pętli ma test behawioralny (`AgentLoop.test.ts`, „runda 2:
 * maxToolResultLengthPerTool"); NIEPILNOWANE było dotąd samo okablowanie — trzy linie,
 * których skasowanie cofa naprawę bez ani jednego czerwonego testu.
 *
 * Audyt nocny 2026-08-19 (moduł 9), po werdykcie Kuby z 2026-08-18: „strażnik na drugą
 * drogę powrotu wyniku suba — TAK".
 */
import test from 'ava';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./chat_streaming.ts', import.meta.url), 'utf8');

/** Blok `limits: { ... }` przekazywany do `runAgentLoop` w turze czatu. */
function blokLimitowPetliGlownej(): string {
    const od = source.indexOf('result = await runAgentLoop({');
    if (od < 0) return '';
    const start = source.indexOf('limits: {', od);
    if (start < 0) return '';
    // Domknięcie bloku: pierwsze `},` na tym samym wcięciu co `limits: {`.
    const wciecie = ' '.repeat(source.slice(0, start).length - source.lastIndexOf('\n', start) - 1);
    const koniec = source.indexOf(`\n${wciecie}},`, start);
    return koniec < 0 ? source.slice(start) : source.slice(start, koniec);
}

/** CAŁE wywołanie `runAgentLoop({ … })` w turze czatu — od `result = await` do `});`. */
function blokWywolaniaPetliGlownej(): string {
    const od = source.indexOf('result = await runAgentLoop({');
    if (od < 0) return '';
    const wciecie = ' '.repeat(od - source.lastIndexOf('\n', od) - 1);
    const koniec = source.indexOf(`\n${wciecie}});`, od);
    return koniec < 0 ? source.slice(od) : source.slice(od, koniec);
}

/** Ciało `send_message` — bez komentarzy (strażnik pilnuje wywołań, nie opisów historii). */
function cialoSendMessage(): string {
    const head = /export (?:async )?function send_message\(/.exec(source);
    if (!head) return '';
    const rest = source.slice(head.index + head[0].length);
    const to = rest.indexOf('\nexport ');
    return (to < 0 ? rest : rest.slice(0, to))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Budowa watchdoga ciszy streamu tury: `const stallTimeoutMs = …` aż do domknięcia
 * `new StreamWatchdog({ … })`. Osobny przewód od `limits: { … }` przekazywanego do
 * `runAgentLoop` — `chat_stream_stall_timeout_ms` zasila tu WŁASNY mechanizm
 * (`StreamWatchdog` w `send_message`), nie pętlę agenta.
 */
function blokWatchdoguStreamu(): string {
    const start = source.indexOf('const stallTimeoutMs =');
    if (start < 0) return '';
    const nowyWatchdog = source.indexOf('turn.watchdog = new StreamWatchdog({', start);
    if (nowyWatchdog < 0) return source.slice(start);
    const koniec = source.indexOf('});', nowyWatchdog);
    return koniec < 0 ? source.slice(start) : source.slice(start, koniec + 3);
}

test('runda 2: pętla główna dostaje per-tool sufit wyniku suba (delegate + agent_delegate)', t => {
    const limity = blokLimitowPetliGlownej();
    t.not(limity, '', 'Nie znaleziono bloku `limits` przy `runAgentLoop` — zmienił się kształt tury czatu.');

    t.true(
        limity.includes('maxToolResultLengthPerTool'),
        'Okablowanie per-tool zniknęło z tury czatu: wynik suba wraca znowu pod wspólny sufit 15k (regres rundy 2 z 2026-08-17).',
    );
    for (const narzedzie of ['delegate', 'agent_delegate']) {
        t.regex(
            limity,
            // AUD-testy-045: `\b` przed nazwą jest OBOWIĄZKOWE. Bez niej wzorzec dla `delegate`
            // dopasowywał się WEWNĄTRZ linii `agent_delegate: …` (między `_` a `d` nie ma granicy
            // słowa), więc skasowanie CAŁEGO osobnego wpisu `delegate:` nie dawało czerwieni —
            // jedna z dwóch pilnowanych linii była niepilnowana.
            new RegExp(`\\b${narzedzie}:\\s*getLimits\\(this\\.env\\?\\.settings\\)\\.subagent_result_max_chars`),
            `Narzędzie \`${narzedzie}\` nie jest podpięte do \`subagent_result_max_chars\` — deliverable suba trafia pod cudzy sufit.`,
        );
    }
});

// ── AUD-testy-026: ZATRZASK STOPU dociera do pętli ──────────────────────────
//
// `chat_streaming.ts:~579` (`shouldAbort: () => turnAbort.isAborted()`) to JEDYNY przewód,
// którym Stop (K5) wchodzi z czatu do `runAgentLoop`. Sam zatrzask ma testy (`turnAbort.test.ts`),
// pętla ma testy (`AgentLoop.abort.test.ts`), scenariusz harnessa `44_stop_zatrzask` podaje
// `shouldAbort` WŁASNY (harness nie stawia ChatView) — ale ten jeden przewód nie miał ŻADNEJ
// asercji: podmiana na `() => false` zostawiała 259/259 na zielono, a userowi guzik Stop,
// który po kliknięciu nie zatrzymuje ani kolejnych iteracji, ani wykonania narzędzi.

test('AUD-testy-026: pętla czatu dostaje zatrzask Stopu (shouldAbort z turnAbort)', t => {
    const wywolanie = blokWywolaniaPetliGlownej();
    t.not(wywolanie, '', 'Nie znalazłem wywołania `runAgentLoop` w turze czatu — zmienił się kształt tury.');

    t.regex(wywolanie, /\bshouldAbort\s*:/,
        'Pętla czatu przestała dostawać `shouldAbort` — po Stopie leci dalej: kolejne iteracje, kolejne narzędzia, finalizacja tury do pliku sesji.');
    // Kształt, nie sam napis: predykat MUSI pytać zatrzask tej tury. `() => false`,
    // `() => turnAbort.isAborted() && false` czy stała — każde z nich ma dać czerwony test.
    t.regex(wywolanie, /\bshouldAbort:\s*\(\)\s*=>\s*turnAbort\.isAborted\(\)\s*,/,
        'Zatrzask Stopu musi wchodzić do pętli DOKŁADNIE jako `() => turnAbort.isAborted()` — inny kształt to albo martwy przewód, albo cudzy stan.');
});

test('AUD-testy-026: `turnAbort` to uchwyt TEJ tury, sięgalny dla Stopu i zamknięcia widoku', t => {
    const body = cialoSendMessage();
    t.not(body, '', 'nie znalazłem send_message');

    // Ten sam obiekt (nie kopia) musi leżeć w trzech miejscach, inaczej `shouldAbort` pyta
    // zatrzask, którego guzik Stop nie ma jak podnieść.
    t.regex(body, /const turnAbort = createTurnAbort\(\);/,
        'tura przestała zakładać własny zatrzask (K5: przerwanie jest stanem TURY, nie pola widoku)');
    t.regex(body, /this\._preparingTurns\.set\([^)]*,\s*turnAbort\)/,
        'Stop kliknięty w oknie przygotowania tury (prompt się buduje) trafiałby w próżnię');
    t.regex(body, /this\._streamCtxMap\.set\([\s\S]{0,400}?\babort:\s*turnAbort,/,
        '`stop_generation(agentName)` i zamknięcie widoku sięgają po zatrzask przez wpis `_streamCtxMap`');
    // Pas zapasowy tej samej naprawy: chunki przerwanej tury nic nie malują.
    t.regex(body, /callbacks:\s*\{\s*chunk:\s*\([^)]*\)\s*=>\s*\{\s*if\s*\(turnAbort\.isAborted\(\)\)\s*return;/,
        'bramka chunków przerwanej tury zniknęła — po Stopie okno dalej maluje tokeny');
});

test('runda 2: sufit deliverable NIE jest podmieniony na wspólny max_tool_result_length', t => {
    const limity = blokLimitowPetliGlownej();
    const perTool = /maxToolResultLengthPerTool:\s*\{([\s\S]*?)\}/.exec(limity)?.[1] || '';

    t.not(perTool, '', 'Brak mapy per-tool do sprawdzenia.');
    t.false(
        perTool.includes('max_tool_result_length'),
        'Ktoś podmienił sufit deliverable na wspólny `max_tool_result_length` — mapa per-tool zostaje, ale naprawa rundy 2 znika po cichu.',
    );
});

// ── AUD-testy-003 / AUD-testy-031: reszta okablowania bloku `limits` ────────
//
// Znalezisko audytu testów 2026-09-01: blok `limits: { … }` przekazywany do `runAgentLoop`
// ma PIĘĆ linii okablowania (`maxIterations`, `maxToolResultLength`, `maxToolResultLengthPerTool`,
// `perCallTimeoutMs` w tym pliku + `stallTimeoutMs` osobno, przy budowie watchdoga streamu) —
// strażnik wyżej pilnował TYLKO jednej (`maxToolResultLengthPerTool`, runda 2). Reprodukcja
// audytu: podmiana `maxIterations: 9999,` i `perCallTimeoutMs: 0,` zostawiała 259/259 modułu
// chat zielonych — backstop iteracji (E1.5) i pas ostateczny per-wywołanie (friendly fire
// 2026-08-15) mogły zniknąć bez ani jednego czerwonego testu.

test('AUD-testy-003: pętla główna dostaje backstop iteracji czatu (chat_max_iterations)', t => {
    const limity = blokLimitowPetliGlownej();
    t.not(limity, '', 'Nie znaleziono bloku `limits` przy `runAgentLoop` — zmienił się kształt tury czatu.');

    t.regex(
        limity,
        /\bmaxIterations:\s*getLimits\(this\.env\?\.settings\)\.chat_max_iterations,/,
        'Twardy backstop iteracji (E1.5) zniknął z okablowania pętli głównej — czat albo przestał słuchać Settings→Limity, albo stracił granicę rund tool-callingu.',
    );
});

test('AUD-testy-003: pętla główna dostaje wspólny sufit wyniku narzędzia (max_tool_result_length)', t => {
    const limity = blokLimitowPetliGlownej();

    t.regex(
        limity,
        /\bmaxToolResultLength:\s*getLimits\(this\.env\?\.settings\)\.max_tool_result_length,/,
        'Wspólny sufit obcinania wyniku narzędzia zniknął z okablowania pętli głównej.',
    );
});

test('AUD-testy-003/031: pętla główna dostaje budzik per-wywołanie modelu (friendly fire 2026-08-15)', t => {
    const limity = blokLimitowPetliGlownej();

    t.regex(
        limity,
        /\bperCallTimeoutMs:\s*getLimits\(this\.env\?\.settings\)\.chat_model_call_timeout_ms,/,
        'Pas ostateczny per wywołanie modelu (`chat_model_call_timeout_ms`) zniknął z okablowania — promisa ubita z zewnątrz (xhr.abort bez zdarzenia) znów wiesza turę na zawsze.',
    );
});

test('AUD-testy-003: watchdog ciszy streamu czatu dostaje chat_stream_stall_timeout_ms', t => {
    const blok = blokWatchdoguStreamu();
    t.not(blok, '', 'Nie znalazłem budowy watchdoga ciszy streamu (`const stallTimeoutMs` → `new StreamWatchdog`) — zmienił się kształt tury.');

    t.regex(
        blok,
        /\bgetLimits\(this\.env\?\.settings\)\.chat_stream_stall_timeout_ms\b/,
        'Watchdog ciszy streamu czatu przestał czytać `chat_stream_stall_timeout_ms` z Settings→Limity — platforma inna niż xai dostaje sztywną wartość zamiast usera.',
    );
    t.regex(
        blok,
        /\btimeoutMs:\s*stallTimeoutMs,/,
        'Wyliczony `stallTimeoutMs` przestał trafiać do `new StreamWatchdog({...})` — watchdog ciszy przestaje reagować na limit z ustawień (uzbraja się, ale z martwym/domyślnym czasem).',
    );
});
