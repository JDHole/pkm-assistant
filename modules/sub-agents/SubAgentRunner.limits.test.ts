/**
 * SubAgentRunner.limits — KONTRAKT sufitu wyniku narzędzia w pętli SUB-agenta.
 *
 * PO CO: wynik suba jest DELIVERABLE i dostaje własny sufit `subagent_result_max_chars`
 * (60k) zamiast wspólnego `max_tool_result_length` (15k) — dokładnie jak powiadomienie
 * z tła + okablowanie per-tool w turze czatu (`chat_streaming`) traktuje wynik agenta
 * głównego. Ten plik pilnuje, że `SubAgentRunner` buduje `loopLimits` Z mapą per-tool
 * (`maxToolResultLengthPerTool`) — bez niej wynik zagnieżdżonej delegacji (sub deleguje
 * głębiej, `max_delegation_depth` > 1) wracałby do suba przycięty wspólnym sufitem 15k.
 *
 * Kontrakt:
 * (a) `loopLimits` ma mapę per-tool (`maxToolResultLengthPerTool`),
 * (b) `delegate` i `agent_delegate` dostają `subagent_result_max_chars` (60k) — chyba że sub
 *     ma WŁASNY `max_tool_result_length` większy niż to, wtedy wygrywa
 *     większy z dwóch — mapa nie ma prawa NIKOMU obniżyć sufitu,
 * (c) zero po KTÓREJKOLWIEK stronie (`subagent_result_max_chars` globalnie, ALBO
 *     `config.max_tool_result_length` tego suba — SubAgentEditorModal zapisuje 0 za puste
 *     pole) to świadome „bez limitu" i zostaje zerem — nie zamienia się w drugą wartość przez
 *     nieostrożny `Math.max`,
 * (d) każde inne narzędzie nadal idzie pod wspólny `max_tool_result_length` (15k).
 *
 * Wzorzec identyczny z `chat_streaming.ts` (per-tool override dla tych samych dwóch nazw,
 * z tego samego źródła configu — `getLimits().subagent_result_max_chars`), z JEDNĄ różnicą:
 * czat nie ma per-agent override, sub ma — stąd `_deliverableResultCap` zamiast przelotu wprost.
 */
import test from 'ava';
import { SubAgentRunner as RuntimeSubAgentRunner } from './SubAgentRunner.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
import { MCPClient } from '../tools/index.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { t as tr } from '../../core/i18n/index.js';

type TestRunner = { runTask(...args: unknown[]): Promise<{ result: string }> };
const SubAgentRunner = RuntimeSubAgentRunner as unknown as new (options: unknown) => TestRunner;

type Payload = { messages?: Array<{ role: string; content?: unknown }> };
type Handlers = { chunk?: (r: unknown) => void; done: (r: unknown) => void; error?: (e: unknown) => void };

const tekstowa = (tresc: string) => ({ choices: [{ message: { role: 'assistant', content: tresc } }] });
const zWywolaniem = (nazwa: string) => ({
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', function: { name: nazwa, arguments: '{"task":"zbierz wszystko"}' } },
    ] } }],
});

/** Model odgrywający: 1. tura woła narzędzie `nazwa`, 2. kończy tekstem. Zapisuje payloady. */
function makeModel(nazwa: string) {
    let idx = 0;
    return {
        calls: [] as Payload[],
        stream(payload: Payload, handlers: Handlers) {
            this.calls.push(payload);
            const resp = idx++ === 0 ? zWywolaniem(nazwa) : tekstowa('gotowe');
            Promise.resolve().then(() => handlers.done(resp));
        },
    };
}

/** Rejestr z jednym narzędziem o podanej nazwie, którego wynik jest podanym tekstem. */
function makeRegistry(nazwa: string, wynik: string) {
    const tool = {
        name: nazwa,
        description: 'narzędzie testowe',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => wynik,
    };
    return { getTool: (n: string) => (n === nazwa ? tool : null) };
}

/** Treść wiadomości roli `tool` z payloadu ostatniego wywołania modelu. */
function wynikNarzedziaZTranskryptu(model: { calls: Payload[] }): string {
    const ostatni = model.calls[model.calls.length - 1];
    const toolMsg = (ostatni?.messages || []).filter((m) => m.role === 'tool').pop();
    return typeof toolMsg?.content === 'string' ? toolMsg.content : '';
}

