import test from 'ava';
import { AgentMemory } from '../memory/AgentMemory.js';
import { createMemorySaveTool } from './MemorySaveTool.js';
import { createMemoryDeleteTool } from './MemoryDeleteTool.js';
// ⚠️ `t` to obiekt asercji AVA — i18n importujemy bez niego (tu potrzebny tylko przełącznik locale).
import { setLocale, getLocale } from '../../core/i18n/index.js';
import type { MemorySavePlugin } from './MemorySaveTool.js';
import type { MemoryDeletePlugin } from './MemoryDeleteTool.js';

/** Wynik narzedzia pamieci czytany w asercjach — pola typowane POD UZYCIE w tym pliku. */
type MemRes = {
    success?: boolean;
    code?: string;
    path?: string;
    filename?: string;
    ephemeral?: boolean;
    section?: string;
    error?: string;
    /** AUD-bledy-029: zmiana zatwierdzona, ale indeks brain.md nie odświeżony. */
    index_stale?: boolean;
    warning?: string;
};
// NOTE (E2.6): memory_read został wchłonięty przez narzędzie `read` (scope=memory).
// Testy odczytu pamięci żyją teraz w ReadTool.test.js.

function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set(initialFolders);

    const parentFoldersFor = (path: string) => {
        const parts = path.split('/');
        const result: string[] = [];
        for (let i = 1; i < parts.length; i++) {
            result.push(parts.slice(0, i).join('/'));
        }
        return result;
    };

    for (const path of Object.keys(files)) {
        for (const folder of parentFoldersFor(path)) folders.add(folder);
    }

    return {
        files,
        folders,
        vault: {
            adapter: {
                async exists(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) {
                    folders.add(path);
                },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    for (const folder of parentFoldersFor(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) {
                    delete files[path];
                },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(path => path.startsWith(prefix)),
                        folders: [...folders].filter(path => path.startsWith(prefix) && path !== folder),
                    };
                },
                async stat(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) ? { mtime: 1 } : null;
                },
            },
        },
    };
}

function brain(agent: string = 'Jaskier') {
    return `# Brain: ${agent}

## User

## Preferencje

## Ustalenia

## Bieżące
`;
}

function makePlugin(
    agentMemory: AgentMemory,
    activeName: string = agentMemory.agentName,
    memories: Record<string, AgentMemory> = {},
): MemorySavePlugin & MemoryDeletePlugin {
    return {
        agentManager: {
            getActiveMemory: () => agentMemory,
            getActiveAgent: () => ({ name: activeName }),
            getAgentMemory: (name: string) => memories[name] || (name === agentMemory.agentName ? agentMemory : null),
        },
    } as unknown as MemorySavePlugin & MemoryDeletePlugin;
}

function noteArgs(overrides: Record<string, unknown> = {}) {
    return {
        name: 'Kuba direct feedback',
        description: 'Kuba wants direct, concrete feedback',
        type: 'user',
        content: 'Kuba prefers direct feedback without cheerleading.',
        why: 'Past sessions showed cheerleading mode is noisy.',
        how_to_apply: 'Be warm, but concrete and honest.',
        ...overrides,
    };
}

test('memory_save creates a new brain note and refreshes brain.md index', async t => {
    const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const { vault, files } = makeVault({ [brainPath]: brain() });
    const memory = new AgentMemory(vault, 'Jaskier');

    const result = await createMemorySaveTool().execute(noteArgs(), null, makePlugin(memory)) as MemRes;

    const notePath = '.pkm-assistant/agents/jaskier/memory/brain/user_kuba_direct_feedback.md';
    t.true(result.success);
    t.is(result.path, notePath);
    t.true(Object.prototype.hasOwnProperty.call(files, notePath));
    t.true(files[brainPath].includes('## User'));
    t.true(files[brainPath].includes('[[brain/user_kuba_direct_feedback.md]]'));
    t.true(files[brainPath].includes('Kuba wants direct, concrete feedback'));
});

