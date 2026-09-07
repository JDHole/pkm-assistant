/**
 * ArchiveWorkflow.test.js — logika WSPÓLNA konsolidacji: dedup `brain/` (propozycja + aplikacja),
 * synteza podsumowań (`_summaryFromFiles`) i zapisywacze (`_writeLevel1/2/3`).
 *
 * D6 (2026-07-30): testy STAREGO, blokującego toru (`run()`, `createLevel1/2/3`,
 * `ConsolidationSnapshot.create/restore`) skasowane razem z tym torem. Testy, które używały
 * `createLevelN` tylko jako WEHIKUŁU do sprawdzenia logiki wspólnej (podmiana `{{LEVEL}}`,
 * zdejmowanie ogrodzeń ```, fallback raw-concat), zostały przepisane na bezpośredni strzał
 * w tę logikę — asercje bez zmian. Przebieg end-to-end testuje `ArchiveWorkflowRun.test.js`.
 */
import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { ArchiveWorkflow } from './ArchiveWorkflow.js';
import { ConsolidationRun, STEP_KIND } from './ConsolidationRun.js';
import { DEFAULT_ARCHIVE_PROMPT } from './workPrompts.js';
import { makeMemoryNoteFilename } from './MemoryAccessGuard.js';
import type { StreamChatModelLike, StreamHandlers, StreamMessage } from './streamHelper.js';

