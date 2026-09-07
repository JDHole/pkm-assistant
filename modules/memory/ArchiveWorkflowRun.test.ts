/**
 * ArchiveWorkflowRun.test.js — S29 Z3: NOWY tor ArchiveWorkflow (generacja ≠ aplikacja).
 *
 * Stary, blokujący `run()` ma własne testy w `ArchiveWorkflow.test.js` — celowo nietknięte.
 * Tu sprawdzamy tylko to, co dokłada Puls pamięci: pętlę paczek L1 w jednym przebiegu,
 * rozdzielenie propozycji od zapisu, bramkę L2/L3, koszt per krok i politykę zwisu.
 *
 * Atrapa modelu wg kontraktu `streamToComplete` (`.stream({messages}, {chunk, done, error})`).
 */
import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { ArchiveWorkflow } from './ArchiveWorkflow.js';
import { ConsolidationRun, STEP_STATUS, STEP_KIND } from './ConsolidationRun.js';
import { ConsolidationSnapshot } from './ConsolidationSnapshot.js';
import type { MemoryVaultLike } from './AgentMemory.js';
import type { StreamChatModelLike, StreamHandlers, StreamMessage } from './streamHelper.js';

function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
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

function session(_name: string, body = 'Treść sesji') {
    return `---\ntype: archived_session\n---\n\n## User\n${body}\n`;
}

function summaryFile(level: string, fields: Record<string, string[]> = {}, body = 'Summary') {
    const lines = ['---', `level: ${level}`];
    for (const [key, values] of Object.entries(fields)) {
        lines.push(`${key}:`);
        for (const value of values) lines.push(`  - ${value}`);
    }
    lines.push('---', '', body);
    return lines.join('\n');
}

function brainNoteFile(name: string, type: string, body = 'note body') {
    return ['---', `name: ${JSON.stringify(name)}`, 'description: ""', `type: ${type}`, 'created: 2026-05-15', '---', body].join('\n');
}

/** N sesji w `sessions/archive` z nazwami sortowalnymi leksykalnie (001..N). */
function archiveWith(count: number) {
    const initial: Record<string, string> = {};
    for (let i = 1; i <= count; i++) {
        const name = `session_${String(i).padStart(3, '0')}.md`;
        initial[`${BASE}/sessions/archive/${name}`] = session(name, `Sesja ${i}`);
    }
    return initial;
}

/**
 * Model sterowany skryptem — jeden wpis na wywołanie:
 *  - string        → done() z tą treścią,
 *  - 'SILENT'      → nic nie oddaje (zwis; watchdog musi go ubić),
 *  - Error         → error().
 * Domyślnie (po wyczerpaniu skryptu) oddaje 'Domyślne streszczenie'.
 */
interface ScriptedModel extends StreamChatModelLike {
    calls: Array<{ messages: StreamMessage[] }>;
    stopped: number;
}

function scriptedModel(script: Array<string | Error> = []): ScriptedModel {
    const model: ScriptedModel = {
        calls: [],
        stopped: 0,
        stopStream() { model.stopped++; },
        stream(req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
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

function makeWorkflow(vault: MemoryVaultLike, options: Record<string, unknown> = {}) {
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', summary_prompt: 'Zrób {{LEVEL}}' },
        ...options,
    });
    return { memory, workflow };
}

const l1FilesIn = (files: Record<string, string>): string[] => Object.keys(files).filter(p => p.includes('/summaries/L1/') && p.endsWith('.md'));

// ── pętla paczek: 60 sesji = 12 paczek w JEDNYM przebiegu ─────────────────────────

test('60 sesji → 12 paczek L1 wygenerowanych, ZERO zapisanych plików', async t => {
    const { vault, files } = makeVault(archiveWith(60));
    const model = scriptedModel();
    const { workflow } = makeWorkflow(vault, { model });
    const run = new ConsolidationRun({ counts: { archiveCount: 60, batchSize: 5 } });

    const outcome = await workflow.runWithRun(run);

    const l1Steps = run.getStepsByKind('l1');
    t.is(l1Steps.length, 12);
    t.true(l1Steps.every(s => s.status === STEP_STATUS.AWAITING_REVIEW));
    t.is(outcome.generated.length, 12);
    t.is(l1FilesIn(files).length, 0, 'generacja NIC nie zapisuje');
    t.is(model.calls.length, 12, 'jeden strzał LLM na paczkę');
});

test('paczki biorą kolejne, nienachodzące na siebie okna posortowanego archiwum', async t => {
    const { vault } = makeVault(archiveWith(15));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 15, batchSize: 5 } });

    await workflow.runWithRun(run);

    t.deepEqual(run.getStep('l1_batch_1')!.result!.sessions, [
        'session_001.md', 'session_002.md', 'session_003.md', 'session_004.md', 'session_005.md'
    ]);
    t.deepEqual(run.getStep('l1_batch_3')!.result!.sessions, [
        'session_011.md', 'session_012.md', 'session_013.md', 'session_014.md', 'session_015.md'
    ]);
    const all = run.getStepsByKind('l1').flatMap(s => s.result!.sessions!);
    t.is(new Set(all).size, 15, 'żadna sesja nie trafia do dwóch paczek');
});

