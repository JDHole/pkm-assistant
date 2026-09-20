import test from 'ava';
import { SkillLoader as RuntimeSkillLoader } from './SkillLoader.js';

type TestSkill = Record<string, unknown> & {
    name: string;
    prompt: string;
    preQuestions: Array<Record<string, unknown>>;
};
type TestSkillLoader = {
    _loadSkillFromFolder(path: string): Promise<TestSkill | null>;
    saveSkill(input: unknown): Promise<void>;
    getSkill(name: string): TestSkill | null;
    getAllSkills(): TestSkill[];
    loadAllSkills(): Promise<void>;
    deleteSkill(name: string): Promise<boolean>;
};
const SkillLoader = RuntimeSkillLoader as unknown as new (vault: unknown) => TestSkillLoader;

function makeVault(files: Record<string, string> = {}, folders: string[] = []) {
    const folderSet = new Set<string>(folders);
    const operations: { rmdir: { path: string; recursive: boolean }[] } = { rmdir: [] };
    return {
        _operations: operations,
        adapter: {
            exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path) || folderSet.has(path),
            read: async (path: string) => files[path],
            list: async (path: string) => ({
                folders: Array.from(folderSet).filter(folder => folder.startsWith(`${path}/`)),
                files: Object.keys(files).filter(file => file.startsWith(`${path}/`)),
            }),
            write: async (path: string, value: string) => { files[path] = value; },
            mkdir: async (path: string) => { folderSet.add(path); },
            remove: async (path: string) => { delete files[path]; },
            rmdir: async (path: string, recursive = false) => {
                operations.rmdir.push({ path, recursive });
                if (!folderSet.has(path)) throw new Error(`Folder not found: ${path}`);
                const hasChildren = Object.keys(files).some(f => f.startsWith(`${path}/`))
                    || Array.from(folderSet).some(f => f !== path && f.startsWith(`${path}/`));
                if (!recursive && hasChildren) throw new Error(`Folder not empty: ${path}`);
                for (const filePath of Object.keys(files)) {
                    if (filePath.startsWith(`${path}/`)) delete files[filePath];
                }
                for (const folderPath of Array.from(folderSet)) {
                    if (folderPath === path || folderPath.startsWith(`${path}/`)) folderSet.delete(folderPath);
                }
            },
        }
    };
}

test('loadSkillFromFolder detects supporting files before returning', async t => {
    const loader = new SkillLoader(makeVault({
        '.pkm-assistant/skills/demo/SKILL.md': [
            '---',
            'name: Demo',
            'description: Demo skill',
            '---',
            '',
            'Do {{thing}}.'
        ].join('\n'),
        '.pkm-assistant/skills/demo/template.md': 'Template',
    }, [
        '.pkm-assistant/skills/demo/references',
        '.pkm-assistant/skills/demo/examples',
    ]));

    const skill = await loader._loadSkillFromFolder('.pkm-assistant/skills/demo');

    t.true(Boolean(skill?.hasTemplate));
    t.true(Boolean(skill?.hasReferences));
    t.true(Boolean(skill?.hasExamples));
});

test('stary skill z allowed-tools wczytuje się, pole jest ignorowane (zero migracji)', async t => {
    const loader = new SkillLoader(makeVault({
        '.pkm-assistant/skills/stary/SKILL.md': [
            '---',
            'name: Stary',
            'description: skill sprzed S27',
            'allowed-tools: [vault_read, connect_to_server, memory_list_summaries]',
            '---',
            '',
            'Treść przepisu.',
        ].join('\n'),
    }));

    const skill = (await loader._loadSkillFromFolder('.pkm-assistant/skills/stary')) as TestSkill;

    t.is(skill.name, 'Stary');
    t.is(skill.prompt, 'Treść przepisu.');
    t.false('allowedTools' in skill, 'pole-fasada nie wchodzi już do modelu skilla');
});

test('saveSkill nie zapisuje allowed-tools nawet gdy wołający je poda', async t => {
    const files: Record<string, string> = {};
    const folders = new Set<string>();
    const loader = new SkillLoader({
        adapter: {
            exists: async (p: string) => Object.hasOwn(files, p) || folders.has(p),
            read: async (p: string) => files[p],
            write: async (p: string, v: string) => { files[p] = v; },
            mkdir: async (p: string) => { folders.add(p); },
            remove: async (p: string) => { delete files[p]; },
        },
    });

    await loader.saveSkill({
        name: 'Nowy', description: 'opis', prompt: 'body',
        allowedTools: ['read', 'write'],
    });

    const raw = files['.pkm-assistant/skills/nowy/SKILL.md'];
    t.false(raw!.includes('allowed-tools'));
    t.falsy(loader.getSkill('nowy')?.allowedTools);
});

