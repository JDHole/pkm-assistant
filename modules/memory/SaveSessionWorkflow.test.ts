import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { SaveSessionWorkflow } from './SaveSessionWorkflow.js';
import type { SaveAgentMemoryLike } from './SaveSessionWorkflow.js';
import type { StreamChatModelLike, StreamHandlers, StreamMessage } from './streamHelper.js';
// Alias — goły `t` jest wewnątrz każdego testu zajęty przez ExecutionContext AVA.
import { t as tr } from '../../core/i18n/index.js';
import { parseFrontmatter } from '../../core/utils/yamlParser.js';

/**
 * `AgentMemory` jest jeszcze w JavaScripcie, a jego JSDoc deklaruje `@param {Object} vault`,
 * więc TS widzi `memory.vault` jako `Object` i nie uznaje instancji za `SaveAgentMemoryLike`.
 * Rzutowanie znika, gdy paczka M2b skonwertuje właściciela.
 */
type MemoryUnderTest = AgentMemory & SaveAgentMemoryLike;
const asMemory = (m: AgentMemory): MemoryUnderTest => m as unknown as MemoryUnderTest;

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

test('SaveSessionWorkflow proposes a brain note from "pamietaj ze" session text', t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);

    const notes = workflow.proposeNotes([
        { role: 'user', content: 'pamiętaj że Kuba lubi krótkie raporty.' }
    ]);

    t.is(notes.length, 1);
    t.like(notes[0], {
        type: 'user',
        section: '## User',
        content: 'Kuba lubi krótkie raporty.'
    });
});

test('SaveSessionWorkflow routes agent_rule content to ## Preferencje', t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);

    const notes = workflow.proposeNotes([
        { role: 'user', content: 'pamiętaj że zawsze mów po polsku bez emoji.' }
    ]);

    t.is(notes.length, 1);
    t.is(notes[0].type, 'agent_rule');
    t.is(notes[0].section, '## Preferencje');
});

test('SaveSessionWorkflow routes project_context content to ## Bieżące', t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);

    const notes = workflow.proposeNotes([
        { role: 'user', content: 'pamiętaj że ten projekt to PKM Assistant plugin do Obsidiana.' }
    ]);

    t.is(notes.length, 1);
    t.is(notes[0].type, 'project_context');
    t.is(notes[0].section, '## Bieżące');
});

test('SaveSessionWorkflow refreshes brain.md as an index instead of appending raw facts', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);

    await workflow._createBrainNote({
        name: 'polski bez emoji',
        description: 'Kuba chce polski styl bez emoji.',
        type: 'agent_rule',
        content: 'Zawsze odpowiadaj po polsku bez emoji.'
    });
    const changed = await workflow._applyBrainUpdates();
    const brain = files['.pkm-assistant/agents/jaskier/memory/brain.md'];

    t.true(changed);
    t.true(brain.includes('## Preferencje'));
    t.true(brain.includes('[[brain/agent_rule_polski_bez_emoji.md]]'));
    t.false(brain.includes('- zawsze mów po polsku bez emoji'));
});

test('SaveSessionWorkflow creates accepted brain note and archives active session', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const path = await memory.appendToActiveSession({
        type: 'user_message',
        content: 'pamiętaj że Kuba lubi krótkie raporty.',
        timestamp: '2026-05-14T10:00:00.000Z'
    });
    const workflow = new SaveSessionWorkflow(memory, {
        modalFactory: ({ notes, brainUpdates }) => ({
            prompt: async () => ({ action: 'archive', notes, brainUpdates })
        })
    });

    const result = await workflow.run({ path });
    const notePath = result.notesCreated[0].path;
    const state = JSON.parse(files['.pkm-assistant/agents/jaskier/memory/.state.json']);

    t.true(files[notePath].includes('Kuba lubi krótkie raporty.'));
    t.true(files['.pkm-assistant/agents/jaskier/memory/brain.md'].includes('[[brain/user_kuba_lubi_krotkie_raporty.md]]'));
    t.false(Object.prototype.hasOwnProperty.call(files, path));
    t.true(Object.prototype.hasOwnProperty.call(files, '.pkm-assistant/agents/jaskier/memory/sessions/archive/' + path.split('/').pop()));
    t.is(state.archived_since_last_consolidation, 1);
    t.false(result.cancelled);
});

