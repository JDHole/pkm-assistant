import test from 'ava';
import { ExternalMcpManager, normalizeMcpResult } from './ExternalMcpManager.js';
import type { ExternalMcpPluginLike, McpCallToolResult, McpClientLike } from './ExternalMcpManager.js';
import { ToolRegistry } from './ToolRegistry.js';
import { t as tr } from '../../core/i18n/index.js';

/** Czym sterujemy atrapę klienta w konkretnym teście. */
interface FakeClientOverrides {
    connectThrows?: string;
    callToolThrows?: string;
    tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
    callToolResult?: McpCallToolResult;
}

/** Rejestr wywołań atrapy — testy asertują na nim nazwy, argumenty i timeouty. */
interface FakeClientCalls {
    connect: Array<{ transport: unknown; opts?: { timeout?: number } }>;
    listTools: Array<{ params: unknown; opts?: { timeout?: number } }>;
    callTool: Array<{ params: { name: string; arguments?: unknown }; schema: unknown; opts?: { timeout?: number } }>;
    close: number;
}

// Fake klient MCP zgodny z kontraktem SDK (connect/listTools/callTool/close) — wstrzykiwany
// przez options.clientFactory, więc testy NIE ciągną SDK, obsidiana ani child_process.
function makeFakeClient(overrides: FakeClientOverrides = {}) {
    const calls: FakeClientCalls = { connect: [], listTools: [], callTool: [], close: 0 };
    const client: McpClientLike = {
        async connect(transport, opts) {
            calls.connect.push({ transport, opts });
            if (overrides.connectThrows) throw new Error(overrides.connectThrows);
        },
        async listTools(params, opts) {
            calls.listTools.push({ params, opts });
            return { tools: overrides.tools ?? [] };
        },
        async callTool(params, schema, opts) {
            calls.callTool.push({ params, schema, opts });
            if (overrides.callToolThrows) throw new Error(overrides.callToolThrows);
            return overrides.callToolResult ?? { content: [{ type: 'text', text: 'ok' }] };
        },
        async close() {
            calls.close += 1;
        },
    };
    return { client, calls };
}

function makeManager(overrides: FakeClientOverrides = {}, plugin: ExternalMcpPluginLike = { manifest: { version: '2.1.0' } }) {
    const registry = new ToolRegistry();
    const fake = makeFakeClient(overrides);
    const mgr = new ExternalMcpManager(plugin, {
        toolRegistry: registry,
        clientFactory: async (cfg) => ({ client: fake.client, transport: { id: cfg?.id } }),
    });
    return { mgr, registry, client: fake.client, calls: fake.calls };
}

test('connect: lists tools and registers them prefixed with source:user + description prefix + schema as-is', async t => {
    const schema = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] };
    const { mgr, registry, calls } = makeManager({
        tools: [{ name: 'render', description: 'Render a scene', inputSchema: schema }],
    });
    const cfg = { id: 'blender', name: 'Blender', transport: 'stdio', command: 'blender-mcp', enabled: true };

    const res = await mgr.connect(cfg);

    t.true(res.success);
    t.deepEqual(res.tools, ['blender__render']);
    t.is(calls.connect.length, 1, 'handshake happened once');
    t.is(calls.listTools.length, 1);

    const tool = registry.getTool('blender__render');
    t.truthy(tool);
    t.is(tool!.source, 'user');
    t.is(tool!.serverName, 'blender', 'serverName = serverId (filterByAgent opt-in)');
    t.is(tool!.description, '[Blender] Render a scene');
    t.is(tool!.inputSchema, schema, 'JSON Schema passed through as-is (same reference)');

    // R2: status runtime żyje w managerze, NIE na obiekcie configu (data.json = tylko konfiguracja).
    t.is(mgr.getStatus('blender').status, 'connected');
    t.is(mgr.getStatus('blender').lastError, null);
    t.is(mgr.getStatus('blender').toolCount, 1);
    t.false('status' in cfg, 'config object stays clean (no runtime status persisted)');
    t.false('lastError' in cfg);
    t.true(mgr.isConnected('blender'));
    t.true(mgr.isExternalTool('blender__render'));
    t.is(mgr.getToolActionType('blender__render'), 'external.call');
    t.is(mgr.getToolActionType('unknown_tool'), null);
});

test('execute routes to client.callTool with un-prefixed name, per-call timeout, and stripped internal args', async t => {
    const { mgr, registry, calls } = makeManager({
        tools: [{ name: 'render', description: 'r', inputSchema: { type: 'object' } }],
        callToolResult: { content: [{ type: 'text', text: 'done' }] },
    });
    await mgr.connect({ id: 'blender', name: 'Blender', transport: 'stdio', command: 'x' });

    const tool = registry.getTool('blender__render');
    const result = await tool!.execute({ code: 'print(1)', _invocationAgentName: 'Jaskier' });

    t.is(calls.callTool.length, 1);
    const call = calls.callTool[0];
    t.is(call.params.name, 'render', 'tool name un-prefixed on the wire');
    t.deepEqual(call.params.arguments, { code: 'print(1)' }, '_invocationAgentName stripped, not leaked to external server');
    t.is(call.opts!.timeout, 60000, 'resolveTimeoutMs default (60s)');
    // Z2.1: execute normalizuje wynik do czystego tekstu (model nie dostaje surowego content[]).
    t.is(result, 'done');
});

