/**
 * `render_messages` - historia z `delegate` i wynikiem `{success:false, error:"limit czasu"}`
 * musi renderować kafelek sub-agenta ze statusem błędu, którego SZCZEGÓŁY niosą tekst
 * "limit czasu" LITERALNIE - nie generyczne "bez opisu"/"without details". Dodatkowy zakres A3
 * (po A2): kod, który to robi, żyje w `chat_messages.ts` (gałąź `response` delegata bez
 * `result`, ale z `error` - patrz komentarz przy tym wywołaniu), wzorowany na
 * `chat.streaming.error_prefix`, którym `_chatOnToolResults` (`chat_streaming.ts`) buduje
 * `response` dla ŻYWEJ, padniętej delegacji.
 *
 * Ten sam plik niesie też DOM-ową weryfikację spec A3 ("Czat bez ścian"): `render_messages`
 * (historia) i `append_message` (na żywo) dla wiadomości maszynowej mają renderować
 * `.cs-tile--system`, NIGDY `.cs-message--user` - patrz testy na dole pliku.
 *
 * Atrapa `document` (globalna z harnessu) ma `classList` jako CAŁKOWITY no-op - ten sam wzorzec
 * jak `handleError.tile.test.ts`: test podstawia WŁASNĄ, minimalną atrapę `document` z
 * prawdziwym `classList`, żeby dało się zweryfikować treść `.cs-tile__details`/klasy kafelka.
 * `withFakeDocument` jest tu ASYNC (inaczej niż w `handleError.tile.test.ts`, gdzie
 * `handle_error` nie jest awaitowane) - `render_messages`/`append_message` mają `await` PRZED
 * pierwszym `document.createElement` (np. `append_message`'s `await
 * this.rollingWindow.addMessage(...)`), więc wariant synchroniczny przywracałby oryginalny
 * `document` ZANIM funkcja realnie doszła do tworzenia elementów.
 */
import test from 'ava';
import { render_messages, append_message } from './chat_messages.js';
import { _chatOnToolResults } from './chat_streaming.js';
import { createSubAgentBlock } from '../../ui-components/index.js';
// `translate` (nie `t`) - AVA nazywa swój argument asercji `t`, więc import pod tą samą nazwą
// cieniowałby się wewnątrz callbacku testu.
import { t as translate } from '../../../core/i18n/index.js';

type Listener = (ev: unknown) => void;

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    parent: FakeEl | null;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    listeners: Record<string, Listener[]>;
    appendText(text: string): void;
    empty(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    addEventListener(type: string, cb: Listener): void;
    createDiv(opts?: { cls?: string | string[] }): FakeEl;
    createSpan(opts?: { cls?: string | string[]; text?: string }): FakeEl;
    createEl(tag: string, opts?: { cls?: string | string[]; text?: string }): FakeEl;
    querySelectorAll(): FakeEl[];
    scrollIntoView(): void;
    style: { setProperty(name: string, value: string): void; getPropertyValue(name: string): string };
};

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    const styleProps = new Map<string, string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
        style: {
            setProperty(name, value) { styleProps.set(name, value); },
            getPropertyValue(name) { return styleProps.get(name) || ''; },
        },
        children: [],
        parent: null,
        classList: {
            add: (...c) => { c.forEach(x => classes.add(x)); },
            remove: (...c) => { c.forEach(x => classes.delete(x)); },
            toggle: (c, force) => { const next = force === undefined ? !classes.has(c) : force; if (next) classes.add(c); else classes.delete(c); },
            contains: (c) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; el.children = []; },
        appendText(t2) { text += t2; },
        empty() { text = ''; el.children = []; },
        setAttribute(name, value) { attrs.set(name, value); },
        getAttribute(name) { return attrs.has(name) ? attrs.get(name)! : null; },
        removeAttribute(name) { attrs.delete(name); },
        hasAttribute(name) { return attrs.has(name); },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        insertBefore(child, ref) {
            child.parent = el;
            const idx = ref ? el.children.indexOf(ref) : -1;
            if (ref && idx >= 0) el.children.splice(idx, 0, child);
            else el.children.push(child);
            return child;
        },
        listeners: {},
        addEventListener(type, cb) { (el.listeners[type] ||= []).push(cb); },
        createDiv(opts) { const c = makeFakeEl('div'); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; el.appendChild(c); return c; },
        createSpan(opts) { const c = makeFakeEl('span'); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; if (opts?.text != null) c.textContent = opts.text; el.appendChild(c); return c; },
        createEl(tag2, opts) { const c = makeFakeEl(tag2); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; if (opts?.text != null) c.textContent = opts.text; el.appendChild(c); return c; },
        querySelectorAll() { return []; },
        scrollIntoView() {},
    } as FakeEl;
    return el;
}

