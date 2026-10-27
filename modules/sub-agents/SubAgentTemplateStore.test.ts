import test from 'ava';
import { SubAgentTemplateStore as RuntimeSubAgentTemplateStore } from './SubAgentTemplateStore.js';
import { SubAgentLoader as RuntimeSubAgentLoader } from './SubAgentLoader.js';
import { editorModelOptions, modelListRoleForEditorRole, templateSaveNotice } from './editorDecisions.js';
import { getModelsForRole } from '../models/index.js';
import { t as translate } from '../../core/i18n/index.js';

type TestTemplate = Record<string, unknown> & { version: number; tools: string[]; prompt: string; role: string; model: string };
type TestStore = {
    createFromData(data: unknown): Promise<Record<string, unknown>>;
    save(slug: string, data: unknown): Promise<Record<string, unknown>>;
    loadAll(): Promise<void>;
    count(): number;
    get(slug: string): TestTemplate;
    instantiate(slug: string, agent: string, options: unknown): Promise<Record<string, unknown>>;
    delete(slug: string): Promise<boolean>;
};
const SubAgentTemplateStore = RuntimeSubAgentTemplateStore as unknown as new (vault: unknown) => TestStore;
const SubAgentLoader = RuntimeSubAgentLoader as unknown as new (vault: unknown) => { getSubAgent(name: string): { from_template?: string | null } };

function makeVault(files: Record<string, string> = {}, folders: string[] = []) {
    const folderSet = new Set<string>(folders);
    return {
        files,
        folders: folderSet,
        adapter: {
            exists: async (path: string) => Object.hasOwn(files, path) || folderSet.has(path),
            read: async (path: string) => files[path],
            write: async (path: string, value: string) => { files[path] = value; },
            remove: async (path: string) => { delete files[path]; },
            mkdir: async (path: string) => { folderSet.add(path); },
            rmdir: async (path: string, recursive: boolean) => {
                if (!recursive) throw Object.assign(new Error('is a directory'), { code: 'ERR_FS_EISDIR' });
                for (const file of Object.keys(files)) if (file.startsWith(`${path}/`)) delete files[file];
                for (const folder of folderSet) if (folder === path || folder.startsWith(`${path}/`)) folderSet.delete(folder);
            },
            list: async (path: string) => ({
                folders: [...folderSet].filter(f => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/')),
                files: Object.keys(files).filter(f => f.startsWith(`${path}/`)),
            }),
        },
    };
}

const BASE = '.pkm-assistant/templates/sub-agents';

test('delete usuwa pusty folder szablonu suba', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Plan', description: 'x', prompt: 'y' });
    t.true(await store.delete('plan'));
    t.false(await vault.adapter.exists(`${BASE}/plan`));
    t.is(store.count(), 0);
});

test('delete szablonu suba zachowuje dodatkowy plik', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Plan', description: 'x', prompt: 'y' });
    vault.files[`${BASE}/plan/notatki.md`] = 'Moje notatki';
    t.true(await store.delete('plan'));
    t.is(vault.files[`${BASE}/plan/notatki.md`], 'Moje notatki');
    t.is(store.count(), 0);
});

test('createFromData zapisuje szablon suba w version 1 (+ KNOWLEDGE.md)', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);

    const res = await store.createFromData({
        name: 'Zwiadowca',
        description: 'zbiera materiał',
        tools: ['search', 'read'],
        prompt: 'Szukaj i streszczaj.',
    });

    t.true(res.success);
    t.is(res.slug, 'zwiadowca');
    t.true(vault.files[`${BASE}/zwiadowca/SUB_AGENT.yaml`].includes('version: 1'));
    t.is(vault.files[`${BASE}/zwiadowca/KNOWLEDGE.md`], 'Szukaj i streszczaj.');
    t.is(store.count(), 1);
});

test('save podbija wersję szablonu suba', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'v1', tools: ['search'] });

    const res = await store.save('zwiadowca', { name: 'Zwiadowca', description: 'v2', tools: ['search', 'list'] });

    t.is(res.version, 2);
    t.true(vault.files[`${BASE}/zwiadowca/SUB_AGENT.yaml`].includes('version: 2'));
    t.deepEqual(store.get('zwiadowca').tools, ['search', 'list']);
});

test('zmiana nazwy zachowuje slug i folder także po ponownym wczytaniu', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'v1' });

    const result = await store.save('zwiadowca', { name: 'Badacz źródeł', description: 'v2' });
    const reloaded = new SubAgentTemplateStore(vault);
    await reloaded.loadAll();

    t.is(result.name, 'Badacz źródeł');
    t.is(reloaded.get('zwiadowca').name, 'Badacz źródeł');
    t.is(reloaded.get('zwiadowca').slug, 'zwiadowca');
    t.is(reloaded.get('zwiadowca').folderPath, `${BASE}/zwiadowca`);
    t.true(vault.files[`${BASE}/zwiadowca/SUB_AGENT.yaml`].includes('name: Badacz źródeł'));
});