test('memory_save refuses to overwrite an existing brain note', async t => {
    const notePath = '.pkm-assistant/agents/jaskier/memory/brain/user_kuba_direct_feedback.md';
    const { vault, files } = makeVault({
        '.pkm-assistant/agents/jaskier/memory/brain.md': brain(),
        [notePath]: 'existing',
    });
    const memory = new AgentMemory(vault, 'Jaskier');

    const result = await createMemorySaveTool().execute(noteArgs(), null, makePlugin(memory)) as MemRes;

    t.false(result.success);
    t.is(result.code, 'note_already_exists');
    t.is(files[notePath], 'existing');
});

test('memory_save rejects invalid note type before writing a brain note', async t => {
    const { vault, files } = makeVault({
        '.pkm-assistant/agents/jaskier/memory/brain.md': brain(),
    });
    const memory = new AgentMemory(vault, 'Jaskier');

    const result = await createMemorySaveTool().execute(
        noteArgs({ type: 'other_memory' }),
        null,
        makePlugin(memory)
    ) as MemRes;

    t.false(result.success);
    t.is(result.code, 'validation_error');
    t.false(Object.keys(files).some(path => path.includes('/memory/brain/other_memory')));
});

test('memory_save writes only to current agent brain folder', async t => {
    const { vault, files } = makeVault({
        '.pkm-assistant/agents/tola/memory/brain.md': brain('Tola'),
        '.pkm-assistant/agents/jaskier/memory/brain.md': brain('Jaskier'),
    });
    const memory = new AgentMemory(vault, 'Tola');

    const result = await createMemorySaveTool().execute(noteArgs({ name: 'Tola voice' }), null, makePlugin(memory, 'Tola')) as MemRes;

    t.true(result.success);
    t.true(Object.prototype.hasOwnProperty.call(files, '.pkm-assistant/agents/tola/memory/brain/user_tola_voice.md'));
    t.false(Object.prototype.hasOwnProperty.call(files, '.pkm-assistant/agents/jaskier/memory/brain/user_tola_voice.md'));
});

test('memory_save uses invocation agent memory when active agent changes', async t => {
    const { vault, files } = makeVault({
        '.pkm-assistant/agents/tola/memory/brain.md': brain('Tola'),
        '.pkm-assistant/agents/jaskier/memory/brain.md': brain('Jaskier'),
    });
    const activeMemory = new AgentMemory(vault, 'Tola');
    const invocationMemory = new AgentMemory(vault, 'Jaskier');

    const result = await createMemorySaveTool().execute(
        { ...noteArgs({ name: 'Snapshot owner' }), _invocationAgentName: 'Jaskier' },
        null,
        makePlugin(activeMemory, 'Tola', { Jaskier: invocationMemory, Tola: activeMemory })
    ) as MemRes;

    t.true(result.success);
    t.true(Object.prototype.hasOwnProperty.call(files, '.pkm-assistant/agents/jaskier/memory/brain/user_snapshot_owner.md'));
    t.false(Object.prototype.hasOwnProperty.call(files, '.pkm-assistant/agents/tola/memory/brain/user_snapshot_owner.md'));
});

