import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { StateManager } from './StateManager.js';
import {
    resolveConsolidationThresholds,
    shouldTriggerConsolidation,
    resolvePlanDedupThreshold,
    getConsolidationStatus,
} from './consolidationStatus.js';

// ── Atrapa vaulta — sam wzorzec co `AgentMemory.test.ts` (realna `AgentMemory`
//    na atrapie adaptera, żadnych mocków metod). ──────────────────────────────────────────

function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>(initialFolders);
    // Licznik operacji ZAPISU (write/append/mkdir/remove/rename/copy) - P3: strażnik dowodzi,
    // że `getConsolidationStatus` na rozgrzanej instancji jest CZYSTYM odczytem, nawet gdy
    // `.state.json`/`brain/` zniknęły spod niej po starcie.
    const calls: string[] = [];

    const parentFoldersFor = (path: string): string[] => {
        const parts = path.split('/');
        const result: string[] = [];
        for (let i = 1; i < parts.length; i++) {
            result.push(parts.slice(0, i).join('/'));
        }
        return result;
    };

    for (const path of Object.keys(files)) {
        for (const folder of parentFoldersFor(path)) folders.add(folder);
    }

    return {
        files,
        folders,
        calls,
        vault: {
            adapter: {
                async exists(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) {
                    calls.push(`mkdir:${path}`);
                    folders.add(path);
                },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    calls.push(`write:${path}`);
                    for (const folder of parentFoldersFor(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) {
                    calls.push(`remove:${path}`);
                    delete files[path];
                },
                async append(path: string, content: string) {
                    calls.push(`append:${path}`);
                    files[path] = (files[path] || '') + content;
                },
                async rename(oldPath: string, newPath: string) {
                    calls.push(`rename:${oldPath}->${newPath}`);
                    if (Object.prototype.hasOwnProperty.call(files, oldPath)) {
                        files[newPath] = files[oldPath];
                        delete files[oldPath];
                    }
                },
                async copy(oldPath: string, newPath: string) {
                    calls.push(`copy:${oldPath}->${newPath}`);
                    if (Object.prototype.hasOwnProperty.call(files, oldPath)) {
                        files[newPath] = files[oldPath];
                    }
                },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(path => path.startsWith(prefix)),
                        folders: [...folders].filter(path => path.startsWith(prefix) && path !== folder),
                    };
                },
                async stat(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) ? { mtime: 1 } : null;
                },
            },
        },
    };
}

function note(name: string, type = 'reference'): string {
    return `---
name: ${name}
description: opis
type: ${type}
created: 2026-05-14
---

Treść.
`;
}

const BASE = '.pkm-assistant/agents/agent/memory';

// ── StateManager.peek() — czysty odczyt, zero bootstrapu (test bezpośredni na StateManager,
//    bo `getConsolidationStatus` woła i inne metody `AgentMemory`, które SAME bootstrapują
//    strukturę jako efekt uboczny — peek() w izolacji to jedyny sposób sprawdzić, że TA
//    metoda niczego nie zapisuje). ──────────────────────────────────────────────────────────

test('StateManager.peek() na brakującym pliku zwraca defaulty i source=missing, NIC nie zapisuje', async t => {
    const { vault, files } = makeVault();
    const sm = new StateManager(vault, `${BASE}/.state.json`);

    const result = await sm.peek();

    t.deepEqual(result, {
        state: { active_sessions: [], archived_since_last_consolidation: 0, last_archive_at: null },
        source: 'missing',
    });
    t.false(Object.prototype.hasOwnProperty.call(files, `${BASE}/.state.json`));
});

test('StateManager.peek() na uszkodzonym JSON zwraca defaulty i source=unreadable', async t => {
    const { vault, files } = makeVault({ [`${BASE}/.state.json`]: '{not valid json' });
    const sm = new StateManager(vault, `${BASE}/.state.json`);

    const result = await sm.peek();

    t.deepEqual(result, {
        state: { active_sessions: [], archived_since_last_consolidation: 0, last_archive_at: null },
        source: 'unreadable',
    });
    // Plik zostaje NIETKNIĘTY - peek() nie nadpisuje uszkodzonej treści defaultami.
    t.is(files[`${BASE}/.state.json`], '{not valid json');
});

