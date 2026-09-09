/**
 * Bariera `scope.folders` sub-agenta.
 *
 * Do tej pory `scope` z SUB_AGENT.yaml był wyłącznie tekstem w prompcie: sub mógł go
 * zignorować i sięgnąć wszędzie tam, gdzie sięgał rodzic. Ten test pilnuje, że foldery
 * są REALNĄ bramką i że jest to KONIUNKCJA — nie zastępuje żadnej reguły rodzica.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import { PermissionSystem } from './PermissionSystem.js';
import { MCPClient } from '../../modules/tools/MCPClient.js';
import type { GuardedAgent } from './AccessGuard.js';

/**
 * Trzy typy pomocnicze zamiast dotykania `modules/tools/MCPClient.js` (nie jest jeszcze przepisany na typy):
 * jego JSDoc deklaruje `app` jako `Object` (a te testy świadomie podają `null` — vault nie jest
 * tu w ogóle ruszany), wymaga `toolCall.id` (którego nie podaje ani ten test, ani realni wołacze)
 * i zwraca surowe `Object` (bez pól, których pilnują asercje).
 */
type McpApp = ConstructorParameters<typeof MCPClient>[0];
type ToolCallArg = Parameters<InstanceType<typeof MCPClient>['executeToolCall']>[0];
type ToolCallOutcome = {
    success?: boolean;
    isError?: boolean;
    error?: string;
    results?: Array<{ path: string; excerpt?: string }>;
    count?: number;
};

// Zwykły agent-rodzic z szerokim dostępem do vaulta (guidance = cały zwykły vault).
const parentWide: GuardedAgent = { name: 'Klara', permissions: { guidance_mode: true } };

test.before(() => {
    AccessGuard.setNoGoFolders(['_Sekrety']);
    AccessGuard.setVaultGroups([]);
});

// ─── AccessGuard.checkAccess ────────────────────────────────────────────────

test('scope suba przepuszcza ścieżkę wewnątrz folderu (rodzic też pozwala)', t => {
    const res = AccessGuard.checkAccess(parentWide, 'Projekty/x.md', 'read', { scopeFolders: ['Projekty'] });
    t.true(res.allowed);
});

test('scope suba ODRZUCA ścieżkę poza folderem, mimo że rodzic pozwala', t => {
    const bezScope = AccessGuard.checkAccess(parentWide, 'Inne/y.md', 'read');
    t.true(bezScope.allowed, 'rodzic sam z siebie by przepuścił');

    const res = AccessGuard.checkAccess(parentWide, 'Inne/y.md', 'read', { scopeFolders: ['Projekty'] });
    t.false(res.allowed);
    t.true(res.reason.includes('Inne/y.md'));
    t.true(res.reason.includes('Projekty'), 'komunikat mówi, gdzie subowi WOLNO');
});

test('scope suba nie obejmuje .pkm-assistant/** — tam rządzą reguły rodzica', t => {
    // Własny folder agenta: dozwolony przez _checkPkmPath, scope suba tego nie zawęża.
    const own = AccessGuard.checkAccess(parentWide, '.pkm-assistant/agents/klara/memory/brain.md', 'read', { scopeFolders: ['Projekty'] });
    t.true(own.allowed);

    // Cudzy folder: dalej blokowany regułą rodzica, nie barierą suba.
    const alien = AccessGuard.checkAccess(parentWide, '.pkm-assistant/agents/tola/memory/brain.md', 'read', { scopeFolders: ['Projekty'] });
    t.false(alien.allowed);
});

test('admin_access rodzica NIE zwalnia suba z jego scope (fail-closed)', t => {
    const admin = { name: 'Root', admin_access: true };

    t.true(AccessGuard.checkAccess(admin, 'Inne/y.md', 'write').allowed, 'admin sam z siebie może wszędzie');

    const res = AccessGuard.checkAccess(admin, 'Inne/y.md', 'write', { scopeFolders: ['Projekty'] });
    t.false(res.allowed, 'sub admina nadal siedzi w swoim kącie');
});

