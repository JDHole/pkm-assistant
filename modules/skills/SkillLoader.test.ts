import test from 'ava';
import { SkillLoader as RuntimeSkillLoader } from './SkillLoader.js';

type TestSkill = Record<string, unknown> & {
    name: string;
    prompt: string;
    preQuestions: Array<Record<string, unknown>>;
};
type TestSkillLoader = {
    _loadSkillFromFolder(path: string): Promise<TestSkill | null>;
    ensureStarterSkills(): Promise<void>;
    saveSkill(input: unknown): Promise<void>;
    getSkill(name: string): TestSkill | null;
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

test('A4 migrates only factory create-agent v2, keeps backup and installs primitive v3 recipe', async t => {
    const path = '.pkm-assistant/skills/create-agent/SKILL.md';
    const backup = '.pkm-assistant/skills/create-agent/SKILL.v2-backup.md';
    const files: Record<string, string> = {
        [path]: [
            '---',
            'name: create-agent',
            'version: 2',
            '---',
            'Archetyp',
            'vault_write(".pkm-assistant/agents/{nazwa}/agent.yaml", "---',
            'minion: null',
        ].join('\n'),
    };
    const folders = new Set<string>(['.pkm-assistant/skills', '.pkm-assistant/skills/create-agent']);
    const vault = {
        adapter: {
            exists: async (p: string) => Object.hasOwn(files, p) || folders.has(p),
            read: async (p: string) => files[p],
            write: async (p: string, value: string) => { files[p] = value; },
            list: async () => ({ folders: [...folders], files: Object.keys(files) }),
        }
    };

    const loader = new SkillLoader(vault as unknown as ConstructorParameters<typeof SkillLoader>[0]);
    await loader.ensureStarterSkills();

    t.truthy(files[backup]);
    t.true(files[path].includes('version: 3'));
    t.true(files[path].includes('create_folder'));
    t.true(files[path].includes('mode: "create"'));
    t.true(files[path].includes('access_policy_version: 2'));
    t.true(files[path].includes('disabled_tools:'));
    t.true(files[path].includes('- web_search'));
    t.false(files[path].includes('agent_create('));
    t.false(files[path].includes('allowed-tools:'));
    t.false(files[path].includes('vault_write'));
});

test('S27 D6: stary skill z allowed-tools wczytuje się, pole jest ignorowane (zero migracji)', async t => {
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

test('S27 D6: saveSkill nie zapisuje allowed-tools nawet gdy wołający je poda', async t => {
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

test('S27 D6: startery nie niosą już pola allowed-tools', async t => {
    const files: Record<string, string> = {};
    const folders = new Set<string>();
    const loader = new SkillLoader({
        adapter: {
            exists: async (p: string) => Object.hasOwn(files, p) || folders.has(p),
            read: async (p: string) => files[p],
            write: async (p: string, v: string) => { files[p] = v; },
            mkdir: async (p: string) => { folders.add(p); },
            list: async () => ({ folders: [], files: [] }),
        },
    });

    await loader.ensureStarterSkills();

    const starters = Object.entries(files).filter(([p]) => p.endsWith('SKILL.md'));
    t.is(starters.length, 8);
    for (const [path, content] of starters) {
        t.false(content.includes('allowed-tools'), `${path} bez pola-fasady`);
    }
});

test('A4 does not overwrite a user-customized create-agent skill', async t => {
    const path = '.pkm-assistant/skills/create-agent/SKILL.md';
    const custom = '---\nname: create-agent\nversion: 2\n---\nMój własny przepis.';
    const files: Record<string, string> = { [path]: custom };
    const vault = {
        adapter: {
            exists: async (p: string) => Object.hasOwn(files, p) || p === '.pkm-assistant/skills',
            read: async (p: string) => files[p],
            write: async (p: string, value: string) => { files[p] = value; },
            list: async () => ({ folders: ['.pkm-assistant/skills/create-agent'], files: [path] }),
        }
    };

    await new SkillLoader(vault).ensureStarterSkills();
    t.is(files[path], custom);
});


// ── E3.5 regression guard: S27 Z1 zgubił preQuestions z returna parseSkillMarkdown ──
// (każdy load z dysku tracił pre-questions → modal pytań przed skillem był martwy).
test('load z dysku zachowuje pre-questions (regresja S27→E3.5)', async t => {
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


// ── smoke-04 finding 01 (przepisany fix z zaginionego commita 3804947) ──
// Cache jest kluczowany slugiem, ale UI kasuje po nazwie wyświetlanej;
// folder musi znikać rekurencyjnie (references/, examples/).

test('smoke-04: deleteSkill kasuje skill po nazwie wyświetlanej ≠ slug', async t => {
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

test('smoke-04: deleteSkill kasuje rekurencyjnie folder z references/ i examples/', async t => {
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

test('AUD-code-review-049: saveSkill w edycji pisze do folderu z cache (slug), nie do slugify(nowej nazwy)', async t => {
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

    // SkillEditorModal (po naprawie) przekazuje `slug` z `existing.slug` — identyczny
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

test('AUD-code-review-049: saveSkill bez slug (nowy skill) zakłada folder ze slugify(name), jak dotąd', async t => {
    const vault = makeVault({}, ['.pkm-assistant/skills']);
    const loader = new SkillLoader(vault);

    await loader.saveSkill({ name: 'Zupełnie Nowy', description: 'opis', prompt: 'body' });

    t.true(await vault.adapter.exists('.pkm-assistant/skills/zupelnie-nowy/SKILL.md'));
    t.truthy(loader.getSkill('zupelnie-nowy'));
});
