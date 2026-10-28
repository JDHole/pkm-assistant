/**
 * Stan tury/okna musi żyć w OBIEKCIE TURY (`turn`) albo być adresowany przez tożsamość ZAKŁADKI
 * (`_tabKey`), nigdy przez pole widoku ani przez samą nazwę agenta - bo dwie tury/dwie zakładki
 * tego samego agenta (albo zakładka odtworzona z dysku, gdzie `sessionId` to ścieżka pliku, nie
 * nazwa agenta) rozjeżdżają się z tym skrótem.
 *
 * `chat_streaming.ts` importuje `obsidian`, więc AVA go nie zaimportuje - strażnicy siedzą PO
 * ŹRÓDLE. Wzór: `turnOwner.test.ts`, `stopSemantics.test.ts`.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { _releaseStreamCtx } from './chat_streaming.js';

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

// ── _agentStates kluczowana _tabKey, nie nazwą agenta ───────────────────────────────────────
//
// Klucz uchwytu tury jest zamrożony na starcie. Stan generowania należy do obiektu
// zakładki i po wymianie rozmowy może leżeć pod jej nowym kluczem.

test('send_message liczy ownerTabKey RAZ, zaraz po freezeTurnOwner', t => {
    const body = bodyOf(streaming, 'send_message');
    t.true(body.length > 0, 'nie znalazłem send_message');
    const freezeIdx = body.search(/const owner = freezeTurnOwner\(this\)/);
    const keyIdx = body.search(/const ownerTabKey = _tabKey\(owner\.tab\)/);
    t.true(freezeIdx >= 0, 'nie znalazłem freezeTurnOwner');
    t.true(keyIdx >= 0, 'ownerTabKey musi być policzony w send_message, jawnie, jednym wywołaniem _tabKey(owner.tab)');
    t.true(keyIdx > freezeIdx, 'ownerTabKey musi być liczony PO zamrożeniu właściciela');
    // Między freeze a ownerTabKey nie ma prawa być ŻADEN await - inaczej klucz łapie stan sprzed zamrożenia.
    t.false(/await /.test(body.slice(freezeIdx, keyIdx)), 'ownerTabKey musi być policzony PRZED pierwszym awaitem po freezeTurnOwner');
});

test('turnOrigin.tabKey reużywa ownerTabKey zamiast przeliczać _tabKey drugi raz', t => {
    const body = bodyOf(streaming, 'send_message');
    t.regex(body, /tabKey:\s*ownerTabKey/, 'turnOrigin powinien wozić ownerTabKey, nie osobne przeliczenie _tabKey(turnTab)');
});

test('zwolnienie ostatniej tury zmienia bieżący stan zakładki, nie stan innej tury', t => {
    const tab = { agentName: 'Owner', sessionId: 'q.md', isActive: false };
    const oldWindow = {}; const q = { rollingWindow: {}, isGenerating: true };
    const ctx: any = { chatTabs: [tab], _agentStates: new Map([['q.md', q]]), _preparingTurns: new Map(), _streamCtxMap: new Map([
        ['old.md', { tab, rollingWindow: oldWindow, turnId: 1 }], ['other.md', { tab, rollingWindow: {}, turnId: 2 }],
    ]) };
    _releaseStreamCtx.call(ctx, 'old.md', 1);
    t.true(q.isGenerating);
    _releaseStreamCtx.call(ctx, 'other.md', 2);
    t.false(q.isGenerating);
});

test('send_message przekazuje ownerTabKey (string, zamrożony) do handle_error', t => {
    t.regex(streamingCode, /this\.handle_error\(error, streamAgentName, turnId, ownerTabKey\)/,
        'bez czwartego argumentu handle_error nie wie, którą zakładkę zwolnić w _agentStates');
    t.notRegex(streamingCode, /this\.handle_error\(error, streamAgentName, turnId, owner\.tab\)/,
        'przekazanie obiektu tab zamiast zamrożonego stringa = handle_error znów przelicza klucz leniwie');
});

// ── estymata wejścia żyje W TURZE, nie na widoku ────────────────────────────────────────────

test('_captureInputEstimate pisze na turn, nie na this', t => {
    const body = bodyOf(streaming, '_captureInputEstimate');
    t.true(body.length > 0, 'nie znalazłem _captureInputEstimate');
    t.regex(body, /turn\.lastInputTokens\s*=/);
    t.regex(body, /turn\.lastInputChars\s*=/);
    t.notRegex(body, /this\._lastInputTokens\s*=/, 'pole per-widok = dwie tury naraz nadpisują sobie estymatę');
    t.notRegex(body, /this\._lastInputChars\s*=/);
});

test('_chatOnUsage, _chatBeforeContinue i _finalizeTurn czytają estymatę z turn, nie z this', t => {
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

test('żadne miejsce w chat_streaming.ts nie czyta/pisze this._lastInputTokens|Chars', t => {
    t.notRegex(streamingCode, /this\._lastInputTokens|this\._lastInputChars/,
        'pole per-widok wróciło — sprawdź czy nowy call-site nie ominął turn.lastInputTokens/Chars');
});

// ── decyzja o wizji dla WŁAŚCICIELA tury, nie globalnie aktywnego ──────────────────────────

test('_chatExecuteToolCall pyta o wizję modelu WŁAŚCICIELA tury', t => {
    const body = bodyOf(streaming, '_chatExecuteToolCall');
    t.true(body.length > 0, 'nie znalazłem _chatExecuteToolCall');
    t.regex(body, /this\._isCurrentModelVision\(turn\.agent\)/,
        'bez turn.agent decyzja o kształcie wyniku generate_image spada na globalnie aktywnego agenta');
    t.notRegex(body, /this\._isCurrentModelVision\(\)/,
        'wywołanie bez argumentu w tym miejscu decyduje wg globalnie aktywnego agenta zamiast właściciela tury');
});

// ── mid-loop compression ustawia rw.sessionPath jak end-of-turn ────────────────────────────

test('_chatBeforeContinue (mid-loop): ustawia rw.sessionPath przed performTwoPhaseCompression', t => {
    const body = bodyOf(streaming, '_chatBeforeContinue');
    t.true(body.length > 0, 'nie znalazłem _chatBeforeContinue');
    const setIdx = body.search(/rw\.sessionPath\s*=/);
    const compressIdx = body.search(/await rw\.performTwoPhaseCompression\(false\)/);
    t.true(setIdx >= 0, 'mid-loop compression nie ustawia rw.sessionPath — Summarizer traci {{SESSION_PATH}}');
    t.true(compressIdx >= 0, 'nie znalazłem wywołania performTwoPhaseCompression w mid-loop');
    t.true(setIdx < compressIdx, 'rw.sessionPath musi być ustawione PRZED kompresją, nie po niej');
});

// ── chat_popovers.ts woła KANONICZNY _tabKey, nie inline'owaną kopię ───────────────────────

test('_applyAutonomyChange woła _tabKey z chat_tabs.js zamiast liczyć klucz inline', t => {
    const popovers = stripComments(readSource('./chat_popovers.ts'));
    t.regex(popovers, /import\s*\{\s*_tabKey\s*\}\s*from\s*'\.\/chat_tabs\.js'/,
        'brak importu kanonicznego _tabKey');
    t.regex(popovers, /_tabKey\(activeTab\)/,
        '_applyAutonomyChange musi liczyć klucz zakładki przez _tabKey, nie inline');
    t.notRegex(popovers, /activeTab\.sessionId\s*\|\|\s*activeTab\.sessionPath/,
        'druga (inline) kopia formuły _tabKey - dokładnie to, przed czym ostrzega JSDoc w chat_tabs.ts');
});

// ── chat_session.ts: writer _agentStates woła KANONICZNY _tabKey ───────────────────────────
//
// `_restoreActiveSession` (`_agentStates.clear()` + pętla po `restored`) pisze do `_agentStates`
// przez `_tabKey` importowany z `chat_tabs.js`, nie ręczną kopią klucza (`item.session.path`).
// Ręczna kopia działałaby przypadkiem - `sessionId` i `sessionPath` dostają w tej samej funkcji
// tę samą wartość przy budowie `chatTabs` - ale każda osobna kopia formuły ryzykuje rozjazd
// z tym, przed czym ostrzega JSDoc `_tabKey` w `chat_tabs.ts` ("druga kopia = wynik suba
// trafiałby do złej zakładki"). `chat_session.ts` importuje `obsidian` (Notice) - strażnik
// PO ŹRÓDLE.

test('_restoreActiveSession pisze do _agentStates przez kanoniczny _tabKey, nie ręczną kopię item.session.path', t => {
    const session = stripComments(readSource('./chat_session.ts'));
    t.regex(session, /import\s*\{\s*_tabKey\s*\}\s*from\s*'\.\/chat_tabs\.js'/,
        'brak importu kanonicznego _tabKey w chat_session.ts');
    t.regex(session, /this\._agentStates\.set\(_tabKey\(this\.chatTabs\[index\]\)/,
        '_agentStates.set musi być kluczowany _tabKey(tab), tak samo jak _switchTab i cały chat_streaming.ts');
    t.notRegex(session, /this\._agentStates\.set\(item\.session\.path/,
        'ręczna kopia klucza (item.session.path) wróciła — czwarty writer znów rozjeżdża się z formułą _tabKey');
});