/**
 * Odpala suba z JEDNYM narzędziem `nazwa`, którego wynik jest `dorobek`; zwraca model (do
 * asercji na `calls`) i to, co dotarło do transkryptu.
 *
 * `opts.configExtra` — dokłada pola do configu suba (np. WŁASNY `max_tool_result_length`,
 * per-sub override z SubAgentEditorModal). `opts.pluginExtra` — nadpisuje `plugin`, żeby
 * dowieźć `settings.pkmAssistant.limits.*` (np. `subagent_result_max_chars: 0`) przez ten sam
 * `getLimits(this.plugin?.env?.settings)`, którego używa runner.
 */
async function uruchomZNarzedziem(
    nazwa: string,
    dorobek: string,
    opts: { configExtra?: Record<string, unknown>; pluginExtra?: Record<string, unknown> } = {},
) {
    const model = makeModel(nazwa);
    const runner = new SubAgentRunner({
        toolRegistry: makeRegistry(nazwa, dorobek),
        app: {},
        plugin: opts.pluginExtra ?? {},
    });
    await runner.runTask(
        'Zleć głębiej i oddaj wynik.',
        { name: 'Jaskier' },
        { name: 'worker', role: 'worker', tools: [nazwa], max_iterations: 3, ...opts.configExtra },
        model,
        { modelTimeout: 5000 },
    );
    return { model, wTranskrypcie: wynikNarzedziaZTranskryptu(model) };
}

for (const nazwa of ['delegate', 'agent_delegate']) {
    test(`kontrakt: wynik \`${nazwa}\` w pętli suba PRZEŻYWA rozmiar, który wspólny sufit by uciął`, async t => {
        const wspolnySufit = DEFAULT_LIMITS.max_tool_result_length;
        const deliverableSufit = DEFAULT_LIMITS.subagent_result_max_chars;
        // Dłuższy niż wspólny sufit (15k), krótszy niż sufit deliverable (60k) — rozróżnia,
        // który z dwóch zadziałał.
        const dorobek = 'D'.repeat(wspolnySufit + 5000);
        t.true(dorobek.length < deliverableSufit, 'Fixture zły: dorobek ma się mieścić pod sufitem deliverable.');

        const { model, wTranskrypcie } = await uruchomZNarzedziem(nazwa, dorobek);

        t.is(model.calls.length, 2, 'Model miał zostać zawołany dwa razy: wywołanie narzędzia i domknięcie.');
        t.is(
            wTranskrypcie,
            dorobek,
            `Wynik \`${nazwa}\` został przycięty mimo że mieści się pod sufitem deliverable (${deliverableSufit}) — mapa maxToolResultLengthPerTool nie działa dla tego narzędzia.`,
        );
    });

    test(`kontrakt: sufit \`${nazwa}\` w pętli suba to DOKŁADNIE subagent_result_max_chars, nie coś inne`, async t => {
        const deliverableSufit = DEFAULT_LIMITS.subagent_result_max_chars;
        // Dłuższy niż sam sufit deliverable — MUSI zostać przycięty; inaczej test nie odróżnia
        // „sufit = subagent_result_max_chars" od „brak sufitu".
        const dorobek = 'D'.repeat(deliverableSufit + 5000);

        const { wTranskrypcie } = await uruchomZNarzedziem(nazwa, dorobek);

        t.true(
            wTranskrypcie.startsWith('D'.repeat(deliverableSufit)),
            `Początek dorobku do sufitu deliverable (${deliverableSufit} znaków) powinien przetrwać w całości.`,
        );
        t.false(
            wTranskrypcie.includes('D'.repeat(deliverableSufit + 1)),
            `Wynik \`${nazwa}\` przekracza sufit deliverable (${deliverableSufit}) — mapa per-tool wskazuje zły klucz configu albo w ogóle nie przycina.`,
        );
    });
}