test('StateManager.peek() na realnym pliku zwraca jego zawartość i source=file', async t => {
    const stored = JSON.stringify({ active_sessions: ['x.md'], archived_since_last_consolidation: 3, last_archive_at: '2026-09-01T00:00:00.000Z' });
    const { vault } = makeVault({ [`${BASE}/.state.json`]: stored });
    const sm = new StateManager(vault, `${BASE}/.state.json`);

    const result = await sm.peek();

    t.deepEqual(result, {
        state: { active_sessions: ['x.md'], archived_since_last_consolidation: 3, last_archive_at: '2026-09-01T00:00:00.000Z' },
        source: 'file',
    });
});

// ── resolveConsolidationThresholds — czyste funkcje, te same operatory/fallbacki co
//    dotychczasowe `SaveSessionWorkflow._shouldTriggerArchive`. ────────────────────────────

test('resolveConsolidationThresholds: bez state/settings -> same defaulty', t => {
    t.deepEqual(resolveConsolidationThresholds(null, null), {
        sessionThreshold: 10,
        brainNotesLimit: 20,
        brainNotesLimitSource: 'default',
        batchSize: 5,
    });
});

test('resolveConsolidationThresholds: memoryV3BrainNotesThreshold z ustawień -> limitSource=settings', t => {
    const result = resolveConsolidationThresholds(null, { memoryV3BrainNotesThreshold: 15 });
    t.is(result.brainNotesLimit, 15);
    t.is(result.brainNotesLimitSource, 'settings');
});

test('resolveConsolidationThresholds: archiveBrainNotesThreshold jako fallback ustawień -> limitSource=settings', t => {
    const result = resolveConsolidationThresholds(null, { archiveBrainNotesThreshold: 12 });
    t.is(result.brainNotesLimit, 12);
    t.is(result.brainNotesLimitSource, 'settings');
});

test('resolveConsolidationThresholds: state.brain_notes_limit ma pierwszeństwo nad ustawieniami -> limitSource=agent_state', t => {
    const result = resolveConsolidationThresholds(
        { brain_notes_limit: 30 },
        { memoryV3BrainNotesThreshold: 15 },
    );
    t.is(result.brainNotesLimit, 30);
    t.is(result.brainNotesLimitSource, 'agent_state');
});

test('resolveConsolidationThresholds: sessionThreshold i batchSize z ustawień', t => {
    const result = resolveConsolidationThresholds(null, {
        memoryV3SessionThreshold: 6,
        memoryV3ArchiveBatchSize: 7,
    });
    t.is(result.sessionThreshold, 6);
    t.is(result.batchSize, 7);
});

test('resolveConsolidationThresholds: archiveSessionThreshold jako fallback sessionThreshold', t => {
    const result = resolveConsolidationThresholds(null, { archiveSessionThreshold: 4 });
    t.is(result.sessionThreshold, 4);
});

// ── shouldTriggerConsolidation — granice: sesje `>=`, notatki `>`. ─────────────────────────

test('shouldTriggerConsolidation: sesje DOKŁADNIE na progu (>=) -> true', t => {
    t.true(shouldTriggerConsolidation({ archived_since_last_consolidation: 10 }, 0, null));
});

test('shouldTriggerConsolidation: sesje tuż pod progiem, notatki na limicie (nie NAD) -> false', t => {
    t.false(shouldTriggerConsolidation({ archived_since_last_consolidation: 9 }, 20, null));
});

test('shouldTriggerConsolidation: notatki NAD limitem (limit+1) -> true', t => {
    t.true(shouldTriggerConsolidation({ archived_since_last_consolidation: 9 }, 21, null));
});

// ── getConsolidationStatus — integracja na realnej `AgentMemory`. ──────────────────────────

test('getConsolidationStatus: świeży agent bez plików - defaulty, plan pusty, wouldTrigger=false', async t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.deepEqual(status, {
        agent: 'Agent',
        state: { source: 'missing', lastArchiveAt: null },
        brainNotes: { count: 0, limit: 20, limitSource: 'default', overLimit: false },
        sessions: {
            archivedSinceLastConsolidation: 0,
            threshold: 10,
            overThreshold: false,
            uncoveredArchive: 0,
            activeFiles: 0,
            stateActive: 0,
        },
        summaries: { uncoveredL1: 0, uncoveredL2: 0, batchSize: 5 },
        wouldTrigger: false,
        plan: [],
    });
});

