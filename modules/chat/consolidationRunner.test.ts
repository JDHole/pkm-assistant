/**
 * consolidationRunner.test.js — KONTROLER przebiegu konsolidacji (S29 „Puls pamięci").
 *
 * Do 2026-07-29 ten plik nie miał ANI JEDNEGO testu, bo `consolidationRunner.js` statycznie
 * importował modal z barrela shella → `obsidian` → AVA wywalała się już na imporcie. Modal jest
 * teraz ładowany leniwie, a testy wstrzykują atrapę klasy (`_setModalClassForTests`).
 *
 * Zasada repo: integracyjne > jednostkowe. `AgentMemory`, `ArchiveWorkflow`, `ConsolidationRun`
 * i `memoryOpsCenter` są PRAWDZIWE — atrapy dostają tylko model (skrypt strzałów), modal
 * (zliczanie open/close) i plugin (zbieranie notice'ów).
 *
 * ⚠️ WSZYSTKIE testy są `serial`: `memoryOpsCenter` to singleton modułowy, a `openModal` +
 * subskrypcja openera to stan modułu `consolidationRunner`. Równoległe biegi deptałyby sobie po
 * nogach. `beforeEach`/`afterEach` sprzątają jedno i drugie.
 */
import test from 'ava';
import {
    startConsolidationRun,
    openConsolidationModal,
    _setModalClassForTests,
} from './consolidationRunner.js';
import { AgentMemory, memoryOpsCenter, STEP_STATUS } from '../memory/index.js';
import type {
    ConsolidationRun,
    ConsolidationStep,
    MemoryVaultLike,
    StepStatus,
    StreamChatModelLike,
} from '../memory/index.js';
import { setLocale } from '../../core/i18n/index.js';
import { en } from '../../core/i18n/en.js';

// TS-any: testowe App DI i payload JSON nie mają zamkniętego produkcyjnego kontraktu.
type Runtime = any;
type FileMap = Record<string, string>;
type ScriptAction = string | Error;
type StreamRequest = Parameters<StreamChatModelLike['stream']>[0];
type StreamHandlers = Parameters<StreamChatModelLike['stream']>[1];
type StartOptions = Parameters<typeof startConsolidationRun>[0];
type StartOverrides = Partial<StartOptions>;
type ProductionRun = NonNullable<Awaited<ReturnType<typeof startConsolidationRun>>>;
type TestRun = {
    getStep(stepId: string): ConsolidationStep;
} & ProductionRun;
type ModalConstructor = NonNullable<Parameters<typeof _setModalClassForTests>[0]>;
type ModalOptions = ConstructorParameters<ModalConstructor>[1];
type RunnerController = NonNullable<ModalOptions['controller']>;

interface MockVaultResult {
    files: FileMap;
    folders: Set<string>;
    vault: MemoryVaultLike;
}

interface ScriptedModel extends StreamChatModelLike {
    calls: StreamRequest[];
    stopped: number;
}

interface NoticeOptions {
    type?: string;
    timeout?: number;
}

interface NoticeRecord {
    message: string;
    opts: NoticeOptions;
    kind: string;
}

interface MakeEnvOptions {
    files?: FileMap;
    script?: ScriptAction[];
    settings?: Record<string, unknown>;
}

interface TestEnvironment {
    vault: MemoryVaultLike;
    files: FileMap;
    memory: AgentMemory;
    model: ScriptedModel;
    notices: NoticeRecord[];
    plugin: StartOptions['plugin'];
    app: Runtime;
    agent: { name: string; summary_prompt: string };
    settings: { limits: { chat_stream_stall_timeout_ms: number } } & Record<string, unknown>;
    start(extra?: StartOverrides): Promise<TestRun>;
    kinds(kind: string): NoticeRecord[];
}

type BuildingTestEnvironment = Omit<TestEnvironment, 'start' | 'kinds'>
    & Partial<Pick<TestEnvironment, 'start' | 'kinds'>>;

setLocale('en'); // klasyfikator notice'ów niżej czyta szablony z `en.js`

// ── atrapy vaultu i modelu (wzorzec z modules/memory/ArchiveWorkflowRun.test.js) ───

