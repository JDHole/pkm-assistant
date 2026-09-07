import test from 'ava';
import { ApprovalManager } from './ApprovalManager.js';
import { PermissionSystem } from './PermissionSystem.js';
import { SecretsStorage } from './SecretsStorage.js';
import type { HydrateStatus, SecureStorageSlice } from './SecretsStorage.js';
import type { ApprovalStorage } from './ApprovalManager.js';
import { log } from '../utils/Logger.js';

/**
 * Ustawienia w kształcie, w jakim ten test je buduje. `type`, nie `interface` — dzięki temu
 * dostaje niejawną index signature i przechodzi jako `SecretsSettings`.
 */
type TestSettings = {
    pkmAssistant: {
        chat?: { apiKeys?: Record<string, string | undefined> };
        secureStorage?: SecureStorageSlice;
    };
};

test('PermissionSystem: unknown actions fail closed', t => {
    const ps = new PermissionSystem(null, {});
    const agent = { name: 'Jaskier', hasPermission: () => true };
    const result = ps.checkPermission(agent, 'unknown.action', 'notes/a.md');
    t.false(result.allowed);
    t.is(result.reason, 'Unknown action');
});

test('E2.8 C1: akcje NIE są już bramkowane polami-widmami uprawnień (mcp/edit_notes...)', t => {
    const ps = new PermissionSystem(null, {});
    // Po C1 checkPermission NIE sprawdza już permissions.mcp/edit_notes/... — o „wolno" decyduje
    // DOSTĘPNOŚĆ narzędzia (disabled_tools/filterByAgent: model nie dostaje wyłączonego narzędzia).
    // Bramką pozostają: No-Go / pliki chronione / whitelista (AccessGuard) + approval (autonomia).
    const agent = {
        name: 'Any',
        permissions: { guidance_mode: true },
        focusFolders: [],
        hasPermission: () => false
    };
    t.true(ps.checkPermission(agent, 'mcp.connect', '').allowed);
    t.true(ps.checkPermission(agent, 'vault.write', 'Notes/a.md').allowed);
    t.true(ps.checkPermission(agent, 'web.search', 'query').allowed);
});

// ─── E2.3 (D21) — tryb autonomii w polityce uprawnień ───────────────

test('E2.3 autonomy yolo: znosi pytania ale NIE omija whitelisty (AccessGuard)', t => {
    const ps = new PermissionSystem(null, {});
    const agent = {
        name: 'Zoe',
        focusFolders: [{ path: 'Projekty', access: 'readwrite' }],
        permissions: {},
        hasPermission: (p: string) => p === 'edit_notes' || p === 'read_notes',
    };
    // W whitelist: yolo → dozwolone i BEZ pytania.
    const inside = ps.checkPermission(agent, 'vault.write', 'Projekty/a.md', { autonomy: 'yolo' });
    t.true(inside.allowed);
    t.false(inside.requiresApproval);
    // Poza whitelistą: yolo NIE ratuje — AccessGuard blokuje twardo.
    const outside = ps.checkPermission(agent, 'vault.write', 'Sekrety/x.md', { autonomy: 'yolo' });
    t.false(outside.allowed);
});

test('E2.3/C1 autonomy yolo: NIE omija plików chronionych (twarde granice)', t => {
    const ps = new PermissionSystem(null, {});
    const agent = { name: 'Ro', hasPermission: () => true };
    // Pliki chronione (data.json / .env) — yolo znosi pytania, ale nie granice: blok twardy.
    t.false(ps.checkPermission(agent, 'vault.write', 'data.json', { autonomy: 'yolo' }).allowed);
    t.false(ps.checkPermission(agent, 'vault.write', '.env', { autonomy: 'yolo' }).allowed);
});

test('E2.3 requiresApproval: yolo nigdy nie pyta', t => {
    const ps = new PermissionSystem(null, {});
    t.false(ps.requiresApproval('vault.write', 'a.md', 'write', {}, 'yolo'));
    t.false(ps.requiresApproval('vault.delete', 'a.md', 'delete', {}, 'yolo'));
    t.false(ps.requiresApproval('web.search', 'q', 'web_search', {}, 'yolo'));
});

test('E2.3 requiresApproval: all pyta o wszystko poza ask_user', t => {
    const ps = new PermissionSystem(null, {});
    t.true(ps.requiresApproval('vault.read', 'a.md', 'read', {}, 'all'));   // czysty odczyt, ale all pyta
    t.true(ps.requiresApproval('web.search', 'q', 'web_search', {}, 'all'));
    t.false(ps.requiresApproval('vault.read', '', 'ask_user', {}, 'all'));  // ask_user = wyjątek
});