test('paczka bez kompletu sesji (archiwum schudło po zbudowaniu planu) jest pomijana', async t => {
    const { vault } = makeVault(archiveWith(7)); // plan mówi 2 paczki, na dysku starczy na 1
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5 } });

    await workflow.runWithRun(run);

    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.AWAITING_REVIEW);
    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.SKIPPED);
    t.is(run.getStep('l1_batch_2')!.meta.skipReason, 'not_enough_sessions');
});

// ── aplikacja po decyzji usera ────────────────────────────────────────────────────

test('applyStepDecision zapisuje L1, resetuje licznik konsolidacji i zostawia sesje', async t => {
    const { vault, files } = makeVault(archiveWith(5));
    const { memory, workflow } = makeWorkflow(vault, { model: scriptedModel(['# Tydzień w pigułce']) });
    await memory.stateManager.write({ archived_since_last_consolidation: 5 });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });

    await workflow.runWithRun(run);
    const res = await workflow.applyStepDecision(run, 'l1_batch_1', { accepted: true });

    t.true(res.applied);
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.DONE);
    const l1 = l1FilesIn(files);
    t.is(l1.length, 1);
    t.true(files[l1[0]].includes('# Tydzień w pigułce'));
    t.true(files[l1[0]].includes('session_001.md'), 'frontmatter niesie pokryte sesje');
    // Sesje ZOSTAJĄ (kasuje je dopiero L2) — kontrakt Memory v3.
    t.true(Object.prototype.hasOwnProperty.call(files, `${BASE}/sessions/archive/session_001.md`));
    const state = JSON.parse(files[`${BASE}/.state.json`]);
    t.is(state.archived_since_last_consolidation, 0);
});

test('user może podmienić treść przy akceptacji (decision.body wygrywa z propozycją)', async t => {
    const { vault, files } = makeVault(archiveWith(5));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel(['wersja modelu']) });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });

    await workflow.runWithRun(run);
    await workflow.applyStepDecision(run, 'l1_batch_1', { accepted: true, body: 'wersja Kuby' });

    const content = files[l1FilesIn(files)[0]];
    t.true(content.includes('wersja Kuby'));
    t.false(content.includes('wersja modelu'));
});

test('odrzucenie paczki → skipped, zero plików', async t => {
    const { vault, files } = makeVault(archiveWith(5));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });

    await workflow.runWithRun(run);
    const res = await workflow.applyStepDecision(run, 'l1_batch_1', { accepted: false });

    t.false(res.applied);
    t.true(res.skipped);
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.SKIPPED);
    t.is(l1FilesIn(files).length, 0);
});

test('12 paczek zaakceptowanych pod rząd daje 12 RÓŻNYCH plików L1 (nazwy nie kolidują)', async t => {
    const { vault, files } = makeVault(archiveWith(60));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 60, batchSize: 5 } });

    await workflow.runWithRun(run);
    for (const step of run.getStepsByKind('l1')) {
        await workflow.applyStepDecision(run, step.id, { accepted: true });
    }

    t.is(l1FilesIn(files).length, 12, 'żaden plik nie nadpisał poprzedniego');
    t.true(run.getStepsByKind('l1').every(s => s.status === STEP_STATUS.DONE));
});

test('padnięty zapis kończy krok jako failed i nie rzuca do góry', async t => {
    const { vault } = makeVault(archiveWith(5));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    await workflow.runWithRun(run);
    vault.adapter.write = async () => { throw new Error('dysk pełny'); };

    const res = await workflow.applyStepDecision(run, 'l1_batch_1', { accepted: true });

    t.false(res.applied);
    t.is((res.error as Error).message, 'dysk pełny');
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.FAILED);
});

// ── dedup ─────────────────────────────────────────────────────────────────────────

test('dedup: propozycja trafia do kroku, nic nie jest scalane przed decyzją', async t => {
    const { vault, files } = makeVault({
        [`${BASE}/brain/user_a.md`]: brainNoteFile('A', 'user'),
        [`${BASE}/brain/user_b.md`]: brainNoteFile('B', 'user'),
    });
    const llm = JSON.stringify({
        merges: [{ sources: ['user_a.md', 'user_b.md'], target_name: 'ab', target_type: 'user', merged_content: 'AB razem' }],
        deletions: [],
    });
    const { workflow } = makeWorkflow(vault, { model: scriptedModel([llm]) });
    const run = new ConsolidationRun({ counts: { brainNotesCount: 2 } });

    await workflow.runWithRun(run);

    t.is(run.getStep('dedup')!.status, STEP_STATUS.AWAITING_REVIEW);
    t.is(run.getStep('dedup')!.result!.merges!.length, 1);
    t.true(run.getStep('dedup')!.result!.llmDriven);
    t.true(Object.prototype.hasOwnProperty.call(files, `${BASE}/brain/user_a.md`), 'źródła nietknięte przed decyzją');

    await workflow.applyStepDecision(run, 'dedup', { accepted: true });
    t.is(run.getStep('dedup')!.status, STEP_STATUS.DONE);
    t.false(Object.prototype.hasOwnProperty.call(files, `${BASE}/brain/user_a.md`), 'dopiero decyzja scala');
});

