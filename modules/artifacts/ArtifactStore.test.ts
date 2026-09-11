import test from 'ava';
import { ArtifactStore, DEFAULT_ARTIFACTS_FOLDER } from './ArtifactStore.js';
import { parseArtifact } from './artifactParser.js';
import { parseYaml, stringifyYaml } from '../../core/utils/yamlParser.js';
import type { ArtifactFrontmatter } from './types.js';

// ── Stub typu `plan` (zamiast ładować z dysku — izolujemy store) ──
const PLAN_TYPE = {
    name: 'plan',
    statusy: ['do-akceptacji', 'uwagi', 'zaakceptowany', 'zamkniety'],
    sprzatanie: 30,
    pola: { cel: { opis: 'po co' }, termin: { opis: 'do kiedy' } },
    template: '## Cel\n{{cel}}\n\n## Kroki\n\n## Ryzyka i założenia\n\n## Uwagi usera\n(strefa usera)\n',
};
const typeLoader = { getType: (n: string) => (n === PLAN_TYPE.name ? PLAN_TYPE : null) };

// ── Mini event bus (imituje `vault.on`/`metadataCache.on` z Obsidiana) ──
// Rejestr artefaktów (ArtifactStore) trzyma się aktualny NIE dzięki skanowaniu vaulta przy
// każdym `list()`/`pathById()`, tylko dzięki tym nasłuchom - więc atrapa musi je REALNIE
// odpalać (nie tylko udawać `on()`), inaczej testy mutacji-zewnętrznej (np.
// `fileManager.processFrontMatter` z pominięciem `store.update()`) nie ujawniłyby regresji.
function makeEmitter() {
    const handlers = new Map<string, Set<(...args: never[]) => void>>();
    return {
        on(name: string, cb: (...args: never[]) => void) {
            if (!handlers.has(name)) handlers.set(name, new Set());
            handlers.get(name)!.add(cb);
            return { name, cb };
        },
        offref(ref: { name: string; cb: (...args: never[]) => void } | null | undefined) {
            if (ref) handlers.get(ref.name)?.delete(ref.cb);
        },
        trigger(name: string, ...args: unknown[]) {
            for (const cb of handlers.get(name) ?? []) (cb as (...a: unknown[]) => void)(...args);
        },
    };
}

// ── Mock App (Vault + metadataCache + fileManager) na in-memory mapie plików ──
function makeApp() {
    const files = new Map<string, string>();      // path -> content string
    const folders = new Set<string>();
    const fileObj = (p: string) => ({ path: p, name: p.split('/').pop() || '', basename: p.split('/').pop()?.replace(/\.md$/i, '') || '' });
    const vaultEvents = makeEmitter();
    const mcEvents = makeEmitter();
    let getMarkdownFilesCalls = 0;
    let cachedReadCalls = 0;
    // Pliki pod rootem, dla których `metadataCache` udaje NIEROZWIĄZANY
    // stan (getFileCache -> null), tak jak zaraz po starcie pluginu, zanim Obsidian rozgrzeje
    // cache całego vaulta — bez emisji żadnego eventu.
    const coldPaths = new Set<string>();

    const app = {
        vault: {
            getMarkdownFiles: () => { getMarkdownFilesCalls++; return [...files.keys()].filter((p: string) => /\.md$/i.test(p)).map(fileObj); },
            getAbstractFileByPath: (p: string) => (files.has(p) ? fileObj(p) : (folders.has(p) ? { path: p, children: [] } : null)),
            create: async (path: string, content: string) => { files.set(path, content); const f = fileObj(path); vaultEvents.trigger('create', f); return f; },
            createFolder: async (p: string) => { folders.add(p); },
            cachedRead: async (file: { path: string }) => { cachedReadCalls++; return files.get(file.path)!; },
            process: async (file: { path: string }, fn: (text: string) => string) => {
                const next = fn(files.get(file.path)!);
                files.set(file.path, next);
                mcEvents.trigger('changed', fileObj(file.path));
                return next;
            },
            trash: async (file: { path: string }) => { files.delete(file.path); vaultEvents.trigger('delete', fileObj(file.path)); },
            on: vaultEvents.on,
            offref: vaultEvents.offref,
        },
        metadataCache: {
            getFileCache: (file: { path: string }) => {
                if (coldPaths.has(file.path)) return null; // P1a: zimny cache, symulowane
                const c = files.get(file.path);
                if (c == null) return null;
                return { frontmatter: parseArtifact(c).frontmatter };
            },
            on: mcEvents.on,
            offref: mcEvents.offref,
        },
        fileManager: {
            processFrontMatter: async (file: { path: string }, fn: (frontmatter: ArtifactFrontmatter) => void) => {
                const content = files.get(file.path)!;
                const m = content.match(/^(---\n)([\s\S]*?)(\n---\n?)/);
                const fm = (m ? (parseYaml(m[2]) || {}) : {}) as ArtifactFrontmatter;
                fn(fm);
                const rest = m ? content.slice(m[0].length) : content;
                files.set(file.path, `---\n${stringifyYaml(fm)}---\n${rest}`);
                mcEvents.trigger('changed', fileObj(file.path));
            },
            renameFile: async (file: { path: string }, newPath: string) => {
                const c = files.get(file.path)!;
                files.delete(file.path);
                files.set(newPath, c);
                vaultEvents.trigger('rename', fileObj(newPath), file.path);
            },
            trashFile: async (file: { path: string }) => { files.delete(file.path); vaultEvents.trigger('delete', fileObj(file.path)); },
        },
    };
    return { app, files, folders, vaultEvents, mcEvents, coldPaths, getMarkdownFilesCalls: () => getMarkdownFilesCalls, cachedReadCalls: () => cachedReadCalls };
}

