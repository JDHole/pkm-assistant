/**
 * Agent - kontrakt pól-widm.
 *
 * `can_message[]` nie jest już bytem w systemie („każdy pisze do każdego"), ale runtime nadal
 * mógłby je czytać, trzymać i zapisywać - wydmuszka udająca uprawnienie. Ten test pilnuje
 * DWÓCH rzeczy naraz:
 *   1. pole naprawdę zniknęło (nie wraca do YAML-a przy zapisie),
 *   2. YAML usera, który je JESZCZE zawiera, ładuje się bez błędu (schemat jest permissive).
 */
import test from 'ava';
import { Agent } from './Agent.js';
import { validateAgentSchema } from '../../core/utils/yamlParser.js';

test('stary YAML z can_message ładuje się bez błędu - pole jest po prostu ignorowane', t => {
    const legacy = {
        name: 'Tola',
        can_message: ['Klara', 'Jaskier'],
        mcp_servers: ['vault'],
    };

    t.true(validateAgentSchema(legacy).valid, 'walidacja schematu nie odrzuca nieznanego pola');

    const agent = new Agent(legacy);
    t.is(agent.name, 'Tola');
    t.is(agent.can_message, undefined, 'pole nie jest już czytane');
    t.deepEqual(agent.mcp_servers, ['vault'], 'sąsiednie pole kontraktu bez zmian');
});

test('serialize NIE wypisuje can_message (ani z domyślnej, ani z podanej wartości)', t => {
    const zListy = new Agent({ name: 'A', can_message: ['Klara'] }).serialize();
    const bez = new Agent({ name: 'B' }).serialize();

    t.false('can_message' in zListy);
    t.false('can_message' in bez);
});

test('update() nie przyjmuje can_message (pole spoza allowedFields)', t => {
    const agent = new Agent({ name: 'A' });
    agent.update({ can_message: ['Klara'], personality: 'spokojna' });

    t.is(agent.can_message, undefined, 'martwe pole nie wraca tylnymi drzwiami');
    t.is(agent.personality, 'spokojna', 'normalne pola dalej działają');
});

// `playbook_overrides` skasowane wzorem `can_message`: pole nie miało żadnego czytelnika
// (PlaybookManager go nie zna), a jedyna gałąź, która je porównywała po zapisie, nie mogła
// się zapalić (panel nie ma widżetu zmieniającego to pole).

test('stary YAML z playbook_overrides ładuje się bez błędu - pole jest po prostu ignorowane', t => {
    const legacy = {
        name: 'Tola',
        playbook_overrides: { intro: 'stary tekst' },
        mcp_servers: ['vault'],
    };

    t.true(validateAgentSchema(legacy).valid, 'walidacja schematu nie odrzuca nieznanego pola');

    const agent = new Agent(legacy);
    t.is(agent.name, 'Tola');
    t.is(agent.playbookOverrides, undefined, 'pole nie jest już czytane');
    t.is(agent.playbook_overrides, undefined, 'ani pod surową nazwą z YAML-a');
    t.deepEqual(agent.mcp_servers, ['vault'], 'sąsiednie pole kontraktu bez zmian');
});

test('serialize NIE wypisuje playbook_overrides (ani z domyślnej, ani z podanej wartości)', t => {
    const zWartoscia = new Agent({ name: 'A', playbook_overrides: { x: 1 } }).serialize();
    const bez = new Agent({ name: 'B' }).serialize();

    t.false('playbook_overrides' in zWartoscia);
    t.false('playbook_overrides' in bez);
});

test('update() nie przyjmuje playbook_overrides (pole spoza allowedFields)', t => {
    const agent = new Agent({ name: 'A' });
    agent.update({ playbook_overrides: { x: 1 }, personality: 'spokojna' });

    t.is(agent.playbookOverrides, undefined, 'martwe pole nie wraca tylnymi drzwiami');
    t.is(agent.personality, 'spokojna', 'normalne pola dalej działają');
});

// Pole spoza znanego zestawu jest ODRZUCONE Z LOGIEM, nie po cichu.

test('update() loguje ostrzeżenie dla pola spoza allowedFields (literówka widoczna, nie milcząca)', t => {
    const agent = new Agent({ name: 'A' });
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    try {
        agent.update({ defualt_permissions: { memory: false }, personality: 'nowa' } as never);
    } finally {
        console.warn = originalWarn;
    }

    t.is(agent.personality, 'nowa', 'znane pole dalej się zapisuje');
    t.true(
        warnCalls.some(args => typeof args[0] === 'string' && args[0].includes('defualt_permissions')),
        'literówka w kluczu updates trafia do logu zamiast ginąć po cichu',
    );
});