function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>(initialFolders);

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
        vault: {
            adapter: {
                async exists(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) {
                    folders.add(path);
                },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    for (const folder of parentFoldersFor(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) {
                    delete files[path];
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

function session(_name: string, body = 'Treść sesji') {
    return `---\ntype: archived_session\n---\n\n## User\n${body}\n`;
}

function summary(level: string, fields: Record<string, string[]> = {}, body = 'Summary') {
    const lines = ['---', `level: ${level}`];
    for (const [key, values] of Object.entries(fields)) {
        lines.push(`${key}:`);
        for (const value of values) lines.push(`  - ${value}`);
    }
    lines.push('---', '', body);
    return lines.join('\n');
}

function brainNoteFile(name: string, type: string, body = 'note body', description = '') {
    return [
        '---',
        `name: ${JSON.stringify(name)}`,
        `description: ${JSON.stringify(description)}`,
        `type: ${type}`,
        'created: 2026-05-15',
        '---',
        body
    ].join('\n');
}

function makeMockModel(responseText: string): StreamChatModelLike {
    return {
        stream(_req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            setTimeout(() => {
                handlers.done({
                    choices: [{ message: { content: responseText } }],
                    usage: { prompt_tokens: 100, completion_tokens: 80 }
                });
            }, 0);
        }
    };
}

// ── Default archive prompt (moved to Agent constructor defaults in E2.8 A2) ──

test('DEFAULT_ARCHIVE_PROMPT is the JSON-output contract for LLM-driven dedup', t => {
    t.true(DEFAULT_ARCHIVE_PROMPT.includes('OUTPUT'));
    t.true(DEFAULT_ARCHIVE_PROMPT.includes('merges'));
    t.true(DEFAULT_ARCHIVE_PROMPT.includes('deletions'));
});

// ── Zapisywacze podsumowań (kaskada L1/L2/L3) — kontrakt bez zmian ──
//
// Wcześniej wchodziło się tu przez `createLevelN` (stary tor). Po D6 wybór paczki i zapis to dwa
// osobne kroki: `_listSessionsForL1`/`_listMarkdown` wybierają, `_writeLevelN` zapisuje. Testy
// robią dokładnie to, co robił `createLevelN` — minus modal.

test('ArchiveWorkflow zapisuje L1 z pięciu zarchiwizowanych sesji NIE kasując sesji', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/sessions/archive/session_${i}.md`] = session(`session_${i}.md`, `Sesja ${i}`);
    }
    const { vault, files } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const batch = (await workflow._listSessionsForL1()).slice(0, 5);
    const result = await workflow._writeLevel1({
        name: workflow._summaryName('L1'),
        sessions: batch.map(item => item.name),
        body: await workflow._summaryFromFiles(batch.map(item => item.path), 'L1'),
    });
    const l1Files = Object.keys(files).filter(path => path.includes('/summaries/L1/') && path.endsWith('.md'));

    t.is(result.created, 1);
    t.is(l1Files.length, 1);
    for (let i = 1; i <= 5; i++) {
        t.true(Object.prototype.hasOwnProperty.call(files, `${base}/sessions/archive/session_${i}.md`));
    }
});

test('ArchiveWorkflow zapisuje L2 z pięciu L1, kasuje pokryte sesje archiwum i ZOSTAWIA L1', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/sessions/archive/session_${i}.md`] = session(`session_${i}.md`, `Sesja ${i}`);
        initial[`${base}/summaries/L1/l1_${i}.md`] = summary('L1', { sessions: [`session_${i}.md`] });
    }
    const { vault, files } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const batch = (await workflow._listMarkdown(memory.paths.l1)).slice(0, 5);
    const result = await workflow._writeLevel2({
        name: workflow._summaryName('L2'),
        l1_files: batch.map(item => item.name),
        sessions: await workflow._collectFrontmatterList(batch, 'sessions'),
        body: await workflow._summaryFromFiles(batch.map(item => item.path), 'L2'),
    });
    const l2Files = Object.keys(files).filter(path => path.includes('/summaries/L2/') && path.endsWith('.md'));

    t.is(result.created, 1);
    t.is(l2Files.length, 1);
    t.true(Object.prototype.hasOwnProperty.call(files, `${base}/summaries/L1/l1_1.md`));
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/sessions/archive/session_1.md`));
});

test('ArchiveWorkflow zapisuje L3 z pięciu L2, kasuje pokryte L1 i ZOSTAWIA L2', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/summaries/L1/l1_${i}.md`] = summary('L1');
        initial[`${base}/summaries/L2/l2_${i}.md`] = summary('L2', { l1_files: [`l1_${i}.md`] });
    }
    const { vault, files } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const batch = (await workflow._listMarkdown(memory.paths.l2)).slice(0, 5);
    const result = await workflow._writeLevel3({
        name: workflow._summaryName('L3'),
        l2_files: batch.map(item => item.name),
        l1_files: await workflow._collectFrontmatterList(batch, 'l1_files'),
        body: await workflow._summaryFromFiles(batch.map(item => item.path), 'L3'),
    });
    const l3Files = Object.keys(files).filter(path => path.includes('/summaries/L3/') && path.endsWith('.md'));

    t.is(result.created, 1);
    t.is(l3Files.length, 1);
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/summaries/L1/l1_1.md`));
    t.true(Object.prototype.hasOwnProperty.call(files, `${base}/summaries/L2/l2_1.md`));
});

// ── Memory v3 LLM-driven dedup ──

test('ArchiveWorkflow.proposeDedup uses LLM when model + agent.archive_prompt are provided', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/brain/user_kuba_dev.md`]: brainNoteFile('Kuba programuje', 'user', 'Kuba pisze plugin', 'dev fact'),
        [`${base}/brain/user_kuba_writer.md`]: brainNoteFile('Kuba pisze', 'user', 'Kuba pisze posty', 'writer fact'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');

    const llmResponse = JSON.stringify({
        merges: [{
            sources: ['user_kuba_dev.md', 'user_kuba_writer.md'],
            target_name: 'kuba_profil',
            target_type: 'user',
            target_description: 'Co Kuba robi',
            target_why: 'fakty komplementarne',
            target_how_to_apply: 'cytuj gdy o Kubie',
            merged_content: 'Kuba pisze plugin i posty.',
            why: 'Dwie notatki o tej samej osobie.'
        }],
        deletions: []
    });
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', archive_prompt: DEFAULT_ARCHIVE_PROMPT },
        model: makeMockModel(llmResponse)
    });

    const result = await workflow.proposeDedup();
    t.true(result.llmDriven);
    t.is(result.merges.length, 1);
    t.is(result.merges[0].target_name, 'kuba_profil');
    t.is(result.merges[0].target_type, 'user');
    t.is(result.merges[0].merged_content, 'Kuba pisze plugin i posty.');
});

test('ArchiveWorkflow.proposeDedup falls back to prefix grouping without LLM', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/brain/user_kuba_dev.md`]: brainNoteFile('Kuba dev', 'user'),
        [`${base}/brain/user_kuba_writer.md`]: brainNoteFile('Kuba writer', 'user'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory); // no model, no agent

    const result = await workflow.proposeDedup();
    t.false(result.llmDriven);
    t.is(result.merges.length, 1);
    t.deepEqual(result.merges[0].sources.sort(), ['user_kuba_dev.md', 'user_kuba_writer.md']);
});

test('ArchiveWorkflow.proposeDedup strips ```json fences from LLM response', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/brain/user_a.md`]: brainNoteFile('A', 'user'),
        [`${base}/brain/user_b.md`]: brainNoteFile('B', 'user'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const wrapped = '```json\n' + JSON.stringify({
        merges: [{
            sources: ['user_a.md', 'user_b.md'],
            target_name: 'ab',
            target_type: 'user',
            target_description: '',
            merged_content: 'AB merged'
        }],
        deletions: []
    }) + '\n```';
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', archive_prompt: DEFAULT_ARCHIVE_PROMPT },
        model: makeMockModel(wrapped)
    });

    const result = await workflow.proposeDedup();
    t.true(result.llmDriven);
    t.is(result.merges.length, 1);
});

