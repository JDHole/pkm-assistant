import test from 'ava';
import { SubAgentRunner as RuntimeSubAgentRunner } from './SubAgentRunner.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
// ⚠️ i18n importujemy jako `tr` — `t` to obiekt asercji AVA (konwencja repo).
import { t as tr } from '../../core/i18n/index.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
// AUD-bledy-011: kontrakt pliku sesji — zdarzenie biegu musi przejść przez pisarza I czytnik.
import { formatSessionEvent, parseActiveSession } from '../memory/activeSessionFormat.js';

type TestRunner = {
    runTask(...args: unknown[]): Promise<{ result: string }>;
    _buildTaskPrompt(...args: unknown[]): Promise<string>;
    _executeTool(...args: unknown[]): Promise<string>;
    _resolveToolNames(...args: unknown[]): string[];
};
const SubAgentRunner = RuntimeSubAgentRunner as unknown as new (options: unknown) => TestRunner;

test('SubAgentRunner returns readable error when stream throws object-like message', async t => {
    const wrapped = new Error('placeholder');
    (wrapped as unknown as { message: unknown }).message = {
        code: 400,
        details: { message: 'Tool-call assistant message produced no valid function calls.' },
    };

    const model = {
        stream(_payload: unknown, callbacks: { error(error: unknown): void }) {
            callbacks.error(wrapped);
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {},
    });

    const result = await runner.runTask(
        'delegate task',
        { name: 'Jaskier' },
        { name: 'prep-memory', role: 'researcher', tools: [] },
        model,
        { modelTimeout: 1 }
    );

    t.true(result.result.includes('prep-memory'));
    t.true(result.result.includes('Tool-call assistant message produced no valid function calls'));
    t.false(result.result.includes('[object Object]'));
});

// --- D18: THIN prompt template (brain injection 12k USUNIĘTY; pull zamiast push) ---

test('_buildTaskPrompt is thin: no brain push, memory PULL hint + budget + rules', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {}, // brak agentManager — sub NIE dostaje pamięci pushem
    });

    const prompt = await runner._buildTaskPrompt(
        { name: 'Jaskier' },
        { name: 'worker', tools: [], description: 'jednorazowy research' }
    );

    // Brain injection + LOKALIZACJE całkowicie out.
    t.false(prompt.includes('BRAIN.MD CONTENT:'));
    t.false(prompt.includes('BRAIN/ CATALOGUE'));
    t.false(prompt.includes('LOKALIZACJE:'));
    // Zamiast pushu — jedna linia wskazówki pull (scope=memory).
    t.true(prompt.includes('scope="memory"'));
    // Zwięzły szkielet: budżet + jedna lista zasad.
    t.true(prompt.includes('BUDŻET:'));
    t.true(prompt.includes('ZASADY:'));
    t.true(prompt.includes('jednorazowy research'));
});

test('_buildTaskPrompt renders identically regardless of role label (F6)', async t => {
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });

    const asResearcher = await runner._buildTaskPrompt(
        { name: 'Klara' }, { name: 'x', role: 'researcher', tools: [], description: 'd' });
    const asStrategist = await runner._buildTaskPrompt(
        { name: 'Klara' }, { name: 'x', role: 'strategist', tools: [], description: 'd' });

    t.is(asResearcher, asStrategist, 'rola to etykieta — nie zmienia szablonu promptu');
});

// F4: cap ISTNIEJE i TNIE — to jest intencja tego testu. Wartość bierze się z
// `config/limits.js` (`subagent_prompt_max_chars`), a nie z liczby wpisanej w test,
// bo od F4 user może ją zmienić w Ustawieniach → Limity.
test('_buildTaskPrompt soft-caps config.prompt at the configured budget', async t => {
    const cap = DEFAULT_LIMITS.subagent_prompt_max_chars;
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });
    const big = 'y'.repeat(cap + 3000);

    const prompt = await runner._buildTaskPrompt(
        { name: 'Jaskier' },
        { name: 'worker', tools: [], prompt: big }
    );

    t.true(prompt.includes(`[... instrukcja obcięta do ${cap} znaków]`));
    // Treść metody obcięta do capu — nie przechodzi w całości.
    t.false(prompt.includes('y'.repeat(cap + 1)));
});

test('F4: budżet instrukcji suba jedzie z ustawień usera (override tnie mocniej)', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { env: { settings: { pkmAssistant: { limits: { subagent_prompt_max_chars: 1500 } } } } },
    });

    const prompt = await runner._buildTaskPrompt(
        { name: 'Jaskier' },
        { name: 'worker', tools: [], prompt: 'y'.repeat(5000) }
    );

    t.true(prompt.includes('[... instrukcja obcięta do 1500 znaków]'));
    t.false(prompt.includes('y'.repeat(1501)));
});

test('F4: blok BUDŻET nie kłamie — pokazuje limity, którymi realnie karmimy pętlę', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { env: { settings: { pkmAssistant: { limits: { subagent_max_iterations_worker: 7 } } } } },
    });

    const domyslny = await runner._buildTaskPrompt({ name: 'Jaskier' }, { name: 'worker', tools: [] });
    t.true(domyslny.includes(`Dostępne iteracje narzędzi: 7`), 'override usera widoczny w prompcie');

    // Config suba nadal wygrywa nad limitem ramy — i prompt musi mówić TĘ liczbę.
    const zConfigu = await runner._buildTaskPrompt(
        { name: 'Jaskier' }, { name: 'worker', tools: [], max_iterations: 20 });
    t.true(zConfigu.includes('Dostępne iteracje narzędzi: 20'));
});

test('_buildTaskPrompt includes SCOPE block only when config.scope is set', async t => {
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });

    const withScope = await runner._buildTaskPrompt(
        { name: 'Klara' },
        { name: 'klara-prep', tools: [], scope: { folders: ['30_X/'], sections: [], pinned_notes: [], frontmatter: {} } }
    );
    const noScope = await runner._buildTaskPrompt(
        { name: 'Klara' }, { name: 'worker', tools: [] });

    t.true(withScope.includes('SCOPE:'));
    t.true(withScope.includes('30_X/'));
    t.false(noScope.includes('SCOPE:'));
});

// --- E1.3 P8: fail-closed whitelist in the direct-execution fallback ---

function makeToolSpyRegistry(calls: Record<string, boolean>) {
    const tools = {
        vault_read: { name: 'vault_read', description: 'read', inputSchema: {}, execute: async () => { calls.read = true; return 'READ_OK'; } },
        vault_delete: { name: 'vault_delete', description: 'delete', inputSchema: {}, execute: async () => { calls.del = true; return 'DELETED'; } },
    };
    return { getTool: (name: string) => tools[name as keyof typeof tools] || null };
}

test('_executeTool refuses a tool outside the parent∩sub whitelist (fallback path)', async t => {
    const calls: Record<string, boolean> = {};
    // plugin has no mcpClient → _executeTool takes the direct-execution fallback.
    const runner = new SubAgentRunner({ toolRegistry: makeToolSpyRegistry(calls), app: {}, plugin: {} });
    const allowed = new Set(['vault_read']);

    const denied = await runner._executeTool({ name: 'vault_delete', arguments: '{}' }, 'Klara', allowed);

    t.falsy(calls.del, 'vault_delete is outside the whitelist and MUST NOT execute');
    t.true(typeof denied === 'string' && denied.length > 0, 'a refusal message is returned');
    t.not(denied, 'DELETED', 'the tool result must not be produced');
});

