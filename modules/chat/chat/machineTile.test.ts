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
import { renderMachineTile } from './machineTile.js';
import { setNoteOpener } from '../../ui-components/index.js';
import type { MachineView } from './machineMessage.js';

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