function makeVault(initialFiles: FileMap = {}, initialFolders: string[] = []): MockVaultResult {
    const files: FileMap = { ...initialFiles };
    const folders = new Set<string>(initialFolders);

    const parentFoldersFor = (path: string): string[] => {
        const parts = path.split('/');
        const result: string[] = [];
        for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join('/'));
        return result;
    };
    for (const path of Object.keys(files)) {
        for (const folder of parentFoldersFor(path)) folders.add(folder);
    }

    return {
        files,
        folders,
        vault: {
            adapter: {
                async exists(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) { folders.add(path); },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    for (const folder of parentFoldersFor(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) { delete files[path]; },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(p => p.startsWith(prefix)),
                        folders: [...folders].filter(p => p.startsWith(prefix) && p !== folder),
                    };
                },
                async stat(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) ? { mtime: 1 } : null;
                },
            },
        },
    };
}

const BASE = '.pkm-assistant/agents/jaskier/memory';
const COST_LOG = '.pkm-assistant/cost_log.jsonl';

function session(name: string, { covered = '' }: { covered?: string } = {}): string {
    const fm = ['---', 'type: archived_session'];
    if (covered) fm.push(`covered_by_l1: ${covered}`);
    fm.push('---', '', '## User', `Treść sesji ${name}`, '');
    return fm.join('\n');
}

/** N sesji w `sessions/archive`; `covered` pierwszych dostaje stempel `covered_by_l1`. */
function archiveWith(count: number, { covered = 0 }: { covered?: number } = {}): FileMap {
    const initial: FileMap = {};
    for (let i = 1; i <= count; i++) {
        const name = `session_${String(i).padStart(3, '0')}.md`;
        initial[`${BASE}/sessions/archive/${name}`] = session(name, {
            covered: i <= covered ? '2026-07-01_l1.md' : '',
        });
    }
    return initial;
}

function summaryFile(level: string, fields: Record<string, string[]> = {}, body = 'Summary'): string {
    const lines = ['---', `level: ${level}`];
    for (const [key, values] of Object.entries(fields)) {
        lines.push(`${key}:`);
        for (const value of values) lines.push(`  - ${value}`);
    }
    lines.push('---', '', body);
    return lines.join('\n');
}

function brainNoteFile(name: string, type: string, body = 'note body'): string {
    return ['---', `name: ${JSON.stringify(name)}`, 'description: ""', `type: ${type}`, 'created: 2026-05-15', '---', body].join('\n');
}

/**
 * Model sterowany skryptem — jeden wpis na wywołanie:
 *  - string   → done() z tą treścią,
 *  - 'SILENT' → nic nie oddaje (zwis; watchdog musi go ubić),
 *  - Error    → error().
 */
function scriptedModel(script: ScriptAction[] = []): ScriptedModel {
    const model: ScriptedModel = {
        calls: [],
        stopped: 0,
        stopStream() { model.stopped++; },
        stream(req: StreamRequest, handlers: StreamHandlers) {
            const action = script[model.calls.length] ?? 'Domyślne streszczenie';
            model.calls.push(req);
            if (action === 'SILENT') return;
            if (action instanceof Error) {
                setTimeout(() => handlers.error(action), 0);
                return;
            }
            setTimeout(() => handlers.done({
                choices: [{ message: { content: action } }],
                usage: { prompt_tokens: 100, completion_tokens: 20 },
            }), 0);
        },
    };
    return model;
}

// ── atrapa modalu ─────────────────────────────────────────────────────────────────

let modals: FakeModal[] = [];

class FakeModal {
    declare app: Runtime;
    declare run: ConsolidationRun | null;
    declare controller: RunnerController | null;
    declare agentName: string;
    declare _onClosed: (() => void) | null;
    declare opened: number;
    declare closed: number;

    constructor(app: Runtime, opts: Partial<ModalOptions> = {}) {
        this.app = app;
        this.run = opts.run || null;
        this.controller = opts.controller || null;
        this.agentName = opts.agentName || '';
        this._onClosed = opts.onClosed || null;
        this.opened = 0;
        this.closed = 0;
        modals.push(this);
    }
    open() { this.opened++; }
    close() { this.closed++; this._onClosed?.(); }
}

const lastModal = (): FakeModal => (modals[modals.length - 1] || null)!;
/** Kontroler przebiegu — modal dostaje go w opcjach, więc atrapa jest naszą furtką do API. */
const controllerOf = (run: TestRun): RunnerController => (modals.find(m => m.run === run)?.controller || null)!;

