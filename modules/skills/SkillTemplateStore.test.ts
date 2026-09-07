import test from 'ava';
import { SkillTemplateStore as RuntimeSkillTemplateStore } from './SkillTemplateStore.js';
import { SkillLoader as RuntimeSkillLoader } from './SkillLoader.js';

type TestTemplate = Record<string, unknown> & { version: number; isTemplate: boolean };
type TestStore = {
    createFromData(data: unknown): Promise<Record<string, unknown>>;
    save(slug: string, data: unknown): Promise<Record<string, unknown>>;
    loadAll(): Promise<void>;
    count(): number;
    get(slug: string): TestTemplate;
    instantiate(slug: string, options: unknown): Promise<Record<string, unknown>>;
    delete(slug: string): Promise<boolean>;
};
const SkillTemplateStore = RuntimeSkillTemplateStore as unknown as new (vault: unknown) => TestStore;
const SkillLoader = RuntimeSkillLoader as unknown as new (vault: unknown) => { _loadSkillFromFolder(path: string): Promise<{ fromTemplate: string | null }> };

/** Atrapa vaulta na mapie plików + zbiorze folderów (jak w SkillLoader.test.js). */
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
            rmdir: async (path: string) => { folderSet.delete(path); },
            list: async (path: string) => ({
                folders: [...folderSet].filter(f => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/')),
                files: Object.keys(files).filter(f => f.startsWith(`${path}/`)),
            }),
        },
    };
}

const BASE = '.pkm-assistant/templates/skills';

test('createFromData zapisuje szablon w version 1 i wchodzi do cache', async t => {
    const vault = makeVault();
    const store = new SkillTemplateStore(vault);

    const res = await store.createFromData({
        name: 'Przegląd tygodnia',
        description: 'Podsumowanie tygodnia',
        category: 'productivity',
        prompt: 'Zrób przegląd {{okres}}.',
    });

    t.true(res.success);
    t.is(res.slug, 'przeglad-tygodnia');
    t.false(res.renamed);

    const raw = vault.files[`${BASE}/przeglad-tygodnia/SKILL.md`];
    t.truthy(raw);
    t.true(raw.includes('version: 1'));
    t.true(raw.includes('Zrób przegląd {{okres}}.'));
    t.is(store.count(), 1);
    t.is(store.get('przeglad-tygodnia').version, 1);
});

test('createFromData przy kolizji slugu dokleja sufiks i raportuje renamed', async t => {
    const vault = makeVault({}, [`${BASE}/plan`]);
    const store = new SkillTemplateStore(vault);

    const res = await store.createFromData({ name: 'Plan', description: 'x', prompt: 'y' });

    t.true(res.success);
    t.is(res.slug, 'plan-2');
    t.is(res.name, 'Plan 2');
    t.true(res.renamed);
});

test('save podbija wersję szablonu i zachowuje jego slug', async t => {
    const vault = makeVault();
    const store = new SkillTemplateStore(vault);
    await store.createFromData({ name: 'Plan', description: 'x', prompt: 'stara treść' });

    const res = await store.save('plan', { name: 'Plan', description: 'x2', prompt: 'nowa treść' });

    t.true(res.success);
    t.is(res.slug, 'plan');
    t.is(res.version, 2);
    t.true(vault.files[`${BASE}/plan/SKILL.md`].includes('version: 2'));
    t.true(vault.files[`${BASE}/plan/SKILL.md`].includes('nowa treść'));
    t.is(store.get('plan').version, 2);
});

test('loadAll czyta szablony z dysku i pomija plik bez name/description', async t => {
    const vault = makeVault({
        [`${BASE}/dobry/SKILL.md`]: '---\nname: Dobry\ndescription: ok\nversion: 3\n---\n\nTreść.',
        [`${BASE}/zly/SKILL.md`]: '---\nname: Zly\n---\n\nBrak opisu.',
    }, [BASE, `${BASE}/dobry`, `${BASE}/zly`]);
    const store = new SkillTemplateStore(vault);

    await store.loadAll();

    t.is(store.count(), 1);
    t.is(store.get('dobry').version, 3);
    t.true(store.get('dobry').isTemplate);
});

test('instantiate robi KOPIĘ w żywych skillach ze śladem from_template i wersją 1', async t => {
    const vault = makeVault();
    const store = new SkillTemplateStore(vault);
    await store.createFromData({
        name: 'Plan', description: 'opis planu', category: 'productivity', prompt: 'Zrób plan.',
    });
    await store.save('plan', { name: 'Plan', description: 'opis planu v2', prompt: 'Zrób plan v2.' });

    const skillLoader = new SkillLoader(vault);
    const res = await store.instantiate('plan', { skillLoader });

    t.true(res.success);
    t.is(res.name, 'Plan');
    t.is(res.fromTemplate, 'Plan v2');
    t.false(res.renamed);

    const copy = vault.files['.pkm-assistant/skills/plan/SKILL.md'];
    t.true(copy.includes('from_template: Plan v2'));
    t.true(copy.includes('version: 1'), 'wersja szablonu nie nadpisuje wersji żywego bytu');
    t.true(copy.includes('Zrób plan v2.'));
});

test('instantiate przy kolizji z istniejącym żywym skillem tworzy wariant -2', async t => {
    const vault = makeVault({}, ['.pkm-assistant/skills/plan']);
    const store = new SkillTemplateStore(vault);
    await store.createFromData({ name: 'Plan', description: 'opis', prompt: 'body' });

    const skillLoader = new SkillLoader(vault);
    const res = await store.instantiate('plan', { skillLoader });

    t.true(res.success);
    t.true(res.renamed);
    t.is(res.slug, 'plan-2');
    t.truthy(vault.files['.pkm-assistant/skills/plan-2/SKILL.md']);
});

test('ślad from_template przeżywa round-trip przez SkillLoader', async t => {
    const vault = makeVault();
    const store = new SkillTemplateStore(vault);
    await store.createFromData({ name: 'Plan', description: 'opis', prompt: 'body' });
    const skillLoader = new SkillLoader(vault);
    await store.instantiate('plan', { skillLoader });

    const loaded = await skillLoader._loadSkillFromFolder('.pkm-assistant/skills/plan');

    t.is(loaded.fromTemplate, 'Plan v1');
});

test('delete kasuje szablon, kopie zostają nietknięte', async t => {
    const vault = makeVault();
    const store = new SkillTemplateStore(vault);
    await store.createFromData({ name: 'Plan', description: 'opis', prompt: 'body' });
    const skillLoader = new SkillLoader(vault);
    await store.instantiate('plan', { skillLoader });

    t.true(await store.delete('plan'));

    t.is(store.count(), 0);
    t.falsy(vault.files[`${BASE}/plan/SKILL.md`]);
    t.truthy(vault.files['.pkm-assistant/skills/plan/SKILL.md'], 'kopia (D3) przeżywa kasację szablonu');
});
