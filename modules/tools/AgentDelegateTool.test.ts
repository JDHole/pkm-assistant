/**
 * agent_delegate (S28 D6 + K6) — kontekst delegacji chodzi TĄ SAMĄ drogą co `kom_send`.
 *
 * Duch nie ma pingu ani kom_read, więc list w jego skrzynce byłby martwy. Delegacja
 * (przełączenie rozmowy) idzie dalej — kontekst niesie sam proposal w wyniku.
 *
 * K6 (AUD-security-006/013): atrapa dostaje PRAWDZIWY `KomunikatorManager`, żeby test
 * dotykał realnych bramek poczty (rate-limit, licznik odbić, filtr ducha), a nie ich imitacji.
 */
import test from 'ava';
import { createAgentDelegateTool } from './AgentDelegateTool.js';
// Atrapa AgentManagera deleguje do PRAWDZIWEGO filtra ducha (wzór KomunikatorTools.test.js).
import { isKomunikatorVisible, listKomunikatorAgents, findKomunikatorAgent } from '../komunikator/visibility.js';
import { KomunikatorManager } from '../komunikator/KomunikatorManager.js';
// K17: pełny łańcuch bramek — prawdziwy rejestr (oś narzędziowa), prawdziwy PermissionSystem
// (klasyfikacja ryzyka + zgody) i prawdziwy klient. Deep-import w teście jest dozwolony.
import { ToolRegistry } from './ToolRegistry.js';
import { MCPClient } from './MCPClient.js';
import { createKomunikatorTools } from './KomunikatorTools.js';
import { PermissionSystem } from '../../core/security/PermissionSystem.js';

/**
 * Agent w atrapie: nazwa + (opcjonalnie) flaga ducha czytana przez prawdziwy filtr
 * + (K17) negatywna lista narzędzi, czyli oś liczona przez `ToolRegistry.checkToolAxis`.
 */
type FakeAgent = {
    name: string;
    komunikator_visible?: boolean;
    disabled_tools?: string[];
    /** K17: przełączniki zgód usera (`PermissionSystem.requiresApproval`). */
    approvalToggles?: Record<string, boolean>;
};

/** Plugin w kształcie, jakiego oczekuje `execute` (atrapa jest luźniejsza). */
type DelegatePlugin = Parameters<ReturnType<typeof createAgentDelegateTool>['execute']>[2];

/** Wynik narzędzia czytany w asercjach. */
type DelegateRes = { success?: boolean; delegation?: boolean; context_summary?: string; error?: string };

