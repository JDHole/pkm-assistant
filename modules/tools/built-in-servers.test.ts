import test from 'ava';
import { BUILTIN_MANIFESTS, resolveBuiltinManifests, getBuiltinManifest } from './built-in-servers/index.js';
import { ServerLoader } from './ServerLoader.js';

const emptyVault = () => ({ adapter: { exists: async () => false, list: async () => ({ folders: [] }) } });
const toolNames = (server: { tools?: Array<string | { name: string }> }) => (server.tools || []).map(x => (typeof x === 'string' ? x : x.name));

test('BUILTIN_MANIFESTS: 8 servers registered (no skills server)', t => {
    t.is(BUILTIN_MANIFESTS.length, 8);
    const names = BUILTIN_MANIFESTS.map(m => m.name).sort();
    t.deepEqual(names, ['artifacts', 'core', 'delegation', 'komunikator', 'memory', 'multimodal', 'vault', 'web']);
});

test('every built-in manifest has required fields', t => {
    for (const m of BUILTIN_MANIFESTS) {
        t.truthy(m.name, `manifest missing name`);
        t.truthy(m.version, `${m.name}: missing version`);
        t.truthy(m.description, `${m.name}: missing description`);
        t.true(Array.isArray(m.tools) && m.tools.length > 0, `${m.name}: tools must be non-empty array`);
        t.is(m.source, 'built-in');
        t.is(m.removable, false);
        t.true(typeof m.timeout_ms === 'number', `${m.name}: timeout_ms must be number`);
    }
});

test('core manifest is always-available (timeout 60s, simplest tools)', t => {
    const core = getBuiltinManifest('core')!;
    t.deepEqual(core.tools.sort(), ['ask_user']);
    t.is(core.timeout_ms, 60_000);
});

test('artifacts manifest owns living-artifact tools + todo (bez starych review/chat_todo)', t => {
    const artifacts = getBuiltinManifest('artifacts')!;
    t.deepEqual(
        artifacts.tools.sort(),
        ['artifact_create', 'artifact_list', 'artifact_read', 'artifact_update', 'todo'],
    );
    // Stary świat skasowany (backward-compat przez aliasy).
    t.false(artifacts.tools.includes('chat_todo'));
    t.false(artifacts.tools.includes('idea_review'));
    t.false(artifacts.tools.includes('plan_review'));
    t.is(artifacts.timeout_ms, 60_000);
});

test('multimodal manifest has 180s timeout (long-running image gen)', t => {
    const mm = getBuiltinManifest('multimodal')!;
    t.is(mm.timeout_ms, 180_000);
});

test('vault manifest has 6 prymitywów (read/list/write/delete/create_folder + search)', t => {
    const vault = getBuiltinManifest('vault')!;
    t.is(vault.tools.length, 6);
    t.true(vault.tools.includes('read'));
    t.true(vault.tools.includes('list'));
    t.true(vault.tools.includes('write'));
    t.true(vault.tools.includes('search')); // unified retrieval
    // Prefixowane vault_* zastąpione prymitywami; retrieval → `search`.
    t.false(vault.tools.includes('vault_read'));
    t.false(vault.tools.includes('vault_search'));
});

test('A2 manifests nie udają whitelisty default_roles', t => {
    for (const manifest of BUILTIN_MANIFESTS) {
        t.false(Object.hasOwn(manifest, 'default_roles'), `${manifest.name}: default_roles powinno zniknąć`);
    }
});

test('memory manifest has 2 write tools (read/list moved to vault server, scope=memory)', t => {
    const memory = getBuiltinManifest('memory')!;
    t.is(memory.tools.length, 2);
    t.true(memory.tools.includes('memory_save'));
    t.true(memory.tools.includes('memory_delete'));
    // memory_read/read_summary/list_summaries wchłonięte przez read/list (scope=memory).
    t.false(memory.tools.includes('memory_read'));
    t.false(memory.tools.includes('memory_list_summaries'));
    // legacy brain_update guard is no longer registered (direct brain.md writes disabled).
    t.false(memory.tools.includes('brain_update'));
});