test('E2.3 requiresApproval: edge pyta na krawędzi, nie o czyste read/think', t => {
    const ps = new PermissionSystem(null, {});
    t.false(ps.requiresApproval('vault.read', 'a.md', 'read', {}, 'edge'));    // read = bezpieczne
    t.true(ps.requiresApproval('vault.delete', 'a.md', 'delete', {}, 'edge')); // delete = krawędź
    t.true(ps.requiresApproval('web.search', 'q', 'web_search', {}, 'edge'));  // web = krawędź
});

test('E2.3 requiresApproval: edge z toggle-off wyłącza pytanie dla danego narzędzia', t => {
    const ps = new PermissionSystem(null, {});
    const agent = { approvalToggles: { web_search: false } };
    t.false(ps.requiresApproval('web.search', 'q', 'web_search', agent, 'edge'));
    // bez toggla dalej pyta:
    t.true(ps.requiresApproval('web.search', 'q', 'web_search', {}, 'edge'));
});

test('A3 edge: toggle wyłącza żółte create, ale nie czerwone patch/delete', t => {
    const ps = new PermissionSystem(null, {});
    const agent = {
        approvalToggles: {
            vault_write: false,
            vault_delete: false, // legacy wartość — po A3 ignorowana
        }
    };
    t.false(ps.requiresApproval('vault.write', 'new.md', 'write', agent, 'edge', { operationMode: 'create' }));
    t.true(ps.requiresApproval('vault.write', 'old.md', 'write', agent, 'edge', { operationMode: 'patch' }));
    t.true(ps.requiresApproval('vault.delete', 'old.md', 'delete', agent, 'edge'));
});

test('A3 edge: narzędzie z zewnętrznego serwera zawsze czerwone', t => {
    const ps = new PermissionSystem(null, {});
    t.true(ps.requiresApproval(
        'vault.read',
        'Notes/a.md',
        'external_read',
        { approvalToggles: {} },
        'edge',
        { isExternalTool: true }
    ));
});

test('A2: assigned-only + puste foldery = zero vaulta; guidance=true zachowuje cały zwykły vault', t => {
    const ps = new PermissionSystem(null, {});
    const strict = {
        name: 'Strict',
        focusFolders: [],
        permissions: { guidance_mode: false },
    };
    const wholeVault = {
        ...strict,
        name: 'Whole',
        permissions: { guidance_mode: true },
    };
    t.false(ps.checkPermission(strict, 'vault.read', 'Notes/a.md').allowed);
    t.true(ps.checkPermission(wholeVault, 'vault.read', 'Notes/a.md').allowed);
    t.false(ps.checkPermission(wholeVault, 'vault.read', '.pkm-assistant/agents/x.yaml').allowed);
});

test('A2: create_folder wymaga readwrite, nie przechodzi przez folder read-only', t => {
    const ps = new PermissionSystem(null, {});
    const agent = {
        name: 'Reader',
        focusFolders: [{ path: 'Źródła', access: 'read' }],
        permissions: { guidance_mode: false },
    };
    t.false(ps.checkPermission(agent, 'vault.create_folder', 'Źródła/Nowy').allowed);
});

test('A1: admin_access podnosi No-Go/protected/workspace, ale nie jest autonomią', t => {
    const ps = new PermissionSystem(null, {});
    const admin = {
        name: 'Nika',
        admin_access: true,
        focusFolders: [],
        permissions: { guidance_mode: false },
    };
    t.true(ps.checkPermission(admin, 'vault.read', '.obsidian/plugins.json', { autonomy: 'edge' }).allowed);
    t.true(ps.checkPermission(admin, 'vault.write', 'data.json', { autonomy: 'edge' }).allowed);
    t.true(ps.checkPermission(admin, 'vault.write', '.pkm-assistant/agents/x.yaml', { autonomy: 'edge' }).requiresApproval);
});

test('E2.3 requiresApproval: nieznana kategoria akcji = krawędź (fail-closed) w edge', t => {
    const ps = new PermissionSystem(null, {});
    // akcja bez wpisu w ACTION_PERMISSIONS → isEdgePermissionType(undefined) = true
    t.true(ps.requiresApproval('nieznana.akcja', 'x', null, {}, 'edge'));
});

test('E2.3 requiresApproval: brak autonomy → domyślnie edge', t => {
    const ps = new PermissionSystem(null, {});
    // Bez 5. argumentu — zachowanie ≈ dzisiejsze defaulty (edge).
    t.true(ps.requiresApproval('vault.delete', 'a.md', 'delete', {}));
    t.false(ps.requiresApproval('vault.read', 'a.md', 'read', {}));
});

