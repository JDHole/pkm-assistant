/**
 * Fabryka napraw F04 (2026-08-30) — cztery znaleziska code-review o jednym wspólnym mianowniku:
 * stan tury/okna musi żyć w OBIEKCIE TURY (`turn`) albo być adresowany przez tożsamość ZAKŁADKI
 * (`_tabKey`), nigdy przez pole widoku ani przez samą nazwę agenta — bo dwie tury/dwie zakładki
 * tego samego agenta (albo zakładka odtworzona z dysku, gdzie `sessionId` to ścieżka pliku, nie
 * nazwa agenta) rozjeżdżają się z tym skrótem.
 *
 * `chat_streaming.ts` importuje `obsidian`, więc AVA go nie zaimportuje — strażnicy siedzą PO
 * ŹRÓDLE. Wzór: `turnOwner.test.ts`, `stopSemantics.test.ts`.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Kod bez komentarzy — strażnik pilnuje WYWOŁAŃ, nie opisów historii. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Ciało funkcji od jej `export [async] function <name>` do następnego `\nexport `. */
function bodyOf(src: string, name: string): string {
    const head = new RegExp(`export (?:async )?function ${name}\\(`).exec(src);
    if (!head) return '';
    const rest = src.slice(head.index + head[0].length);
    const to = rest.indexOf('\nexport ');
    return stripComments(to < 0 ? rest : rest.slice(0, to));
}

const streaming = readSource('./chat_streaming.ts');
const streamingCode = stripComments(streaming);

// ── AUD-code-review-012: _agentStates kluczowana _tabKey, nie nazwą agenta ─────────────────
//
// F04 druga runda (2026-08-30, po blokadzie mergem): `_tabKey(turn.owner?.tab)` PRZELICZANY w
// miejscu sprzątania (finalize/error/watchdog) czyta ŻYWE pole `tab.sessionPath` — a `/save
// session` → „Archiwizuj i nowa sesja" (`archive_new`, `slash-commands/save_session.ts`)
// podmienia `activeTab.sessionPath` NA MIEJSCU, bez re-keyowania `_agentStates`. Klucz musi być
// zamrożony RAZ, na starcie tury (`ownerTabKey` w `send_message`, wożony dalej jako
// `turn.origin.tabKey` albo wprost jako string do `handle_error`), nie przeliczany leniwie
// po (czasem długich) awaitach.

test('send_message liczy ownerTabKey RAZ, zaraz po freezeTurnOwner (F04)', t => {
    const body = bodyOf(streaming, 'send_message');
    t.true(body.length > 0, 'nie znalazłem send_message');
    const freezeIdx = body.search(/const owner = freezeTurnOwner\(this\)/);
    const keyIdx = body.search(/const ownerTabKey = _tabKey\(owner\.tab\)/);
    t.true(freezeIdx >= 0, 'nie znalazłem freezeTurnOwner');
    t.true(keyIdx >= 0, 'ownerTabKey musi być policzony w send_message, jawnie, jednym wywołaniem _tabKey(owner.tab)');
    t.true(keyIdx > freezeIdx, 'ownerTabKey musi być liczony PO zamrożeniu właściciela');
    // Między freeze a ownerTabKey nie ma prawa być ŻADEN await — inaczej wracamy do luki K18.
    t.false(/await /.test(body.slice(freezeIdx, keyIdx)), 'ownerTabKey musi być policzony PRZED pierwszym awaitem po freezeTurnOwner');
});

test('turnOrigin.tabKey reużywa ownerTabKey zamiast przeliczać _tabKey drugi raz (F04)', t => {
    const body = bodyOf(streaming, 'send_message');
    t.regex(body, /tabKey:\s*ownerTabKey/, 'turnOrigin powinien wozić ownerTabKey, nie osobne przeliczenie _tabKey(turnTab)');
});

test('_finalizeTurn (tura w tle): zwalnia stan zakładki przez zamrożony turn.origin.tabKey (AUD-code-review-012)', t => {
    const body = bodyOf(streaming, '_finalizeTurn');
    t.true(body.length > 0, 'nie znalazłem _finalizeTurn');
    t.regex(body, /this\._agentStates\.get\(turn\.origin\?\.tabKey \?\? ''\)/,
        '_agentStates musi być czytana zamrożonym turn.origin.tabKey, nie przeliczonym _tabKey(turn.owner?.tab)');
    t.notRegex(body, /this\._agentStates\.get\(streamAgentName\)/,
        'powrót do klucza-nazwy = zakładka odtworzona z dysku (sessionId=ścieżka) znów wisi na "generuję"');
    t.notRegex(body, /this\._agentStates\.get\(_tabKey\(turn\.owner\?\.tab\)\)/,
        'przeliczenie leniwe po awaitach = archive_new podmienia tab.sessionPath pod nogami tego lookupu');
});

