import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
    resolveOwnerAgentName,
    resolveOwnerAgent,
    resolveOwnerMemory,
    saveMemoryCandidatesFor,
    buildOwnerWindowOptions,
    freezeTurnOwner,
    isOwnerTabActive,
} from './turnOwner.js';

// TS-any: atrapy runtime'u (AgentManager/AgentMemory/ChatView).
type Runtime = any;

/**
 * Atrapa AgentManagera z dwoma agentami: A (właściciel tury) i B (przełączony pod spodem).
 *
 * @param opts.pendingRescue - D8 (2026-08-27): opcjonalna atrapa `writePendingRescue` na pamięci.
 *   `'ok'` = poczekalnia działa (kandydat ląduje w `pending`, NIE w `written`). `'throw'` = symuluje
 *   padniętą poczekalnię (fail-soft ma wtedy spaść na `writeBrainNote`). Bez opcji (stare testy)
 *   `writePendingRescue` W OGÓLE nie istnieje na atrapie — dokładnie jak przed D8.
 */
function makeManager(opts: { pendingRescue?: 'ok' | 'throw' } = {}) {
    const brains: Record<string, string> = { A: 'BRAIN-A', B: 'BRAIN-B' };
    const written: Array<{ agent: string; candidate: Runtime }> = [];
    const pending: Array<{ agent: string; candidate: Runtime }> = [];
    const rebuilt: string[] = [];
    const memories: Record<string, Runtime> = {};
    for (const name of ['A', 'B']) {
        const mem: Runtime = {
            agentName: name,
            getBrain: async () => brains[name],
            writeBrainNote: async (candidate: Runtime) => {
                written.push({ agent: name, candidate });
                return { path: `.pkm-assistant/agents/${name.toLowerCase()}/memory/brain/${candidate.name}.md` };
            },
            rebuildBrainIndex: async () => { rebuilt.push(name); },
        };
        if (opts.pendingRescue === 'ok') {
            mem.writePendingRescue = async (candidate: Runtime) => {
                pending.push({ agent: name, candidate });
                return { path: `.pkm-assistant/agents/${name.toLowerCase()}/memory/brain/pending_rescue/${candidate.name}.md` };
            };
        } else if (opts.pendingRescue === 'throw') {
            mem.writePendingRescue = async () => { throw new Error('poczekalnia padła (test)'); };
        }
        memories[name] = mem;
    }
    const agents: Record<string, Runtime> = {
        A: { name: 'A', models: { researcher: 'model-A' } },
        B: { name: 'B', models: { researcher: 'model-B' } },
    };
    const state = { active: 'B' };
    return {
        state, written, pending, rebuilt, agents, memories,
        manager: {
            getAgent: (name: string) => agents[name],
            getActiveAgent: () => agents[state.active],
            getAgentMemory: (name: string) => memories[name] || null,
            getActiveMemory: () => memories[state.active] || null,
        },
    };
}

/**
 * Atrapa ChatView — tylko to, czego dotykają providery okna.
 * @param opts.chatTabs - AUD-code-review-013: opcjonalny model zakładek dla `isOwnerTabActive`.
 *   Domyślnie brak (jak przed 013) — `isOwnerTabActive` wtedy fail-open (maluje, jak dawniej).
 */
function makeView(manager: Runtime, opts: { chatTabs?: Runtime[] } = {}) {
    const seen: Runtime = { minionAgents: [], emergencyOwners: [], savedNotes: [], tokenPanelUpdates: 0 };
    return {
        seen,
        view: {
            plugin: { agentManager: manager },
            env: { settings: {} },
            chatTabs: opts.chatTabs,
            _getMinionModel: (agent: Runtime) => { seen.minionAgents.push(agent?.name ?? null); return { modelKey: `minion-${agent?.name}` }; },
            get_chat_model: () => ({ modelKey: 'GLOBAL-FALLBACK' }),
            _buildEmergencyTaskContext: (owner: string) => { seen.emergencyOwners.push(owner); return ''; },
            _renderMemorySavedNote: (n: number) => { seen.savedNotes.push(n); },
            _updateTokenPanel: () => { seen.tokenPanelUpdates++; },
        },
    };
}

// ── nazwa właściciela ──

test('resolveOwnerAgentName: jawna nazwa wygrywa z globalnym aktywnym', t => {
    const { manager } = makeManager();
    t.is(resolveOwnerAgentName(manager, 'A'), 'A');
    t.is(resolveOwnerAgentName(manager, '   '), 'B', 'pusta nazwa = zakładanie okna na aktywnym');
    t.is(resolveOwnerAgentName(manager, null), 'B');
});