test('ArchiveWorkflow.proposeDedup rejects invalid merges (single source, bad type, empty content)', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/brain/user_a.md`]: brainNoteFile('A', 'user'),
        [`${base}/brain/user_b.md`]: brainNoteFile('B', 'user'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const llmResponse = JSON.stringify({
        merges: [
            { sources: ['user_a.md'], target_name: 'a', target_type: 'user', merged_content: 'x' }, // single source
            { sources: ['user_a.md', 'user_b.md'], target_name: '', target_type: 'user', merged_content: 'x' }, // empty name
            { sources: ['user_a.md', 'user_b.md'], target_name: 'ab', target_type: 'user', merged_content: '' }, // empty content
            { sources: ['user_a.md', 'user_b.md'], target_name: 'ok', target_type: 'user', merged_content: 'all good' } // valid
        ],
        deletions: []
    });
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', archive_prompt: DEFAULT_ARCHIVE_PROMPT },
        model: makeMockModel(llmResponse)
    });

    const result = await workflow.proposeDedup();
    t.is(result.merges.length, 1);
    t.is(result.merges[0].target_name, 'ok');
});

test('ArchiveWorkflow.applyDedup uses LLM-provided clean merged_content (no raw concat)', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain/user_a.md`]: brainNoteFile('A', 'user', 'A body', 'desc A'),
        [`${base}/brain/user_b.md`]: brainNoteFile('B', 'user', 'B body', 'desc B'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = await workflow.applyDedup({
        merges: [{
            sources: ['user_a.md', 'user_b.md'],
            target_name: 'ab_combined',
            target_type: 'user',
            target_description: 'Combined facts',
            merged_content: 'Clean merged content from LLM.',
            target_why: 'fact-merge',
            target_how_to_apply: 'use when talking about A or B',
            accepted: true
        }],
        deletions: []
    });

    t.is(result.merged, 1);
    const expectedFilename = makeMemoryNoteFilename('user', 'ab_combined');
    const targetPath = `${base}/brain/${expectedFilename}`;
    t.true(Object.prototype.hasOwnProperty.call(files, targetPath));
    const content = files[targetPath];
    t.true(content.includes('Clean merged content from LLM.'));
    t.true(content.includes('**Why:** fact-merge'));
    t.true(content.includes('**How to apply:** use when talking about A or B'));
    // Source files removed
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_a.md`));
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_b.md`));
});