function makeStore(nowRef: { value: Date }) {
    const { app, files, folders, vaultEvents, mcEvents, coldPaths, getMarkdownFilesCalls, cachedReadCalls } = makeApp();
    const store = new ArtifactStore({ app, typeLoader: typeLoader as unknown as { getType(name: string): import('./types.js').ArtifactType | null }, now: () => nowRef.value });
    return { store, app, files, folders, vaultEvents, mcEvents, coldPaths, getMarkdownFilesCalls, cachedReadCalls };
}

test('create writes a well-formed instance note in the agent folder', async t => {
    const nowRef = { value: new Date('2026-07-23T10:00:00Z') };
    const { store, files } = makeStore(nowRef);

    const res = await store.create('plan', {
        tytul: 'Plan porządków',
        pola: { cel: 'Ogarnąć folder Projekty' },
        agent: 'Jaskier',
        sekcje: [{ op: 'add_item', heading: 'Kroki', text: 'Przejrzeć notatki' }],
    });

    t.regex(res.id, /^art-\d{8}-[0-9a-f]{4}$/);
    t.true(res.path.startsWith(`${DEFAULT_ARTIFACTS_FOLDER}/Jaskier/`));
    t.true(res.path.endsWith('2026-07-23 Plan porządków.md'));
    t.true(files.has(res.path));

    const parsed = parseArtifact(files.get(res.path));
    t.is(parsed.frontmatter['pkm-artefakt'], res.id);
    t.is(parsed.frontmatter.typ, 'plan');
    t.is(parsed.frontmatter.agent, 'Jaskier');
    t.is(parsed.frontmatter.status, 'do-akceptacji');
    t.is(parsed.frontmatter.cel, 'Ogarnąć folder Projekty');
    t.is(parsed.frontmatter.utworzono, '2026-07-23');
    t.is(parsed.frontmatter.zaktualizowano, '2026-07-23');

    const cel = parsed.sections.find(s => s.heading === 'Cel')!;
    t.true(cel.text.includes('Ogarnąć folder Projekty')); // {{cel}} podstawione w body
    const kroki = parsed.sections.find(s => s.heading === 'Kroki')!;
    t.is(kroki.items.length, 1);
    t.is(kroki.items[0]!.text, 'Przejrzeć notatki');
    t.truthy(kroki.items[0]!.blockId);
    t.true(parsed.buttons); // blok pkm-artefakt doklejony
});