test('ApprovalManager persists always-approved rules', t => {
    const storage: ApprovalStorage = {};
    let saveCount = 0;
    const manager = new ApprovalManager({}, {
        storage,
        onChange: () => { saveCount += 1; },
    });

    manager.addToAlwaysApproved('Jaskier', 'vault.write', 'notes/a.md');

    t.true(manager.isAlwaysApproved('Jaskier', 'vault.write', 'notes/a.md'));
    t.deepEqual(storage.alwaysApprovedRules, {
        Jaskier: ['vault.write::notes/a.md'],
    });
    t.is(saveCount, 1);

    const restored = new ApprovalManager({}, { storage });
    t.true(restored.isAlwaysApproved('Jaskier', 'vault.write', 'notes/a.md'));
});

test('ApprovalManager lists and removes always-approved rules', t => {
    const storage: ApprovalStorage = {};
    const manager = new ApprovalManager({}, { storage });
    manager.addToAlwaysApproved('Jaskier', 'vault.write', 'notes/a.md');
    // K22 (AUD-security-104): cel `*` jest DOSŁOWNY — zapisuje się jako token, nie jako
    // wieloznacznik `web.search::*`. Wcześniej ten wiersz udokumentowywał właśnie tę dziurę.
    manager.addToAlwaysApproved('Tola', 'web.search', '*');

    t.deepEqual(manager.getAllAlwaysApprovedRules(), [
        { agentName: 'Jaskier', rule: 'vault.write::notes/a.md' },
        { agentName: 'Tola', rule: 'web.search::<gwiazdka>' },
    ]);
    t.false(manager.isAlwaysApproved('Tola', 'web.search', 'kurs walut'), 'to nie jest zgoda na dowolne zapytanie');

    manager.removeFromAlwaysApproved('Jaskier', 'vault.write', 'notes/a.md');

    t.false(manager.isAlwaysApproved('Jaskier', 'vault.write', 'notes/a.md'));
    t.deepEqual(storage.alwaysApprovedRules, {
        Jaskier: [],
        Tola: ['web.search::<gwiazdka>'],
    });
});

test('E2.3 ApprovalManager: redirect passthrough (result + instruction, logged)', async t => {
    const manager = new ApprovalManager({}, {});
    manager.setApprovalHandler(async () => ({ result: 'redirect', instruction: 'zapisz w Szkice' }));

    const res = await manager.requestApproval({ agentName: 'Jaskier', type: 'vault.write', targetPath: 'a.md' });

    t.is(res.result, 'redirect');
    t.is(res.instruction, 'zapisz w Szkice');
    // Historia loguje przekierowanie jako 'redirect'.
    t.is(manager.getHistory().at(-1)!.result, 'redirect');
    // Redirect NIE jest zapisem always-approved.
    t.false(manager.isAlwaysApproved('Jaskier', 'vault.write', 'a.md'));
});


test('Logger masks sensitive data in warn and error', t => {
    const oldWarn = console.warn;
    const oldError = console.error;
    const calls: unknown[] = [];
    console.warn = (...args) => calls.push(['warn', args]);
    console.error = (...args) => calls.push(['error', args]);
    try {
        log.warn('Test', 'token sk-123456789012345678901234', { api_key: 'sk-abcdef1234567890abcdef1234567890' });
        log.error('Test', 'failed', new Error('Bearer sk-ant-abcdef1234567890abcdef1234567890'));
    } finally {
        console.warn = oldWarn;
        console.error = oldError;
    }

    const output = JSON.stringify(calls);
    t.false(output.includes('sk-123456789012345678901234'));
    t.false(output.includes('sk-abcdef1234567890abcdef1234567890'));
    t.false(output.includes('sk-ant-abcdef1234567890abcdef1234567890'));
    t.true(output.includes('***'));
});

test('Logger masks sensitive data in info and debug when debug mode is enabled', t => {
    // L1 (2026-08-27): info()/debug() call console.debug (not .log) — zgodnosc z wytyczna
    // Obsidiana "Avoid unnecessary logging to console" (core/utils/Logger.ts). Spy podmieniony
    // razem ze zmiana wywolania, semantyka testu (maskowanie sekretow) bez zmian.
    const oldDebugConsole = console.debug;
    const oldDebug = log.isDebug;
    const calls: unknown[] = [];
    console.debug = (...args) => calls.push(args);
    try {
        log._debug = true;
        log.info('Test', 'info sk-ant-dddddddddddddddddddddddddddd', { token: 'sk-eeeeeeeeeeeeeeeeeeeeeeeeeeee' });
        log.debug('Test', 'debug message', ['sk-ffffffffffffffffffffffffffff']);
    } finally {
        log._debug = oldDebug;
        console.debug = oldDebugConsole;
    }

    const output = JSON.stringify(calls);
    t.false(output.includes('sk-ant-dddddddddddddddddddddddddddd'));
    t.false(output.includes('sk-eeeeeeeeeeeeeeeeeeeeeeeeeeee'));
    t.false(output.includes('sk-ffffffffffffffffffffffffffff'));
    t.true(output.includes('***'));
});