test('callTool timeout honours resolveTimeoutMs override and clamps to the 180s ceiling', async t => {
    const { mgr, calls } = makeManager({
        tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
    });
    await mgr.connect({ id: 'srv', name: 'Srv', transport: 'http', url: 'https://x', timeout_ms: 999999 });

    await mgr.callTool('srv', 't', {});
    t.is(calls.callTool[0].opts!.timeout, 180000, 'clamped to MAX_TIMEOUT_MS');
});

test('close unregisters the server tools and closes the client', async t => {
    const { mgr, registry, calls } = makeManager({
        tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }],
    });
    const cfg = { id: 'srv', name: 'Srv', transport: 'http', url: 'https://x' };
    await mgr.connect(cfg);
    t.truthy(registry.getTool('srv__a'));

    await mgr.close('srv');

    t.is(registry.getTool('srv__a'), null, 'tool unregistered from ToolRegistry');
    t.is(calls.close, 1);
    t.false(mgr.isConnected('srv'));
    t.false(mgr.isExternalTool('srv__a'));
    t.is(mgr.getStatus('srv').status, 'off');
});

test('connect failure sets status:error + lastError and does NOT throw (silent fail D-D)', async t => {
    const registry = new ToolRegistry();
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        // AUD-bledy-024: kształt `ENOENT` ma teraz własne zdanie — test pilnuje CICHEGO FAILA
        // (zero rzucania, status w mapie), a nie dosłownego brzmienia komunikatu.
        clientFactory: async () => { throw new Error('spawn ENOENT'); },
    });
    const cfg = { id: 'broken', name: 'Broken', transport: 'stdio', command: 'nope' };

    const res = await mgr.connect(cfg); // must resolve, never reject
    t.false(res.success);
    t.true(String(res.error).includes('nope'), res.error);
    t.is(mgr.getStatus('broken').status, 'error');
    t.is(mgr.getStatus('broken').lastError, res.error ?? null);
    t.false('status' in cfg, 'error status not persisted onto config');
    t.false(mgr.isConnected('broken'));
});

test('connect: handshake failure closes the half-open client (no zombie) and reports error', async t => {
    const { mgr, calls } = makeManager({ connectThrows: 'handshake failed' });
    const cfg = { id: 'srv', name: 'Srv', transport: 'stdio', command: 'x' };

    const res = await mgr.connect(cfg);
    t.false(res.success);
    t.is(mgr.getStatus('srv').status, 'error');
    t.is(calls.close, 1, 'best-effort cleanup after handshake failure');
});

test('autostart connects only enabled+autostart servers', async t => {
    const registry = new ToolRegistry();
    const connected: string[] = [];
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async (cfg) => {
            connected.push(cfg.id);
            return { client: makeFakeClient({ tools: [] }).client, transport: {} };
        },
    });
    const servers = [
        { id: 'srv-a', name: 'A', transport: 'http', url: 'https://a', enabled: true, autostart: true },
        { id: 'srv-b', name: 'B', transport: 'http', url: 'https://b', enabled: true, autostart: false },
        { id: 'srv-c', name: 'C', transport: 'http', url: 'https://c', enabled: false, autostart: true },
    ];

    await mgr.autostart(servers);
    await mgr.whenAutostartSettled();
    t.deepEqual(connected, ['srv-a']);
});

test('closeAll closes every connection (onunload zombie-guard)', async t => {
    const registry = new ToolRegistry();
    const clientCalls: FakeClientCalls[] = [];
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async () => {
            const f = makeFakeClient({ tools: [] });
            clientCalls.push(f.calls);
            return { client: f.client, transport: {} };
        },
    });
    await mgr.connect({ id: 'srv-a', name: 'A', transport: 'http', url: 'https://a' });
    await mgr.connect({ id: 'srv-b', name: 'B', transport: 'http', url: 'https://b' });
    t.is(mgr.getConnectedServerIds().length, 2);

    await mgr.closeAll();
    t.is(mgr.getConnectedServerIds().length, 0);
    t.is(clientCalls[0].close, 1);
    t.is(clientCalls[1].close, 1);
});

test('callTool on an unconnected server returns isError without throwing', async t => {
    const { mgr } = makeManager();
    const res = await mgr.callTool('ghost', 'x', {});
    t.true(res.isError);
});

test('callTool surfaces a server-side error as an isError result (no throw)', async t => {
    const { mgr } = makeManager({
        tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
        callToolThrows: 'boom',
    });
    await mgr.connect({ id: 'srv', name: 'S', transport: 'http', url: 'https://x' });

    const res = await mgr.callTool('srv', 't', {});
    t.true(res.isError);
    t.is(res.error, 'boom');
});