test('handle_error (tura w tle): przyjmuje KLUCZ (string), nie obiekt taba, i zwalnia stan przez niego (AUD-code-review-012)', t => {
    const body = bodyOf(streaming, 'handle_error');
    t.true(body.length > 0, 'nie znalazłem handle_error');
    t.regex(streamingCode, /export function handle_error\([^)]*ownerTabKey\?:\s*string\)/,
        'sygnatura handle_error musi przyjmować ownerTabKey jako string, nie obiekt tab');
    t.regex(body, /this\._agentStates\.get\(ownerTabKey \?\? ''\)/,
        'handle_error musi czytać _agentStates przez ownerTabKey (string) podany przez wołacza');
    t.notRegex(body, /this\._agentStates\.get\(streamAgentName\)/);
    t.notRegex(body, /_tabKey\(ownerTab\)/, 'stara sygnatura (obiekt tab + przeliczenie _tabKey tu) nie ma wrócić');
});

test('send_message przekazuje ownerTabKey (string, zamrożony) do handle_error (AUD-code-review-012)', t => {
    t.regex(streamingCode, /this\.handle_error\(error, streamAgentName, turnId, ownerTabKey\)/,
        'bez czwartego argumentu handle_error nie wie, którą zakładkę zwolnić w _agentStates');
    t.notRegex(streamingCode, /this\.handle_error\(error, streamAgentName, turnId, owner\.tab\)/,
        'przekazanie obiektu tab zamiast zamrożonego stringa = handle_error znów przelicza klucz leniwie');
});

test('_onStreamStall (tura w tle): zwalnia stan przez zamrożony turn.origin.tabKey (AUD-code-review-012)', t => {
    const body = bodyOf(streaming, '_onStreamStall');
    t.true(body.length > 0, 'nie znalazłem _onStreamStall');
    t.regex(body, /this\._agentStates\.get\(turn\.origin\?\.tabKey \?\? ''\)/);
    t.notRegex(body, /this\._agentStates\.get\(agentName\)/);
    t.notRegex(body, /this\._agentStates\.get\(_tabKey\(turn\.owner\?\.tab\)\)/,
        'watchdog strzela nawet po kilku minutach ciszy — największe okno na archive_new pod nogami');
});

// ── F04: strażnik file-wide — KAŻDE _agentStates.get(...) w całym pliku czyta zamrożony klucz ──
//
// Wolno tylko `turn.origin?.tabKey ?? ''` i `ownerTabKey ?? ''` (allowlist, nie notRegex na
// pojedynczy zły kształt) — inaczej strażnik złapie tylko wzorce, o których pomyśleliśmy dziś,
// a przyszły nowy odczyt po nazwie agenta albo po żywym `_tabKey(tab)` przemknie bez testu.

test('CAŁY plik: każde _agentStates.get(...) czyta wyłącznie zamrożony klucz (F04, file-wide)', t => {
    const calls = [...streamingCode.matchAll(/this\._agentStates\.get\(([^)]*)\)/g)].map(m => m[1].trim());
    t.true(calls.length >= 3, `spodziewałem się co najmniej 3 odczytów _agentStates.get(...) w pliku, znalazłem ${calls.length}`);
    const allowed = new Set(["turn.origin?.tabKey ?? ''", "ownerTabKey ?? ''"]);
    for (const call of calls) {
        t.true(allowed.has(call),
            `this._agentStates.get(${call}) — dozwolone WYŁĄCZNIE zamrożone klucze (${[...allowed].join(' | ')}); ` +
            `każdy inny kształt (nazwa agenta, _tabKey(tab) przeliczony na żywo) jest dokładnie tą klasą błędu co AUD-code-review-012`);
    }
});

// ── AUD-code-review-014: estymata wejścia żyje W TURZE, nie na widoku ──────────────────────

test('_captureInputEstimate pisze na turn, nie na this (AUD-code-review-014)', t => {
    const body = bodyOf(streaming, '_captureInputEstimate');
    t.true(body.length > 0, 'nie znalazłem _captureInputEstimate');
    t.regex(body, /turn\.lastInputTokens\s*=/);
    t.regex(body, /turn\.lastInputChars\s*=/);
    t.notRegex(body, /this\._lastInputTokens\s*=/, 'pole per-widok = dwie tury naraz nadpisują sobie estymatę');
    t.notRegex(body, /this\._lastInputChars\s*=/);
});

test('_chatOnUsage, _chatBeforeContinue i _finalizeTurn czytają estymatę z turn, nie z this (AUD-code-review-014)', t => {
    for (const fn of ['_chatOnUsage', '_chatBeforeContinue', '_finalizeTurn']) {
        const body = bodyOf(streaming, fn);
        t.true(body.length > 0, `nie znalazłem ${fn}`);
        t.notRegex(body, /this\._lastInputTokens/, `${fn} czyta this._lastInputTokens — cudzej tury estymatę`);
        t.notRegex(body, /this\._lastInputChars/, `${fn} czyta this._lastInputChars — cudzej tury estymatę`);
    }
    t.regex(bodyOf(streaming, '_chatOnUsage'), /turn\.lastInputChars/);
    t.regex(bodyOf(streaming, '_chatBeforeContinue'), /turn\.lastInputTokens/);
    t.regex(bodyOf(streaming, '_finalizeTurn'), /turn\.lastInputTokens/);
});