test('AUD-code-review-008: applyDedup NIE nadpisuje notatki SPOZA sources, gdy target_name koliduje z jej nazwą', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain/user_a.md`]: brainNoteFile('A', 'user', 'A body', 'desc A'),
        [`${base}/brain/user_b.md`]: brainNoteFile('B', 'user', 'B body', 'desc B'),
        // Notatka usera SPOZA `sources` — nazwa po slugifikacji koliduje z `target_name`
        // scalenia (np. `target_name` zaproponowany przez LLM zbiegł się z istniejącą notatką,
        // albo dwie różne długie nazwy dały ten sam ucięty do 80 znaków slug).
        [`${base}/brain/user_ab_combined.md`]: brainNoteFile('BEZCENNA TRESC USERA', 'user', 'BEZCENNA TRESC USERA', 'nie ma nic wspólnego ze scaleniem'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = await workflow.applyDedup({
        merges: [{
            sources: ['user_a.md', 'user_b.md'],
            target_name: 'ab_combined',
            target_type: 'user',
            target_description: 'Combined facts',
            merged_content: 'Clean merged content from LLM.',
            target_why: 'fact-merge',
            target_how_to_apply: 'use when talking about A or B',
            accepted: true
        }],
        deletions: []
    });

    t.is(result.merged, 1);
    const collidingPath = `${base}/brain/user_ab_combined.md`;
    const suffixedPath = `${base}/brain/user_ab_combined_2.md`;

    // Do naprawy (AUD-code-review-008) applyDedup pisał na ślepo pod `targetPath`: notatka
    // usera SPOZA scalenia znikała bez `.bak` i bez wpisu `delete` w `brain.log` (log dostawał
    // tylko `merge`, jakby nic się nie stało poza scaleniem).
    t.true(files[collidingPath].includes('BEZCENNA TRESC USERA'), 'notatka spoza sources przeżywa scalenie NIETKNIĘTA');
    t.true(Object.prototype.hasOwnProperty.call(files, suffixedPath), 'scalenie dostaje sufiks _2 zamiast nadpisać cudzą notatkę');
    t.true(files[suffixedPath].includes('Clean merged content from LLM.'));
    // Źródła scalenia i tak znikają, jak dotąd.
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_a.md`));
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_b.md`));
});

test('AUD-code-review-008: target_name identyczny z JEDNYM ze sources nadal działa bez sufiksu (scalenie legalnie zajmuje jego miejsce)', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain/user_a.md`]: brainNoteFile('A', 'user', 'A body', 'desc A'),
        [`${base}/brain/user_b.md`]: brainNoteFile('B', 'user', 'B body', 'desc B'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = await workflow.applyDedup({
        merges: [{
            sources: ['user_a.md', 'user_b.md'],
            target_name: 'a', // koliduje z jednym ze SWOICH źródeł — to jest LEGALNE, nie kolizja
            target_type: 'user',
            target_description: '',
            merged_content: 'Merged into A.',
            target_why: '',
            target_how_to_apply: '',
            accepted: true
        }],
        deletions: []
    });

    t.is(result.merged, 1);
    t.true(files[`${base}/brain/user_a.md`].includes('Merged into A.'), 'scalenie zajmuje miejsce jednego ze swoich źródeł, bez sufiksu');
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_a_2.md`), 'zero sufiksu, gdy kolizja jest z WŁASNYM źródłem scalenia');
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_b.md`));
});

test('F01 (runda 2): applyDedup pomija merge po wyczerpaniu 50 sufiksów zamiast pisać nad cudzą notatką "_50"', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const targetStem = makeMemoryNoteFilename('user', 'ab_combined').replace(/\.md$/, '');

    const seed: Record<string, string> = {
        [`${base}/brain/user_a.md`]: brainNoteFile('A', 'user', 'A body'),
        [`${base}/brain/user_b.md`]: brainNoteFile('B', 'user', 'B body'),
        // Wieczna kolizja: nazwa bazowa I każdy sufiks do _50 zajęty przez CUDZE notatki
        // (spoza `sources`) — pętla nigdy nie znajdzie wolnej nazwy.
        [`${base}/brain/${targetStem}.md`]: brainNoteFile('cudza notatka', 'user', 'tresc obca'),
    };
    for (let n = 2; n <= 50; n++) {
        seed[`${base}/brain/${targetStem}_${n}.md`] = brainNoteFile(`cudza ${n}`, 'user', `tresc obca ${n}`);
    }

    const { vault, files } = makeVault(seed);
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = await workflow.applyDedup({
        merges: [{
            sources: ['user_a.md', 'user_b.md'],
            target_name: 'ab_combined',
            target_type: 'user',
            merged_content: 'Clean merged content from LLM.',
            accepted: true
        }],
        deletions: []
    });

    // Do naprawy (F01, runda 2): `break` przy suffix>50 zostawiał `targetFilename` na `_50` —
    // nazwie, o której ta sama pętla WŁAŚNIE orzekła że ISTNIEJE — i pisał tam mimo to,
    // nadpisując cudzą notatkę bez `.bak` i bez wpisu `delete` w `brain.log`.
    t.is(result.merged, 0, 'wyczerpanie sufiksów = zero scaleń wykonanych, nie cichy zapis');

    // Zero zapisu: żadna z 50 "cudzych" notatek nie została ruszona.
    t.is(files[`${base}/brain/${targetStem}.md`], seed[`${base}/brain/${targetStem}.md`], 'nazwa bazowa nietknięta');
    for (let n = 2; n <= 50; n++) {
        const path = `${base}/brain/${targetStem}_${n}.md`;
        t.is(files[path], seed[path], `cudza notatka "_${n}" nietknięta`);
    }
    // Żadnej nowej nazwy poza zakresem prób (_51 i dalej) nie powstało.
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/${targetStem}_51.md`), 'zero nowego zapisu poza limitem 50 prób');

    // Źródła scalenia NIETKNIĘTE — skoro merge się nie odbył, nie ma czego kasować.
    t.true(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_a.md`), 'źródło A przeżywa nieudane scalenie');
    t.true(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_b.md`), 'źródło B przeżywa nieudane scalenie');
});

test('ArchiveWorkflow.applyDedup handles deletions independently of merges', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain/agent_rule_stale.md`]: brainNoteFile('stale rule', 'agent_rule'),
        [`${base}/brain/user_keep.md`]: brainNoteFile('keep me', 'user'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = await workflow.applyDedup({
        merges: [],
        deletions: [{ filename: 'agent_rule_stale.md', why: 'outdated', accepted: true }]
    });

    t.is(result.merged, 0);
    t.is(result.deleted, 1);
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/agent_rule_stale.md`));
    t.true(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_keep.md`));
});