test('_executeTool still runs a whitelisted tool (fallback path)', async t => {
    const calls: Record<string, boolean> = {};
    const runner = new SubAgentRunner({ toolRegistry: makeToolSpyRegistry(calls), app: {}, plugin: {} });
    const allowed = new Set(['vault_read']);

    const result = await runner._executeTool({ name: 'vault_read', arguments: '{}' }, 'Klara', allowed);

    t.true(calls.read, 'vault_read is whitelisted and must execute');
    t.is(result, 'READ_OK');
    t.falsy(calls.del);
});

// F2.13 (release 2.2.0/W3): fallback bez MCPClient nie umie wyegzekwować scopeFolders (żadna
// bramka PermissionSystem nie stoi na tej ścieżce — jedyna ochrona to whitelista NAZW). Gdy
// wołacz podał scopeFolders (zamierzał zawęzić suba do konkretnych folderów), fail-closed
// (odmowa) jest bezpieczniejsze niż ciche rozszerzenie na cały vault.
test('_executeTool (fallback bez MCPClient) ODMAWIA, gdy scopeFolders nie da się wyegzekwować', async t => {
    const calls: Record<string, boolean> = {};
    const runner = new SubAgentRunner({ toolRegistry: makeToolSpyRegistry(calls), app: {}, plugin: {} });
    const allowed = new Set(['vault_read']);

    const denied = await runner._executeTool({ name: 'vault_read', arguments: '{}' }, 'Klara', allowed,
        { scopeFolders: ['Projekty'] });

    t.falsy(calls.read, 'vault_read jest na whitelisście, ale scope nie da się wyegzekwować w tej ścieżce — MUSI odmówić');
    t.is(denied, tr('subagent.tool_scope_unenforceable', { name: 'vault_read' }));
});

test('_executeTool (fallback bez MCPClient) przechodzi bez zmian, gdy scopeFolders jest puste/nieustawione', async t => {
    const calls: Record<string, boolean> = {};
    const runner = new SubAgentRunner({ toolRegistry: makeToolSpyRegistry(calls), app: {}, plugin: {} });
    const allowed = new Set(['vault_read']);

    const okEmpty = await runner._executeTool({ name: 'vault_read', arguments: '{}' }, 'Klara', allowed,
        { scopeFolders: [] });
    t.true(calls.read, 'pusta lista scopeFolders = brak zawężenia, zachowanie sprzed F2.13');
    t.is(okEmpty, 'READ_OK');
});

// --- S33 Z1: kagańce delegacji przenoszone do MCPClient ---

test('_executeTool przekazuje delegationDepth i scopeFolders do MCPClient', async t => {
    const calls: Array<{ agentName?: string; opts: Record<string, unknown> }> = [];
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            currentAutonomy: 'edge',
            mcpClient: {
                executeToolCall: async (_toolCall: unknown, agentName: string, opts: Record<string, unknown>) => {
                    calls.push({ agentName, opts });
                    return 'OK';
                },
            },
        },
    });

    await runner._executeTool({ name: 'read', arguments: '{}' }, 'Klara', new Set(['read']),
        { delegationDepth: 1, scopeFolders: ['Projekty'] });

    t.is(calls.length, 1);
    t.is(calls[0].opts.delegationDepth, 1);
    t.deepEqual(calls[0].opts.scopeFolders, ['Projekty']);
    t.is(calls[0].opts.autonomy, 'edge', 'dziedziczenie autonomii bez zmian');
});

test('_executeTool (fallback bez MCPClient) sam znaczy głębokość w args', async t => {
    const seen: Array<Record<string, unknown>> = [];
    const runner = new SubAgentRunner({
        toolRegistry: {
            getTool: (name: string) => ({ name, execute: async (args: Record<string, unknown>) => { seen.push(args); return 'OK'; } }),
        },
        app: {},
        plugin: {}, // brak mcpClient → ścieżka bezpośrednia
    });

    await runner._executeTool({ name: 'delegate', arguments: '{"task":"x"}' }, 'Klara',
        new Set(['delegate']), { delegationDepth: 1 });

    t.is(seen[0]._invocationDelegationDepth, 1, 'inaczej delegacja tędy startowałaby od zera');
});

test('runTask domyślnie nie nakłada scope ani głębokości (zachowanie bez zmian)', async t => {
    const calls: Array<Record<string, unknown>> = [];
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            mcpClient: {
                executeToolCall: async (_toolCall: unknown, _agentName: string, opts: Record<string, unknown>) => { calls.push(opts); return 'OK'; },
            },
        },
    });

    await runner._executeTool({ name: 'read', arguments: '{}' }, 'Klara', new Set(['read']));

    t.is(calls[0].delegationDepth, undefined);
    t.is(calls[0].scopeFolders, undefined);
});

// --- D18/F6: jednolity domyślny zestaw narzędzi (rola nie steruje) ---

test('_resolveToolNames uses the uniform worker default set (prymitywy read/list/search)', t => {
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });
    const names = runner._resolveToolNames({}, {});

    t.deepEqual(names, ['search', 'list', 'read', 'web_search', 'web_read']);
    t.false(names.includes('memory_list_summaries'), 'no deprecated memory names');
    t.false(names.includes('vault_search'), 'no deprecated vault_search');
});

test('_resolveToolNames defaults are identical regardless of role label (F6)', t => {
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });
    const asResearcher = runner._resolveToolNames({ role: 'researcher' }, {});
    const asStrategist = runner._resolveToolNames({ role: 'strategist' }, {});

    t.deepEqual(asResearcher, asStrategist, 'rola to etykieta — nie zmienia domyślnych narzędzi');
});

test('_resolveToolNames honors explicit config.tools over defaults (rename applied)', t => {
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });
    // E2.6: vault_read → read przy budowie whitelisty (DEPRECATED_TOOL_RENAMES).
    const names = runner._resolveToolNames({ role: 'researcher', tools: ['vault_read'] }, {});

    t.deepEqual(names, ['read']);
});

test('_resolveToolNames maps deprecated config.tools to search/read + dedups', t => {
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });
    // vault_grep/vault_semantic → search (dedup), vault_read → read (E2.6).
    const names = runner._resolveToolNames({ role: 'researcher', tools: ['vault_grep', 'vault_semantic', 'vault_read'] }, {});

    t.deepEqual(names, ['search', 'read']);
});

// --- Poligon F2: etykieta trace musi rozróżniać WYWOŁANIA suba ---
//
// `delegate` z listą `tasks` odpala N workerów równolegle (Promise.all na tym samym configu).
// Do F2 każdy pisał w trace pod tą samą etykietą `sub/<nazwa>`, więc `loop.start`/`tool.post`/
// `loop.end` z kilku biegów mieszały się w jeden nierozróżnialny strumień.

/** Atrapa modelu: jedna odpowiedź tekstowa, zero tool-calli → pętla kończy się naturalnie. */
function fakeDoneModel() {
    return {
        stream(_payload: unknown, callbacks: { done(resp: unknown): void }) {
            callbacks.done({
                choices: [{ message: { role: 'assistant', content: 'gotowe' } }],
                usage: { prompt_tokens: 10, completion_tokens: 2 },
            });
        },
    };
}

/**
 * ⚠️ `modelTimeout: 5` w każdym wywołaniu: `runAgentLoop` robi `Promise.race` z `setTimeout`
 * i NIE kasuje timera po rozstrzygnięciu wyścigu — domyślne 120 s trzymałoby żywy event loop
 * i AVA kończyła plik komunikatem „Failed to exit". Tak samo robi pierwszy test w tym pliku.
 */

/** Runner z atrapą pluginu, która zapamiętuje KAŻDĄ etykietę podaną do `traceLog.scope`. */
function makeTracingRunner(labels: string[]) {
    return new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            traceLog: {
                scope(label: string) {
                    labels.push(label);
                    return () => { /* same zdarzenia trace nas tu nie interesują */ };
                },
            },
        },
    });
}

