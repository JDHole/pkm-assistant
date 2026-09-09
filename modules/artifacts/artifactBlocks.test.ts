import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { isBlockBoundToNote, parseArtifactBlockId, registerArtifactBlocks } from './artifactBlocks.js';

setLocale('pl');

// Blok ```pkm-artefakt``` bez tej bramki renderowałby guziki dla DOWOLNEGO id wpisanego w jego
// treść - także artefaktu innego agenta, w dowolnej notatce vaulta. User widziałby „✅ Zatwierdź" w
// kontekście SWOJEJ notatki i jednym klikiem przestawiałby status cudzego planu (+ przywoływał
// tamtego agenta). Bramką jest ścieżka: blok żyje wyłącznie w notatce swojego artefaktu.

const OWN = 'PKM Assistant/Artefakty/Jaskier/2026-08-22 Plan.md';
const FOREIGN = 'PKM Assistant/Artefakty/Igor/2026-08-22 Plan Igora.md';

/** Atrapa store'a: `pathById` to jedyne źródło prawdy o właścicielu bloku. */
function makeStore() {
    const calls: string[] = [];
    const store = {
        pathById: (id: string) => (id === 'art-wlasny' ? OWN : id === 'art-obcy' ? FOREIGN : null),
        read: async (id: string) => {
            calls.push(`read:${id}`);
            return { id, typ: 'plan', status: 'do-akceptacji', tytul: 'Plan' };
        },
        update: async (id: string) => { calls.push(`update:${id}`); return { applied: 1, errors: [], artifact: null }; },
    };
    return { store, calls };
}

// ── Atrapa elementu Obsidiana (createDiv/createSpan/createEl) ──────────────────
interface FakeEl {
    tag: string;
    cls: string;
    text: string;
    children: FakeEl[];
    disabled: boolean;
    createDiv(o?: { cls?: string; text?: string }): FakeEl;
    createSpan(o?: { cls?: string; text?: string }): FakeEl;
    createEl(tag: string, o?: { cls?: string; text?: string }): FakeEl;
    addEventListener(ev: string, fn: () => unknown): void;
}

function fakeEl(tag = 'div'): FakeEl {
    const el: FakeEl = {
        tag,
        cls: '',
        text: '',
        children: [],
        disabled: false,
        createDiv(o = {}) { return el.createEl('div', o); },
        createSpan(o = {}) { return el.createEl('span', o); },
        createEl(t2: string, o: { cls?: string; text?: string } = {}) {
            const child = fakeEl(t2);
            child.cls = o.cls || '';
            child.text = o.text || '';
            el.children.push(child);
            return child;
        },
        addEventListener() { /* klik nie jest tu potrzebny */ },
    };
    return el;
}

/** Wyrenderuj blok i oddaj drzewko + ślad wywołań store'a. */
async function render(source: string, sourcePath: string | undefined) {
    const { store, calls } = makeStore();
    let handler: ((src: string, el: FakeEl, ctx: { sourcePath?: string }) => Promise<void>) | null = null;
    const plugin = {
        artifactStore: store,
        agentManager: { artifactTypeLoader: { getType: () => ({ statusy: ['do-akceptacji', 'uwagi', 'zaakceptowany', 'zamkniety'] }) } },
        registerMarkdownCodeBlockProcessor: (_name: string, fn: typeof handler) => { handler = fn; },
    };
    registerArtifactBlocks(plugin);
    const el = fakeEl();
    await handler!(source, el, { sourcePath });
    const root = el.children[0]!;
    const flat: FakeEl[] = [];
    const walk = (n: FakeEl) => { flat.push(n); n.children.forEach(walk); };
    walk(root);
    return { root, flat, calls };
}

test('isBlockBoundToNote — własna notatka TAK, cudza NIE', t => {
    const { store } = makeStore();
    t.true(isBlockBoundToNote('art-wlasny', OWN, store));
    t.false(isBlockBoundToNote('art-obcy', OWN, store), 'cudze id w mojej notatce = nie związane');
    t.false(isBlockBoundToNote('art-wlasny', FOREIGN, store), 'moje id w cudzej notatce = nie związane');
});

test('isBlockBoundToNote — nieznane id / brak ścieżki / brak store = fail-closed', t => {
    const { store } = makeStore();
    t.false(isBlockBoundToNote('art-nieznany', OWN, store));
    t.false(isBlockBoundToNote('art-wlasny', undefined, store));
    t.false(isBlockBoundToNote('art-wlasny', OWN, null));
    t.false(isBlockBoundToNote('', OWN, store));
});

test('isBlockBoundToNote — porównanie po ścieżce KANONICZNEJ (backslashe, ./ , wiodący /)', t => {
    const { store } = makeStore();
    t.true(isBlockBoundToNote('art-wlasny', OWN.replace(/\//g, '\\'), store));
    t.true(isBlockBoundToNote('art-wlasny', `./${OWN}`, store));
    t.true(isBlockBoundToNote('art-wlasny', `/${OWN}`, store));
});

test('blok z CUDZYM id renderuje się nieaktywnie — zero guzików, zero wywołań store', async t => {
    const { root, flat, calls } = await render('id: art-obcy', OWN);
    t.is(flat.filter(n => n.tag === 'button').length, 0, 'żadnej akcji do kliknięcia');
    t.deepEqual(calls, [], 'store nie jest nawet pytany o cudzy artefakt');
    t.true(root.children.some(n => n.cls.includes('pkm-artefakt-block__note') && n.text.length > 0), 'komunikat i18n dla usera');
});

test('blok we WŁASNEJ notatce dalej rysuje guziki', async t => {
    const { flat, calls } = await render('id: art-wlasny', OWN);
    t.true(flat.filter(n => n.tag === 'button').length >= 1);
    t.deepEqual(calls, ['read:art-wlasny']);
});

test('brak ctx.sourcePath (stary host) = blok nieaktywny, nie otwarte guziki', async t => {
    const { flat } = await render('id: art-wlasny', undefined);
    t.is(flat.filter(n => n.tag === 'button').length, 0);
});

test('parseArtifactBlockId: `id: x` oraz goły token', t => {
    t.is(parseArtifactBlockId('id: art-1'), 'art-1');
    t.is(parseArtifactBlockId('art-2'), 'art-2');
    t.is(parseArtifactBlockId(''), '');
});