// ── K4 rdzeń: brak zjazdu na globalne lustro ──

test('resolveOwnerMemory: znana nazwa NIE spada na getActiveMemory (AUD-security-064/065)', t => {
    const { manager, state } = makeManager();
    state.active = 'B';
    t.is(resolveOwnerMemory(manager, 'A')?.agentName, 'A');
    // Agent bez wpisu w agentMemories → odmowa, a nie cudzy katalog.
    t.is(resolveOwnerMemory(manager, 'Nieznany'), null);
    t.is(resolveOwnerMemory(manager, null)?.agentName, 'B', 'brak nazwy = stare zachowanie');
});

test('resolveOwnerAgent: znana nazwa NIE spada na getActiveAgent (AUD-security-066)', t => {
    const { manager, state } = makeManager();
    state.active = 'B';
    t.is(resolveOwnerAgent(manager, 'A')?.name, 'A');
    t.is(resolveOwnerAgent(manager, 'Nieznany'), null);
});

test('kompresja okna agenta A czyta brain.md agenta A, choć aktywny jest B', async t => {
    const { manager, state } = makeManager();
    const { view } = makeView(manager);
    const opts = buildOwnerWindowOptions(view, 'A');
    state.active = 'B'; // user przełączył zakładkę w trakcie tury
    t.is(await opts.memoryIndexProvider(), 'BRAIN-A');
});

test('kompresja okna agenta A jedzie modelem agenta A, choć aktywny jest B', t => {
    const { manager, state } = makeManager();
    const { view, seen } = makeView(manager);
    const opts = buildOwnerWindowOptions(view, 'A');
    state.active = 'B';
    t.is(opts.modelProvider()?.modelKey, 'minion-A');
    t.deepEqual(seen.minionAgents, ['A']);
});

test('kontekst awaryjny kompresji pyta o sesję WŁAŚCICIELA okna', t => {
    const { manager, state } = makeManager();
    const { view, seen } = makeView(manager);
    const opts = buildOwnerWindowOptions(view, 'A');
    state.active = 'B';
    opts.emergencyContextProvider();
    t.deepEqual(seen.emergencyOwners, ['A']);
});

// ── ratunek pamięci (065) ──

test('trwałe notatki brain/ z kompresji okna A lądują u A, pamięć B nietknięta', async t => {
    const { manager, state, written, rebuilt } = makeManager();
    const { view } = makeView(manager);
    const opts = buildOwnerWindowOptions(view, 'A');
    state.active = 'B';

    await opts.onMemoryCandidates([{ name: 'sekret-projektu', type: 'project_context', content: 'TAJNE-A' }]);

    t.deepEqual(written.map(w => w.agent), ['A']);
    t.deepEqual(rebuilt, ['A']);
});

test('wyłącznik memory_rescue czytany z agenta-WŁAŚCICIELA, nie z aktywnego', async t => {
    const { manager, agents, state, written } = makeManager();
    agents.A.memory_rescue = false;
    state.active = 'B';

    const saved = await saveMemoryCandidatesFor(manager, 'A', [{ name: 'x', content: 'y' }]);

    t.is(saved, 0, 'A ma ratunek pamięci wyłączony — nic nie zapisujemy');
    t.deepEqual(written, []);
});

// ── AUD-code-review-013: callbacki okna malują TYLKO do zakładki WŁAŚCICIELA ────────────────
//
// `messages_container` jest JEDEN na cały widok. K4 mówi że kompresja end-of-turn LECI
// bezwarunkowo także dla zakładki w tle — to zasada o DANYCH (transkrypt, sesja), nie o DOM-ie.
// Bez tej bramki blok „skompresowano"/nota ratunku pamięci agenta A malowały się fizycznie
// w rozmowie agenta B, którą user akurat czyta.

test('isOwnerTabActive: true gdy zakładka właściciela jest na wierzchu, false gdy inna', t => {
    const view = { chatTabs: [{ agentName: 'A', isActive: true }, { agentName: 'B', isActive: false }] };
    t.true(isOwnerTabActive(view, 'A'));
    t.false(isOwnerTabActive(view, 'B'));
});