function findByClass(root: FakeEl, cls: string): FakeEl | null {
    if (root.classList.contains(cls)) return root;
    for (const child of root.children) {
        const found = findByClass(child, cls);
        if (found) return found;
    }
    return null;
}

function deepText(root: FakeEl): string {
    return root.textContent + root.children.map(deepText).join('');
}

// Async-aware (`render_messages`/`append_message` są `async function` z `await` PRZED pierwszym
// `document.createElement` - `renderMachineTile` (`machineTile.ts`) dla `append_message` odpala
// dopiero PO `await this.rollingWindow.addMessage(...)`, i sama jest `async` - rozwiązuje ścieżkę
// artefaktu PRZED budową kafelka, B2 fix). Wariant synchroniczny (jak w
// `handleError.tile.test.ts`, gdzie `handle_error` nie jest awaitowane) przywracałby oryginalny
// `document` w `finally` ZANIM funkcja realnie doszła do tworzenia elementów - `try { return
// fn(); }` na funkcji async zwraca PENDING promise natychmiast, więc `finally` odpaliłby
// przedwcześnie. Tu `await fn()` czeka na realne zakończenie przed przywróceniem.
async function withFakeDocument<T>(fn: () => Promise<T>): Promise<T> {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag) };
    try {
        return await fn();
    } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
    }
}

type TestDynamic = any;

function buildFakeThis(container: FakeEl, messages: TestDynamic[]): TestDynamic {
    return {
        messages_container: container,
        rollingWindow: { messages },
        plugin: { agentManager: { getActiveAgent: () => ({ name: 'Jaskier', color: '#fff' }) },
            subTaskRegistry: { getTask: (id: string) => id === 'sub/id#7' ? { threadId: 'sub/worker', status: 'running' } : undefined,
                getThread: (id: string) => id === 'sub/worker' ? { phase: 'running' } : undefined } },
        env: { settings: { pkmAssistant: {} } },
        app: {},
        _drawConnectorLines: () => {},
        scrollToBottom: () => {},
        addMessageActions: () => {},
        _renderMultimodalUserContent: () => {},
        _renderUserText: () => {},
        _renderCacheSavingsBadge: () => {},
        _contentBlocksToText: () => '',
    };
}

test.serial('render_messages: delegate padniety {success:false, error:"limit czasu"} - kafelek sub-agenta w BLEDZIE, details niosa "limit czasu" literalnie', async t => {
    await withFakeDocument(async () => {
        const container = makeFakeEl('div');
        const messages: TestDynamic[] = [
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call_1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'zbadaj limit', aspect: 'ekspert' }) } }],
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                content: JSON.stringify({ success: false, error: 'limit czasu' }),
            },
        ];
        const fakeThis = buildFakeThis(container, messages);

        await render_messages.call(fakeThis);

        const tile = findByClass(container, 'cs-tile--agent');
        t.truthy(tile, 'brak kafelka sub-agenta (.cs-tile--agent) w messages_container');
        t.true(tile!.classList.contains('cs-tile--error'), 'delegacja padnieta ma byc .cs-tile--error');

        const details = findByClass(tile!, 'cs-tile__details');
        t.truthy(details, 'kafelek bledu musi miec sekcje details (status error rozwija domyslnie)');
        t.true(details!.textContent.includes('limit czasu'), `details maja zawierac literalny tekst bledu, dostalem: "${details!.textContent}"`);

        const errorNoDetailsPl = translate('chat.tile.sub.error_no_details', undefined, 'pl');
        const errorNoDetailsEn = translate('chat.tile.sub.error_no_details', undefined, 'en');
        t.false(details!.textContent.includes(errorNoDetailsPl), 'nie generyczny komunikat PL "bez opisu" - opis BYL w danych');
        t.false(details!.textContent.includes(errorNoDetailsEn), 'nie generyczny komunikat EN "without details" - opis BYL w danych');
    });
});