test('dedup bez propozycji jest pomijany (nie pokazujemy pustego ekranu)', async t => {
    const { vault } = makeVault({
        [`${BASE}/brain/user_a.md`]: brainNoteFile('A', 'user'),
        [`${BASE}/brain/agent_rule_b.md`]: brainNoteFile('B', 'agent_rule'),
    });
    const { workflow } = makeWorkflow(vault, { model: scriptedModel([JSON.stringify({ merges: [], deletions: [] })]) });
    const run = new ConsolidationRun({ counts: { brainNotesCount: 2 } });

    await workflow.runWithRun(run);

    t.is(run.getStep('dedup')!.status, STEP_STATUS.SKIPPED);
    t.is(run.getStep('dedup')!.meta.skipReason, 'nothing_to_merge');
});

// ── bramka L2 / L3 ────────────────────────────────────────────────────────────────

test('L2 czeka aż WSZYSTKIE paczki L1 będą rozstrzygnięte', async t => {
    const { vault } = makeVault(archiveWith(25));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 25, batchSize: 5 } });

    await workflow.runWithRun(run);
    t.is(run.getStep('l2')!.status, STEP_STATUS.GATED);

    // Cztery paczki rozstrzygnięte, piąta wisi → L2 nadal pod kłódką.
    for (const id of ['l1_batch_1', 'l1_batch_2', 'l1_batch_3', 'l1_batch_4']) {
        await workflow.applyStepDecision(run, id, { accepted: true });
    }
    let gate = await workflow.generateGatedSteps(run);
    t.true(gate.waiting);
    t.is(run.getStep('l2')!.status, STEP_STATUS.GATED);

    await workflow.applyStepDecision(run, 'l1_batch_5', { accepted: true });
    gate = await workflow.generateGatedSteps(run);

    t.false(gate.waiting);
    t.deepEqual(gate.generated, ['l2']);
    t.is(run.getStep('l2')!.status, STEP_STATUS.AWAITING_REVIEW);
    t.is(run.getStep('l2')!.result!.l1_files!.length, 5);
});

test('L2 (i zależny L3) pomijane, gdy po odrzuceniach zostało za mało plików L1', async t => {
    const { vault } = makeVault(archiveWith(25));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 25, batchSize: 5, l2Count: 4 } });

    await workflow.runWithRun(run);
    await workflow.applyStepDecision(run, 'l1_batch_1', { accepted: true });
    for (const id of ['l1_batch_2', 'l1_batch_3', 'l1_batch_4', 'l1_batch_5']) {
        await workflow.applyStepDecision(run, id, { accepted: false });
    }

    const gate = await workflow.generateGatedSteps(run);

    t.deepEqual(gate.skipped, ['l2', 'l3']);
    t.is(run.getStep('l2')!.status, STEP_STATUS.SKIPPED);
    t.is(run.getStep('l2')!.meta.skipReason, 'not_enough_l1');
    t.is(run.getStep('l3')!.status, STEP_STATUS.SKIPPED);
});

test('L3 rusza dopiero po rozstrzygnięciu L2 i tylko przy komplecie plików L2', async t => {
    const initial = archiveWith(25);
    for (let i = 1; i <= 4; i++) {
        initial[`${BASE}/summaries/L2/l2_${i}.md`] = summaryFile('L2', { l1_files: [`old_l1_${i}.md`] });
    }
    const { vault } = makeVault(initial);
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 25, batchSize: 5, l2Count: 4 } });

    await workflow.runWithRun(run);
    for (const step of run.getStepsByKind('l1')) {
        await workflow.applyStepDecision(run, step.id, { accepted: true });
    }

    // Krok 1: bramka L1 otwarta → generuje się L2, L3 nadal czeka.
    await workflow.generateGatedSteps(run);
    t.is(run.getStep('l3')!.status, STEP_STATUS.GATED);
    t.true((await workflow.generateGatedSteps(run)).waiting, 'L3 czeka na decyzję o L2');

    // Krok 2: L2 zaakceptowany → na dysku jest 5 plików L2 → L3 się generuje.
    await workflow.applyStepDecision(run, 'l2', { accepted: true });
    const gate = await workflow.generateGatedSteps(run);

    t.deepEqual(gate.generated, ['l3']);
    t.is(run.getStep('l3')!.status, STEP_STATUS.AWAITING_REVIEW);
    t.is(run.getStep('l3')!.result!.l2_files!.length, 5);
});

test('generateGatedSteps bez kroków bramkowanych jest bezpieczne', async t => {
    const { vault } = makeVault(archiveWith(5));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    await workflow.runWithRun(run);

    const gate = await workflow.generateGatedSteps(run);
    t.deepEqual(gate, { generated: [], skipped: [], failed: [], waiting: false });
});

// ── zwis streamu: retry 1×, potem failed — reszta przebiegu leci dalej ────────────

