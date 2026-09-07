/**
 * AUD-code-review-024 (CRITICAL) — zmiana nazwy agenta ma jednego właściciela dyskowej operacji.
 * Testy pokrywają dokładnie to, czego żądał audyt: rename szczęśliwy, kolizja nazw, pad przenosin
 * pamięci — plus pad zapisu YAML i guard built-ina, żeby rollback nie miał dziur.
 */
import test from 'ava';
import { renameAgentOnDisk, type RenameAgentDeps, type RenameAgentLike } from './renameAgentFlow.js';

/** Vault-atrapa w pamięci: pliki + foldery jako proste zbiory, bez `obsidian`. */
function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>(initialFolders);
    const calls = { exists: [] as string[], remove: [] as string[], rmdir: [] as string[] };

    const adapter = {
        async exists(path: string) {
            calls.exists.push(path);
            return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
        },
        async remove(path: string) {
            calls.remove.push(path);
            delete files[path];
        },
        async rmdir(path: string, _recursive?: boolean) {
            calls.rmdir.push(path);
            folders.delete(path);
            const prefix = `${path}/`;
            for (const f of Object.keys(files)) if (f.startsWith(prefix)) delete files[f];
            for (const f of [...folders]) if (f.startsWith(prefix)) folders.delete(f);
        },
    };

    return { files, folders, calls, adapter };
}

function makeAgent(overrides: Partial<RenameAgentLike> = {}): RenameAgentLike {
    return { name: 'Agent2', isBuiltIn: false, filePath: '.pkm-assistant/agents/agent2.yaml', ...overrides };
}

/** Kopiowanie folderu — atrapa `AgentManager._copyFolderRecursive` na tej samej vault-atrapie. */
function makeCopyFolder(vault: ReturnType<typeof makeVault>, { failOn }: { failOn?: string } = {}) {
    return async (src: string, dest: string) => {
        vault.folders.add(dest);
        const prefix = `${src}/`;
        for (const [path, content] of Object.entries(vault.files)) {
            if (!path.startsWith(prefix)) continue;
            if (failOn && path === failOn) throw new Error(`copy padła na ${path}`);
            const rel = path.slice(src.length);
            vault.files[`${dest}${rel}`] = content;
        }
    };
}

function makeDeps(vault: ReturnType<typeof makeVault>, overrides: Partial<RenameAgentDeps> = {}): RenameAgentDeps {
    return {
        vaultAdapter: vault.adapter,
        agentsPath: '.pkm-assistant/agents',
        hasAgentName: () => false,
        saveAgent: async (agent) => {
            const safeName = agent.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
            const path = `.pkm-assistant/agents/${safeName}.yaml`;
            vault.files[path] = `name: ${agent.name}\n`;
            return path;
        },
        copyFolder: makeCopyFolder(vault),
        ...overrides,
    };
}

// ── rename szczęśliwy ──────────────────────────────────────────────────────

test('rename szczęśliwy: nowy YAML + folder pamięci powstają, stare znikają, agent wskazuje nową tożsamość', async t => {
    const vault = makeVault(
        {
            '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n',
            '.pkm-assistant/agents/agent2/memory/brain.md': '# brain',
            '.pkm-assistant/agents/agent2/memory/brain/note.md': 'trwały fakt',
        },
        ['.pkm-assistant/agents/agent2', '.pkm-assistant/agents/agent2/memory'],
    );
    const agent = makeAgent();
    const deps = makeDeps(vault);

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.true(result.ok);
    t.is(result.filePath, '.pkm-assistant/agents/badacz.yaml');
    t.is(agent.name, 'Badacz', 'obiekt agenta wskazuje nową nazwę');
    t.is(agent.filePath, '.pkm-assistant/agents/badacz.yaml');

    t.true('.pkm-assistant/agents/badacz.yaml' in vault.files, 'nowy YAML powstał');
    t.false('.pkm-assistant/agents/agent2.yaml' in vault.files, 'stary YAML skasowany');

    t.is(vault.files['.pkm-assistant/agents/badacz/memory/brain.md'], '# brain', 'pamięć przeniesiona pod nowy slug');
    t.is(vault.files['.pkm-assistant/agents/badacz/memory/brain/note.md'], 'trwały fakt');
    t.false('.pkm-assistant/agents/agent2/memory/brain.md' in vault.files, 'stara pamięć skasowana');
});

test('rename z tą samą nazwą (trim) jest no-opem — zero zapisów na dysk', async t => {
    const vault = makeVault({ '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n' });
    const agent = makeAgent();
    let saveCalled = false;
    const deps = makeDeps(vault, { saveAgent: async () => { saveCalled = true; return ''; } });

    const result = await renameAgentOnDisk(agent, '  Agent2  ', deps);

    t.true(result.ok);
    t.is(agent.name, 'Agent2');
    t.false(saveCalled, 'no-op nie zapisuje niczego');
});

