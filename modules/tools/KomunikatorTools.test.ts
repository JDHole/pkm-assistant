/**
 * kom_send / kom_list / kom_read — kontrakt trzech prymitywów poczty.
 *
 * Narzędzia dostają PRAWDZIWY `KomunikatorManager` na atrapie vaulta, więc test dotyka
 * pełnej ścieżki: schema → walidacja adresata (widoczność) → zapis pliku → odczyt.
 */
import test from 'ava';
import { createKomunikatorTools } from './KomunikatorTools.js';
import type { KomPlugin, KomunikatorArgs } from './KomunikatorTools.js';
// Bramka poczty pyta o oś narzędziową WOŁAJĄCEGO — atrapa niesie PRAWDZIWY rejestr,
// żeby liczyła ją ta sama metoda co w produkcji (`ToolRegistry.checkToolAxis`).
import { ToolRegistry } from './ToolRegistry.js';
import { KomunikatorManager, KOM_RATE_WINDOW_MS, KOM_HOP_LIMIT } from '../komunikator/KomunikatorManager.js';
// Atrapa AgentManagera deleguje do PRAWDZIWYCH helperów widoczności — testujemy realny
// filtr ducha, nie jego imitację. (Deep import dozwolony w testach — patrz eslint.config.js.)
import { isKomunikatorVisible, listKomunikatorAgents, findKomunikatorAgent } from '../komunikator/visibility.js';

/**
 * Wynik prymitywu poczty czytany w asercjach. Pola typowane POD UŻYCIE w tym pliku
 * (`error`/`messages` bez `?`), nie pod pełny kontrakt runtime'u — testy i tak wchodzą
 * tylko w tę gałąź, którą właśnie sprawdzają.
 */
type KomRes = {
    success?: boolean;
    error: string;
    count?: number;
    unread?: number;
    messages: Array<{ id: string; od: string; temat: string; data: string; przeczytana: boolean }>;
    tresc?: string;
    od?: string;
    id?: string;
};

/** Narzędzie poczty w kształcie, w jakim woła je ten test. */
type KomTool = {
    name: string;
    serverName?: string;
    execute(args: KomunikatorArgs, app: unknown, plugin: KomPlugin): Promise<KomRes>;
};

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

/**
 * Agent w atrapie: nazwa + (opcjonalnie) flaga ducha czytana przez PRAWDZIWY filtr
 * + negatywna lista narzędzi, czyli oś, którą liczy `ToolRegistry.checkToolAxis`.
 */
type FakeAgent = { name: string; komunikator_visible?: boolean; disabled_tools?: string[] };

/** Zdarzenie wypchnięte przez atrapę AgentManagera. */
type EmittedEvent = { event: string; data: unknown };

/**
 * @param opts.withKomunikator - domyślnie true
 * @param opts.limits - nadpisania `settings.pkmAssistant.limits` (rate-limit)
 * @param opts.now - zegar na sznurku
 */
function makePlugin(
    agents: FakeAgent[],
    { withKomunikator = true, limits, now }: {
        withKomunikator?: boolean;
        limits?: Record<string, number>;
        now?: () => number;
    } = {},
) {
    const emitted: EmittedEvent[] = [];
    const agentManager: Record<string, unknown> = {
        _emit: (event: string, data: unknown) => emitted.push({ event, data }),
        getAllAgents: () => agents,
        getAgent: (name: string) => agents.find(a => a.name === name) || null,
        getActiveAgent: () => agents[0] || null,
    };
    agentManager.isKomunikatorVisible = (a: FakeAgent) => isKomunikatorVisible(a);
    agentManager.listKomunikatorAgents = () => listKomunikatorAgents(agentManager);
    agentManager.findKomunikatorAgent = (name: string) => findKomunikatorAgent(agentManager, name);
    const vault = fakeVault();
    agentManager.komunikatorManager = withKomunikator
        ? new KomunikatorManager(vault, agentManager, now ? { now } : {})
        : null;
    // Rejestr jest w KAŻDEJ atrapie — dzięki temu cały zestaw testów biegnie z żywą bramką
    // osi i pilnuje zera regresji.
    const plugin = {
        agentManager,
        toolRegistry: new ToolRegistry(),
        env: { settings: { pkmAssistant: { limits: limits || {} } } },
    } as unknown as KomPlugin;
    return { plugin, agentManager, vault, emitted };
}