test('AUD-code-review-067: _createBrainNote dokłada kanoniczną stopkę Why/How (jak memory_save)', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);

    const created = await workflow._createBrainNote({
        name: 'notatka z why/how',
        description: 'opis',
        type: 'user',
        content: 'Treść notatki.',
        why: 'Bo Kuba o to prosił.',
        how_to_apply: 'Użyj przy planowaniu sesji.',
    });

    const body = files[created.path];
    // Do naprawy (AUD-code-review-067) `_createBrainNote` reimplementowała zapis obok
    // `AgentMemory.writeBrainNote` i NIGDY nie dokładała tej stopki, mimo że LLM w
    // `/save session` generuje `why`/`how_to_apply` (workPrompts.ts).
    t.true(body.includes(`${tr('memory.note.why_label')} Bo Kuba o to prosił.`), 'stopka „Dlaczego" niesie treść z pola why');
    t.true(body.includes(`${tr('memory.note.how_label')} Użyj przy planowaniu sesji.`), 'stopka „Jak stosować" niesie treść z pola how_to_apply');
});

test('AUD-code-review-068: _createBrainNote escapuje frontmatter przez JSON.stringify — dwukropek w name/description przeżywa zapis', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);

    const created = await workflow._createBrainNote({
        name: 'spotkanie 14:30',
        description: 'notatka o godzinie 9:00',
        type: 'user',
        content: 'Treść.',
    });

    // Do naprawy (AUD-code-review-068) `_createBrainNote` psuła dwukropek przez
    // `replace(':', ' -')` — „spotkanie 14:30" wracało na dysku jako „spotkanie 14 -30",
    // bezpowrotnie. Kanoniczny pisarz (`AgentMemory._buildBrainNoteContent`) escapuje przez
    // `JSON.stringify`, więc dwukropek zostaje w cudzysłowie, nie zamieniony.
    t.true(files[created.path].includes('"spotkanie 14:30"'), 'dwukropek w name przeżywa zapis 1:1, nie „spotkanie 14 -30"');
    t.true(files[created.path].includes('"notatka o godzinie 9:00"'), 'to samo dla description');

    // Czytnik (listBrainNotes -> _parseFrontmatter -> parseFrontmatterScalar -> JSON.parse)
    // odzyskuje oryginalny tekst, nie tylko surowe bajty pliku.
    const [note] = await memory.listBrainNotes();
    t.is(note.name, 'spotkanie 14:30');
    t.is(note.description, 'notatka o godzinie 9:00');
});

test('AUD-code-review-051: pad zapisu JEDNEJ notatki nie blokuje pozostałych, przebudowy indeksu ani archiwizacji sesji', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const path = await memory.appendToActiveSession({
        type: 'user_message',
        content: 'pamiętaj że Kuba lubi krótkie raporty.',
        timestamp: '2026-08-30T10:00:00.000Z',
    });
    const workflow = new SaveSessionWorkflow(memory);

    // „druga notatka" pada na zapisie (symulacja awarii IO na dysku sieciowym) — „pierwsza
    // notatka" i cała reszta metody (rebuildBrainIndex, archiveActiveSession) mają przeżyć.
    const realWrite = vault.adapter.write.bind(vault.adapter);
    vault.adapter.write = async (p: string, content: string) => {
        if (p.includes('/brain/') && p.includes('druga')) {
            throw new Error('symulacja: dysk sieciowy padł');
        }
        return realWrite(p, content);
    };

    const result = await workflow.applyDecision({ path }, { sessionPath: path }, {
        action: 'archive',
        notes: [
            { name: 'pierwsza notatka', type: 'user', content: 'tresc 1', accepted: true },
            { name: 'druga notatka', type: 'user', content: 'tresc 2', accepted: true },
        ],
        brainUpdates: [],
    });

    t.is(result.notesCreated.length, 1, 'notatka, która się udała, jest w wyniku');
    t.is(result.notesCreated[0].name, 'pierwsza notatka');
    t.is(result.noteFailures?.length, 1, 'padnięta notatka wraca w noteFailures, nie znika bez śladu');
    t.is(result.noteFailures?.[0].name, 'druga notatka');
    t.true(result.brainChanged, 'rebuildBrainIndex WYKONAŁ SIĘ mimo pada jednej notatki');
    t.truthy(result.archivedPath, 'archiveActiveSession WYKONAŁO SIĘ mimo pada jednej notatki');
    t.false(Object.prototype.hasOwnProperty.call(files, path), 'aktywna sesja została zarchiwizowana mimo pada jednej notatki');
    t.false(result.cancelled);
});

// ─── Memory v3 LLM-driven proposal ─────────────────────────────────────────

function makeMockModel(responseText: string): StreamChatModelLike {
    return {
        stream(_req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            // Mimic the ChatModel done() callback shape (OpenAI/Anthropic shaped)
            setTimeout(() => {
                handlers.done({
                    choices: [{ message: { content: responseText } }],
                    usage: { prompt_tokens: 50, completion_tokens: 20 }
                });
            }, 0);
        }
    };
}

const FAKE_PROMPT = 'You are an agent. Output JSON.';