// ── regression guard: `preQuestions` musi przetrwać return z `parseSkillMarkdown` ──
// (inaczej każdy load z dysku traciłby pre-questions → modal pytań przed skillem byłby martwy).
test('load z dysku zachowuje pre-questions', async t => {
    const raw = `---
name: pytajacy
description: "skill z pytaniami"
pre-questions:
  - key: dzien
    question: "Który dzień?"
    default: "dzisiaj"
  - key: glebokosc
    question: "Jak głęboko?"
    type: select
    options:
      - "szybko"
      - "głęboko"
    default: "szybko"
---

Body {{dzien}} / {{glebokosc}}`;
    const vault = makeVault(
        { '.pkm-assistant/skills/pytajacy/SKILL.md': raw },
        ['.pkm-assistant/skills', '.pkm-assistant/skills/pytajacy'],
    );
    const loader = new SkillLoader(vault);
    await loader.loadAllSkills();

    const skill = loader.getSkill('pytajacy') as TestSkill;
    t.truthy(skill);
    t.is(skill.preQuestions?.length, 2);
    t.is(skill.preQuestions[0].key, 'dzien');
    t.is(skill.preQuestions[0].default, 'dzisiaj');
    t.is(skill.preQuestions[1].type, 'select');
    t.deepEqual(skill.preQuestions[1].options, ['szybko', 'głęboko']);
});


// ── deleteSkill: nazwa wyświetlana ≠ slug ──
// Cache jest kluczowany slugiem, ale UI kasuje po nazwie wyświetlanej;
// folder musi znikać rekurencyjnie (references/, examples/).

test('deleteSkill kasuje skill po nazwie wyświetlanej ≠ slug', async t => {
    const vault = makeVault({
        '.pkm-assistant/skills/moj-skill/SKILL.md': [
            '---', 'name: Mój Skill', 'description: opis', '---', '', 'Body',
        ].join('\n'),
    }, ['.pkm-assistant/skills', '.pkm-assistant/skills/moj-skill']);
    const loader = new SkillLoader(vault);
    await loader.loadAllSkills();
    t.truthy(loader.getSkill('Mój Skill'), 'sanity: skill wczytany');

    const deleted = await loader.deleteSkill('Mój Skill');

    t.true(deleted);
    t.falsy(loader.getSkill('Mój Skill'));
    t.falsy(loader.getSkill('moj-skill'));
    t.false(await vault.adapter.exists('.pkm-assistant/skills/moj-skill'));
});

test('deleteSkill kasuje rekurencyjnie folder z references/ i examples/', async t => {
    const vault = makeVault({
        '.pkm-assistant/skills/z-dodatkami/SKILL.md': [
            '---', 'name: z-dodatkami', 'description: opis', '---', '', 'Body',
        ].join('\n'),
        '.pkm-assistant/skills/z-dodatkami/references/link.md': 'ref',
    }, [
        '.pkm-assistant/skills',
        '.pkm-assistant/skills/z-dodatkami',
        '.pkm-assistant/skills/z-dodatkami/references',
        '.pkm-assistant/skills/z-dodatkami/examples',
    ]);
    const loader = new SkillLoader(vault);
    await loader.loadAllSkills();

    const deleted = await loader.deleteSkill('z-dodatkami');

    t.true(deleted);
    t.deepEqual(vault._operations.rmdir, [
        { path: '.pkm-assistant/skills/z-dodatkami', recursive: true },
    ], 'jedno kasowanie, rekurencyjne');
    t.false(await vault.adapter.exists('.pkm-assistant/skills/z-dodatkami'));
    t.false(await vault.adapter.exists('.pkm-assistant/skills/z-dodatkami/references'));
});

test('deleteSkill zwraca false dla nieznanego skilla i pustej nazwy', async t => {
    const loader = new SkillLoader(makeVault({}, ['.pkm-assistant/skills']));
    await loader.loadAllSkills();

    t.false(await loader.deleteSkill('nie-ma-takiego'));
    t.false(await loader.deleteSkill(''));
    t.false(await loader.deleteSkill(null as unknown as string));
});

test('deleteSkill działa zaraz po saveSkill (wpis cache z zapisu, nie z dysku)', async t => {
    const vault = makeVault({}, ['.pkm-assistant/skills']);
    const loader = new SkillLoader(vault);

    await loader.saveSkill({ name: 'Świeży Skill', description: 'opis', prompt: 'body' });
    t.true(await vault.adapter.exists('.pkm-assistant/skills/swiezy-skill/SKILL.md'), 'sanity: zapisany');

    const deleted = await loader.deleteSkill('Świeży Skill');

    t.true(deleted);
    t.falsy(loader.getSkill('Świeży Skill'));
    t.false(await vault.adapter.exists('.pkm-assistant/skills/swiezy-skill'));
});