test.serial('render_messages i wynik na żywo przekazują te same pełne opcje kafelka', async t => {
    await withFakeDocument(async () => {
        const output = { success: false, error: 'Limit czasu', aspect: 'pkm-sub', partial_result: 'DOROBEK', tools_used: ['write'], tool_call_details: [{ name: 'write', args: { path: 'a.md' } }], usage: { prompt_tokens: 4, completion_tokens: 2 }, duration_ms: 12345 };
        const container = makeFakeEl();
        const messages = [
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'zapisz' }) } }] },
            { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify(output) },
        ];
        let historyOptions: Parameters<typeof createSubAgentBlock>[0] | undefined;
        await render_messages.call(buildFakeThis(container, messages), options => {
            historyOptions = options;
            return createSubAgentBlock(options);
        });
        const actual = findByClass(container, 'cs-tile--agent');
        const capture: { live?: FakeEl; options?: Parameters<typeof createSubAgentBlock>[0] } = {};
        const toolCall = { id: 'call_1', name: 'delegate', arguments: JSON.stringify({ task: 'zapisz' }) };
        const turn = {
            agentName: 'Jaskier', toolCallsContainer: null,
            owner: { memory: null }, origin: { sessionPath: '' },
            rawResults: new Map([['call_1', { result: output, error: null }]]),
            pendingEntries: [{ isSubAgent: true, toolDisplay: { replaceWith: (el: FakeEl) => { capture.live = el; } } }],
        };
        await _chatOnToolResults.call({ _isTurnActiveTab: () => true, _scheduleConnectorRedraw: () => {}, toolReactors: { run: async () => {} } } as never, turn as never, [{ toolCall, result: output }] as never, 0, options => {
            capture.options = options;
            return createSubAgentBlock(options);
        });
        const live = capture.live;
        const expectedOptions = {
            type: 'delegate', status: 'error', agentName: 'pkm-sub', query: 'zapisz',
            response: `${translate('chat.streaming.error_prefix', { message: 'Limit czasu' })}\n\n${translate('chat.subagent_notification.partial_heading')}\nDOROBEK`,
            toolsUsed: ['write'], toolCallDetails: [{ name: 'write', args: { path: 'a.md' } }],
            usage: { prompt_tokens: 4, completion_tokens: 2 }, duration: 12345,
        };
        t.deepEqual(historyOptions, expectedOptions);
        t.deepEqual(capture.options, expectedOptions);
        t.deepEqual(historyOptions, capture.options);
        t.truthy(actual);
        t.truthy(live);
        t.true(actual?.classList.contains('cs-tile--error') ?? false);
        t.true(live?.classList.contains('cs-tile--error') ?? false);
        const actualDetails = actual && findByClass(actual, 'cs-tile__details');
        const liveDetails = live && findByClass(live, 'cs-tile__details');
        t.is(actualDetails?.textContent, liveDetails?.textContent);
        t.true(actualDetails?.textContent.includes('DOROBEK') ?? false);
        t.true(actualDetails?.textContent.includes('Limit czasu') ?? false);
        const title = actual && findByClass(actual, 'cs-tile__title');
        t.true(title?.textContent.includes('pkm-sub') ?? false);
    });
});

test.serial('render_messages: tekstowy wynik starszego delegate zachowuje odpowiedź', async t => {
    await withFakeDocument(async () => {
        const container = makeFakeEl();
        await render_messages.call(buildFakeThis(container, [
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'zadanie' }) } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'STARA ODPOWIEDŹ' },
        ]));
        const tile = findByClass(container, 'cs-tile--agent');
        const head = tile && findByClass(tile, 'cs-tile__head');
        (head?.listeners.click || []).forEach(cb => cb({}));
        const details = tile && findByClass(tile, 'cs-tile__details');
        t.true(details?.textContent.includes('STARA ODPOWIEDŹ') ?? false);
    });
});

// ── Dodatkowo (spec A3, "Czat bez ścian"): render historii i render na żywo dla wiadomości
// maszynowej - okno renderuje .cs-tile--system i NIE renderuje .cs-message--user. Ten sam
// FakeEl/withFakeDocument co test wyżej - atrapa `document` harnessu ma classList jako no-op,
// więc weryfikacja klas kafelka wymaga własnej, minimalnej atrapy z prawdziwym classList.