test('create rejects a code-fence in initial sekcje (no code written)', async t => {
    const nowRef = { value: new Date('2026-07-23T10:00:00Z') };
    const { store, files } = makeStore(nowRef);
    const res = await store.create('plan', {
        tytul: 'Zły',
        agent: 'Jaskier',
        sekcje: [{ op: 'set_section', heading: 'Ryzyka i założenia', text: '```js\nalert(1)\n```' }],
    });
    const content = files.get(res.path);
    t.false(content!.includes('alert(1)'));
});

test('create zwraca applied/errors — nagłówek spoza szablonu NIE ginie po cichu', async t => {
    const nowRef = { value: new Date('2026-07-23T10:00:00Z') };
    const { store } = makeStore(nowRef);

    const res = await store.create('plan', {
        tytul: 'Literówka w nagłówku',
        agent: 'Jaskier',
        sekcje: [
            { op: 'add_item', heading: 'Kroki', text: 'krok, który wchodzi' },
            { op: 'set_section', heading: 'Kroki do wykonania', text: 'sekcja, której w szablonie nie ma' },
        ],
    });

    t.is(res.applied, 1, 'poprawny ops przeszedł');
    t.is(res.errors.length, 1);
    t.is(res.errors[0]!.code, 'not_found', 'błąd sekcji widoczny w wyniku create');
});

test('create bez sekcji → applied 0 i pusta lista błędów', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const res = await store.create('plan', { tytul: 'Goły', agent: 'Jaskier' });
    t.is(res.applied, 0);
    t.deepEqual(res.errors, []);
});

test('create throws on unknown type', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    await t.throwsAsync(() => store.create('nieistnieje', { tytul: 'x', agent: 'Jaskier' }));
});

test('read returns thin JSON for an existing artifact', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const { id } = await store.create('plan', { tytul: 'Do odczytu', pola: { cel: 'zrobić coś' }, agent: 'Jaskier' });
    const thin = (await store.read(id))!;
    t.is(thin.id, id);
    t.is(thin.typ, 'plan');
    t.is(thin.status, 'do-akceptacji');
    t.is(thin.tytul, '2026-07-23 Do odczytu');
    t.truthy(thin.sections.find(s => s.heading === 'Cel'));
});

test('read returns null for a missing id', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    t.is(await store.read('art-00000000-dead'), null);
});

test('update applies body + frontmatter ops and bumps zaktualizowano', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const { id } = await store.create('plan', {
        tytul: 'Aktualizacja',
        agent: 'Jaskier',
        sekcje: [{ op: 'add_item', heading: 'Kroki', text: 'krok pierwszy' }],
    });

    // Zasymuluj upływ dnia — zaktualizowano powinno się przesunąć.
    nowRef.value = new Date('2026-07-24');
    const r = await store.update(id, [
        { op: 'check_item', blockId: 'k1' },
        { op: 'set_field', key: 'status', value: 'zaakceptowany' },
    ]);

    t.is(r.applied, 2);
    t.is(r.errors.length, 0);
    t.is(r.artifact!.status, 'zaakceptowany');
    t.is(r.artifact!.frontmatter.zaktualizowano, '2026-07-24');
    const kroki = r.artifact!.sections.find(s => s.heading === 'Kroki')!;
    t.is(kroki.items.find(i => i.blockId === 'k1')!.checked, true);
});

test('update rejects protected-key set_field but still applies valid ops', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const { id } = await store.create('plan', { tytul: 'Ochrona', agent: 'Jaskier' });

    const r = await store.update(id, [
        { op: 'set_field', key: 'typ', value: 'hacked' },        // protected
        { op: 'set_field', key: 'status', value: 'uwagi' },      // ok
    ]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 1);
    t.is(r.errors[0]!.code, 'protected_key');
    t.is(r.artifact!.typ, 'plan');       // nietknięte
    t.is(r.artifact!.status, 'uwagi');
});

test('update rejects set_field without a string key (no "undefined" frontmatter key)', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files } = makeStore(nowRef);
    const { id, path } = await store.create('plan', { tytul: 'Bez klucza', agent: 'Jaskier' });

    const r = await store.update(id, [{ op: 'set_field', value: 'wartosc-smiec' } as unknown as { op: 'set_field'; key: string; value: string }]);

    t.is(r.applied, 0);
    t.is(r.errors.length, 1);
    t.is(r.errors[0]!.code, 'invalid_op');
    t.is(r.errors[0]!.message, 'set_field requires a string key');
    t.false(files.get(path)!.includes('undefined:'));
});