test('tool without inputSchema gets an object-schema fallback that ToolRegistry accepts', async t => {
    const { mgr, registry } = makeManager({ tools: [{ name: 'noschema', description: 'd' }] });
    const res = await mgr.connect({ id: 'srv', name: 'S', transport: 'http', url: 'https://x' });

    t.true(res.success);
    const tool = registry.getTool('srv__noschema');
    t.deepEqual(tool!.inputSchema, { type: 'object', properties: {} });
});

test('connect twice is idempotent (alreadyConnected, no second handshake)', async t => {
    const { mgr, calls } = makeManager({
        tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }],
    });
    const cfg = { id: 'srv', name: 'S', transport: 'http', url: 'https://x' };
    await mgr.connect(cfg);

    const res2 = await mgr.connect(cfg);
    t.true(res2.alreadyConnected);
    t.deepEqual(res2.tools, ['srv__a']);
    t.is(calls.connect.length, 1, 'no duplicate handshake on re-connect');
});

// ─── R2: statusy runtime nie persystują do data.json ─────────────

test('R2: getStatus reflects lifecycle and the config object never gains runtime fields', async t => {
    const { mgr } = makeManager({ tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }] });
    const cfg = { id: 'srv', name: 'S', transport: 'http', url: 'https://x' };

    t.is(mgr.getStatus('srv').status, 'off', 'never-connected server = off');

    await mgr.connect(cfg);
    t.is(mgr.getStatus('srv').status, 'connected');
    t.is(mgr.getStatus('srv').toolCount, 1);
    t.is(mgr.getStatus('srv').lastError, null);
    // The persisted config must stay pure configuration.
    t.deepEqual(Object.keys(cfg).sort(), ['id', 'name', 'transport', 'url'].sort());

    await mgr.close('srv');
    t.is(mgr.getStatus('srv').status, 'off');
    t.is(mgr.getStatus('srv').toolCount, 0);
});

test('R2: stripRuntimeFields removes status/lastError a previous version may have persisted', t => {
    const cfg = { id: 'srv', name: 'S', transport: 'http', url: 'https://x', status: 'connected', lastError: 'boom' };
    const out = ExternalMcpManager.stripRuntimeFields(cfg);
    t.is(out, cfg, 'mutates in place and returns it');
    t.false('status' in cfg);
    t.false('lastError' in cfg);
    t.is(cfg.url, 'https://x', 'user configuration preserved');
    // safe on non-objects
    t.notThrows(() => ExternalMcpManager.stripRuntimeFields(null));
});

test('R2: listServersForUi merges config + runtime status from the internal map', async t => {
    const { mgr } = makeManager({ tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }] });
    const servers = [
        { id: 'live', name: 'Live', transport: 'http', url: 'https://x', autostart: true },
        { id: 'idle', name: 'Idle', transport: 'stdio', command: 'x' },
    ];
    await mgr.connect(servers[0]);

    const rows = mgr.listServersForUi(servers);
    const live = rows.find(r => r.id === 'live');
    const idle = rows.find(r => r.id === 'idle');
    t.is(live!.status, 'connected');
    t.is(live!.toolCount, 1);
    t.true(live!.connected);
    t.true(live!.autostart);
    t.is(idle!.status, 'off');
    t.false(idle!.connected);
});

// ─── R3: walidacja id serwera (slug + brak kolizji z built-in) ────

test('R3 unit: validateServerId enforces slug + rejects built-in server-name collisions', t => {
    const builtin = ['core', 'vault', 'memory', 'web', 'multimodal', 'delegation', 'artifacts', 'komunikator'];
    t.true(ExternalMcpManager.validateServerId('blender', builtin).ok);
    t.true(ExternalMcpManager.validateServerId('my-remote-2', builtin).ok);
    // collisions with built-in servers (SECURITY: default agent.mcp_servers = [vault,memory,core])
    t.is(ExternalMcpManager.validateServerId('vault', builtin).reason, 'reserved');
    t.is(ExternalMcpManager.validateServerId('memory', builtin).reason, 'reserved');
    t.is(ExternalMcpManager.validateServerId('core', builtin).reason, 'reserved');
    // format violations
    t.is(ExternalMcpManager.validateServerId('X', builtin).reason, 'format', 'uppercase');
    t.is(ExternalMcpManager.validateServerId('a', builtin).reason, 'format', 'too short');
    t.is(ExternalMcpManager.validateServerId('foo_bar', builtin).reason, 'format', 'underscore not allowed');
    t.is(ExternalMcpManager.validateServerId('../evil', builtin).reason, 'format', 'traversal');
    t.is(ExternalMcpManager.validateServerId('a'.repeat(33), builtin).reason, 'format', 'too long');
    t.is(ExternalMcpManager.validateServerId(null as unknown as string, builtin).reason, 'format');
});

test('R3: connect refuses an id colliding with a built-in server (no auto-grant to every agent)', async t => {
    const { mgr } = makeManager({ tools: [{ name: 'x', description: 'd', inputSchema: { type: 'object' } }] });
    const cfg = { id: 'vault', name: 'Evil', transport: 'http', url: 'https://x' };

    const res = await mgr.connect(cfg);
    t.false(res.success);
    t.regex(res.error!, /zarezerwowane/);
    t.false(mgr.isConnected('vault'));
    t.is(mgr.getStatus('vault').status, 'error');
});