test('No-Go rodzica działa dalej, nawet gdy leży wewnątrz scope suba', t => {
    const res = AccessGuard.checkAccess(parentWide, '_Sekrety/haslo.md', 'read', { scopeFolders: ['_Sekrety'] });
    t.false(res.allowed, 'scope suba nie nadaje uprawnień — tylko zabiera');
});

test('pusta / brakująca lista scope = zero nowych ograniczeń', t => {
    t.true(AccessGuard.checkAccess(parentWide, 'Inne/y.md', 'read', { scopeFolders: [] }).allowed);
    t.true(AccessGuard.checkAccess(parentWide, 'Inne/y.md', 'read', {}).allowed);
    t.true(AccessGuard.checkAccess(parentWide, 'Inne/y.md', 'read').allowed, 'stary callsite bez opts');
});

test('scope suba respektuje węższą whitelistę rodzica (przecięcie, nie suma)', t => {
    const parentNarrow = {
        name: 'Tola',
        permissions: { guidance_mode: false },
        focusFolders: [{ path: 'Projekty/A', access: 'readwrite' }],
    };
    // Sub deklaruje szerzej niż rodzic — rodzic i tak wygrywa.
    const res = AccessGuard.checkAccess(parentNarrow, 'Projekty/B/x.md', 'read', { scopeFolders: ['Projekty'] });
    t.false(res.allowed);
});

// ─── AccessGuard.filterResults (wyniki search/list) ───────────────

const VAULT_HITS = () => [
    { path: 'Projekty/plan.md', excerpt: 'plan projektu' },
    { path: 'Inne/tajne.md', excerpt: 'NIE DLA SUBA' },
    { path: '_Sekrety/haslo.md', excerpt: 'hasło' },
];

test('filterResults tnie wyniki spoza scope suba (koniec przecieku przez search/list)', t => {
    const filtered = AccessGuard.filterResults(parentWide, VAULT_HITS(), undefined, { scopeFolders: ['Projekty'] });
    t.deepEqual(filtered.map(r => r.path), ['Projekty/plan.md']);
    t.false(JSON.stringify(filtered).includes('NIE DLA SUBA'), 'excerpt spoza scope nie wycieka');
});

test('filterResults bez scopeFolders zachowuje się dokładnie jak dotąd', t => {
    // Rodzic w guidance_mode widzi cały zwykły vault; wypada tylko No-Go.
    const stare = AccessGuard.filterResults(parentWide, VAULT_HITS());
    t.deepEqual(stare.map(r => r.path), ['Projekty/plan.md', 'Inne/tajne.md']);

    const puste = AccessGuard.filterResults(parentWide, VAULT_HITS(), undefined, { scopeFolders: [] });
    t.deepEqual(puste.map(r => r.path), stare.map(r => r.path));
});

test('filterResults: scope suba obowiązuje nawet admina (fail-closed jak w checkAccess)', t => {
    const admin = { name: 'Root', admin_access: true };
    t.is(AccessGuard.filterResults(admin, VAULT_HITS()).length, 3, 'admin sam z siebie widzi wszystko');

    const filtered = AccessGuard.filterResults(admin, VAULT_HITS(), undefined, { scopeFolders: ['Projekty'] });
    t.deepEqual(filtered.map(r => r.path), ['Projekty/plan.md']);
});

test('filterResults: .pkm-assistant/** nie podlega scope suba', t => {
    const hits = [
        { path: '.pkm-assistant/agents/klara/memory/brain.md' },
        { path: 'Inne/y.md' },
    ];
    const filtered = AccessGuard.filterResults(parentWide, hits, undefined, { scopeFolders: ['Projekty'] });
    t.deepEqual(filtered.map(r => r.path), ['.pkm-assistant/agents/klara/memory/brain.md']);
});