test('update rejects a non-scalar set_field value with the canonical message', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const { id } = await store.create('plan', { tytul: 'Nie-skalar', agent: 'Jaskier' });

    const r = await store.update(id, [{ op: 'set_field', key: 'status', value: { zly: 'obiekt' } } as unknown as { op: 'set_field'; key: string; value: string }]);

    t.is(r.applied, 0);
    t.is(r.errors.length, 1);
    t.is(r.errors[0]!.code, 'invalid_value');
    // Kanoniczny komunikat z artifactParser.ts (INVALID_VALUE_MSG) - TEN SAM co przy `create`/`pola`,
    // nie osobna, rozjechana kopia ("set_field accepts only scalar values" bez sufiksu).
    t.is(r.errors[0]!.message, 'set_field accepts only scalar values (string/number/bool)');
});

test('update on a missing id returns not_found', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const r = await store.update('art-00000000-dead', [{ op: 'check_item', blockId: 'k1' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'not_found');
});

test('list filters by agent / typ / status (tracking by frontmatter, not path)', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const a = await store.create('plan', { tytul: 'A', agent: 'Jaskier' });
    await store.create('plan', { tytul: 'B', agent: 'Tola' });

    t.is(store.list({ agent: 'Jaskier' }).length, 1);
    t.is(store.list({ agent: 'Jaskier' })[0]!.id, a.id);
    t.is(store.list({ agent: 'Nieznany' }).length, 0);
    t.is(store.list({ typ: 'plan' }).length, 2);
    t.is(store.list({ status: 'do-akceptacji' }).length, 2);
    t.is(store.list({ status: 'zamkniety' }).length, 0);
});

test('move relocates the note but keeps it findable by frontmatter id', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files } = makeStore(nowRef);
    const { id, path } = await store.create('plan', { tytul: 'Przenoszony', agent: 'Jaskier' });

    // Przenosiny WEWNĄTRZ folderu artefaktów - tu tropimy po frontmatterze, nie po ścieżce.
    const ok = await store.move(id, `${DEFAULT_ARTIFACTS_FOLDER}/Inny`);
    t.true(ok);
    t.false(files.has(path));
    const thin = (await store.read(id))!;
    t.truthy(thin);
    t.true(thin.path!.startsWith(`${DEFAULT_ARTIFACTS_FOLDER}/Inny/`));
});

test('move POZA folder artefaktów jest odmawiane - artefakt nie może osierocieć', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files } = makeStore(nowRef);
    const { id, path } = await store.create('plan', { tytul: 'Nie wyjedzie', agent: 'Jaskier' });

    t.false(await store.move(id, 'Prywatne'), 'przenosiny poza folder artefaktów mają wracać false');
    t.true(files.has(path), 'plik zostaje na miejscu');
    t.truthy(await store.read(id), 'artefakt dalej jest widoczny dla silnika');
});

test('remove trashes the note', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files } = makeStore(nowRef);
    const { id, path } = await store.create('plan', { tytul: 'Do usunięcia', agent: 'Jaskier' });
    t.true(await store.remove(id));
    t.false(files.has(path));
    t.is(await store.read(id), null);
});

test('filename collisions get a numeric suffix', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const a = await store.create('plan', { tytul: 'Ten sam', agent: 'Jaskier' });
    const b = await store.create('plan', { tytul: 'Ten sam', agent: 'Jaskier' });
    t.not(a.path, b.path);
    t.true(b.path.endsWith('Ten sam 2.md'));
});

test('archive moves closed artifacts older than the type retention window', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const { id } = await store.create('plan', { tytul: 'Stary', agent: 'Jaskier' });
    // Zamknij i cofnij zaktualizowano o 40 dni (typ plan: sprzatanie 30).
    await store.update(id, [{ op: 'set_field', key: 'status', value: 'zamkniety' }]);
    await store.app.fileManager.processFrontMatter((await store._findFileById(id))!, (fm: ArtifactFrontmatter) => { fm.zaktualizowano = '2026-06-01'; });

    const moved = await store.archive();
    t.is(moved, 1);
    const thin = (await store.read(id))!;
    t.true(thin.path!.includes('_archiwum/'));
});