test('kontrakt: narzędzie SPOZA mapy per-tool (np. `search`) nadal idzie pod wspólny sufit max_tool_result_length', async t => {
    const wspolnySufit = DEFAULT_LIMITS.max_tool_result_length;
    const deliverableSufit = DEFAULT_LIMITS.subagent_result_max_chars;
    // Dłuższy niż wspólny sufit, ale krótszy niż sufit deliverable — gdyby mapa per-tool
    // objęła to narzędzie przez pomyłkę (np. zbyt szeroki klucz), wynik przeszedłby CAŁY.
    const dorobek = 'D'.repeat(wspolnySufit + 5000);
    t.true(dorobek.length < deliverableSufit, 'Fixture zły: dorobek ma być krótszy niż sufit deliverable, inaczej test niczego nie odróżnia.');

    const { model, wTranskrypcie } = await uruchomZNarzedziem('search', dorobek);

    t.is(model.calls.length, 2, 'Model miał zostać zawołany dwa razy: wywołanie narzędzia i domknięcie.');
    t.true(
        wTranskrypcie.startsWith('D'.repeat(wspolnySufit)),
        'Początek dorobku do wspólnego sufitu powinien przetrwać w całości.',
    );
    t.false(
        wTranskrypcie.includes('D'.repeat(wspolnySufit + 1)),
        `Wynik narzędzia spoza mapy per-tool przekracza wspólny sufit (${wspolnySufit}) — mapa per-tool zeszła piętro niżej i objęła narzędzia, których nie powinna.`,
    );
});

test('kontrakt: sub z WŁASNYM max_tool_result_length większym niż deliverable — delegate NIE cięty do 60k', async t => {
    const deliverableDefault = DEFAULT_LIMITS.subagent_result_max_chars;
    const subCommonCap = deliverableDefault + 40000; // override w SUB_AGENT.yaml, > deliverable default
    t.true(subCommonCap > deliverableDefault, 'Fixture zły: cały sens testu to override suba WIĘKSZY niż deliverable default.');

    // Między deliverable default (60k) a override suba (100k) — gdyby mapa nadal hardcodowała
    // subagent_result_max_chars zamiast Math.max z sufitem suba, ten payload zostałby ucięty
    // na 60k MIMO że sub ma jawnie ustawiony większy sufit ogólny.
    const dorobek = 'D'.repeat(subCommonCap - 5000);

    const { wTranskrypcie } = await uruchomZNarzedziem('delegate', dorobek, {
        configExtra: { max_tool_result_length: subCommonCap },
    });

    t.is(
        wTranskrypcie,
        dorobek,
        `Wynik \`delegate\` został przycięty mimo że mieści się pod WŁASNYM sufitem suba (${subCommonCap}) — mapa obniżyła sufit configu suba zamiast go tylko podnosić do deliverable.`,
    );
});

test('kontrakt: subagent_result_max_chars=0 („bez limitu") — delegate bez cięcia, nie 60k', async t => {
    // Payload wyraźnie większy niż jakikolwiek default w tym pliku — ma przetrwać W CAŁOŚCI,
    // bo administrator globalnie wyłączył sufit deliverable (0 = bez limitu, config/limits.ts).
    const dorobek = 'D'.repeat(DEFAULT_LIMITS.subagent_result_max_chars * 3);

    const { wTranskrypcie } = await uruchomZNarzedziem('delegate', dorobek, {
        pluginExtra: { env: { settings: { pkmAssistant: { limits: { subagent_result_max_chars: 0 } } } } },
    });

    t.is(
        wTranskrypcie,
        dorobek,
        'subagent_result_max_chars=0 to świadome „bez limitu" — zwykły Math.max(commonCap, 0) by je zepsuł (0 przegrywa z każdą dodatnią liczbą i zamieniłby się w commonCap); delegate nie powinien być cięty wcale.',
    );
});

test('kontrakt: sub z WŁASNYM max_tool_result_length=0 („bez limitu") — delegate bez cięcia, nie 60k', async t => {
    // SubAgentEditorModal zapisuje 0 za puste pole, a `config.max_tool_result_length ?? ...`
    // NIE łapie 0 (tylko null/undefined) — więc sufit ogólny TEGO suba realnie wynosi 0
    // („bez limitu" dla wszystkich jego narzędzi). Payload wyraźnie większy niż deliverable
    // default ma przetrwać W CAŁOŚCI — inaczej delegate dostałby sufit 60k mimo że reszta
    // narzędzi suba jest jawnie bez limitu (dokładnie ta sama klasa błędu co test (b) wyżej,
    // tylko po DRUGIEJ stronie Math.max).
    const dorobek = 'D'.repeat(DEFAULT_LIMITS.subagent_result_max_chars * 3);

    const { wTranskrypcie } = await uruchomZNarzedziem('delegate', dorobek, {
        configExtra: { max_tool_result_length: 0 },
    });

    t.is(
        wTranskrypcie,
        dorobek,
        'max_tool_result_length=0 w configu suba to świadome „bez limitu" — Math.max(0, 60000) by je zepsuł (0 przegrywa z deliverable default), więc delegate dostałby sufit 60k mimo że sub go jawnie wyłączył.',
    );
});