test('komunikator manifest has the three mail primitives (no Project Hub)', t => {
    const komunikator = getBuiltinManifest('komunikator')!;
    t.deepEqual(komunikator.tools, ['kom_send', 'kom_list', 'kom_read']);
    // Project Hub nie istnieje — żaden kom_*_project/thread/brief nie może wrócić.
    t.false(komunikator.tools.some(name => /project|thread|brief/.test(name)));
});

test('delegation manifest no longer carries agent_message', t => {
    const delegation = getBuiltinManifest('delegation')!;
    t.deepEqual(delegation.tools, ['delegate', 'agent_delegate']);
});

test('resolveBuiltinManifests: komunikatorEnabled=false drops the komunikator server (kill-switch)', t => {
    const resolved = resolveBuiltinManifests({ pluginVersion: '2.0.0', komunikatorEnabled: false });
    const names = resolved.map(m => m.name);
    t.false(names.includes('komunikator'), 'komunikator server must be hidden');
    t.is(resolved.length, 7);
    // Delegacja przeżywa w całości — działa bez KomunikatorManagera.
    const delegation = resolved.find(m => m.name === 'delegation')!;
    t.true(delegation.tools.includes('delegate'));
    t.true(delegation.tools.includes('agent_delegate'));
    // Filtering must not mutate the static BUILTIN_MANIFESTS source.
    t.truthy(getBuiltinManifest('komunikator'));
});

test('resolveBuiltinManifests: komunikatorEnabled=true (and default) keeps everything', t => {
    const enabled = resolveBuiltinManifests({ pluginVersion: '2.0.0', komunikatorEnabled: true });
    t.true(enabled.some(m => m.name === 'komunikator'));
    t.is(enabled.length, 8);
    t.true(enabled.find(m => m.name === 'komunikator')!.tools.includes('kom_send'));
    // No flag = bypass (backward-compatible default).
    t.is(resolveBuiltinManifests({ pluginVersion: '2.0.0' }).length, 8);
});

test('resolveBuiltinManifests: resolves "plugin" sentinel to provided pluginVersion', t => {
    const resolved = resolveBuiltinManifests({ pluginVersion: '2.0.0' });
    for (const m of resolved) {
        t.is(m.version, '2.0.0', `${m.name}: version sentinel not resolved`);
    }
});

test('resolveBuiltinManifests: defaults to "1.0.0" when pluginVersion missing', t => {
    const resolved = resolveBuiltinManifests({});
    for (const m of resolved) {
        t.is(m.version, '1.0.0');
    }
});

test('getBuiltinManifest: returns null for unknown server', t => {
    t.is(getBuiltinManifest('nonexistent'), null);
});

test('getBuiltinManifest: case-sensitive names', t => {
    t.truthy(getBuiltinManifest('vault'));
    t.is(getBuiltinManifest('Vault'), null); // wrong case
});

test('ServerLoader: komunikatorEnabled=false hides the komunikator server from the catalog agents see', async t => {
    const loader = new ServerLoader(emptyVault(), { pluginVersion: '2.0.0', komunikatorEnabled: false });
    await loader.loadAllServers();
    t.is(loader.getServer('komunikator'), null, 'komunikator server must not be in the catalog');
    t.true(toolNames(loader.getServer('delegation')!).includes('delegate'), 'delegate survives');
    t.truthy(loader.getServer('vault'), 'other built-ins still present');
});

test('ServerLoader: default (no flag) keeps the komunikator server (bypass)', async t => {
    const loader = new ServerLoader(emptyVault(), { pluginVersion: '2.0.0' });
    await loader.loadAllServers();
    t.truthy(loader.getServer('komunikator'));
    t.true(toolNames(loader.getServer('komunikator')!).includes('kom_send'));
});