test('SaveSessionWorkflow LLM proposal — parses ADD/UPDATE/DELETE + new_notes', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const llmResponse = JSON.stringify({
        brain_updates: [
            { action: 'ADD', section: '## Bieżące', content: 'deadline na artykuł', why: 'user deadline' },
            { action: 'UPDATE', section: '## Bieżące', oldContent: 'stare', content: 'nowe' },
            { action: 'DELETE', section: '## Bieżące', content: 'do usunięcia' }
        ],
        new_notes: [
            { name: 'cytat_dnia', description: 'cytat o spontaniczności', type: 'reference', content: 'Świat jest pełen rzeczy...', why: 'user prosił', how_to_apply: 'cytuj kiedy o pięknie' }
        ]
    });
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: makeMockModel(llmResponse)
    });

    const proposal = await workflow.proposeBrainUpdatesViaAgent([
        { role: 'user', content: 'dziś deadline na artykuł' }
    ]);

    t.is(proposal.brain_updates.length, 0);
    t.is(proposal.new_notes.length, 1);
    t.is(proposal.new_notes[0].name, 'cytat_dnia');
    t.is(proposal.new_notes[0].type, 'reference');
});

test('SaveSessionWorkflow LLM proposal — strips ```json fences', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const wrapped = '```json\n' + JSON.stringify({ brain_updates: [{ action: 'ADD', section: '## User', content: 'fakt' }], new_notes: [] }) + '\n```';
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: makeMockModel(wrapped)
    });

    const proposal = await workflow.proposeBrainUpdatesViaAgent([{ role: 'user', content: 'cokolwiek' }]);
    t.is(proposal.brain_updates.length, 0);
});

test('SaveSessionWorkflow LLM proposal — rejects invalid sections and actions', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const llmResponse = JSON.stringify({
        brain_updates: [
            { action: 'ADD', section: '## Foo', content: 'bad section' },
            { action: 'EXPLODE', section: '## Bieżące', content: 'bad action' },
            { action: 'ADD', section: '## Bieżące', content: '   ' },
            { action: 'ADD', section: '## Bieżące', content: 'good entry' }
        ],
        new_notes: [
            { name: '', content: 'no name', type: 'reference' },
            { name: 'ok', content: 'ok content', type: 'reference' }
        ]
    });
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: makeMockModel(llmResponse)
    });

    const proposal = await workflow.proposeBrainUpdatesViaAgent([{ role: 'user', content: 'x' }]);
    t.is(proposal.brain_updates.length, 0);
    t.is(proposal.new_notes.length, 1);
    t.is(proposal.new_notes[0].name, 'ok');
});

test('SaveSessionWorkflow prepareProposals falls back to regex when LLM is missing', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.appendToActiveSession({
        type: 'user_message',
        content: 'pamiętaj że Kuba lubi krótkie raporty.',
        timestamp: '2026-05-15T10:00:00.000Z'
    });

    const workflow = new SaveSessionWorkflow(memory, {
        // no agent, no model → must fall back
    });

    const prep = await workflow.prepareProposals({ path: memory.activeSessionPath });
    t.false(prep.llmDriven);
    t.true(prep.notes.length >= 1);
    t.is(prep.notes[0].type, 'user');
});

test('SaveSessionWorkflow prepareProposals uses LLM when model + agent provided', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.appendToActiveSession({
        type: 'user_message',
        content: 'zapisz mi proszę cytat ulubiony',
        timestamp: '2026-05-15T10:00:00.000Z'
    });
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: makeMockModel(JSON.stringify({
            brain_updates: [{ action: 'ADD', section: '## Bieżące', content: 'cytat zapisany' }],
            new_notes: []
        }))
    });

    const prep = await workflow.prepareProposals({ path: memory.activeSessionPath });
    t.true(prep.llmDriven);
    t.is(prep.brainUpdates.length, 0);
});

// ─── Z4.3: usage strzalu propozycji wychodzi z prepareProposals (zeby ktos mogl zaksiegowac koszt) ───

test('Z4.3: prepareProposals oddaje usage ze strzalu LLM', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.appendToActiveSession({
        type: 'user_message',
        content: 'zapisz cytat',
        timestamp: '2026-05-15T10:00:00.000Z'
    });
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: makeMockModel(JSON.stringify({ brain_updates: [], new_notes: [] })),
    });

    const prep = await workflow.prepareProposals({ path: memory.activeSessionPath });

    t.true(prep.llmDriven);
    const usage = prep.usage as { prompt_tokens?: number; completion_tokens?: number };
    t.is(usage.prompt_tokens, 50);
    t.is(usage.completion_tokens, 20);
});

test('Z4.3: sciezka regexowa (bez modelu) nie obiecuje usage', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.appendToActiveSession({
        type: 'user_message',
        content: 'pamiętaj że X',
        timestamp: '2026-05-15T10:00:00.000Z'
    });
    const workflow = new SaveSessionWorkflow(memory, {});

    const prep = await workflow.prepareProposals({ path: memory.activeSessionPath });

    t.false(prep.llmDriven);
    t.is(prep.usage, null);
});

