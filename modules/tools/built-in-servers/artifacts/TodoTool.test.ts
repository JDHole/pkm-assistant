import test from 'ava';
import { TodoFileStore, TODO_FOLDER, createTodoTool } from './TodoTool.js';
import type { TodoAdapter, TodoToolPlugin } from './TodoTool.js';
import { parseArtifact } from '../../../artifacts/artifactParser.js';

/**
 * Haki atrapy adaptera (mutowalne — test uzbraja je DOPIERO przed badaną operacją).
 * `slowRead` daje równoległym operacjom realną szansę na przeplot read↔write.
 */
interface AdapterHooks {
    slowRead?: boolean;
    removeThrows?: Error;
    /** Obcy pisarz dopisuje coś do pliku TUŻ PO naszym zapisie. */
    afterWrite?: (path: string) => void;
}

// ── Mock adapter (dotfolder) na in-memory mapie plików ──
function makeAdapter(hooks: AdapterHooks = {}) {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    return {
        files,
        folders,
        adapter: {
            exists: async (p: string) => files.has(p) || folders.has(p),
            read: async (p: string) => {
                // Migawka treści leci PRZED opóźnieniem — czytelnik dostaje to, co plik
                // miał w chwili startu odczytu, tak jak prawdziwe I/O.
                const content = files.get(p) as string;
                if (hooks.slowRead) await new Promise(r => setTimeout(r, 0));
                return content;
            },
            write: async (p: string, c: string) => { files.set(p, c); hooks.afterWrite?.(p); },
            remove: async (p: string) => { if (hooks.removeThrows) throw hooks.removeThrows; files.delete(p); },
            mkdir: async (p: string) => { folders.add(p); },
            list: async (dir: string) => ({
                files: [...files.keys()].filter(p => p.startsWith(dir + '/')),
                folders: [],
            }),
        },
    };
}

function makeStore(hooks: AdapterHooks = {}) {
    const { adapter, files } = makeAdapter(hooks);
    const store = new TodoFileStore({ adapter, now: () => new Date('2026-07-23T10:00:00Z') });
    return { store, files, adapter };
}

/** Minimalny plugin pod `execute` narzędzia (bez pamięci → sessionId = 'current'). */
function makePlugin(adapter: TodoAdapter, store: TodoFileStore): TodoToolPlugin {
    return {
        app: { vault: { adapter } },
        agentManager: { getActiveAgent: () => ({ name: 'Ag' }) },
        _todoStore: store,
    };
}

test('create writes a todo file with checkboxes and block-ids', async t => {
    const { store, files } = makeStore();
    const { state } = await store.create('Jaskier', 'sess1', ['Krok A', 'Krok B']);

    const path = store.path('Jaskier', 'sess1');
    t.is(path, `${TODO_FOLDER}/jaskier-sess1.md`);
    t.true(files.has(path));

    t.is(state.total, 2);
    t.is(state.done, 0);
    t.is(state.items[0].text, 'Krok A');
    t.is(state.items[0].blockId, 'k1');
    t.is(state.items[1].blockId, 'k2');
    t.false(state.items[0].checked);

    // Plik na dysku jest poprawnym markdownem z sekcją Zadania.
    const parsed = parseArtifact(files.get(path) as string);
    t.is(parsed.sections[0].heading, 'Zadania');
    t.is(parsed.sections[0].items.length, 2);
});

test('check / uncheck toggle by block-id', async t => {
    const { store } = makeStore();
    await store.create('Ag', 's', ['a', 'b']);

    let { state } = await store.patch('Ag', 's', [{ op: 'check_item', blockId: 'k2' }]);
    t.is(state.done, 1);
    t.true(state.items[1].checked);
    t.true(state.items[1].done); // alias dla ToolCallDisplay

    ({ state } = await store.patch('Ag', 's', [{ op: 'uncheck_item', blockId: 'k2' }]));
    t.is(state.done, 0);
    t.false(state.items[1].checked);
});

test('add appends a new step with a fresh block-id', async t => {
    const { store } = makeStore();
    await store.create('Ag', 's', ['a']);
    const { state } = await store.patch('Ag', 's', [{ op: 'add_item', heading: 'Zadania', text: 'c' }]);
    t.is(state.total, 2);
    t.is(state.items[1].text, 'c');
    t.is(state.items[1].blockId, 'k2');
});

test('patch on missing block-id returns error but keeps state', async t => {
    const { store } = makeStore();
    await store.create('Ag', 's', ['a']);
    const { state, errors } = await store.patch('Ag', 's', [{ op: 'check_item', blockId: 'k9' }]);
    t.is(errors!.length, 1);
    t.is(errors![0].code, 'not_found');
    t.is(state.total, 1);
});

