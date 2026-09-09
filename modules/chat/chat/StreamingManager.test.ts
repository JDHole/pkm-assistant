/**
 * `getActiveStreams()` zasila decyzję, czy tura dostanie ŚWIEŻĄ instancję modelu
 * (`chat_streaming.ts`): jeśli ta metoda kiedykolwiek zwróci pustą listę mimo aktywnych
 * streamów, dwie zakładki zaczną dzielić jedną instancję `ChatModel` - czyli Stop kliknięty
 * w jednej trafi w turę drugiej (`stopStream`/bilet bramki/`_abortSettle` są per instancja).
 *
 * Testy są `serial`, bo `streamingManager` (default export) to singleton modułowy - biegi
 * równoległe grzebałyby sobie nawzajem w `activeStreams`.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import streamingManager, { StreamingManager, shouldUseFreshModel } from './StreamingManager.js';

// ── Decyzja o świeżej instancji modelu — obie strony każdej gałęzi ──

test('świeża instancja: jedna tura lokalnie, zero cudzych streamów → cache wystarczy', t => {
    t.false(shouldUseFreshModel(0, 0));
    t.false(shouldUseFreshModel(1, 0), 'pojedyncza tura w pojedynczym widoku nie ściera się z nikim');
});

test('świeża instancja: druga tura W TYM widoku wymusza świeży model', t => {
    t.true(shouldUseFreshModel(2, 0));
    t.true(shouldUseFreshModel(5, 0));
});

test('świeża instancja: stream z INNEGO widoku też wymusza świeży model', t => {
    // Lokalne `size > 1` nie widzi zakładek z osobnych widoków, więc trzeba liczyć osobno.
    t.true(shouldUseFreshModel(1, 1));
    t.true(shouldUseFreshModel(0, 3));
});

test('świeża instancja: martwy licznik streamów (zawsze 0) NIE otwiera cache dla drugiej tury', t => {
    // Mutacja `getActiveStreams()` → `[]` psuje tylko drugi człon - pierwszy musi ją częściowo
    // złapać, ale przypadek 1 tura + cudzy stream już nie.
    t.true(shouldUseFreshModel(2, 0));
    t.true(shouldUseFreshModel(1, 1));
});

// ── Rejestr streamów ──

test.serial('rejestracja streamu jest widoczna w getActiveStreams', t => {
    const mgr = new StreamingManager();
    mgr.startStream('tab-1:Borys', { agent: 'Borys', modelId: 'deepseek-chat' });

    const aktywne = mgr.getActiveStreams();
    t.is(aktywne.length, 1);
    t.is(aktywne[0].streamId, 'tab-1:Borys');
    t.is(aktywne[0].agent, 'Borys');
    t.is(aktywne[0].modelId, 'deepseek-chat');
    t.true(aktywne[0].durationMs >= 0, 'czas trwania liczony od rejestracji');
});

test.serial('startStream oddaje AbortController, którym da się przerwać stream', t => {
    const mgr = new StreamingManager();
    const ctrl = mgr.startStream('tab-1:Borys');
    t.truthy(ctrl, 'bez kontrolera nie ma jak kooperatywnie anulować');
    t.false(ctrl!.signal.aborted);
});

test.serial('ponowna rejestracja tego samego streamId PRZERYWA poprzedni', t => {
    const mgr = new StreamingManager();
    const pierwszy = mgr.startStream('tab-1:Borys', { agent: 'Borys' });
    const drugi = mgr.startStream('tab-1:Borys', { agent: 'Borys' });

    t.true(pierwszy!.signal.aborted, 'stary stream zostałby sierotą — dwa strumienie w jedną zakładkę');
    t.false(drugi!.signal.aborted);
    t.is(mgr.getActiveStreams().length, 1, 'wpis jest jeden, nie dwa');
});

test.serial('stopStream wyrejestrowuje i przerywa; nieznane id oddaje false', t => {
    const mgr = new StreamingManager();
    const ctrl = mgr.startStream('tab-1:Borys');

    t.false(mgr.stopStream('tab-nieznana'), 'nieznane id nie może udawać, że coś zatrzymało');
    t.true(mgr.stopStream('tab-1:Borys'));
    t.true(ctrl!.signal.aborted);
    t.is(mgr.getActiveStreams().length, 0);
    t.false(mgr.stopStream('tab-1:Borys'), 'drugie zatrzymanie tego samego streamu to już nie-znaleziono');
});

test.serial('dwa widoki = dwa wpisy; zatrzymanie jednego nie rusza drugiego', t => {
    const mgr = new StreamingManager();
    mgr.startStream('tab-1:Borys', { agent: 'Borys' });
    const drugi = mgr.startStream('tab-2:Jaskier', { agent: 'Jaskier' });

    mgr.stopStream('tab-1:Borys');
    const aktywne = mgr.getActiveStreams();
    t.is(aktywne.length, 1);
    t.is(aktywne[0].agent, 'Jaskier');
    t.false(drugi!.signal.aborted);
});

test.serial('reset() przerywa wszystko i czyści rejestr (plugin disable)', t => {
    const mgr = new StreamingManager();
    const a = mgr.startStream('tab-1:Borys');
    const b = mgr.startStream('tab-2:Jaskier');

    mgr.reset();
    t.true(a!.signal.aborted);
    t.true(b!.signal.aborted);
    t.is(mgr.getActiveStreams().length, 0);
});

test.serial('singleton jest jeden na cały plugin (ten sam obiekt dla każdego importera)', t => {
    t.true(streamingManager instanceof StreamingManager);
    t.is(streamingManager.getActiveStreams().length, 0, 'startowo pusty — testy nie zostawiają śmieci');
});

// ── Okablowanie w turze czatu (po źródle — `chat_streaming.ts` wisi na `obsidian`) ──

const streamingCode = readFileSync(fileURLToPath(new URL('./chat_streaming.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('tura czatu pyta wspólnej decyzji i karmi ją OBOMA licznikami', t => {
    t.regex(
        streamingCode,
        /const needsFreshModel = shouldUseFreshModel\(this\._streamCtxMap\.size,\s*streamingManager\.getActiveStreams\(\)\.length\);/,
        'tura przestała pytać `shouldUseFreshModel` (albo urwała jeden z liczników) — wraca cross-tab race na współdzielonej instancji modelu',
    );
    t.regex(
        streamingCode,
        /get_chat_model\(\{\s*skipCache: needsFreshModel\b/,
        'werdykt nie dociera do doboru modelu — `skipCache` przestało zależeć od współbieżności',
    );
    t.regex(
        streamingCode,
        /import streamingManager, \{ shouldUseFreshModel \} from '\.\/StreamingManager\.js';/,
        'decyzja musi iść z StreamingManager.js, nie z lokalnej kopii warunku',
    );
});