test('etykieta trace suba niesie identyfikator wywołania (sub/<nazwa>#<id>)', async t => {
    const labels: string[] = [];
    const runner = makeTracingRunner(labels);

    await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });

    t.is(labels.length, 1);
    t.regex(labels[0], /^sub\/pkm-sub#[a-z0-9]+$/, `etykieta bez identyfikatora wywołania: ${labels[0]}`);
});

test('N równoległych workerów z jednego delegate dostaje RÓŻNE etykiety', async t => {
    const labels: string[] = [];
    const runner = makeTracingRunner(labels);

    await Promise.all([1, 2, 3].map(i =>
        runner.runTask(`zadanie ${i}`, { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), { modelTimeout: 5 })));

    t.is(labels.length, 3);
    t.is(new Set(labels).size, 3, `etykiety się powtarzają: ${labels.join(', ')}`);
    for (const label of labels) t.true(label.startsWith('sub/pkm-sub#'));
});

test('filtr prefiksowy po nazwie suba nie łapie cudzych nazw (kontrakt harnessa)', async t => {
    const labels: string[] = [];
    const runner = makeTracingRunner(labels);

    await runner.runTask('a', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });
    await runner.runTask('b', { name: 'Tester' }, { name: 'pkm-sub-extra', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });

    // Tak filtruje `subTraceEvents` w harnessie: `<label>#`, nie goły `startsWith(label)`.
    t.is(labels.filter(l => l.startsWith('sub/pkm-sub#')).length, 1);
    t.is(labels.filter(l => l.startsWith('sub/pkm-sub-extra#')).length, 1);
});

// --- F1: bieg suba jako byt w rejestrze (`plugin.subTaskRegistry`) ---
//
// Rejestr rozsyła kroki pętli do konsumentów; trace.log jest PIERWSZYM z nich (subskrypcja
// żyje w SubTaskRegistry, nie tutaj). Runner ma tylko: założyć byt pod etykietą trace,
// podać pętli funkcję-tee i domknąć bieg wynikiem albo błędem.

type FakeTask = { id: string; name: string; agentName: string; budget: Record<string, unknown> };

function makeFakeRegistry() {
    const created: FakeTask[] = [];
    const steps: Array<{ id: string; type: string; fields: Record<string, unknown> }> = [];
    const finished: Array<{ id: string; result: Record<string, unknown> }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    const registry = {
        create(init: FakeTask) { created.push(init); return init; },
        traceFor(task: FakeTask) {
            return (type: string, fields: Record<string, unknown> = {}) => { steps.push({ id: task.id, type, fields }); };
        },
        finish(task: FakeTask, result: Record<string, unknown>) { finished.push({ id: task.id, result }); },
        fail(task: FakeTask, error: string) { failed.push({ id: task.id, error }); },
    };
    return { created, steps, finished, failed, registry };
}

test('runTask zakłada w rejestrze byt o id = etykieta trace i karmi go krokami pętli', async t => {
    const { created, steps, registry } = makeFakeRegistry();
    const scopeLabels: string[] = [];
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            subTaskRegistry: registry,
            traceLog: { scope(label: string) { scopeLabels.push(label); return () => {}; } },
        },
    });

    await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });

    t.is(created.length, 1);
    t.regex(created[0].id, /^sub\/pkm-sub#[a-z0-9]+$/, 'id taska = dzisiejsza etykieta trace');
    t.is(created[0].name, 'pkm-sub');
    t.is(created[0].agentName, 'Tester');
    // F4: wartość bierze się z `config/limits.js`, nie z liczby wpisanej w test — intencja
    // („budżet taska = limity, którymi realnie karmimy pętlę") zostaje, pin przestaje kłamać.
    t.is(created[0].budget.maxIterations, DEFAULT_LIMITS.subagent_max_iterations_worker,
        'budżet taska = limity podane pętli');
    t.true(steps.length > 0, 'kroki pętli lecą przez rejestr');
    t.true(steps.every(s => s.id === created[0].id));
    t.true(steps.some(s => s.type === 'loop.start'));
    t.true(steps.some(s => s.type === 'loop.end'));
    t.deepEqual(scopeLabels, [], 'z rejestrem runner NIE woła traceLog.scope — pisze konsument rejestru');
});

test('runTask domyka byt wynikiem (finish z mapowaniem stoppedBy)', async t => {
    const { finished, failed, registry } = makeFakeRegistry();
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { subTaskRegistry: registry },
    });

    await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });

    t.is(failed.length, 0);
    t.is(finished.length, 1);
    t.is(finished[0].result.stoppedBy, 'natural');
    t.is(finished[0].result.text, 'gotowe');
    t.deepEqual(finished[0].result.toolsUsed, []);
    t.is(typeof finished[0].result.durationMs, 'number');
});

test('błąd modelu domyka byt przez fail, a wynik runTask zostaje bez zmian', async t => {
    const { created, finished, failed, registry } = makeFakeRegistry();
    const model = {
        stream(_payload: unknown, callbacks: { error(error: unknown): void }) {
            callbacks.error(new Error('model padł'));
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { subTaskRegistry: registry },
    });

    const result = await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, model, { modelTimeout: 5 });

    t.is(finished.length, 0);
    t.is(failed.length, 1);
    t.is(failed[0].id, created[0].id);
    t.is(failed[0].error, 'model padł');
    t.true(result.result.includes('model padł'), 'runTask nadal zwraca NORMALNY wynik z tekstem błędu');
});

test('bez rejestru runner pisze trace jak dotąd (fallback ścieżki sprzed F1)', async t => {
    const labels: string[] = [];
    const events: string[] = [];
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            traceLog: {
                scope(label: string) {
                    labels.push(label);
                    return (type: string) => { events.push(type); };
                },
            },
        },
    });

    await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });

    t.is(labels.length, 1);
    t.regex(labels[0], /^sub\/pkm-sub#[a-z0-9]+$/);
    t.true(events.includes('loop.start') && events.includes('loop.end'), 'trace dostaje kroki wprost z pętli');
});

test('wysypany rejestr nie psuje biegu suba (księgowość nie zmienia wyniku)', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            subTaskRegistry: {
                create() { throw new Error('rejestr padł'); },
                traceFor() { return () => {}; },
                finish() { /* nieosiągalne */ },
                fail() { /* nieosiągalne */ },
            },
        },
    });

    const result = await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });

    t.is(result.result, 'gotowe', 'sub kończy normalnie mimo wywalonego rejestru');
});

test('sub bez nazwy spada na rolę, a bez roli na „sub" — nadal z numerem wywołania', async t => {
    const labels: string[] = [];
    const runner = makeTracingRunner(labels);

    await runner.runTask('a', { name: 'Tester' }, { role: 'researcher', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });
    await runner.runTask('b', { name: 'Tester' }, { tools: [] }, fakeDoneModel(), { modelTimeout: 5 });

    t.regex(labels[0], /^sub\/researcher#[a-z0-9]+$/);
    t.regex(labels[1], /^sub\/sub#[a-z0-9]+$/);
});

// --- F2: byt zakładany PRZED startem modelu + hak onTaskCreated ---

test('onTaskCreated dostaje byt ZANIM ruszy model (delegacja w tle ma czym oddać task_id)', async t => {
    const { created, registry } = makeFakeRegistry();
    const kolejnosc: string[] = [];
    const model = {
        stream(_payload: unknown, callbacks: { done(resp: unknown): void }) {
            kolejnosc.push('model');
            callbacks.done({ choices: [{ message: { role: 'assistant', content: 'gotowe' } }] });
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { subTaskRegistry: registry },
    });

    const widziane: string[] = [];
    await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, model, {
        modelTimeout: 5,
        onTaskCreated: (task: { id: string }) => { kolejnosc.push('created'); widziane.push(task.id); },
    });

    t.deepEqual(kolejnosc, ['created', 'model'], 'byt istnieje przed pierwszym requestem do modelu');
    t.is(widziane.length, 1);
    t.is(widziane[0], created[0].id, 'hak dostaje TEN SAM byt, który poszedł do rejestru');
});

test('origin i background jadą 1:1 do registry.create', async t => {
    const { created, registry } = makeFakeRegistry();
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { subTaskRegistry: registry },
    });
    const origin = { agentName: 'Klara', sessionPath: 'Czaty/klara.md', tabKey: 'tab-2' };

    await runner.runTask('zadanie', { name: 'Klara' }, { name: 'klara-prep', tools: [] }, fakeDoneModel(), {
        modelTimeout: 5, origin, background: true,
    });

    t.is((created[0] as unknown as { background?: boolean }).background, true);
    t.deepEqual((created[0] as unknown as { origin?: unknown }).origin, origin);
});