// ── kolizja nazw ────────────────────────────────────────────────────────────

test('kolizja z agentem w pamięci: odmowa, zero zmian na agencie i na dysku', async t => {
    const vault = makeVault({ '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n' });
    const agent = makeAgent();
    let copyCalled = false;
    let saveCalled = false;
    const deps = makeDeps(vault, {
        hasAgentName: (name) => name === 'Klara',
        copyFolder: async () => { copyCalled = true; },
        saveAgent: async () => { saveCalled = true; return ''; },
    });

    const result = await renameAgentOnDisk(agent, 'Klara', deps);

    t.false(result.ok);
    t.is(result.reason, 'name_collision');
    t.is(agent.name, 'Agent2', 'nazwa agenta nietknięta');
    t.false(copyCalled, 'pamięć nigdy nie zaczęła się przenosić');
    t.false(saveCalled, 'YAML nigdy nie został zapisany — zero nadpisania cudzego pliku');
});

test('kolizja przez osierocony plik na dysku (bez wpisu w pamięci) też jest odmową', async t => {
    const vault = makeVault({
        '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n',
        '.pkm-assistant/agents/klara.yaml': 'name: Klara\n', // plik istnieje, ale nikt nie zgłasza kolizji w pamięci
    });
    const agent = makeAgent();
    const deps = makeDeps(vault, { hasAgentName: () => false });

    const result = await renameAgentOnDisk(agent, 'Klara', deps);

    t.false(result.ok);
    t.is(result.reason, 'name_collision');
    t.is(vault.files['.pkm-assistant/agents/klara.yaml'], 'name: Klara\n', 'cudzy plik NIE nadpisany');
});

// ── pad przenosin pamięci ────────────────────────────────────────────────────

test('pad kopiowania pamięci przerywa rename: zero zmian na agencie, zero zapisu YAML, sprzątnięta częściowa kopia', async t => {
    const vault = makeVault(
        {
            '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n',
            '.pkm-assistant/agents/agent2/memory/brain.md': '# brain',
            '.pkm-assistant/agents/agent2/memory/sessions/a.md': 'sesja',
        },
        ['.pkm-assistant/agents/agent2', '.pkm-assistant/agents/agent2/memory'],
    );
    const agent = makeAgent();
    let saveCalled = false;
    const deps = makeDeps(vault, {
        copyFolder: makeCopyFolder(vault, { failOn: '.pkm-assistant/agents/agent2/memory/sessions/a.md' }),
        saveAgent: async () => { saveCalled = true; return ''; },
    });

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.false(result.ok);
    t.is(result.reason, 'memory_move_failed');
    t.is(agent.name, 'Agent2', 'nazwa agenta nietknięta — zero połowicznego stanu');
    t.false(saveCalled, 'YAML nigdy nie doszedł do zapisu');
    t.true('.pkm-assistant/agents/agent2.yaml' in vault.files, 'stary YAML nietknięty');
    t.is(vault.files['.pkm-assistant/agents/agent2/memory/brain.md'], '# brain', 'stara pamięć nietknięta');
    t.true(vault.calls.rmdir.includes('.pkm-assistant/agents/badacz'), 'częściowa kopia posprzątana');
});

// ── pad zapisu YAML (po udanym przeniesieniu pamięci) ───────────────────────

test('pad zapisu nowego YAML cofa nazwę agenta i sprząta skopiowaną pamięć — stara pamięć zostaje', async t => {
    const vault = makeVault(
        { '.pkm-assistant/agents/agent2/memory/brain.md': '# brain' },
        ['.pkm-assistant/agents/agent2', '.pkm-assistant/agents/agent2/memory'],
    );
    const agent = makeAgent({ filePath: '.pkm-assistant/agents/agent2.yaml' });
    const deps = makeDeps(vault, {
        saveAgent: async () => { throw new Error('dysk pełny'); },
    });

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.false(result.ok);
    t.is(result.reason, 'save_failed');
    t.is(agent.name, 'Agent2', 'nazwa cofnięta po nieudanym zapisie');
    t.is(agent.filePath, '.pkm-assistant/agents/agent2.yaml', 'filePath nietknięty');
    t.is(vault.files['.pkm-assistant/agents/agent2/memory/brain.md'], '# brain', 'stara pamięć NIGDY nie została skasowana');
    t.true(vault.calls.rmdir.includes('.pkm-assistant/agents/badacz'), 'skopiowana pamięć pod nową nazwą posprzątana');
});

// ── guardy ───────────────────────────────────────────────────────────────────

