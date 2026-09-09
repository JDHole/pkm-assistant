import test from 'ava';
import {
    ensureFactoryTemplates,
    getFactorySkillTemplates,
    getFactorySubAgentTemplates,
    FACTORY_TEMPLATES_MARKER,
} from './factoryTemplates.js';
import { SkillTemplateStore } from '../skills/SkillTemplateStore.js';
import { SkillLoader } from '../skills/SkillLoader.js';
import { SubAgentTemplateStore } from '../sub-agents/SubAgentTemplateStore.js';
import { __test__ as delegateTest } from '../tools/DelegateTool.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
import type { VaultAdapterLike as SkillVaultAdapter } from '../skills/types.js';
import type { SubAgentInput } from '../sub-agents/types.js';

/** Atrapa vaulta na mapie plików + zbiorze folderów (wzór SkillTemplateStore.test.js). */
type FakeVault = { files: Record<string, string>; folders: Set<string>; adapter: SkillVaultAdapter };

function makeVault(files: Record<string, string> = {}, folders: string[] = []): FakeVault {
    const folderSet = new Set(folders);
    return {
        files,
        folders: folderSet,
        adapter: {
            exists: async (path: string) => Object.hasOwn(files, path) || folderSet.has(path),
            read: async (path: string) => files[path],
            write: async (path: string, value: string) => { files[path] = value; },
            remove: async (path: string) => { delete files[path]; },
            mkdir: async (path: string) => { folderSet.add(path); },
            rmdir: async (path: string, _recursive: boolean) => { folderSet.delete(path); },
            list: async (path: string) => ({
                folders: [...folderSet].filter(f => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/')),
                files: Object.keys(files).filter(f => f.startsWith(`${path}/`)),
            }),
        },
    };
}

function makeStores(vault: FakeVault) {
    return {
        skillTemplateStore: new SkillTemplateStore(vault),
        subAgentTemplateStore: new SubAgentTemplateStore(vault),
    };
}

test('seed tworzy 3 fabryczne szablony + marker', async t => {
    const vault = makeVault();
    const stores = makeStores(vault);

    const seeded = await ensureFactoryTemplates({ vault, ...stores });

    t.true(seeded);
    t.truthy(vault.files[FACTORY_TEMPLATES_MARKER]);
    // Sub researcher: YAML + KNOWLEDGE (prompt niepusty z i18n).
    const subYaml = vault.files['.pkm-assistant/templates/sub-agents/researcher/SUB_AGENT.yaml'];
    t.truthy(subYaml);
    t.true(subYaml.includes('max_iterations: 12'));
    t.truthy(vault.files['.pkm-assistant/templates/sub-agents/researcher/KNOWLEDGE.md']);
    // Skille: oba w magazynie, w cache po seedzie (bez re-load).
    t.truthy(vault.files['.pkm-assistant/templates/skills/deep-research-web/SKILL.md']);
    t.truthy(vault.files['.pkm-assistant/templates/skills/deep-research-vault/SKILL.md']);
    t.is(stores.skillTemplateStore.count(), 2);
    t.is(stores.subAgentTemplateStore.count(), 1);
});

test('drugi bieg = no-op (marker istnieje), kasacja usera SZANOWANA', async t => {
    const vault = makeVault();
    const stores = makeStores(vault);
    await ensureFactoryTemplates({ vault, ...stores });

    // User kasuje researcher-a z Zaplecza…
    await stores.subAgentTemplateStore.delete('researcher');
    t.falsy(vault.files['.pkm-assistant/templates/sub-agents/researcher/SUB_AGENT.yaml']);

    // …restart pluginu (drugi seed) — szablon NIE wraca.
    const seededAgain = await ensureFactoryTemplates({ vault, ...stores });
    t.false(seededAgain);
    t.falsy(vault.files['.pkm-assistant/templates/sub-agents/researcher/SUB_AGENT.yaml']);
});

test('userowy szablon pod fabryczną nazwą NIE jest nadpisywany ani sufiksowany', async t => {
    const vault = makeVault();
    const stores = makeStores(vault);
    // User (albo import) ma już własny szablon 'researcher' PRZED pierwszym seedem.
    await stores.subAgentTemplateStore.createFromData({
        name: 'researcher',
        description: 'moja własna wersja',
        prompt: 'user content',
    });

    await ensureFactoryTemplates({ vault, ...stores });

    const yaml = vault.files['.pkm-assistant/templates/sub-agents/researcher/SUB_AGENT.yaml'];
    t.true(yaml.includes('moja własna wersja'));
    // Zero wariantu 'researcher-2' — fabryczny po prostu odpuścił.
    t.falsy(vault.files['.pkm-assistant/templates/sub-agents/researcher-2/SUB_AGENT.yaml']);
    // Skille fabryczne zaseedowały się normalnie.
    t.is(stores.skillTemplateStore.count(), 2);
});

test('odlany researcher trafia w fuzzy match delegate(aspect:"researcher")', async t => {
    const vault = makeVault();
    const stores = makeStores(vault);
    await ensureFactoryTemplates({ vault, ...stores });

    // Odlew dla agenta Klara → kopia `klara-researcher`.
    const saved: SubAgentInput[] = [];
    const subAgentLoader = {
        saveSubAgent: async (cfg: SubAgentInput) => { saved.push(cfg); },
    } as unknown as { saveSubAgent: (data: SubAgentInput) => Promise<string> };
    const res = await stores.subAgentTemplateStore.instantiate('researcher', 'Klara', { subAgentLoader });
    t.true(res.success);
    t.is(saved[0].name, 'klara-researcher');
    t.is(saved[0].max_iterations, 12);
    t.true(saved[0].prompt!.length > 0);

    // Przepis mówi delegate(aspect:"researcher") — fuzzy endsWith('-researcher') trafia.
    const resolved = delegateTest._resolveDelegate('researcher', [{ name: 'klara-researcher' }]);
    t.is(resolved.delegate?.name, 'klara-researcher');
});

test('odlany skill web ma pre-questions z selectem głębokości (round-trip przez SkillLoader)', async t => {
    const vault = makeVault();
    const stores = makeStores(vault);
    await ensureFactoryTemplates({ vault, ...stores });

    const skillLoader = new SkillLoader(vault);
    const res = await stores.skillTemplateStore.instantiate('deep-research-web', { skillLoader });
    t.true(res.success);

    await skillLoader.loadAllSkills();
    const skill = skillLoader.getSkill('deep-research-web');
    t.truthy(skill);
    const loadedSkill = skill as NonNullable<typeof skill> & {
        preQuestions: NonNullable<NonNullable<typeof skill>['preQuestions']>;
    };
    t.is(loadedSkill.preQuestions.length, 2);
    t.is(loadedSkill.preQuestions[0].key, 'temat');
    const glebokosc = loadedSkill.preQuestions[1] as typeof loadedSkill.preQuestions[number] & { options: string[] };
    t.is(glebokosc.key, 'glebokosc');
    t.is(glebokosc.type, 'select');
    t.is(glebokosc.options.length, 2);
    // Przepis odwołuje się do obu placeholderów.
    t.true(loadedSkill.prompt.includes('{{temat}}'));
    t.true(loadedSkill.prompt.includes('{{glebokosc}}'));
});

// max_tool_result_length fabrycznego szablonu NIE wolno hardcodować - musi zgadzać się
// z JEDNYM źródłem prawdy (config/limits.ts), inaczej podbicie kanonu tam nie dotrze do
// nowo seedowanego szablonu researcher-a.
test('definicje fabryczne: max_tool_result_length zgadza się z DEFAULT_LIMITS, nie z lokalnym literałem', t => {
    const subs = getFactorySubAgentTemplates();
    t.is(subs[0].max_tool_result_length, DEFAULT_LIMITS.max_tool_result_length);
});

test('definicje fabryczne: stałe nazwy (kontrakt delegacji) + typ raport w przepisach', t => {
    const subs = getFactorySubAgentTemplates();
    t.deepEqual(subs.map(s => s.name), ['researcher']);
    t.deepEqual(subs[0].tools, ['search', 'list', 'read', 'web_search', 'web_read']);

    const skills = getFactorySkillTemplates();
    t.deepEqual(skills.map(s => s.name), ['deep-research-web', 'deep-research-vault']);
    for (const skill of skills) {
        // Oba przepisy tworzą artefakt typu raport i delegują do researcher-a.
        t.true(skill.prompt.includes('typ: "raport"'));
        t.true(skill.prompt.includes('aspect: "researcher"'));
        t.true(skill.prompt.includes('timeout_ms: 300000'));
    }
});