test('isOwnerTabActive: fail-open (true) gdy widok nie zna modelu zakładek', t => {
    t.true(isOwnerTabActive({}, 'A'), 'atrapa bez chatTabs — nic do wygaszenia, maluj jak dawniej');
    t.true(isOwnerTabActive({ chatTabs: [] }, 'A'));
});

test('onMemoryCandidates NIE maluje noty do cudzej zakładki (AUD-code-review-013)', async t => {
    const { manager } = makeManager();
    const { view, seen } = makeView(manager, {
        chatTabs: [
            { agentName: 'A', isActive: false },
            { agentName: 'B', isActive: true }, // user czyta B, gdy kompresja kończy okno A w tle
        ],
    });
    const opts = buildOwnerWindowOptions(view, 'A');

    await opts.onMemoryCandidates([{ name: 'sekret-projektu', type: 'project_context', content: 'TAJNE-A' }]);

    t.deepEqual(seen.savedNotes, [], 'nota "N kandydatów czeka" nie ma prawa wylądować w rozmowie B');
    t.is(seen.tokenPanelUpdates, 0, 'panel tokenów zakładki B nie jest odświeżany danymi okna A');
});

test('onMemoryCandidates maluje notę, gdy zakładka właściciela jest aktywna', async t => {
    const { manager } = makeManager();
    const { view, seen } = makeView(manager, { chatTabs: [{ agentName: 'A', isActive: true }] });
    const opts = buildOwnerWindowOptions(view, 'A');

    await opts.onMemoryCandidates([{ name: 'x', type: 'project_context', content: 'y' }]);

    t.deepEqual(seen.savedNotes, [1]);
    t.is(seen.tokenPanelUpdates, 1);
});