test('bez rejestru onTaskCreated NIE jest wołany (ścieżka sprzed F1 bez zmian)', async t => {
    const labels: string[] = [];
    const runner = makeTracingRunner(labels);
    let wolane = 0;

    const result = await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), {
        modelTimeout: 5, background: true, onTaskCreated: () => { wolane++; },
    });

    t.is(wolane, 0);
    t.is(result.result, 'gotowe', 'brak rejestru nie psuje biegu');
    t.is(labels.length, 1, 'trace leci wprost, jak przed F1');
});

test('rzucający onTaskCreated nie wywala biegu suba (bezpiecznik księgowości)', async t => {
    const { finished, registry } = makeFakeRegistry();
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { subTaskRegistry: registry },
    });

    const result = await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), {
        modelTimeout: 5, onTaskCreated: () => { throw new Error('wołacz padł'); },
    });

    t.is(result.result, 'gotowe');
    t.is(finished.length, 1, 'bieg i tak domknięty normalnie');
});

// ─── Audyt nocny 2026-08-15, moduł 19 (iteracje subagentów) — ZAMKNIĘTY w F5 ───
// `runAgentLoop` oddaje `stoppedBy` ('natural' | 'backstop' | 'abort'), runner wypisywał je
// do logu ("stop: backstop"), ale NIE przekazywał dalej — zwracany obiekt miał
// result/toolsUsed/toolCallDetails/duration/usage i tyle. Informacja o tym, JAK sub zszedł,
// ginęła na granicy runnera i nie docierała ani do `DelegateTool`, ani do agenta zlecającego.
// Skutek: sub, któremu skończyły się iteracje (i który oddał zaślepkę backstopu), wyglądał
// dla zlecającego identycznie jak sub, który zadanie realnie domknął.
test('audyt 19: runTask oddaje stoppedBy z pętli (F5: już nie ginie na granicy runnera)', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {},
    });

    const result = await runner.runTask(
        'zadanie',
        { name: 'Tester' },
        { name: 'pkm-sub', tools: [] },
        fakeDoneModel(),
        { modelTimeout: 5 },
    ) as { result: string; stoppedBy?: string; failed?: true };

    // Kontrola założenia: bieg naprawdę doszedł do końca i oddał tekst modelu.
    t.is(result.result, 'gotowe');
    t.is(result.stoppedBy, 'natural', 'runner nie przekazuje stoppedBy z runAgentLoop');
    t.is(result.failed, undefined, 'udany bieg NIE ma flagi failed');
});

// F5: druga połowa uczciwości — bieg, który padł, musi to POWIEDZIEĆ.
test('F5: bieg zakończony wyjątkiem oddaje failed:true + stoppedBy "error"', async t => {
    const model = {
        stream(_payload: unknown, callbacks: { error(error: unknown): void }) {
            callbacks.error(new Error('Model timeout'));
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {},
    });

    const result = await runner.runTask(
        'zadanie',
        { name: 'Tester' },
        { name: 'pkm-sub', tools: [] },
        model,
        { modelTimeout: 5 },
    ) as { result: string; stoppedBy?: string; failed?: true };

    t.true(result.result.includes('Model timeout'), 'tekst błędu zostaje w `result` (kompat)');
    t.is(result.stoppedBy, 'error');
    t.true(result.failed);
});

// F5: rejestr dostaje `stoppedBy` z pętli tą samą drogą co dotąd (kontrakt `finish` bez zmian).
test('F5: stoppedBy z pętli ląduje też w karcie biegu (registry.finish)', async t => {
    const { finished, registry } = makeFakeRegistry();
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { subTaskRegistry: registry },
    });

    await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, fakeDoneModel(), { modelTimeout: 5 });

    t.is(finished.length, 1);
    t.is(finished[0].result.stoppedBy, 'natural');
});

// ─── F5: wiadomość do suba w trakcie (hak `beforeContinue`) ───────────────────
// Suby NIE podpinały dotąd ŻADNYCH hooków pętli. F5 dokłada dokładnie jeden —
// `beforeContinue` — bo tylko tam da się dopisać coś do transkryptu MIĘDZY wywołaniami
// modelu, czyli tam, gdzie sub to przeczyta bez przerywania w połowie zdania.

/**
 * Atrapa modelu na N iteracji: pierwsze N-1 odpowiedzi to tool-call (pętla leci dalej),
 * ostatnia to zwykły tekst — który dodatkowo RAPORTUJE, co model zobaczył w transkrypcie.
 */
function fakeMultiIterModel(iteracje: number, widziane: string[][]) {
    let i = 0;
    return {
        stream(payload: { messages?: Array<{ role: string; content?: unknown }> }, callbacks: { done(resp: unknown): void }) {
            widziane.push((payload.messages || []).map(m => `${m.role}:${String(m.content ?? '')}`));
            i++;
            if (i < iteracje) {
                callbacks.done({
                    choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                        { id: `c${i}`, type: 'function', function: { name: 'read', arguments: '{}' } },
                    ] } }],
                });
                return;
            }
            callbacks.done({ choices: [{ message: { role: 'assistant', content: 'gotowe' } }] });
        },
    };
}

function runnerZNarzedziem(registry: unknown) {
    return new SubAgentRunner({
        toolRegistry: {
            getTool: (name: string) => ({
                name,
                description: 'atrapa',
                inputSchema: {},
                execute: async () => 'wynik narzędzia',
            }),
        },
        app: {},
        plugin: { subTaskRegistry: registry },
    });
}

test('F5: wiadomość wrzucona w trakcie biegu ląduje w transkrypcie suba przed kolejnym strzałem', async t => {
    const registry = new SubTaskRegistry();
    const widziane: string[][] = [];
    const runner = runnerZNarzedziem(registry);

    // Wiadomość wrzucamy DOPIERO gdy bieg istnieje — czyli w haku „byt powstał".
    const bieg = runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: ['read'] },
        fakeMultiIterModel(3, widziane),
        {
            modelTimeout: 500,
            onTaskCreated: (task: { id: string }) => { registry.postMessage(task.id, 'pomiń archiwum'); },
        },
    );
    await bieg;

    // Iteracja 1 jeszcze jej nie widzi (wrzucona przed pierwszym strzałem, ale hak
    // `beforeContinue` odpala się dopiero PO iteracji) — kolejne już tak.
    t.false(widziane[0].some(m => m.includes('pomiń archiwum')), 'pierwszy strzał leci bez dopisku');
    t.true(widziane[1].some(m => m.includes('pomiń archiwum')), 'drugi strzał ma polecenie w transkrypcie');
    t.true(widziane[1].some(m => m.startsWith('user:') && m.includes(tr('subagent.steer_prefix'))),
        'dopisek jedzie jako wiadomość usera z nagłówkiem-ramką');
    registry.dispose();
});