test('zwis → auto-ponów 1× → failed; kolejne paczki mielą się dalej', async t => {
    const { vault } = makeVault(archiveWith(15));
    const model = scriptedModel(['SILENT', 'SILENT', 'Streszczenie 2', 'Streszczenie 3']);
    const { workflow } = makeWorkflow(vault, { model });
    const run = new ConsolidationRun({ counts: { archiveCount: 15, batchSize: 5 } });
    const stalls: Array<{ willRetry: boolean }> = [];

    const outcome = await workflow.runWithRun(run, {
        stallTimeoutMs: 20,
        onStall: (info) => stalls.push(info),
    });

    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.FAILED);
    t.is(run.getStep('l1_batch_1')!.error!.code, 'stream_stalled');
    t.is(run.getStep('l1_batch_1')!.retryCount, 1, 'dokładnie jedno auto-ponowienie');
    t.is(stalls.length, 2);
    t.true(stalls[0].willRetry);
    t.false(stalls[1].willRetry);

    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.AWAITING_REVIEW, 'fail jednej paczki nie blokuje reszty');
    t.is(run.getStep('l1_batch_3')!.status, STEP_STATUS.AWAITING_REVIEW);
    t.deepEqual(outcome.failed, ['l1_batch_1']);
    t.deepEqual(outcome.generated, ['l1_batch_2', 'l1_batch_3']);
    t.is(model.stopped, 2, 'każdy zwis przerywa stream');
});

test('„Ponów" padniętej paczki L1 trzyma ZAMROŻONE okno — nie kradnie sesji innej paczki', async t => {
    // Review kubełka 2, P2-1: lista niepokrytych sesji KURCZY SIĘ po zaakceptowaniu paczki
    // (stemple covered_by_l1), więc retry liczący okno od nowa slice'em brał sesje paczki 3:
    // duplikat L1 na tych samych źródłach + 5 sesji wypadało z przebiegu.
    const { vault } = makeVault(archiveWith(15));
    // call1 = paczka 1 OK; call2+3 = paczka 2 zwis + auto-retry zwis → failed; call4 = paczka 3 OK
    const model = scriptedModel(['P1', 'SILENT', 'SILENT', 'P3']);
    const { workflow } = makeWorkflow(vault, { model });
    const run = new ConsolidationRun({ counts: { archiveCount: 15, batchSize: 5 } });

    await workflow.runWithRun(run, { stallTimeoutMs: 20 });
    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.FAILED);
    t.deepEqual(run.getStep('l1_batch_2')!.meta.sessions, [
        'session_006.md', 'session_007.md', 'session_008.md', 'session_009.md', 'session_010.md'
    ], 'okno paczki zamrożone przy pierwszej generacji');

    // User akceptuje paczkę 1 → sesje 001-005 dostają stemple, lista niepokrytych kurczy się.
    await workflow.applyStepDecision(run, 'l1_batch_1', { accepted: true });

    // „Ponów" paczki 2: okno MUSI zostać 006-010 (a nie 011-015 z przesuniętego slice'a).
    await workflow.retryStep(run, 'l1_batch_2', { stallTimeoutMs: 20 });

    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.AWAITING_REVIEW);
    t.deepEqual(run.getStep('l1_batch_2')!.result!.sessions, [
        'session_006.md', 'session_007.md', 'session_008.md', 'session_009.md', 'session_010.md'
    ]);
});

test('zamrożone okno: gdy sesja z okna zniknęła z dysku, retry pomija paczkę zamiast dobierać cudze', async t => {
    const { vault, files } = makeVault(archiveWith(15));
    const model = scriptedModel(['P1', 'SILENT', 'SILENT', 'P3']);
    const { workflow } = makeWorkflow(vault, { model });
    const run = new ConsolidationRun({ counts: { archiveCount: 15, batchSize: 5 } });

    await workflow.runWithRun(run, { stallTimeoutMs: 20 });
    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.FAILED);

    // User ręcznie skasował sesję z zamrożonego okna paczki 2.
    delete files[`${BASE}/sessions/archive/session_008.md`];

    await workflow.retryStep(run, 'l1_batch_2', { stallTimeoutMs: 20 });

    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.SKIPPED);
    t.is(run.getStep('l1_batch_2')!.meta.skipReason, 'not_enough_sessions');
});

test('krok failed przez zwis blokuje bramkę L2 do decyzji usera', async t => {
    // 30 sesji = 6 paczek. Pierwsza pada na zwisie, pozostałe 5 daje komplet plików L1,
    // więc L2 jest osiągalny — bramka stoi WYŁĄCZNIE na nierozstrzygniętym failu.
    const { vault } = makeVault(archiveWith(30));
    const model = scriptedModel(['SILENT', 'SILENT']);
    const { workflow } = makeWorkflow(vault, { model });
    const run = new ConsolidationRun({ counts: { archiveCount: 30, batchSize: 5 } });

    await workflow.runWithRun(run, { stallTimeoutMs: 20 });
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.FAILED);
    for (const id of ['l1_batch_2', 'l1_batch_3', 'l1_batch_4', 'l1_batch_5', 'l1_batch_6']) {
        await workflow.applyStepDecision(run, id, { accepted: true });
    }

    t.true((await workflow.generateGatedSteps(run)).waiting, 'failed L1 = nierozstrzygnięty');
    t.is(run.getStep('l2')!.status, STEP_STATUS.GATED);

    run.skipStep('l1_batch_1'); // user klika „Pomiń"
    const gate = await workflow.generateGatedSteps(run);
    t.deepEqual(gate.generated, ['l2']);
});