// ── bramka i zlew rozstrzygają id na TĘ SAMĄ ścieżkę ──────
// `pathById` (cel dla `contextExtractor`) i `_findFileById` (zapis) muszą się zgadzać: gdyby
// jeden czytał nieświeży `_pathIndex` bez weryfikacji, a drugi skanował dysk, user przenoszący
// notatkę w Obsidianie rozjeżdżałby bramkę (ocena STAREJ ścieżki) z zapisem (NOWA ścieżka), a
// `isBlockBoundToNote` wiązałby cudzą notatkę stojącą pod starym adresem z żywymi guzikami
// artefaktu.

test('po przenosinach usera bramka i zlew widzą tę samą ścieżkę', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files } = makeStore(nowRef);
    const { id, path } = await store.create('plan', { tytul: 'Plan', agent: 'Klara' });
    t.is(store.pathById(id), path);

    // User przenosi notatkę w Obsidianie (poza zasięgiem store'a - plugin nic nie wie).
    const moved = `${DEFAULT_ARTIFACTS_FOLDER}/Prywatne/2026-07-23 Plan.md`;
    files.set(moved, files.get(path)!);
    files.delete(path);

    const sink = await store._findFileById(id);
    t.is(sink?.path, moved, 'zlew idzie do nowej ścieżki');
    t.is(store.pathById(id), moved, 'bramka MUSI wskazać to samo co zlew');
});

test('obca notatka pod starą ścieżką nie dziedziczy id artefaktu', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files } = makeStore(nowRef);
    const { id, path } = await store.create('plan', { tytul: 'Plan', agent: 'Klara' });

    const moved = `${DEFAULT_ARTIFACTS_FOLDER}/Klara/2026-07-23 Plan przeniesiony.md`;
    files.set(moved, files.get(path)!);
    // Pod starą ścieżką staje CUDZA notatka (bez naszego id).
    files.set(path, '---\npkm-artefakt: art-inny-0000\ntyp: plan\n---\n\n## Cel\ncudze\n');

    t.is(store.pathById(id), moved);
    t.not(store.pathById(id), path, 'stary wpis indeksu nie może wskazywać cudzej notatki');
});

// ── walidator ogląda DOKŁADNIE to, co pójdzie do zapisu ──────
// `applyFieldsValidated` musi sprawdzać samą wartość, nie `String(value)` - inaczej zagnieżdżony
// obiekt dawałby "[object Object]" i przechodził, a `create` wpisywałby do frontmattera SUROWĄ
// mapę - razem z blokiem kodu, którego `set_field` w ogóle nie dopuszcza (tylko skalary).

test('nie-skalar w `pola` jest odrzucony (invalid_value), plik NIE powstaje', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files } = makeStore(nowRef);

    const payload = { zly: '```dataviewjs\napp.vault.getFiles()\n```' };
    const res = await store.create('plan', {
        tytul: 'Podstęp',
        agent: 'Klara',
        pola: { cel: payload as unknown as string },
    });

    t.false(res.created);
    t.is(res.errors[0]!.code, 'invalid_value');
    t.is(files.size, 0, 'żaden plik nie powstał');
});

test('walidator i zapis oglądają ten sam ładunek - tablica też odpada', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const res = await store.create('plan', {
        tytul: 'Tablica',
        agent: 'Klara',
        pola: { cel: ['a', 'b'] as unknown as string },
    });
    t.false(res.created);
    t.is(res.errors[0]!.code, 'invalid_value');
});

test('skalary (string/liczba/bool) nadal przechodzą', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const res = await store.create('plan', {
        tytul: 'Skalary',
        agent: 'Klara',
        pola: { cel: 'zwykly tekst', termin: 42 as unknown as string },
    });
    t.true(res.created);
    t.is(res.errors.length, 0);
});