test('F5: wiadomość doręczana DOKŁADNIE RAZ — kolejne iteracje nie powtarzają dopisku', async t => {
    const registry = new SubTaskRegistry();
    const widziane: string[][] = [];
    const runner = runnerZNarzedziem(registry);

    await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: ['read'] },
        fakeMultiIterModel(4, widziane),
        {
            modelTimeout: 500,
            onTaskCreated: (task: { id: string }) => { registry.postMessage(task.id, 'jedno polecenie'); },
        },
    );

    const powtorzenia = widziane[3].filter(m => m.includes('jedno polecenie')).length;
    t.is(powtorzenia, 1, 'dopisek siedzi w transkrypcie raz, a nie raz na iterację');
    registry.dispose();
});

test('F5: brak wiadomości = ZERO dopisków w transkrypcie', async t => {
    const registry = new SubTaskRegistry();
    const widziane: string[][] = [];
    const runner = runnerZNarzedziem(registry);

    await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: ['read'] },
        fakeMultiIterModel(3, widziane), { modelTimeout: 500 },
    );

    t.false(widziane.flat().some(m => m.includes(tr('subagent.steer_prefix'))));
    registry.dispose();
});

test('F5: bez rejestru hak w ogóle nie jest podpinany (ścieżka sprzed F5)', async t => {
    const widziane: string[][] = [];
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {}, // brak subTaskRegistry
    });

    const res = await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] },
        fakeMultiIterModel(1, widziane), { modelTimeout: 500 },
    );

    t.is(res.result, 'gotowe');
    t.false(widziane.flat().some(m => m.includes(tr('subagent.steer_prefix'))));
});

// ── K8 (AUD-security-055): błąd suba nie wozi sekretów do rodzica ani do pliku sesji ──

test('K8: klucz z błędu suba nie wraca do rodzica ani nie ląduje w pliku sesji', async t => {
    const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    // Kształt zdarzenia strumienia bez `data`: normalize_error serializuje CAŁY event
    // razem z nagłówkiem autoryzacji (dokładnie ta wtopa z raportu).
    const raw = new Error('placeholder');
    (raw as unknown as { message: unknown }).message =
        `{"status":null,"data":null,"source":{"headers":{"Authorization":"Bearer ${KEY}"}}}`;

    const events: Array<Record<string, unknown>> = [];
    const model = {
        stream(_payload: unknown, callbacks: { error(error: unknown): void }) {
            callbacks.error(raw);
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            agentManager: {
                // K4: runner adresuje pamięć po WŁAŚCICIELU biegu, nie po globalnym aktywnym.
                getAgentMemory: (name: string) => (name === 'Tester' ? {
                    appendToActiveSession: async (event: Record<string, unknown>) => { events.push(event); },
                } : null),
            },
        },
    });

    const result = await runner.runTask(
        'zadanie',
        { name: 'Tester' },
        { name: 'pkm-sub', tools: [] },
        model,
        { modelTimeout: 5 },
    );

    // (a) wynik oddawany narzędziu `delegate` → kontekst modelu rodzica
    t.false(result.result.includes(KEY), 'klucz wrócił do modelu rodzica');
    // (b) zapis do aktywnej sesji agenta w vaultcie
    t.is(events.length, 1);
    t.false(String(events[0].result).includes(KEY), 'klucz wylądował w pliku sesji');
    // Ślad błędu zostaje czytelny (diagnostyka nie ginie).
    t.true(result.result.includes('Authorization'));
});

// ── K4 (AUD-security-091/050): stan biegu zamrożony w chwili ZLECENIA ──
// Delegacja z głównego czatu jest od rundy 3 ZAWSZE w tle, więc bieg suba przeżywa dalszą
// pracę usera w UI: przełączenie zakładki przestawia `agentManager.activeAgent` i
// `plugin.currentAutonomy`. Runner nie ma prawa czytać tych luster w trakcie biegu.

/** Atrapa AgentManagera z dwoma pamięciami + przestawialnym globalnym aktywnym. */
function makeSwitchableManager() {
    const events: Record<string, Array<Record<string, unknown>>> = { A: [], B: [] };
    const state = { active: 'A' };
    const memories: Record<string, unknown> = {};
    for (const name of ['A', 'B']) {
        memories[name] = {
            agentName: name,
            appendToActiveSession: async (event: Record<string, unknown>) => { events[name].push(event); },
        };
    }
    return {
        events, state,
        manager: {
            getAgentMemory: (name: string) => memories[name] || null,
            getActiveAgent: () => ({ name: state.active }),
            getActiveMemory: () => memories[state.active] || null,
        },
    };
}

test('K4: dziennik biegu suba agenta A ląduje u A, choć w trakcie przełączono na B', async t => {
    const { manager, state, events } = makeSwitchableManager();
    const model = {
        stream(_payload: unknown, callbacks: { error(error: unknown): void }) {
            // Przełączenie zakładki DOKŁADNIE w trakcie biegu suba.
            state.active = 'B';
            callbacks.error(new Error('model down'));
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { agentManager: manager },
    });

    await runner.runTask('zadanie', { name: 'A' }, { name: 'pkm-sub', tools: [] }, model, { modelTimeout: 5 });

    t.is(events.A.length, 1, 'zdarzenie biegu ma trafić do pamięci WŁAŚCICIELA (A)');
    t.deepEqual(events.B, [], 'pamięć B nie może dostać ani jednego zdarzenia z cudzego biegu');
    t.is(events.A[0].agentName, 'A');
});

test('K4: _appendMemoryEvent adresuje po nazwie właściciela, nie po getActiveMemory', async t => {
    const { manager, state, events } = makeSwitchableManager();
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null }, app: {}, plugin: { agentManager: manager },
    });
    state.active = 'B';

    await (runner as unknown as { _appendMemoryEvent(n: string, e: Record<string, unknown>): Promise<void> })
        ._appendMemoryEvent('A', { type: 'subagent_call', result: 'x' });

    t.is(events.A.length, 1);
    t.deepEqual(events.B, []);
});

test('K4: nieznany właściciel biegu = ZERO zapisu (fail-closed, nie cudza pamięć)', async t => {
    const { manager, state, events } = makeSwitchableManager();
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null }, app: {}, plugin: { agentManager: manager },
    });
    state.active = 'B';

    await (runner as unknown as { _appendMemoryEvent(n: string, e: Record<string, unknown>): Promise<void> })
        ._appendMemoryEvent('Skasowany', { type: 'subagent_call', result: 'x' });

    t.deepEqual(events.A, []);
    t.deepEqual(events.B, [], 'bieg agenta bez pamięci nie może dopisać się do aktywnego');
});

test('K4 (050): sub używa autonomii ZAMROŻONEJ przy zleceniu, nie lustra pluginu', async t => {
    const calls: Array<Record<string, unknown>> = [];
    const plugin = {
        currentAutonomy: 'all',
        mcpClient: {
            executeToolCall: async (_tc: unknown, _agent: string, opts: Record<string, unknown>) => {
                // User przełącza zakładkę w trakcie biegu — lustro leci na `yolo`.
                plugin.currentAutonomy = 'yolo';
                calls.push(opts);
                return 'OK';
            },
        },
    };
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin });

    await runner._executeTool({ name: 'read', arguments: '{}' }, 'A', new Set(['read']), { autonomy: 'edge' });
    await runner._executeTool({ name: 'read', arguments: '{}' }, 'A', new Set(['read']), { autonomy: 'edge' });

    t.is(calls[0].autonomy, 'edge');
    t.is(calls[1].autonomy, 'edge', 'drugie narzędzie tego samego biegu NIE MOŻE złapać nowego trybu');
});