test('sub-agent forwards trusted context through the real MCPClient and keeps bounded JSON errors intact', async t => {
    const agent = { name: 'Jaskier', permissions: { guidance_mode: true, read_notes: true, mcp: true } };
    let received: unknown;
    const readTool = {
        name: 'read', description: 'read', source: 'built-in', inputSchema: { type: 'object' },
        execute: async (_args: unknown, _app: unknown, _plugin: unknown, context: unknown) => {
            received = context;
            return { success: false, code: 'file_changed', restart_offset: 0 };
        },
    };
    const mcpRegistry = {
        getTool: (name: string) => name === 'read' ? readTool : null,
        getToolDefinitions: () => [],
    };
    const mcpPlugin = {
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
    };
    const mcp = new MCPClient({} as never, mcpPlugin as never, mcpRegistry as never);
    const plugin = { ...mcpPlugin, mcpClient: mcp };
    const runner = new SubAgentRunner({
        toolRegistry: { filterByAgent: () => [readTool], getTool: (name: string) => name === 'read' ? readTool : null },
        app: {},
        plugin,
    });
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload, handlers: Handlers) {
            this.calls.push(payload);
            const result = this.calls.length === 1
                ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
                    { id: 'r1', function: { name: 'read', arguments: JSON.stringify({ path: 'Notes/a.md', resultBudgetChars: 1, _invocationAgentName: 'Other' }) } },
                ] } }] }
                : tekstowa('gotowe');
            Promise.resolve().then(() => handlers.done(result));
        },
    };
    const shouldAbort = () => false;

    await runner.runTask('Przeczytaj plik.', { name: 'Jaskier' }, {
        name: 'worker', role: 'worker', tools: ['read'], max_iterations: 3, max_tool_result_length: 600,
    }, model as never, { modelTimeout: 5000, shouldAbort });

    t.is((received as { resultBudgetChars: number }).resultBudgetChars, 600);
    t.is((received as { shouldAbort: () => boolean }).shouldAbort, shouldAbort);
    const transcript = wynikNarzedziaZTranskryptu(model);
    t.deepEqual(JSON.parse(transcript), { success: false, code: 'file_changed', restart_offset: 0, isError: true });
    t.false(transcript.startsWith('Błąd narzędzia'));
});

test('real sub-agent transcript preserves text-search abort state under the runtime cap', async t => {
    const { createSearchTool } = await import('../tools/SearchTool.js');
    let reads = 0;
    const app = { vault: { adapter: {
        list: async (folder: string) => ({ files: [`${folder}/a.js`, `${folder}/b.js`], folders: [] }),
        stat: async () => ({ size: 6 }),
        read: async () => { reads++; return 'needle'; },
    } } };
    const agent = { name: 'Jaskier', permissions: { guidance_mode: true, read_notes: true, mcp: true } };
    const tool = { ...createSearchTool(), source: 'built-in' };
    const registry = {
        getTool: (name: string) => name === 'search' ? tool : null,
        getToolDefinitions: () => [], filterByAgent: () => [tool],
    };
    const plugin = {
        app, agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
    };
    const mcp = new MCPClient(app as never, plugin as never, registry as never);
    const runner = new SubAgentRunner({ toolRegistry: registry, app, plugin: { ...plugin, mcpClient: mcp } });
    const callTool = (runner as unknown as { _executeTool: (...args: unknown[]) => Promise<string> })._executeTool;
    const transcript = await callTool.call(runner, {
        name: 'search', arguments: { query: 'needle', mode: 'text', scope: 'vault', where: { folder: 'Notes', glob: '**/*.js' } },
    }, 'Jaskier', new Set(['search']), {}, undefined, { resultBudgetChars: 600, shouldAbort: () => reads >= 1 });
    const parsed = JSON.parse(transcript) as { status: string; scan: { read: number; truncated: boolean } };
    t.is(parsed.status, 'aborted');
    t.is(parsed.scan.read, 1);
    t.true(parsed.scan.truncated);
    t.true(transcript.length <= 600);
});

