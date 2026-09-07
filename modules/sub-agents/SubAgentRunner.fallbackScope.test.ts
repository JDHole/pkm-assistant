/**
 * SubAgentRunner._executeTool — KONTRAKT ścieżki AWARYJNEJ (bieg bez `MCPClient`).
 *
 * Kontekst (audyt nocny 2026-09-01, moduł 19). `_executeTool` ma dwie drogi wykonania
 * narzędzia i one NIE są równoważne:
 *
 *   (A) przez `MCPClient` — droga produkcyjna. Wiezie do klienta trzy rzeczy naraz:
 *       `autonomy`, `delegationDepth` i `scopeFolders` (bariera folderów suba, S33 Z1),
 *       plus whitelistę wołacza (K11). Klient wstrzykuje je dalej — do argumentów
 *       narzędzia i do `checkPermission`.
 *   (B) fallback `tool.execute(args, app, plugin)` — gdy `plugin?.mcpClient` jest puste
 *       (stary plugin, test bez DI, bieg z gołym obiektem plugin). Ta droga omija klienta,
 *       więc każdy znacznik musi dołożyć SAMA.
 *
 * Co jest tu spisane jako stan faktyczny:
 *
 *   1. GREEN — whitelista rodzic∩sub obowiązuje na OBU drogach. Odmowa zapada PRZED
 *      rozgałęzieniem, więc fallback nie jest dziurą w liście narzędzi.
 *   2. GREEN — `_invocationDelegationDepth` jedzie fallbackiem. To jest naprawa S33 Z1:
 *      bez niej `delegate` wołany tą drogą startowałby zawsze od zera, czyli rekurencja
 *      bez kagańca.
 *   3. ROZSTRZYGNIĘTE (F2.13, release 2.2.0/W3, 2026-09-04) — `scopeFolders` fallbackiem
 *      dalej NIE JEDZIE, ale to dziś ŚWIADOMY KONTRAKT, nie dziura do dopisania. Fallback
 *      nie ma jak wyegzekwować bariery folderów suba (żadna bramka `PermissionSystem` nie
 *      stoi na tej ścieżce — jedyna ochrona to whitelista NAZW z pkt 1), więc zamiast cicho
 *      rozszerzać suba z „konkretne foldery" na „cały vault" (fail-open), `_executeTool`
 *      ODMAWIA wykonania KAŻDEGO narzędzia, gdy wołacz podał niepusty `scopeFolders`
 *      (`t('subagent.tool_scope_unenforceable', …)`, fail-closed). Test charakteryzujący tę
 *      odmowę już istnieje w `SubAgentRunner.test.ts` („_executeTool (fallback bez MCPClient)
 *      ODMAWIA, gdy scopeFolders nie da się wyegzekwować" + siostrzany test na pustą listę)
 *      — nie dublowany tutaj. Ten plik zostaje jako kontrakt ścieżki (B) w całości; szczegóły
 *      decyzji: `modules/sub-agents/CLAUDE.md` gotcha K11.
 */
import test from 'ava';
import { SubAgentRunner as RuntimeSubAgentRunner } from './SubAgentRunner.js';

type TestRunner = {
    _executeTool(
        toolCall: { name: string; arguments: unknown },
        agentName: string,
        allowedToolNames: Set<string> | null,
        execOptions: Record<string, unknown>,
        onFailure?: () => void,
    ): Promise<string>;
};
const SubAgentRunner = RuntimeSubAgentRunner as unknown as new (options: unknown) => TestRunner;

/** Narzędzie-szpieg: zapisuje KOMPLET tego, co dostało, i oddaje stały tekst. */
function makeSpyTool(nazwa: string) {
    const widziane: Array<{ args: unknown; app: unknown; plugin: unknown }> = [];
    const tool = {
        name: nazwa,
        description: 'narzędzie testowe',
        inputSchema: { type: 'object', properties: {} },
        execute: async (args: unknown, app: unknown, plugin: unknown) => {
            widziane.push({ args, app, plugin });
            return 'zrobione';
        },
    };
    return { widziane, registry: { getTool: (n: string) => (n === nazwa ? tool : null) } };
}

/** Runner BEZ `mcpClient` — `plugin: {}` wymusza drogę (B), dokładnie jak w biegu bez DI. */
function makeRunnerBezKlienta(registry: unknown) {
    return new SubAgentRunner({ toolRegistry: registry, app: { znacznik: 'app' }, plugin: {} });
}

test('fallback bez MCPClient: whitelista rodzic∩sub obowiązuje tak samo jak przez klienta', async t => {
    const { widziane, registry } = makeSpyTool('read');
    const runner = makeRunnerBezKlienta(registry);

    let padlo = false;
    const wynik = await runner._executeTool(
        { name: 'write', arguments: {} },
        'Jaskier',
        new Set(['read']),
        {},
        () => { padlo = true; },
    );

    t.is(widziane.length, 0, 'Narzędzie spoza whitelisty NIE ma prawa się wykonać na ścieżce awaryjnej.');
    t.true(padlo, 'Odmowa whitelisty powinna zgłosić się hakiem `onFailure`.');
    t.true(
        typeof wynik === 'string' && wynik.length > 0,
        'Odmowa ma wrócić do transkryptu suba komunikatem, nie pustką.',
    );
});

test('fallback bez MCPClient: znacznik głębokości delegacji jedzie do argumentów narzędzia (S33 Z1)', async t => {
    const { widziane, registry } = makeSpyTool('delegate');
    const runner = makeRunnerBezKlienta(registry);

    await runner._executeTool(
        { name: 'delegate', arguments: { task: 'zejdź piętro niżej' } },
        'Jaskier',
        new Set(['delegate']),
        { delegationDepth: 2 },
    );

    t.is(widziane.length, 1, 'Narzędzie z whitelisty miało się wykonać dokładnie raz.');
    const args = widziane[0].args as Record<string, unknown>;
    t.is(
        args._invocationDelegationDepth,
        2,
        'Bez tego znacznika `delegate` wołany fallbackiem startuje od zera — rekurencja bez kagańca.',
    );
    t.is(args.task, 'zejdź piętro niżej', 'Znacznik nie ma prawa zjeść oryginalnych argumentów.');
});

test('fallback bez MCPClient: głębokość 0 NIE dokłada znacznika (kontrakt: tylko bieg zagnieżdżony)', async t => {
    const { widziane, registry } = makeSpyTool('read');
    const runner = makeRunnerBezKlienta(registry);

    await runner._executeTool(
        { name: 'read', arguments: { path: 'Notatki/a.md' } },
        'Jaskier',
        new Set(['read']),
        { delegationDepth: 0 },
    );

    const args = widziane[0].args as Record<string, unknown>;
    t.false(
        '_invocationDelegationDepth' in args,
        'Przy głębokości 0 znacznik jest zbędny i nie powinien zaśmiecać argumentów narzędzia.',
    );
});