test('ArchiveWorkflow.applyDedup moves completed project_context notes to brain/archive', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain/project_done.md`]: brainNoteFile('done project', 'project_context', 'Projekt zakończony'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = await workflow.applyDedup({
        merges: [],
        deletions: [{ filename: 'project_done.md', why: 'done', lessons_extracted: true, accepted: true }]
    });

    t.is(result.deleted, 1);
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/project_done.md`));
    t.true(Object.prototype.hasOwnProperty.call(files, `${base}/brain/archive/project_done.md`));
    t.true(files[`${base}/brain/archive/project_done.md`].includes('status: archived'));
    t.false(files[`${base}/brain.md`].includes('project_done.md'));
});

test('ArchiveWorkflow.applyDedup keeps project_context notes when lessons were not extracted', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const source = `${base}/brain/project_done.md`;
    const { vault, files } = makeVault({
        [source]: brainNoteFile('done project', 'project_context', 'Projekt zakończony'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = await workflow.applyDedup({
        merges: [],
        deletions: [{ filename: 'project_done.md', why: 'done', accepted: true }]
    });

    t.is(result.deleted, 0);
    t.true(Object.prototype.hasOwnProperty.call(files, source));
    t.false(Object.prototype.hasOwnProperty.call(files, `${base}/brain/archive/project_done.md`));
});

test('ArchiveWorkflow._parseDedupResponse keeps lessons_extracted for project cleanup', t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = workflow._parseDedupResponse(JSON.stringify({
        merges: [],
        deletions: [{ filename: 'project_done.md', why: 'done', lessons_extracted: true }]
    }));

    t.is(result.deletions.length, 1);
    t.true(result.deletions[0].lessons_extracted);
});

test('ArchiveWorkflow._parseDedupResponse defaults missing lessons_extracted to false', t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = workflow._parseDedupResponse(JSON.stringify({
        merges: [],
        deletions: [{ filename: 'project_done.md', why: 'done' }]
    }));

    t.is(result.deletions.length, 1);
    t.false(result.deletions[0].lessons_extracted);
});