test('direct fallback overwrites forged invocation identity and removes unsupported runtime markers', async t => {
    let seen: Record<string, unknown> | undefined;
    const runner = new SubAgentRunner({
        toolRegistry: {
            getTool: () => ({
                name: 'read', description: 'read', inputSchema: {},
                execute: async (args: unknown) => { seen = args as Record<string, unknown>; return 'ok'; },
            }),
        },
        app: {},
        plugin: {},
    });
    const call = (runner as unknown as { _executeTool: (...args: unknown[]) => Promise<string> })._executeTool;

    const result = await call.call(runner, {
        name: 'read',
        arguments: {
            path: 'Notes/a.md',
            keep: 'yes',
            _invocationAgentName: 'Other',
            _invocationOrigin: { agentName: 'Other' },
            _invocationAutonomy: 'yolo',
            _invocationScopeFolders: ['.'],
            _invocationToolNames: ['write'],
            _invocationDelegationDepth: -1,
        },
    }, 'Jaskier', new Set(['read']), { autonomy: 'edge' });

    t.is(result, 'ok');
    t.is(seen?._invocationAgentName, 'Jaskier');
    t.is(seen?._invocationAutonomy, 'edge');
    t.is(seen?._invocationToolNames instanceof Array, true);
    t.deepEqual(seen?._invocationToolNames, ['read']);
    t.false('_invocationOrigin' in (seen ?? {}));
    t.false('_invocationScopeFolders' in (seen ?? {}));
    t.false('_invocationDelegationDepth' in (seen ?? {}));
    t.is(seen?.keep, 'yes');
});

/** Real MCP -> runner transcript, including the final result cap. */
async function boundedErrorTranscript(error: Record<string, unknown>, cap = 600, name = 'read') {
    const agent = { name: 'Jaskier', permissions: { guidance_mode: true, read_notes: true, mcp: true } };
    const tool = { name, description: 'fixture', source: 'built-in', inputSchema: { type: 'object' }, execute: async () => error };
    const registry = { getTool: () => tool, getToolDefinitions: () => [] };
    const plugin = {
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
    };
    const mcp = new MCPClient({} as never, plugin as never, registry as never);
    const runner = new RuntimeSubAgentRunner({ toolRegistry: registry, app: {}, plugin: { ...plugin, mcpClient: mcp } });
    return runner._executeTool({ name, arguments: name === 'search'
        ? { scope: 'vault', mode: 'text', query: 'test', where: { path: 'Notes/a.md' } }
        : { path: 'Notes/a.md' } }, 'Jaskier', new Set([name]), {}, undefined,
    { resultBudgetChars: cap, shouldAbort: () => false });
}

for (const name of ['read', 'search']) {
    test(`${name} bounded errors mask secrets and preserve JSON`, async t => {
        const text = await boundedErrorTranscript({ success: false, code: 'file_missing', error: 'Authorization: Bearer SECRETVALUE123456' }, 600, name);
        const result = JSON.parse(text) as Record<string, unknown>;
        t.is(result.code, 'file_missing');
        t.is(result.isError, true);
        t.false(text.includes('SECRETVALUE123456'));
        t.true(text.includes('***'));
        t.true(text.length <= 600);
    });
}

test('read redaction that breaks an escape returns safe code and restart metadata', async t => {
    const text = await boundedErrorTranscript({ success: false, code: 'file_changed', restart_offset: 0, error: 'Authorization: Bearer AAA\\BBBB' });
    t.deepEqual(JSON.parse(text), { success: false, code: 'file_changed', restart_offset: 0, isError: true });
});

for (const cap of [1, 46, 600, 0]) {
    test(`bounded error redaction respects runtime cap ${cap}`, async t => {
        const text = await boundedErrorTranscript({ success: false, code: 'file_missing', error: 'Authorization: Bearer SECRETVALUE123456' }, cap);
        t.true(text.length <= (cap || 12000));
        if (cap < 58 && cap > 0) t.is(text, 'B');
        else {
            const result = JSON.parse(text) as Record<string, unknown>;
            t.is(result.code, 'file_missing');
            t.false(text.includes('SECRETVALUE123456'));
        }
    });
}