test('SaveSessionWorkflow uses LLM via factory save prompt when agent has none — E2.8 B3', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.appendToActiveSession({
        type: 'user_message',
        content: 'zapisz cytat',
        timestamp: '2026-05-15T10:00:00.000Z'
    });
    let capturedSystemPrompt: string | null = null;
    const captureModel: StreamChatModelLike = {
        stream(req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            capturedSystemPrompt = (req.messages?.find(m => m.role === 'system')?.content as string) || null;
            setTimeout(() => handlers.done({ choices: [{ message: { content: JSON.stringify({ brain_updates: [], new_notes: [] }) } }] }), 0);
        }
    };
    // model present, agent WITHOUT save_session_prompt → resolver falls back to factory (LLM path).
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier' },
        model: captureModel,
    });

    const prep = await workflow.prepareProposals({ path: memory.activeSessionPath });
    t.true(prep.llmDriven, 'factory save_session prompt drives the LLM path');
    t.true(capturedSystemPrompt!.includes('brain.md'), 'factory save-session prompt reached the model');
});

test('SaveSessionWorkflow falls back to regex when LLM throws', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.appendToActiveSession({
        type: 'user_message',
        content: 'pamiętaj że X',
        timestamp: '2026-05-15T10:00:00.000Z'
    });
    const explodingModel: StreamChatModelLike = {
        stream(_req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            setTimeout(() => handlers.error(new Error('boom')), 0);
        }
    };
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: explodingModel
    });

    const prep = await workflow.prepareProposals({ path: memory.activeSessionPath });
    t.false(prep.llmDriven);
    t.true(prep.notes.length >= 1);
});

test('SaveSessionWorkflow applyDecision ignores legacy brainUpdates and rebuilds index', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const path = await memory.appendToActiveSession({
        type: 'user_message',
        content: 'session start',
        timestamp: '2026-05-15T10:00:00.000Z'
    });
    const workflow = new SaveSessionWorkflow(memory);
    const decision = {
        action: 'archive',
        notes: [{
            name: 'refaktor pamięci',
            description: 'Nowy indeks brain.md dla Memory v3.',
            type: 'project_context',
            content: 'Przebudowa indeksu brain.md.',
            accepted: true
        }],
        brainUpdates: [
            { action: 'ADD', section: '## Bieżące', content: 'nowy ważny artykuł refaktor' },
            { action: 'DELETE', section: '## Bieżące', content: 'stary deadline na sobotę' }
        ]
    };
    const prep = { sessionPath: path, messages: [], notes: [], brainUpdates: decision.brainUpdates };
    await workflow.applyDecision({ path }, prep, decision);

    const brain = files['.pkm-assistant/agents/jaskier/memory/brain.md'];
    t.true(brain.includes('[[brain/project_context_refaktor_pamieci.md]]'));
    t.false(brain.includes('nowy ważny artykuł refaktor'));
    t.false(brain.includes('stary deadline na sobotę'));
});

// ─── E2.8 D3: „Na teraz" short-term updates from the LLM proposal ───

test('E2.8 D3: LLM na_teraz block parses into ADD/DELETE updates', t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);
    const parsed = workflow._parseAgentJsonResponse(JSON.stringify({
        new_notes: [],
        na_teraz: {
            user: { add: ['Kuba testuje panel'], remove: ['Stary stan usera'] },
            environment: { add: [], remove: [] }
        }
    }));
    t.is(parsed.na_teraz_updates.length, 2);
    t.like(parsed.na_teraz_updates.find(u => u.action === 'ADD'), { section: 'user', content: 'Kuba testuje panel' });
    t.like(parsed.na_teraz_updates.find(u => u.action === 'DELETE'), { section: 'user', oldContent: 'Stary stan usera' });
});

test('E2.8 D3: applyDecision applies accepted „Na teraz" updates via the writer', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const path = await memory.appendToActiveSession({ type: 'user_message', content: 'x', timestamp: '2026-07-23T10:00:00.000Z' });
    await memory.writeNaTeraz([{ section: 'user', add: 'Stary stan usera' }]);
    const workflow = new SaveSessionWorkflow(memory);
    const decision = {
        action: 'archive',
        notes: [],
        brainUpdates: [
            { action: 'ADD', section: 'user', content: 'Kuba testuje panel', accepted: true },
            { action: 'DELETE', section: 'user', oldContent: 'Stary stan usera', accepted: true },
            { action: 'ADD', section: 'environment', content: 'Odrzucone', accepted: false }
        ]
    };
    const prep = { sessionPath: path, messages: [], notes: [], brainUpdates: decision.brainUpdates };
    await workflow.applyDecision({ path }, prep, decision);

    const brain = files['.pkm-assistant/agents/jaskier/memory/brain.md'];
    t.true(brain.includes('- Kuba testuje panel'));
    t.false(brain.includes('- Stary stan usera'), 'outdated entry removed');
    t.false(brain.includes('Odrzucone'), 'rejected update not applied');
});

