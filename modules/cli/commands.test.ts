import test from 'ava';
import { buildCliCommands } from './commands.js';

import type { Agent } from '../agents/index.js';
import type { AgentMemory, ConsolidationStatus } from '../memory/index.js';
import type { CliAgentManager, CliDeps } from './commands.js';

/**
 * Fejkowe `CliDeps` pisane ręcznie w teście, NIGDY realny `AgentManager`/`AgentMemory` -
 * `modules/agents/index.ts` ciągnie transytywnie import CSS (`profile_advanced.ts` ->
 * `HiddenFileEditorModal.css`) i AVA pada na starcie testu, zanim dojdzie do jednego `test()`
 * (patrz `modules/agents/CLAUDE.md`, gotcha "profile_advanced.ts nie wstaje w AVA wcale").
 * `Agent`/`AgentMemory` wchodzą tu WYŁĄCZNIE jako `import type` - realnych instancji nie ma,
 * fejkowe obiekty niosą tylko to, co komendy naprawdę czytają, i są rzutowane na granicy.
 */

interface FakePromptSection {
    key: string;
    label: string;
    tokens: number;
    enabled: boolean;
    required: boolean;
    category: string;
    content: string;
    editable: boolean;
}

interface FakePromptResult {
    sections: FakePromptSection[];
    breakdown: { total: number; sections: Array<{ key: string; label: string; tokens: number }> };
}

function fakeAgent(name: string): Agent {
    return { name } as unknown as Agent;
}

function fakeMemory(marker: string): AgentMemory {
    return { __fakeMarker: marker } as unknown as AgentMemory;
}

function markerOf(memory: AgentMemory): string {
    return (memory as unknown as { __fakeMarker: string }).__fakeMarker;
}

interface AgentManagerFixture {
    names: string[];
    active?: string | null;
    prompts?: Record<string, FakePromptResult>;
    memories?: Record<string, AgentMemory | null>;
}

function makeAgentManager(fixture: AgentManagerFixture): CliAgentManager {
    const emptyPrompt: FakePromptResult = { sections: [], breakdown: { total: 0, sections: [] } };
    return {
        getAllAgents: () => fixture.names.map(fakeAgent),
        getAgent: (name: string) => (fixture.names.includes(name) ? fakeAgent(name) : undefined),
        getActiveAgent: () => (fixture.active ? fakeAgent(fixture.active) : null),
        getAgentMemory: (name: string) => fixture.memories?.[name] ?? null,
        getPromptInspectorDataForAgent: async (name?: string) => fixture.prompts?.[name || ''] ?? emptyPrompt,
    };
}

interface DepsFixture {
    ready?: boolean;
    agentManager?: CliAgentManager | undefined;
    indexStatus?: ReturnType<CliDeps['indexStatus']>;
    selfTestResult?: object;
    selfTestError?: Error;
    consolidationByMarker?: Record<string, ConsolidationStatus | Error>;
    version?: string;
    now?: Date;
}

function makeDeps(fixture: DepsFixture = {}): CliDeps {
    // Domyślnie pusty, ale OBECNY agent manager - testy "not_ready z braku agentManagera"
    // podają `agentManager: undefined` JAWNIE, więc `'agentManager' in fixture` je odróżnia
    // od testów, którym agent manager jest po prostu obojętny (np. `status`/`selftest`).
    const am = 'agentManager' in fixture ? fixture.agentManager : makeAgentManager({ names: [] });
    return {
        pluginId: 'pkm-assistant',
        version: () => fixture.version ?? '2.2.8',
        isReady: () => fixture.ready ?? true,
        agentManager: () => am,
        indexStatus: () => fixture.indexStatus,
        selfTest: async () => {
            if (fixture.selfTestError) throw fixture.selfTestError;
            return fixture.selfTestResult ?? { ok: true };
        },
        consolidationStatus: async (memory: AgentMemory) => {
            const marker = markerOf(memory);
            const result = fixture.consolidationByMarker?.[marker];
            if (result instanceof Error) throw result;
            if (!result) throw new Error(`no fixture for marker "${marker}"`);
            return result;
        },
        now: () => fixture.now ?? new Date('2026-09-20T00:00:00.000Z'),
    };
}

function commandById(deps: CliDeps, id: string) {
    const found = buildCliCommands(deps).find(spec => spec.id === `pkm-assistant:${id}`);
    if (!found) throw new Error(`command not found: ${id}`);
    return found;
}

async function run(deps: CliDeps, id: string, params: Record<string, string> = {}) {
    const spec = commandById(deps, id);
    const raw = await spec.run(params);
    return JSON.parse(raw);
}

function consolidationFixture(agent: string): ConsolidationStatus {
    return {
        agent,
        state: { source: 'file', lastArchiveAt: null },
        brainNotes: { count: 3, limit: 20, limitSource: 'default', overLimit: false },
        sessions: { archivedSinceLastConsolidation: 1, threshold: 10, overThreshold: false, uncoveredArchive: 1, activeFiles: 0 },
        summaries: { uncoveredL1: 0, uncoveredL2: 0, batchSize: 5 },
        wouldTrigger: false,
        plan: [],
    };
}