// ── rejestr artefaktów zamiast skanu vaulta na każde `list()`/`pathById()` ──
// Testy liczą realne wywołania `vault.getMarkdownFiles()`, nie tylko wynik - żeby złapać
// regresję do pętli po `getMarkdownFiles()` per wywołanie w `list()`/`pathById()`/`_findFileById`.

test('list() skanuje vault RAZ (rejestr), kolejne wywołania nie skanują ponownie', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, getMarkdownFilesCalls } = makeStore(nowRef);
    await store.create('plan', { tytul: 'A', agent: 'Jaskier' });
    await store.create('plan', { tytul: 'B', agent: 'Tola' });

    t.is(store.list().length, 2);
    t.is(store.list({ agent: 'Jaskier' }).length, 1);
    t.is(store.list({ typ: 'plan' }).length, 2);
    t.is(store.list({ status: 'do-akceptacji' }).length, 2);

    t.is(getMarkdownFilesCalls(), 1, 'cztery `list()` z rzędu mają skanować vault RAZ, nie cztery');
});

test('pathById dla NIEISTNIEJĄCEGO id nie skanuje vaulta powtórnie', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, getMarkdownFilesCalls } = makeStore(nowRef);
    await store.create('plan', { tytul: 'A', agent: 'Jaskier' });

    t.is(store.pathById('art-nieistnieje-0000'), null);
    const callsAfterFirstMiss = getMarkdownFilesCalls();
    t.is(callsAfterFirstMiss, 1, 'pierwsze pytanie buduje rejestr — dokładnie jeden skan');

    t.is(store.pathById('art-nieistnieje-0000'), null);
    t.is(store.pathById('art-nieistnieje-0000'), null);
    t.is(store.pathById('inne-nieznane-id'), null);
    t.is(getMarkdownFilesCalls(), callsAfterFirstMiss,
        'kolejne pytania o (to samo albo inne) nieznane id NIE mają wracać do pełnego skanu — rejestr jest kompletną wyrocznią');
});

test('`create` pod rootem (zdarzenie vault.on) odsłania nowy artefakt bez pełnego skanu', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files, vaultEvents, getMarkdownFilesCalls } = makeStore(nowRef);

    t.is(store.pathById('art-zewnetrzny-0001'), null, 'buduje rejestr, id jeszcze nie istnieje');
    const callsAfterMiss = getMarkdownFilesCalls();

    // Plik powstaje SPOZA store'a (np. synchronizacja) — zapis w mapie + prawdziwy event `create`,
    // dokładnie tak jak zrobiłby to Obsidian dla pliku dodanego przez cokolwiek innego niż nasz
    // `store.create()`.
    const externalPath = `${DEFAULT_ARTIFACTS_FOLDER}/Jaskier/2026-07-23 Zewnetrzny.md`;
    files.set(externalPath, [
        '---', 'pkm-artefakt: art-zewnetrzny-0001', 'typ: plan', 'agent: Jaskier',
        'status: do-akceptacji', 'utworzono: 2026-07-23', 'zaktualizowano: 2026-07-23', '---', '',
    ].join('\n'));
    vaultEvents.trigger('create', { path: externalPath, name: '2026-07-23 Zewnetrzny.md', basename: '2026-07-23 Zewnetrzny' });

    t.is(store.pathById('art-zewnetrzny-0001'), externalPath, 'event create zaktualizował rejestr');
    t.is(getMarkdownFilesCalls(), callsAfterMiss, 'indeksowanie POJEDYNCZEGO pliku z eventu nie wraca do pełnego skanu');
    t.is(store.list({ agent: 'Jaskier' }).length, 1, 'list() też widzi świeżo doindeksowany wpis, bez własnego skanu');
});

test('`delete` pod rootem (zdarzenie vault.on) wypisuje artefakt z rejestru', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, vaultEvents } = makeStore(nowRef);
    const { id, path } = await store.create('plan', { tytul: 'Do skasowania z zewnątrz', agent: 'Jaskier' });

    t.is(store.list().length, 1);
    vaultEvents.trigger('delete', { path });

    t.is(store.list().length, 0, 'wpis znika z list() od razu, bez czekania na kolejny pełny skan');
    t.is(store.pathById(id), null);
});