function tools(_plugin: KomPlugin): Record<string, KomTool> {
    const list = createKomunikatorTools();
    return Object.fromEntries(list.map(tl => [tl.name, tl])) as unknown as Record<string, KomTool>;
}

const AGENTS = (): FakeAgent[] => [{ name: 'Tola' }, { name: 'Sonny' }, { name: 'Duch', komunikator_visible: false }];

test('trzy narzędzia, wszystkie na serwerze `komunikator`', t => {
    const list = createKomunikatorTools();
    t.deepEqual(list.map(tl => tl.name), ['kom_send', 'kom_list', 'kom_read']);
    t.true(list.every(tl => tl.serverName === 'komunikator'));
    // Agent NIE MA narzędzia kasowania poczty (create-only).
    t.false(list.some(tl => /delete|remove|clear/.test(tl.name)));
});

test('kom_send: wysyła w imieniu wołającego, nie w imieniu podanym przez model', async t => {
    const { plugin, vault, emitted } = makePlugin(AGENTS());
    const res = await tools(plugin).kom_send.execute(
        { to: 'Sonny', subject: 'Temat', content: 'Treść', _invocationAgentName: 'Tola', from: 'PODROBIONY' },
        {}, plugin,
    );

    t.true(res.success);
    const saved = [...vault._files.values()][0];
    t.true(saved.includes('od: "Tola"'));
    t.false(saved.includes('PODROBIONY'));
    t.is(emitted.at(-1)!.event, 'communicator:message_sent');
});

