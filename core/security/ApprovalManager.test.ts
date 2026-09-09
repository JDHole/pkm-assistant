import test from 'ava';
import { ApprovalManager } from './ApprovalManager.js';
import type { ApprovalHandlerResult } from './ApprovalManager.js';

function makeManager(handlerResult: ApprovalHandlerResult) {
    const mgr = new ApprovalManager({}, { storage: {} });
    mgr.setApprovalHandler(async () => handlerResult);
    return mgr;
}

// ─── "Zawsze zezwalaj" per KONKRETNE narzędzie external ────────────
// External MCP tools carry a distinct approvalTarget (prefixed tool name) so a single
// "always" does NOT unlock every external tool of every server (external.call::* is too broad).

test('external tools: "always" for one tool does NOT auto-approve sibling tools or another server', async t => {
    const mgr = makeManager({ result: 'always' });

    // User approves-forever the specific external tool (approvalTarget = prefixed name; targetPath empty).
    const first = await mgr.requestApproval({
        agentName: 'Jaskier', type: 'external.call', targetPath: '', approvalTarget: 'srv__toolA',
    });
    t.is(first.result, 'approve');

    // Different tool of the SAME server + same tool of ANOTHER server → must still ask.
    let asked = 0;
    mgr.setApprovalHandler(async () => { asked++; return { result: 'deny' }; });
    await mgr.requestApproval({ agentName: 'Jaskier', type: 'external.call', targetPath: '', approvalTarget: 'srv__toolB' });
    await mgr.requestApproval({ agentName: 'Jaskier', type: 'external.call', targetPath: '', approvalTarget: 'srv2__toolA' });
    t.is(asked, 2, 'neither sibling tool nor same-tool-other-server was auto-approved');

    // The exact tool is auto-approved without hitting the handler again.
    const repeat = await mgr.requestApproval({ agentName: 'Jaskier', type: 'external.call', targetPath: '', approvalTarget: 'srv__toolA' });
    t.is(repeat.result, 'approve');
    t.is(asked, 2, 'exact tool auto-approved silently');
});

test('external tools: always-rule is stored per-tool (no external.call::* wildcard)', async t => {
    const mgr = makeManager({ result: 'always' });
    await mgr.requestApproval({ agentName: 'Jaskier', type: 'external.call', targetPath: '', approvalTarget: 'srv__toolA' });
    const rules = mgr.getAlwaysApprovedRules('Jaskier');
    t.deepEqual(rules, ['external.call::srv__toolA']);
    t.false(rules.includes('external.call::*'), 'must NOT create the broad wildcard');
});

test('external tools: non-external actions keep using targetPath (approvalTarget absent → fallback, unchanged behavior)', async t => {
    const mgr = makeManager({ result: 'always' });
    await mgr.requestApproval({ agentName: 'Jaskier', type: 'vault.write', targetPath: 'Notes/a.md' });
    t.deepEqual(mgr.getAlwaysApprovedRules('Jaskier'), ['vault.write::Notes/a.md']);
});

// ─── cel od WOŁACZA jest dosłowny, nie wieloznaczny ──
// Gdyby DOSŁOWNA gwiazdka z argumentu narzędzia (`delete {path:"*"}`) produkowała klucz
// `akcja::*`, modal pokazywałby kasowanie „*", wywołanie i tak odbijałoby się o walidację
// narzędzia, więc user klikałby „Zawsze zezwalaj" spokojnie — i zapisywałby TRWAŁĄ regułę
// auto-zatwierdzającą każdy przyszły cel tej akcji.

test('literalTarget: „zawsze" dla celu `*` nie zapisuje wieloznacznika i nie otwiera innych celów', async t => {
    const mgr = makeManager({ result: 'always' });

    // Model woła `delete {path:"*"}` — wywołanie odbije się o walidację narzędzia,
    // więc user klika trzeci przycisk bez obaw.
    await mgr.requestApproval({ agentName: 'Igor', type: 'vault.delete', targetPath: '*' });

    const rules = mgr.getAlwaysApprovedRules('Igor');
    t.false(rules.includes('vault.delete::*'), 'wieloznacznik NIE powstaje z argumentu modelu');
    t.false(
        mgr.isAlwaysApproved('Igor', 'vault.delete', 'Notes/wazne.md'),
        'kasowanie prawdziwej notatki dalej wymaga zgody',
    );
    t.true(mgr.isAlwaysApproved('Igor', 'vault.delete', '*'), 'reguła obejmuje dokładnie to, na co user kliknął');
});

test('literalTarget: to:"*" w agent.message też nie zapada w wieloznacznik', async t => {
    const mgr = makeManager({ result: 'always' });

    await mgr.requestApproval({ agentName: 'Igor', type: 'agent.message', targetPath: '*' });

    t.false(mgr.getAlwaysApprovedRules('Igor').includes('agent.message::*'));
    t.false(mgr.isAlwaysApproved('Igor', 'agent.message', 'Tola'), 'poczta do konkretnego agenta dalej pyta');
});

test('literalTarget: gwiazdka WEWNĄTRZ celu też jest dosłowna (żadnego globa w kluczu)', t => {
    const mgr = new ApprovalManager({}, { storage: {} });

    const klucz = mgr.createPatternKey('vault.write', 'Notes/*.md');
    t.false(klucz.includes('*'), 'w kluczu nie zostaje ani jedna gwiazdka sterująca');
    t.is(klucz, mgr.createPatternKey('vault.write', 'Notes/*.md'), 'ten sam cel daje ten sam klucz');
    t.not(klucz, mgr.createPatternKey('vault.write', 'Notes/a.md'), 'i nie pasuje do prawdziwej notatki');
});