test('R3: connect refuses a malformed id before touching the transport', async t => {
    const connected = [];
    const registry = new ToolRegistry();
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async (cfg) => { connected.push(cfg.id); return { client: makeFakeClient({ tools: [] }).client, transport: {} }; },
    });

    const res = await mgr.connect({ id: 'Bad_Id', name: 'x', transport: 'http', url: 'https://x' });
    t.false(res.success);
    t.is(connected.length, 0, 'clientFactory never called for an invalid id');
});

// ─── S32 Z2.1: normalizacja wyników MCP (model dostaje tekst, nie base64) ──

test('Z2.1 normalizeMcpResult: text-only content sklejony w czysty string', t => {
    t.is(normalizeMcpResult({ content: [{ type: 'text', text: 'pierwszy' }, { type: 'text', text: 'drugi' }] }),
        'pierwszy\n\ndrugi');
});

test('Z2.1 normalizeMcpResult: base64 obrazka NIE trafia do wyniku (tylko adnotacja)', t => {
    const base64 = 'A'.repeat(4096); // 4096 znaków base64 = ~3 kB
    const out = normalizeMcpResult({
        content: [
            { type: 'text', text: 'Wyrenderowane:' },
            { type: 'image', mimeType: 'image/png', data: base64 },
        ],
    });
    t.false((out as string).includes(base64), 'base64 nie wchodzi do promptu');
    t.is(out, 'Wyrenderowane:\n\n[image image/png, ~3 kB]');
});

test('Z2.1 normalizeMcpResult: resource z tekstem dokleja treść pod adnotacją', t => {
    t.is(
        normalizeMcpResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.md', text: 'treść pliku' } }] }),
        '[resource: file:///a.md]\ntreść pliku'
    );
    // resource bez tekstu (np. binarny blob) = sama adnotacja
    t.is(
        normalizeMcpResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.bin', blob: 'AAAA' } }] }),
        '[resource: file:///a.bin]'
    );
    // nieznany typ part-a nie wywala normalizacji
    t.is(normalizeMcpResult({ content: [{ type: 'audio', data: 'AAAA' }] }), '[audio]');
});

test('Z2.1 normalizeMcpResult: isError zwraca {isError, error} ze sklejonym tekstem', t => {
    t.deepEqual(
        normalizeMcpResult({ isError: true, content: [{ type: 'text', text: 'server exploded' }] }),
        { isError: true, error: 'server exploded' }
    );
});

test('Z2.1 normalizeMcpResult: wejście bez tablicy content przechodzi bez zmian', t => {
    const own = { isError: true, error: 'nie podłączony' };
    t.is(normalizeMcpResult(own), own, 'nasz własny kształt błędu (bez content) — ta sama referencja');
    t.is(normalizeMcpResult(null), null);
    t.is(normalizeMcpResult('goły string'), 'goły string');
    const noContent = { structuredContent: { a: 1 } };
    t.is(normalizeMcpResult(noContent), noContent);
});

test('Z2.1: execute na obrazku zwraca adnotację, callTool nadal surowy wynik SDK', async t => {
    const raw = { content: [{ type: 'image', mimeType: 'image/jpeg', data: 'B'.repeat(1024) }] };
    const { mgr, registry } = makeManager({
        tools: [{ name: 'shot', description: 'd', inputSchema: { type: 'object' } }],
        callToolResult: raw,
    });
    await mgr.connect({ id: 'srv', name: 'S', transport: 'http', url: 'https://x' });

    t.is(await registry.getTool('srv__shot')!.execute({}), '[image image/jpeg, ~1 kB]');
    t.deepEqual(await mgr.callTool('srv', 'shot', {}), raw, 'callTool zostaje surowe (kontrakt niezmieniony)');
});

// ─── S32 Z2.4: czytelny 401 ────────────────────────────────────────

test('Z2.4: 401/Unauthorized daje przetłumaczony komunikat w lastError', async t => {
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: new ToolRegistry(),
        clientFactory: async () => { throw new Error('HTTP 401 Unauthorized'); },
    });

    const res = await mgr.connect({ id: 'remote', name: 'R', transport: 'http', url: 'https://x' });
    t.false(res.success);
    t.is(res.error, tr('settings.mcp_external_error_401'));
    t.is(mgr.getStatus('remote').lastError, tr('settings.mcp_external_error_401'));
});

test('Z2.4: inny błąd niż 401 zostaje surowy (zamaskowany), bez podmiany na instrukcję', async t => {
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: new ToolRegistry(),
        clientFactory: async () => { throw new Error('HTTP 500 Internal Server Error'); },
    });

    const res = await mgr.connect({ id: 'remote', name: 'R', transport: 'http', url: 'https://x' });
    t.is(res.error, 'HTTP 500 Internal Server Error');
    t.not(res.error, tr('settings.mcp_external_error_401'));
});