// ── status ──────────────────────────────────────────────────────────────────────────────

test('status: przed gotowoscia -> ready=false, agents=null, index=null', async t => {
    const deps = makeDeps({ ready: false, agentManager: undefined, indexStatus: undefined });
    const response = await run(deps, 'status');

    t.deepEqual(response, {
        ok: true,
        command: 'pkm-assistant:status',
        verified: true,
        effect: 'unchanged',
        data: {
            plugin: { id: 'pkm-assistant', version: '2.2.8', loadedAt: '2026-09-20T00:00:00.000Z' },
            ready: false,
            agents: null,
            index: null,
            commands: [
                'pkm-assistant:status',
                'pkm-assistant:selftest',
                'pkm-assistant:agent-prompt',
                'pkm-assistant:memory-status',
            ],
        },
    });
});

test('status: po gotowosci -> agenci i indeks wypelnione', async t => {
    const am = makeAgentManager({ names: ['Jaskier', 'Atlas'], active: 'Jaskier' });
    const deps = makeDeps({
        ready: true,
        agentManager: am,
        indexStatus: { status: 'ready', progress: { indexed: 42, total: 42 }, modelKey: 'openai/text-embedding-3-small', lastError: null },
    });
    const response = await run(deps, 'status');

    t.true(response.ok);
    t.deepEqual(response.data.agents, { count: 2, active: 'Jaskier', names: ['Jaskier', 'Atlas'] });
    t.deepEqual(response.data.index, { status: 'ready', indexed: 42, total: 42, modelKey: 'openai/text-embedding-3-small', lastError: null });
    t.true(response.data.ready);
});

test('status: lastError obiektem (nie stringiem) wychodzi jako String(...)', async t => {
    const deps = makeDeps({
        indexStatus: { status: 'error', progress: { indexed: 0, total: 0 }, modelKey: null, lastError: new Error('boom') },
    });
    const response = await run(deps, 'status');

    t.is(response.data.index.lastError, 'Error: boom');
});

// ── selftest ────────────────────────────────────────────────────────────────────────────

test('selftest: przekazuje raport z deps.selfTest() bez zmian kształtu', async t => {
    const report = { passed: 12, failed: 0, findings: ['a', 'b'] };
    const deps = makeDeps({ selfTestResult: report });
    const response = await run(deps, 'selftest');

    t.true(response.ok);
    t.deepEqual(response.data, report);
});

test('selftest: wyjatek z deps.selfTest() -> internal, handler nie rzuca', async t => {
    const deps = makeDeps({ selfTestError: new Error('raport padl') });
    const response = await run(deps, 'selftest');

    t.deepEqual(response, {
        ok: false,
        command: 'pkm-assistant:selftest',
        verified: false,
        effect: 'unchanged',
        error: { code: 'internal', message: 'raport padl' },
    });
});

// ── agent-prompt ────────────────────────────────────────────────────────────────────────

const PROMPT_FIXTURE: FakePromptResult = {
    sections: [
        { key: 'identity', label: 'Identity', tokens: 120, enabled: true, required: true, category: 'core', content: 'You are Jaskier.', editable: false },
        { key: 'rules', label: 'Rules', tokens: 80, enabled: true, required: false, category: 'core', content: 'Follow these rules.', editable: true },
    ],
    breakdown: { total: 200, sections: [{ key: 'identity', label: 'Identity', tokens: 120 }, { key: 'rules', label: 'Rules', tokens: 80 }] },
};

test('agent-prompt: dokladne imie -> sekcje BEZ pola content/editable', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier' });

    t.deepEqual(response.data, {
        agent: 'Jaskier',
        totalTokens: 200,
        sections: [
            { key: 'identity', label: 'Identity', category: 'core', tokens: 120, enabled: true, required: true },
            { key: 'rules', label: 'Rules', category: 'core', tokens: 80, enabled: true, required: false },
        ],
    });
});

test('agent-prompt: imie inna wielkoscia liter, JEDNOZNACZNie -> rozwiazuje na kanoniczne imie', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'agent-prompt', { agent: 'JASKIER' });

    t.true(response.ok);
    t.is(response.data.agent, 'Jaskier');
});

test('agent-prompt: nieznane imie -> agent_not_found z lista dostepnych imion', async t => {
    const am = makeAgentManager({ names: ['Jaskier', 'Atlas'] });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'agent-prompt', { agent: 'Nikt' });

    t.false(response.ok);
    t.is(response.error.code, 'agent_not_found');
    t.true(response.error.message.includes('Jaskier'));
    t.true(response.error.message.includes('Atlas'));
});

test('agent-prompt: dwuznaczne dopasowanie bez wielkosci liter -> agent_ambiguous', async t => {
    const am = makeAgentManager({ names: ['Atlas', 'atlas'] });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'agent-prompt', { agent: 'ATLAS' });

    t.false(response.ok);
    t.is(response.error.code, 'agent_ambiguous');
    t.true(response.error.message.includes('Atlas'));
});