test('oba komunikaty sukcesu pokazują nazwę faktycznie zapisaną przez magazyn', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'v1' });

    const created = await store.createFromData({ name: 'Zwiadowca', description: 'druga kopia' });
    const edited = await store.save('zwiadowca', { name: 'Nowa nazwa', description: 'v2' });
    const createdNotice = templateSaveNotice({ name: created.name as string });
    const editedNotice = templateSaveNotice({ name: edited.name as string, version: edited.version as number });

    t.is(store.get(created.slug as string).name, created.name);
    t.is(store.get('zwiadowca').name, edited.name);
    t.is(translate(createdNotice.messageKey, createdNotice.params, 'pl'), 'Szablon suba "Zwiadowca 2" zapisany w Zapleczu.');
    t.is(translate(editedNotice.messageKey, editedNotice.params, 'pl'), 'Szablon suba "Nowa nazwa" zapisany (v2).');
    t.is(translate(createdNotice.messageKey, createdNotice.params, 'en'), 'Sub-agent template "Zwiadowca 2" saved to Backstage.');
    t.is(translate(editedNotice.messageKey, editedNotice.params, 'en'), 'Sub-agent template "Nowa nazwa" saved (v2).');
});

test('zapis samego opisu zachowuje model spoza aktualnej biblioteki', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Badacz', description: 'przed edycją', role: 'researcher', model: 'legacy-model' });
    const existing = store.get('badacz');
    const settings = { modelLibrary: { minion: [{ platform: 'openai', model: 'new-model' }] } };
    const options = editorModelOptions(getModelsForRole(settings, modelListRoleForEditorRole(existing.role)), existing.model);
    const selected = options.find(option => option.model === existing.model)?.model;

    await store.save('badacz', { ...existing, description: 'po edycji', model: selected });
    const reloaded = new SubAgentTemplateStore(vault);
    await reloaded.loadAll();

    t.is(reloaded.get('badacz').description, 'po edycji');
    t.is(reloaded.get('badacz').model, 'legacy-model');
    t.true(vault.files[`${BASE}/badacz/SUB_AGENT.yaml`].includes('model: legacy-model'));
});

test('loadAll czyta szablony i pomija YAML bez name/description', async t => {
    const vault = makeVault({
        [`${BASE}/ok/SUB_AGENT.yaml`]: 'name: Ok\ndescription: dziala\nversion: 4\ntools:\n  - search\n',
        [`${BASE}/ok/KNOWLEDGE.md`]: 'Metoda.',
        [`${BASE}/zly/SUB_AGENT.yaml`]: 'name: Zly\n',
    }, [BASE, `${BASE}/ok`, `${BASE}/zly`]);
    const store = new SubAgentTemplateStore(vault);

    await store.loadAll();

    t.is(store.count(), 1);
    t.is(store.get('ok').version, 4);
    t.is(store.get('ok').prompt, 'Metoda.');
});

test('template read preserves missing, empty and alias lists', async t => {
    const vault = makeVault({
        [`${BASE}/missing/SUB_AGENT.yaml`]: 'name: Missing\ndescription: test\n',
        [`${BASE}/empty/SUB_AGENT.yaml`]: 'name: Empty\ndescription: test\ntools: []\n',
        [`${BASE}/aliases/SUB_AGENT.yaml`]: 'name: Aliases\ndescription: test\ntools: [vault_grep, vault_search, vault_read]\n',
    }, [BASE, `${BASE}/missing`, `${BASE}/empty`, `${BASE}/aliases`]);
    const store = new SubAgentTemplateStore(vault);
    await store.loadAll();
    t.deepEqual(store.get('missing').tools, []);
    t.deepEqual(store.get('empty').tools, []);
    t.deepEqual(store.get('aliases').tools, ['vault_grep', 'vault_search', 'vault_read']);
});

test('template copies preserve their effective tools immediately and after reload', async t => {
    const vault = makeVault();
    const store = new RuntimeSubAgentTemplateStore(vault);
    const loader = new RuntimeSubAgentLoader(vault);
    await store.createFromData({ name: 'Empty', description: 'test' });
    await store.createFromData({ name: 'Read', description: 'test', tools: ['read'] });
    await store.instantiate('empty', 'parent', { subAgentLoader: loader });
    await store.instantiate('read', 'parent', { subAgentLoader: loader });
    const check = () => {
        t.deepEqual(loader.getSubAgent('parent-empty')?.tools, ['search', 'list', 'read', 'web_search', 'web_read']);
        t.deepEqual(loader.getSubAgent('parent-read')?.tools, ['read']);
    };
    check();
    await loader.reloadSubAgents();
    check();
    await store.loadAll();
    t.deepEqual(store.get('empty')?.tools, []);
    t.deepEqual(store.get('read')?.tools, ['read']);
});