// D6: dawniej przez `run()` + `modalFactory` (stary tor). Ten sam gest żyje w `_applyStep`:
// user odznaczył WSZYSTKIE scalenia → podnosimy próg, żeby nie zaczepiać go o to samo przy
// każdym zapisie sesji. Wejście przez `applyStepDecision` (jedyne miejsce, gdzie się zapisuje).
test('ArchiveWorkflow podnosi próg notatek brain/ o +10, gdy user odrzuci wszystkie scalenia', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain/user_kuba_dev.md`]: brainNoteFile('Kuba dev', 'user'),
        [`${base}/brain/user_kuba_writer.md`]: brainNoteFile('Kuba writer', 'user'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory); // bez LLM → heurystyka prefiksów proponuje scalenie
    const run = new ConsolidationRun({ counts: { brainNotesCount: 2 } });

    await workflow.runWithRun(run);
    const dedup = run.getStep(STEP_KIND.DEDUP)!;
    const proposed = (dedup.result!.merges || []) as Array<Record<string, unknown>>;
    t.is(proposed.length, 1, 'jest co odrzucać');

    // Krok przyjęty, ale KAŻDE scalenie odznaczone — to nie to samo co odrzucenie całego kroku.
    const outcome = await workflow.applyStepDecision(run, dedup.id, {
        accepted: true,
        merges: proposed.map(p => ({ ...p, accepted: false })),
        deletions: [],
    });
    const state = JSON.parse(files[`${base}/.state.json`]);

    t.true(outcome.applied);
    t.is(outcome.result!.merged, 0, 'nic nie scalone');
    t.true(Boolean(outcome.result!.autoBumpedBrainNoteLimit));
    t.is(state.brain_notes_limit, 30); // 20 default + 10 bump
});

// AUD-testy-043: strona PRZECIWNA testu wyżej. Ten sam warunek `_applyStep`
// (`proposal.merges.length > 0 && applied.merged === 0 && applied.deleted === 0`) miał pokrytą
// TYLKO gałąź „wszystko odrzucone -> bump". Gdyby ktoś przy przyszłym refaktorze poluzował
// warunek tak, że KAŻDE zaakceptowane scalenie też podbija próg, `brain_notes_limit` rósłby
// bez końca przy każdym udanym dedupie — próg wyzwalający kolejną konsolidację nigdy nie
// zostałby osiągnięty. Zero testu w repo to dziś łapie.
test('ArchiveWorkflow NIE podnosi progu notatek brain/, gdy user zaakceptuje scalenie i zostaje ono wykonane', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain/user_kuba_dev.md`]: brainNoteFile('Kuba dev', 'user'),
        [`${base}/brain/user_kuba_writer.md`]: brainNoteFile('Kuba writer', 'user'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory); // bez LLM → heurystyka prefiksów proponuje scalenie
    const run = new ConsolidationRun({ counts: { brainNotesCount: 2 } });

    await workflow.runWithRun(run);
    const dedup = run.getStep(STEP_KIND.DEDUP)!;
    const proposed = (dedup.result!.merges || []) as Array<Record<string, unknown>>;
    t.is(proposed.length, 1, 'jest co scalać');

    // Przeciwieństwo testu wyżej: scalenie ZAAKCEPTOWANE i realnie wykonane (applied.merged > 0).
    const outcome = await workflow.applyStepDecision(run, dedup.id, {
        accepted: true,
        merges: proposed.map(p => ({ ...p, accepted: true })),
        deletions: [],
    });

    t.true(outcome.applied);
    t.is(outcome.result!.merged, 1, 'scalenie faktycznie wykonane - to jest warunek graniczny testu');
    t.false(
        Boolean(outcome.result!.autoBumpedBrainNoteLimit),
        'auto-bump jest TYLKO dla „user odrzucił wszystko" - wykonane scalenie nie ma go wyzwalać'
    );

    // Jeśli `.state.json` w ogóle powstał, próg na pewno nie skoczył do wartości po bumpie
    // (20 default + 10 = 30) - regresja opisana w audycie dawałaby dokładnie tę liczbę.
    const stateRaw = files[`${base}/.state.json`];
    if (stateRaw) {
        const state = JSON.parse(stateRaw);
        t.not(state.brain_notes_limit, 30, 'próg NIE mógł skoczyć na wartość po bumpie po wykonanym scaleniu');
    }
});

// ── Memory v3 LLM-driven L1/L2/L3 synthesis ──

/** Ścieżki 5 sesji archiwum — materiał wejściowy dla `_summaryFromFiles`. */
function archivePaths(base: string, count = 5) {
    return Array.from({ length: count }, (_, i) => `${base}/sessions/archive/session_${i + 1}.md`);
}

test('ArchiveWorkflow._summaryFromFiles uses LLM when summary_prompt + model are provided', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/sessions/archive/session_${i}.md`] = session(`session_${i}.md`, `Treść sesji ${i}`);
    }
    const { vault } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');

    const llmResponse = '# Tydzień testów\n\n## Kluczowe tematy\nMigracja Memory v3.\n\n## Decyzje\nThreshold 25.';
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', summary_prompt: 'Stwórz {{LEVEL}} podsumowanie' },
        model: makeMockModel(llmResponse)
    });

    const body = await workflow._summaryFromFiles(archivePaths(base), 'L1');
    t.true(body.includes('Tydzień testów'));
    t.true(body.includes('## Kluczowe tematy'));
    t.false(body.includes('raw concat'), 'should NOT use fallback when LLM works');
});

test('ArchiveWorkflow._summaryFromFiles substitutes {{LEVEL}} token in summary_prompt', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/sessions/archive/session_${i}.md`] = session(`session_${i}.md`);
    }
    const { vault } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');

    // Capture the system prompt that reached the model
    let capturedSystemPrompt: string | null = null;
    const captureModel: StreamChatModelLike = {
        stream(req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            capturedSystemPrompt = (req.messages?.find(m => m.role === 'system')?.content as string) || null;
            setTimeout(() => handlers.done({ choices: [{ message: { content: 'OK summary' } }] }), 0);
        }
    };
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', summary_prompt: 'Robisz {{LEVEL}} z {{LEVEL}} dokumentów' },
        model: captureModel
    });

    await workflow._summaryFromFiles(archivePaths(base), 'L1');
    t.true(capturedSystemPrompt!.includes('Robisz L1 z L1 dokumentów'));
    t.false(capturedSystemPrompt!.includes('{{LEVEL}}'));
});