// ─── S29 Z6: prepareProposals przekazuje opcje streamu (onChunk / signal / watchdog) ───

/** Atrapa modelu, która najpierw kapie chunkami, potem kończy. Zapamiętuje, czy ją zatrzymano. */
interface ChunkSink { started?: boolean; stopped?: boolean }

function makeChunkingModel(responseText: string, sink: ChunkSink = {}, delayMs = 0): StreamChatModelLike {
    return {
        stopStream() { sink.stopped = true; },
        stream(_req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            sink.started = true;
            setTimeout(() => {
                if (sink.stopped) return;
                // Chunk niesie CAŁOŚĆ skumulowaną (kontrakt streamHelper) — deltę liczy helper.
                handlers.chunk({ choices: [{ message: { content: '{"new_' } }] });
                handlers.chunk({ choices: [{ message: { content: responseText } }] });
                handlers.done({ choices: [{ message: { content: responseText } }], usage: {} });
            }, delayMs);
        }
    };
}

test('S29: prepareProposals karmi onChunk deltami ze streamu (znak życia dla modalu)', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const response = JSON.stringify({ new_notes: [{ name: 'x', description: 'd', type: 'user', content: 'c' }] });
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: makeChunkingModel(response),
    });

    const deltas: string[] = [];
    const prep = await workflow.prepareProposals(
        { path: 'x.md', messages: [{ role: 'user', content: 'hej' }] },
        { onChunk: (delta) => deltas.push(delta) }
    );

    t.true(prep.llmDriven, 'ścieżka LLM, nie regexy');
    t.is(deltas.length, 2, 'każdy chunk zgłasza znak życia');
    t.is(deltas[0], '{"new_');
    t.true(deltas[1].startsWith('notes'), 'druga delta to PRZYROST, nie cała treść od nowa');
});

test('S29: prepareProposals honoruje AbortSignal — „Anuluj" nie udaje propozycji z regexów', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const sink: ChunkSink = {};
    const workflow = new SaveSessionWorkflow(memory, {
        // Model, który długo milczy — dokładnie ta sytuacja, w której user klika „Anuluj".
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: makeChunkingModel('{}', sink, 5000),
    });

    const controller = new AbortController();
    const pending = workflow.prepareProposals(
        { path: 'x.md', messages: [{ role: 'user', content: 'pamiętaj że Kuba lubi krótkie raporty.' }] },
        { signal: controller.signal }
    );
    while (!sink.started) await new Promise(resolve => setTimeout(resolve, 1)); // czekamy aż strzał ruszy
    controller.abort();

    const error = await t.throwsAsync(pending);
    t.is((error as Error & { code?: string })?.code, 'aborted');
    t.true(sink.stopped, 'stream zatrzymany tą samą drogą co Stop w czacie');
});

test('S29: zwykła awaria modelu NADAL spada cicho na regexy (bez zmian dla starych wywołań)', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory, {
        agent: { name: 'Jaskier', save_session_prompt: FAKE_PROMPT },
        model: {
            stream(_req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
                setTimeout(() => handlers.error(new Error('HTTP 500')), 0);
            },
        },
    });

    const prep = await workflow.prepareProposals({
        path: 'x.md',
        messages: [{ role: 'user', content: 'pamiętaj że Kuba lubi krótkie raporty.' }],
    });

    t.false(prep.llmDriven);
    t.is(prep.notes.length, 1, 'fallback regexowy zadziałał jak dotąd');
});

// ─── D8 (2026-08-27, werdykt 27.08): poczekalnia rescue dołączona do propozycji /save session ───
//
// AUD-docs-065: memory_rescue pisał kandydatów wprost do brain/, bez review. Werdykt lidera:
// kandydaci z brain/pending_rescue/ dołączają do TEJ SAMEJ listy `notes`, którą już renderuje
// SaveSessionModal — accept tworzy notatkę (przez AgentMemory.acceptPendingRescue), reject i
// anulowanie modala mają swoje własne, odrębne zachowanie (patrz testy niżej).

test('D8 (e): prepareProposals dokłada kandydatów z poczekalni do listy notes', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.writePendingRescue({
        name: 'Kuba lubi ciemny motyw', type: 'user', content: 'Kuba lubi ciemny motyw w Obsidianie.',
        description: 'opis oryginalny',
    });
    const workflow = new SaveSessionWorkflow(memory);

    const prep = await workflow.prepareProposals({ path: 'x.md', messages: [] });

    t.is(prep.notes.length, 1);
    t.is(prep.notes[0].pendingFilename, 'user_kuba_lubi_ciemny_motyw.md');
    t.is(prep.notes[0].content, 'Kuba lubi ciemny motyw w Obsidianie.');
    const today = new Date().toISOString().slice(0, 10);
    t.true(prep.notes[0].description!.startsWith('['), 'pochodzenie widoczne jako prefiks w nawiasach');
    t.true(prep.notes[0].description!.includes(today), 'prefiks niesie datę kandydata');
    t.true(prep.notes[0].description!.endsWith('] opis oryginalny'));
    t.is(prep.notes[0].pendingOriginalDescription, 'opis oryginalny');
    t.true(prep.notes[0].accepted, 'domyślnie zaznaczony do akceptacji, jak zwykłe propozycje');
});