// ── notice'y: rozpoznanie po stałym początku szablonu i18n ─────────────────────────

const NOTICE_KEYS = Object.keys(en).filter(k => k.startsWith('memory.consolidation.notice_'));

function noticeKind(message: string): string {
    for (const key of NOTICE_KEYS) {
        const head = String(en[key]).split('{{')[0];
        if (head && String(message).startsWith(head)) return key.replace('memory.consolidation.notice_', '');
    }
    return 'other';
}

// ── środowisko testu ──────────────────────────────────────────────────────────────

function makeEnv({ files = {}, script = [], settings = {} }: MakeEnvOptions = {}): TestEnvironment {
    const { vault, files: fileMap } = makeVault(files);
    const memory = new AgentMemory(vault, 'Jaskier');
    const model = scriptedModel(script);
    const notices: NoticeRecord[] = [];
    const plugin = {
        showCrystalNotice(message: string, opts: NoticeOptions = {}) {
            notices.push({ message, opts, kind: noticeKind(message) });
        },
    };
    const env: BuildingTestEnvironment = {
        vault, files: fileMap, memory, model, notices, plugin,
        app: {},
        agent: { name: 'Jaskier', summary_prompt: 'Zrób {{LEVEL}}' },
        settings: { limits: { chat_stream_stall_timeout_ms: 30 }, ...settings },
    };
    /** `extra` pozwala dołożyć np. `source: 'auto'` bez dublowania całego wywołania. */
    env.start = (extra: StartOverrides = {}) => startConsolidationRun({
        plugin: env.plugin,
        app: env.app,
        agentMemory: env.memory as StartOptions['agentMemory'],
        agent: env.agent,
        model: env.model,
        settings: env.settings,
        ...extra,
    }) as Promise<TestRun>;
    env.kinds = (kind: string) => env.notices.filter(n => n.kind === kind);
    return env as TestEnvironment;
}

/** Generacja jest fire-and-forget — czekamy na warunek zamiast zgadywać liczbę tików. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, label = 'warunek', timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return true;
        if (Date.now() > deadline) throw new Error(`waitUntil: nie doczekałem się (${label})`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

const waitStatus = (run: TestRun, stepId: string, status: StepStatus): Promise<boolean> =>
    waitUntil(() => run.getStep(stepId)?.status === status, `${stepId} → ${status}`);
const waitSettled = (run: TestRun): Promise<boolean> => waitUntil(() => run.isSettled(), 'przebieg rozstrzygnięty');

test.beforeEach(() => {
    modals = [];
    _setModalClassForTests(FakeModal);
    if (memoryOpsCenter.getActiveRun()) memoryOpsCenter.finishRun();
});

test.afterEach.always(() => {
    for (const modal of modals) {
        try { modal.close(); } catch (_) { /* best-effort */ }
    }
    modals = [];
    _setModalClassForTests(null);
    if (memoryOpsCenter.getActiveRun()) memoryOpsCenter.finishRun();
});

// ── start przebiegu ───────────────────────────────────────────────────────────────

test.serial('pusty plan → null, notice „nie ma czego", centrum wolne, zero modali', async t => {
    const env = makeEnv();

    const run = await env.start();

    t.is(run, null as unknown as TestRun);
    t.is(env.kinds('nothing').length, 1);
    t.is(memoryOpsCenter.getActiveRun(), null);
    t.is(modals.length, 0, 'pusty plan nie otwiera okna');
    t.is(env.model.calls.length, 0, 'zero strzałów do modelu');
});

test.serial('Z4.4: pusty plan z triggera AUTOMATYCZNEGO milczy (koniec notice-spamu po każdym zapisie)', async t => {
    // Licznik `archived_since_last_consolidation` zeruje dopiero realny zapis L1, więc gdy
    // materiału jest mniej niż batchSize, próg jest przebity przy KAŻDYM kolejnym `/save session`.
    const env = makeEnv();

    const run = await env.start({ source: 'auto' });

    t.is(run, null as unknown as TestRun);
    t.is(env.kinds('nothing').length, 0, 'automat nie zawraca głowy');
    t.is(env.notices.length, 0, 'żadnego notice w ogóle');
    t.is(memoryOpsCenter.getActiveRun(), null);
    t.is(modals.length, 0);
});