test('instantiate tworzy suba <agent>-<slug> ze śladem from_template', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'zbiera', tools: ['search'], prompt: 'Metoda.' });
    await store.save('zwiadowca', { name: 'Zwiadowca', description: 'zbiera v2', tools: ['search'], prompt: 'Metoda v2.' });

    const subAgentLoader = new SubAgentLoader(vault);
    const res = await store.instantiate('zwiadowca', 'Klara', { subAgentLoader });

    t.true(res.success);
    t.is(res.name, 'klara-zwiadowca');
    t.is(res.fromTemplate, 'Zwiadowca v2');

    const yaml = vault.files['.pkm-assistant/sub-agents/klara-zwiadowca/SUB_AGENT.yaml'];
    t.true(yaml.includes('from_template: Zwiadowca v2'));
    t.false(yaml.includes('version:'), 'wersja szablonu nie wchodzi do żywego bytu');
    t.is(subAgentLoader.getSubAgent('klara-zwiadowca').from_template, 'Zwiadowca v2');
});

test('instantiate przy kolizji nazwy tworzy wariant -2 zamiast nadpisać', async t => {
    const vault = makeVault({}, ['.pkm-assistant/sub-agents/klara-zwiadowca']);
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'zbiera', tools: ['search'] });

    const subAgentLoader = new SubAgentLoader(vault);
    const res = await store.instantiate('zwiadowca', 'Klara', { subAgentLoader });

    t.true(res.renamed);
    t.is(res.name, 'klara-zwiadowca-2');
    t.truthy(vault.files['.pkm-assistant/sub-agents/klara-zwiadowca-2/SUB_AGENT.yaml']);
});

test('instantiate bez agenta odmawia (nazwa kopii niesie prefiks agenta)', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'zbiera' });

    const res = await store.instantiate('zwiadowca', '', { subAgentLoader: new SubAgentLoader(vault) });

    t.false(res.success);
    t.is(res.error, 'agent_required');
});

test('delete kasuje szablon, kopia u agenta zostaje', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'zbiera', prompt: 'Metoda.' });
    const subAgentLoader = new SubAgentLoader(vault);
    await store.instantiate('zwiadowca', 'Klara', { subAgentLoader });

    t.true(await store.delete('zwiadowca'));

    t.is(store.count(), 0);
    t.falsy(vault.files[`${BASE}/zwiadowca/SUB_AGENT.yaml`]);
    t.truthy(vault.files['.pkm-assistant/sub-agents/klara-zwiadowca/SUB_AGENT.yaml']);
});

// ─── ta sama dziura w MAGAZYNIE SZABLONÓW ────────────────────
//
// Gdyby `_write` pisał KNOWLEDGE.md tylko pod `if (data.prompt)`, „wersja v3" szablonu
// z wyczyszczoną metodą niosłaby dalej metodę z v2 - i taką kopię dostawałby każdy nowy sub.

test('wyczyszczona metoda znika z szablonu (v2 nie wraca w v3)', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'zbiera', prompt: 'METODA v1' });

    const res = await store.save('zwiadowca', { name: 'Zwiadowca', description: 'zbiera', prompt: '' });

    t.true(res.success);
    t.falsy(vault.files[`${BASE}/zwiadowca/KNOWLEDGE.md`], 'stara metoda nie zostaje na dysku');
    t.is(store.get('zwiadowca').prompt, '');
});

test('szablon z metodą zapisuje się jak dotąd', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'zbiera', prompt: 'METODA v1' });

    await store.save('zwiadowca', { name: 'Zwiadowca', description: 'zbiera', prompt: 'METODA v2' });

    t.is(vault.files[`${BASE}/zwiadowca/KNOWLEDGE.md`], 'METODA v2');
});

// ─── delete — gałąź catch (porażka) ─────────────────────────────────────────
//
// `delete()` ma dwie drogi wyjścia: `return true` po sukcesie (testowana wyżej, „delete kasuje
// szablon...") i `return false` w `catch`. UWAGA: `rmdir` ma WŁASNY, wewnętrzny
// try/catch (`SubAgentTemplateStore.ts:187`, `catch { /* ok */ }`) — rzucający `rmdir` NIE
// dotrze do zewnętrznego `catch`, trzeba użyć `remove`, żeby realnie trafić w tę gałąź.

test('delete — gałąź catch (adapter.remove rzuca) zwraca false, szablon zostaje', async t => {
    const vault = makeVault();
    const store = new SubAgentTemplateStore(vault);
    await store.createFromData({ name: 'Zwiadowca', description: 'zbiera', prompt: 'Metoda.' });

    vault.adapter.remove = async () => { throw new Error('dysk zajęty (sync w toku)'); };

    const ok = await store.delete('zwiadowca');

    t.false(ok);
    t.is(store.count(), 1, 'cache NIE jest czyszczony przy nieudanym kasowaniu');
    t.truthy(vault.files[`${BASE}/zwiadowca/SUB_AGENT.yaml`], 'plik zostaje na dysku po porażce — kafel nie może zniknąć z UI');
});