function fakeVault() {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    return {
        _files: files,
        adapter: {
            async exists(p: string) { return files.has(p) || dirs.has(p); },
            async mkdir(p: string) { dirs.add(p); },
            async read(p: string) { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
            async write(p: string, d: string) { files.set(p, d); },
            async remove(p: string) { files.delete(p); },
            async list(dir: string) {
                const prefix = dir.endsWith('/') ? dir : dir + '/';
                return {
                    files: [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')),
                    folders: [],
                };
            },
        },
    };
}

function makePlugin(agents: FakeAgent[], limits?: Record<string, number>) {
    const agentManager: Record<string, unknown> = {
        _emit: () => {},
        getAllAgents: () => agents,
        getAgent: (name: string) => agents.find(a => a.name === name) || null,
        getActiveAgent: () => agents[0] || null,
    };
    agentManager.isKomunikatorVisible = (a: FakeAgent) => isKomunikatorVisible(a);
    agentManager.listKomunikatorAgents = () => listKomunikatorAgents(agentManager);
    agentManager.findKomunikatorAgent = (name: string) => findKomunikatorAgent(agentManager, name);
    const vault = fakeVault();
    agentManager.komunikatorManager = new KomunikatorManager(vault, agentManager);
    // K17: rejestr jest w KAŻDEJ atrapie — cały dotychczasowy zestaw biegnie z żywą bramką
    // osi poczty i pilnuje, że delegacja widocznych agentów działa jak dotąd.
    const toolRegistry = new ToolRegistry();
    const plugin = {
        agentManager,
        toolRegistry,
        env: { settings: { pkmAssistant: { limits: limits || {} } } },
    } as unknown as DelegatePlugin;
    return { plugin, vault, toolRegistry };
}

/** Listy leżące w skrzynkach (bez rozróżnienia adresata). */
const listy = (vault: ReturnType<typeof fakeVault>) => [...vault._files.keys()].filter(p => p.endsWith('.md'));

const AGENTS = (): FakeAgent[] => [{ name: 'Tola' }, { name: 'Sonny' }, { name: 'Duch', komunikator_visible: false }];

test('widoczny adresat: kontekst delegacji ląduje w skrzynce', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const tool = createAgentDelegateTool();
    const res = await tool.execute(
        { to_agent: 'Sonny', context_summary: 'Kontekst rozmowy', reason: 'bo tak', _invocationAgentName: 'Tola' },
        {}, plugin,
    ) as DelegateRes;
    t.true(res.success);
    t.true(res.delegation);
    t.is(listy(vault).length, 1);
    const [path] = listy(vault);
    t.true(path.includes('/sonny/'));
    t.true(vault._files.get(path)!.includes('Kontekst rozmowy'));
});

test('agent-duch: delegacja przechodzi, ale ZERO listu do skrzynki (D6)', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const tool = createAgentDelegateTool();
    const res = await tool.execute(
        { to_agent: 'Duch', context_summary: 'Kontekst rozmowy', _invocationAgentName: 'Tola' },
        {}, plugin,
    ) as DelegateRes;
    t.true(res.success);
    t.true(res.delegation);
    t.is(res.context_summary, 'Kontekst rozmowy');
    t.is(listy(vault).length, 0);
});

// ═════════ K6 (AUD-security-006/013) — delegacja nie jest drugą drogą do skrzynki ═════════

test('006: delegacja podlega TEMU SAMEMU rate-limitowi co kom_send', async t => {
    const { plugin, vault } = makePlugin(AGENTS(), { kom_send_rate_max: 2 });
    const tool = createAgentDelegateTool();
    const args = () => ({ to_agent: 'Sonny', context_summary: 'Kontekst', _invocationAgentName: 'Tola' });

    for (let i = 0; i < 5; i++) await tool.execute(args(), {}, plugin);

    t.is(listy(vault).length, 2, 'limit 2 = dwa listy, reszta odbita');
});

test('006: wsad delegacji przez Promise.all nie przebija limitu', async t => {
    const { plugin, vault } = makePlugin(AGENTS(), { kom_send_rate_max: 3 });
    const tool = createAgentDelegateTool();

    await Promise.all(Array.from({ length: 8 }, () => tool.execute(
        { to_agent: 'Sonny', context_summary: 'Kontekst', _invocationAgentName: 'Tola' }, {}, plugin,
    )));

    t.is(listy(vault).length, 3);
});

test('013: duch jako NADAWCA nie przemyci listu przez delegację', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const tool = createAgentDelegateTool();
    const res = await tool.execute(
        { to_agent: 'Sonny', context_summary: 'Kontekst', _invocationAgentName: 'Duch' },
        {}, plugin,
    ) as DelegateRes;

    t.true(res.success, 'sama propozycja delegacji przechodzi');
    t.is(listy(vault).length, 0, 'ale nazwa ducha NIE ląduje w cudzej skrzynce');
});

test('013: błąd „nie znaleziono" nie wylicza duchów', async t => {
    const { plugin } = makePlugin(AGENTS());
    const tool = createAgentDelegateTool();
    const res = await tool.execute(
        { to_agent: 'NieMaTakiego', context_summary: 'Kontekst', _invocationAgentName: 'Tola' },
        {}, plugin,
    ) as DelegateRes;

    t.false(res.success);
    t.false(res.error!.includes('Duch'), 'duch nie może pojawić się na liście dostępnych');
    t.true(res.error!.includes('Sonny'), 'widoczni agenci nadal są wypisani');
});