test.serial('Z4.4: pusty plan z triggera RĘCZNEGO nadal odpowiada („nie ma czego konsolidować")', async t => {
    const env = makeEnv();

    const run = await env.start({ source: 'manual' });

    t.is(run, null as unknown as TestRun);
    t.is(env.kinds('nothing').length, 1, 'guzik usera musi dać odpowiedź');
});

test.serial('plan z liczników → przebieg w centrum + notice startowy + JEDNO okno', async t => {
    const env = makeEnv({
        files: archiveWith(2),
        settings: { memoryV3ArchiveBatchSize: 2 },
    });

    const run = await env.start();

    t.truthy(run);
    t.is(memoryOpsCenter.getActiveRun(), run);
    t.is(env.kinds('start').length, 1);
    t.is(modals.length, 1);
    t.is(lastModal().opened, 1);
    t.is(lastModal().run, run);
    t.is(lastModal().agentName, 'Jaskier');
    t.truthy(lastModal().controller, 'modal dostaje kontroler przebiegu');

    await waitStatus(run, 'l1_batch_1', STEP_STATUS.AWAITING_REVIEW);
});

test.serial('próg dedupu: `brain_notes_limit` ze `.state.json` bije ustawienie', async t => {
    const env = makeEnv({
        files: {
            [`${BASE}/brain/user_a.md`]: brainNoteFile('A', 'user'),
            [`${BASE}/brain/user_b.md`]: brainNoteFile('B', 'user'),
            [`${BASE}/.state.json`]: JSON.stringify({ brain_notes_limit: 33 }),
        },
        settings: { memoryV3BrainNotesThreshold: 20 },
    });

    const run = await env.start();

    t.is(run.getStep('dedup').meta.dedupThreshold, 33);
    await waitUntil(() => run.getStep('dedup').status !== STEP_STATUS.RUNNING
        && run.getStep('dedup').status !== STEP_STATUS.PENDING, 'dedup przestał mielić');
});

test.serial('próg dedupu: uszkodzony `.state.json` spada na ustawienie', async t => {
    const env = makeEnv({
        files: {
            [`${BASE}/brain/user_a.md`]: brainNoteFile('A', 'user'),
            [`${BASE}/brain/user_b.md`]: brainNoteFile('B', 'user'),
            [`${BASE}/.state.json`]: '{ to nie jest JSON',
        },
        settings: { memoryV3BrainNotesThreshold: 7 },
    });

    const run = await env.start();

    t.is(run.getStep('dedup').meta.dedupThreshold, 7);
    await waitUntil(() => run.getStep('dedup').status !== STEP_STATUS.RUNNING
        && run.getStep('dedup').status !== STEP_STATUS.PENDING, 'dedup przestał mielić');
});

test.serial('drugi trigger przy zajętym centrum zwraca CUDZY przebieg (zero podwójnej roboty)', async t => {
    const env = makeEnv({
        files: archiveWith(2),
        settings: { memoryV3ArchiveBatchSize: 2 },
    });

    const runA = await env.start();
    const runB = await env.start();

    t.is(runB, runA, 'drugi start dostaje przebieg, który już leci');
    t.is(env.kinds('busy').length, 1);
    t.is(env.kinds('start').length, 1, 'notice startowy tylko dla pierwszego');
    t.is(modals.length, 1, 'to samo okno, nie drugie');

    await waitStatus(runA, 'l1_batch_1', STEP_STATUS.AWAITING_REVIEW);
    t.is(env.model.calls.length, 1, 'jedna paczka = jeden strzał, mimo dwóch triggerów');
});

test.serial('archiveCount liczy TYLKO sesje bez stempla `covered_by_l1`', async t => {
    // 5 sesji, 3 już pokryte przez L1 → materiału starczy na 0 paczek (2 < 5).
    // Gdyby plan liczył wszystkie pliki archiwum, obiecałby paczkę, którą generator odrzuca.
    const covered = makeEnv({ files: archiveWith(5, { covered: 3 }) });
    t.is(await covered.start(), null as unknown as TestRun);
    t.is(covered.kinds('nothing').length, 1);

    // Kontrola: te same 5 sesji BEZ stempli → plan powstaje.
    const fresh = makeEnv({ files: archiveWith(5) });
    const run = await fresh.start();
    t.truthy(run);
    t.is(run.getStepsByKind('l1').length, 1);
    await waitStatus(run, 'l1_batch_1', STEP_STATUS.AWAITING_REVIEW);
});