test('loadApprovals: zastana reguła `akcja::*` działa jak dotąd, ale wczytanie ostrzega', t => {
    const warns: string[] = [];
    const oldWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
    let mgr: ApprovalManager;
    try {
        mgr = new ApprovalManager({}, {
            storage: { alwaysApprovedRules: { Igor: ['vault.delete::*', 'vault.write::Notes/a.md'] } },
        });
    } finally {
        console.warn = oldWarn;
    }

    // Semantyka reguł ZASTANYCH bez zmian — nie kasujemy po cichu cudzych decyzji.
    t.true(mgr.isAlwaysApproved('Igor', 'vault.delete', 'Notes/wazne.md'));
    // ...ale user ma się o nich dowiedzieć.
    t.true(warns.some(w => w.includes('vault.delete::*')), `brak ostrzeżenia o wieloznaczniku: ${warns.join(' | ')}`);
    t.false(warns.some(w => w.includes('vault.write::Notes/a.md')), 'zwykłe reguły nie hałasują');
});

test('removeFromAlwaysApproved: ekran reguł dalej usuwa zastany wieloznacznik', t => {
    const mgr = new ApprovalManager({}, {
        storage: { alwaysApprovedRules: { Igor: ['vault.delete::*'] } },
    });

    // Dokładnie ta droga, którą idzie guzik „Remove" w Settings → Security
    // (`core/SettingsContent.ts`: rozbicie reguły po `::`).
    const [actionType, ...targetParts] = 'vault.delete::*'.split('::');
    mgr.removeFromAlwaysApproved('Igor', actionType, targetParts.join('::') || '*');

    t.deepEqual(mgr.getAlwaysApprovedRules('Igor'), [], 'reguła zniknęła z listy');
    t.false(mgr.isAlwaysApproved('Igor', 'vault.delete', 'Notes/wazne.md'));
});

test('createPatternKey: reguła dla konkretnego celu — zapis, dopasowanie i kasowanie bez zmian (regresja)', async t => {
    const storage = {};
    const mgr = new ApprovalManager({}, { storage });
    mgr.setApprovalHandler(() => ({ result: 'always' }));

    await mgr.requestApproval({ agentName: 'Jaskier', type: 'vault.write', targetPath: 'Notes/a.md' });

    t.deepEqual(mgr.getAlwaysApprovedRules('Jaskier'), ['vault.write::Notes/a.md']);
    t.true(mgr.isAlwaysApproved('Jaskier', 'vault.write', 'Notes/a.md'));
    t.false(mgr.isAlwaysApproved('Jaskier', 'vault.write', 'Notes/b.md'));

    mgr.removeFromAlwaysApproved('Jaskier', 'vault.write', 'Notes/a.md');
    t.deepEqual(mgr.getAlwaysApprovedRules('Jaskier'), []);
});

// ─── reguła BEZ agenta (agentName===null) przeżywa "restart" ──────────
// invocationAgentName (MCPClient) bywa realnym `null`, gdy nie ma aktywnego agenta. Reguła
// "Zawsze zezwalaj" zapisana wtedy musi wciąż obowiązywać po ponownym wczytaniu ustawień —
// czyli po zbudowaniu NOWEJ instancji ApprovalManager nad tym samym `storage` (tak samo jak
// `src/main.ts` robi przy każdym starcie pluginu).

test('reguła "Zawsze zezwalaj" bez agenta (null) przeżywa restart', async t => {
    const storage = {};
    const mgr1 = new ApprovalManager({}, { storage });
    mgr1.setApprovalHandler(() => ({ result: 'always' }));

    const first = await mgr1.requestApproval({ agentName: null, type: 'vault.write', targetPath: 'Notes/a.md' });
    t.is(first.result, 'approve');
    t.true(mgr1.isAlwaysApproved(null, 'vault.write', 'Notes/a.md'), 'ta sama sesja widzi regułę od razu');

    // "Restart": NOWA instancja nad TYM SAMYM storage (`src/main.ts` robi dokładnie to przy
    // każdym starcie pluginu — `new ApprovalManager(app, { storage: pluginSettings... })`).
    const mgr2 = new ApprovalManager({}, { storage });
    t.true(mgr2.isAlwaysApproved(null, 'vault.write', 'Notes/a.md'),
        'reguła bez agenta musi przetrwać round-trip przez zapis/odczyt ustawień');

    // Kluczem persystencji jest jawny sentinel, nie string "null" wynikły z koercji.
    t.deepEqual(Object.keys((storage as { alwaysApprovedRules?: Record<string, string[]> }).alwaysApprovedRules || {}),
        ['<brak-agenta>']);

    // getAllAlwaysApprovedRules (ekran Ustawienia → Bezpieczeństwo) oddaje PRAWDZIWY null,
    // nie string "null" — inaczej UI pokazywałby fałszywego agenta o nazwie "null".
    const rows = mgr2.getAllAlwaysApprovedRules();
    t.is(rows.length, 1);
    t.is(rows[0].agentName, null);
    t.is(rows[0].rule, 'vault.write::Notes/a.md');
});
