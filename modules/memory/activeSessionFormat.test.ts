import test from 'ava';
import {
    ACTIVE_SESSION_FORMAT_VERSION,
    EVENT_FIELDS,
    escapeActiveText,
    unescapeActiveText,
    escapeEventFieldText,
    unescapeEventFieldLabels,
    formatSessionEvent,
    parseActiveSession,
    maxSeq,
} from './activeSessionFormat.js';
import { formatToMarkdown, parseSessionFile } from './sessionParser.js';

/**
 * TEST KONTRAKTOWY pliku `sessions/active/*.md` (S36 Faza 1, krok 6 z D6 §6).
 *
 * To jest test, którego BRAK pozwolił przeżyć wtopie z hotfiksa `71a4ffe` — trwałej utracie
 * rozmowy usera. Kontrakt: co pisarz A (`formatSessionEvent`) zapisze, czytnik
 * (`parseActiveSession`) musi odzyskać 1:1 — także wtedy, gdy treść wiadomości SAMA wygląda
 * jak nagłówek bloku (`## User`), i także w pliku MIESZANYM (transkrypt + ogon event-logu).
 *
 * Ma być bezlitosny: asercje na treści VERBATIM (`t.is`/`t.deepEqual`), nie na `includes`.
 */

const FRONTMATTER = [
    '---',
    'type: active_session',
    'agent: Jaskier',
    'created: 2026-07-30T10:00:00.000Z',
    '---',
    '',
    '# Jaskier session 2026-07-30T10:00:00.000Z',
    '',
].join('\n');

/** Zdarzenie w zapisie testowym: pola eventu (`EVENT_FIELDS`) + typ + stempel. */
interface TestEvent {
    type: string;
    timestamp?: string;
    /** `null` (jawnie) = symulacja bloku LEGACY, pisanego jeszcze bez numeracji */
    seq?: number | null;
    [field: string]: unknown;
}

/**
 * Składa plik event-logu dokładnie tak, jak robi to `appendToActiveSession`:
 * frontmatter + kolejne bloki doklejane na koniec (z gwarancją `\n` między nimi),
 * każdy z rosnącym `**seq:**` (S36 Faza 2). `seq: null` w evencie = symulacja bloku
 * LEGACY, pisanego jeszcze bez numeracji.
 */
function buildEventLog(
    events: TestEvent[],
    { head = FRONTMATTER, startSeq = 1 }: { head?: string; startSeq?: number } = {},
): string {
    let text = head;
    events.forEach((event, i) => {
        const stamp = event.timestamp || `2026-07-30T10:${String(10 + i).padStart(2, '0')}:00.000Z`;
        const seq = event.seq === null ? undefined : (event.seq ?? startSeq + i);
        const block = formatSessionEvent(event.type, { ...event, seq }, stamp);
        text = text.endsWith('\n') ? text + block : `${text}\n${block}`;
    });
    return text;
}

/** Doklejka ogona event-logu do gotowego pliku (np. do transkryptu z `formatToMarkdown`). */
function appendEvents(existing: string, events: TestEvent[]): string {
    return buildEventLog(events, { head: existing.endsWith('\n') ? existing : `${existing}\n` });
}

// ─── 1. Round-trip event-logu: mieszanka typów zdarzeń, treść udająca nagłówki ───