test('connect: stdio na mobile odmawia bez importu SDK (gate isMobile przez DI)', async (t) => {
    const mgr = new ExternalMcpManager({ manifest: { version: '2.1.0' } }, {
        toolRegistry: new ToolRegistry(),
        isMobile: true,
    });
    const res = await mgr.connect({ id: 'blender', transport: 'stdio', command: 'uv' });
    t.false(res.success);
    t.regex(res.error!, /desktop/i);
    t.is(mgr.getStatus('blender').status, 'error');
});

// ─── S33 Z3: filtr znaczników wewnętrznych ────────────────────────

test('S33 Z3: _stripInternal wycina WSZYSTKIE znaczniki _invocation* i nie rusza reszty', t => {
    const { mgr } = makeManager();
    const out = mgr._stripInternal({
        code: 'print(1)',
        _invocationAgentName: 'Jaskier',
        _invocationDelegationDepth: 2,
        _invocationFutureMarker: 'whatever',
        nested: { _invocationAgentName: 'keep — filtr jest płytki z założenia' },
        _underscoreButNotInvocation: 'zostaje',
    });
    t.deepEqual(out, {
        code: 'print(1)',
        nested: { _invocationAgentName: 'keep — filtr jest płytki z założenia' },
        _underscoreButNotInvocation: 'zostaje',
    });
    // static i alias instancyjny to ta sama reguła (MCPClient używa statica).
    t.deepEqual(ExternalMcpManager.stripInternalArgs({ a: 1, _invocationAgentName: 'x' }), { a: 1 });
});

test('S33 Z3: _stripInternal zwraca wejścia nie-obiektowe nietknięte', t => {
    const { mgr } = makeManager();
    t.is(mgr._stripInternal(null), null);
    t.is(mgr._stripInternal(undefined), undefined);
    t.is(mgr._stripInternal('tekst'), 'tekst');
    t.is(mgr._stripInternal(42), 42);
    const arr = [{ _invocationAgentName: 'x' }];
    t.is(mgr._stripInternal(arr), arr, 'tablica wraca TĄ SAMĄ referencją (nie filtrujemy list)');
});

// ─── S33 Z3: podgląd narzędzi PRZED zapisem ───────────────────────

test('S33 Z3: previewTools listuje narzędzia, zamyka klienta i NICZEGO nie rejestruje', async t => {
    const { mgr, registry, calls } = makeManager({
        tools: [
            { name: 'render', description: 'Render a scene', inputSchema: { type: 'object' } },
            { name: 'quit', description: '', inputSchema: { type: 'object' } },
        ],
    });
    const cfg = { id: 'blender', name: 'Blender', transport: 'stdio', command: 'x' };

    const res = await mgr.previewTools(cfg);

    t.true(res.success);
    t.deepEqual(res.tools, [
        { name: 'render', description: 'Render a scene' },
        { name: 'quit', description: '' },
    ]);
    t.is(calls.close, 1, 'podgląd nie zostawia otwartego połączenia');
    t.is(registry.getTool('blender__render'), null, 'nic nie trafia do ToolRegistry');
    t.false(mgr.isConnected('blender'));
    t.false(mgr.isExternalTool('blender__render'));
    t.is(mgr.getStatus('blender').status, 'off', 'mapa statusów nietknięta przez podgląd');
});

test('S33 Z3: previewTools nie rzuca — błąd wraca jako {success:false, error}', async t => {
    const { mgr } = makeManager({ connectThrows: 'ECONNREFUSED 127.0.0.1:9000' });
    const res = await mgr.previewTools({ id: 'srv', name: 'S', transport: 'http', url: 'https://x' });
    t.false(res.success);
    t.is(res.error, 'ECONNREFUSED 127.0.0.1:9000');
    t.is(mgr.getStatus('srv').status, 'off', 'nieudany podgląd nie ustawia statusu error');
});

test('S33 Z3: previewTools na mobile odmawia stdio (ten sam gate co connect)', async t => {
    const mgr = new ExternalMcpManager({ manifest: { version: '2.1.0' } }, {
        toolRegistry: new ToolRegistry(),
        isMobile: true,
    });
    const res = await mgr.previewTools({ id: 'blender', transport: 'stdio', command: 'uv' });
    t.false(res.success);
    t.regex(res.error!, /desktop/i);
});

test('S33 Z3: previewTools nie psuje ŻYWEGO połączenia tego samego serwera', async t => {
    const { mgr, registry } = makeManager({
        tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }],
    });
    const cfg = { id: 'srv', name: 'S', transport: 'http', url: 'https://x' };
    await mgr.connect(cfg);

    await mgr.previewTools(cfg);

    t.true(mgr.isConnected('srv'), 'połączenie żyje dalej');
    t.truthy(registry.getTool('srv__a'), 'narzędzia zostają zarejestrowane');
    t.is(mgr.getStatus('srv').status, 'connected');
});