test('K4 (050): runTask przenosi autonomię zlecenia do egzekutora narzędzi', async t => {
    const calls: Array<Record<string, unknown>> = [];
    const model = {
        stream(_payload: unknown, callbacks: Record<string, (arg: unknown) => void>) {
            callbacks.chunk?.({ tool_calls: [{ id: '1', function: { name: 'read', arguments: '{}' } }] });
            callbacks.done?.({ tool_calls: [{ id: '1', function: { name: 'read', arguments: '{}' } }] });
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: (name: string) => ({ name, description: '', inputSchema: {} }) },
        app: {},
        plugin: {
            currentAutonomy: 'yolo',
            mcpClient: {
                executeToolCall: async (_tc: unknown, _a: string, opts: Record<string, unknown>) => {
                    calls.push(opts);
                    return 'OK';
                },
            },
        },
    });

    await runner.runTask('zadanie', { name: 'A' }, { name: 'pkm-sub', tools: ['read'] }, model,
        { autonomy: 'edge', modelTimeout: 50 });

    t.true(calls.length > 0, 'sub w ogóle nie sięgnął po narzędzie');
    t.is(calls[0].autonomy, 'edge', 'autonomia biegu ma iść ze zlecenia, nie z plugin.currentAutonomy');
});

test('K4 (050): brak autonomii w zleceniu = stare zachowanie (lustro jako fallback)', async t => {
    const calls: Array<Record<string, unknown>> = [];
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            currentAutonomy: 'edge',
            mcpClient: {
                executeToolCall: async (_tc: unknown, _a: string, opts: Record<string, unknown>) => { calls.push(opts); return 'OK'; },
            },
        },
    });

    await runner._executeTool({ name: 'read', arguments: '{}' }, 'A', new Set(['read']));

    t.is(calls[0].autonomy, 'edge');
});

// ─── K11 (AUD-security-072): whitelista suba jedzie DALEJ, do delegacji piętro niżej ─────

test('K11 (072): _getTools przecina też whitelistę WOŁAJĄCEGO suba', t => {
    const runner = new SubAgentRunner({
        toolRegistry: {
            getTool: (name: string) => ({ name, description: '', inputSchema: {} }),
            filterByAgent: () => ['read', 'list', 'write', 'delegate'].map(name => ({ name })),
        },
        app: {},
        plugin: {},
    }) as unknown as { _getTools(names: string[], parent: unknown, caller?: string[] | null): Array<{ function: { name: string } }> };

    const bezWolajacego = runner._getTools(['read', 'list', 'write'], { name: 'Tester' });
    t.deepEqual(bezWolajacego.map(td => td.function.name), ['read', 'list', 'write']);

    const zWolajacym = runner._getTools(['read', 'list', 'write'], { name: 'Tester' }, ['read']);
    t.deepEqual(zWolajacym.map(td => td.function.name), ['read'], 'wnuk nie dostaje nic ponad rodzica-suba');
});

test('K11 (072): _executeTool podaje klientowi whitelistę suba jako callerToolNames', async t => {
    const calls: Array<Record<string, unknown>> = [];
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            mcpClient: {
                executeToolCall: async (_tc: unknown, _a: string, opts: Record<string, unknown>) => { calls.push(opts); return 'OK'; },
            },
        },
    });

    await runner._executeTool({ name: 'delegate', arguments: '{}' }, 'A', new Set(['read', 'delegate']), {
        delegationDepth: 1,
        scopeFolders: ['Publiczne'],
    });

    t.deepEqual((calls[0].callerToolNames as string[]).sort(), ['delegate', 'read']);
    t.deepEqual(calls[0].scopeFolders, ['Publiczne']);
});

// ─── AUD-wydajnosc-098: transkrypt suba nie niesie base64 obrazu ───────────────────────────
//
// `generate_image` zwraca w sukcesie pełny base64 obrazu (obok `path`/`note_path` — obraz JEST
// już zapisany w vaulcie). Czat wycina to pole przed wstawieniem wyniku do transkryptu
// (`chat_streaming.ts`), ale sub nie miał tej samej normalizacji — medianowy obraz realny
// (~594 000 znaków base64) zjadał niemal cały sufit `max_tool_result_length` transkryptu suba.

test('098: generate_image (ścieżka MCPClient) — transkrypt suba NIE niesie base64, ale niesie path/note_path', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            mcpClient: {
                executeToolCall: async () => ({
                    success: true,
                    path: 'Attachments/generated/x.png',
                    note_path: 'Attachments/generated/x.md',
                    base64: 'A'.repeat(500000),
                    format: 'png',
                    revised_prompt: null,
                    message: 'Wygenerowano obraz: Attachments/generated/x.png',
                }),
            },
        },
    });

    const out = await runner._executeTool({ name: 'generate_image', arguments: '{"prompt":"kot"}' }, 'A', new Set(['generate_image']));

    t.false(out.includes('AAAA'), 'base64 nie może przeciekać do transkryptu suba');
    t.true(out.length < 1000, `transkrypt musi być mały bez base64 (jest: ${out.length} znaków)`);
    t.true(out.includes('Attachments/generated/x.png'), 'path zostaje — model musi wiedzieć, gdzie jest obraz');
    t.true(out.includes('Attachments/generated/x.md'), 'note_path zostaje');
    t.true(out.includes('kB'), 'adnotacja rozmiaru zostaje (wzór normalizeMcpResult)');
});

test('098: generate_image (ścieżka fallback bez MCPClient) — ta sama normalizacja', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: {
            getTool: () => ({
                name: 'generate_image',
                execute: async () => ({
                    success: true,
                    path: 'Attachments/generated/y.png',
                    base64: 'B'.repeat(300000),
                }),
            }),
        },
        app: {},
        plugin: {},
    });

    const out = await runner._executeTool({ name: 'generate_image', arguments: '{}' }, 'A');

    t.false(out.includes('BBBB'));
    t.true(out.includes('Attachments/generated/y.png'));
});

test('098: inne narzędzie z polem `base64` (nie generate_image) — NIE dotknięte (skalpel, nie młot)', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            mcpClient: {
                executeToolCall: async () => ({ success: true, base64: 'zostaje', other: 1 }),
            },
        },
    });

    const out = await runner._executeTool({ name: 'read', arguments: '{}' }, 'A', new Set(['read']));

    t.true(out.includes('zostaje'), 'normalizacja jest wyłącznie dla generate_image — inne narzędzia bez zmian');
});

test('098: generate_image bez pola base64 (np. błąd) — wynik przechodzi bez zmian', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            mcpClient: {
                executeToolCall: async () => ({ success: false, error: 'Brak klucza API' }),
            },
        },
    });

    const out = await runner._executeTool({ name: 'generate_image', arguments: '{}' }, 'A', new Set(['generate_image']));

    t.true(out.includes('Brak klucza API'));
});

// ─── AUD-bledy-013: padnięte narzędzie suba przestaje wyglądać jak wynik ──────────────────
//
// Egzekutor suba z kontraktu NIE rzuca (każda ścieżka kończy się `return` stringa), a pętla
// stawia `status: 'error'` na kroku `tool.post` wyłącznie po wyjątku. Efekt: bieg, w którym
// padło każde narzędzie, wyglądał w trace.log i w pasku biegów identycznie jak bieg udany,
// a sub dostawał komunikat błędu w kształcie zwykłego wyniku.