test('D8 (e): pending i zwykłe propozycje regexowe współistnieją na jednej liście', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.writePendingRescue({ name: 'z rescue', type: 'reference', content: 'kandydat z kompresji' });
    await memory.appendToActiveSession({
        type: 'user_message', content: 'pamiętaj że Kuba lubi krótkie raporty.',
        timestamp: '2026-08-27T10:00:00.000Z',
    });
    const workflow = new SaveSessionWorkflow(memory);

    const prep = await workflow.prepareProposals({ path: memory.activeSessionPath });

    t.is(prep.notes.length, 2);
    t.true(prep.notes.some(n => n.pendingFilename && n.content === 'kandydat z kompresji'));
    t.true(prep.notes.some(n => !n.pendingFilename && n.content === 'Kuba lubi krótkie raporty.'));
});

test('D8 (e): padnięte listPendingRescue nie wywala prepareProposals — po prostu brak kandydatów w tej rundzie', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    (memory as unknown as { listPendingRescue: () => Promise<never> }).listPendingRescue =
        async () => { throw new Error('dysk niedostępny'); };
    const workflow = new SaveSessionWorkflow(memory);

    const prep = await workflow.prepareProposals({ path: 'x.md', messages: [] });
    t.deepEqual(prep.notes, []);
});

test('D8 (b): applyDecision accept notatki-pending tworzy notatkę w brain/ i kasuje kandydata', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const pending = await memory.writePendingRescue({ name: 'do zaakceptowania', type: 'reference', content: 'tresc rescue' });
    const workflow = new SaveSessionWorkflow(memory);
    // Bez sesji aktywnej (agentMemory.activeSessionPath jest null) — applyDecision pomija
    // archiveActiveSession (sessionPath falsy). Test dotyczy WYŁĄCZNIE notatek z poczekalni.
    const prep = await workflow.prepareProposals({});

    const result = await workflow.applyDecision({}, prep, {
        action: 'archive', notes: prep.notes, brainUpdates: [],
    });

    t.is(result.notesCreated.length, 1);
    t.true(files[result.notesCreated[0].path].includes('tresc rescue'));
    t.deepEqual(await memory.listPendingRescue(), [], 'kandydat zniknął z poczekalni po accept');
    t.is((await memory.listBrainNotes()).length, 1);
    t.false(Object.prototype.hasOwnProperty.call(files, pending.path));
});

test('D8 (c): applyDecision reject notatki-pending (accepted:false) kasuje kandydata, brain/ bez zmian', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const pending = await memory.writePendingRescue({ name: 'do odrzucenia', type: 'reference', content: 'tresc rescue' });
    const workflow = new SaveSessionWorkflow(memory);
    const prep = await workflow.prepareProposals({});
    const decisionNotes = prep.notes.map(n => ({ ...n, accepted: false }));

    const result = await workflow.applyDecision({}, prep, {
        action: 'archive', notes: decisionNotes, brainUpdates: [],
    });

    t.is(result.notesCreated.length, 0);
    t.deepEqual(await memory.listPendingRescue(), [], 'odrzucony kandydat zniknął z poczekalni');
    t.deepEqual(await memory.listBrainNotes(), [], 'reject NIE tworzy notatki w brain/');
    t.false(Object.prototype.hasOwnProperty.call(files, pending.path));
});

test('D8 (f): anulowanie CAŁEGO modala zostawia poczekalnię nietkniętą', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const pending = await memory.writePendingRescue({ name: 'czeka dalej', type: 'reference', content: 'x' });
    const workflow = new SaveSessionWorkflow(memory);
    const prep = await workflow.prepareProposals({ path: 'x.md', messages: [] });

    const result = await workflow.applyDecision({ path: 'x.md', messages: [] }, prep, {
        action: 'cancel', notes: prep.notes, brainUpdates: [],
    });

    t.true(result.cancelled);
    t.is(result.notesCreated.length, 0);
    const stillPending = await memory.listPendingRescue();
    t.is(stillPending.length, 1, 'kandydat CZEKA na następną okazję — anulowanie nic nie rusza');
    t.is(stillPending[0].filename, pending.filename);
    t.deepEqual(await memory.listBrainNotes(), [], 'nic nie powstało w brain/');
});

