/**
 * YAML agenta: `model` jest zapisywane TYLKO gdy świadomie ustawione (Default OFF), a
 * `language` i inne pola usera PRZEŻYWAJĄ zapis - włącznie z automatycznym rewrite'em pliku,
 * jaki `AgentLoader.loadAgentFromFile` odpala przy migracji osi narzędziowej (jedyny
 * automatyczny REWRITE całego pliku, który dzieje się bez kliknięcia "Zapisz profil"). Testy
 * działają na atrapie vaulta w pamięci (żadnego dotknięcia realnego dysku ani vaulta usera)
 * i pilnują dokładnie tego kształtu regresji: żadna ścieżka w `modules/agents`/`modules/chat`/
 * `modules/models`/`modules/tools`/`modules/sub-agents`/`modules/shell` nie może mutować
 * `agent.model` na twardą wartość bez udziału usera.
 *
 * `emoji` miało tę samą klasę błędu (pole schematu bez wiązania z instancją) - patrz testy
 * niżej.
 */
import test from 'ava';
import { parseYaml } from '../../core/utils/yamlParser.js';
import { Agent } from './Agent.js';
import { AgentLoader } from './AgentLoader.js';

/** Vault-atrapa w pamięci: tylko to, czego dotyka AgentLoader (wzór permission_switches.test.ts). */
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

// ── Reprodukcja: yaml stary (bez disabled_tools) z language, BEZ model ────────────────

test('agent bez model + z language przeżywa migrację osi narzędziowej (auto-rewrite przy load)', async t => {
    const vault = makeMemoryVault();
    // Stary format: brak `disabled_tools` (tablicy) → konstruktor Agenta wylicza go z legacy
    // (`mcp_servers`/`enabled_tools`/`permissions`) i AgentLoader od razu PRZEPISUJE plik w formie
    // kanonicznej — to JEDYNY automatyczny full-rewrite, jaki dzieje się bez „Zapisz profil".
    vault.files['.pkm-assistant/agents/tola.yaml'] = [
        'name: Tola',
        'language: pl',
        'personality: Zwięzła i konkretna.',
        'mcp_servers:',
        '  - vault',
    ].join('\n');

    const loader = new AgentLoader(vault as never);
    const agent = await loader.loadAgentFromFile('.pkm-assistant/agents/tola.yaml');

    t.truthy(agent);
    t.is(agent!.language, 'pl', 'language wczytany do instancji Agenta');
    t.is(agent!.model, null, 'model nie był w yamlu — instancja go nie ma');
    t.true(agent!._toolAxisMigrated, 'punkt wyjścia: to jest dokładnie ścieżka auto-rewrite');

    // Plik PO auto-migracji (loader dopisał disabled_tools i przepisał całość agent.serialize()).
    const rewritten = parseYaml(vault.files['.pkm-assistant/agents/tola.yaml']) as Record<string, unknown>;
    t.is(rewritten.language, 'pl', 'language PRZEŻYWA automatyczny rewrite migracji osi narzędziowej');
    t.false('model' in rewritten, 'model NIE pojawia się znikąd w automatycznym rewrite');
});

// ── Ta sama ścieżka, ale przez update() + saveAgent — symulacja zapisu profilu ────────

test('update() pola niezwiązanego z modelem + saveAgent nie wstrzykuje model ani nie gubi language', async t => {
    const vault = makeMemoryVault();
    vault.files['.pkm-assistant/agents/klara.yaml'] = [
        'name: Klara',
        'language: en',
        'disabled_tools: []',
    ].join('\n');

    const loader = new AgentLoader(vault as never);
    const agent = await loader.loadAgentFromFile('.pkm-assistant/agents/klara.yaml');
    t.truthy(agent);
    t.false(agent!._toolAxisMigrated, 'yaml już miał disabled_tools — brak auto-rewrite przy load');

    // Symulacja: user edytuje coś NIEZWIĄZANEGO z modelem (np. personality) i zapisuje profil —
    // dokładnie to, co `AgentManager.updateAgent` robi: `agent.update(rest)` + `loader.saveAgent`.
    agent!.update({ personality: 'Energiczna, szybka.' });
    await loader.saveAgent(agent!);

    const rewritten = parseYaml(vault.files['.pkm-assistant/agents/klara.yaml']) as Record<string, unknown>;
    t.is(rewritten.language, 'en', 'language przeżywa zapis niezwiązanej zmiany');
    t.false('model' in rewritten, 'zapis niezwiązanego pola nie dopisuje model');
});

// ── Model JAWNIE ustawiony w yamlu przeżywa round-trip (Default OFF działa w OBIE strony) ──