test('pole ZNANE (bez literówki) nie generuje żadnego ostrzeżenia', t => {
    const agent = new Agent({ name: 'A' });
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    try {
        agent.update({ default_permissions: { memory: false }, personality: 'nowa' });
    } finally {
        console.warn = originalWarn;
    }

    t.is(warnCalls.length, 0, 'poprawne pole nie trafia do logu odrzuconych');
});

test('`access_policy_version` NIE trafia do logu - serialize() go emituje ZAWSZE, więc nie jest literówką', t => {
    // Odtwarza dokładnie to, co robi `AgentLoader._mergeBuiltInOverrides` po restarcie: czyta
    // z powrotem plik zapisany przez `saveBuiltInOverrides` (czyli `agent.serialize()`) i woła
    // `agent.update(data)`. `access_policy_version` jest w KAŻDYM takim pliku - gdyby trafiał
    // do logu, Jaskier ostrzegałby o „literówce" na każdym starcie z niezerowym override.
    const agent = new Agent({ name: 'Jaskier', isBuiltIn: true });
    const serialized = agent.serialize();
    t.truthy(serialized.access_policy_version, 'zakładamy realny kształt danych z serialize()');

    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    try {
        agent.update(serialized as never);
    } finally {
        console.warn = originalWarn;
    }

    t.is(warnCalls.length, 0, 'round-trip serialize() → update() jest cichy');
});

// admin_access ma JEDEN kształt po update().

test('update() normalizuje admin_access tak samo jak konstruktor', t => {
    const a = new Agent({ name: 'T', admin_access: true });
    t.is(a.admin_access, true);

    a.update({ admin_access: 'yes' as unknown as boolean });
    t.is(a.admin_access, false, 'nie-boolowska wartość NIE staje się adminem (fail-closed)');

    a.update({ admin_access: true });
    t.is(a.admin_access, true);

    a.update({ admin_access: 1 as unknown as boolean });
    t.is(a.admin_access, false, 'po update() pole trzyma bool, nie surową wartość z YAML-a');
});


// Jedno ogrodzenie pamięci, nie dwa.

/**
 * `getSystemPrompt` NIE wolno owijać `memoryContext` we WŁASNE dodatkowe markery obok
 * `<vault_content source="memory">` (`PromptBuilder` → `fenceUntrusted`), które ESCAPUJE
 * treść - własny tekstowy marker byłby drugim, PODRABIALNYM płotem wewnątrz prawdziwego:
 * treść pamięci mogłaby udawać koniec sekcji i wyrwać się z ogrodzenia.
 *
 * Asercje są świadomie KSZTAŁTOWE, nie tekstowe: markery idą przez i18n, więc test na
 * konkretnym napisie łapałby tylko jeden język.
 */
test('wewnątrz ogrodzenia pamięci nie ma DRUGIEGO płotu (linii-linijki)', t => {
    const agent = new Agent({ name: 'Tola', personality: '', disabled_tools: [] });
    const memoryContext = '## Długoterminowa pamięć\n\n## User\n- lubi krótko\n';

    const prompt = agent.getSystemPrompt({
        vaultName: 'Vault',
        currentDate: '2026-08-23',
        memoryContext,
    } as never);

    const start = prompt.indexOf('<vault_content source="memory">');
    t.true(start >= 0, 'sekcja pamięci jest ogrodzona');
    const wnetrze = prompt.slice(start).split('</vault_content>')[0];

    t.is((wnetrze.match(/<vault_content\b/g) || []).length, 1, 'dokładnie jedno otwarcie ogrodzenia');
    t.true(wnetrze.includes('lubi krótko'), 'treść pamięci nadal w prompcie');
    t.true(wnetrze.includes('## Długoterminowa pamięć'), 'nagłówek-etykieta ZOSTAJE (to nie granica)');

    // Płot = linia zbudowana z powtórzonych `-`, `=` albo `═`. Nagłówki `##` i punkty `-`
    // listy nie łapią się na ten wzorzec.
    const ploty = wnetrze.split('\n').filter(l => /^\s*(?:-{3,}|={3,}|═{3,})/.test(l.trim()));
    t.deepEqual(ploty, [], 'żaden drugi płot nie stoi wewnątrz ogrodzenia');
});

// getSystemPrompt/getPromptSections dzielą jedną konfigurację.