test('agent-prompt: section=<key> zwraca content TYLKO tej sekcji, obok pelnej listy sekcji', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', section: 'rules' });

    t.true(response.ok);
    t.deepEqual(response.data.section, { key: 'rules', label: 'Rules', tokens: 80, content: 'Follow these rules.' });
    t.is(response.data.sections.length, 2);
});

test('agent-prompt: nieznana sekcja -> section_not_found z lista dostepnych kluczy', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', section: 'nope' });

    t.false(response.ok);
    t.is(response.error.code, 'section_not_found');
    t.true(response.error.message.includes('identity'));
    t.true(response.error.message.includes('rules'));
});

// ── memory-status ───────────────────────────────────────────────────────────────────────

test('memory-status: jeden agent -> agents=[status], errors=[]', async t => {
    const memory = fakeMemory('jaskier');
    const am = makeAgentManager({ names: ['Jaskier'], memories: { Jaskier: memory } });
    const deps = makeDeps({ agentManager: am, consolidationByMarker: { jaskier: consolidationFixture('Jaskier') } });
    const response = await run(deps, 'memory-status', { agent: 'Jaskier' });

    t.true(response.ok);
    t.deepEqual(response.data, { agents: [consolidationFixture('Jaskier')], errors: [] });
});

test('memory-status: all z jednym agentem rzucajacym -> reszta w agents, wtopa w errors', async t => {
    const jaskierMemory = fakeMemory('jaskier');
    const atlasMemory = fakeMemory('atlas');
    const am = makeAgentManager({
        names: ['Jaskier', 'Atlas'],
        memories: { Jaskier: jaskierMemory, Atlas: atlasMemory },
    });
    const deps = makeDeps({
        agentManager: am,
        consolidationByMarker: {
            jaskier: consolidationFixture('Jaskier'),
            atlas: new Error('brain.md nie do odczytu'),
        },
    });
    const response = await run(deps, 'memory-status', { agent: 'all' });

    t.true(response.ok);
    t.deepEqual(response.data.agents, [consolidationFixture('Jaskier')]);
    t.deepEqual(response.data.errors, [{ agent: 'Atlas', message: 'brain.md nie do odczytu' }]);
});

test('memory-status: agent bez instancji pamieci (getAgentMemory -> null) -> wpis w errors', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], memories: { Jaskier: null } });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'memory-status', { agent: 'Jaskier' });

    t.true(response.ok);
    t.deepEqual(response.data, { agents: [], errors: [{ agent: 'Jaskier', message: 'Agent has no memory instance yet.' }] });
});

test('memory-status: nieznane imie (nie "all") -> agent_not_found, nie wchodzi w petle', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'memory-status', { agent: 'Nikt' });

    t.false(response.ok);
    t.is(response.error.code, 'agent_not_found');
});

// ── wspolne zasady (format / not_ready / nieznane klucze / wyjatki) ────────────────────────

test('format=xml -> bad_flag (na kazdej z czterech komend)', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ agentManager: am });
    for (const id of ['status', 'selftest', 'agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { format: 'xml', agent: 'Jaskier' });
        t.false(response.ok, `${id} powinno odmowic format=xml`);
        t.is(response.error.code, 'bad_flag', `${id}`);
    }
});

test('nieznany klucz w params jest ignorowany, nie wywala bad_flag', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ agentManager: am });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', vault: 'MyVault' });

    t.true(response.ok);
});

test('not_ready dla trzech komend (nie status), gdy isReady()===false', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ ready: false, agentManager: am });
    for (const id of ['selftest', 'agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { agent: 'Jaskier' });
        t.false(response.ok, id);
        t.is(response.error.code, 'not_ready', id);
    }
});

test('not_ready dla trzech komend, gdy brak agentManager (nawet jesli isReady()===true)', async t => {
    const deps = makeDeps({ ready: true, agentManager: undefined });
    for (const id of ['selftest', 'agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { agent: 'Jaskier' });
        t.false(response.ok, id);
        t.is(response.error.code, 'not_ready', id);
    }
});

test('status NIGDY nie oddaje not_ready, nawet bez agentManagera i przed gotowoscia', async t => {
    const deps = makeDeps({ ready: false, agentManager: undefined });
    const response = await run(deps, 'status');
    t.true(response.ok);
});

test('wyjatek rzucony przez deps (agentManager()) -> internal, handler nie rzuca', async t => {
    const deps: CliDeps = {
        ...makeDeps({}),
        agentManager: () => { throw new Error('deps padly'); },
    };
    const response = await run(deps, 'selftest');

    t.deepEqual(response, {
        ok: false,
        command: 'pkm-assistant:selftest',
        verified: false,
        effect: 'unchanged',
        error: { code: 'internal', message: 'deps padly' },
    });
});
