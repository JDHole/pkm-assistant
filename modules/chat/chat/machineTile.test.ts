/**
 * `renderMachineTile` (uwaga 5, spec A3-fix - fuzja trzech dawnych kopii w `chat_messages.ts`/
 * `chat_streaming.ts` w JEDNĄ implementację) przez behawior, nie przez source-regex:
 *
 * - B2 (recenzja A3-fix): artefakt nieznany sklepowi -> przycisk "Otwórz" WIDOCZNY, ale
 *   `disabled`, z tooltipem i18n; artefakt znany -> przycisk aktywny.
 * - Uwaga 4 (spec A3-fix): klik robi TYLKO `plugin.openNote(path)` - zero innych wywołań na
 *   atrapie pluginu (bez `activateArtifactInChat`, bez przypinania, bez odsłaniania panelu).
 *
 * `renderMachineTile` ciągnie `obsidian` przechodnio przez barrel `ui-components` - w AVA
 * ratuje to atrapa z preloadu harnessu; własna atrapa `document` jest identyczna z `Tile.test.ts`.
 */
import test from 'ava';
import { readFileSync } from 'node:fs';
import { renderMachineTile } from './machineTile.js';
import { buildMachineView } from './machineMessage.js';
import { buildSubTaskNotificationText } from './subTaskNotification.js';
import { buildSubTaskQuestionDelivery } from './subTaskQuestionDelivery.js';
import { buildSubTaskResultDelivery } from './subTaskResultDelivery.js';
import { setLocale, t as translate } from '../../../core/i18n/index.js';
import { setNoteOpener } from '../../ui-components/index.js';
import type { MachineView } from './machineMessage.js';
import { SubAgentRunner, SubTaskRegistry } from '../../sub-agents/index.js';
import { QuestionTestClock } from '../../sub-agents/test-support/questionTestClock.js';
import type { SubTask } from '../../sub-agents/index.js';

type Listener = (ev: unknown) => void;

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    parent: FakeEl | null;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    listeners: Record<string, Listener[]>;
    appendText(t: string): void;
    empty(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    appendChild(child: FakeEl): FakeEl;
    createDiv(opts?: { cls?: string }): FakeEl;
    createSpan(opts?: { cls?: string }): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    remove(): void;
    addEventListener(type: string, cb: Listener): void;
    fire(type: string, ev?: unknown): void;
};

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
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
        set textContent(v: string) { text = v; el.children.forEach(c => { c.parent = null; }); el.children = []; },
        appendText(t2) { text += t2; },
        empty() { text = ''; el.children.forEach(c => { c.parent = null; }); el.children = []; },
        setAttribute(name, value) { attrs.set(name, value); },
        getAttribute(name) { return attrs.has(name) ? attrs.get(name)! : null; },
        removeAttribute(name) { attrs.delete(name); },
        hasAttribute(name) { return attrs.has(name); },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        createDiv(opts) { const child = makeFakeEl('div'); if (opts?.cls) child.className = opts.cls; return el.appendChild(child); },
        createSpan(opts) { const child = makeFakeEl('span'); if (opts?.cls) child.className = opts.cls; return el.appendChild(child); },
        insertBefore(child, ref) {
            child.parent = el;
            const idx = ref ? el.children.indexOf(ref) : -1;
            if (ref && idx >= 0) el.children.splice(idx, 0, child);
            else el.children.push(child);
            return child;
        },
        remove() { if (el.parent) { el.parent.children = el.parent.children.filter(c => c !== el); el.parent = null; } },
        listeners: {},
        addEventListener(type, cb) { (el.listeners[type] ||= []).push(cb); },
        fire(type, ev = {}) { (el.listeners[type] || []).forEach(cb => cb(ev)); },
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

function deepText(root: FakeEl): string { return root.textContent + root.children.map(deepText).join(''); }

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

function baseView(over: Partial<MachineView> = {}): MachineView {
    return {
        kind: 'artifact_summon',
        title: 'Artefakt: Plan',
        summary: 'plan, Do akceptacji',
        details: 'Kroki\n✓ Zrobić A',
        open: { label: 'Otwórz', artifactId: 'art-1' },
        status: 'ok',
        ...over,
    };
}

function fakePlugin(calls: string[], storeResult: { path?: string } | null): TestDynamic {
    return {
        artifactStore: { read: async (id: string) => { calls.push(`read:${id}`); return storeResult; } },
        openNote: async (p: string) => { calls.push(`openNote:${p}`); },
        openChatView: () => { calls.push('openChatView'); },
        app: { workspace: { getLeavesOfType: () => { calls.push('getLeavesOfType'); return []; } } },
    };
}