test('D8: user edytował opis w modalu — accept zapisuje wersję usera, nie prefiks pochodzenia', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.writePendingRescue({ name: 'x', type: 'reference', content: 'c', description: 'opis oryginalny' });
    const workflow = new SaveSessionWorkflow(memory);
    const prep = await workflow.prepareProposals({});
    // Symulacja edycji pola opisu w SaveSessionModal (`desc.addEventListener('input', ...)`).
    const editedNotes = prep.notes.map(n => ({ ...n, description: 'opis wpisany przez usera' }));

    const result = await workflow.applyDecision({}, prep, {
        action: 'archive', notes: editedNotes, brainUpdates: [],
    });

    t.true(files[result.notesCreated[0].path].includes('opis wpisany przez usera'));
    t.false(files[result.notesCreated[0].path].includes('z kompresji okna'), 'prefiks pochodzenia nie ląduje w finalnej notatce, gdy user nadpisał opis');
});

// ─── Weryfikacja opusa — nit 2: pola pending przeżywają DOKŁADNIE spread SaveSessionModal ───

test('D8 nit2 (weryfikacja opusa): propozycja pending przeżywa dokładnie ten spread, którego używa SaveSessionModal.setProposals', async t => {
    // SaveSessionModal.ts: `this.notes = (payload.notes || []).map(note => ({ ...note,
    // accepted: note.accepted !== false }))` — TA SAMA transformacja, powtórzona tu 1:1.
    // Gdyby ktoś kiedyś zamienił ten spread na jawną rekonstrukcję pól (jak `_normalizeUpdate`
    // robi dziś dla `BrainUpdate` w tym samym pliku), a zapomniał o `pendingFilename`/
    // `pendingOriginalDescription`/`pendingPrefixedDescription` — ten test złapałby regresję
    // przez OBSERWOWALNY skutek: kandydat nie zniknąłby z poczekalni mimo accept.
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const pending = await memory.writePendingRescue({ name: 'x', type: 'reference', content: 'treść' });
    const workflow = new SaveSessionWorkflow(memory);
    const prep = await workflow.prepareProposals({});

    const throughModal = prep.notes.map(note => ({ ...note, accepted: note.accepted !== false }));
    t.is(throughModal[0].pendingFilename, pending.filename, 'spread modala zachowuje pole (kontrola pozytywna)');

    const result = await workflow.applyDecision({}, prep, {
        action: 'archive', notes: throughModal, brainUpdates: [],
    });

    t.is(result.notesCreated.length, 1);
    t.deepEqual(await memory.listPendingRescue(), [], 'accept po przejściu przez spread modala nadal kasuje kandydata z poczekalni');
    t.false(Object.prototype.hasOwnProperty.call(files, pending.path), 'brak ducha w poczekalni');
});

test('D8 nit2: propozycja BEZ pendingFilename (rekonstrukcja pól a la _normalizeUpdate) tworzy DUPLIKAT i osiera kandydata — dokumentuje ryzyko z komentarza w SessionNote', async t => {
    // Kontrola negatywna: symuluje DOKŁADNIE tę przyszłą regresję, przed którą ostrzega
    // komentarz w `SaveSessionModal.SessionNote`. Test NIE sprawdza obrony (jej nie ma na
    // tym poziomie — to typ, nie runtime guard) — dokumentuje SKUTEK, żeby ktokolwiek
    // wprowadzający taką rekonstrukcję zobaczył w diffie testów, co realnie się psuje.
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const pending = await memory.writePendingRescue({ name: 'x', type: 'reference', content: 'treść' });
    const workflow = new SaveSessionWorkflow(memory);
    const prep = await workflow.prepareProposals({});

    // Rekonstrukcja NAZWANYCH pól, bez pendingFilename/pendingOriginalDescription/pendingPrefixedDescription.
    const rebuilt = prep.notes.map(n => ({
        name: n.name, section: n.section, description: n.description, content: n.content, accepted: n.accepted,
    }));

    const result = await workflow.applyDecision({}, prep, {
        action: 'archive', notes: rebuilt, brainUpdates: [],
    });

    t.is(result.notesCreated.length, 1, 'notatka POWSTAJE — ale przez zwykłą ścieżkę _createBrainNote, nie accept poczekalni');
    const stillPending = await memory.listPendingRescue();
    t.is(stillPending.length, 1, 'DUCH: kandydat zostaje w poczekalni na zawsze — dokładnie ryzyko z komentarza w SessionNote');
    t.is(stillPending[0].filename, pending.filename);
});

// ─── Weryfikacja opusa — nit 3: kandydat bez name/filename nie wywala całego /save session ───