test('connect: realna ścieżka SDK — nieistniejąca komenda stdio daje status error (bez clientFactory)', async (t) => {
    const mgr = new ExternalMcpManager({ manifest: { version: '2.1.0' } }, {
        toolRegistry: new ToolRegistry(),
        isMobile: false,
    });
    const res = await mgr.connect({ id: 'ghost', transport: 'stdio', command: 'pkm-nonexistent-cmd-xyz' });
    t.false(res.success);
    t.is(mgr.getStatus('ghost').status, 'error');
    t.truthy(mgr.getStatus('ghost').lastError);
});

// ─── K11 (AUD-security-005): autostart nie bramkuje startu pluginu ───────────────────────
//
// Do K11 `autostart()` łączyła serwery po kolei (`await` w pętli), a `main.ts` czekał na nią
// przed ustawieniem `plugin._ready`. Serwer, który przyjmuje transport i milczy, trzymał więc
// czat i sidebar na spinnerze przez cały swój budżet — a trzy takie serwery sumowały budżety.

test('K11 005: autostart wraca NATYCHMIAST, choć serwer wisi (nie bramkuje _ready)', async t => {
    const registry = new ToolRegistry();
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        // Serwer, który przyjął transport i milczy — obietnica nie rozstrzyga się nigdy.
        clientFactory: () => new Promise(() => {}) as never,
    });

    const started = Date.now();
    await mgr.autostart([
        { id: 'wisi-a', name: 'A', transport: 'http', url: 'https://a', enabled: true, autostart: true },
        { id: 'wisi-b', name: 'B', transport: 'http', url: 'https://b', enabled: true, autostart: true },
    ]);
    t.true(Date.now() - started < 1000, 'autostart nie czeka na zawieszony serwer');

    // Fail-closed: dopóki serwer nie wstanie, jego narzędzi po prostu nie ma w rejestrze.
    t.is(mgr.getServerTools('wisi-a').length, 0);
});

test('K11 005: autostart łączy RÓWNOLEGLE (budżety serwerów się nie sumują)', async t => {
    const registry = new ToolRegistry();
    let inFlight = 0;
    let maxInFlight = 0;
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(res => setTimeout(res, 20));
            inFlight--;
            return { client: makeFakeClient({ tools: [] }).client, transport: {} };
        },
    });

    await mgr.autostart([
        { id: 'wolny-a', name: 'A', transport: 'http', url: 'https://a', enabled: true, autostart: true },
        { id: 'wolny-b', name: 'B', transport: 'http', url: 'https://b', enabled: true, autostart: true },
        { id: 'wolny-c', name: 'C', transport: 'http', url: 'https://c', enabled: true, autostart: true },
    ]);
    await mgr.whenAutostartSettled();

    // Asercja o RÓWNOLEGŁOŚCI, nie o zegarze — sekwencyjna pętla dałaby maksimum 1.
    t.is(maxInFlight, 3, 'wszystkie trzy podłączenia ruszały naraz');
    t.is(mgr.getStatus('wolny-c').status, 'connected');
});

test('K11 005: connect ma JEDEN budżet na handshake + listTools, nie dwa', async t => {
    const registry = new ToolRegistry();
    const timeouts: Array<[string, number | undefined]> = [];
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async () => ({
            client: {
                connect: async (_tr: unknown, opts?: { timeout?: number }) => {
                    timeouts.push(['connect', opts?.timeout]);
                    await new Promise(res => setTimeout(res, 30));
                },
                listTools: async (_a: unknown, opts?: { timeout?: number }) => {
                    timeouts.push(['listTools', opts?.timeout]);
                    return { tools: [] };
                },
                close: async () => {},
            } as never,
            transport: {},
        }),
    });

    await mgr.connect({ id: 'srv', name: 'S', transport: 'http', url: 'https://x', timeout_ms: 1000 });

    t.is(timeouts[0][1], 1000);
    t.true(timeouts[1][1]! < 1000, 'listTools dostaje RESZTĘ budżetu, nie drugie pełne okno');
});

// ─── AUD-bledy-022: śmierć procesu serwera musi zejść ze statusu i z rejestru ───
//
// Do tej naprawy manager nie podpinał `onclose`/`onerror` transportu, więc po padzie procesu
// stdio (user zamknął Blendera) wpis zostawał w `_connections`, `getStatus()` dalej mówił
// „connected", a martwe narzędzia leciały modelowi w definicjach — każde wywołanie wracało
// „Connection closed", a Ustawienia i Konektory pokazywały zieloną kropkę.

/** Transport-atrapa: trzyma haki, które podpina do niego manager (i SDK). */
function makeFakeTransport(): { onclose?: () => void; onerror?: (e: Error) => void } {
    return {};
}