test('retryStep („Ponów" w UI) ponawia generację padniętego kroku z tym samym oknem paczki', async t => {
    const { vault } = makeVault(archiveWith(10));
    // Paczka 1: dwa zwisy → failed. Paczka 2: OK. Potem ręczny retry paczki 1 → OK.
    const model = scriptedModel(['SILENT', 'SILENT', 'Paczka 2', 'Paczka 1 za drugim podejściem']);
    const { workflow } = makeWorkflow(vault, { model });
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5 } });

    await workflow.runWithRun(run, { stallTimeoutMs: 20 });
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.FAILED);

    const outcome = await workflow.retryStep(run, 'l1_batch_1', { stallTimeoutMs: 20 });

    t.deepEqual(outcome.generated, ['l1_batch_1']);
    const step = run.getStep('l1_batch_1')!;
    t.is(step.status, STEP_STATUS.AWAITING_REVIEW);
    t.is((step as unknown as Record<string, unknown>).body, undefined);
    t.is(step.result!.body, 'Paczka 1 za drugim podejściem');
    t.deepEqual(step.result!.sessions, [
        'session_001.md', 'session_002.md', 'session_003.md', 'session_004.md', 'session_005.md'
    ], 'to samo okno co pierwotnie');
    t.is(step.retryCount, 0, 'ręczny retry daje świeży budżet auto-ponowień');
});

test('retryStep na kroku, który nie padł, rzuca', async t => {
    const { vault } = makeVault(archiveWith(5));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    await workflow.runWithRun(run);

    await t.throwsAsync(() => workflow.retryStep(run, 'l1_batch_1'), { message: /nie jest w stanie failed/ });
});

test('zwykły błąd LLM (nie zwis) NIE jest ponawiany — spada na deterministyczny fallback', async t => {
    const { vault } = makeVault(archiveWith(5));
    const model = scriptedModel([new Error('HTTP 500')]);
    const { workflow } = makeWorkflow(vault, { model });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });

    await workflow.runWithRun(run, { stallTimeoutMs: 20 });

    const step = run.getStep('l1_batch_1')!;
    t.is(step.status, STEP_STATUS.AWAITING_REVIEW, 'user dostaje raw concat do przejrzenia');
    t.false(step.result!.llmDriven, 'krok jest oznaczony jako fallback — nie udajemy pracy modelu');
    t.true(step.result!.body!.includes('raw concat'));
    t.is(model.calls.length, 1, 'zero ponowień przy błędzie innym niż zwis');
});

// ── koszt per krok ────────────────────────────────────────────────────────────────

test('usage z każdego strzału ląduje w kroku i sumuje się w przebiegu', async t => {
    const { vault } = makeVault({ ...archiveWith(10), [`${BASE}/brain/user_a.md`]: brainNoteFile('A', 'user'), [`${BASE}/brain/user_b.md`]: brainNoteFile('B', 'user') });
    const dedupReply = JSON.stringify({
        merges: [{ sources: ['user_a.md', 'user_b.md'], target_name: 'ab', target_type: 'user', merged_content: 'AB' }],
        deletions: [],
    });
    const { workflow } = makeWorkflow(vault, { model: scriptedModel([dedupReply]) });
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5, brainNotesCount: 2 } });

    await workflow.runWithRun(run);

    t.deepEqual(run.getStep('l1_batch_1')!.usage, { inputTokens: 100, outputTokens: 20, cachedTokens: 0, calls: 1 });
    t.deepEqual(run.totalUsage(), { inputTokens: 300, outputTokens: 60, cachedTokens: 0, calls: 3 });
});

test('ponowiony strzał dokłada swój koszt (retry nie jest darmowy)', async t => {
    const { vault } = makeVault(archiveWith(5));
    // Pierwszy strzał zwis (bez usage), drugi się udaje.
    const { workflow } = makeWorkflow(vault, { model: scriptedModel(['SILENT', 'Streszczenie']) });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });

    await workflow.runWithRun(run, { stallTimeoutMs: 20 });

    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.AWAITING_REVIEW);
    t.is(run.getStep('l1_batch_1')!.retryCount, 1);
    t.is(run.getStep('l1_batch_1')!.usage.calls, 1, 'zwis nie oddał usage, udany retry tak');
});

// ── snapshot + kontrakt wejścia ───────────────────────────────────────────────────

test('runWithRun NIE robi snapshotu (nowy tor: zapisy dzieją się długo po generacji)', async t => {
    const { vault, files } = makeVault(archiveWith(10));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5 } });

    const outcome = await workflow.runWithRun(run);

    t.is((outcome as { snapshotPath?: string }).snapshotPath, undefined, 'outcome nie obiecuje snapshotu');
    t.is(run.meta.snapshotPath, undefined);
    t.false(
        Object.keys(files).some(p => p.includes('/.consolidation_snapshots/')),
        'żaden plik snapshotu nie powstał'
    );
});

