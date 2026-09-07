/**
 * C1 (risk register 2026-09-02 / S34 z8, nota do rejestru w B6 Runda 3 punkt 5):
 * `AgentLoader.saveBuiltInOverrides` serializowało CAŁEGO Jaskra (`agent.serialize()` minus
 * `name`) do `jaskier_overrides.yaml` — emoji, color, personality itd. wyciekały do dysku przy
 * KAŻDYM zapisie profilu, nawet gdy user nie ruszył ani jednego z tych pól. Naprawa: zapisuj
 * tylko DIFF względem wbudowanej konfiguracji (`createJaskier()`).
 *
 * A1 (klaster C4b, nit na recenzję C1): `access_policy_version` jest teraz ZAWSZE w pliku
 * nadpisań (patrz `ALWAYS_WRITTEN_META_FIELDS` w `AgentLoader.ts`) — bez tego `diffAgentConfig`
 * je wycinało (baseline ma dokładnie tę samą, bieżącą wartość), więc każdy load widział
 * `accessVersion 0 < ACCESS_POLICY_VERSION`, odpalał `migrateAccessPolicy` i przepisywał plik
 * PO KAŻDYM zapisie. Testy „plik ma TYLKO X" niżej liczą się z tym jednym stałym polem.
 *
 * Wzór atrapy vaulta: `agent_yaml_roundtrip.test.ts` / `permission_switches.test.ts`.
 */
import test from 'ava';
import { parseYaml } from '../../core/utils/yamlParser.js';
import { Agent } from './Agent.js';
import { AgentLoader } from './AgentLoader.js';
import { createJaskier } from './archetypes/index.js';
import { ACCESS_POLICY_VERSION } from './accessPolicy.js';
import { log } from '../../core/utils/Logger.js';

/** A1: pomija stałe meta-pole `access_policy_version`, żeby asercje „plik ma TYLKO X" nie
 * musiały wypisywać go w każdym oczekiwanym obiekcie z osobna. */
function withoutMeta(written: Record<string, unknown> | null): Record<string, unknown> {
    const rest: Record<string, unknown> = { ...(written || {}) };
    delete rest.access_policy_version;
    return rest;
}

function makeMemoryVault() {
    const files: Record<string, string> = {};
    return {
        files,
        adapter: {
            async exists(path: string) { return Object.prototype.hasOwnProperty.call(files, path); },
            async mkdir() { /* no-op */ },
            async list(folder: string) {
                return { files: Object.keys(files).filter(f => f.startsWith(`${folder}/`)), folders: [] };
            },
            async read(path: string) { return files[path]; },
            async write(path: string, content: string) { files[path] = content; },
            async remove(path: string) { delete files[path]; },
        },
    };
}

test('C1: agent identyczny z Jaskrem fabrycznym zapisuje plik nadpisań PUSTY poza meta-polem access_policy_version', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const jaskier = createJaskier(); // zero zmian względem baseline
    await loader.saveBuiltInOverrides(jaskier);

    const written = parseYaml(vault.files['.pkm-assistant/agents/jaskier_overrides.yaml']) as Record<string, unknown> | null;
    // A1: `access_policy_version` jest ZAWSZE obecne (meta-pole, patrz nagłówek pliku) — reszta
    // musi być pusta, dokładnie jak przed A1.
    const keys = Object.keys(withoutMeta(written));
    t.deepEqual(keys, [], `Plik nadpisań agenta bez zmian powinien być pusty poza access_policy_version, ma klucze: ${keys.join(', ')}`);
    t.is(written?.access_policy_version, ACCESS_POLICY_VERSION, 'access_policy_version musi być zapisane nawet gdy zgadza się z baseline (A1)');
});

test('C1: agent = default + zmieniona JEDNA wartość → plik ma TYLKO tę wartość (+ access_policy_version)', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const jaskier = createJaskier();
    jaskier.update({ temperature: 0.2 }); // jedyna zmiana względem baseline

    await loader.saveBuiltInOverrides(jaskier);

    const written = parseYaml(vault.files['.pkm-assistant/agents/jaskier_overrides.yaml']) as Record<string, unknown>;
    t.deepEqual(withoutMeta(written), { temperature: 0.2 },
        `Plik nadpisań powinien nieść WYŁĄCZNIE temperature poza meta-polem, dostał: ${JSON.stringify(written)}`);
    t.is(written.access_policy_version, ACCESS_POLICY_VERSION);
});