test('getConsolidationStatus: 20 notatek na limicie 20 -> overLimit=false', async t => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 20; i++) files[`${BASE}/brain/reference_${i}.md`] = note(`Notatka ${i}`);
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.brainNotes.count, 20);
    t.is(status.brainNotes.limit, 20);
    t.false(status.brainNotes.overLimit);
    t.false(status.wouldTrigger);
});

test('getConsolidationStatus: 21 notatek nad limitem 20 -> overLimit=true i wouldTrigger=true', async t => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 21; i++) files[`${BASE}/brain/reference_${i}.md`] = note(`Notatka ${i}`);
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.brainNotes.count, 21);
    t.true(status.brainNotes.overLimit);
    t.true(status.wouldTrigger);
    // Dedup jest planowany od >= 2 notatek w brain/.
    t.true(status.plan.some(step => step.kind === 'dedup'));
});

test('getConsolidationStatus: 10 zarchiwizowanych sesji przy progu 10 -> overThreshold=true i wouldTrigger=true', async t => {
    const state = JSON.stringify({ active_sessions: [], archived_since_last_consolidation: 10, last_archive_at: '2026-09-01T00:00:00.000Z' });
    const { vault } = makeVault({ [`${BASE}/.state.json`]: state });
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.state.source, 'file');
    t.is(status.state.lastArchiveAt, '2026-09-01T00:00:00.000Z');
    t.is(status.sessions.archivedSinceLastConsolidation, 10);
    t.is(status.sessions.threshold, 10);
    t.true(status.sessions.overThreshold);
    t.true(status.wouldTrigger);
});

test('getConsolidationStatus: state.brain_notes_limit z .state.json -> limitSource=agent_state', async t => {
    const state = JSON.stringify({ active_sessions: [], archived_since_last_consolidation: 0, last_archive_at: null, brain_notes_limit: 30 });
    const { vault } = makeVault({ [`${BASE}/.state.json`]: state });
    const memory = new AgentMemory(vault, 'Agent', { memoryV3BrainNotesThreshold: 15 });

    const status = await getConsolidationStatus(memory);

    t.is(status.brainNotes.limit, 30);
    t.is(status.brainNotes.limitSource, 'agent_state');
});

test('getConsolidationStatus: uszkodzony .state.json -> state.source=unreadable, liczniki spadają na defaulty', async t => {
    const { vault } = makeVault({ [`${BASE}/.state.json`]: '{broken' });
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.state.source, 'unreadable');
    t.is(status.sessions.archivedSinceLastConsolidation, 0);
});

test('getConsolidationStatus: aktywne sesje i niepokryte archiwum liczone osobno', async t => {
    const files: Record<string, string> = {
        [`${BASE}/sessions/active/Agent_2026-09-20_10-00.md`]: '---\nagent: Agent\n---\n',
        [`${BASE}/sessions/archive/2026-09-01_09-00.md`]: '---\nagent: Agent\ncreated: 2026-09-01\n---\n',
    };
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.sessions.activeFiles, 1);
    t.is(status.sessions.uncoveredArchive, 1);
    // Za mało sesji na pełną paczkę (batchSize domyślny 5) -> brak kroków L1 w planie.
    t.false(status.plan.some(step => step.kind === 'l1'));
});

// ── P3: rozgrzana instancja NIE materializuje struktury, gdy zniknęła spod niej po starcie ──

test('getConsolidationStatus na ROZGRZANEJ instancji: .state.json i brain/ zniknęły po starcie -> ZERO zapisu, źródła zostają puste', async t => {
    const { vault, files, folders, calls } = makeVault();
    const memory = new AgentMemory(vault, 'Agent');

    // Rozgrzewamy instancję jak robi to produkcyjny `AgentManager.agentMemories` -
    // `_structureEnsured` jest już `true`, `.state.json` i `brain/` istnieją na dysku.
    await memory.initialize();
    t.true(Object.prototype.hasOwnProperty.call(files, `${BASE}/.state.json`), 'sanity: initialize() zakłada .state.json');
    t.true(folders.has(`${BASE}/brain`), 'sanity: initialize() zakłada brain/');

    // Desync z dyskiem PO starcie (sync chmurowy, ręczne skasowanie, inny proces) - dokładnie
    // scenariusz zmierzony przez recenzenta.
    delete files[`${BASE}/.state.json`];
    folders.delete(`${BASE}/brain`);
    calls.length = 0;

    const status = await getConsolidationStatus(memory);

    t.deepEqual(calls, [], 'getConsolidationStatus na rozgrzanej instancji nie ma prawa nic zapisać');
    t.is(status.state.source, 'missing');
    t.is(status.brainNotes.count, 0);
    t.false(Object.prototype.hasOwnProperty.call(files, `${BASE}/.state.json`), '.state.json dalej NIE istnieje');
    t.false(folders.has(`${BASE}/brain`), 'brain/ dalej NIE istnieje');
});