test('ConsolidationSnapshot.prune zostawia N najnowszych kopii', async t => {
    const root = `${BASE}/.consolidation_snapshots`;
    const stamps = ['2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29'];
    const initial: Record<string, string> = {};
    for (const stamp of stamps) initial[`${root}/${stamp}T10-00-00-000Z_archive_workflow.tar.gz`] = '{}';
    const { vault, files } = makeVault(initial);
    const snapshot = new ConsolidationSnapshot(new AgentMemory(vault, 'Jaskier'));

    const result = await snapshot.prune(3);

    t.is(result.removed, 2);
    const left = Object.keys(files).filter(p => p.startsWith(`${root}/`)).sort();
    t.deepEqual(left.map(p => p.split('/').pop()!.slice(0, 10)), ['2026-07-27', '2026-07-28', '2026-07-29']);
});

test('ConsolidationSnapshot.prune NIE dotyka plików usera i nie oddaje im slotów retencji', async t => {
    // Second-pass audytu kubełka 2: prune bez filtra nazwy kasował ręcznie wrzucony
    // backup usera, a nie-snapshot (litery > cyfry leksykalnie) zajmował slot retencji
    // i wypychał prawdziwy snapshot.
    const root = `${BASE}/.consolidation_snapshots`;
    const stamps = ['2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29'];
    const initial: Record<string, string> = {
        [`${root}/MOJE_WAZNE_NOTATKI.md`]: 'nie ruszac',
        [`${root}/0000_backup_recznie.zip`]: 'user backup',
    };
    for (const stamp of stamps) initial[`${root}/${stamp}T10-00-00-000Z_archive_workflow.tar.gz`] = '{}';
    const { vault, files } = makeVault(initial);
    const snapshot = new ConsolidationSnapshot(new AgentMemory(vault, 'Jaskier'));

    const result = await snapshot.prune(3);

    t.is(result.removed, 2, 'skasowane tylko 2 najstarsze PRAWDZIWE snapshoty');
    t.truthy(files[`${root}/MOJE_WAZNE_NOTATKI.md`], 'plik usera przezyl');
    t.truthy(files[`${root}/0000_backup_recznie.zip`], 'reczny backup usera przezyl');
    const snapshotsLeft = Object.keys(files)
        .filter(p => p.startsWith(`${root}/`) && p.endsWith('.tar.gz') && !p.includes('backup'))
        .sort();
    t.deepEqual(
        snapshotsLeft.map(p => p.split('/').pop()!.slice(0, 10)),
        ['2026-07-27', '2026-07-28', '2026-07-29'],
        'retencja liczona wylacznie po prawdziwych snapshotach'
    );
});

test('ConsolidationSnapshot.prune na nieistniejącym folderze nie rzuca', async t => {
    const { vault } = makeVault();
    const snapshot = new ConsolidationSnapshot(new AgentMemory(vault, 'Jaskier'));

    t.deepEqual(await snapshot.prune(3), { removed: 0 });
});

// ── retencja archiwum sesji (Z6) ───────────────────────────────────────────────────

const oldStamped = (created: string, covered = '2026-01-01_l1.md') =>
    `---\ntype: archived_session\ncreated: ${created}\ncovered_by_l1: ${covered}\n---\n\n## User\nstara, wchłonięta rozmowa\n`;

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

test('runWithRun sprząta archiwum wg ustawień — ale tylko sesje wchłonięte do L1', async t => {
    const { vault, files } = makeVault({
        ...archiveWith(5), // 5 niepokrytych = materiał na dokładnie jedną paczkę L1
        [`${BASE}/sessions/archive/stara_pokryta_1.md`]: oldStamped(isoDaysAgo(120)),
        [`${BASE}/sessions/archive/stara_pokryta_2.md`]: oldStamped(isoDaysAgo(200)),
    });
    const { workflow } = makeWorkflow(vault, {
        model: scriptedModel(),
        settings: { archiveRetentionDays: 30 },
    });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });

    await workflow.runWithRun(run);

    t.false(Object.prototype.hasOwnProperty.call(files, `${BASE}/sessions/archive/stara_pokryta_1.md`));
    t.false(Object.prototype.hasOwnProperty.call(files, `${BASE}/sessions/archive/stara_pokryta_2.md`));
    const left = Object.keys(files).filter(p => p.startsWith(`${BASE}/sessions/archive/`));
    t.is(left.length, 5, 'wszystkie niepokryte sesje zostały nietknięte');
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.AWAITING_REVIEW, 'paczka L1 powstała normalnie');
});

test('runWithRun bez ustawień retencji nie kasuje NICZEGO z archiwum (default off)', async t => {
    const { vault, files } = makeVault({
        ...archiveWith(5),
        [`${BASE}/sessions/archive/stara_pokryta_1.md`]: oldStamped(isoDaysAgo(900)),
    });
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });

    await workflow.runWithRun(run);

    t.true(Object.prototype.hasOwnProperty.call(files, `${BASE}/sessions/archive/stara_pokryta_1.md`));
    t.is(Object.keys(files).filter(p => p.startsWith(`${BASE}/sessions/archive/`)).length, 6);
});

test('pad retencji nie zatrzymuje przebiegu', async t => {
    const { vault } = makeVault(archiveWith(5));
    const { memory, workflow } = makeWorkflow(vault, {
        model: scriptedModel(),
        settings: { archiveRetentionDays: 30 },
    });
    memory.pruneArchive = async () => { throw new Error('dysk odpadł'); };
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });

    await t.notThrowsAsync(() => workflow.runWithRun(run));
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.AWAITING_REVIEW);
});