test.serial('renderMachineTile: artefakt nieznany sklepowi - przycisk WIDOCZNY, disabled, z tooltipem i18n; klik nic nie wywoluje', async t => {
    await withFakeDocument(async () => {
        const calls: string[] = [];
        const container = makeFakeEl('div');
        await renderMachineTile(container as unknown as HTMLElement, fakePlugin(calls, null), baseView());

        const btn = findByClass(container, 'cs-tile__action');
        t.truthy(btn, 'przycisk "Otworz" musi zostac WIDOCZNY, nawet gdy sciezka nieznana (B2)');
        t.is(btn!.textContent, 'Otwórz');
        t.true(btn!.hasAttribute('disabled'));
        t.truthy(btn!.getAttribute('title'), 'tooltip i18n musi byc ustawiony');

        calls.length = 0;
        btn!.fire('click');
        t.deepEqual(calls, [], 'disabled - klik nie ma prawa wywolac zadnego callbacku');
    });
});

test.serial('renderMachineTile: artefakt znany sklepowi - przycisk aktywny, klik robi TYLKO openNote (uwaga 4)', async t => {
    await withFakeDocument(async () => {
        const calls: string[] = [];
        const container = makeFakeEl('div');
        await renderMachineTile(container as unknown as HTMLElement, fakePlugin(calls, { path: 'Artefakty/Plan.md' }), baseView());

        const btn = findByClass(container, 'cs-tile__action');
        t.truthy(btn);
        t.false(btn!.hasAttribute('disabled'));

        calls.length = 0;
        btn!.fire('click');
        await new Promise(r => setTimeout(r, 0));
        t.deepEqual(calls, ['openNote:Artefakty/Plan.md'], 'klik ma wywolac WYLACZNIE openNote - bez activateArtifactInChat/openChatView/getLeavesOfType');
    });
});

test.serial('renderMachineTile: z zarejestrowanym openerem klik Otworz idzie przez opener (jak linki notatek), openNote nietkniete', async t => {
    await withFakeDocument(async () => {
        const opened: string[] = [];
        setNoteOpener((path) => { opened.push(path); });
        try {
            const calls: string[] = [];
            const container = makeFakeEl('div');
            await renderMachineTile(container as unknown as HTMLElement, fakePlugin(calls, { path: 'Artefakty/Plan.md' }), baseView());
            const btn = findByClass(container, 'cs-tile__action');
            t.truthy(btn);
            calls.length = 0;
            btn!.fire('click');
            await new Promise(r => setTimeout(r, 0));
            t.deepEqual(opened, ['Artefakty/Plan.md'], 'opener dostaje dokladna sciezke notatki artefaktu');
            t.deepEqual(calls, [], 'z openerem plugin.openNote nie jest wolane');
        } finally {
            setNoteOpener(null);
        }
    });
});

test.serial('renderMachineTile: view.open nieobecny (np. powiadomienie suba) - kafelek bez akcji', async t => {
    await withFakeDocument(async () => {
        const calls: string[] = [];
        const container = makeFakeEl('div');
        await renderMachineTile(container as unknown as HTMLElement, fakePlugin(calls, null), baseView({ open: undefined, kind: 'subtask_notification' }));

        t.falsy(findByClass(container, 'cs-tile__action'), 'bez view.open nie ma prawa powstac zaden przycisk akcji');
        t.deepEqual(calls, [], 'sklep artefaktow nie ma prawa byc odpytany, gdy nie ma akcji Otworz');
    });
});

test.serial('renderMachineTile: artefakt bez view.open (JSON bez id) - przycisk WIDOCZNY, disabled, tooltip i18n, sklep nieodpytany', async t => {
    await withFakeDocument(async () => {
        const calls: string[] = [];
        const container = makeFakeEl('div');
        await renderMachineTile(container as unknown as HTMLElement, fakePlugin(calls, null), baseView({ open: undefined, kind: 'artifact_summon' }));

        const btn = findByClass(container, 'cs-tile__action');
        t.truthy(btn, 'B2: bez id przycisk ma byc WIDOCZNY, nie nieobecny');
        t.true(btn!.hasAttribute('disabled'));
        t.is(btn!.getAttribute('title'), 'Artifact note is not known');
        t.is(btn!.textContent, 'Open');
        t.deepEqual(calls, [], 'bez id sklep artefaktow nie jest odpytywany');
    });
});