// `_createRollingWindow` (chat_session.ts) importuje `obsidian` — strażnik PO ŹRÓDLE, wzór
// `stopSemantics.test.ts`.
test('chat_session._createRollingWindow gate’uje onSummarized/onToolsTrimmed przez isOwnerTabActive (AUD-code-review-013)', t => {
    const src = readFileSync(fileURLToPath(new URL('./chat_session.ts', import.meta.url)), 'utf8');
    const head = /onSummarized:[\s\S]*?\.\.\.buildOwnerWindowOptions/.exec(src);
    t.true(!!head, 'nie znalazłem bloku onSummarized/onToolsTrimmed w _createRollingWindow');
    const block = head![0];
    t.regex(block, /isOwnerTabActive\(this, ownerAgentName\)/g);
    // Dwa wystąpienia — jedno per callback.
    t.is((block.match(/isOwnerTabActive\(/g) || []).length, 2);
});

test('brak pamięci dla nazwanego właściciela = zero zapisów (fail-closed)', async t => {
    const { manager, written } = makeManager();
    const saved = await saveMemoryCandidatesFor(manager, 'Nieznany', [{ name: 'x', content: 'y' }]);
    t.is(saved, 0);
    t.deepEqual(written, [], 'kandydat NIE MOŻE wylądować w katalogu aktywnego agenta');
});

// ── D8 (2026-08-27, werdykt 27.08): poczekalnia zamiast zapisu wprost do brain/ ──

test('D8: kandydat idzie do poczekalni (writePendingRescue), NIE wprost do writeBrainNote', async t => {
    const { manager, written, pending, rebuilt } = makeManager({ pendingRescue: 'ok' });

    const saved = await saveMemoryCandidatesFor(manager, 'A', [
        { name: 'sekret-projektu', type: 'project_context', content: 'TAJNE-A' },
    ]);

    t.is(saved, 1);
    t.deepEqual(written, [], 'writeBrainNote nie jest wołane, gdy poczekalnia istnieje i działa');
    t.deepEqual(pending.map(w => w.agent), ['A'], 'kandydat trafia do poczekalni WŁAŚCICIELA okna');
    t.deepEqual(rebuilt, ['A'], 'indeks nadal odświeżany (rebuild jest tani no-opem, gdy brain/ się nie zmieniło)');
});

test('D8: fail-soft — padnięta poczekalnia wraca do dawnego zapisu wprost do brain/', async t => {
    const { manager, written } = makeManager({ pendingRescue: 'throw' });

    const saved = await saveMemoryCandidatesFor(manager, 'A', [{ name: 'x', type: 'user', content: 'y' }]);

    t.is(saved, 1, 'lepszy niezreview\'owany zapis niż utrata kandydata (werdykt 27.08)');
    t.deepEqual(written.map(w => w.agent), ['A'], 'writeBrainNote wołane jako fallback po padzie poczekalni');
});

test('D8: wiele kandydatów — jeden pada w poczekalni, reszta idzie normalnie (błąd izolowany per kandydat)', async t => {
    const { manager, written, pending } = makeManager({ pendingRescue: 'ok' });
    // Nadpisujemy poczekalnię A: DRUGI kandydat pada, pierwszy i trzeci przechodzą normalnie.
    manager.getAgentMemory('A')!.writePendingRescue = async (candidate: Runtime) => {
        if (candidate.name === 'padnie') throw new Error('symulowany pad');
        pending.push({ agent: 'A', candidate });
        return { path: `brain/pending_rescue/${candidate.name}.md` };
    };

    const saved = await saveMemoryCandidatesFor(manager, 'A', [
        { name: 'ok-1', type: 'user', content: 'a' },
        { name: 'padnie', type: 'user', content: 'b' },
        { name: 'ok-2', type: 'user', content: 'c' },
    ]);

    t.is(saved, 3, 'wszystkie trzy lądują gdzieś (dwa w poczekalni, jeden fail-soft w brain/)');
    t.deepEqual(pending.map(p => p.candidate.name), ['ok-1', 'ok-2']);
    t.deepEqual(written.map(w => w.candidate.name), ['padnie'], 'tylko padnięty kandydat idzie fail-softem wprost do brain/');
});

test('D8 nit C1(a) (weryfikacja opusa): atrapa BEZ poczekalni — padnięty writeBrainNote NIE jest ponawiany drugi raz', async t => {
    // Przed naprawą: gałąź "atrapa bez poczekalni" wołała writeBrainNote WEWNĄTRZ try, a catch
    // wołał je ZNOWU jako "fallback" — czyli dwa identyczne wywołania z tymi samymi argumentami
    // po jednym padzie. To marnowanie roboty (podwójny I/O) bez żadnej korzyści.
    const { manager } = makeManager(); // bez { pendingRescue }, więc mem.writePendingRescue === undefined
    let calls = 0;
    manager.getAgentMemory('A')!.writeBrainNote = async () => {
        calls++;
        throw new Error('writeBrainNote padł (test)');
    };

    const saved = await saveMemoryCandidatesFor(manager, 'A', [{ name: 'x', type: 'user', content: 'y' }]);

    t.is(saved, 0);
    t.is(calls, 1, 'writeBrainNote wołane DOKŁADNIE raz — bez sensownego retry tego samego wywołania');
});

// ── K18 (AUD-security-112): właściciel TURY zamrożony przed awaitami przygotowania ──

/** Atrapa ChatView z dwiema zakładkami — odgrywa `_switchTab` w trakcie budowy promptu. */
function makeTabbedView(manager: Runtime, bundle: Runtime) {
    const windows: Record<string, Runtime> = { A: { id: 'RW-A' }, B: { id: 'RW-B' } };
    const trackers: Record<string, Runtime> = { A: { id: 'TT-A' }, B: { id: 'TT-B' } };
    const view: Runtime = {
        plugin: { agentManager: manager },
        chatTabs: [
            { agentName: 'A', sessionPath: 'sesja-A.md', isActive: true },
            { agentName: 'B', sessionPath: 'sesja-B.md', isActive: false },
        ],
        rollingWindow: windows.A,
        tokenTracker: trackers.A,
        currentAutonomy: 'edge',
        currentArtifactId: 'artefakt-A',
    };
    /** Dokładnie to, co robi `_switchTab`: aktywny agent + okno + tracker + stan zakładki. */
    const switchTab = (to: 'A' | 'B') => {
        bundle.state.active = to;
        view.rollingWindow = windows[to];
        view.tokenTracker = trackers[to];
        view.currentAutonomy = to === 'B' ? 'yolo' : 'edge';
        view.currentArtifactId = `artefakt-${to}`;
        for (const tab of view.chatTabs) tab.isActive = tab.agentName === to;
    };
    return { view, windows, trackers, switchTab };
}

test('freezeTurnOwner: przełączenie zakładki w trakcie tury nie podmienia właściciela', t => {
    const bundle = makeManager();
    bundle.state.active = 'A';
    const { view, windows, trackers, switchTab } = makeTabbedView(bundle.manager, bundle);

    const owner = freezeTurnOwner(view);
    switchTab('B'); // user klika w drugą zakładkę, gdy prompt się jeszcze buduje

    t.is(owner.agentName, 'A');
    t.is(owner.agent?.name, 'A');
    t.is(owner.rollingWindow, windows.A, 'okno rozmowy zostaje przy właścicielu');
    t.is(owner.tokenTracker, trackers.A);
    t.is(owner.memory?.agentName, 'A', 'pamięć po nazwie właściciela, nie po aktywnym');
    t.is(owner.tab?.agentName, 'A', 'adres zwrotny delegacji celuje w zakładkę zlecenia');
    t.is(owner.autonomy, 'edge', 'autonomia B (yolo) NIE przejmuje tury zleconej w edge');
    t.is(owner.artifactId, 'artefakt-A');
    // Kontrola negatywna: widok NAPRAWDĘ się przełączył.
    t.is(bundle.manager.getActiveAgent()?.name, 'B');
    t.is(view.rollingWindow, windows.B);
});

test('freezeTurnOwner: ścieżka sesji to sesja właściciela z chwili startu tury', t => {
    const bundle = makeManager();
    bundle.state.active = 'A';
    bundle.memories.A.activeSessionPath = 'sessions/active/A-teraz.md';
    bundle.memories.B.activeSessionPath = 'sessions/active/B-teraz.md';
    const { view, switchTab } = makeTabbedView(bundle.manager, bundle);

    const owner = freezeTurnOwner(view);
    switchTab('B');

    t.is(owner.sessionPath, 'sessions/active/A-teraz.md');
});

test('freezeTurnOwner: nieznany agent nie dostaje cudzej pamięci (fail-closed)', t => {
    const bundle = makeManager();
    bundle.agents.Duch = { name: 'Duch' }; // profil jest, wpisu w agentMemories brak
    bundle.state.active = 'Duch';
    const { view } = makeTabbedView(bundle.manager, bundle);

    const owner = freezeTurnOwner(view);

    t.is(owner.agentName, 'Duch');
    t.is(owner.memory, null, 'brak pamięci = odmowa, a nie katalog sąsiada');
    t.is(owner.sessionPath, '');
});

test('freezeTurnOwner: pusty widok nie wybucha', t => {
    const owner = freezeTurnOwner({});
    t.is(owner.agentName, '');
    t.is(owner.agent, null);
    t.is(owner.tab, null);
});

// ── Strażnik PO ŹRÓDLE ──
// `send_message` ciągnie `obsidian` (MarkdownRenderer, Notice), więc w AVA nie wstaje.
// Kolejność „zamrożenie PRZED budową promptu" pilnujemy więc na źródle — wzór
// `core/PKMEnv.boot_timing.test.ts`.

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('send_message zamraża właściciela PRZED getActiveSystemPromptWithMemory', t => {
    const src = readSource('./chat_streaming.ts');
    const freeze = src.indexOf('freezeTurnOwner(this)');
    const prompt = src.indexOf('getActiveSystemPromptWithMemory(');
    t.true(freeze > 0, 'brak zamrożenia właściciela w send_message');
    t.true(prompt > 0);
    t.true(freeze < prompt, 'właściciel tury MUSI być zamrożony przed budową promptu z pamięcią');
});

test('prompt tury budowany dla agenta-właściciela, nie dla aktywnego', t => {
    const src = readSource('./chat_streaming.ts');
    t.regex(src, /getActiveSystemPromptWithMemory\([\s\S]{0,400}?\},\s*owner\.agent\b/);
});

test('AgentManager przyjmuje agenta argumentem (brak argumentu = stare zachowanie)', t => {
    const src = readSource('../../agents/AgentManager.ts');
    t.regex(src, /async getActiveSystemPromptWithMemory\(\s*context[^)]*,\s*agent\??:/);
});

/** Kod bez komentarzy — strażnik pilnuje WYWOŁAŃ, a nie opisów w komentarzach. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('po zamrożeniu send_message nie czyta już globalnych luster widoku', t => {
    const src = readSource('./chat_streaming.ts');
    const from = src.indexOf('freezeTurnOwner(this)');
    t.true(from > 0, 'brak zamrożenia właściciela w send_message');
    const body = stripComments(src.slice(from, src.indexOf('export function handle_chunk')));
    t.false(/getActiveAgent\(/.test(body), 'getActiveAgent() po zamrożeniu = powrót AUD-security-112');
    t.false(/this\.rollingWindow/.test(body), 'this.rollingWindow po zamrożeniu = okno cudzej zakładki');
    t.false(/getActiveMemory/.test(body), 'getActiveMemory() po zamrożeniu = sesja cudzego agenta');
});