test('agent wbudowany: odmowa bez dotykania dysku', async t => {
    const vault = makeVault();
    const agent = makeAgent({ isBuiltIn: true, name: 'Jaskier', filePath: null });
    let touched = false;
    const deps = makeDeps(vault, {
        saveAgent: async () => { touched = true; return ''; },
        copyFolder: async () => { touched = true; },
    });

    const result = await renameAgentOnDisk(agent, 'Nowy Jaskier', deps);

    t.false(result.ok);
    t.is(result.reason, 'built_in');
    t.is(agent.name, 'Jaskier');
    t.false(touched);
});

test('pusta/białoznakowa nazwa: odmowa', async t => {
    const vault = makeVault();
    const agent = makeAgent();
    const result = await renameAgentOnDisk(agent, '   ', makeDeps(vault));

    t.false(result.ok);
    t.is(result.reason, 'empty_name');
    t.is(agent.name, 'Agent2');
});

test('agent bez folderu pamięci (świeży, jeszcze nieinicjalizowany): rename przechodzi bez kopiowania', async t => {
    const vault = makeVault({ '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n' });
    const agent = makeAgent();
    let copyCalled = false;
    const deps = makeDeps(vault, { copyFolder: async () => { copyCalled = true; } });

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.true(result.ok);
    t.false(copyCalled, 'brak folderu = nic do skopiowania');
});

// ── F02 (AUD-code-review-024, druga runda) — same-slug, fail-closed, osierocony folder ──────

test('F02.1: rename na ten sam slug (tylko wielkość liter) — zapis w miejscu, ZERO ruszania pamięci, ZERO bramki kolizji z samym sobą', async t => {
    const vault = makeVault(
        {
            '.pkm-assistant/agents/badacz.yaml': 'name: badacz\n',
            '.pkm-assistant/agents/badacz/memory/brain.md': '# brain',
        },
        ['.pkm-assistant/agents/badacz', '.pkm-assistant/agents/badacz/memory'],
    );
    const agent = makeAgent({ name: 'badacz', filePath: '.pkm-assistant/agents/badacz.yaml' });
    let hasAgentNameCalled = false;
    let copyCalled = false;
    let rmdirCalled = false;
    const deps = makeDeps(vault, {
        hasAgentName: () => { hasAgentNameCalled = true; return false; },
        copyFolder: async () => { copyCalled = true; },
        vaultAdapter: {
            ...vault.adapter,
            rmdir: async (...args: [string, boolean?]) => { rmdirCalled = true; return vault.adapter.rmdir(...args); },
        },
    });

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.true(result.ok);
    t.is(agent.name, 'Badacz');
    t.is(result.filePath, '.pkm-assistant/agents/badacz.yaml', 'ścieżka na dysku niezmieniona — sam slug');
    t.false(hasAgentNameCalled, 'zero bramki kolizji z samym sobą');
    t.false(copyCalled, 'zero dotykania folderu pamięci — to ten sam folder');
    t.false(rmdirCalled, 'zero kasowania czegokolwiek');
    t.is(vault.files['.pkm-assistant/agents/badacz/memory/brain.md'], '# brain', 'pamięć nietknięta');
});

test('F02.2: bramka kolizji fail-CLOSED — pad exists() jest odmową, nie cichym przepuszczeniem', async t => {
    const vault = makeVault({ '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n' });
    const agent = makeAgent();
    let saveCalled = false;
    let copyCalled = false;
    const failingAdapter = {
        ...vault.adapter,
        async exists(_path: string): Promise<boolean> { throw new Error('dysk niedostępny'); },
    };
    const deps = makeDeps(vault, {
        vaultAdapter: failingAdapter,
        saveAgent: async () => { saveCalled = true; return ''; },
        copyFolder: async () => { copyCalled = true; },
    });

    const result = await renameAgentOnDisk(agent, 'Klara', deps);

    t.false(result.ok);
    t.is(result.reason, 'collision_check_failed');
    t.is(agent.name, 'Agent2', 'nazwa nietknięta');
    t.false(saveCalled, 'zero zapisu na padzie sprawdzenia kolizji');
    t.false(copyCalled, 'zero kopiowania pamięci na padzie sprawdzenia kolizji');
});