test.serial('renderMachineTile: kafelek ma klase .cs-tile--system i poprawny status', async t => {
    await withFakeDocument(async () => {
        const calls: string[] = [];
        const container = makeFakeEl('div');
        await renderMachineTile(container as unknown as HTMLElement, fakePlugin(calls, null), baseView({ status: 'error' }));

        const tile = findByClass(container, 'cs-tile--system');
        t.truthy(tile);
        t.true(tile!.classList.contains('cs-tile--error'));
    });
});

// Odczyt zwycięskiej deklaracji z rzeczywistego arkusza dla klas zwróconych przez renderer.
// W teście Node nie ma silnika CSS, więc uwzględniamy kolejność i specyficzność prostych
// selektorów klas, które ustawiają zmienną koloru kafelka.
function tileColor(tile: FakeEl): string | null {
    const css = readFileSync(new URL('../chat_view.css', import.meta.url), 'utf8');
    let winner: { specificity: number; order: number; value: string } | null = null;
    const rules = /([^{}]+)\{([^{}]*)\}/g;
    for (const [order, match] of [...css.matchAll(rules)].entries()) {
        const value = match[2].match(/(?:^|;)\s*--cs-tile-color:\s*([^;]+);/);
        if (!value) continue;
        for (const selector of match[1].split(',')) {
            const simple = selector.trim();
            if (!/^(?:\.[\w-]+)+$/.test(simple)) continue;
            const classes = [...simple.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
            if (!classes.every(cls => tile.classList.contains(cls))) continue;
            if (!winner || classes.length > winner.specificity || (classes.length === winner.specificity && order > winner.order)) {
                winner = { specificity: classes.length, order, value: value[1].trim() };
            }
        }
    }
    return winner?.value ?? null;
}

test.serial('renderMachineTile: sukces subagenta nie jest czerwony, blad i przerwanie sa czerwone', async t => {
    await withFakeDocument(async () => {
        for (const status of ['done', 'error', 'aborted'] as const) {
            const task = {
                id: 'sub/pkm-explorer#1', name: 'pkm-explorer', agentName: 'Kuba', status,
                createdAt: 1000, endedAt: 2000, steps: [], budget: {}, background: true,
                result: status === 'done' ? { text: 'Dokument przeczytany.', toolsUsed: [], durationMs: 1000, usage: null } : undefined,
                error: status === 'error' ? 'Blad odczytu' : undefined,
            } as SubTask;
            const content = buildSubTaskNotificationText(task);
            const view = buildMachineView({ role: 'user', content, _subTaskNotification: true }, { t: translate });
            t.truthy(view);
            const container = makeFakeEl();
            await renderMachineTile(container as unknown as HTMLElement, fakePlugin([], null), view!);
            const tile = findByClass(container, 'cs-tile--system');
            t.truthy(tile);
            t.true(tile!.classList.contains(status === 'done' ? 'cs-tile--ok' : 'cs-tile--error'));
            t.is(tileColor(tile!), status === 'done' ? 'var(--color-green)' : 'var(--color-red)', status);
        }
    });
});

test.serial('renderMachineTile: ramka wyniku suba używa SubAgentBlock z rolą systemową', async t => {
    await withFakeDocument(async () => {
        const container = makeFakeEl('div');
        const view = baseView({ kind: 'subtask_notification', subAgentResult: {
            title: 'badacz skończył sam', badge: 'wynik niesprawdzony', status: 'ok', material: 'DOROBEK',
            missingTargets: [], effects: [], notes: [],
        } });
        await renderMachineTile(container as unknown as HTMLElement, fakePlugin([], null), view);
        const tile = findByClass(container, 'cs-tile--system');
        t.truthy(tile);
        t.is(findByClass(tile!, 'cs-tile__title')?.textContent, 'badacz skończył sam');
        t.is(findByClass(tile!, 'cs-tile__badge')?.textContent, 'wynik niesprawdzony');
        findByClass(tile!, 'cs-tile__head')!.fire('click');
        const result = findByClass(tile!, 'cs-subresult');
        t.truthy(result);
        t.true(deepText(result!).includes('DOROBEK'));
    });
});


test.serial('pytanie suba przechodzi przez delivery, klasyfikator i render w PL i EN', async t => {
    await withFakeDocument(async () => {
        for (const [locale, title] of [['pl', 'Pytanie sub-agenta Badacz'], ['en', 'Question from sub-agent Badacz']] as const) {
            setLocale(locale);
            const delivery = buildSubTaskQuestionDelivery({ id: 'q1', taskId: 'task1', subId: 'sub1', name: 'Badacz', text: 'Który katalog wybrać?', owner: { agentName: 'Lead', sessionPath: 'a', sessionEpoch: 'b' }, askedAt: 1 } as never);
            for (const meta of [delivery.meta, {}]) {
                const view = buildMachineView({ role: 'user', content: delivery.text, ...meta }, { t: translate, getTask: () => ({ taskPreview: 'Sprawdź notatki' }) });
                t.is(view?.kind, 'subtask_question');
                const container = makeFakeEl();
                await renderMachineTile(container as unknown as HTMLElement, fakePlugin([], null), view!);
                const tile = findByClass(container, 'cs-tile--subquestion');
                t.truthy(tile);
                t.true(tile!.classList.contains('cs-tile--attention'));
                t.is(tileColor(tile!), 'var(--text-warning)');
                findByClass(container, 'cs-tile__head')?.fire('click');
                t.truthy(findByClass(container, 'cs-sub-question__text'));
                const rendered = deepText(container);
                t.true(rendered.includes(title));
                t.true(rendered.includes('Sprawdź notatki'));
                t.true(rendered.includes('Który katalog wybrać?'));
                t.false(rendered.includes('skończył w tle'));
                t.false(rendered.includes('finished in the background'));
            }
        }
        setLocale('en');
    });
});

test.serial('brak odpowiedzi: dorobek i jedno pytanie w wyniku żywym oraz historii PL i EN', async t => {
    await withFakeDocument(async () => {
        for (const locale of ['pl', 'en'] as const) {
            setLocale(locale);
            const question = 'Którą wersję planu wybrać?';
            const runner = locale === 'pl' ? `Sub nie dostał odpowiedzi na pytanie: ${question}` : `The sub-agent received no answer to the question: ${question}`;
            const tool = 'read | Notatki/Plan Q4.md | {"success":true}';
            const task = { id: 'task1', name: 'pkm-sub', agentName: 'Lead', status: 'done', background: true, createdAt: 1, steps: [], budget: {}, outcome: { end: { kind: 'timeout' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] }, result: { text: `${runner}\n\nTool results, newest first\n${tool}`, toolsUsed: ['read'], durationMs: 1, usage: null, question: { text: question, resolution: { kind: 'no-answer' } } } } as SubTask;
            const delivery = buildSubTaskResultDelivery(task, undefined, 0);
            for (const meta of [delivery.meta, {}]) {
                const view = buildMachineView({ role: 'user', content: delivery.text, ...meta }, { t: translate });
                const container = makeFakeEl();
                await renderMachineTile(container as unknown as HTMLElement, fakePlugin([], null), view!);
                const tile = findByClass(container, 'cs-tile--subresult')!;
                t.true(tile.classList.contains('cs-tile--attention'));
                t.is(tileColor(tile), 'var(--text-warning)');
                findByClass(tile, 'cs-tile__head')!.fire('click');
                const rendered = deepText(tile);
                t.is(rendered.split(question).length - 1, 1);
                const badge = locale === 'pl' ? 'brak odpowiedzi' : 'no answer';
                t.is(deepText(findByClass(tile, 'cs-tile__head')!).toLowerCase().split(badge).length - 1, 1);
                t.true(deepText(findByClass(tile, 'cs-subresult')!).includes(tool));
                t.false(rendered.includes(runner));
                t.false(rendered.includes(locale === 'pl' ? 'czas na odpowiedź upłynął' : 'response time expired'));
                t.truthy(findByClass(tile, 'cs-subresult__question'));
            }
        }
        setLocale('en');
    });
});

for (const scenario of ['partial', 'success'] as const) test.serial(`delivery i render PL i EN: ${scenario}`, async t => {
    await withFakeDocument(async () => {
        for (const locale of ['pl', 'en'] as const) {
            setLocale(locale);
            const question = 'Pierwszy akapit?\n\nDrugi akapit z wyborem A lub B?';
            const runner = locale === 'pl' ? `Sub nie dostał odpowiedzi na pytanie: ${question}` : `The sub-agent received no answer to the question: ${question}`;
            const tool = 'read | Plan.md | OK';
            const base = { id: 'task1', name: 'pkm-sub', agentName: 'Lead', status: 'done', background: true, createdAt: 1, steps: [], budget: {} };
            const partial = { ...base, outcome: { end: { kind: 'timeout' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] }, result: { text: `${runner}\n\n${tool}`, toolsUsed: ['read'], durationMs: 1, usage: null, question: { text: question, resolution: { kind: 'no-answer' } } } } as SubTask;
            const quote = locale === 'pl' ? 'Brak odpowiedzi: czas na odpowiedź upłynął.\nOtwarte pytanie: CYTAT - wybierz folder?' : 'No answer: response time expired.\nOpen question: CYTAT - wybierz folder?';
            const material = `Dokumentacja:\n\n\`\`\`\n\n${quote}\n\n\`\`\``;
            const success = { ...base, outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] }, result: { text: material, toolsUsed: [], durationMs: 1, usage: null } } as SubTask;
            for (const task of [scenario === 'partial' ? partial : success]) {
                const delivery = buildSubTaskResultDelivery(task, undefined, 0);
                for (const meta of [delivery.meta, {}]) {
                    const view = buildMachineView({ role: 'user', content: delivery.text, ...meta }, { t: translate });
                    const container = makeFakeEl();
                    await renderMachineTile(container as unknown as HTMLElement, fakePlugin([], null), view!);
                    const tile = findByClass(container, 'cs-tile--subresult')!;
                    findByClass(tile, 'cs-tile__head')!.fire('click');
                    const rendered = deepText(tile);
                    t.false(rendered.includes('[SUBTASK_QUESTION'));
                    t.false(rendered.includes('[/SUBTASK_QUESTION]'));
                    if (task === partial) {
                        t.true(tile.classList.contains('cs-tile--attention'));
                        t.is(view!.subAgentResult!.title, locale === 'pl' ? 'Wynik pkm-sub' : 'Result pkm-sub');
                        t.is(view!.subAgentResult!.openQuestion, question);
                        t.is(rendered.split(question).length - 1, 1);
                        t.true(rendered.includes(tool));
                        t.false(rendered.includes(runner));
                    } else {
                        t.true(tile.classList.contains('cs-tile--ok'));
                        t.is(view!.subAgentResult!.openQuestion, undefined);
                        t.true(rendered.includes(material));
                    }
                }
            }
        }
        setLocale('en');
    });
});