/**
 * Obie metody muszą budować `PromptBuilder` z tą samą konfiguracją (`disabledPromptSections`
 * + `addDynamicSection('memory', ...)`) przez wspólny `_buildConfiguredPromptBuilder`: sekcja
 * wyłączona przez usera znika z OBU wyjść, a sekcja pamięci pojawia się w OBU identycznie.
 */
test('getSystemPrompt i getPromptSections zgadzają się co do wyłączonych sekcji i pamięci', t => {
    const agent = new Agent({ name: 'Tola', personality: 'zwięzła', disabled_tools: [] });
    const context = {
        vaultName: 'Vault',
        currentDate: '2026-08-30',
        memoryContext: 'MARKER_PAMIECI_086',
        disabledPromptSections: ['permissions'],
    } as never;

    const { sections } = agent.getPromptSections(context);
    const permSection = sections.find(s => s.key === 'permissions');
    t.truthy(permSection, 'sekcja permissions musi istnieć w metadanych');
    t.false(permSection!.enabled, 'permissions ma być wyłączona przez disabledPromptSections');

    const memSection = sections.find(s => s.key === 'memory');
    t.truthy(memSection, 'sekcja memory musi istnieć (dynamiczna, dodana przez oba wejścia)');
    t.true(memSection!.enabled);
    t.true(memSection!.content.includes('MARKER_PAMIECI_086'));

    const prompt = agent.getSystemPrompt(context);
    t.false(prompt.includes(permSection!.content), 'wyłączona sekcja permissions nie ma trafić do pełnego prompta');
    t.true(prompt.includes('MARKER_PAMIECI_086'), 'pamięć ma trafić do pełnego prompta tak samo jak do metadanych');
});

// `model` pisany TYLKO gdy pochodzi ze źródła (yaml) albo user jawnie go ustawił przez
// update() - nigdy z drogi, która nie jest jednym z tych dwóch przypadków. `language`
// (i inne pola, które Agent zna) przeżywają round-trip.

test('yaml bez model → serialize NIE dopisuje model (nie ma go znikąd)', t => {
    const agent = new Agent({ name: 'Tola', language: 'pl' });
    const data = agent.serialize();
    t.false('model' in data, 'model nie może pojawić się bez źródła');
    t.is(data.language, 'pl', 'language musi przeżyć serialize');
});

test('yaml z model → model zostaje po serialize (źródło ma pierwszeństwo)', t => {
    const agent = new Agent({ name: 'Borys', model: 'openai/gpt-4o' });
    const data = agent.serialize();
    t.is(data.model, 'openai/gpt-4o');
});

test('update() pola NIEZWIĄZANEGO z modelem nie dopisuje model, gdy go nie było', t => {
    const agent = new Agent({ name: 'Tola', language: 'pl' });
    agent.update({ personality: 'zwięzła i konkretna' });
    const data = agent.serialize();
    t.false('model' in data, 'update() innego pola nie może wskrzesić model');
    t.is(data.language, 'pl', 'language nadal obecny po update() innego pola');
});

test('update({ model }) jawnie ustawiony przez usera przeżywa serialize (UI ma prawo go ustawić)', t => {
    const agent = new Agent({ name: 'Tola' }); // brak model w źródle
    agent.update({ model: 'anthropic/claude-3-5-sonnet-20241022' });
    const data = agent.serialize();
    t.is(data.model, 'anthropic/claude-3-5-sonnet-20241022', 'jawna decyzja usera w update() musi przeżyć serialize');
});

test('update({ model: null }) czyści pole i serialize go nie wypisuje', t => {
    const agent = new Agent({ name: 'Borys', model: 'openai/gpt-4o' });
    agent.update({ model: null } as never);
    const data = agent.serialize();
    t.false('model' in data, 'wyczyszczone pole nie może wrócić');
});

test('bezpośrednie przypisanie this.model (bez update()) NIE jest traktowane jako źródło - bramka broni się przed obejściem update()', t => {
    const agent = new Agent({ name: 'Tola' });
    // Symuluje kod, który (błędnie) omija update() i pisze wprost na instancję - bramka
    // `_modelFromSource` MUSI zostać false, bo żadna z dwóch legalnych dróg (konstruktor /
    // update()) tego nie zrobiła.
    agent.model = 'openai/gpt-4o';
    const data = agent.serialize();
    t.false('model' in data, 'przypisanie z pominięciem update() nie ma prawa trafić do pliku');
});