test('AUD-bledy-013: wynik {success:false} wraca do suba jako BŁĄD, nie jako zwykły wynik', async t => {
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            mcpClient: { executeToolCall: async () => ({ success: false, error: 'Plik już istnieje' }) },
        },
    });

    const out = await runner._executeTool({ name: 'write', arguments: '{}' }, 'Klara', new Set(['write']));

    t.is(out, tr('subagent.tool_error', { name: 'write', error: JSON.stringify({ success: false, error: 'Plik już istnieje' }) }),
        `sub dostał wynik nie do odróżnienia od udanego: ${out}`);
    // Tekst dla modelu ma się ZACZYNAĆ od błędu — po polsku to dosłownie „Błąd narzędzia …".
    t.true(tr('subagent.tool_error', { name: 'write', error: 'x' }, 'pl').startsWith('Błąd'));
});

test('AUD-bledy-013: krok tool.post padniętego narzędzia niesie status error', async t => {
    const { steps, registry } = makeFakeRegistry();
    const widziane: string[][] = [];
    const runner = new SubAgentRunner({
        toolRegistry: {
            getTool: (name: string) => ({ name, description: 'atrapa', inputSchema: {}, execute: async () => 'nieużywane' }),
        },
        app: {},
        plugin: {
            subTaskRegistry: registry,
            mcpClient: { executeToolCall: async () => ({ success: false, error: 'Plik już istnieje' }) },
        },
    });

    await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: ['read'] },
        fakeMultiIterModel(2, widziane), { modelTimeout: 500 });

    const post = steps.filter(s => s.type === 'tool.post');
    t.is(post.length, 1, 'jeden krok tool.post na jedno wywołanie — bez dubli');
    t.is(post[0].fields.status, 'error', 'bieg z padniętym narzędziem wyglądał w trace jak udany');
});

// ── AUD-bledy-011: padnięty bieg suba przeżywa drogę zdarzenie → plik sesji → parser ──
//
// Runner dopisywał awarię jako `subagent_error` w kształcie, którego `parseActiveSession`
// nie umiał odczytać (pole `**role:**` niosło etykietę suba, a typ nie miał mapowania roli).
// Blok fizycznie leżał w pliku, ale KAŻDY odczyt go pomijał — więc po restarcie Obsidiana
// nie było śladu po padzie, konsolidacja karmiła się wyłącznie udanymi biegami,
// a `archiveActiveSession` (transkrypt z `parsed.messages` + kasacja oryginału) kasowała zapis.

test('AUD-bledy-011: zdarzenie padniętego biegu wraca z parsera pliku sesji', async t => {
    const events: Array<Record<string, unknown>> = [];
    const model = {
        stream(_payload: unknown, callbacks: { error(error: unknown): void }) {
            callbacks.error(new Error('model timeout po 900000 ms'));
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: {
            agentManager: {
                getAgentMemory: (name: string) => (name === 'Tester' ? {
                    appendToActiveSession: async (event: Record<string, unknown>) => { events.push(event); },
                } : null),
            },
        },
    });

    await runner.runTask(
        'zadanie',
        { name: 'Tester' },
        { name: 'pkm-sub', role: 'researcher', tools: [] },
        model,
        { modelTimeout: 5 },
    );

    t.is(events.length, 1);
    t.is(events[0].type, 'subagent_error');

    // Plik sesji składany DOKŁADNIE tak, jak robi to `appendToActiveSession`.
    const file = [
        '---', 'type: active_session', 'agent: Tester', '---', '',
        '# Tester session', '',
        formatSessionEvent(String(events[0].type), { ...events[0], seq: 1 }, '2026-08-23T10:00:00.000Z'),
    ].join('\n');
    const parsed = parseActiveSession(file);

    t.is(parsed.messages.length, 1, 'padnięty bieg NIE MOŻE zniknąć z odtworzonej sesji');
    t.is(parsed.messages[0].role, 'assistant', 'etykieta roli suba nie może podmienić roli wiadomości');
    t.true(parsed.messages[0].content.includes('model timeout po 900000 ms'), 'powód padu zachowany');
});

// ─── Fabryka napraw F3 (2026-09-02), audyt testów 2026-09-01 ──────────────────────────────
//
// Cztery znaleziska o WSPÓLNYM kształcie: `runTask` okablowuje `config/limits.ts` do
// `loopLimits` przekazywanego `runAgentLoop` (linie 210-230), a żaden test nie sprawdzał, że
// ten PRZELOT realnie działa — istniejące testy mierzyły albo TEKST promptu (osobna
// kalkulacja w `_buildTaskPrompt`), albo tylko drogę DOMYŚLNĄ. Testy niżej mierzą SKUTEK:
// co pętla faktycznie dostaje i jak się przez to zachowuje — nie sam fakt przekazania argumentu.

// AUD-testy-018: `stoppedBy` z pętli MUSI dotrzeć do ZWROTKI `runTask` (linia 375) — osobnej
// linii od tej, która karmi `registry.finish` (linia 362). Mutacja „na sztywno 'natural'"
// na linii 375 nie rusza żadnego z trzech testów pinujących wyłącznie drogę natural/error.

test('AUD-testy-018: backstop — stoppedBy dociera do zwrotki runTask (mutacja "na sztywno natural" ma tu palić)', async t => {
    const model = fakeStubbornToolModel('read');
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: (name: string) => ({ name, description: 'atrapa', inputSchema: {}, execute: async () => 'wynik' }) },
        app: {},
        plugin: {},
    });

    const result = await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'worker', tools: ['read'], max_iterations: 1 },
        model, { modelTimeout: 500 },
    ) as { result: string; stoppedBy?: string; failed?: true };

    t.is(result.stoppedBy, 'backstop', 'zwrotka runTask musi nieść TĘ wartość, nie hardcode "natural"');
    t.is(result.failed, undefined, 'backstop nie jest niepowodzeniem — nie może dostać flagi failed');
});

test('AUD-testy-018: abort — stoppedBy dociera do zwrotki runTask ORAZ do karty biegu jako aborted', async t => {
    const registry = new SubTaskRegistry();
    let task: { status?: string } | undefined;
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { subTaskRegistry: registry },
    });

    const result = await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] },
        fakeDoneModel(),
        { modelTimeout: 5, shouldAbort: () => true, onTaskCreated: (created: { status?: string }) => { task = created; } },
    ) as { result: string; stoppedBy?: string };

    t.is(result.stoppedBy, 'abort', 'zwrotka runTask musi nieść "abort", nie hardcode "natural"');
    t.is(task?.status, 'aborted', 'karta biegu w rejestrze musi zejść jako aborted, nie running/done');
    registry.dispose();
});

// AUD-testy-019 (kanon; duplikat AUD-testy-002): `subagent_stall_timeout_ms` i
// `subagent_salvage_max_chars` z ustawień muszą dotrzeć do `loopLimits` (linie 217-218) —
// obalacz wyzerował oba na sztywno i 2465 testów + 34/34 scenariuszy harnessa zostały zielone.

test('AUD-testy-019: subagent_stall_timeout_ms z ustawień budzi pętlę z ciszy (nie czeka do delegation_timeout_ms)', async t => {
    const silentModel = {
        stream(_payload: unknown, _callbacks: Record<string, unknown>) {
            // Zero chunków, zero done/error — bez przelotu limitu z ustawień do pętli ten
            // bieg wisiałby do awaryjnego zegara ściennego delegation_timeout_ms
            // (900000 ms domyślnie — patrz config/limits.ts).
        },
    };
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { env: { settings: { pkmAssistant: { limits: { subagent_stall_timeout_ms: 40 } } } } },
    });
    const start = Date.now();

    const result = await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, silentModel, {},
    ) as { result: string; stoppedBy?: string; failed?: true };

    t.true(Date.now() - start < 3000,
        'subagent_stall_timeout_ms z ustawień musi realnie budzić pętlę — bieg NIE może czekać do delegation_timeout_ms (900000 ms)');
    t.true(result.failed);
    t.is(result.stoppedBy, 'error');
    t.true(result.result.includes(tr('agentLoop.model_stall', { seconds: Math.round(40 / 1000) })),
        'komunikat musi pochodzić z watchdogu ciszy pętli, nie z innego źródła błędu');
});