test('ArchiveWorkflow._summaryFromFiles uses factory summary prompt (with {{LEVEL}}) when agent has none — E2.8 B3', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/sessions/archive/session_${i}.md`] = session(`session_${i}.md`);
    }
    const { vault } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');

    let capturedSystemPrompt: string | null = null;
    const captureModel: StreamChatModelLike = {
        stream(req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            capturedSystemPrompt = (req.messages?.find(m => m.role === 'system')?.content as string) || null;
            setTimeout(() => handlers.done({ choices: [{ message: { content: 'OK summary' } }] }), 0);
        }
    };
    // model present, agent with NO summary_prompt → resolver falls back to factory (LLM path runs).
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier' },
        model: captureModel,
    });

    await workflow._summaryFromFiles(archivePaths(base), 'L1');
    t.true(capturedSystemPrompt!.includes('L1'), 'factory {{LEVEL}} substituted to L1');
    t.false(capturedSystemPrompt!.includes('{{LEVEL}}'));
    t.true(capturedSystemPrompt!.includes('## Kluczowe tematy'), 'factory summary prompt reached the model');
});

test('ArchiveWorkflow.proposeDedup uses LLM via factory archive prompt when agent has none — E2.8 B3', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/brain/user_a.md`]: brainNoteFile('A', 'user'),
        [`${base}/brain/user_b.md`]: brainNoteFile('B', 'user'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const llmResponse = JSON.stringify({
        merges: [{ sources: ['user_a.md', 'user_b.md'], target_name: 'ab', target_type: 'user', merged_content: 'AB merged' }],
        deletions: []
    });
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier' }, // no archive_prompt → factory via resolver
        model: makeMockModel(llmResponse),
    });

    const result = await workflow.proposeDedup();
    t.true(result.llmDriven, 'factory archive prompt drives the LLM path');
    t.is(result.merges.length, 1);
});

test('ArchiveWorkflow._summaryFromFiles strips ```markdown fences from LLM output', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/sessions/archive/session_${i}.md`] = session(`session_${i}.md`);
    }
    const { vault } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');

    const wrapped = '```markdown\n# Clean title\n\nClean body\n```';
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', summary_prompt: 'go' },
        model: makeMockModel(wrapped)
    });

    const content = await workflow._summaryFromFiles(archivePaths(base), 'L1');
    t.true(content.includes('# Clean title'));
    t.true(content.includes('Clean body'));
    t.false(content.includes('```'));
});