test('022: pad procesu serwera (transport.onclose) rozłącza go i wyrejestrowuje narzędzia', async t => {
    const registry = new ToolRegistry();
    const transport = makeFakeTransport();
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async () => ({ client: makeFakeClient({ tools: [{ name: 'scene' }] }).client, transport }),
    });
    await mgr.connect({ id: 'blender', name: 'Blender', transport: 'stdio', command: 'blender-mcp' });
    t.is(mgr.getStatus('blender').status, 'connected');
    t.truthy(registry.getTool('blender__scene'));

    // Proces ginie: SDK woła hak transportu.
    transport.onclose?.();

    t.not(mgr.getStatus('blender').status, 'connected', 'status nie może dalej mówić „połączony"');
    t.false(mgr.isConnected('blender'));
    t.is(registry.getTool('blender__scene'), null, 'martwe narzędzie znika z rejestru');
    t.false(mgr.isExternalTool('blender__scene'));
    t.is(mgr.getStatus('blender').toolCount, 0);
});

test('022: błąd transportu (onerror) też ląduje w statusie serwera', async t => {
    const registry = new ToolRegistry();
    const transport = makeFakeTransport();
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async () => ({ client: makeFakeClient({ tools: [{ name: 'scene' }] }).client, transport }),
    });
    await mgr.connect({ id: 'blender', name: 'Blender', transport: 'stdio', command: 'blender-mcp' });

    transport.onerror?.(new Error('EPIPE: broken pipe'));

    t.is(mgr.getStatus('blender').status, 'error');
    t.truthy(mgr.getStatus('blender').lastError);
    t.is(registry.getTool('blender__scene'), null);
});

// ─── AUD-bledy-023 + 034: closeAll równolegle z sufitem + guard po wyładowaniu ───

test('023: closeAll nie czeka na wiszący serwer — pozostałe dostają close w limicie', async t => {
    const registry = new ToolRegistry();
    const closed: string[] = [];
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async (cfg) => ({
            client: {
                connect: async () => {},
                listTools: async () => ({ tools: [] }),
                callTool: async () => ({}),
                // Serwer „wisi-b" ignoruje zamknięcie stdin i nigdy nie oddaje obietnicy.
                close: cfg.id === 'wisi-b'
                    ? () => new Promise(() => {})
                    : async () => { closed.push(cfg.id); },
            } as never,
            transport: {},
        }),
    });
    await mgr.connect({ id: 'wisi-a', name: 'A', transport: 'http', url: 'https://a' });
    await mgr.connect({ id: 'wisi-b', name: 'B', transport: 'http', url: 'https://b' });
    await mgr.connect({ id: 'wisi-c', name: 'C', transport: 'http', url: 'https://c' });

    const started = Date.now();
    await mgr.closeAll(50);

    t.true(Date.now() - started < 2000, 'jeden trup nie może zablokować demontażu');
    t.deepEqual(closed.sort(), ['wisi-a', 'wisi-c'], 'reszta listy dostała close mimo trupa w środku');
    t.is(mgr.getConnectedServerIds().length, 0, 'rejestr połączeń pusty po demontażu');
});

test('034: po closeAll autostart i connect ODMAWIAJĄ (żadnego zombie po wyładowaniu)', async t => {
    const registry = new ToolRegistry();
    let created = 0;
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async () => {
            created++;
            return { client: makeFakeClient({ tools: [{ name: 'scene' }] }).client, transport: {} };
        },
    });

    await mgr.closeAll();

    await mgr.autostart([{ id: 'srv-a', name: 'A', transport: 'http', url: 'https://a', enabled: true, autostart: true }]);
    await mgr.whenAutostartSettled();
    const res = await mgr.connect({ id: 'srv-b', name: 'B', transport: 'http', url: 'https://b' });

    t.is(created, 0, 'martwy menedżer nie stawia nowych procesów');
    t.false(res.success);
    t.is(mgr.getConnectedServerIds().length, 0);
    t.is(registry.getTool('srv-b__scene'), null);
});

test('034: handshake, który skończył się PO closeAll, nie ląduje w mapie połączeń', async t => {
    const registry = new ToolRegistry();
    let release: (() => void) | null = null;
    const fake = makeFakeClient({ tools: [{ name: 'scene' }] });
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async () => {
            await new Promise<void>(res => { release = res; });
            return { client: fake.client, transport: {} };
        },
    });

    // `npx` ciągnie paczkę — handshake trwa; w tym czasie user wyłącza plugin.
    const pending = mgr.connect({ id: 'wolny', name: 'W', transport: 'stdio', command: 'npx' });
    await new Promise(res => setTimeout(res, 10));
    await mgr.closeAll();
    (release as unknown as () => void)();
    const res = await pending;

    t.false(res.success, 'spóźnione podłączenie nie melduje sukcesu');
    t.is(mgr.getConnectedServerIds().length, 0, 'nic nie wpada do mapy martwego menedżera');
    t.is(registry.getTool('wolny__scene'), null, 'ani do rejestru narzędzi');
    t.is(fake.calls.close, 1, 'świeżo zestawiony klient zostaje domknięty');
});

// ─── AUD-code-review-061: dwa równoczesne connect() dla TEGO SAMEGO serwera ───
//
// Scenariusz z audytu: autostart (bez await) łączy serwer stdio z wolnym handshakiem
// (`npx` ściąga paczkę), a user w tym samym oknie klika „Połącz" w Ustawieniach. Przed
// naprawą oba wywołania przechodziły check-then-act na `_connections` (pusta mapa dla
// obu), oba stawiały OSOBNY klient/proces, a późniejszy zapis do `_connections.set()`
// po cichu nadpisywał wcześniejszy — pierwszy proces potomny nigdy nie dostawał `close()`.