test('AUD-testy-019: subagent_salvage_max_chars z ustawień trafia do zaślepki backstopu (dorobek, nie goła zaślepka)', async t => {
    const dorobek = 'TAJNY_DOROBEK_XYZ_' + 'x'.repeat(200);
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: (name: string) => ({ name, description: 'atrapa', inputSchema: {}, execute: async () => dorobek }) },
        app: {},
        plugin: {},
    });

    const result = await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'worker', tools: ['read'], max_iterations: 1 },
        fakeToolThenFailingBackstopModel('read'), { modelTimeout: 500 },
    ) as { result: string; stoppedBy?: string };

    t.is(result.stoppedBy, 'backstop', 'finalna synteza padła — bieg schodzi jako backstop, nie error');
    t.true(result.result.includes(dorobek),
        'subagent_salvage_max_chars musi dotrzeć do pętli — bez przelotu zaślepka jest GOŁA (bez dorobku narzędzi)');
});

// AUD-testy-020: `options.modelTimeout` musi dotrzeć do `perCallTimeoutMs` (linia 213) — test
// SKUTKU (bieg realnie kończy się szybko), nie samego przekazania argumentu tak jak robi to
// `DelegateTool.test.ts` z atrapą runnera, która nigdy nie woła prawdziwego SubAgentRunnera.

test('AUD-testy-020: options.modelTimeout dociera do perCallTimeoutMs pętli (skutek, nie tylko argument)', async t => {
    const hangingModel = {
        stream(_payload: unknown, _callbacks: Record<string, unknown>) {
            // Model nigdy nie rozstrzyga promisy — jedyne, co może skończyć ten bieg, to
            // per-call timeout pętli. Bez przelotu options.modelTimeout do perCallTimeoutMs
            // ten bieg wisiałby do delegation_timeout_ms (900000 ms domyślnie).
        },
    };
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });
    const start = Date.now();

    const result = await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [] }, hangingModel, { modelTimeout: 40 },
    ) as { result: string; stoppedBy?: string; failed?: true };

    t.true(Date.now() - start < 3000,
        'options.modelTimeout musi realnie ograniczyć wywołanie modelu — bieg NIE może czekać do delegation_timeout_ms (900000 ms)');
    t.true(result.failed, 'per-call timeout kończy bieg jako niepowodzenie');
    t.is(result.stoppedBy, 'error');
    t.true(result.result.includes(tr('agentLoop.model_timeout', { seconds: Math.round(40 / 1000) })),
        'komunikat musi pochodzić z per-call timeoutu pętli, nie z innego źródła błędu');
});

// AUD-testy-055 (kanon; duplikat AUD-testy-041): config.max_iterations/min_iterations custom
// suba muszą wygrać nad globalnym defaultem — WIDOCZNIE w budżecie taska ORAZ REALNIE w
// liczbie kroków pętli (nie tylko w tekście promptu — test „F4: blok BUDŻET…" wyżej liczy TĘ
// SAMĄ wartość osobną kalkulacją w `_buildTaskPrompt`, więc nie łapie rozjazdu w `runTask`).

/**
 * Model, który ZAWSZE prosi o narzędzie, dopóki dostaje `tools` w payloadzie (nigdy nie
 * kończy się naturalnie) — na finalnym strzale backstopu (payload BEZ `tools`, patrz
 * `_buildPayload(apiMessages, null)` w AgentLoop.ts) odpowiada zwykłym tekstem. Jedyny sposób,
 * żeby taki bieg się skończył, to backstop po dokładnie skonfigurowanej liczbie iteracji.
 */
function fakeStubbornToolModel(nazwaNarzedzia: string) {
    const calls: Array<{ tools?: unknown[] }> = [];
    return {
        calls,
        stream(payload: { tools?: unknown[] }, callbacks: { done(resp: unknown): void }) {
            calls.push(payload);
            const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
            if (!hasTools) {
                callbacks.done({ choices: [{ message: { role: 'assistant', content: 'BACKSTOP_TEXT' } }] });
                return;
            }
            callbacks.done({
                choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                    { id: `c${calls.length}`, type: 'function', function: { name: nazwaNarzedzia, arguments: '{}' } },
                ] } }],
            });
        },
    };
}

/**
 * Model: 1. woła narzędzie (żeby był dorobek do ratowania), 2. na finalnym strzale backstopu
 * (payload BEZ `tools`) PADA błędem — wymusza ścieżkę `_fallbackWithSalvage` zamiast zwykłej
 * udanej syntezy.
 */
function fakeToolThenFailingBackstopModel(nazwaNarzedzia: string) {
    let i = 0;
    return {
        stream(payload: { tools?: unknown[] }, callbacks: { done(resp: unknown): void; error(err: unknown): void }) {
            i++;
            const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
            if (!hasTools) {
                callbacks.error(new Error('synteza finalna padła'));
                return;
            }
            callbacks.done({
                choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                    { id: `c${i}`, type: 'function', function: { name: nazwaNarzedzia, arguments: '{}' } },
                ] } }],
            });
        },
    };
}

test('AUD-testy-055: config.max_iterations custom suba widoczny w budżecie taska (nie tylko default)', async t => {
    const { created, registry } = makeFakeRegistry();
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => null },
        app: {},
        plugin: { subTaskRegistry: registry },
    });

    await runner.runTask('zadanie', { name: 'Tester' }, { name: 'pkm-sub', tools: [], max_iterations: 3 },
        fakeDoneModel(), { modelTimeout: 5 });

    t.is(created[0].budget.maxIterations, 3, 'config.max_iterations musi wygrać nad globalnym defaultem w budżecie taska');
    t.not(created[0].budget.maxIterations, DEFAULT_LIMITS.subagent_max_iterations_worker,
        'fixture zły, jeśli override akurat równa się defaultowi');
});

test('AUD-testy-055: config.max_iterations REALNIE ogranicza pętlę, nie tylko widoczny w budżecie/prompcie', async t => {
    const model = fakeStubbornToolModel('read');
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: (name: string) => ({ name, description: 'atrapa', inputSchema: {}, execute: async () => 'wynik' }) },
        app: {},
        plugin: {},
    });

    const result = await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'worker', tools: ['read'], max_iterations: 2 },
        model, { modelTimeout: 500 },
    ) as { result: string; stoppedBy?: string };

    t.is(model.calls.length, 3, 'override max_iterations=2 → 2 wywołania z narzędziami + 1 backstop bez narzędzi');
    t.is(result.stoppedBy, 'backstop', 'pętla musi stanąć backstopem po dokładnie skonfigurowanej liczbie iteracji');
});

test('AUD-testy-055: config.min_iterations custom suba REALNIE wymusza kontynuację (nie tylko default=1)', async t => {
    let calls = 0;
    const model = {
        stream(_payload: unknown, callbacks: { done(resp: unknown): void }) {
            calls++;
            callbacks.done({ choices: [{ message: { role: 'assistant', content: 'gotowe' } }] });
        },
    };
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: {} });

    const result = await runner.runTask(
        'zadanie', { name: 'Tester' }, { name: 'worker', tools: [], min_iterations: 2 },
        model, { modelTimeout: 500 },
    ) as { result: string; stoppedBy?: string };

    t.is(calls, 2, 'z min_iterations=2 model MUSI zostać zawołany dwa razy — default=1 kończyłby po pierwszym');
    t.is(result.stoppedBy, 'natural');
});