test('ArchiveWorkflow._summaryFromFiles falls back to raw concat when LLM throws', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/sessions/archive/session_${i}.md`] = session(`session_${i}.md`, `Sesja ${i}`);
    }
    const { vault } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');

    const explodingModel: StreamChatModelLike = {
        stream(_req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            setTimeout(() => handlers.error(new Error('LLM down')), 0);
        }
    };
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', summary_prompt: 'go' },
        model: explodingModel
    });

    const content = await workflow._summaryFromFiles(archivePaths(base), 'L1');
    t.true(content.includes('raw concat'));
    t.true(content.includes('Sesja 1'));
});

test('ArchiveWorkflow._summaryFromFiles falls back to raw concat without agent/model', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
        initial[`${base}/sessions/archive/session_${i}.md`] = session(`session_${i}.md`, `Sesja ${i}`);
    }
    const { vault } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory); // no LLM at all

    const content = await workflow._summaryFromFiles(archivePaths(base), 'L1');
    t.true(content.includes('raw concat'));
});

test('makeMemoryNoteFilename strips duplicate type prefix in name', t => {
    // Bug pre-fix: makeMemoryNoteFilename('agent_rule', 'agent_rule_polski') → 'agent_rule_agent_rule_polski.md'
    t.is(makeMemoryNoteFilename('agent_rule', 'agent_rule_polski'), 'agent_rule_polski.md');
    t.is(makeMemoryNoteFilename('user', 'user_kuba_dev'), 'user_kuba_dev.md');
    t.is(makeMemoryNoteFilename('reference', 'reference_cytat'), 'reference_cytat.md');
    // No prefix to strip — passes through
    t.is(makeMemoryNoteFilename('user', 'kuba_dev'), 'user_kuba_dev.md');
    // Trailing .md gets stripped before normalization
    t.is(makeMemoryNoteFilename('user', 'kuba.md'), 'user_kuba.md');
});

// ── E2.7 K1 dokończone (2026-07-29): liczniki .state.json przez kolejkę RMW ──
//
// `_resetArchiveCounter` i `_autoBumpBrainNoteLimit` robiły `read()` → mutacja → `write()`.
// Odczyt leciał POZA kolejką, a `write()` nadpisuje CAŁY plik, więc równoległy zapis z czatu
// (`markArchived` / `addActiveSession` przy autozapisie) był po cichu cofany. Konsolidacja woła
// `_resetArchiveCounter` raz na KAŻDĄ zaakceptowaną paczkę L1 — 12 paczek = 12 okien wyścigu.

test('E2.7 K1: równoległy _autoBumpBrainNoteLimit i addActiveSession nie kasują się nawzajem', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const statePath = `${base}/.state.json`;
    const { vault, files } = makeVault({
        [statePath]: JSON.stringify({ active_sessions: [], brain_notes_limit: 20 }),
    });
    // Szerokie okno read→write: bez kolejki jeden zapis zjada drugi.
    const origWrite = vault.adapter.write;
    vault.adapter.write = async (p: string, c: string) => {
        await new Promise(r => setTimeout(r, 1));
        return origWrite(p, c);
    };
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const [bumped] = await Promise.all([
        workflow._autoBumpBrainNoteLimit(),
        memory.stateManager.addActiveSession('zywa_sesja.md'),
    ]);

    const state = JSON.parse(files[statePath]);
    t.true(bumped);
    t.is(state.brain_notes_limit, 30, 'podbicie progu przeżyło');
    t.deepEqual(state.active_sessions, ['zywa_sesja.md'], 'sesja z czatu też przeżyła');
});

test('E2.7 K1: równoległy _resetArchiveCounter i markArchived nie gubią wpisu z czatu', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const statePath = `${base}/.state.json`;
    const { vault, files } = makeVault({
        [statePath]: JSON.stringify({ active_sessions: ['sesja_a.md'], archived_since_last_consolidation: 7 }),
    });
    const origWrite = vault.adapter.write;
    vault.adapter.write = async (p: string, c: string) => {
        await new Promise(r => setTimeout(r, 1));
        return origWrite(p, c);
    };
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    await Promise.all([
        workflow._resetArchiveCounter(),
        memory.stateManager.addActiveSession('sesja_b.md'),
    ]);

    const state = JSON.parse(files[statePath]);
    t.deepEqual((state.active_sessions || []).sort(), ['sesja_a.md', 'sesja_b.md']);
});

// ─── AUD-bledy-047: krok L1 melduje ZE STANU stempli, nie z faktu zapisania paczki ───

test('AUD-bledy-047: pad stempla → wynik kroku L1 WYMIENIA nieostemplowane sesje', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const initial: Record<string, string> = {
        [`${base}/sessions/archive/session_1.md`]: session('session_1.md', 'Sesja 1'),
        [`${base}/sessions/archive/session_2.md`]: session('session_2.md', 'Sesja 2'),
    };
    const { vault, files } = makeVault(initial);
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);
    // Pada WYŁĄCZNIE zapis plików sesji (blokada synchronizatora na `sessions/archive/`) —
    // sama paczka L1 zapisuje się normalnie, więc to jest „zapisane, nie ostemplowane".
    const realWrite = vault.adapter.write;
    vault.adapter.write = async (path: string, content: string) => {
        if (path.includes('/sessions/archive/')) throw new Error('EACCES');
        return realWrite(path, content);
    };

    const result = await workflow._writeLevel1({
        name: 'test_l1.md',
        sessions: ['session_1.md', 'session_2.md'],
        body: 'streszczenie',
    });

    t.is(result.created, 1, 'paczka L1 JEST zapisana - to nie jest porażka całości');
    t.true(Object.keys(files).some(path => path.includes('/summaries/L1/')), 'plik L1 na dysku');
    t.deepEqual(
        result.unstamped?.map(entry => entry.session),
        ['session_1.md', 'session_2.md'],
        'krok niesie listę sesji, które wrócą do NASTĘPNEJ paczki L1',
    );
});

test('AUD-bledy-047: komplet stempli → wynik kroku bez pola `unstamped`', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/sessions/archive/session_1.md`]: session('session_1.md', 'Sesja 1'),
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory);

    const result = await workflow._writeLevel1({ name: 'test_l1.md', sessions: ['session_1.md'], body: 'streszczenie' });

    t.is(result.created, 1);
    t.is(result.unstamped, undefined, 'czysty przebieg nie zaśmieca zwrotki pustą listą');
});