test('C1: zmiana emoji/color/personality nie wycieka reszty fabrycznego configu (regres B6 Rundy 3, p.5)', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const jaskier = createJaskier();
    jaskier.update({ emoji: '🐦' });

    await loader.saveBuiltInOverrides(jaskier);

    const written = parseYaml(vault.files['.pkm-assistant/agents/jaskier_overrides.yaml']) as Record<string, unknown>;
    t.deepEqual(withoutMeta(written), { emoji: '🐦' });
    t.false('personality' in written, 'personality fabryczna wyciekła do pliku nadpisań mimo braku zmiany');
    t.false('color' in written, 'color fabryczny wyciekł do pliku nadpisań mimo braku zmiany');
    t.false('skills' in written, 'skills fabryczne wyciekły do pliku nadpisań mimo braku zmiany');
    t.false('disabled_tools' in written, 'disabled_tools fabryczne wyciekły do pliku nadpisań mimo braku zmiany');
});

test('C1: pole różniące się od baseline w TABLICY (disabled_tools) jest zapisywane', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const jaskier = createJaskier();
    // 'list' is ON by default (not in the factory disabled set) — disabling it is a real diff,
    // unlike a tool that is already OFF by default (e.g. 'write' — a no-op that would falsely
    // pass this test without exercising the diff at all).
    t.false(jaskier.disabled_tools.includes('list'), 'test setup invariant: `list` must be ON by default for this test to prove anything');
    const customDisabled = [...jaskier.disabled_tools, 'list'];
    jaskier.update({ disabled_tools: customDisabled });

    await loader.saveBuiltInOverrides(jaskier);

    const written = parseYaml(vault.files['.pkm-assistant/agents/jaskier_overrides.yaml']) as Record<string, unknown>;
    t.true('disabled_tools' in written, 'zmienione disabled_tools musi trafić do diffu');
    t.deepEqual((written.disabled_tools as string[]).slice().sort(), jaskier.disabled_tools.slice().sort());
});

test('C1: diff-only override file jest kompatybilny z odczytem (round-trip przez loadBuiltInAgents)', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const jaskier = createJaskier();
    jaskier.update({ temperature: 0.3, emoji: '🎨' });
    await loader.saveBuiltInOverrides(jaskier);

    // Świeży load: nowa instancja Jaskra + merge nadpisań (dokładnie ścieżka produkcyjna).
    const [loaded] = await loader.loadBuiltInAgents();
    t.is(loaded.temperature, 0.3, 'temperature z diff-only override musi wrócić po odczycie');
    t.is(loaded.emoji, '🎨', 'emoji z diff-only override musi wrócić po odczycie');
    // Pola NIEOBECNE w diffie muszą zostać na wartości fabrycznej, nie znikać.
    t.is(loaded.personality, createJaskier().personality, 'personality bez zmiany musi zostać fabryczna po odczycie diff-only pliku');
    t.deepEqual(loaded.disabled_tools.slice().sort(), createJaskier().disabled_tools.slice().sort());
});

test('C1: pole nieobecne w baseline, a ustawione na agencie, jest zapisywane (fail-safe strony diffu)', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const jaskier = createJaskier();
    // `agent_rules` nie jest ustawione w HUMAN_VIBE_CONFIG (baseline go nie ma) — user go dodaje.
    jaskier.update({ agent_rules: 'Grafiki w 16:9.' });

    await loader.saveBuiltInOverrides(jaskier);

    const written = parseYaml(vault.files['.pkm-assistant/agents/jaskier_overrides.yaml']) as Record<string, unknown>;
    t.is(written.agent_rules, 'Grafiki w 16:9.');
});

test('C1: saveAgent(jaskier) deleguje do saveBuiltInOverrides (guard K3 nietknięty)', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const jaskier = createJaskier();
    jaskier.update({ temperature: 0.5 });
    await loader.saveAgent(jaskier);

    t.true('.pkm-assistant/agents/jaskier_overrides.yaml' in vault.files);
    t.false('.pkm-assistant/agents/jaskier.yaml' in vault.files, 'built-in nie może dostać zwykłego pliku agenta');
});

test('C1: agent zwykły (nie built-in) nadal dostaje pełny serialize(), bez diffu', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const custom = new Agent({ name: 'Tola', personality: 'Zwięzła.', isBuiltIn: false });
    await loader.saveAgent(custom);

    const written = parseYaml(vault.files['.pkm-assistant/agents/tola.yaml']) as Record<string, unknown>;
    t.is(written.personality, 'Zwięzła.');
    t.is(written.name, 'Tola', 'agent zwykły zapisuje name w pliku (built-in go usuwa)');
});