test('saveSkill w edycji pisze do folderu z cache (slug), nie do slugify(nowej nazwy)', async t => {
    // Skill, którego `name:` we frontmatterze user zmienił ręcznie w vaulcie BEZ zmiany
    // nazwy folderu — dokładnie sytuacja, którą deleteSkill nazywa "legacy/renamed skills".
    // _loadSkillFromFolder bierze slug ZAWSZE z folderu, więc po wczytaniu:
    //   cache.slug === 'stara-nazwa' (folder), cache.name === 'Nowa Nazwa' (frontmatter).
    const vault = makeVault({
        '.pkm-assistant/skills/stara-nazwa/SKILL.md': [
            '---', 'name: Nowa Nazwa', 'description: opis', '---', '', 'Body',
        ].join('\n'),
    }, ['.pkm-assistant/skills', '.pkm-assistant/skills/stara-nazwa']);
    const loader = new SkillLoader(vault);
    await loader.loadAllSkills();

    const loaded = loader.getSkill('stara-nazwa');
    t.is(loaded?.name, 'Nowa Nazwa', 'sanity: frontmatter i folder się rozjechały');

    // SkillEditorModal przekazuje `slug` z `existing.slug` — identyczny
    // przewód jak deleteSkill.
    await loader.saveSkill({
        slug: 'stara-nazwa',
        name: 'Nowa Nazwa',
        description: 'zmieniony opis',
        prompt: 'zmienione body',
    });

    // Zapis MUSI trafić do ISTNIEJĄCEGO folderu, nie założyć drugiego pod slugify('Nowa Nazwa').
    t.false(await vault.adapter.exists('.pkm-assistant/skills/nowa-nazwa'),
        'edycja nie ma prawa założyć DRUGIEGO folderu pod nowym slugiem');
    t.true(await vault.adapter.exists('.pkm-assistant/skills/stara-nazwa/SKILL.md'),
        'oryginalny folder zostaje i niesie edycję');

    const updated = loader.getSkill('stara-nazwa');
    t.is(updated?.prompt, 'zmienione body', 'cache musi odzwierciedlać nowy zapis, nie stary');

    // Kasowanie po edycji nadal działa jedną, spójną tożsamością (slug z folderu).
    t.true(await loader.deleteSkill('stara-nazwa'));
    t.false(await vault.adapter.exists('.pkm-assistant/skills/stara-nazwa'));
});

test('saveSkill bez slug (nowy skill) zakłada folder ze slugify(name), jak dotąd', async t => {
    const vault = makeVault({}, ['.pkm-assistant/skills']);
    const loader = new SkillLoader(vault);

    await loader.saveSkill({ name: 'Zupełnie Nowy', description: 'opis', prompt: 'body' });

    t.true(await vault.adapter.exists('.pkm-assistant/skills/zupelnie-nowy/SKILL.md'));
    t.truthy(loader.getSkill('zupelnie-nowy'));
});

// ── boot nie sieje (decyzja 2026-09: zero fabrycznych skilli) ──
// loadAllSkills() jest jedyną drogą wołaną przy starcie pluginu (AgentManager.initialize).
// Brak folderu `.pkm-assistant/skills/` ma skończyć się cicho: pusta lista, zero wyjątków,
// zero zapisów na dysk — plugin nie ma prawa niczego zasiać sam z siebie.
test('loadAllSkills bez folderu .pkm-assistant/skills/ nie rzuca, lista pusta, zero zapisów', async t => {
    let writes = 0;
    let mkdirs = 0;
    const loader = new SkillLoader({
        adapter: {
            exists: async () => false,
            list: async () => ({ folders: [], files: [] }),
            read: async () => { throw new Error('read nie powinien być wołany, gdy folderu nie ma'); },
            write: async () => { writes++; },
            mkdir: async () => { mkdirs++; },
        },
    });

    await t.notThrowsAsync(() => loader.loadAllSkills());

    t.deepEqual(loader.getAllSkills(), []);
    t.is(writes, 0, 'boot nie pisze — zero adapter.write()');
    t.is(mkdirs, 0, 'boot nie pisze — zero adapter.mkdir()');
});

test('loadAllSkills z JEDNYM skillem usera: lista ma dokładnie ten skill, plik nietknięty, zero zapisów', async t => {
    let writes = 0;
    let mkdirs = 0;
    const original = [
        '---',
        'name: Mój Przepis',
        'description: prywatny skill usera',
        '---',
        '',
        'Treść, której plugin nie ma prawa ruszyć.',
    ].join('\n');
    const files: Record<string, string> = {
        '.pkm-assistant/skills/moj-przepis/SKILL.md': original,
    };
    const folders = new Set<string>(['.pkm-assistant/skills', '.pkm-assistant/skills/moj-przepis']);
    const loader = new SkillLoader({
        adapter: {
            exists: async (p: string) => Object.hasOwn(files, p) || folders.has(p),
            read: async (p: string) => files[p],
            list: async (p: string) => ({
                folders: Array.from(folders).filter(f => f.startsWith(`${p}/`)),
                files: Object.keys(files).filter(f => f.startsWith(`${p}/`)),
            }),
            write: async (p: string, v: string) => { writes++; files[p] = v; },
            mkdir: async () => { mkdirs++; },
        },
    });

    await loader.loadAllSkills();

    const all = loader.getAllSkills();
    t.is(all.length, 1);
    t.is(all[0].name, 'Mój Przepis');
    t.is(files['.pkm-assistant/skills/moj-przepis/SKILL.md'], original, 'plik usera bajtowo bez zmian');
    t.is(writes, 0, 'load nigdy nie pisze');
    t.is(mkdirs, 0, 'load nigdy nie tworzy folderów');
});