test('runWithRun bez przebiegu rzuca', async t => {
    const { vault } = makeVault();
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    await t.throwsAsync(() => workflow.runWithRun(null), { message: /brak przebiegu/ });
});

test('applyStepDecision nieznanego kroku rzuca', async t => {
    const { vault } = makeVault();
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({ counts: {} });
    await t.throwsAsync(() => workflow.applyStepDecision(run, 'l1_batch_9'), { message: /nieznany krok/ });
});

// ── timeout watchdoga = wspólny z czatem ──────────────────────────────────────────

test('timeout zwisu bierze się z limits (Settings → Limity), niezależnie od kształtu settings', t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    // domyślnie: 120 s z config/limits.js
    t.is(new ArchiveWorkflow(memory)._stallTimeoutMs(), 120000);
    // caller podaje podgałąź `settings.pkmAssistant` (save_session.js / profile_memory.js)
    t.is(new ArchiveWorkflow(memory, { settings: { limits: { chat_stream_stall_timeout_ms: 45000 } } })._stallTimeoutMs(), 45000);
    // caller podaje PEŁNE settings
    t.is(new ArchiveWorkflow(memory, { settings: { pkmAssistant: { limits: { chat_stream_stall_timeout_ms: 30000 } } } })._stallTimeoutMs(), 30000);
    // 0 = watchdog wyłączony (legalne wg LIMIT_SPECS)
    t.is(new ArchiveWorkflow(memory, { settings: { limits: { chat_stream_stall_timeout_ms: 0 } } })._stallTimeoutMs(), 0);
});

// ── stempel covered_by_l1 filtruje wybór paczek (koniec duplikatów L1) ────────────
//
// Sam fix ścieżki w `_cleanupAfterL1` nie wystarczy: nikt stempla NIE CZYTAŁ przy wyborze
// paczek, więc każdy przebieg brał te same najstarsze sesje z `sessions/archive`.

/** N sesji w archiwum, z których `coveredCount` pierwszych jest już ostemplowanych. */
function archiveWithCovered(count: number, coveredCount: number, l1Name = 'stary_l1.md') {
    const initial = archiveWith(count);
    for (let i = 1; i <= coveredCount; i++) {
        const name = `session_${String(i).padStart(3, '0')}.md`;
        initial[`${BASE}/sessions/archive/${name}`] =
            `---\ntype: archived_session\ncovered_by_l1: ${l1Name}\n---\n\n## User\nSesja ${i}\n`;
    }
    return initial;
}

test('sesje ze stemplem covered_by_l1 nie wchodzą do paczek L1 (nowy tor)', async t => {
    const { vault } = makeVault(archiveWithCovered(10, 5));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    // Plan powstaje z LICZNIKA plików w archiwum — o stemplach nic nie wie.
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5 } });

    await workflow.runWithRun(run);

    t.deepEqual(run.getStep('l1_batch_1')!.result!.sessions, [
        'session_006.md', 'session_007.md', 'session_008.md', 'session_009.md', 'session_010.md'
    ]);
    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.SKIPPED, 'na drugą paczkę nie ma już materiału');
    t.is(run.getStep('l1_batch_2')!.meta.skipReason, 'not_enough_sessions');
});

test('drugi przebieg po zaakceptowanym L1 nie proponuje tych samych sesji (koniec duplikatów)', async t => {
    const { vault, files } = makeVault(archiveWith(5));
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });

    const first = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    await workflow.runWithRun(first);
    await workflow.applyStepDecision(first, 'l1_batch_1', { accepted: true });

    t.true(files[`${BASE}/sessions/archive/session_001.md`].includes('covered_by_l1:'), 'sesje ostemplowane');

    // Świeży przebieg na tym samym vaulcie — licznik dalej widzi 5 plików w archiwum.
    const second = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    await workflow.runWithRun(second);

    t.is(second.getStep('l1_batch_1')!.status, STEP_STATUS.SKIPPED);
    t.is(second.getStep('l1_batch_1')!.meta.skipReason, 'not_enough_sessions');
    t.is(l1FilesIn(files).length, 1, 'żadnego duplikatu L1');
});

// D6 (2026-07-30): test „stary tor createLevel1 też pomija sesje ostemplowane" skasowany razem
// z `createLevel1`. Filtr stempla `covered_by_l1` żyje w `_listSessionsForL1` (jedno źródło dla
// całego przebiegu) i jest sprawdzany dwoma testami wyżej.

// ── przedpobrana lista archiwum od runnera (jedno listowanie na start) ────────────
//
// Runner liczy plan z `listUncoveredArchiveSessions()`, a generacja czytała to samo drugi raz —
// dwa komplety stat() + read() frontmattera per plik archiwum na starcie każdej konsolidacji.

/** Podmienia lister na zliczający, zachowując prawdziwy wynik. */
function countingLister(memory: AgentMemory) {
    const spy = { calls: 0 };
    const orig = memory.listUncoveredArchiveSessions.bind(memory);
    memory.listUncoveredArchiveSessions = async () => {
        spy.calls++;
        return orig();
    };
    return spy;
}