test('F02.3: osierocony folder pamięci pod nowym slugiem (po skasowanym agencie) jest kolizją — cudze notatki NIE zostają wchłonięte', async t => {
    const vault = makeVault(
        {
            '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n',
            '.pkm-assistant/agents/klara/memory/brain.md': 'cudze notatki',
        },
        ['.pkm-assistant/agents/klara', '.pkm-assistant/agents/klara/memory'],
    );
    const agent = makeAgent();
    let copyCalled = false;
    const deps = makeDeps(vault, {
        hasAgentName: () => false, // brak wpisu w pamięci runtime — TYLKO osierocony folder na dysku
        copyFolder: async () => { copyCalled = true; },
    });

    const result = await renameAgentOnDisk(agent, 'Klara', deps);

    t.false(result.ok);
    t.is(result.reason, 'name_collision');
    t.false(copyCalled, 'rename nigdy nie zaczął kopiować do cudzego folderu');
    t.is(vault.files['.pkm-assistant/agents/klara/memory/brain.md'], 'cudze notatki', 'cudza pamięć nietknięta');
});

test('F02.4: pad zapisu YAML gdy agent nie ma własnej pamięci — rollback NIE kasuje folderu, którego sam nie stworzył', async t => {
    const vault = makeVault({ '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n' });
    const agent = makeAgent();
    const deps = makeDeps(vault, {
        saveAgent: async () => { throw new Error('dysk pełny'); },
    });

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.false(result.ok);
    t.is(result.reason, 'save_failed');
    t.is(agent.name, 'Agent2');
    t.false(vault.calls.rmdir.includes('.pkm-assistant/agents/badacz'), 'rollback nie woła rmdir na folderze, który nigdy nie powstał');
});

// ── F02.6a — skrzynka komunikatora wędruje z agentem, best-effort ──────────────────────────

test('F02.5: rename przenosi skrzynkę komunikatora na nowy slug (create-before-delete)', async t => {
    const vault = makeVault(
        {
            '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n',
            '.pkm-assistant/komunikator/inbox/agent2/msg-1.md': 'wiadomość 1',
        },
        ['.pkm-assistant/komunikator/inbox/agent2'],
    );
    const agent = makeAgent();
    const deps = makeDeps(vault);

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.true(result.ok);
    t.falsy(result.inboxMoveFailed);
    t.is(vault.files['.pkm-assistant/komunikator/inbox/badacz/msg-1.md'], 'wiadomość 1', 'skrzynka pod nowym slugiem');
    t.false('.pkm-assistant/komunikator/inbox/agent2/msg-1.md' in vault.files, 'stara skrzynka skasowana');
});

test('F02.7: istniejąca skrzynka pod NOWYM slugiem = zero kopiowania (cudza poczta nie jest wchłaniana), inboxMoveFailed', async t => {
    const vault = makeVault(
        {
            '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n',
            '.pkm-assistant/komunikator/inbox/agent2/msg-1.md': 'moja wiadomość',
            '.pkm-assistant/komunikator/inbox/badacz/msg-cudza.md': 'cudza poczta po skasowanym agencie',
        },
        ['.pkm-assistant/komunikator/inbox/agent2', '.pkm-assistant/komunikator/inbox/badacz'],
    );
    const agent = makeAgent();
    const deps = makeDeps(vault);

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.true(result.ok, 'rename agenta udany — skrzynka jest best-effort');
    t.true(result.inboxMoveFailed, 'zgłoszony pad przenosin skrzynki');
    t.is(vault.files['.pkm-assistant/komunikator/inbox/badacz/msg-cudza.md'], 'cudza poczta po skasowanym agencie', 'cudza skrzynka NIETKNIĘTA');
    t.true('.pkm-assistant/komunikator/inbox/agent2/msg-1.md' in vault.files, 'stara skrzynka zostaje (nic nie skasowane)');
});

test('F02.6: pad przenosin skrzynki komunikatora NIE wywala rename — agent zapisany, zwrotka niesie inboxMoveFailed', async t => {
    const vault = makeVault(
        {
            '.pkm-assistant/agents/agent2.yaml': 'name: Agent2\n',
            '.pkm-assistant/komunikator/inbox/agent2/msg-1.md': 'wiadomość 1',
        },
        ['.pkm-assistant/komunikator/inbox/agent2'],
    );
    const agent = makeAgent();
    const realCopy = makeCopyFolder(vault);
    const deps = makeDeps(vault, {
        copyFolder: async (src: string, dest: string) => {
            if (src.startsWith('.pkm-assistant/komunikator/inbox/')) throw new Error('dysk padł na skrzynce');
            return realCopy(src, dest);
        },
    });

    const result = await renameAgentOnDisk(agent, 'Badacz', deps);

    t.true(result.ok, 'rename agenta udany mimo pada skrzynki');
    t.true(result.inboxMoveFailed);
    t.is(agent.name, 'Badacz');
    t.is(result.filePath, '.pkm-assistant/agents/badacz.yaml');
    t.true('.pkm-assistant/komunikator/inbox/agent2/msg-1.md' in vault.files, 'stara skrzynka NIETKNIĘTA po padzie (nic nie skasowane w połowie)');
});