test.serial('historia pytania z reusable thread zachowuje pytanie i instrukcję wątku', async t => {
    await withFakeDocument(async () => {
        setLocale('pl');
        const question = 'Pierwszy akapit?\n\nDrugi akapit?';
        const task = { id: 'task1', name: 'pkm-sub', agentName: 'Lead', status: 'done', background: true, createdAt: 1, steps: [], budget: {}, outcome: { end: { kind: 'timeout' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] }, result: { text: `Sub nie dostał odpowiedzi na pytanie: ${question}\n\nread | Plan.md | OK`, toolsUsed: ['read'], durationMs: 1, usage: null, question: { text: question, resolution: { kind: 'no-answer' } } } } as SubTask;
        const text = buildSubTaskNotificationText(task, { subId: 'sub/pkm#1', maxResultChars: 0 });
        const view = buildMachineView({ role: 'user', content: text }, { t: translate, getThread: () => ({ phase: 'idle', reusable: true }) });
        t.is(view!.subAgentResult!.openQuestion, question);
        t.true(view!.subAgentResult!.notes.includes('Agent może dokończyć tym samym subem'));
        const container = makeFakeEl();
        await renderMachineTile(container as unknown as HTMLElement, fakePlugin([], null), view!);
        const tile = findByClass(container, 'cs-tile--subresult')!;
        findByClass(tile, 'cs-tile__head')!.fire('click');
        t.is(deepText(tile).split(question).length - 1, 1);
        t.true(deepText(tile).includes('read | Plan.md | OK'));
        setLocale('en');
    });
});