test('`metadataCache.changed` (edycja frontmattera z zewnątrz store\'a) odświeża rejestr', async t => {
    // To jest DOKŁADNIE scenariusz z testu „archive moves closed artifacts…" niżej w tym pliku,
    // wyizolowany: `list()` musi zobaczyć zmianę zrobioną PRZEZ `app.fileManager` wprost, z
    // pominięciem `store.update()` — inaczej `archive()` (który filtruje po `list({status})`)
    // nigdy by takiego artefaktu nie znalazł.
    const nowRef = { value: new Date('2026-07-23') };
    const { store } = makeStore(nowRef);
    const { id } = await store.create('plan', { tytul: 'Zewnętrzna edycja', agent: 'Jaskier' });
    t.is(store.list({ status: 'zamkniety' }).length, 0);

    const file = await store._findFileById(id);
    await store.app.fileManager.processFrontMatter(file!, (fm: ArtifactFrontmatter) => { fm.status = 'zamkniety'; });

    t.is(store.list({ status: 'zamkniety' }).length, 1, 'zmiana zrobiona mimo store powinna dotrzeć do rejestru przez event `changed`');
});

test('root ustawień liczy się O(1) na przelot rejestru, nie O(liczby plików vaulta)', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { app, files } = makeApp();
    let getFolderCalls = 0;
    const store = new ArtifactStore({
        app,
        typeLoader: typeLoader as unknown as { getType(name: string): import('./types.js').ArtifactType | null },
        now: () => nowRef.value,
        getArtifactsFolder: () => { getFolderCalls++; return DEFAULT_ARTIFACTS_FOLDER; },
    });

    await store.create('plan', { tytul: 'A', agent: 'Jaskier' });
    // 30 obcych notatek w vaultcie, poza folderem artefaktów - test pilnuje żeby `_artifactsRoot()`
    // (czyli `sanitizePath`) nie liczył się per KAŻDY z nich wewnątrz pętli `list()`.
    for (let i = 0; i < 30; i++) files.set(`Notatki/nota-${i}.md`, '# nic');

    getFolderCalls = 0; // liczymy WYŁĄCZNIE koszt tego jednego list()
    t.is(store.list().length, 1);
    t.true(getFolderCalls <= 2,
        `_artifactsRoot() policzony ${getFolderCalls} razy na 31 plików vaulta — powinien być stały, nie proporcjonalny do rozmiaru vaulta`);
});

// ── zimny metadataCache przy budowie rejestru + samoleczenie pod zimnym cache w NOWEJ
// lokalizacji. Testy reprodukują: 3 artefakty / zimny cache -> list()=0, pathById=null; potem
// rozgrzanie / `resolved` / dysk-fallback odzyskują dane.

test('zimny metadataCache przy (pierwszej) budowie rejestru nie gubi artefaktów na zawsze', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files, coldPaths } = makeStore(nowRef);
    // Artefakty ISTNIEJĄCE już na dysku (np. z poprzedniej sesji) — fresh store, `_pathIndex`
    // pusty, jedyna droga to rejestr. `archive()` na `onLayoutReady` może spytać, zanim
    // Obsidian rozgrzał `metadataCache` dla tych trzech notatek.
    const mk = (n: string) => `${DEFAULT_ARTIFACTS_FOLDER}/Jaskier/2026-07-23 ${n}.md`;
    const paths = ['A', 'B', 'C'].map(mk);
    paths.forEach((p, i) => {
        files.set(p, `---\npkm-artefakt: art-stara-000${i}\ntyp: plan\nagent: Jaskier\nstatus: do-akceptacji\nutworzono: 2026-07-23\nzaktualizowano: 2026-07-23\n---\n\n## Cel\n`);
        coldPaths.add(p);
    });

    t.is(store.list().length, 0, 'zimny cache przy (pierwszej) budowie -> rejestr chwilowo pusty, NIE ma halucynacji');
    t.is(store.pathById('art-stara-0000'), null, 'i pathById też nie halucynuje pod zimnym cache');

    // Cache się rozgrzewa BEZ żadnego eventu (Obsidian po prostu dogania się w tle) — kolejne
    // pytanie MUSI spróbować ponownie, bo build na zimnym cache nie mógł zastemplować roota.
    coldPaths.clear();
    t.is(store.list().length, 3, 'po rozgrzaniu następny list() widzi WSZYSTKIE trzy — rejestr się przebudował');
    t.is(store.pathById('art-stara-0001'), paths[1]);
});