test('unrelated tool errors retain legacy masked transcript handling', async t => {
    const text = await boundedErrorTranscript({ success: false, code: 'file_missing', error: 'Authorization: Bearer SECRETVALUE123456' }, 600, 'legacy_fixture');
    t.false(text.startsWith('{'));
    t.false(text.includes('SECRETVALUE123456'));
    t.true(text.includes('***'));
});

test('runTask clamps YAML iteration and result ceilings consistently in loop and prompt', async t => {
    const registry = new SubTaskRegistry();
    let calls = 0;
    let prompt = '';
    const tool = { name: 'read', description: 'read', inputSchema: {}, execute: async () => 'x' };
    const model = { stream(payload: Payload, handlers: Handlers) {
        calls++;
        prompt = String(payload.messages?.[0]?.content ?? prompt);
        handlers.done(zWywolaniem('read'));
    } };
    const runner = new SubAgentRunner({ toolRegistry: { filterByAgent: () => [tool], getTool: (name: string) => name === 'read' ? tool : null }, app: {}, plugin: { subTaskRegistry: registry } });
    await runner.runTask('task', { name: 'Owner' }, { name: 'worker', tools: ['read'], max_iterations: 500, max_tool_result_length: 999999 } as never, model, { modelTimeout: 10000 } as never);
    t.is(calls, 101);
    t.is(registry.list()[0].budget.maxIterations, 100);
    t.is(registry.list()[0].budget.maxToolResultLength, 200000);
    t.true(prompt.includes(tr('subagent.frame.budget_iterations', { count: 100 })));
    t.true(prompt.includes(tr('subagent.frame.budget_tool_result', { value: tr('subagent.frame.budget_chars', { count: 200000 }) })));
    registry.dispose();
});

test('runTask keeps zero tool-result length and defaults zero or missing iterations and fields', async t => {
    const registry = new SubTaskRegistry();
    const prompts: string[] = [];
    const model = { stream(payload: Payload, handlers: Handlers) {
        prompts.push(String(payload.messages?.[0]?.content ?? ''));
        handlers.done(tekstowa('done'));
    } };
    const runner = new SubAgentRunner({ toolRegistry: { filterByAgent: () => [], getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry } });
    await runner.runTask('zero', { name: 'Owner' }, { name: 'worker', tools: [], max_iterations: 0, max_tool_result_length: 0 } as never, model, { modelTimeout: 10000 } as never);
    t.is(registry.list()[0].budget.maxIterations, 25);
    t.is(registry.list()[0].budget.maxToolResultLength, 0);
    t.true(prompts[0].includes(tr('subagent.frame.budget_iterations', { count: 25 })));
    t.true(prompts[0].includes(tr('subagent.frame.budget_tool_result', { value: tr('subagent.frame.budget_unlimited') })));
    await runner.runTask('missing', { name: 'Owner' }, { name: 'worker', tools: [] } as never, model, { modelTimeout: 10000 } as never);
    t.is(registry.list()[1].budget.maxIterations, 25);
    t.is(registry.list()[1].budget.maxToolResultLength, 15000);
    t.true(prompts[1].includes(tr('subagent.frame.budget_iterations', { count: 25 })));
    t.true(prompts[1].includes(tr('subagent.frame.budget_tool_result', { value: tr('subagent.frame.budget_chars', { count: 15000 }) })));
    registry.dispose();
});

test('runTask preserves in-range YAML limits', async t => {
    const registry = new SubTaskRegistry();
    let prompt = '';
    const model = { stream(payload: Payload, handlers: Handlers) { prompt = String(payload.messages?.[0]?.content ?? ''); handlers.done(tekstowa('done')); } };
    const runner = new SubAgentRunner({ toolRegistry: { filterByAgent: () => [], getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry } });
    await runner.runTask('task', { name: 'Owner' }, { name: 'worker', tools: [], max_iterations: 7, max_tool_result_length: 23000 } as never, model, { modelTimeout: 10000 } as never);
    t.is(registry.list()[0].budget.maxIterations, 7);
    t.is(registry.list()[0].budget.maxToolResultLength, 23000);
    t.true(prompt.includes(tr('subagent.frame.budget_iterations', { count: 7 })));
    t.true(prompt.includes(tr('subagent.frame.budget_tool_result', { value: tr('subagent.frame.budget_chars', { count: 23000 }) })));
    registry.dispose();
});