// ─── A1 (klaster C4b, nit na C1): `access_policy_version` zawsze w diffie → migracja nie
// odpala się już przy KAŻDYM kolejnym load po zapisie profilu (patrz nagłówek pliku).

test('A1: po saveBuiltInOverrides na niezmienionym Jaskrze kolejny load NIE odpala migracji (zero zapisów, treść pliku nietknięta)', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    const jaskier = createJaskier(); // zero zmian względem baseline
    await loader.saveBuiltInOverrides(jaskier);

    const overridePath = '.pkm-assistant/agents/jaskier_overrides.yaml';
    const contentAfterSave = vault.files[overridePath];
    t.true(contentAfterSave.includes('access_policy_version'),
        'zapis musi zawierać access_policy_version — inaczej migracja odpali się przy odczycie');

    let writeCalls = 0;
    const originalWrite = vault.adapter.write.bind(vault.adapter);
    vault.adapter.write = async (path: string, content: string) => {
        writeCalls += 1;
        return originalWrite(path, content);
    };

    // Świeży load: DOKŁADNIE ścieżka produkcyjna (_mergeBuiltInOverrides → _migrateLegacyAgentFormat
    // → migrateAccessPolicy). Bez fixu A1 to wołanie zapisuje plik i loguje „Migrated built-in
    // override" — po KAŻDYM saveBuiltInOverrides, w nieskończoność.
    const [loaded] = await loader.loadBuiltInAgents();

    t.is(writeCalls, 0, 'load na diff-only pliku z access_policy_version nie może wywołać ŻADNEGO zapisu (migracja nie powinna się odpalić)');
    t.is(vault.files[overridePath], contentAfterSave, 'treść pliku nadpisań musi zostać identyczna po load');
    t.is(loaded.access_policy_version, ACCESS_POLICY_VERSION, 'agent po load ma poprawną wersję, bez potrzeby migracji w locie');
});

// ─── A2 (klaster C4b, nit na C1): baseline diffu jest per built-in, nie hardcoded Jaskier.

test('A2: built-in bez zarejestrowanego baseline (agent.name spoza BUILT_IN_BASELINES) dostaje pełny serialize() — fallback, nie diff', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);

    // Symuluje przyszłego DRUGIEGO built-ina, którego ktoś zapomniał dopisać do
    // BUILT_IN_BASELINES — diffowanie względem createJaskier() byłoby diffem względem CUDZEGO
    // baseline'u (fałszywe zniknięcia/wycieki pól po przypadkowej zbieżności wartości).
    const ghost = new Agent({
        name: 'GhostBuiltIn',
        isBuiltIn: true,
        personality: 'Duch bez zarejestrowanego baseline.',
        temperature: 0.9,
    });

    await loader.saveBuiltInOverrides(ghost);

    const expected = ghost.serialize();
    delete expected.name; // saveBuiltInOverrides usuwa name z zapisu (nazwa built-ina jest hardcoded)

    const written = parseYaml(vault.files['.pkm-assistant/agents/ghostbuiltin_overrides.yaml']) as Record<string, unknown>;
    t.deepEqual(written, expected, 'bez zarejestrowanego baseline zapis musi być pełnym serialize() (zachowanie sprzed C1), nie diffem');
    t.is(written.personality, 'Duch bez zarejestrowanego baseline.');
    t.is(written.temperature, 0.9);
});

// F2.22 (release 2.2.0/W3): ostrzeżenie „brak baseline" krzyczało przy KAŻDYM zapisie profilu
// tego built-ina, w nieskończoność — realna wartość jest w PIERWSZYM ostrzeżeniu, reszta to szum.
test.serial('F2.22: log.warn „brak baseline" leci RAZ per nazwę agenta, nie przy każdym zapisie', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);
    const ghost = new Agent({ name: 'GhostBuiltInDedup', isBuiltIn: true, temperature: 0.1 });

    const calls: unknown[][] = [];
    const originalWarn = log.warn;
    log.warn = (...args: unknown[]) => { calls.push(args); };
    try {
        await loader.saveBuiltInOverrides(ghost);
        ghost.update({ temperature: 0.2 });
        await loader.saveBuiltInOverrides(ghost);
        ghost.update({ temperature: 0.3 });
        await loader.saveBuiltInOverrides(ghost);
    } finally {
        log.warn = originalWarn;
    }

    const missingBaselineWarnings = calls.filter(args => String(args[1] ?? '').includes('brak zarejestrowanego baseline'));
    t.is(missingBaselineWarnings.length, 1, 'trzy zapisy tego samego agenta bez baseline → JEDNO ostrzeżenie w logu, nie trzy');
});