test('metadataCache "resolved" wymusza przebudowę rejestru (łapie zmiany bez żadnego innego eventu)', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files, mcEvents } = makeStore(nowRef);
    await store.create('plan', { tytul: 'A', agent: 'Jaskier' });
    t.is(store.list().length, 1); // rejestr zbudowany i zastemplowany jako kompletny (cache ciepły)

    // Plik pojawia się „z niczego" (np. odtworzenie z zapisanej bazy Obsidiana) — BEZ eventu
    // `create`, więc bez naprawy P1a rejestr o nim nigdy by się nie dowiedział.
    const path = `${DEFAULT_ARTIFACTS_FOLDER}/Jaskier/2026-07-23 Odtworzony.md`;
    files.set(path, '---\npkm-artefakt: art-odtworzony-0002\ntyp: plan\nagent: Jaskier\nstatus: do-akceptacji\nutworzono: 2026-07-23\nzaktualizowano: 2026-07-23\n---\n\n## Cel\n');

    t.is(store.list().length, 1, 'bez zdarzenia rejestr jeszcze nie wie o nowym pliku');
    mcEvents.trigger('resolved');
    t.is(store.list().length, 2, 'po "resolved" rejestr się przebudował i widzi oba');
});

test('artefakt przeniesiony BEZ eventu do lokalizacji z zimnym cache - _findFileById wraca do dysku', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, files, coldPaths } = makeStore(nowRef);
    const { id, path } = await store.create('plan', { tytul: 'Przenoszony po cichu', agent: 'Jaskier' });
    t.is(store.pathById(id), path, 'id jest "znany" (wpis w indeksie sesji) przed przenosinami');

    // User przenosi notatkę w Obsidianie (poza zasięgiem store'a, bez eventu `rename`) — a NOWA
    // lokalizacja ma jeszcze ZIMNY metadataCache, więc samoleczenie `pathById` (tylko cache)
    // nie może jej znaleźć.
    const moved = `${DEFAULT_ARTIFACTS_FOLDER}/Jaskier/2026-07-23 Przeniesiony po cichu.md`;
    files.set(moved, files.get(path)!);
    files.delete(path);
    coldPaths.add(moved);

    t.is(store.pathById(id), null, 'samoleczenie SYNCHRONICZNE (tylko metadataCache) nie znajduje pod zimnym cache');

    const file = await store._findFileById(id);
    t.truthy(file, '_findFileById (asynchroniczny) MUSI spróbować fallbacku z dysku, bo id BYŁO kiedyś znane');
    t.is(file?.path, moved);

    // Po fallbacku z dysku indeks/rejestr są znów świeże — kolejne pathById (sync) trafia bez dysku.
    coldPaths.delete(moved);
    t.is(store.pathById(id), moved);
});

test('id NIGDY niewidziane nie dostaje fallbacku z dysku (zostaje O(1))', async t => {
    const nowRef = { value: new Date('2026-07-23') };
    const { store, cachedReadCalls } = makeStore(nowRef);
    await store.create('plan', { tytul: 'A', agent: 'Jaskier' });

    t.is(await store._findFileById('art-nigdy-niewidziane-0000'), null,
        '_wasEverKnown musi być false dla id, którego rejestr nigdy nie znał — bez tego wracałby skan+odczyt z dysku na każde halucynowane id');
    t.is(await store._findFileById('inne-halucynowane-id'), null);
    // Fallback z dysku dla id, którego rejestr nigdy nie znał, w ogóle się NIE odpala - inaczej
    // `_diskFallbackForId` czytałby z dysku KAŻDY plik folderu artefaktów na KAŻDE halucynowane
    // id od modelu.
    t.is(cachedReadCalls(), 0, 'zero odczytów z dysku dla id, którego rejestr nigdy nie znał');
});