test('getConsolidationStatus: sessions.stateActive (z .state.json) i sessions.activeFiles (z dysku) liczone NIEZALEŻNIE - rozjazd jest widoczny', async t => {
    // .state.json pamięta DWIE sesje aktywne, z których jedna nie ma już pliku na dysku
    // (zombie) - dokładnie diagnostyka, do której `stateActive` istnieje.
    const state = JSON.stringify({
        active_sessions: ['Agent_2026-09-19_08-00.md', 'zombie.md'],
        archived_since_last_consolidation: 0,
        last_archive_at: null,
    });
    const files: Record<string, string> = {
        [`${BASE}/.state.json`]: state,
        [`${BASE}/sessions/active/Agent_2026-09-19_08-00.md`]: '---\nagent: Agent\n---\n',
    };
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.sessions.activeFiles, 1, 'z listowania katalogu - jeden PRAWDZIWY plik');
    t.is(status.sessions.stateActive, 2, 'z .state.json - dwie sesje, w tym jedna bez pliku');
});

test('getConsolidationStatus: activeFiles pomija podfolder .discarded/, licząc TYLKO pliki bezpośrednio w sessions/active', async t => {
    const files: Record<string, string> = {
        [`${BASE}/sessions/active/Agent_2026-09-20_10-00.md`]: '---\nagent: Agent\n---\n',
        [`${BASE}/sessions/active/.discarded/Agent_2026-09-18_09-00.md`]: '---\nagent: Agent\n---\n',
    };
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.sessions.activeFiles, 1);
});

test('getConsolidationStatus na ZIMNEJ instancji: bootstrap struktury odpala się dokładnie raz (bez podwójnego mkdir z równoległych wywołań)', async t => {
    const { vault, calls } = makeVault();
    const memory = new AgentMemory(vault, 'Agent'); // celowo BEZ initialize() - zimna instancja

    await getConsolidationStatus(memory);

    const mkdirPaths = calls.filter(c => c.startsWith('mkdir:')).map(c => c.slice('mkdir:'.length));
    const uniqueMkdirPaths = new Set(mkdirPaths);
    t.is(mkdirPaths.length, uniqueMkdirPaths.size, `każdy folder zakładany DOKŁADNIE raz, nie dwa razy równolegle: ${JSON.stringify(mkdirPaths)}`);
});

// ── resolvePlanDedupThreshold — formuła produkcyjnego `consolidationRunner.startConsolidationRun`,
//    CELOWO inna niż resolveConsolidationThresholds (brak fallbacku na archiveBrainNotesThreshold). ──

test('resolvePlanDedupThreshold: bez state/settings -> domyślne 20 (jak produkcja)', t => {
    t.is(resolvePlanDedupThreshold(null, null), 20);
});

test('resolvePlanDedupThreshold: memoryV3BrainNotesThreshold z ustawień nadpisuje domyślne 20', t => {
    t.is(resolvePlanDedupThreshold(null, { memoryV3BrainNotesThreshold: 15 }), 15);
});

test('resolvePlanDedupThreshold: archiveBrainNotesThreshold jest IGNOROWANY - to jest różnica względem resolveConsolidationThresholds', t => {
    t.is(resolvePlanDedupThreshold(null, { archiveBrainNotesThreshold: 12 }), 20);
    // Ten sam settings obiekt w "jednym liczydle" progów daje INNĄ wartość (12, źródło "settings") -
    // dwie funkcje celowo liczą różne rzeczy, patrz komentarz przy `resolvePlanDedupThreshold`.
    t.is(resolveConsolidationThresholds(null, { archiveBrainNotesThreshold: 12 }).brainNotesLimit, 12);
});

test('resolvePlanDedupThreshold: state.brain_notes_limit nadpisuje bazę (ustawienia LUB domyślne 20)', t => {
    t.is(resolvePlanDedupThreshold({ brain_notes_limit: 30 }, { memoryV3BrainNotesThreshold: 15 }), 30);
    t.is(resolvePlanDedupThreshold({ brain_notes_limit: 30 }, null), 30);
});