test('żadne miejsce w chat_streaming.ts nie czyta/pisze this._lastInputTokens|Chars (AUD-code-review-014)', t => {
    t.notRegex(streamingCode, /this\._lastInputTokens|this\._lastInputChars/,
        'pole per-widok wróciło — sprawdź czy nowy call-site nie ominął turn.lastInputTokens/Chars');
});

// ── AUD-code-review-073: decyzja o wizji dla WŁAŚCICIELA tury, nie globalnie aktywnego ─────

test('_chatExecuteToolCall pyta o wizję modelu WŁAŚCICIELA tury (AUD-code-review-073)', t => {
    const body = bodyOf(streaming, '_chatExecuteToolCall');
    t.true(body.length > 0, 'nie znalazłem _chatExecuteToolCall');
    t.regex(body, /this\._isCurrentModelVision\(turn\.agent\)/,
        'bez turn.agent decyzja o kształcie wyniku generate_image spada na globalnie aktywnego agenta');
    t.notRegex(body, /this\._isCurrentModelVision\(\)/,
        'wywołanie bez argumentu w tym miejscu = powrót do bugu AUD-code-review-073');
});

// ── AUD-code-review-052: mid-loop compression ustawia rw.sessionPath jak end-of-turn ───────

test('_chatBeforeContinue (mid-loop): ustawia rw.sessionPath przed performTwoPhaseCompression (AUD-code-review-052)', t => {
    const body = bodyOf(streaming, '_chatBeforeContinue');
    t.true(body.length > 0, 'nie znalazłem _chatBeforeContinue');
    const setIdx = body.search(/rw\.sessionPath\s*=/);
    const compressIdx = body.search(/await rw\.performTwoPhaseCompression\(false\)/);
    t.true(setIdx >= 0, 'mid-loop compression nie ustawia rw.sessionPath — Summarizer traci {{SESSION_PATH}}');
    t.true(compressIdx >= 0, 'nie znalazłem wywołania performTwoPhaseCompression w mid-loop');
    t.true(setIdx < compressIdx, 'rw.sessionPath musi być ustawione PRZED kompresją, nie po niej');
});

// ── AUD-code-review-016: chat_popovers.ts woła KANONICZNY _tabKey, nie inline'owaną kopię ──

test('_applyAutonomyChange woła _tabKey z chat_tabs.js zamiast liczyć klucz inline (AUD-code-review-016)', t => {
    const popovers = stripComments(readSource('./chat_popovers.ts'));
    t.regex(popovers, /import\s*\{\s*_tabKey\s*\}\s*from\s*'\.\/chat_tabs\.js'/,
        'brak importu kanonicznego _tabKey');
    t.regex(popovers, /_tabKey\(activeTab\)/,
        '_applyAutonomyChange musi liczyć klucz zakładki przez _tabKey, nie inline');
    t.notRegex(popovers, /activeTab\.sessionId\s*\|\|\s*activeTab\.sessionPath/,
        'druga (inline) kopia formuły _tabKey wróciła — dokładnie to, przed czym ostrzega JSDoc w chat_tabs.ts');
});

// ── F04: chat_session.ts — czwarty writer _agentStates woła KANONICZNY _tabKey ─────────────
//
// `_restoreActiveSession` (`_agentStates.clear()` + pętla po `restored`) był jedynym miejscem
// PISZĄCYM do `_agentStates` ręczną kopią klucza (`item.session.path`) zamiast wołać `_tabKey`
// importowany z `chat_tabs.js`. Działało przypadkiem — `sessionId` i `sessionPath` dostają w tej
// samej funkcji tę samą wartość przy budowie `chatTabs` — ale to czwarta kopia formuły, przed
// którą ostrzega JSDoc `_tabKey` w `chat_tabs.ts` ("druga kopia = wynik suba trafiałby do złej
// zakładki"). `chat_session.ts` importuje `obsidian` (Notice) — strażnik PO ŹRÓDLE.

test('_restoreActiveSession pisze do _agentStates przez kanoniczny _tabKey, nie ręczną kopię item.session.path (F04)', t => {
    const session = stripComments(readSource('./chat_session.ts'));
    t.regex(session, /import\s*\{\s*_tabKey\s*\}\s*from\s*'\.\/chat_tabs\.js'/,
        'brak importu kanonicznego _tabKey w chat_session.ts');
    t.regex(session, /this\._agentStates\.set\(_tabKey\(this\.chatTabs\[index\]\)/,
        '_agentStates.set musi być kluczowany _tabKey(tab), tak samo jak _switchTab i cały chat_streaming.ts');
    t.notRegex(session, /this\._agentStates\.set\(item\.session\.path/,
        'ręczna kopia klucza (item.session.path) wróciła — czwarty writer znów rozjeżdża się z formułą _tabKey');
});