test('finish deletes the file and reports finished', async t => {
    const { store, files } = makeStore();
    await store.create('Ag', 's', ['a']);
    const path = store.path('Ag', 's');
    t.true(files.has(path));

    const { state } = await store.finish('Ag', 's');
    t.false(files.has(path));
    t.true(state.finished);
    t.is(state.total, 0);
});

test('create clears stale todo files of the same agent (new session hygiene)', async t => {
    const { store, files } = makeStore();
    await store.create('Ag', 'old_session', ['x']);
    t.true(files.has(store.path('Ag', 'old_session')));

    await store.create('Ag', 'new_session', ['y']);
    t.false(files.has(store.path('Ag', 'old_session')), 'stary plik agenta skasowany');
    t.true(files.has(store.path('Ag', 'new_session')));
});

test('create rejects code fences (engine-level security)', async t => {
    const { store } = makeStore();
    const { state, errors } = await store.create('Ag', 's', ['normalny krok', '```js\nevil()\n```']);
    // Element z code fence odrzucony przez walidator patcha — nie trafia na listę.
    t.is(state.total, 1);
    t.is(state.items[0].text, 'normalny krok');
    t.true(errors!.some(e => e.code === 'code_forbidden'));
});

test('polish characters survive roundtrip', async t => {
    const { store, files } = makeStore();
    await store.create('Żółw', 'sesja', ['Zażółć gęślą jaźń']);
    const path = store.path('Żółw', 'sesja');
    const parsed = parseArtifact(files.get(path) as string);
    t.is(parsed.sections[0].items[0].text, 'Zażółć gęślą jaźń');
});

// ── AUD-bledy-057: kolejka per ścieżka (pętla agenta puszcza tool_calls tury przez Promise.all) ──

test('AUD-bledy-057: dwa równoległe add na tej samej liście NIE gubią pozycji', async t => {
    const hooks: AdapterHooks = { slowRead: true };
    const { store, files } = makeStore(hooks);
    await store.create('Ag', 's', ['baza']);
    const path = store.path('Ag', 's');

    // Dokładnie tak robi to AgentLoop: wszystkie wywołania tury startują razem.
    await Promise.all([
        store.patch('Ag', 's', [{ op: 'add_item', heading: 'Zadania', text: 'rownolegle A' }]),
        store.patch('Ag', 's', [{ op: 'add_item', heading: 'Zadania', text: 'rownolegle B' }]),
    ]);

    const onDisk = parseArtifact(files.get(path) as string).sections[0].items.map(i => i.text);
    t.deepEqual(onDisk, ['baza', 'rownolegle A', 'rownolegle B'], 'obie pozycje są na dysku');
    // Block-idy liczone z tego samego, nieświeżego stanu potrafiły się zdublować.
    const ids = parseArtifact(files.get(path) as string).sections[0].items.map(i => i.blockId);
    t.is(new Set(ids).size, ids.length, 'block-idy unikalne');
});

test('AUD-bledy-057: równoległy add + check nie kasują się nawzajem', async t => {
    const hooks: AdapterHooks = { slowRead: true };
    const { store, files } = makeStore(hooks);
    await store.create('Ag', 's', ['pierwszy']);
    const path = store.path('Ag', 's');

    await Promise.all([
        store.patch('Ag', 's', [{ op: 'check_item', blockId: 'k1' }]),
        store.patch('Ag', 's', [{ op: 'add_item', heading: 'Zadania', text: 'drugi' }]),
    ]);

    const items = parseArtifact(files.get(path) as string).sections[0].items;
    t.is(items.length, 2, 'dopisana pozycja została');
    t.true(items[0].checked, 'odhaczenie też zostało');
});

test('AUD-bledy-057: zwrotka patch to stan ODCZYTANY z dysku po zapisie', async t => {
    const hooks: AdapterHooks = {};
    const { store, files } = makeStore(hooks);
    await store.create('Ag', 's', ['a']);
    const path = store.path('Ag', 's');

    // Obcy pisarz (inna operacja / inne okno) dopisuje pozycję zaraz po naszym zapisie.
    hooks.afterWrite = (p: string) => {
        if (p !== path) return;
        hooks.afterWrite = undefined; // jednorazowo
        const md = files.get(p) as string;
        files.set(p, (md.endsWith('\n') ? md : md + '\n') + '- [ ] dopisek z dysku ^k9\n');
    };

    const { state } = await store.patch('Ag', 's', [{ op: 'add_item', heading: 'Zadania', text: 'b' }]);
    t.true(
        state.items.some(i => i.text === 'dopisek z dysku'),
        'zwrotka pokazuje to, co realnie leży na dysku, a nie lokalnie policzoną kopię',
    );
});