// ═════════ K17 (AUD-security-110) — delegacja podlega OSI POCZTY wołającego ═════════
// Oś narzędziowa (K3) ocenia w `MCPClient` nazwę `agent_delegate` — grupa `delegation`.
// Poczta to grupa `komunikator`, więc agent z WŁĄCZONĄ delegacją i WYŁĄCZONĄ pocztą
// (domyślny stan świeżego profilu) deponował tekst swojego modelu w cudzej skrzynce.
// Bramka stoi w chokepoincie `sendAgentMail`, więc łapie każdą drogę do skrzynki.

/** Wołający ma delegację, ale całą grupę `komunikator` na negatywnej liście. */
const BEZ_POCZTY = (): FakeAgent[] => [
    { name: 'Tola', disabled_tools: ['kom_send', 'kom_list', 'kom_read'] },
    { name: 'Sonny' },
];

test('110: agent bez poczty deleguje, ale NIE zostawia listu w cudzej skrzynce', async t => {
    const { plugin, vault } = makePlugin(BEZ_POCZTY());
    const tool = createAgentDelegateTool();

    const res = await tool.execute(
        { to_agent: 'Sonny', context_summary: 'Kontekst rozmowy', reason: 'bo tak', _invocationAgentName: 'Tola' },
        {}, plugin,
    ) as DelegateRes;

    // Sama propozycja przekazania rozmowy zostaje (kontekst niesie wynik) — jak przy duchu.
    t.true(res.success);
    t.is(res.context_summary, 'Kontekst rozmowy');
    t.is(listy(vault).length, 0, 'poczta wyłączona = zero plików w skrzynce Sonny’ego');
});

test('110: ten sam agent z włączoną pocztą deponuje list jak dotąd', async t => {
    const { plugin, vault } = makePlugin([{ name: 'Tola', disabled_tools: ['web_search'] }, { name: 'Sonny' }]);
    const tool = createAgentDelegateTool();

    const res = await tool.execute(
        { to_agent: 'Sonny', context_summary: 'Kontekst rozmowy', _invocationAgentName: 'Tola' },
        {}, plugin,
    ) as DelegateRes;

    t.true(res.success);
    t.is(listy(vault).length, 1, 'wyłączona wyszukiwarka nie ma nic wspólnego z pocztą');
});

test('110: tożsamość nadawcy z runtime — model nie podszyje się pod agenta z pocztą', async t => {
    const { plugin, vault } = makePlugin(BEZ_POCZTY());
    const tool = createAgentDelegateTool();

    // `from`/`_invocationAgentName` w worku argumentów: pierwsze pochodzi od modelu i nie
    // ma prawa nic znaczyć, drugie nadpisuje `MCPClient` przed wykonaniem.
    const res = await tool.execute(
        { to_agent: 'Sonny', context_summary: 'K', from: 'Sonny', _invocationAgentName: 'Tola' },
        {}, plugin,
    ) as DelegateRes;

    t.true(res.success);
    t.is(listy(vault).length, 0, 'oś liczona dla Toli, nie dla nazwy podanej przez model');
});

// ═════ K17 (AUD-security-109) — delegacja pyta o zgodę tak samo jak kom_send ═════

/** Wynik pojedynczego pytania o zgodę, w zakresie czytanym w asercjach. */
type ApprovalCall = { type?: string; toolName?: string; targetPath?: string; messageContent?: string };