test.serial('archiwum listowane RAZ na cykl: plan i generacja dzielą jedną listę', async t => {
    // Listowanie niepokrytych sesji to stat() + read() frontmattera per plik archiwum. Runner
    // robił je dla planu, a `runWithRun` zaraz potem drugi raz — na 60 sesjach dwa pełne obchody
    // dysku, zanim user cokolwiek zobaczył.
    const env = makeEnv({ files: archiveWith(10), settings: { memoryV3ArchiveBatchSize: 5 } });
    let listings = 0;
    const orig = env.memory.listUncoveredArchiveSessions.bind(env.memory);
    env.memory.listUncoveredArchiveSessions = async (...args) => {
        listings++;
        return orig(...args);
    };

    const run = await env.start();
    await waitStatus(run, 'l1_batch_2', STEP_STATUS.AWAITING_REVIEW);

    t.is(listings, 1, 'jedno listowanie archiwum na cały cykl start + generacja');
    t.deepEqual(run.getStep('l1_batch_1').result!.sessions, [
        'session_001.md', 'session_002.md', 'session_003.md', 'session_004.md', 'session_005.md'
    ]);
    t.deepEqual(run.getStep('l1_batch_2').result!.sessions, [
        'session_006.md', 'session_007.md', 'session_008.md', 'session_009.md', 'session_010.md'
    ]);
});

// ── pełny cykl ────────────────────────────────────────────────────────────────────

test.serial('happy path: propozycja → decyzja → domknięcie z notice, kosztem i wolnym centrum', async t => {
    const env = makeEnv({
        files: archiveWith(2),
        settings: { memoryV3ArchiveBatchSize: 2 },
    });

    const run = await env.start();
    await waitStatus(run, 'l1_batch_1', STEP_STATUS.AWAITING_REVIEW);
    await controllerOf(run).applyDecision('l1_batch_1', { accepted: true, body: 'wersja Kuby' });

    t.is(run.getStep('l1_batch_1').status, STEP_STATUS.DONE);
    t.true(run.isSettled());
    t.is(env.kinds('done').length, 1);
    t.is(memoryOpsCenter.getActiveRun(), null, 'centrum zwolnione = pasek statusu gaśnie');

    const l1 = Object.keys(env.files).filter(p => p.includes('/summaries/L1/'));
    t.is(l1.length, 1);
    t.true(env.files[l1[0]].includes('wersja Kuby'));

    await waitUntil(() => Boolean(env.files[COST_LOG]), 'wpis w cost_log.jsonl');
    const entries = env.files[COST_LOG].trim().split('\n').map(line => JSON.parse(line));
    t.is(entries.length, 1);
    t.is(entries[0].role, 'memory-consolidation');
    t.is(entries[0].agent, 'Jaskier');
    t.is(entries[0].input_tokens, 100);
    t.is(entries[0].output_tokens, 20);
});

test.serial('kaskada: decyzja o ostatniej L1 odgatowuje L2, a decyzja o L2 — L3', async t => {
    const env = makeEnv({
        files: {
            ...archiveWith(4),
            // Jeden L2 już na dysku, żeby L3 był w ogóle osiągalny (l2Count + 1 >= batchSize).
            [`${BASE}/summaries/L2/2026-07-01_l2.md`]: summaryFile('L2', { l1_files: ['stare_l1.md'] }),
        },
        settings: { memoryV3ArchiveBatchSize: 2 },
    });

    const run = await env.start();
    await waitStatus(run, 'l1_batch_2', STEP_STATUS.AWAITING_REVIEW);
    t.is(run.getStep('l2').status, STEP_STATUS.GATED);
    t.is(run.getStep('l3').status, STEP_STATUS.GATED);

    const controller = controllerOf(run);
    await controller.applyDecision('l1_batch_1', { accepted: true });
    t.is(run.getStep('l2').status, STEP_STATUS.GATED, 'jedna paczka to za mało na zdjęcie kłódki');

    await controller.applyDecision('l1_batch_2', { accepted: true });
    t.is(run.getStep('l2').status, STEP_STATUS.AWAITING_REVIEW, 'ostatnia L1 odgatowała L2');
    t.is(run.getStep('l3').status, STEP_STATUS.GATED, 'L3 czeka na rozstrzygnięcie L2');

    await controller.applyDecision('l2', { accepted: true });
    t.is(run.getStep('l3').status, STEP_STATUS.AWAITING_REVIEW, 'jedno advance zdjęło kłódkę z L3');
});