test('agent z JAWNIE ustawionym model w yamlu zachowuje go po round-tripie', async t => {
    const vault = makeMemoryVault();
    vault.files['.pkm-assistant/agents/borys.yaml'] = [
        'name: Borys',
        'model: openai/gpt-4o',
        'disabled_tools: []',
    ].join('\n');

    const loader = new AgentLoader(vault as never);
    const agent = await loader.loadAgentFromFile('.pkm-assistant/agents/borys.yaml');
    t.is(agent!.model, 'openai/gpt-4o');

    await loader.saveAgent(agent!);
    const rewritten = parseYaml(vault.files['.pkm-assistant/agents/borys.yaml']) as Record<string, unknown>;
    t.is(rewritten.model, 'openai/gpt-4o', 'model jawnie ustawiony przez usera przeżywa zapis');
});

// ── Czyszczenie pola w profilu (pusty string) nie zostawia model:'' ani nie wstrzykuje domyślnego ──

test('czyszczenie modelu w profilu (pusty string → null) nie zostawia model:"" ani domyślnej wartości', t => {
    const agent = new Agent({ name: 'Igor', model: 'anthropic/claude-3-5-sonnet-20241022' });
    t.is(agent.model, 'anthropic/claude-3-5-sonnet-20241022');

    // profile_advanced.handleSave: `model: formData.model || null` — pusty string z pola select
    // zamienia się na `null` PRZED update(), tak jak robi to prawdziwy handler.
    agent.update({ model: '' || null } as never);

    const data = agent.serialize();
    t.false('model' in data, 'wyczyszczenie pola nie zostawia ani pustego stringa, ani starej wartości');
});

// ── Round-trip innych pól usera (komunikator_visible, default_autonomy, models, prompt_overrides, mcp_servers) ──

test('round-trip kompletu pól usera przez auto-rewrite migracji — nic nie ginie poza samym model', async t => {
    const vault = makeMemoryVault();
    vault.files['.pkm-assistant/agents/wera.yaml'] = [
        'name: Wera',
        'language: pl',
        'komunikator_visible: false',
        'default_autonomy: edge',
        'models:',
        '  researcher: openai/gpt-4o-mini',
        'prompt_overrides:',
        '  agent_rules: Zawsze pisz krótko.',
        'mcp_servers:',
        '  - vault',
        '  - memory',
        // Brak disabled_tools → wymusza auto-rewrite migracji w loadAgentFromFile.
    ].join('\n');

    const loader = new AgentLoader(vault as never);
    const agent = await loader.loadAgentFromFile('.pkm-assistant/agents/wera.yaml');
    t.true(agent!._toolAxisMigrated, 'punkt wyjścia: auto-rewrite się odpala');

    const rewritten = parseYaml(vault.files['.pkm-assistant/agents/wera.yaml']) as Record<string, unknown>;
    t.is(rewritten.language, 'pl');
    t.is(rewritten.komunikator_visible, false);
    t.is(rewritten.default_autonomy, 'edge');
    t.deepEqual(rewritten.models, { researcher: 'openai/gpt-4o-mini' });
    t.deepEqual(rewritten.prompt_overrides, { agent_rules: 'Zawsze pisz krótko.' });
    t.deepEqual(rewritten.mcp_servers, ['vault', 'memory']);
    t.false('model' in rewritten, 'nadal brak model — nic go nie ustawiło w tej ścieżce');
});

// ── `emoji` jest w AgentConfig/allowedFields od zawsze, ale konstruktor go nie czytał -
// dokładnie ta sama klasa błędu co `language` (pole schematu, zerowe wiązanie z instancją),
// tylko że TU realnie łamie widoczną funkcję: `chat_popovers.ts` i `chat_streaming.ts` czytają
// `agent.emoji` na komunikaty "czeka…"/"skończył" (fallback `◆`), a NAWET Jaskier
// (`HUMAN_VIBE_CONFIG.emoji: '🎭'`) dostawał ten sam placeholder co reszta.

test('emoji z yamla trafia do instancji Agenta', t => {
    const agent = new Agent({ name: 'Jaskier', emoji: '🎭' });
    t.is(agent.emoji, '🎭', 'agent.emoji musi nieść wartość z configu, nie undefined');
});

test('emoji przeżywa round-trip load → serialize (auto-rewrite migracji)', async t => {
    const vault = makeMemoryVault();
    vault.files['.pkm-assistant/agents/zoja.yaml'] = [
        'name: Zoja',
        'emoji: "🌙"',
    ].join('\n');

    const loader = new AgentLoader(vault as never);
    const agent = await loader.loadAgentFromFile('.pkm-assistant/agents/zoja.yaml');
    t.is(agent!.emoji, '🌙');

    const rewritten = parseYaml(vault.files['.pkm-assistant/agents/zoja.yaml']) as Record<string, unknown>;
    t.is(rewritten.emoji, '🌙', 'emoji przeżywa automatyczny rewrite migracji osi narzędziowej');
});

test('emoji nieustawiony nie zaśmieca yamla (Default OFF, wzór color)', t => {
    const data = new Agent({ name: 'Bezimienny' }).serialize();
    t.false('emoji' in data);
});