test('061: dwa równoczesne connect() dla tego samego id — JEDEN handshake, JEDEN klient, zero zombie', async t => {
    const registry = new ToolRegistry();
    let created = 0;
    let release: (() => void) | null = null;
    const fake = makeFakeClient({ tools: [{ name: 'scene' }] });
    const mgr = new ExternalMcpManager({}, {
        toolRegistry: registry,
        clientFactory: async () => {
            created++;
            // Handshake trwa — okno, w którym oba wywołania (autostart + klik „Połącz")
            // widzą pustą mapę połączeń.
            await new Promise<void>(res => { release = res; });
            return { client: fake.client, transport: {} };
        },
    });
    const cfg = { id: 'srv', name: 'S', transport: 'stdio', command: 'npx' };

    const p1 = mgr.connect(cfg);
    await new Promise(res => setTimeout(res, 5)); // p1 jest już w środku handshake'u
    const p2 = mgr.connect(cfg);

    t.is(created, 1, 'clientFactory wołana RAZ — drugi connect() nie stawia własnego procesu');

    (release as unknown as () => void)();
    const [res1, res2] = await Promise.all([p1, p2]);

    t.true(res1.success);
    t.deepEqual(res1, res2, 'oba wywołania dostają TEN SAM wynik (ta sama obietnica)');
    t.is(mgr.getConnectedServerIds().length, 1, 'jeden wpis w mapie połączeń, nie dwa');
    t.is(fake.calls.connect.length, 1, 'jeden handshake protokołu MCP, nie dwa');
    t.is(fake.calls.close, 0, 'zero zamkniętych klientów — nikt nie został osierocony');
});

test('061: blokada zwalnia się po rozstrzygnięciu — trzeci connect() widzi już podłączony serwer', async t => {
    const { mgr, calls } = makeManager({ tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }] });
    const cfg = { id: 'srv', name: 'S', transport: 'http', url: 'https://x' };

    await Promise.all([mgr.connect(cfg), mgr.connect(cfg)]);
    const res3 = await mgr.connect(cfg);

    t.true(res3.alreadyConnected, 'blokada nie zostaje wisząca na zawsze — trzecie wywołanie idzie ścieżką alreadyConnected');
    t.is(calls.connect.length, 1, 'wciąż tylko jeden handshake mimo trzech wywołań connect()');
});

// ─── AUD-bledy-024: nieudane połączenie mówi ZDANIEM, nie kodem systemowym ───

test('024: spawn npx ENOENT daje zdanie z nazwą programu, nie ENOENT', async t => {
    const { mgr } = makeManager({ connectThrows: 'spawn npx ENOENT' });

    const res = await mgr.connect({ id: 'fs', name: 'Filesystem', transport: 'stdio', command: 'npx' });

    t.false(res.success);
    t.false(String(res.error).includes('ENOENT'), `surowy kod w komunikacie: ${res.error}`);
    t.true(String(res.error).includes('npx'), 'zdanie ma nazwać program, którego brakuje');
    t.is(mgr.getStatus('fs').lastError, res.error ?? null, 'wiersz w Ustawieniach pokazuje to samo zdanie');
});

test('024: EACCES / ECONNREFUSED / timeout mają własne zdania', async t => {
    for (const [raw, must] of [
        ['spawn /usr/local/bin/mcp EACCES', 'EACCES'],
        ['connect ECONNREFUSED 127.0.0.1:3000', 'ECONNREFUSED'],
        ['MCP error -32001: Request timed out', 'timed out'],
    ] as Array<[string, string]>) {
        const { mgr } = makeManager({ connectThrows: raw });
        const res = await mgr.connect({ id: 'srv', name: 'S', transport: 'http', url: 'https://x' });
        t.false(res.success);
        t.false(String(res.error).includes(must), `${raw} → surowy tekst w UI: ${res.error}`);
        t.true(String(res.error).length > 20, `${raw} → to ma być zdanie, nie skrót`);
    }
});

test('024: nieznany kształt błędu leci starą ścieżką (maskowany surowy tekst)', async t => {
    const { mgr } = makeManager({ connectThrows: 'cos zupelnie innego poszlo nie tak' });

    const res = await mgr.connect({ id: 'srv', name: 'S', transport: 'http', url: 'https://x' });

    t.is(res.error, 'cos zupelnie innego poszlo nie tak');
});

test('024: klucze i18n użyte przez warstwę tłumaczenia istnieją w PL i EN', t => {
    for (const key of [
        'settings.mcp_external_error_enoent',
        'settings.mcp_external_error_eacces',
        'settings.mcp_external_error_refused',
        'settings.mcp_external_error_timeout',
    ]) {
        t.not(tr(key, { cmd: 'npx' }), key, `brak tłumaczenia dla ${key} — user zobaczyłby nazwę klucza`);
    }
});