// Uwaga 6 (spec A3-fix, recenzja A3): treść tych dwóch testów NIE zaczyna się od stałego
// prefiksu nagłówka maszynowego - gdyby ktoś kiedyś zepsuł ścieżkę meta-first
// (`classifyMachineMessage`'s `msg._subTaskNotification`/`_artifactSummon`), fallback po TREŚCI
// NIE MA JAK uratować tego testu (treść nie pasuje do żadnego wzorca), więc test naprawdę mierzy
// klasyfikację przez metę, nie przypadkiem obie ścieżki naraz.

test.serial('render_messages: wiadomość maszynowa (_subTaskNotification) renderuje .cs-tile--system zwinięty, bez stopki, bez JSON-a, NIE .cs-message--user', async t => {
    await withFakeDocument(async () => {
        const container = makeFakeEl('div');
        // Treść celowo BEZ prefiksu "[POWIADOMIENIE SYSTEMU] Sub-agent ..." - klasyfikacja musi
        // zajść WYŁĄCZNIE przez `_subTaskNotification: true`.
        const text = 'Wynik pracy w tle: gotowe, 3 notatki.';
        const messages: TestDynamic[] = [
            { role: 'user', content: text, _subTaskNotification: true, timestamp: '12:00' },
        ];
        const fakeThis = buildFakeThis(container, messages);

        await render_messages.call(fakeThis);

        const tile = findByClass(container, 'cs-tile--system');
        t.truthy(tile, 'brak kafelka systemowego .cs-tile--system');
        t.falsy(findByClass(container, 'cs-message--user'), 'wiadomość maszynowa NIE ma prawa renderować się jako dymek usera');

        const body = findByClass(tile!, 'cs-tile__body');
        t.truthy(body, 'kafelek musi miec .cs-tile__body strukturalnie zawsze');
        t.true(body!.hasAttribute('hidden'), 'kafelek sukcesu ma zostac ZWINIETY domyslnie');

        // Details renderuja sie LENIWIE - dopiero PIERWSZE rozwiniecie je buduje (Tile.ts).
        // Zwiniety kafelek ma details puste z definicji, wiec sprawdzenie tresci wymaga
        // rozwiniecia - dokladnie jak w probes/probe-render.mts recenzenta. Ten FakeEl (inaczej
        // niz w Tile.test.ts) nie ma metody `fire` - listenery odpalamy wprost.
        const head = findByClass(tile!, 'cs-tile__head');
        (head?.listeners.click || []).forEach(cb => cb({}));
        const details = findByClass(tile!, 'cs-tile__details');
        t.truthy(details);
        const footer = translate('chat.subagent_notification.footer');
        t.false(details!.textContent.includes(footer), 'stopka-instrukcja dla modelu nie ma prawa trafic do DOM-u');
        t.false(details!.textContent.includes('{'), 'zaden fragment JSON-a nie ma prawa trafic do DOM-u');
        t.falsy(findByClass(tile!, 'cs-tile__actions'), 'powiadomienie suba nie niesie akcji - brak rzedu akcji w DOM');
    });
});

test.serial('append_message: przywołanie artefaktu na żywo (_artifactSummon) renderuje .cs-tile--system zwinięty, bez JSON-a, NIE .cs-message--user', async t => {
    await withFakeDocument(async () => {
        const container = makeFakeEl('div');
        const messages: TestDynamic[] = [];
        const fakeThis = buildFakeThis(container, messages);
        fakeThis.rollingWindow.addMessage = async () => {};
        fakeThis.updateTokenCounter = () => {};

        // Treść celowo BEZ prefiksu "📄 Artefakt ..." - klasyfikacja musi zajść WYŁĄCZNIE przez
        // `_artifactSummon: true`.
        const text = 'Notatka zaktualizowana przez agenta, bez nagłówka przywołania.';
        await append_message.call(fakeThis, 'user', text, undefined, { _artifactSummon: true, origin: 'machine' });

        const tile = findByClass(container, 'cs-tile--system');
        t.truthy(tile, 'brak kafelka systemowego .cs-tile--system');
        t.falsy(findByClass(container, 'cs-message--user'), 'przywołanie artefaktu NIE ma prawa renderować się jako dymek usera');

        const body = findByClass(tile!, 'cs-tile__body');
        t.truthy(body);
        t.true(body!.hasAttribute('hidden'), 'kafelek przywolania (status ok) ma zostac ZWINIETY domyslnie');

        const head = findByClass(tile!, 'cs-tile__head');
        (head?.listeners.click || []).forEach(cb => cb({}));
        const details = findByClass(tile!, 'cs-tile__details');
        t.truthy(details);
        t.false(details!.textContent.includes('{'), 'zaden fragment JSON-a nie ma prawa trafic do DOM-u');
    });
});