test('przedpobrana lista (archiveSessions) zastępuje listowanie archiwum przy generacji', async t => {
    const { vault } = makeVault(archiveWith(10));
    const memory = new AgentMemory(vault, 'Jaskier');
    const spy = countingLister(memory);
    const archiveSessions = await memory.listUncoveredArchiveSessions(); // to robi runner dla planu
    t.is(spy.calls, 1);

    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', summary_prompt: 'Zrób {{LEVEL}}' },
        model: scriptedModel(),
        archiveSessions,
    });
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5 } });

    await workflow.runWithRun(run);

    t.is(spy.calls, 1, 'generacja NIE czyta archiwum drugi raz');
    t.deepEqual(run.getStep('l1_batch_1')!.result!.sessions, [
        'session_001.md', 'session_002.md', 'session_003.md', 'session_004.md', 'session_005.md'
    ]);
    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.AWAITING_REVIEW, 'obie paczki z jednej listy');
});

test('przedpobrana lista jest JEDNORAZOWA — retry po decyzji usera czyta świeży dysk', async t => {
    // Gdyby lista żyła całe życie workflow, „Ponów" walidowałby zamrożone okno o stan archiwum
    // z przed decyzji usera (stemple covered_by_l1, ręczne kasowanie plików).
    const { vault } = makeVault(archiveWith(10));
    const memory = new AgentMemory(vault, 'Jaskier');
    const archiveSessions = await memory.listUncoveredArchiveSessions();
    const spy = countingLister(memory);
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', summary_prompt: 'Zrób {{LEVEL}}' },
        model: scriptedModel(['P1', 'SILENT', 'SILENT', 'P2']),
        archiveSessions,
    });
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5 } });

    await workflow.runWithRun(run, { stallTimeoutMs: 20 });
    t.is(spy.calls, 0, 'start przebiegu jedzie z przedpobranej listy');
    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.FAILED);

    await workflow.retryStep(run, 'l1_batch_2', { stallTimeoutMs: 20 });

    t.is(spy.calls, 1, 'retry pyta dysk o aktualny stan archiwum');
    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.AWAITING_REVIEW);
});

// ── pancerz L2/L3: pad przed propozycją nie zostawia kroku w `running` ────────────
//
// `_collectFrontmatterList` czyta pliki z dysku POZA polityką zwisu (kaskada `_cleanupAfterL3`
// potrafi skasować L1 pod nogami). Rzut zostawiał krok w `running` na zawsze → `memoryOpsCenter`
// był „zajęty" aż do restartu Obsidiana.

/** Kasuje `victim` w momencie, w którym listing `folderSuffix` już wyszedł — symuluje wyścig. */
function deleteAfterListing(
    vault: { adapter: { list: (folder: string) => Promise<unknown> } },
    files: Record<string, string>,
    folderSuffix: string,
    victim: string,
) {
    const origList = vault.adapter.list.bind(vault.adapter);
    vault.adapter.list = async (folder: string) => {
        const listed = await origList(folder);
        if (folder.endsWith(folderSuffix)) delete files[victim];
        return listed;
    };
}

test('L2: plik L1 skasowany między listingiem a odczytem → krok failed, nic nie wisi w running', async t => {
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${BASE}/summaries/L1/l1_${i}.md`] = summaryFile('L1', { sessions: [`session_${i}.md`] });
    }
    const { vault, files } = makeVault(initial);
    deleteAfterListing(vault, files, '/summaries/L1', `${BASE}/summaries/L1/l1_1.md`);
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({
        steps: [{ id: STEP_KIND.L2, kind: STEP_KIND.L2, status: STEP_STATUS.GATED, meta: { batchSize: 5 } }],
    });

    const gate = await workflow.generateGatedSteps(run);

    t.deepEqual(gate.failed, [STEP_KIND.L2]);
    t.is(run.getStep(STEP_KIND.L2)!.status, STEP_STATUS.FAILED);
    t.is(run.getActiveStep(), null, 'żaden krok nie został w running');
    t.true(run.isSettled(), 'przebieg się domyka — centrum operacji się zwalnia');
});

test('L3: plik L2 skasowany między listingiem a odczytem → krok failed, nic nie wisi w running', async t => {
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${BASE}/summaries/L2/l2_${i}.md`] = summaryFile('L2', { l1_files: [`l1_${i}.md`] });
    }
    const { vault, files } = makeVault(initial);
    deleteAfterListing(vault, files, '/summaries/L2', `${BASE}/summaries/L2/l2_1.md`);
    const { workflow } = makeWorkflow(vault, { model: scriptedModel() });
    const run = new ConsolidationRun({
        steps: [{ id: STEP_KIND.L3, kind: STEP_KIND.L3, status: STEP_STATUS.GATED, meta: { batchSize: 5 } }],
    });

    const gate = await workflow.generateGatedSteps(run);

    t.deepEqual(gate.failed, [STEP_KIND.L3]);
    t.is(run.getStep(STEP_KIND.L3)!.status, STEP_STATUS.FAILED);
    t.is(run.getActiveStep(), null);
    t.true(run.isSettled());
});