test('kontrakt: formatSessionEvent × N → parseActiveSession odzyskuje wiadomości 1:1', t => {
    // Treści, które BEZ escapowania po stronie pisarza A rozbijały wiadomość na dwie:
    const userText = 'Pokaż mi format sesji:\n## User\ntreść usera\n## Wyniki\nlista';
    const agentText = 'Zaraz tłumaczę.\n## Wyniki\n- punkt pierwszy\n## User\n(to tylko cytat)';
    const toolResultText = '# Raport\n## Sekcja A\nOK\n## Sekcja B\nteż OK';
    const subPrompt = 'Zbadaj temat';
    const subResult = 'Gotowe.\n## Wnioski\nnic ciekawego';

    const file = buildEventLog([
        { type: 'user_message', content: userText },
        { type: 'agent_message', content: agentText },
        // mcp call, którego narzędzie zwróciło pustkę — blok BEZ pola treści, pomijany
        { type: 'mcp_call', tool: 'write', args: { path: 'x.md' }, result: '' },
        { type: 'tool_result', tool: 'read', result: toolResultText, duration_ms: 12 },
        { type: 'subagent_call', prompt: subPrompt, result: subResult, model: 'deepseek-chat' },
    ]);

    const parsed = parseActiveSession(file);

    t.deepEqual(parsed.messages, [
        { role: 'user', content: userText, seq: 1 },
        { role: 'assistant', content: agentText, seq: 2 },
        // seq 3 to `mcp call` bez treści — numeruje ZDARZENIA, nie wiadomości, więc w
        // widocznych wiadomościach jest dziura. Tak ma być.
        { role: 'tool', content: toolResultText, seq: 4 },
        { role: 'assistant', content: subResult, seq: 5 },
    ], 'role, treści VERBATIM, kolejność i numeracja bez zmian');
    t.is(parsed.metadata.agent, 'Jaskier');
    t.is(parsed.metadata.type, 'active_session');
});