test.serial('każdy krok odpadł → przebieg domyka się sam, bez decyzji usera', async t => {
    // Nikt nie kliknie decyzji, więc domknięcie musi zrobić `generate()` → `advance()`.
    // Dwie notatki bez wspólnego mianownika → dedup nie ma co proponować → krok `skipped`.
    //
    // ⚠️ Ten test do 2026-07-30 symulował inny wyścig: plan widział 4 sesje, a generator (drugie
    // listowanie archiwum) już tylko jedną. Po przejściu na JEDNĄ listę (runner podaje ją
    // workflow) tego okna nie ma — plan i generacja patrzą na ten sam materiał z definicji.
    const env = makeEnv({
        files: {
            [`${BASE}/brain/user_a.md`]: brainNoteFile('A', 'user'),
            [`${BASE}/brain/agent_rule_b.md`]: brainNoteFile('B', 'agent_rule'),
        },
        script: [JSON.stringify({ merges: [], deletions: [] })],
        settings: { memoryV3BrainNotesThreshold: 2 },
    });

    const run = await env.start();
    await waitSettled(run);

    t.is(run.getStep('dedup').status, STEP_STATUS.SKIPPED);
    t.is(run.getStep('dedup').meta.skipReason, 'nothing_to_merge');
    t.is(env.kinds('done').length, 1, 'podsumowanie mimo braku decyzji usera');
    t.is(memoryOpsCenter.getActiveRun(), null);
    t.is(Object.keys(env.files).filter(p => p.includes('/summaries/L1/')).length, 0);
});

// ── pady i ponowienia ─────────────────────────────────────────────────────────────

test.serial('pad generacji → failed + JEDEN notice o padzie (nie po jednym na rundę)', async t => {
    const env = makeEnv({
        files: archiveWith(2),
        script: ['SILENT', 'SILENT'],
        settings: { memoryV3ArchiveBatchSize: 2 },
    });

    const run = await env.start();
    await waitStatus(run, 'l1_batch_1', STEP_STATUS.FAILED);
    await waitSettled(run);

    t.is(run.getStep('l1_batch_1').error!.code, 'stream_stalled');
    t.is(run.getStep('l1_batch_1').retryCount, 1, 'jedno auto-ponowienie po zwisie');
    t.is(env.kinds('failed').length, 1, 'zwis i outcome nie krzyczą dwa razy o tym samym kroku');
});

test.serial('„Ponów" po padzie GENERACJI odpala nowy strzał do modelu', async t => {
    const env = makeEnv({
        files: archiveWith(2),
        script: ['SILENT', 'SILENT'],
        settings: { memoryV3ArchiveBatchSize: 2 },
    });

    const run = await env.start();
    await waitStatus(run, 'l1_batch_1', STEP_STATUS.FAILED);
    t.is(env.model.calls.length, 2);

    await controllerOf(run).retry('l1_batch_1');

    t.is(run.getStep('l1_batch_1').status, STEP_STATUS.AWAITING_REVIEW);
    t.is(env.model.calls.length, 3, 'ponowna generacja = kolejny strzał');
    t.is(memoryOpsCenter.getActiveRun(), run, 'przebieg wrócił do gry');
});