test.serial('wynik z question renderuje brak odpowiedzi bez rejestru', async t => {
    await withFakeDocument(async () => {
        setLocale('pl');
        const task = { id: 'task1', name: 'Badacz', agentName: 'Lead', status: 'done', background: true, createdAt: 1, steps: [], budget: {}, outcome: { end: { kind: 'timeout' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] }, result: { text: '', toolsUsed: [], durationMs: 1, usage: null, question: { text: 'Który katalog?', resolution: { kind: 'no-answer' } } } } as SubTask;
        const delivery = buildSubTaskResultDelivery(task, undefined, 10);
        const view = buildMachineView({ role: 'user', content: delivery.text, ...delivery.meta }, { t: translate });
        const container = makeFakeEl();
        await renderMachineTile(container as unknown as HTMLElement, fakePlugin([], null), view!);
        findByClass(container, 'cs-tile__head')?.fire('click');
        const rendered = deepText(container);
        t.true(rendered.includes('brak odpowiedzi'));
        t.true(rendered.includes('Otwarte pytanie: Który katalog?'));
        setLocale('en');
    });
});


for (const scenario of ['long', 'trailing'] as const) test.serial(`delivery i render: ${scenario}`, async t => {
    await withFakeDocument(async () => {
        for (const locale of ['pl', 'en'] as const) {
            setLocale(locale);
            const question = `UNIKALNY_POCZĄTEK ${'bardzo długie pytanie '.repeat(1100)} KONIEC?`;
            const clock = new QuestionTestClock();
            const registry = new SubTaskRegistry({ questionClock: clock });
            const read = { name: 'read', description: 'read', inputSchema: {}, execute: async () => 'DOROBEK_NARZĘDZIA' };
            const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry }, toolRegistry: { filterByAgent: () => [read], getTool: () => read } });
            let ready!: () => void;
            const waiting = new Promise<void>(resolve => { ready = resolve; });
            let calls = 0;
            const model = { stream(_payload: unknown, cb: { done(value: unknown): void }) {
                const call = calls++ === 0
                    ? { id: 'r', type: 'function', function: { name: 'read', arguments: '{}' } }
                    : { id: 'q', type: 'function', function: { name: 'ask_parent', arguments: JSON.stringify({ text: question }) } };
                cb.done({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [call] } }] });
            } };
            const run = runner.runTask('zadanie', { name: 'Lead' }, { name: 'Badacz', tools: ['read'] } as never, model as never,
                { origin: { agentName: 'Lead', sessionPath: 'a', sessionEpoch: 'b' }, onActivity: activity => { if (activity.kind === 'waiting') ready(); } });
            await Promise.race([waiting, run.then(() => { throw new Error('runner nie otworzył pytania'); })]);
            clock.advance(300000);
            const result = await run;
            t.is(result.question?.text, question);
            const task = registry.list()[0];
            t.true(task.result!.handoff!.includes('DOROBEK_NARZĘDZIA'));
            const shortQuestion = 'First?\n\nSecond?\n\n';
            const sentence = translate('subagent.question_no_answer', { question: shortQuestion });
            const onlySentence = { ...task, questionState: { kind: 'none' as const }, result: { ...task.result!, text: sentence, handoff: sentence, question: { text: shortQuestion, resolution: { kind: 'no-answer' as const } } } };
            for (const [candidate, expectedQuestion, material] of [scenario === 'long' ? [task, question, 'DOROBEK_NARZĘDZIA'] as const : [onlySentence, shortQuestion, ''] as const]) {
                for (const reusable of [false, true]) {
                    const deliveryRegistry = reusable ? { getThread: () => ({ phase: 'idle', reusable: true, effects: [] }) } : undefined;
                    const delivery = buildSubTaskResultDelivery(candidate, deliveryRegistry as never, 0);
                    for (const meta of [delivery.meta, {}]) for (const withRegistry of [false, true]) {
                        const view = buildMachineView({ role: 'user', content: delivery.text, ...meta }, { t: translate, ...(withRegistry ? { getTask: () => candidate, getThread: () => ({ phase: 'idle', reusable: true }) } : {}) });
                        const container = makeFakeEl();
                        await renderMachineTile(container as unknown as HTMLElement, fakePlugin([], null), view!);
                        const tile = findByClass(container, 'cs-tile--subresult')!;
                        findByClass(tile, 'cs-tile__head')!.fire('click');
                        const rendered = deepText(tile);
                        t.is(view!.subAgentResult!.openQuestion, expectedQuestion);
                        t.is(rendered.split(expectedQuestion).length - 1, 1);
                        t.is(rendered.split(expectedQuestion.slice(0, 6)).length - 1, 1);
                        if (material) t.true(view!.subAgentResult!.material!.includes(material));
                        else t.is(view!.subAgentResult!.material, undefined);
                    }
                }
            }
            registry.dispose();
        }
        setLocale('en');
    });
});