test('Logger masks sensitive data in model selection logs', t => {
    // L1 (2026-08-27): model() calls console.debug (not .log) — patrz komentarz w tescie wyzej.
    const oldDebugConsole = console.debug;
    const oldDebug = log.isDebug;
    const calls: unknown[] = [];
    console.debug = (...args) => calls.push(args);
    try {
        log._debug = true;
        log.model('main', 'sk-ant-gggggggggggggggggggggggggggg', 'model-sk-hhhhhhhhhhhhhhhhhhhhhhhhhhhh');
    } finally {
        log._debug = oldDebug;
        console.debug = oldDebugConsole;
    }

    const output = JSON.stringify(calls);
    t.false(output.includes('sk-ant-gggggggggggggggggggggggggggg'));
    t.false(output.includes('sk-hhhhhhhhhhhhhhhhhhhhhhhhhhhh'));
    t.true(output.includes('***'));
});

test('SecretsStorage migrates plaintext settings to master-password encrypted refs', async t => {
    const app = {};
    const settings: TestSettings = {
        pkmAssistant: { chat: { apiKeys: { openai: 'sk-test12345678901234567890' } } },
    };
    const storage = new SecretsStorage(app);

    const unlocked = await storage.unlock('correct horse battery staple');
    settings.pkmAssistant.secureStorage = { masterSalt: unlocked.salt };
    await storage.migratePlainSettings(settings);

    t.false(Object.prototype.propertyIsEnumerable.call(settings.pkmAssistant.chat!.apiKeys, 'openai'));
    t.is(settings.pkmAssistant.chat!.apiKeys!.openai, 'sk-test12345678901234567890');
    t.is(JSON.stringify(settings).includes('sk-test12345678901234567890'), false);
    // S35: NOWE sekrety dostają prefiks `pkm-assistant-`. Stare id `obsek-*` u userów
    // dalej działają, bo odszyfrowanie idzie po mapie refs, nie po prefiksie.
    t.truthy(settings.pkmAssistant.secureStorage!.encrypted!['pkm-assistant-pkmassistant-chat-apikeys-openai']);

    const freshSettings: TestSettings = JSON.parse(JSON.stringify(settings));
    const lockedStorage = new SecretsStorage(app);
    const lockedStatus = await lockedStorage.hydrateSettings(freshSettings);
    t.true(lockedStatus.locked);
    t.deepEqual(lockedStatus.missing, ['pkmAssistant.chat.apiKeys.openai']);
    t.is(freshSettings.pkmAssistant.chat!.apiKeys!.openai, undefined);

    await lockedStorage.unlock('correct horse battery staple', freshSettings.pkmAssistant.secureStorage!.masterSalt);
    const hydratedStatus = await lockedStorage.hydrateSettings(freshSettings);
    t.false(hydratedStatus.locked);
    t.is(hydratedStatus.hydrated, 1);
    t.is(freshSettings.pkmAssistant.chat!.apiKeys!.openai, 'sk-test12345678901234567890');
    t.false(Object.prototype.propertyIsEnumerable.call(freshSettings.pkmAssistant.chat!.apiKeys, 'openai'));
});