test('D8 nit3 (weryfikacja opusa): kandydat bez pól (obca implementacja listPendingRescue) nie wywala prepareProposals', async t => {
    const { vault } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    await memory.appendToActiveSession({
        type: 'user_message', content: 'pamiętaj że Kuba lubi krótkie raporty.',
        timestamp: '2026-08-27T10:00:00.000Z',
    });
    // Obca implementacja `listPendingRescue` (albo plik uszkodzony na dysku) — kandydat BEZ
    // name i BEZ filename. `p.name || p.filename.replace(...)` rzuciłby TypeError bez nit3.
    (memory as unknown as { listPendingRescue: () => Promise<Array<Record<string, unknown>>> }).listPendingRescue =
        async () => [{}];
    const workflow = new SaveSessionWorkflow(memory);

    const prep = await workflow.prepareProposals({ path: memory.activeSessionPath });

    t.is(prep.notes.length, 1, 'malformed kandydat pending pominięty — zwykła propozycja sesji PRZEŻYWA');
    t.is(prep.notes[0].content, 'Kuba lubi krótkie raporty.');
});

test('SaveSessionWorkflow does not rewrite brain.md when index is already current', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);

    await memory.rebuildBrainIndex();
    const changed = await workflow._applyBrainUpdates();
    const firstBrain = files['.pkm-assistant/agents/jaskier/memory/brain.md'];
    const changedAgain = await workflow._applyBrainUpdates();
    const secondBrain = files['.pkm-assistant/agents/jaskier/memory/brain.md'];

    t.false(changed);
    t.false(changedAgain);
    t.is(secondBrain, firstBrain);
});

// ── Pin nocy audytowej 2026-08-17 (moduł 8 / zgłoszenie Niki z 16.08) ──────────
//
// Zgłoszenie: na 248 notatek pamięci załogi 9 miało frontmatter, którego YAML nie
// parsuje — Obsidian odrzuca wtedy CAŁY nagłówek i notatka znika dla wszystkiego,
// co filtruje po `type`/`created`.
//
// W tym module żyją CZTERY pisarze nagłówka notatki i dwie różne szkoły:
//   • `AgentMemory.ts:1207` (`quote`) i `ArchiveWorkflow.ts:981` (`safe`) —
//     `JSON.stringify`, czyli poprawny cytowany skalar YAML;
//   • `SaveSessionWorkflow.ts:648` (`_frontmatterValue`) i `MigrationV3.ts:330`
//     (`escapeFrontmatter`) — wartość NIECYTOWANA, a jedyna obrona to okaleczenie
//     dwukropka (`':' → ' -'`).
//
// Rodzina druga przepuszcza wszystkie pozostałe znaki-wskaźniki YAML. Zmierzone
// parserem, nie wydedukowane: opis zaczynający się od backticka albo `*` wywala
// parsowanie, a opis od `#` cicho wychodzi jako `null` (reszta linii to komentarz).
// Dwukropek w środku zdania jest przy okazji trwale przepisywany na ` -`, więc
// treść usera nie wraca taka, jaka weszła.
//
// STAN 2026-09-04 (wciąganie ogonów): naprawa WESZŁA — `SaveSessionWorkflow` pisze dziś
// nagłówek przez `JSON.stringify` (ta sama szkoła co `AgentMemory`), więc pin nocy zszedł
// z `.failing` na zwykły test i pilnuje od teraz regresji.
test('nagłówek notatki z save_session przeżywa własny parser pluginu (round-trip)', async t => {
    const { vault, files } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const workflow = new SaveSessionWorkflow(memory);

    // Opisy pisze model przy zamykaniu sesji — backtick i gwiazdka to jego codzienność.
    const opis = '`memory_save` zapisuje od razu: bez pytania';

    const { path } = await workflow._createBrainNote({
        name: 'zapis pamieci',
        description: opis,
        type: 'agent_rule',
        content: 'tresc',
    });

    const { frontmatter } = parseFrontmatter(files[path]);
    const fm = frontmatter as { description?: unknown; type?: unknown } | null;

    t.truthy(fm, 'nagłówek w ogóle się parsuje');
    t.is(fm?.type, 'agent_rule', 'pola za opisem nie giną');
    t.is(fm?.description, opis, 'opis wraca dokładnie taki, jaki wszedł');
});

test('kontrola: pisarz z AgentMemory (JSON.stringify) ten sam opis przenosi bez szwanku', t => {
    const opis = '`memory_save` zapisuje od razu: bez pytania';
    // 1:1 helper `quote` z AgentMemory.ts:1207 — druga szkoła w tym samym module.
    const quote = (v: unknown) => JSON.stringify(String(v || '').slice(0, 1000));
    const { frontmatter } = parseFrontmatter(
        `---\nname: "test"\ndescription: ${quote(opis)}\ntype: agent_rule\n---\n\ntresc\n`,
    );
    const fm = frontmatter as { description?: unknown; type?: unknown } | null;

    t.is(fm?.description, opis, 'to jest wzorzec, do którego pin wyżej równa');
    t.is(fm?.type, 'agent_rule');
});