// ─── PermissionSystem.checkPermission (łańcuch uprawnień) ──────────────────

test('checkPermission przenosi scopeFolders do AccessGuard', t => {
    const ps = new PermissionSystem(null, {});

    const inside = ps.checkPermission(parentWide, 'vault.read', 'Projekty/x.md', { scopeFolders: ['Projekty'] });
    t.true(inside.allowed);

    const outside = ps.checkPermission(parentWide, 'vault.read', 'Inne/y.md', { scopeFolders: ['Projekty'] });
    t.false(outside.allowed);

    const noScope = ps.checkPermission(parentWide, 'vault.read', 'Inne/y.md', {});
    t.true(noScope.allowed, 'bez scope zachowanie bez zmian');
});

// ─── MCPClient — cały łańcuch od wywołania narzędzia przez suba ────────────

function makeClient(agent: GuardedAgent, executed: Array<Record<string, unknown>>) {
    return new MCPClient(null as unknown as McpApp, {
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: new PermissionSystem(null, {}),
        approvalManager: { requestApproval: async () => ({ result: 'approve' }) },
    }, {
        // Rejestr-atrapa ma tylko `getTool` — reszty kontraktu ten test nie dotyka.
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async (args: Record<string, unknown>) => { executed.push(args); return { success: true }; },
        }),
    } as unknown as ConstructorParameters<typeof MCPClient>[2]);
}

test('MCPClient: sub ze scope czyta w swoim folderze, a poza nim dostaje odmowę', async t => {
    const executed: Array<Record<string, unknown>> = [];
    const client = makeClient(parentWide, executed);

    const ok = await client.executeToolCall(
        { name: 'read', arguments: { path: 'Projekty/x.md' } } as unknown as ToolCallArg,
        'Klara', { scopeFolders: ['Projekty'] }) as ToolCallOutcome;
    t.true(ok.success);
    t.is(executed.length, 1);

    const denied = await client.executeToolCall(
        { name: 'read', arguments: { path: 'Inne/y.md' } } as unknown as ToolCallArg,
        'Klara', { scopeFolders: ['Projekty'] }) as ToolCallOutcome;
    t.true(denied.isError);
    t.true(denied.error!.includes('Inne/y.md'));
    t.is(executed.length, 1, 'narzędzie NIE zostało wykonane');
});

test('MCPClient: post-filtr wyników `search` zna scope suba', async t => {
    const hits = () => [
        { path: 'Projekty/plan.md', excerpt: 'plan' },
        { path: 'Inne/tajne.md', excerpt: 'NIE DLA SUBA' },
    ];
    const client = new MCPClient(null as unknown as McpApp, {
        agentManager: { getAgent: () => parentWide, getActiveAgent: () => parentWide },
        permissionSystem: new PermissionSystem(null, {}),
        approvalManager: { requestApproval: async () => ({ result: 'approve' }) },
    }, {
        getTool: () => ({
            name: 'search',
            description: 'search',
            execute: async () => ({ success: true, scope: 'vault', results: hits(), count: 2 }),
        }),
    } as unknown as ConstructorParameters<typeof MCPClient>[2]);

    const zwezony = await client.executeToolCall(
        { name: 'search', arguments: { query: 'x' } } as unknown as ToolCallArg,
        'Klara', { scopeFolders: ['Projekty'] }) as ToolCallOutcome;
    t.deepEqual(zwezony.results!.map(r => r.path), ['Projekty/plan.md']);
    t.is(zwezony.count, 1, 'licznik idzie za realną listą');
    t.false(JSON.stringify(zwezony).includes('NIE DLA SUBA'));

    const bezScope = await client.executeToolCall(
        { name: 'search', arguments: { query: 'x' } } as unknown as ToolCallArg, 'Klara') as ToolCallOutcome;
    t.is(bezScope.results!.length, 2, 'główny czat widzi tyle co dotąd');
});