test('kom_send: nieznana nazwa i agent-duch dają IDENTYCZNY błąd (zero przecieku)', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const send = tools(plugin).kom_send;

    const ghost = await send.execute({ to: 'Duch', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);
    const typo = await send.execute({ to: 'NieMaTakiego', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);

    t.false(ghost.success);
    t.false(typo.success);
    t.is(ghost.error.replace('Duch', 'X'), typo.error.replace('NieMaTakiego', 'X'));
    t.false(ghost.error.includes('Duch,'), 'duch nie może pojawić się na liście dostępnych');
    t.false(typo.error.includes('Duch'), 'duch nie może pojawić się na liście dostępnych');
    t.is(vault._files.size, 0, 'nic nie zostało zapisane');
});

test('kom_send: literówka w wielkości liter nadal trafia do adresata', async t => {
    const { plugin } = makePlugin(AGENTS());
    const res = await tools(plugin).kom_send.execute(
        { to: 'sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin,
    );
    t.true(res.success);
});

test('kom_send: do samego siebie = odmowa', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const res = await tools(plugin).kom_send.execute(
        { to: 'Tola', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin,
    );
    t.false(res.success);
    t.is(vault._files.size, 0);
});

test('niewidzialny agent nie wysyła i nie czyta — dostaje uczciwy powód (widzi go tylko on)', async t => {
    const { plugin } = makePlugin(AGENTS());
    const tl = tools(plugin);
    const as = { _invocationAgentName: 'Duch' };

    const send = await tl.kom_send.execute({ ...as, to: 'Sonny', subject: 's', content: 'c' }, {}, plugin);
    const list = await tl.kom_list.execute({ ...as }, {}, plugin);
    const read = await tl.kom_read.execute({ ...as, id: 'msg-1' }, {}, plugin);

    for (const res of [send, list, read]) {
        t.false(res.success);
        t.true(res.error.length > 0);
    }
    t.is(send.error, list.error, 'ten sam powód dla wszystkich trzech');
});

test('kom_list: same nagłówki własnej skrzynki, bez treści', async t => {
    const { plugin } = makePlugin(AGENTS());
    const tl = tools(plugin);
    await tl.kom_send.execute({ to: 'Sonny', subject: 'Brief', content: 'TAJNA TREŚĆ', _invocationAgentName: 'Tola' }, {}, plugin);

    const mine = await tl.kom_list.execute({ _invocationAgentName: 'Sonny' }, {}, plugin);
    t.true(mine.success);
    t.is(mine.count, 1);
    t.is(mine.unread, 1);
    t.is(mine.messages[0].od, 'Tola');
    t.is(mine.messages[0].temat, 'Brief');
    t.false(JSON.stringify(mine).includes('TAJNA'), 'lista nie niesie treści');

    // Skrzynka nadawcy pusta — agent widzi WYŁĄCZNIE swoją.
    const sender = await tl.kom_list.execute({ _invocationAgentName: 'Tola' }, {}, plugin);
    t.is(sender.count, 0);
});

test('kom_read: zwraca treść i odhacza wiadomość jako przeczytaną przez AI', async t => {
    const { plugin } = makePlugin(AGENTS());
    const tl = tools(plugin);
    await tl.kom_send.execute({ to: 'Sonny', subject: 'Brief', content: 'pełna treść', _invocationAgentName: 'Tola' }, {}, plugin);
    const { messages } = await tl.kom_list.execute({ _invocationAgentName: 'Sonny' }, {}, plugin);

    const read = await tl.kom_read.execute({ id: messages[0].id, _invocationAgentName: 'Sonny' }, {}, plugin);
    t.true(read.success);
    t.is(read.tresc, 'pełna treść');
    t.is(read.od, 'Tola');

    const after = await tl.kom_list.execute({ _invocationAgentName: 'Sonny' }, {}, plugin);
    t.is(after.unread, 0);
    t.true(after.messages[0].przeczytana);
});

test('kom_read: agent nie przeczyta cudzej wiadomości (skrzynka zawsze własna)', async t => {
    const { plugin } = makePlugin(AGENTS());
    const tl = tools(plugin);
    await tl.kom_send.execute({ to: 'Sonny', subject: 's', content: 'tajne', _invocationAgentName: 'Tola' }, {}, plugin);
    const { messages } = await tl.kom_list.execute({ _invocationAgentName: 'Sonny' }, {}, plugin);

    // Tola zna id (sama wysłała), ale czyta ze SWOJEJ skrzynki — tam tego pliku nie ma.
    const res = await tl.kom_read.execute({ id: messages[0].id, _invocationAgentName: 'Tola' }, {}, plugin);
    t.false(res.success);
});

test('kom_read: id z traversalem odbite', async t => {
    const { plugin } = makePlugin(AGENTS());
    const res = await tools(plugin).kom_read.execute(
        { id: '../../../Sekrety/klucze', _invocationAgentName: 'Sonny' }, {}, plugin,
    );
    t.false(res.success);
});

test('wyłączony komunikator: wszystkie trzy odmawiają zamiast wybuchać', async t => {
    const { plugin } = makePlugin(AGENTS(), { withKomunikator: false });
    const tl = tools(plugin);
    for (const res of [
        await tl.kom_send.execute({ to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin),
        await tl.kom_list.execute({ _invocationAgentName: 'Tola' }, {}, plugin),
        await tl.kom_read.execute({ id: 'msg-1', _invocationAgentName: 'Tola' }, {}, plugin),
    ]) {
        t.false(res.success);
        t.truthy(res.error);
    }
});

// ═════════════ strażnicy poczty (rate-limit + licznik odbić) ═════════════

test('B1: po wyczerpaniu limitu kom_send odmawia i NIC nie zapisuje', async t => {
    const { plugin, vault } = makePlugin(AGENTS(), { limits: { kom_send_rate_max: 2 } });
    const send = tools(plugin).kom_send;
    const args = () => ({ to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' });

    t.true((await send.execute(args(), {}, plugin)).success);
    t.true((await send.execute(args(), {}, plugin)).success);

    const blocked = await send.execute(args(), {}, plugin);
    t.false(blocked.success);
    t.true(blocked.error.includes('Sonny'), 'agent wie, do KOGO nie może teraz pisać');
    t.true(blocked.error.includes('2'), 'komunikat niesie limit');
    t.is(vault._files.size, 2, 'trzeci list nie powstał');
});

test('B1: limit jest per para — blokada do jednego adresata nie zamyka poczty do innych', async t => {
    const { plugin } = makePlugin([...AGENTS(), { name: 'Jaskier' }], { limits: { kom_send_rate_max: 1 } });
    const send = tools(plugin).kom_send;

    await send.execute({ to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);
    const doSonny = await send.execute({ to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);
    const doJaskra = await send.execute({ to: 'Jaskier', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);

    t.false(doSonny.success);
    t.true(doJaskra.success);
});

test('B1: rate-limit NIE zdradza duchów — literówka i duch dalej dają ten sam błąd', async t => {
    const { plugin } = makePlugin(AGENTS(), { limits: { kom_send_rate_max: 1 } });
    const send = tools(plugin).kom_send;

    // Wyczerpujemy pulę na ducha i na literówkę — obie próby odpadają PRZED rate-limitem.
    for (let i = 0; i < 3; i++) {
        await send.execute({ to: 'Duch', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);
    }
    const ghost = await send.execute({ to: 'Duch', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);
    const typo = await send.execute({ to: 'NieMaTakiego', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);

    t.is(ghost.error.replace('Duch', 'X'), typo.error.replace('NieMaTakiego', 'X'));
});

test('B1: po wyjściu z okna 10 min agent znów może pisać', async t => {
    let now = 1_000_000;
    const { plugin } = makePlugin(AGENTS(), { limits: { kom_send_rate_max: 1 }, now: () => now });
    const send = tools(plugin).kom_send;
    const args = () => ({ to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' });

    t.true((await send.execute(args(), {}, plugin)).success);
    t.false((await send.execute(args(), {}, plugin)).success);

    now += KOM_RATE_WINDOW_MS + 1;
    t.true((await send.execute(args(), {}, plugin)).success);
});

test('sufit NADAWCY blokuje mimo wolnych par — i mówi to innym komunikatem', async t => {
    const { plugin, vault } = makePlugin(
        [...AGENTS(), { name: 'Jaskier' }],
        { limits: { kom_send_rate_max: 5, kom_send_rate_max_sender: 2 } },
    );
    const send = tools(plugin).kom_send;
    const doKogo = (to: string) => ({ to, subject: 's', content: 'c', _invocationAgentName: 'Tola' });

    t.true((await send.execute(doKogo('Sonny'), {}, plugin)).success);
    t.true((await send.execute(doKogo('Jaskier'), {}, plugin)).success);

    // Trzeci adresat jest zupełnie świeży (limit pary 5, licznik 0), a mimo to odmowa.
    const blocked = await send.execute(doKogo('Sonny'), {}, plugin);
    t.false(blocked.success);
    t.false(blocked.error.includes('Sonny'), 'to nie jest odmowa „do tego adresata" — sufit dotyczy CAŁEJ puli');
    t.true(blocked.error.includes('2'), 'komunikat niesie sufit nadawcy');
    t.is(vault._files.size, 2, 'trzeci list nie powstał');

    // Inny nadawca ma własną pulę.
    t.true((await send.execute({ ...doKogo('Sonny'), _invocationAgentName: 'Jaskier' }, {}, plugin)).success);
});

test('B2: zwykła rozmowa z userem wysyła wiadomość z hop 0', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    await tools(plugin).kom_send.execute(
        { to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);

    t.true([...vault._files.values()][0].includes('hop: 0'));
});

test('B2: łańcuch odbić rośnie z każdym „przeczytaj i odpisz", a na trzecim pęka', async t => {
    const { plugin } = makePlugin([{ name: 'A' }, { name: 'B' }]);
    const tl = tools(plugin);

    // A→B (hop 0)
    await tl.kom_send.execute({ to: 'B', subject: 's', content: 'c', _invocationAgentName: 'A' }, {}, plugin);
    const inboxB1 = await tl.kom_list.execute({ _invocationAgentName: 'B' }, {}, plugin);
    await tl.kom_read.execute({ id: inboxB1.messages[0].id, _invocationAgentName: 'B' }, {}, plugin);

    // B odpisuje (hop 1)
    t.true((await tl.kom_send.execute({ to: 'A', subject: 's', content: 'c', _invocationAgentName: 'B' }, {}, plugin)).success);
    const inboxA = await tl.kom_list.execute({ _invocationAgentName: 'A' }, {}, plugin);
    await tl.kom_read.execute({ id: inboxA.messages[0].id, _invocationAgentName: 'A' }, {}, plugin);

    // A odpisuje (hop 2)
    t.true((await tl.kom_send.execute({ to: 'B', subject: 's', content: 'c', _invocationAgentName: 'A' }, {}, plugin)).success);
    const inboxB2 = await tl.kom_list.execute({ _invocationAgentName: 'B' }, {}, plugin);
    const swiezy = inboxB2.messages.find(m => !m.przeczytana);
    await tl.kom_read.execute({ id: swiezy!.id, _invocationAgentName: 'B' }, {}, plugin);

    // B chciałby odpisać po raz trzeci — STOP.
    const stop = await tl.kom_send.execute({ to: 'A', subject: 's', content: 'c', _invocationAgentName: 'B' }, {}, plugin);
    t.false(stop.success);
    t.truthy(stop.error);
    t.not(stop.error, 'mcp.kom_send.hop_limit', 'i18n rozwiązane, nie goły klucz');
});

test('B2: przeczytanie wiadomości bez pola hop (stara poczta) nie odcina wysyłki', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const tl = tools(plugin);
    // Wiadomość zapisana ręcznie w STARYM formacie — bez `hop` we frontmatterze.
    vault._files.set('.pkm-assistant/komunikator/inbox/sonny/msg-1.md', [
        '---', 'type: kom-message', 'od: "Tola"', 'do: "Sonny"', 'temat: "Stare"',
        'data: "2026-07-01 10:00"', 'user_read: false', 'ai_read: false', '---', '', 'treść', '',
    ].join('\n'));

    await tl.kom_read.execute({ id: 'msg-1', _invocationAgentName: 'Sonny' }, {}, plugin);
    const res = await tl.kom_send.execute(
        { to: 'Tola', subject: 's', content: 'c', _invocationAgentName: 'Sonny' }, {}, plugin);

    t.true(res.success, 'stara wiadomość liczy się jako hop 0 → odpowiedź to dopiero hop 1');
    const wyslana = [...vault._files.entries()].find(([p]) => p.includes('/tola/'))![1];
    t.true(wyslana.includes('hop: 1'));
});

test('B2: próg odmowy w narzędziu zgadza się ze stałą managera', t => {
    t.is(KOM_HOP_LIMIT, 3, 'gdy zmienisz próg, zmień go w OBU miejscach (świadoma duplikacja)');
});

// ══════════ bramki poczty pod równoległością ══════════

test('10× kom_send przez Promise.all przy limicie 5 → dokładnie 5 zapisów i 5 odmów', async t => {
    const { plugin, vault } = makePlugin(AGENTS(), { limits: { kom_send_rate_max: 5 } });
    const send = tools(plugin).kom_send;

    // Jedna odpowiedź modelu = jeden wsad tool_calls; AgentLoop odpala go przez Promise.all.
    const results = await Promise.all(Array.from({ length: 10 }, () => send.execute(
        { to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin,
    )));

    t.is(results.filter(r => r.success).length, 5, 'limit 5 = pięć przepustek');
    t.is(results.filter(r => r.success === false).length, 5, 'reszta odbita');
    t.is(vault._files.size, 5, 'na dysku dokładnie tyle plików, ile przepustek');
});

test('równoległy wsad nie nadpisuje plików — każdy list ma własną nazwę', async t => {
    // Zegar stoi w miejscu: wszystkie wysyłki celują w TEN SAM `msg-<stamp>`.
    const { plugin, vault } = makePlugin(AGENTS(), { limits: { kom_send_rate_max: 50 }, now: () => 1_700_000_000_000 });
    const send = tools(plugin).kom_send;

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => send.execute(
        { to: 'Sonny', subject: `temat ${i}`, content: `tresc ${i}`, _invocationAgentName: 'Tola' }, {}, plugin,
    )));

    const ok = results.filter(r => r.success);
    t.is(ok.length, 6);
    t.is(new Set(ok.map(r => r.id)).size, 6, 'sześć RÓŻNYCH id');
    t.is(vault._files.size, 6, 'sześć plików — żaden nie nadpisał kolegi');
    const tresci = new Set([...vault._files.values()].map(v => v.trim().split('\n').at(-1)));
    t.is(tresci.size, 6, 'treść każdego listu ocalała');
});

test('dwaj RÓŻNI nadawcy piszą równolegle do jednej skrzynki — nic nie ginie', async t => {
    const { plugin, vault } = makePlugin([{ name: 'A' }, { name: 'B' }, { name: 'C' }], { now: () => 1_700_000_000_000 });
    const send = tools(plugin).kom_send;

    await Promise.all([
        ...Array.from({ length: 5 }, (_, i) => send.execute({ to: 'C', subject: 'a', content: `A${i}`, _invocationAgentName: 'A' }, {}, plugin)),
        ...Array.from({ length: 5 }, (_, i) => send.execute({ to: 'C', subject: 'b', content: `B${i}`, _invocationAgentName: 'B' }, {}, plugin)),
    ]);

    t.is(vault._files.size, 10, 'dziesięć wysyłek = dziesięć plików');
});

test('kom_read i kom_send w JEDNEJ turze — wysłany list niesie hop przeczytanego + 1', async t => {
    const { plugin, vault } = makePlugin([{ name: 'Tester' }, { name: 'Odbiorca' }]);
    const tl = tools(plugin);
    // Podłożona wiadomość z hop 1 (id świeże — łańcuch w oknie TTL).
    const stamp = Date.now();
    vault._files.set(`.pkm-assistant/komunikator/inbox/tester/msg-${stamp}.md`, [
        '---', 'type: kom-message', 'od: "Odbiorca"', 'do: "Tester"', 'temat: "T"',
        'data: "2026-08-22 10:00"', 'user_read: false', 'ai_read: false', 'hop: 1', '---', '', 'tresc', '',
    ].join('\n'));

    // Model emituje OBA wywołania w jednej paczce — kom_read pierwsze.
    await Promise.all([
        tl.kom_read.execute({ id: `msg-${stamp}`, _invocationAgentName: 'Tester' }, {}, plugin),
        tl.kom_send.execute({ to: 'Odbiorca', subject: 's', content: 'c', _invocationAgentName: 'Tester' }, {}, plugin),
    ]);

    const wyslana = [...vault._files.entries()].find(([p]) => p.includes('/odbiorca/'));
    t.truthy(wyslana, 'list wyszedł');
    t.true(wyslana![1].includes('hop: 2'), 'hop przeczytanego (1) + 1');
});

test('kom_read w tej samej turze dobija do HOP_LIMIT — kom_send odmawia', async t => {
    const { plugin, vault } = makePlugin([{ name: 'Tester' }, { name: 'Odbiorca' }]);
    const tl = tools(plugin);
    const stamp = Date.now();
    vault._files.set(`.pkm-assistant/komunikator/inbox/tester/msg-${stamp}.md`, [
        '---', 'type: kom-message', 'od: "Odbiorca"', 'do: "Tester"', 'temat: "T"',
        'data: "2026-08-22 10:00"', 'user_read: false', 'ai_read: false', 'hop: 2', '---', '', 'tresc', '',
    ].join('\n'));

    const [, wyslij] = await Promise.all([
        tl.kom_read.execute({ id: `msg-${stamp}`, _invocationAgentName: 'Tester' }, {}, plugin),
        tl.kom_send.execute({ to: 'Odbiorca', subject: 's', content: 'c', _invocationAgentName: 'Tester' }, {}, plugin),
    ]);

    t.false(wyslij.success, 'hop 3 = STOP');
    t.is([...vault._files.keys()].filter(p => p.includes('/odbiorca/')).length, 0);
});

test('duch jako nadawca kom_send — odmowa i zero plików', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const res = await tools(plugin).kom_send.execute(
        { to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Duch' }, {}, plugin,
    );
    t.false(res.success);
    t.is(vault._files.size, 0);
});

test('żadne narzędzie kom_* nie kasuje ani nie przepisuje cudzej wiadomości', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const tl = tools(plugin);
    await tl.kom_send.execute({ to: 'Sonny', subject: 'Temat', content: 'Treść oryginalna', _invocationAgentName: 'Tola' }, {}, plugin);
    const [path] = [...vault._files.keys()];
    const przed = vault._files.get(path)!;

    const lista = await tl.kom_list.execute({ _invocationAgentName: 'Sonny' }, {}, plugin);
    await tl.kom_read.execute({ id: lista.messages[0].id, _invocationAgentName: 'Sonny' }, {}, plugin);

    const po = vault._files.get(path)!;
    t.is(vault._files.size, 1, 'plik nadal jest — kom_read nic nie skasował');
    t.true(po.includes('Treść oryginalna'), 'treść nietknięta');
    t.true(po.includes('od: "Tola"'), 'nagłówek nadawcy nietknięty');
    // Jedyna dozwolona różnica to ptaszek `ai_read` (auto-ptaszek AI).
    t.is(przed.replace('ai_read: false', 'ai_read: true'), po);
});

// ═════ bramką jest OŚ POCZTY WOŁAJĄCEGO, nie nazwa narzędzia ═════
// `sendAgentMail` to jedyna droga do cudzej skrzynki, więc to ona pyta rejestr o
// `kom_send` agenta, który ją zawołał. Dzięki temu reguła obowiązuje każdą drogę — także
// `agent_delegate`, którego oś narzędziową MCPClient ocenia pod grupą `delegation`.

/** Agent ze świeżego profilu: cała grupa `komunikator` na negatywnej liście. */
const BEZ_POCZTY = (): FakeAgent[] => [
    { name: 'Tola', disabled_tools: ['kom_send', 'kom_list', 'kom_read'] },
    { name: 'Sonny' },
];

test('agent z wyłączoną grupą `komunikator` nie wyśle listu — plik NIE powstaje', async t => {
    const { plugin, vault } = makePlugin(BEZ_POCZTY());

    const res = await tools(plugin).kom_send.execute(
        { to: 'Sonny', subject: 'Temat', content: 'Treść', _invocationAgentName: 'Tola' }, {}, plugin,
    );

    t.false(res.success, 'odmowa fail-closed');
    t.is(vault._files.size, 0, 'żaden plik nie wylądował w cudzej skrzynce');
});

test('wyłączone samo `kom_send` (reszta poczty ON) też odbija wysyłkę', async t => {
    const { plugin, vault } = makePlugin([{ name: 'Tola', disabled_tools: ['kom_send'] }, { name: 'Sonny' }]);

    const res = await tools(plugin).kom_send.execute(
        { to: 'Sonny', subject: 'Temat', content: 'Treść', _invocationAgentName: 'Tola' }, {}, plugin,
    );

    t.false(res.success);
    t.is(vault._files.size, 0);
});

test('odmowa nie zdradza, kto istnieje — ten sam komunikat dla znanego i nieznanego adresata', async t => {
    const { plugin } = makePlugin(BEZ_POCZTY());
    const tl = tools(plugin);

    const znany = await tl.kom_send.execute({ to: 'Sonny', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);
    const nieznany = await tl.kom_send.execute({ to: 'NieMaTakiego', subject: 's', content: 'c', _invocationAgentName: 'Tola' }, {}, plugin);

    t.is(znany.error, nieznany.error, 'bramka osi stoi PRZED rozwiązaniem adresata');
});

test('agent z włączoną pocztą wysyła jak dotąd (zero regresji)', async t => {
    const { plugin, vault } = makePlugin([{ name: 'Tola', disabled_tools: ['write'] }, { name: 'Sonny' }]);

    const res = await tools(plugin).kom_send.execute(
        { to: 'Sonny', subject: 'Temat', content: 'Treść', _invocationAgentName: 'Tola' }, {}, plugin,
    );

    t.true(res.success, 'wyłączone `write` nie ma nic wspólnego z pocztą');
    t.is(vault._files.size, 1);
});

test('bramka dotyczy WYSYŁKI — czytanie własnej skrzynki idzie swoją drogą', async t => {
    // `kom_list`/`kom_read` mają własną bramkę osi w `MCPClient` (po nazwie narzędzia).
    // Chokepoint poczty ich nie dotyka, bo nie prowadzi do CUDZEJ skrzynki.
    const { plugin, vault } = makePlugin([{ name: 'Tola' }, { name: 'Sonny', disabled_tools: ['kom_send'] }]);
    const tl = tools(plugin);
    await tl.kom_send.execute({ to: 'Sonny', subject: 'Temat', content: 'Treść', _invocationAgentName: 'Tola' }, {}, plugin);

    const lista = await tl.kom_list.execute({ _invocationAgentName: 'Sonny' }, {}, plugin);

    t.is(vault._files.size, 1);
    t.is(lista.count, 1, 'adresat bez prawa wysyłki nadal czyta swoją skrzynkę');
});

// ── adresat liczony RAZ, przed bramką ─────────────────────
// `execute` czytał cztery synonimy (`to`/`to_agent`/`agent`/`target`), a switch w
// `MCPClient` tylko dwa i wpadał na literał `'agent'`. Modal mówił „do agenta »agent«",
// a klik „Zawsze zezwalaj" zapisywał regułę `agent.message::agent` — auto-zgodę na pocztę
// do DOWOLNEGO adresata wysłaną tym samym synonimem.

/** Kształt bramki, o który pyta ten blok (fabryka dokłada go do `kom_send`). */
type KomExtractor = (
    args: KomunikatorArgs,
    ctx: { agentName: string | null; plugin: unknown },
) => { targetPath?: string; approvalContext?: Record<string, unknown> };

function komSendExtractor(plugin: KomPlugin): KomExtractor {
    const send = createKomunikatorTools().find(tl => tl.name === 'kom_send') as unknown as
        { contextExtractor?: KomExtractor };
    if (typeof send.contextExtractor !== 'function') throw new Error('kom_send bez contextExtractor');
    const fn = send.contextExtractor;
    return (args, ctx) => fn(args, { ...ctx, plugin });
}

test('cztery synonimy adresata dają JEDEN kanon dla okna zgody', t => {
    const { plugin } = makePlugin(AGENTS());
    const extract = komSendExtractor(plugin);
    const base = { subject: 'Temat', content: 'Treść', _invocationAgentName: 'Tola' };
    const ctx = { agentName: 'Tola', plugin };

    const cele = (['to', 'to_agent', 'agent', 'target'] as const).map(
        pole => extract({ ...base, [pole]: 'Sonny' }, ctx).targetPath,
    );

    t.deepEqual(cele, ['Sonny', 'Sonny', 'Sonny', 'Sonny']);
    t.false(cele.includes('agent'), 'literał „agent" nie może być celem reguły zgody');
});

test('kanon = nazwa z rejestru, więc modal i reguła nie rozjeżdżają się na wielkości liter', t => {
    const { plugin } = makePlugin(AGENTS());
    const extract = komSendExtractor(plugin);
    const ctx = { agentName: 'Tola', plugin };

    t.is(extract({ target: 'sonny', _invocationAgentName: 'Tola' }, ctx).targetPath, 'Sonny');
    t.is(extract({ to: 'SONNY', _invocationAgentName: 'Tola' }, ctx).targetPath, 'Sonny');
});

test('cel bramki = adresat, który REALNIE dostał list (jeden ciąg)', async t => {
    const { plugin, vault } = makePlugin(AGENTS());
    const args = { target: 'sonny', subject: 'Temat', content: 'Treść', _invocationAgentName: 'Tola' };

    const cel = komSendExtractor(plugin)(args, { agentName: 'Tola', plugin }).targetPath;
    const res = await tools(plugin).kom_send.execute(args, {}, plugin);

    t.true(res.success);
    t.is(cel, 'Sonny', 'bramka widzi kanon, nie surowy synonim');
    t.is(vault._files.size, 1);
    // Skrzynka celu z bramki NAPRAWDĘ dostała list — jeden ciąg po obu stronach.
    const skrzynka = await tools(plugin).kom_list.execute({ _invocationAgentName: cel }, {}, plugin);
    t.is(skrzynka.count, 1);
});

test('okno zgody dostaje temat i treść (podgląd, nie sam adresat)', t => {
    const { plugin } = makePlugin(AGENTS());
    const ctx = { agentName: 'Tola', plugin };
    const out = komSendExtractor(plugin)(
        { agent: 'Sonny', subject: 'Temat', content: 'Treść', _invocationAgentName: 'Tola' }, ctx,
    );
    t.is(out.approvalContext?.messageSubject, 'Temat');
    t.is(out.approvalContext?.messageContent, 'Treść');
});

test('nieznany adresat NIE zapada w wieloznacznik — cel zostaje dosłowny', t => {
    const { plugin } = makePlugin(AGENTS());
    const ctx = { agentName: 'Tola', plugin };
    t.is(komSendExtractor(plugin)({ target: 'NieMaTakiego', _invocationAgentName: 'Tola' }, ctx).targetPath, 'NieMaTakiego');
    t.is(komSendExtractor(plugin)({ _invocationAgentName: 'Tola' }, ctx).targetPath, '');
});