test('kontrakt: `## User` w treści eventu NIE tworzy fałszywej granicy bloku', t => {
    const file = buildEventLog([
        { type: 'agent_message', content: 'Format:\n## User\npytanie\n## Assistant\nodpowiedź' },
        { type: 'user_message', content: 'dzięki' },
    ]);

    // Escape musi być widoczny NA DYSKU — inaczej parser rozbije blok.
    t.true(file.includes('\\## User'), 'pisarz A escapuje `## ` w treści pola');
    t.false(/\n## User\n/.test(file), 'w pliku nie ma nieescapowanego `## User` jako linii');

    const parsed = parseActiveSession(file);
    t.is(parsed.messages.length, 2);
    t.is(parsed.messages[0].content, 'Format:\n## User\npytanie\n## Assistant\nodpowiedź');
    t.is(parsed.messages[1].content, 'dzięki');
});

test('kontrakt: event bez pola treści (mcp call z pustym wynikiem) nie zaśmieca poprzedniej wiadomości', t => {
    const file = buildEventLog([
        { type: 'agent_message', content: 'Odpowiedź agenta' },
        { type: 'mcp_call', tool: 'write', args: { path: 'x.md' } },
        { type: 'user_message', content: 'Dalej' },
    ]);

    t.deepEqual(parseActiveSession(file).messages, [
        { role: 'assistant', content: 'Odpowiedź agenta', seq: 1 },
        { role: 'user', content: 'Dalej', seq: 3 },
    ]);
});

test('kontrakt: event z jawną rolą (`**role:**`) i nieznanym typem trafia do wiadomości', t => {
    const known = buildEventLog([{ type: 'note', content: 'systemowa notka', role: 'system' }]);
    t.deepEqual(parseActiveSession(known).messages, [
        { role: 'system', content: 'systemowa notka', seq: 1 },
    ]);

    const unknown = buildEventLog([{ type: 'note', content: 'bez roli' }]);
    t.deepEqual(parseActiveSession(unknown).messages, [], 'nierozpoznana rola = blok pomijany (jak dotąd)');
});

// ─── 2. Plik MIESZANY: transkrypt (pisarz B) + ogon event-logu (pisarz A) ───

test('kontrakt: plik MIESZANY (transkrypt + ogon eventów) wraca w kolejności pliku', t => {
    const quoted = 'Tak wygląda plik:\n## User\npytanie\n## Assistant\nodpowiedź';
    const transcript = formatToMarkdown(
        [
            { role: 'user', content: 'Pytanie 1' },
            { role: 'assistant', content: quoted },
        ],
        { type: 'active_session', agent: 'Jaskier', created: '2026-07-30T10:00:00.000Z' },
    );
    // Sanity: pisarz B też escapuje — obie połowy pliku używają TEJ SAMEJ pary regexów.
    t.true(transcript.includes('\\## User'));

    const file = appendEvents(transcript, [
        { type: 'user_message', content: 'Pytanie 2\n## Nagłówek w cytacie' },
        { type: 'agent_message', content: 'Odpowiedź 2' },
    ]);

    const parsed = parseActiveSession(file);

    t.deepEqual(parsed.messages, [
        { role: 'user', content: 'Pytanie 1', seq: null },
        { role: 'assistant', content: quoted, seq: null },
        { role: 'user', content: 'Pytanie 2\n## Nagłówek w cytacie', seq: 1 },
        { role: 'assistant', content: 'Odpowiedź 2', seq: 2 },
    ], 'wiadomości transkryptowe nie mają numeru, eventowe mają');
    t.is(parsed.metadata.agent, 'Jaskier');
});

test('kontrakt: nierozpoznany nagłówek w transkrypcie wraca do treści poprzedniej wiadomości', t => {
    const file = [
        '---',
        'agent: Jaskier',
        '---',
        '## Assistant',
        'Wstęp do analizy',
        '## Wyniki',
        'Trzy punkty',
        '## User',
        'Dzięki',
    ].join('\n');

    t.deepEqual(parseActiveSession(file).messages, [
        { role: 'assistant', content: 'Wstęp do analizy\n## Wyniki\nTrzy punkty', seq: null },
        { role: 'user', content: 'Dzięki', seq: null },
    ]);
});

// ─── 3. Wsteczna zgodność: LEGACY event-log bez escapowania ───

test('wsteczna zgodność: legacy event-log (pisany BEZ escapowania) parsuje się jak dotąd', t => {
    // Ręcznie sklejony plik w formacie sprzed S36 — dokładnie to, co leży u usera na dysku.
    const legacy = [
        '---',
        'type: active_session',
        'agent: Jaskier',
        '---',
        '',
        '# Jaskier session',
        '',
        '## 2026-07-29T11:00:00.000Z — user message',
        '',
        '**content:**',
        '',
        'Pytanie bez markdownu',
        '',
        '## 2026-07-29T11:01:00.000Z — agent message',
        '',
        '**content:**',
        '',
        'Odpowiedź bez markdownu',
        '',
        '## 2026-07-29T11:02:00.000Z — tool result',
        '',
        '**tool:**',
        '',
        'read',
        '',
        '**result:**',
        '',
        'zawartość pliku',
        '',
    ].join('\n');

    t.deepEqual(parseActiveSession(legacy).messages, [
        { role: 'user', content: 'Pytanie bez markdownu', seq: null },
        { role: 'assistant', content: 'Odpowiedź bez markdownu', seq: null },
        { role: 'tool', content: 'zawartość pliku', seq: null },
    ], 'unescape na nieescapowanej treści to no-op, brak `**seq:**` = seq null');
});

test('wsteczna zgodność: legacy event z `## ` w treści dalej gubi granicę (nowe pliki już nie)', t => {
    // Ta wtopa jest DZIEDZICZONA i nieodwracalna dla plików sprzed S36: pisarz A nie
    // escapował, więc `## Wyniki` leży w pliku jako prawdziwa linia nagłówka. Czytnik nie
    // ma jak odgadnąć, że to była treść — doklejka (c) ratuje ją do POPRZEDNIEJ wiadomości.
    // Test pilnuje, że tak zostaje (nic nie ginie), a nowe pliki są już escapowane (wyżej).
    const legacy = [
        '## 2026-07-29T11:00:00.000Z — agent message',
        '',
        '**content:**',
        '',
        'Wstęp',
        '## Wyniki',
        'lista',
        '',
    ].join('\n');

    t.deepEqual(parseActiveSession(legacy).messages, [
        { role: 'assistant', content: 'Wstęp\n## Wyniki\nlista', seq: null },
    ]);
});

// ─── 4. Kontrakt „pusty plik = zero wiadomości" (na tym stoi pruning sierot) ───

test('kontrakt: pusty tekst / sam frontmatter → messages: []', t => {
    for (const input of [undefined, null, '', '   ', FRONTMATTER, '---\nagent: Jaskier\n---\n']) {
        const parsed = parseActiveSession(input);
        t.deepEqual(parsed.messages, [], `wejście: ${JSON.stringify(input)}`);
        t.is(parsed.summary, null);
    }
    t.is(parseActiveSession(FRONTMATTER).metadata.agent, 'Jaskier');
});

test('kontrakt: CRLF w pliku nie rozwala parsowania', t => {
    const file = buildEventLog([
        { type: 'user_message', content: 'Pytanie\n## Cytat' },
        { type: 'agent_message', content: 'Odpowiedź' },
    ]).replace(/\n/g, '\r\n');

    t.deepEqual(parseActiveSession(file).messages, [
        { role: 'user', content: 'Pytanie\n## Cytat', seq: 1 },
        { role: 'assistant', content: 'Odpowiedź', seq: 2 },
    ]);
});

// ─── 5. Para escape/unescape (jedno źródło regexów dla obu pisarzy) ───

test('escape/unescape: escape → unescape = identyczność (także `## ` w pierwszej linii)', t => {
    const samples = [
        '## na samym początku',
        'zwykły tekst',
        'linia\n## w środku\nkoniec',
        '## start\n## drugi\n## trzeci',
        'nie tykaj ##bez spacji ani ### trzech',
        '  ## wcięte — to nie początek linii',
        '',
    ];
    for (const sample of samples) {
        t.is(unescapeActiveText(escapeActiveText(sample)), sample, `sample: ${JSON.stringify(sample)}`);
    }
});

test('escape/unescape: unescape jest no-opem na tekście bez escapów (idempotencja)', t => {
    const plain = 'linia\n## nagłówek\nkoniec';
    t.is(unescapeActiveText(plain), plain);
    const escaped = escapeActiveText(plain);
    t.is(unescapeActiveText(unescapeActiveText(escaped)), plain, 'drugi unescape już nic nie zmienia');
    t.is(escapeActiveText(escaped), escaped, 'drugi escape już nic nie dodaje (`\\## ` nie pasuje do `## `)');
});

test('escape/unescape: ZNANA strata — literalny `\\## ` na początku linii wraca jako `## `', t => {
    // Świadomie udokumentowana niedoskonałość schematu, ODZIEDZICZONA po `formatToMarkdown`
    // (pisarz B ma ją od zawsze). Naprawa = escapowanie samego backslasha, czyli zmiana
    // formatu po stronie B i odczytu starych plików — poza zakresem S36 Fazy 1.
    const tricky = 'Kod:\n\\## nie ruszaj';
    t.is(unescapeActiveText(escapeActiveText(tricky)), 'Kod:\n## nie ruszaj');
    // Ten sam efekt na pełnym round-tripie event-logu — żeby nikt nie odkrył tego przypadkiem.
    const parsed = parseActiveSession(buildEventLog([{ type: 'user_message', content: tricky }]));
    t.is(parsed.messages[0].content, 'Kod:\n## nie ruszaj');

    // S36 Faza 2: escapowanie etykiet pól dziedziczy TĘ SAMĄ wadę — literalny `\**result:**`
    // w treści wraca bez backslasha. Ta sama przyczyna (nie escapujemy samego backslasha),
    // ta sama świadoma decyzja.
    const trickyLabel = 'Log:\n\\**result:**\nkoniec';
    const parsedLabel = parseActiveSession(buildEventLog([{ type: 'user_message', content: trickyLabel }]));
    t.is(parsedLabel.messages[0].content, 'Log:\n**result:**\nkoniec');
});

test('stała wersji kontraktu jest ustawiona', t => {
    // v2 = S36 Faza 2 (pole `**seq:**` + escapowanie etykiet pól).
    t.is(ACTIVE_SESSION_FORMAT_VERSION, 2);
});

// ─── 5b. S36 Faza 2: numeracja `seq` + escapowanie etykiet pól ───

test('seq: pole `**seq:**` trafia do pliku tylko dla liczby', t => {
    const withSeq = formatSessionEvent('user_message', { content: 'raz', seq: 7 }, '2026-07-30T10:00:00.000Z');
    t.true(withSeq.includes('**seq:**\n\n7\n'), 'liczba idzie do pliku surowo');

    // Junk-inputy: typ mówi `seq: number`, a test pilnuje, że pisarz odrzuca resztę.
    for (const bad of [undefined, null, '', 'pięć', NaN, Infinity, {}]) {
        const block = formatSessionEvent(
            'user_message',
            { content: 'raz', seq: bad as unknown as number },
            '2026-07-30T10:00:00.000Z',
        );
        t.false(block.includes('**seq:**'), `seq=${JSON.stringify(bad)} nie tworzy pola`);
    }
});

test('maxSeq: największy numer w pliku, 0 gdy numeracji nie ma', t => {
    t.is(maxSeq(''), 0);
    t.is(maxSeq(undefined), 0);
    t.is(maxSeq(FRONTMATTER), 0);

    const file = buildEventLog([
        { type: 'user_message', content: 'raz' },
        { type: 'agent_message', content: 'dwa' },
        { type: 'user_message', content: 'trzy' },
    ]);
    t.is(maxSeq(file), 3);
    t.is(maxSeq(file.replace(/\n/g, '\r\n')), 3, 'CRLF nie psuje skanu');

    // Numeracja z dziurą / nie po kolei — liczy się MAKSIMUM, nie ostatni wpis.
    const outOfOrder = buildEventLog([
        { type: 'user_message', content: 'raz', seq: 41 },
        { type: 'agent_message', content: 'dwa', seq: 12 },
    ]);
    t.is(maxSeq(outOfOrder), 41);
});

test('maxSeq: linia `**seq:** 5` wklejona w TREŚĆ nie podbija licznika', t => {
    const file = buildEventLog([
        { type: 'user_message', content: 'Wklejam log:\n**seq:** 999\ni koniec', seq: 1 },
    ]);
    t.is(maxSeq(file), 1, 'wartość w tej samej linii co etykieta nie jest polem');
    t.is(parseActiveSession(file).messages[0].content, 'Wklejam log:\n**seq:** 999\ni koniec');
});

test('pola: treść z linią będącą etykietą pola (`**result:**`) wraca VERBATIM', t => {
    // Dziura bliźniacza do `## ` (znalezisko S36 Fazy 1): bez escapowania ta linia ucinała
    // pole przy odczycie, bo lookahead brał ją za początek następnego pola.
    const trap = [
        'Zwrotka narzędzia:',
        '**result:**',
        'to jest ciągle treść, nie nowe pole',
        '**seq:**',
        'i to też',
    ].join('\n');

    const file = buildEventLog([
        { type: 'tool_result', tool: 'read', result: trap },
        { type: 'agent_message', content: `Podsumowanie.\n${trap}` },
    ]);

    t.true(file.includes('\\**result:**'), 'pisarz escapuje etykietę w treści');
    t.true(file.includes('\\**seq:**'), 'to samo dla `**seq:**`');

    t.deepEqual(parseActiveSession(file).messages, [
        { role: 'tool', content: trap, seq: 1 },
        { role: 'assistant', content: `Podsumowanie.\n${trap}`, seq: 2 },
    ]);
});

test('AUD-code-review-007: etykieta pola WCZEŚNIEJSZEGO w EVENT_FIELDS (`content`) osadzona w treści pola PÓŹNIEJSZEGO (`result`) nie podszywa się pod prawdziwe pole', t => {
    // `extractEventField` sprawdzał pole `content` PRZED `result` (kolejność prób w
    // `parseActiveSession`), a bez kotwicy `^`/`\n` i przy fladze `i` etykieta wcześniejszego
    // pola osadzona w środku treści późniejszego pola wygrywała wyścig — czytnik zwracał tylko
    // ogon PO niej, gubiąc początek. Wariant małych liter pisarz ESCAPUJE (jak `**result:**`
    // w teście wyżej); wariant wielkich liter pisarz w ogóle nie rusza, bo `FIELD_LABEL_LINE_RE`
    // (escape pisarza) nie ma flagi `i` — więc czytnik MUSI stosować dokładnie tę samą regułę
    // rozpoznawania etykiety (kotwica + wielkość liter), inaczej jedna ze stron widzi granicę,
    // której druga nie widzi.
    const trapLower = ['PIERWSZA CZESC', '', '**content:**', '', 'DRUGA CZESC'].join('\n');
    const fileLower = buildEventLog([{ type: 'tool_result', tool: 'read', result: trapLower }]);
    t.true(fileLower.includes('\\**content:**'), 'pisarz escapuje etykietę `content` małymi literami tak samo jak `result`/`seq`');
    t.deepEqual(parseActiveSession(fileLower).messages, [
        { role: 'tool', content: trapLower, seq: 1 },
    ], 'czytnik zwraca CAŁĄ treść result (PIERWSZA + DRUGA), nie tylko ogon po embedded `**content:**`');

    const trapUpper = ['PIERWSZA CZESC', '', '**Content:**', '', 'DRUGA CZESC'].join('\n');
    const fileUpper = buildEventLog([{ type: 'tool_result', tool: 'read', result: trapUpper }]);
    t.false(fileUpper.includes('\\**Content:**'), 'pisarz NIE escapuje `**Content:**` (inna wielkość liter niż kanoniczna etykieta) — świadomie, bo czytnik ma tę samą regułę');
    t.deepEqual(parseActiveSession(fileUpper).messages, [
        { role: 'tool', content: trapUpper, seq: 1 },
    ], 'czytnik NIE traktuje `**Content:**` jako granicy pola (wielkość liter musi się zgadzać) — treść wraca w całości mimo braku escape');
});

test('pola: NIEZNANA bold-etykieta w treści już nie ucina pola (poprawa dla plików legacy)', t => {
    // Lookahead był `\n\*\*[^*]+:\*\*` — KAŻDA bold-etykieta kończyła pole, więc `**Uwaga:**`
    // w odpowiedzi modelu obcinało resztę wiadomości. Teraz kończą tylko znane etykiety.
    const legacy = [
        '## 2026-07-29T11:00:00.000Z — agent message',
        '',
        '**content:**',
        '',
        'Początek.',
        '**Uwaga:**',
        'to musi zostać',
        '',
    ].join('\n');

    t.deepEqual(parseActiveSession(legacy).messages, [
        { role: 'assistant', content: 'Początek.\n**Uwaga:**\nto musi zostać', seq: null },
    ]);
});

test('pola: escape/unescape etykiet = identyczność, unescape jest no-opem bez escapów', t => {
    const samples = [
        '**result:**',
        'linia\n**content:**\nkoniec',
        '**tool:**   ',
        'zwykły tekst',
        '**Uwaga:** nieznana etykieta zostaje nietknięta',
        '**result:** z wartością w tej samej linii',
        '',
    ];
    for (const sample of samples) {
        t.is(
            unescapeActiveText(unescapeEventFieldLabels(escapeEventFieldText(sample))),
            sample,
            `sample: ${JSON.stringify(sample)}`,
        );
    }
    const plain = 'linia\n**result:**\nkoniec';
    t.is(unescapeEventFieldLabels(plain), plain, 'no-op na treści bez escapów (legacy)');
});

test('EVENT_FIELDS: kolejność pól w bloku idzie z jednej listy', t => {
    t.deepEqual(EVENT_FIELDS, [
        'content', 'tool', 'args', 'result', 'model', 'tokens', 'duration_ms', 'role', 'prompt', 'seq',
    ]);
    const block = formatSessionEvent('tool_result', {
        seq: 1, prompt: 'p', role: 'tool', duration_ms: 5, tokens: 3, model: 'm',
        result: 'r', args: { a: 1 }, tool: 't', content: 'c',
    }, '2026-07-30T10:00:00.000Z');
    const order = [...block.matchAll(/^\*\*([a-z_]+):\*\*$/gm)].map(m => m[1]);
    t.deepEqual(order, EVENT_FIELDS, 'blok zapisuje pola w kolejności EVENT_FIELDS');
});

// ─── 6. Strażnik: sessionParser dalej robi round-trip po przepięciu regexów ───

test('strażnik: formatToMarkdown → parseSessionFile bez zmian po przeniesieniu escape/unescape', t => {
    const messages = [
        { role: 'user', content: 'Znajdź notatki' },
        { role: 'assistant', content: 'Szukam...\n## Wyniki\n- nic\n## Wnioski\nBrak.' },
    ];
    const parsed = parseSessionFile(formatToMarkdown(messages, { agent: 'jaskier' }, 'streszczenie'));
    t.deepEqual(parsed.messages, messages);
    t.is(parsed.metadata.agent, 'jaskier');
    t.is(parsed.summary, 'streszczenie');
});

// ─── AUD-bledy-011: padnięty bieg suba NIE MOŻE zniknąć z odtworzonej sesji ───
//
// `SubAgentRunner` dopisuje awarię jako blok `subagent_error` z polem `**role:**` niosącym
// ETYKIETĘ suba („researcher"). `roleFromEvent` nie znało tego typu, więc czytało `role` jako
// rolę WIADOMOŚCI — nieznana wartość dawała `null` i parser POMIJAŁ cały blok. Skutki: po
// restarcie Obsidiana odtworzona rozmowa nie ma śladu po padzie, konsolidacja karmi się
// `parsed.messages` (pamięć długoterminowa widzi tylko udane biegi), a `archiveActiveSession`
// przepisuje sesję z `parsed.messages` i KASUJE oryginał — zapis o awarii przestaje istnieć.

test('AUD-bledy-011: round-trip subagent_error — blok zapisany, blok odczytany', t => {
    const errText = 'Błąd sub-agenta Researcher: model timeout po 900000 ms';
    const file = buildEventLog([
        { type: 'agent_message', content: 'Zlecam researcherowi rozpoznanie.' },
        { type: 'subagent_error', role: 'researcher', prompt: 'Zbadaj temat', result: errText, duration_ms: 900000 },
        { type: 'user_message', content: 'i co?' },
    ]);

    t.true(file.includes('— subagent error'), 'blok FIZYCZNIE jest w pliku');

    const parsed = parseActiveSession(file);

    t.deepEqual(parsed.messages, [
        { role: 'assistant', content: 'Zlecam researcherowi rozpoznanie.', seq: 1 },
        { role: 'assistant', content: errText, seq: 2 },
        { role: 'user', content: 'i co?', seq: 3 },
    ], 'awaria suba wraca z odczytu jak każde inne zdarzenie biegu');
});

test('AUD-bledy-011: etykieta roli suba nie podszywa się pod rolę wiadomości', t => {
    // Sub z `role: system` w YAML-u wstrzykiwał treść błędu do odtworzonej rozmowy jako
    // WIADOMOŚĆ SYSTEMOWĄ — typ zdarzenia musi wygrywać z polem `**role:**`.
    const file = buildEventLog([
        { type: 'subagent_error', role: 'system', prompt: 'x', result: 'padło' },
        { type: 'subagent_call', role: 'system', prompt: 'x', result: 'poszło' },
    ]);

    const parsed = parseActiveSession(file);

    t.deepEqual(parsed.messages.map(m => m.role), ['assistant', 'assistant'],
        'oba biegi suba to wypowiedź asystenta, nie wiadomość systemowa');
});