test('SecretsStorage startup hydrate without unlock keeps keys unavailable without crash', async t => {
    const settings: TestSettings = {
        pkmAssistant: { chat: { apiKeys: { anthropic: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' } } },
    };
    const storage = new SecretsStorage({});
    const unlocked = await storage.unlock('correct horse battery staple');
    settings.pkmAssistant.secureStorage = { masterSalt: unlocked.salt };
    await storage.migratePlainSettings(settings);

    const freshSettings: TestSettings = JSON.parse(JSON.stringify(settings));
    const freshStorage = new SecretsStorage({});
    // `!` = definite assignment: przypisanie dzieje się w callbacku `notThrowsAsync`,
    // czego przepływ TS nie widzi. Zero emitu, zero zmian w asercjach niżej.
    let result!: HydrateStatus;
    await t.notThrowsAsync(async () => {
        result = await freshStorage.hydrateSettings(freshSettings);
    });

    t.true(result.locked);
    t.is(result.hydrated, 0);
    t.deepEqual(result.missing, ['pkmAssistant.chat.apiKeys.anthropic']);
    t.is(freshSettings.pkmAssistant.chat!.apiKeys!.anthropic, undefined);
});

// ─── AUD-testy-008 (kanon; duplikat 050) — próg min. 12 znaków w SecretsStorage.unlock ───
// core/security/SecretsStorage.ts:158-160. Nie miał testu strony "blokuje": `unlock` w tym
// pliku był wołany zawsze z tym samym, długim hasłem (28 znaków) — zamiana warunku na
// `if (false)` zostawiała pełny pakiet 2465 testów zielony.

test('SecretsStorage.unlock: hasło krótsze niż 12 znaków = odmowa BEZ próby odszyfrowania czegokolwiek', async t => {
    const storage = new SecretsStorage({});
    await t.throwsAsync(
        () => storage.unlock('a'.repeat(11)),
        { message: /at least 12/ },
        'próg 12 znaków nie odmówił krótszemu hasłu',
    );
    // Bramka odmawia PRZED derivePasswordKey — sejf zostaje zamknięty, nic nie próbowało się wyprowadzić.
    t.is(storage.passwordKey, null);
});

test('SecretsStorage.unlock: pusty string też odmawia (gałąź `!password`, nie tylko `.length < 12`)', async t => {
    const storage = new SecretsStorage({});
    await t.throwsAsync(() => storage.unlock(''), { message: /at least 12/ });
});

test('SecretsStorage.unlock: dokładnie 12 znaków (granica progu) i dłuższe hasło PRZECHODZĄ dalej', async t => {
    const storage = new SecretsStorage({});
    const unlocked = await storage.unlock('a'.repeat(12));
    t.truthy(unlocked.salt);
    t.not(storage.passwordKey, null);
});

// ─── AUD-testy-034 — SecretsStorage.hydrateSettings, gałąź status.errors ───────────────
// core/security/SecretsStorage.ts:220-227. Złe hasło główne przy ODSZYFROWANIU (nie: "nigdy
// nie odblokowano" — to inna gałąź, pokryta testem wyżej) musi zostać ZARAPORTOWANE w
// status.errors, nie połknięte cichym `catch`, i nie może wywrócić hydrate nieobsłużonym
// wyjątkiem (ta ścieżka biegnie przy KAŻDYM starcie pluginu).

test('SecretsStorage.hydrateSettings: złe hasło główne przy odszyfrowaniu ląduje w status.errors, nie ginie i nie wywraca hydrate', async t => {
    const app = {};
    const settings: TestSettings = {
        pkmAssistant: { chat: { apiKeys: { openai: 'sk-test-zle-haslo-1234567890' } } },
    };
    const storage = new SecretsStorage(app);
    const unlocked = await storage.unlock('correct horse battery staple');
    settings.pkmAssistant.secureStorage = { masterSalt: unlocked.salt };
    await storage.migratePlainSettings(settings);

    const freshSettings: TestSettings = JSON.parse(JSON.stringify(settings));
    const wrongStorage = new SecretsStorage(app);
    // TA SAMA sól (żeby przejść próg długości i realnie dotrzeć do decryptWithPassword),
    // ale INNE hasło → AES-GCM tag mismatch przy odszyfrowaniu (zła treść, nie brak klucza).
    await wrongStorage.unlock('to jest zupelnie inne haslo', freshSettings.pkmAssistant.secureStorage!.masterSalt);

    let status!: HydrateStatus;
    await t.notThrowsAsync(async () => {
        status = await wrongStorage.hydrateSettings(freshSettings);
    }, 'złe hasło przy odszyfrowaniu nie może wywrócić hydrate nieobsłużonym wyjątkiem (boot pluginu)');

    t.false(status.locked, 'sejf BYŁ odblokowany (choć złym hasłem) — "locked" mierzy co innego (nigdy-nie-odblokowano)');
    t.is(status.hydrated, 0);
    t.deepEqual(status.missing, ['pkmAssistant.chat.apiKeys.openai']);
    t.is(status.errors.length, 1, 'błąd odszyfrowania musi zostać ZARAPORTOWANY, nie połknięty cichym catch');
    t.is(status.errors[0].fieldPath, 'pkmAssistant.chat.apiKeys.openai');
    t.truthy(status.errors[0].message, 'komunikat błędu nie może być pusty');

    // Stan bezpieczny: klucz NIE trafia do settings jako plaintext mimo "udanego" unlock().
    t.is(freshSettings.pkmAssistant.chat!.apiKeys!.openai, undefined);
});