/** Pełny łańcuch: prawdziwy rejestr + PermissionSystem + MCPClient nad tą samą atrapą poczty. */
function makeChain(agents: FakeAgent[]) {
    const { plugin, vault, toolRegistry } = makePlugin(agents);
    toolRegistry.registerTool(createAgentDelegateTool() as never);
    for (const tl of createKomunikatorTools()) toolRegistry.registerTool(tl as never);

    const approvals: ApprovalCall[] = [];
    const fullPlugin = Object.assign(plugin as object, {
        permissionSystem: new PermissionSystem(null, {}),
        approvalManager: {
            async requestApproval(a: ApprovalCall) { approvals.push(a); return { result: 'approve' }; },
        },
    });
    // `app` dotyka wyłącznie gałąź podglądu diffa dla `write` — tu nieużywana.
    const app = { vault: { getAbstractFileByPath: () => null, read: async () => '' } };
    const client = new MCPClient(
        app as unknown as ConstructorParameters<typeof MCPClient>[0],
        fullPlugin as unknown as ConstructorParameters<typeof MCPClient>[1],
        toolRegistry as unknown as ConstructorParameters<typeof MCPClient>[2],
    );
    return { client, approvals, vault };
}

test('109: agent_delegate wymaga zgody usera dokładnie jak kom_send (domyślne ustawienia)', async t => {
    const { client, approvals, vault } = makeChain(AGENTS());

    await client.executeToolCall(
        { name: 'kom_send', arguments: { to: 'Sonny', subject: 'Temat', content: 'Treść' } }, 'Tola',
    );
    await client.executeToolCall(
        { name: 'agent_delegate', arguments: { to_agent: 'Sonny', context_summary: 'Kontekst rozmowy' } }, 'Tola',
    );

    t.deepEqual(approvals.map(a => a.toolName), ['kom_send', 'agent_delegate'],
        'obie drogi do skrzynki pytają usera');
    t.deepEqual(approvals.map(a => a.type), ['agent.message', 'agent.message'],
        'ta sama akcja, bo skutek jest ten sam: list w cudzej skrzynce');
    t.is(approvals[1].targetPath, 'Sonny', 'modal mówi, do KOGO idzie list');
    t.is(approvals[1].messageContent, 'Kontekst rozmowy', 'i pokazuje, CO wychodzi');
    t.is(listy(vault).length, 2, 'po zgodzie oba listy powstają');
});

test('109: user, który wyciszył pocztę, wycisza też delegację (jeden przełącznik)', async t => {
    const { client, approvals, vault } = makeChain([
        { name: 'Tola', approvalToggles: { kom_send: false } },
        { name: 'Sonny' },
    ]);

    await client.executeToolCall(
        { name: 'agent_delegate', arguments: { to_agent: 'Sonny', context_summary: 'Kontekst' } }, 'Tola',
    );

    t.is(approvals.length, 0, 'ten sam przełącznik zdejmuje pytanie z obu dróg');
    t.is(listy(vault).length, 1);
});

// ─── AUD-security-128: zewnętrzny catch `agent_delegate` maskuje sekret ───
//
// Ta sama klasa co wyżej w `delegate`: wyjątek z zapisu poczty (adapter vaulta, błąd I/O
// z pełną ścieżką systemową) albo z odczytu ustawień wracał modelowi surowy.

test('128: catch w agent_delegate nie oddaje modelowi surowego komunikatu z sekretem', async t => {
    const SECRET = 'sk-ant-TAJNYKLUCZ0123456789abcdef';
    const plugin = {
        agentManager: {
            getAgent: () => {
                throw new Error(`adapter write failed: {"api_key":"${SECRET}"}`);
            },
            getAllAgents: () => [],
            getActiveAgent: () => ({ name: 'Jaskier' }),
            _emit: () => {},
        },
    } as unknown as DelegatePlugin;

    const res = await createAgentDelegateTool().execute(
        { to_agent: 'Tola', context_summary: 'kontekst' }, {}, plugin) as DelegateRes;

    t.false(res.success);
    t.false(String(res.error).includes(SECRET), `klucz jawny w zwrotce: ${res.error}`);
});