for (const sample of [
    { name: 'live metadata', text: 'Utworzono folder TEST-U3. Efekt niezweryfikowany.', meta: { _loopPartial: true } },
    { name: 'restored system receipt', text: 'Częściowy wynik tej tury\n\nUtworzono folder TEST-U3. Efekt niezweryfikowany.', meta: {} },
]) {
    test.serial('render_messages: loop partial survives history render - ' + sample.name, async t => {
        await withFakeDocument(async () => {
            const container = makeFakeEl('div');
            const view = buildFakeThis(container, [{ role: 'system', content: sample.text, ...sample.meta }]);
            await render_messages.call(view);
            t.is(container.children.length, 1, 'exactly one visible receipt');
            const tile = findByClass(container, 'cs-tile--system');
            t.true(Boolean(tile), 'partial is a system tile');
            const head = tile && findByClass(tile, 'cs-tile__head');
            (head?.listeners.click || []).forEach(cb => cb({}));
            const details = tile && findByClass(tile, 'cs-tile__details');
            t.is(details?.textContent, sample.text);
        });
    });
}

test.serial('render_messages: sub_agent task, pokwitowanie, list i odmowa maja wlasciwe bloki i chipy', async t => {
    await withFakeDocument(async () => {
        const render = async (output: unknown, args: Record<string, unknown>) => {
            const container = makeFakeEl();
            await render_messages.call(buildFakeThis(container, [
                { role: 'assistant', content: '', tool_calls: [{ id: 'sub-call', function: { name: 'sub_agent', arguments: JSON.stringify(args) } }] },
                { role: 'tool', tool_call_id: 'sub-call', content: JSON.stringify(output) },
            ]));
            return container;
        };
        const partialContainer = await render({ success: false, aspect: 'literal-sub', outcome: { end: 'limit' }, error: 'limit', partial_result: 'dorobek' }, { action: 'task', task: 'zadanie' });
        const partial = findByClass(partialContainer, 'cs-tile--agent');
        t.truthy(partial);
        t.true(partial!.classList.contains('cs-tile--error'));
        t.true(findByClass(partial!, 'cs-tile__title')?.textContent.includes('literal-sub') ?? false);

        const receiptContainer = await render({ started: true, success: true, task_id: 'sub/id#7', sub_id: 'sub/worker' }, { action: 'task', task: 'zadanie' });
        const receipt = findByClass(receiptContainer, 'cs-tile--agent');
        t.truthy(receipt);
        t.is(findByClass(receipt!, 'cs-tile__title')?.textContent, 'Sent to background: sub/worker');
        const receiptDetails = findByClass(receipt!, 'cs-tile__details');
        t.truthy(receiptDetails);
        const receiptHead = findByClass(receipt!, 'cs-tile__head');
        (receiptHead?.listeners.click || []).forEach(cb => cb({}));
        t.true(deepText(receiptDetails!).trimEnd().endsWith('sub/id#7'));

        const fallbackContainer = await render({ success: true, outcome: { end: 'done' }, sub_id: 'sub/fallback', result: 'gotowe' }, { action: 'task', task: 'zadanie', aspect: 'wrong-args-name' });
        const fallback = findByClass(fallbackContainer, 'cs-tile--agent');
        t.truthy(fallback);
        t.is(findByClass(fallback!, 'cs-tile__title')?.textContent, 'Sub-agent sub/fallback');

        const listContainer = await render({ success: true, threads: [] }, { action: 'list' });
        t.truthy(findByClass(listContainer, 'cs-tile--ok'));

        const deniedContainer = await render({ success: false, error: 'odmowa' }, { action: 'task' });
        t.truthy(findByClass(deniedContainer, 'cs-tile--error'));
        t.falsy(findByClass(deniedContainer, 'cs-tile--agent'));
    });
});