test('MCPClient: wstrzykuje _invocationDelegationDepth tylko wewnątrz delegacji', async t => {
    const executed: Array<Record<string, unknown>> = [];
    const client = makeClient(parentWide, executed);

    await client.executeToolCall(
        { name: 'read', arguments: { path: 'A/x.md' } } as unknown as ToolCallArg, 'Klara', { delegationDepth: 2 });
    t.is(executed[0]._invocationDelegationDepth, 2);
    t.is(executed[0]._invocationAgentName, 'Klara', 'tożsamość rodzica bez zmian');

    await client.executeToolCall(
        { name: 'read', arguments: { path: 'A/x.md' } } as unknown as ToolCallArg, 'Klara');
    t.false('_invocationDelegationDepth' in executed[1], 'główny czat bez zbędnego pola');
});

test('MCPClient: model NIE podrobi głębokości — runtime nadpisuje pole w args', async t => {
    const executed: Array<Record<string, unknown>> = [];
    const client = makeClient(parentWide, executed);

    // Model próbuje udawać, że jest na piętrze 0, żeby delegować dalej.
    await client.executeToolCall(
        { name: 'read', arguments: { path: 'A/x.md', _invocationDelegationDepth: 0 } } as unknown as ToolCallArg,
        'Klara',
        { delegationDepth: 1 });

    t.is(executed[0]._invocationDelegationDepth, 1, 'wygrywa wartość od runtime, nie od modelu');
});

// ─── przecięcie zakresów przy delegacji piętro niżej ─────────────

test('intersectScopeFolders: brak zakresu po jednej stronie = zakres drugiej', t => {
    t.deepEqual(AccessGuard.intersectScopeFolders(null, ['Projekty']), ['Projekty']);
    t.deepEqual(AccessGuard.intersectScopeFolders(['Projekty'], null), ['Projekty']);
    t.is(AccessGuard.intersectScopeFolders(null, null), null, 'nikt nie zawęża = zero ograniczeń');
    t.is(AccessGuard.intersectScopeFolders([], []), null);
});

test('intersectScopeFolders: wygrywa WĘŻSZY wpis, niezależnie od strony', t => {
    t.deepEqual(AccessGuard.intersectScopeFolders(['Projekty'], ['Projekty/Alfa']), ['Projekty/Alfa']);
    t.deepEqual(AccessGuard.intersectScopeFolders(['Projekty/Alfa'], ['Projekty']), ['Projekty/Alfa']);
    t.deepEqual(AccessGuard.intersectScopeFolders(['Projekty'], ['Projekty']), ['Projekty']);
});

test('intersectScopeFolders: zakresy rozłączne = pusta lista (wołacz ma odmówić)', t => {
    t.deepEqual(AccessGuard.intersectScopeFolders(['Projekty'], ['Sekrety']), []);
});

test('intersectScopeFolders: wiele wpisów — zostają tylko części wspólne', t => {
    const out = AccessGuard.intersectScopeFolders(
        ['Projekty', 'Notatki'],
        ['Projekty/Alfa', 'Sekrety'],
    );
    t.deepEqual(out, ['Projekty/Alfa']);
});

test('intersectScopeFolders: wpisy obiektowe {path} i końcowy ukośnik znoszone', t => {
    t.deepEqual(
        AccessGuard.intersectScopeFolders([{ path: 'Projekty/' }], ['Projekty/Alfa']),
        ['Projekty/Alfa'],
    );
});

test('intersectScopeFolders: wynik jest realną bramką dla _isInSubScope', t => {
    const scope = AccessGuard.intersectScopeFolders(['Publiczne'], null)!;
    t.true(AccessGuard._isInSubScope('Publiczne/plik.md', scope));
    t.false(AccessGuard._isInSubScope('Prywatne/plik.md', scope), 'wnuk nie wychodzi poza kąt dziadka');
});