test.serial('„Ponów" po padzie ZAPISU powtarza zapis z decyzją usera, bez nowego strzału', async t => {
    const env = makeEnv({
        files: archiveWith(2),
        settings: { memoryV3ArchiveBatchSize: 2 },
    });
    // Psujemy TYLKO zapis podsumowań — cost log i .state.json muszą działać.
    const realWrite = env.vault.adapter.write.bind(env.vault.adapter);
    let breakSummaryWrite = true;
    env.vault.adapter.write = async (path, content) => {
        if (breakSummaryWrite && path.includes('/summaries/')) throw new Error('dysk pełny');
        return realWrite(path, content);
    };

    const run = await env.start();
    await waitStatus(run, 'l1_batch_1', STEP_STATUS.AWAITING_REVIEW);
    const controller = controllerOf(run);
    await controller.applyDecision('l1_batch_1', { accepted: true, body: 'wersja Kuby' });
    t.is(run.getStep('l1_batch_1').status, STEP_STATUS.FAILED);

    breakSummaryWrite = false;
    await controller.retry('l1_batch_1');

    t.is(run.getStep('l1_batch_1').status, STEP_STATUS.DONE);
    t.is(env.model.calls.length, 1, 'zapis ponowiony bez palenia kolejnego strzału LLM');
    const l1 = Object.keys(env.files).filter(p => p.includes('/summaries/L1/'));
    t.is(l1.length, 1);
    t.true(env.files[l1[0]].includes('wersja Kuby'), 'edycja usera przeżyła ponowienie');
});

test.serial('drugie domknięcie przebiegu księguje tylko DELTĘ kosztu', async t => {
    const env = makeEnv({
        files: archiveWith(2),
        settings: { memoryV3ArchiveBatchSize: 2 },
    });
    const realWrite = env.vault.adapter.write.bind(env.vault.adapter);
    let breakSummaryWrite = true;
    env.vault.adapter.write = async (path, content) => {
        if (breakSummaryWrite && path.includes('/summaries/')) throw new Error('dysk pełny');
        return realWrite(path, content);
    };

    const run = await env.start();
    await waitStatus(run, 'l1_batch_1', STEP_STATUS.AWAITING_REVIEW);
    const controller = controllerOf(run);
    await controller.applyDecision('l1_batch_1', { accepted: true });
    t.true(run.isSettled(), 'krok failed też domyka przebieg');
    await waitUntil(() => Boolean(env.files[COST_LOG]), 'pierwszy wpis kosztu');

    breakSummaryWrite = false;
    await controller.retry('l1_batch_1');
    await waitSettled(run);

    t.is(env.kinds('done').length, 2, 'każde domknięcie ma swoje podsumowanie');
    const entries = env.files[COST_LOG].trim().split('\n');
    t.is(entries.length, 1, 'zerowa delta = brak drugiego wpisu (koszt nie liczy się dwa razy)');
});

test.serial('„Pomiń" na padniętej paczce L1 odblokowuje bramkę L2', async t => {
    const env = makeEnv({
        files: archiveWith(6),
        // Paczka 1 OK, paczka 2 zwisa dwa razy (→ failed), paczka 3 OK.
        script: ['Paczka 1', 'SILENT', 'SILENT', 'Paczka 3'],
        settings: { memoryV3ArchiveBatchSize: 2 },
    });

    const run = await env.start();
    await waitStatus(run, 'l1_batch_2', STEP_STATUS.FAILED);
    await waitStatus(run, 'l1_batch_3', STEP_STATUS.AWAITING_REVIEW);

    const controller = controllerOf(run);
    await controller.applyDecision('l1_batch_1', { accepted: true });
    await controller.applyDecision('l1_batch_3', { accepted: true });
    t.is(run.getStep('l2').status, STEP_STATUS.GATED, 'padnięta paczka ≠ rozstrzygnięta');

    await controller.skip('l1_batch_2');

    t.is(run.getStep('l1_batch_2').status, STEP_STATUS.SKIPPED);
    t.is(run.getStep('l2').status, STEP_STATUS.AWAITING_REVIEW, 'świadome odpuszczenie zdjęło kłódkę');
});

// ── okno przebiegu ────────────────────────────────────────────────────────────────

test.serial('powtórne otwarcie okna dla TEGO SAMEGO przebiegu nie tworzy drugiego modalu', async t => {
    const env = makeEnv({
        files: archiveWith(2),
        settings: { memoryV3ArchiveBatchSize: 2 },
    });

    const run = await env.start();
    const again = await openConsolidationModal(env.app, run);

    t.is(modals.length, 1);
    t.is(again, lastModal());

    // Zamknięcie okna zwalnia slot — klik w 🧠 buduje świeże okno tego samego przebiegu.
    lastModal().close();
    await openConsolidationModal(env.app, run);
    t.is(modals.length, 2);
    t.is(lastModal().run, run);

    await waitStatus(run, 'l1_batch_1', STEP_STATUS.AWAITING_REVIEW);
});