// ── AUD-bledy-031: finish nie może meldować zamknięcia, gdy kasowanie padło ──

test('AUD-bledy-031: finish z nieudanym remove wraca jako błąd, nie „zakończono"', async t => {
    const hooks: AdapterHooks = {};
    const { store, files, adapter } = makeStore(hooks);
    await store.create('Ag', 'current', ['niedokończone']);
    const path = store.path('Ag', 'current');
    hooks.removeThrows = new Error('EBUSY: plik zajęty przez inny proces');

    const tool = createTodoTool();
    const res = await tool.execute(
        { action: 'finish', _invocationAgentName: 'Ag' },
        {},
        makePlugin(adapter, store),
    ) as { isError?: boolean; success?: boolean; finished?: boolean; error?: string; cause?: string };

    t.true(files.has(path), 'plik ZOSTAŁ na dysku');
    t.true(res.isError, 'narzędzie melduje błąd');
    t.is(res.success, false);
    t.not(res.finished, true, 'nie wolno meldować zamkniętej listy');
    t.true(
        String(res.error).includes('EBUSY') || String(res.cause).includes('EBUSY'),
        'oryginalny błąd nie ginie',
    );
});

test('AUD-bledy-031: finish bez pliku dalej jest sukcesem (idempotencja)', async t => {
    const { store, adapter } = makeStore();
    const tool = createTodoTool();
    const res = await tool.execute(
        { action: 'finish', _invocationAgentName: 'Ag' },
        {},
        makePlugin(adapter, store),
    ) as { isError?: boolean; finished?: boolean };

    t.not(res.isError, true);
    t.true(res.finished);
});

// ── K4 self-append (za weryfikacją opus): readIfExists broni `patch` przed kłamiącym exists() ──
// Ten sam wzorzec bugu co `modules/memory` (AgentMemory_self_append.test.ts): stary
// `(await exists(p)) ? read(p) : emptyMarkdown()` na Dysku Google traktował ISTNIEJĄCĄ listę
// jako świeżą i patch nadpisywał ją pustym szkieletem + nowym wpisem — reszta zadań znikała.

test('K4: kłamiący exists() na WŁASNYM pliku listy NIE kasuje wcześniejszych zadań (patch)', async t => {
    const { store, files, adapter } = makeStore();
    await store.create('Ag', 's', ['stare zadanie']);
    const path = store.path('Ag', 's');

    // Dysk Google: exists() kłamie DOKŁADNIE na tej ścieżce, read() nadal oddaje prawdziwą treść.
    const honestExists = adapter.exists.bind(adapter);
    adapter.exists = async (p: string) => (p === path ? false : honestExists(p));

    const { state } = await store.patch('Ag', 's', [{ op: 'add_item', heading: 'Zadania', text: 'nowe zadanie' }]);

    t.is(state.total, 2, 'stare zadanie NIE zginęło mimo kłamiącego exists()');
    t.is(state.items[0].text, 'stare zadanie');
    t.is(state.items[1].text, 'nowe zadanie');
    const onDisk = parseArtifact(files.get(path) as string).sections[0].items.map(i => i.text);
    t.deepEqual(onDisk, ['stare zadanie', 'nowe zadanie'], 'obie pozycje realnie leżą na dysku');
});

test('K4: sprzeczne sygnały (exists=true, read rzuca) na WŁASNYM pliku listy → tool-error, plik NIETKNIĘTY', async t => {
    const { store, files, adapter } = makeStore();
    await store.create('Ag', 'current', ['stare zadanie']);
    const path = store.path('Ag', 'current');
    const originalContent = files.get(path);

    const honestRead = adapter.read.bind(adapter);
    adapter.read = async (p: string) => {
        if (p === path) throw new Error('EIO: dysk nie odpowiada');
        return honestRead(p);
    };

    const tool = createTodoTool();
    const res = await tool.execute(
        { action: 'add', text: 'nowe zadanie', _invocationAgentName: 'Ag' },
        {},
        makePlugin(adapter, store),
    ) as { isError?: boolean; error?: string };

    t.true(res.isError, 'narzędzie melduje błąd modelowi (tool-error), nie ciche powodzenie');
    t.true(
        String(res.error).includes('EIO: dysk nie odpowiada'),
        'przyczyna (cause z readIfExists) niesiona w komunikacie, nie sam suchy „nie mogę odczytać"',
    );
    t.is(files.get(path), originalContent, 'plik listy NIETKNIĘTY — throw ląduje przed jakimkolwiek write()');
});
