/**
 * K3 (AUD-security-024 / 025) — POPOVER UPRAWNIEŃ PRZESTAJE KŁAMAĆ.
 *
 * 025: przełączniki „odczyt / edycja / tworzenie / usuwanie" pisały w `default_permissions`,
 * czyli w klucze, które `Agent._normalizePermissions` cicho kasuje, a `checkPermission` i tak
 * nigdy nie czytał. Teraz liczą się na `disabled_tools` — jedynej osi, którą ktokolwiek
 * egzekwuje (`ToolRegistry.checkToolAxis`, i przy widoczności, i przy wykonaniu).
 *
 * 024: zapis dla agenta WBUDOWANEGO szedł do `<nazwa>.yaml`, który `loadAllAgents` odfiltrowuje —
 * ustawienie znikało po restarcie. Loader ma teraz twardy guard: built-in → plik nadpisań.
 */
import test from 'ava';
import {
    PERMISSION_SWITCH_TOOLS,
    PERMISSION_PRESET_SWITCHES,
    isPermissionSwitchOn,
    applyPermissionSwitch,
    applyPermissionPreset,
} from './toolAxis.js';
import { ALL_BUILTIN_TOOLS } from './toolAxis.js';
import { Agent } from './Agent.js';
import { AgentLoader } from './AgentLoader.js';

// ── AUD-security-025: przełączniki piszą tam, gdzie ktoś patrzy ───────────────

test('K3: każdy przełącznik popovera wskazuje ISTNIEJĄCE narzędzia built-in', t => {
    for (const [key, tools] of Object.entries(PERMISSION_SWITCH_TOOLS)) {
        t.true(tools.length > 0, `przełącznik ${key} bez narzędzi = znowu martwy`);
        for (const tool of tools) {
            t.true(ALL_BUILTIN_TOOLS.includes(tool), `${key} → nieznane narzędzie "${tool}"`);
        }
    }
});

test('K3: wyłączenie „Usuwanie plików" ląduje w disabled_tools, nie w polu-widmie', t => {
    const wylaczone = applyPermissionSwitch([], 'delete_files', false);
    t.true(wylaczone.includes('delete'));
    t.false(isPermissionSwitchOn(wylaczone, 'delete_files'));

    // I to przeżywa przejście przez klasę Agent (czego `default_permissions.delete_files` nie robił).
    const agent = new Agent({ name: 'T', disabled_tools: wylaczone });
    t.true(agent.disabled_tools.includes('delete'), 'Agent zachował wyłączenie');
    t.false('delete_files' in agent.permissions, 'stare pole nadal jest widmem — dlatego go nie używamy');
});

test('K3: przełącznik nie rusza narzędzi spoza swojej mapy', t => {
    const start = ['web_search', 'delete'];
    const po = applyPermissionSwitch(start, 'edit_notes', false);
    t.true(po.includes('web_search'), 'ustawienie z profilu przetrwało klikanie w popoverze');
    t.true(po.includes('delete'));
    t.true(po.includes('write'));
});

test('K3: włączenie przełącznika zdejmuje WSZYSTKIE jego narzędzia', t => {
    const start = ['read', 'list', 'search', 'write'];
    const po = applyPermissionSwitch(start, 'read_notes', true);
    t.deepEqual(po, ['write']);
    t.true(isPermissionSwitchOn(po, 'read_notes'));
});

test('K3: stan mieszany pokazujemy jako OFF (UI nie obiecuje więcej niż agent ma)', t => {
    t.false(isPermissionSwitchOn(['search'], 'read_notes'), 'jedno z trzech wyłączone = przełącznik OFF');
    t.true(isPermissionSwitchOn([], 'read_notes'));
});

test('K3: presety różnią się dokładnie tym, co obiecują etykiety', t => {
    const bezpieczny = applyPermissionPreset([], PERMISSION_PRESET_SWITCHES.safe);
    const standard = applyPermissionPreset([], PERMISSION_PRESET_SWITCHES.standard);
    const pelny = applyPermissionPreset([], PERMISSION_PRESET_SWITCHES.full);

    t.true(bezpieczny.includes('write') && bezpieczny.includes('delete'), 'Bezpieczny = tylko czytanie');
    t.false(standard.includes('write'), 'Standard pozwala pisać');
    t.true(standard.includes('delete'), 'Standard nie pozwala kasować');
    t.deepEqual(pelny, [], 'Pełny nie wyłącza nic z osi vaultowej');
});

test('K3: preset NIE rusza grup spoza osi vaultowej', t => {
    const po = applyPermissionPreset(['web_search', 'kom_send'], PERMISSION_PRESET_SWITCHES.full);
    t.deepEqual(po.sort(), ['kom_send', 'web_search']);
});

test('K3: `mcp` NIE ma już przełącznika — opt-in konektora jest per serwer', t => {
    t.false('mcp' in PERMISSION_SWITCH_TOOLS);
    t.is(applyPermissionSwitch(['write'], 'mcp', true).join(','), 'write', 'nieznany klucz nic nie zmienia');
});

// ── AUD-security-024: zapis built-ina trafia do pliku, który loader czyta ─────

/** Vault-atrapa w pamięci: tylko to, czego dotyka AgentLoader. */
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

test('K3: saveAgent dla agenta WBUDOWANEGO pisze do pliku nadpisań, nie do <nazwa>.yaml', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);
    const [jaskier] = await loader.loadBuiltInAgents();

    jaskier.update({ disabled_tools: ['write', 'delete'] });
    const path = await loader.saveAgent(jaskier);

    t.is(path, '.pkm-assistant/agents/jaskier_overrides.yaml');
    t.false('.pkm-assistant/agents/jaskier.yaml' in vault.files, 'plik odrzucany przez loader NIE powstał');
});

test('K3: ograniczenie built-ina z popovera przeżywa restart (loadAllAgents je widzi)', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);
    const [jaskier] = await loader.loadBuiltInAgents();
    // Świeży Jaskier ma `write`/`delete` wyłączone z fabryki — test musi ruszyć coś, co jest ON,
    // inaczej „przetrwało restart" byłoby prawdą także bez zapisu.
    t.false(jaskier.disabled_tools.includes('read'), 'punkt wyjścia: odczyt włączony');

    jaskier.update({ disabled_tools: applyPermissionSwitch(jaskier.disabled_tools, 'read_notes', false) });
    await loader.saveAgent(jaskier);

    // „Restart": świeży loader na tym samym vaultcie.
    const poRestarcie = await new AgentLoader(vault as never).loadAllAgents();
    const wczytany = poRestarcie.find(a => a.name === 'Jaskier');
    t.truthy(wczytany);
    t.false(isPermissionSwitchOn(wczytany!.disabled_tools, 'read_notes'), 'wyłączenie odczytu przetrwało restart');
    t.true(wczytany!.disabled_tools.includes('search'), 'cała trójka read/list/search została wyłączona');
});

test('K3: agent CUSTOM dalej zapisuje się do <nazwa>.yaml (brak regresji)', async t => {
    const vault = makeMemoryVault();
    const loader = new AgentLoader(vault as never);
    const custom = new Agent({ name: 'Tola', disabled_tools: ['write'] });

    const path = await loader.saveAgent(custom);
    t.is(path, '.pkm-assistant/agents/tola.yaml');
    t.true('.pkm-assistant/agents/tola.yaml' in vault.files);
});