test('memory_delete removes one matching brain note and refreshes brain.md index', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const notePath = `${base}/brain/user_kuba_direct.md`;
    const { vault, files } = makeVault({
        [`${base}/brain.md`]: brain(),
        [notePath]: `---
name: Kuba direct
description: direct feedback preference
type: user
created: 2026-05-24
---
Kuba prefers direct feedback.
`,
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    await memory.rebuildBrainIndex();
    t.true(files[`${base}/brain.md`].includes('user_kuba_direct.md'));

    const result = await createMemoryDeleteTool().execute(
        { fact: 'direct feedback preference' },
        null,
        makePlugin(memory)
    ) as MemRes;

    t.true(result.success, JSON.stringify(result));
    t.is(result.filename, 'user_kuba_direct.md');
    t.false(Object.prototype.hasOwnProperty.call(files, notePath));
    t.false(files[`${base}/brain.md`].includes('user_kuba_direct.md'));
});

test('memory_delete matches note identity only, not the full body (E1.1 ryzyko B)', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const notePath = `${base}/brain/user_kuba.md`;
    const { vault, files } = makeVault({
        [`${base}/brain.md`]: brain(),
        [notePath]: `---
name: Kuba
description: podstawowe fakty o userze
type: user
created: 2026-05-24
---
Kuba mieszka w Warszawie i pracuje nad pluginem.
`,
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    await memory.rebuildBrainIndex();

    // The phrase only appears inside the note body — identity-only matching must NOT delete it.
    const result = await createMemoryDeleteTool().execute(
        { fact: 'mieszka w Warszawie' },
        null,
        makePlugin(memory)
    ) as MemRes;

    t.false(result.success);
    t.is(result.code, 'note_not_found');
    t.true(Object.prototype.hasOwnProperty.call(files, notePath));
});

test('memory_delete refuses ambiguous matches instead of deleting multiple notes', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain.md`]: brain(),
        [`${base}/brain/user_first.md`]: `---
name: First
description: duplicate topic
type: user
created: 2026-05-24
---
One duplicate topic.
`,
        [`${base}/brain/user_second.md`]: `---
name: Second
description: duplicate topic
type: user
created: 2026-05-24
---
Another duplicate topic.
`,
    });
    const memory = new AgentMemory(vault, 'Jaskier');

    const result = await createMemoryDeleteTool().execute(
        { fact: 'duplicate topic' },
        null,
        makePlugin(memory)
    ) as MemRes;

    t.false(result.success);
    t.is(result.code, 'ambiguous_match');
    t.true(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_first.md`));
    t.true(Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_second.md`));
});

test('memory_delete refuses project_context notes so completed projects go through archive review', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const notePath = `${base}/brain/project_done.md`;
    const { vault, files } = makeVault({
        [`${base}/brain.md`]: brain(),
        [notePath]: `---
name: Done
description: completed project
type: project_context
created: 2026-05-24
---
Projekt jest zakończony.
`,
    });
    const memory = new AgentMemory(vault, 'Jaskier');

    const result = await createMemoryDeleteTool().execute(
        { fact: 'completed project' },
        null,
        makePlugin(memory)
    ) as MemRes;

    t.false(result.success);
    t.is(result.code, 'project_archive_required');
    t.true(Object.prototype.hasOwnProperty.call(files, notePath));
});

// ─── E2.7 K1: parallel memory_save through the per-path write queue ───

test('E2.7 K1: two parallel memory_save (different names) both land + index lists both', async t => {
    const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const { vault, files } = makeVault({ [brainPath]: brain() });
    // Widen the read→write window so a missing lock would drop one note from the index.
    const origWrite = vault.adapter.write;
    vault.adapter.write = async (p, c) => {
        await new Promise(r => setTimeout(r, 1));
        return origWrite(p, c);
    };
    const memory = new AgentMemory(vault, 'Jaskier');
    const tool = createMemorySaveTool();

    const [r1, r2] = await Promise.all([
        tool.execute(noteArgs({ name: 'Alpha fact', content: 'Alpha content' }), null, makePlugin(memory)),
        tool.execute(noteArgs({ name: 'Beta fact', content: 'Beta content' }), null, makePlugin(memory)),
    ]);

    t.true(r1.success);
    t.true(r2.success);
    const alphaPath = '.pkm-assistant/agents/jaskier/memory/brain/user_alpha_fact.md';
    const betaPath = '.pkm-assistant/agents/jaskier/memory/brain/user_beta_fact.md';
    t.true(Object.prototype.hasOwnProperty.call(files, alphaPath));
    t.true(Object.prototype.hasOwnProperty.call(files, betaPath));
    // The index (brain.md) must list BOTH notes — the serialized rebuild cannot lose one.
    t.true(files[brainPath].includes('[[brain/user_alpha_fact.md]]'));
    t.true(files[brainPath].includes('[[brain/user_beta_fact.md]]'));
});

test('E2.7 K1: two parallel memory_save (same name) → exactly one file, other gets note_already_exists', async t => {
    const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const { vault, files } = makeVault({ [brainPath]: brain() });
    const origWrite = vault.adapter.write;
    vault.adapter.write = async (p, c) => {
        await new Promise(r => setTimeout(r, 1));
        return origWrite(p, c);
    };
    const memory = new AgentMemory(vault, 'Jaskier');
    const tool = createMemorySaveTool();

    const results = await Promise.all([
        tool.execute(noteArgs({ name: 'Same fact', content: 'first' }), null, makePlugin(memory)),
        tool.execute(noteArgs({ name: 'Same fact', content: 'second' }), null, makePlugin(memory)),
    ]);

    const succeeded = results.filter(r => r.success);
    const refused = results.filter(r => !r.success && r.code === 'note_already_exists');
    t.is(succeeded.length, 1);
    t.is(refused.length, 1);
    const notePath = '.pkm-assistant/agents/jaskier/memory/brain/user_same_fact.md';
    t.true(Object.prototype.hasOwnProperty.call(files, notePath));
});

// ─── E2.8 D2: memory_save {ephemeral} → „Na teraz" section (the create-only exception) ───

test('E2.8 D2: memory_save ephemeral writes to „Na teraz" instead of a brain/ note', async t => {
    const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const { vault, files } = makeVault({ [brainPath]: brain() });
    const memory = new AgentMemory(vault, 'Jaskier');

    const result = await createMemorySaveTool().execute(
        { ephemeral: true, section: 'user', content: 'Kuba testuje dziś panel' },
        null,
        makePlugin(memory)
    ) as MemRes;

    t.true(result.success);
    t.true(result.ephemeral);
    t.is(result.section, 'user');
    t.true(files[brainPath].includes('## Na teraz: User'));
    t.true(files[brainPath].includes('- Kuba testuje dziś panel'));
    // No brain/ note was created — this is NOT the create-only path.
    const brainDir = '.pkm-assistant/agents/jaskier/memory/brain/';
    t.false(Object.keys(files).some(p => p.startsWith(brainDir)), 'no brain/ note created');
});

test('E2.8 D2: memory_save ephemeral remove purges an outdated „Na teraz" entry', async t => {
    const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const { vault, files } = makeVault({ [brainPath]: brain() });
    const memory = new AgentMemory(vault, 'Jaskier');
    const tool = createMemorySaveTool();

    await tool.execute({ ephemeral: true, section: 'environment', content: 'Stary stan projektu' }, null, makePlugin(memory));
    // update in one call: remove outdated + add fresh
    const result = await tool.execute(
        { ephemeral: true, section: 'environment', remove: 'Stary stan projektu', content: 'Nowy stan projektu' },
        null,
        makePlugin(memory)
    ) as MemRes;

    t.true(result.success);
    t.false(files[brainPath].includes('- Stary stan projektu'));
    t.true(files[brainPath].includes('- Nowy stan projektu'));
});

test('E2.8 D2: memory_save ephemeral rejects an empty op and a bad section', async t => {
    const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const { vault } = makeVault({ [brainPath]: brain() });
    const memory = new AgentMemory(vault, 'Jaskier');
    const tool = createMemorySaveTool();

    const empty = await tool.execute({ ephemeral: true, section: 'user' }, null, makePlugin(memory)) as MemRes;
    t.false(empty.success);
    t.is(empty.code, 'validation_error');

    const badSection = await tool.execute({ ephemeral: true, section: 'nonsense', content: 'x' }, null, makePlugin(memory)) as MemRes;
    t.false(badSection.success);
    t.is(badSection.code, 'validation_error');
});

// ── Poligon F2: stopka notatki (Dlaczego / Jak stosować) idzie z i18n ──────────
// Wcześniej `**Why:** Not specified yet.` / `**How to apply:** …` były wpisane na sztywno
// w DWÓCH miejscach (MemorySaveTool + AgentMemory._buildBrainNoteContent) i lądowały
// po angielsku w vaulcie usera niezależnie od języka UI.
// ⚠️ test.serial + przywrócenie locale — `setLocale` to globalny stan modułu i18n.

test.serial('stopka notatki brain/ jest w języku UI (pl vs en) — obie ścieżki zapisu', async t => {
    const przedLocale = getLocale();
    try {
        const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
        const { vault, files } = makeVault({ [brainPath]: brain() });
        const memory = new AgentMemory(vault, 'Jaskier');

        // ── PL ──
        setLocale('pl');
        // Ścieżka 1: narzędzie agenta (bez why/how → domyślne zdania).
        await createMemorySaveTool().execute(
            noteArgs({ name: 'Notka PL', why: '', how_to_apply: '' }), null, makePlugin(memory),
        );
        const pathPl = '.pkm-assistant/agents/jaskier/memory/brain/user_notka_pl.md';
        t.true(files[pathPl].includes('**Dlaczego:** Jeszcze nieokreślone.'));
        t.true(files[pathPl].includes('**Jak stosować:** Użyj, gdy pasuje do bieżącej rozmowy.'));
        t.false(files[pathPl].includes('**Why:**'), 'przy locale pl nie może zostać angielska etykieta');

        // Ścieżka 2: ratunek pamięci przy kompresji okna (AgentMemory.writeBrainNote).
        const ratunekPl = await memory.writeBrainNote({
            name: 'Ratunek PL', description: 'opis', type: 'reference', content: 'treść',
        });
        t.true(files[ratunekPl.path].includes('**Dlaczego:**'));
        t.true(files[ratunekPl.path].includes('**Jak stosować:**'));

        // ── EN ──
        setLocale('en');
        await createMemorySaveTool().execute(
            noteArgs({ name: 'Note EN', why: '', how_to_apply: '' }), null, makePlugin(memory),
        );
        const pathEn = '.pkm-assistant/agents/jaskier/memory/brain/user_note_en.md';
        t.true(files[pathEn].includes('**Why:** Not specified yet.'));
        t.true(files[pathEn].includes('**How to apply:** Use this when it is relevant to the current conversation.'));

        const ratunekEn = await memory.writeBrainNote({
            name: 'Rescue EN', description: 'desc', type: 'reference', content: 'body',
        });
        t.true(files[ratunekEn.path].includes('**Why:**'));
        t.true(files[ratunekEn.path].includes('**How to apply:**'));

        // Jawne why/how od modelu przechodzą verbatim w obu językach.
        setLocale('pl');
        await createMemorySaveTool().execute(
            noteArgs({ name: 'Notka wlasna', why: 'bo tak', how_to_apply: 'wtedy i wtedy' }), null, makePlugin(memory),
        );
        const wlasna = files['.pkm-assistant/agents/jaskier/memory/brain/user_notka_wlasna.md'];
        t.true(wlasna.includes('**Dlaczego:** bo tak'));
        t.true(wlasna.includes('**Jak stosować:** wtedy i wtedy'));
    } finally {
        setLocale(przedLocale);
    }
});

// ── K4 (AUD-security-036): rozwiązywanie pamięci jest FAIL-CLOSED ──
// Tożsamość z runtime (`_invocationAgentName`) bez wpisu w `agentMemories` — dzieje się przy
// biegu suba w tle po przełączeniu agenta i po skasowaniu agenta w trakcie biegu. Do K4
// narzędzia spadały wtedy na `getActiveMemory()`, czyli pisały do CUDZEGO katalogu `brain/`.

test('K4/036: memory_save z nieznaną tożsamością odmawia zamiast pisać do cudzej pamięci', async t => {
    const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const { vault, files } = makeVault({ [brainPath]: brain() });
    const memory = new AgentMemory(vault, 'Jaskier');
    const before = Object.keys(files).length;

    const result = await createMemorySaveTool().execute(
        noteArgs({ _invocationAgentName: 'Skasowany' }), null, makePlugin(memory),
    ) as MemRes;

    t.false(result.success);
    t.is(Object.keys(files).length, before, 'żaden plik nie mógł powstać w pamięci Jaskra');
});

test('K4/036: memory_delete z nieznaną tożsamością odmawia zamiast kasować u kogoś innego', async t => {
    const notePath = '.pkm-assistant/agents/jaskier/memory/brain/user_kuba.md';
    const { vault, files } = makeVault({
        '.pkm-assistant/agents/jaskier/memory/brain.md': brain(),
        [notePath]: '---\nname: Kuba\ntype: user\n---\ntreść',
    });
    const memory = new AgentMemory(vault, 'Jaskier');

    const result = await createMemoryDeleteTool().execute(
        { fact: 'Kuba', _invocationAgentName: 'Skasowany' }, null, makePlugin(memory),
    ) as MemRes;

    t.false(result.success);
    t.true(Object.prototype.hasOwnProperty.call(files, notePath), 'notatka Jaskra musi przeżyć');
});

// ── AUD-bledy-029: zmiana zatwierdzona ≠ indeks odświeżony ──
// `rebuildBrainIndex` jest od K4 (gotcha 9 w `modules/memory/CLAUDE.md`) FAIL-CLOSED: odczyt
// `'unknown'` rzuca zamiast nadpisać brain.md. Dopóki rebuild siedział w tym samym `try` co
// zapis/kasacja, jego pad zamieniał UDANĄ operację w `{success:false}` — model ponawiał zapis
// (i odbijał się o create-only) albo słyszał „nie skasowałem" o pliku, którego już nie ma.

test('029: memory_save z padniętym rebuildem melduje sukces + index_stale (notatka JEST na dysku)', async t => {
    const brainPath = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const { vault, files } = makeVault({ [brainPath]: brain() });
    const memory = new AgentMemory(vault, 'Jaskier');
    // Atrapa: przebudowa indeksu pada (fail-closed przy `probeFile → 'unknown'`).
    memory.rebuildBrainIndex = async () => { throw new Error('brain.md: odczyt niepewny'); };

    const result = await createMemorySaveTool().execute(noteArgs(), null, makePlugin(memory)) as MemRes;

    const notePath = '.pkm-assistant/agents/jaskier/memory/brain/user_kuba_direct_feedback.md';
    t.true(Object.prototype.hasOwnProperty.call(files, notePath), 'notatka realnie powstała');
    t.true(result.success, 'zapis się udał, więc meldunek to sukces');
    t.true(result.index_stale, 'ale indeks brain.md nie został odświeżony');
    t.is(typeof result.warning, 'string');
    t.not(result.warning, '');
});

test('029: memory_delete z padniętym rebuildem melduje sukces + index_stale (plik JUŻ skasowany)', async t => {
    const notePath = '.pkm-assistant/agents/jaskier/memory/brain/user_kuba.md';
    const { vault, files } = makeVault({
        '.pkm-assistant/agents/jaskier/memory/brain.md': brain(),
        [notePath]: '---\nname: Kuba\ntype: user\n---\ntreść',
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    memory.rebuildBrainIndex = async () => { throw new Error('brain.md: odczyt niepewny'); };

    const result = await createMemoryDeleteTool().execute(
        { fact: 'Kuba' }, null, makePlugin(memory),
    ) as MemRes;

    t.false(Object.prototype.hasOwnProperty.call(files, notePath), 'plik realnie zniknął');
    t.true(result.success, 'kasacja się udała, więc meldunek to sukces');
    t.true(result.index_stale);
    t.is(typeof result.warning, 'string');
    t.not(result.warning, '');
});
