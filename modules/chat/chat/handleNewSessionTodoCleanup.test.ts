import test from 'ava';
import { _resetTodoPanelState } from './chat_tabs.js';
import { handleNewSession } from './chat_session.js';
import { SessionCloseModal } from '../SessionCloseModal.js';

/** Kontrakt ścieżki jednorazowego pliku todo (`TodoTool.ts`, TODO_FOLDER nie jest w
 * publicznych drzwiach `modules/tools/index.js` — literał, nie deep-import z sąsiedniego modułu). */
const TODO_FOLDER = '.pkm-assistant/artifacts/todo';

/**
 * BUG C3 — nowa rozmowa nie czyściła panelu `todo` nad polem wpisywania, mimo że stara
 * sesja realnie odeszła (archive/discard). Drugi ogon: plik jednorazowy
 * `.pkm-assistant/artifacts/todo/<agent>-<sessionId>.md` zostawał na dysku po odrzuceniu
 * sesji (harmless, ale się kumuluje).
 *
 * `handleNewSession` resetował panel TYLKO przy przełączeniu ZAKŁADKI (`_switchTab`,
 * `chat_tabs.ts`) - nowa sesja TEGO SAMEGO agenta nie przechodziła przez tę ścieżkę.
 */
type TestDynamic = any;

/** Fake adapter dotfolderowy (`.pkm-assistant/artifacts/todo/`) — in-memory mapa. */
function makeTodoAdapter(seed: Record<string, string> = {}) {
    const files = new Map(Object.entries(seed));
    return {
        files,
        adapter: {
            exists: async (p: string) => files.has(p),
            read: async (p: string) => files.get(p) as string,
            write: async (p: string, c: string) => { files.set(p, c); },
            remove: async (p: string) => { files.delete(p); },
            mkdir: async () => {},
            list: async (dir: string) => ({ files: [...files.keys()].filter(p => p.startsWith(dir + '/')) }),
        },
    };
}

function buildFakeThis(overrides: TestDynamic = {}): TestDynamic {
    return {
        is_generating: false,
        stop_generation: () => {},
        rollingWindow: { messages: [] },
        tokenTracker: { clear: () => {} },
        app: { vault: { adapter: makeTodoAdapter().adapter } },
        handleSaveSession: async () => {},
        plugin: {
            agentManager: {
                getActiveAgent: () => ({ name: 'Jaskier', color: '#fff' }),
                getActiveMemory: () => null,
            },
            subTaskRegistry: { pruneSession: () => {} },
        },
        _renderSubTaskStrip: () => {},
        consolidateSession: async () => {},
        _createRollingWindow: () => ({ messages: [] }),
        render_messages: async () => {},
        add_welcome_message: () => {},
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
        // Stan z POPRZEDNIEJ rozmowy — ten sam kształt, który `_switchTab` czyści.
        _activeTodoState: { title: 'Stara lista', items: [{ text: 'a', checked: false }] },
        _prevTodoModel: { visible: true, title: 'Stara lista', items: [{ text: 'a', checked: false }], done: 0, total: 1, allDone: false },
        _bottomBarMode: 'todo',
        _renderTodoPanel: () => {},
        // Prawdziwa funkcja (nie mock) — weryfikujemy REALNE okablowanie, nie że coś zostało wołane.
        _resetTodoPanelState,
        ...overrides,
    };
}

test('BUG C3: handleNewSession czyści panel todo nawet z pustym oknem (bez modalu)', async t => {
    const fakeThis = buildFakeThis();

    await handleNewSession.call(fakeThis);

    t.is(fakeThis._activeTodoState, null, 'stan listy POPRZEDNIEJ rozmowy zniknął');
    t.is(fakeThis._prevTodoModel, null);
    t.is(fakeThis._bottomBarMode, 'input', 'pasek wraca na pole tekstowe');
});

test.serial('BUG C3: handleNewSession (odrzucenie) czyści panel todo I kasuje plik jednorazowy', async t => {
    // `SessionCloseModal.prompt()` w realnym kodzie czeka na klik w DOM, którego atrapa
    // Obsidiana (`Modal.open()` no-op) nigdy nie odpali — podmieniamy TYLKO `prompt()` na czas
    // testu, resztę klasy (konstruktor, pola) zostawiamy prawdziwą.
    const originalPrompt = SessionCloseModal.prototype.prompt;
    SessionCloseModal.prototype.prompt = async function () { return { choice: 'discard' }; };
    t.teardown(() => { SessionCloseModal.prototype.prompt = originalPrompt; });

    const sessionPath = 'sessions/active/Jaskier_2026-08-09.md';
    // Nazwa pliku wg TEGO SAMEGO wzoru co `TodoTool.path`/`safeSlug` (agent + sessionId, basename bez .md).
    const todoPath = `${TODO_FOLDER}/jaskier-jaskier_2026_08_09.md`;
    const { adapter, files } = makeTodoAdapter({ [todoPath]: '---\ntyp: todo\n---\n\n## Zadania\n- [ ] coś\n' });

    const fakeAgentMemory = {
        activeSessionPath: sessionPath,
        discardActiveSession: async () => 'sessions/active/.discarded/Jaskier_2026-08-09.md',
        startNewSession: async () => {},
    };
    const fakeThis = buildFakeThis({
        rollingWindow: { messages: [{ role: 'user', content: 'cześć' }] },
        app: { vault: { adapter } },
        plugin: {
            agentManager: {
                getActiveAgent: () => ({ name: 'Jaskier', color: '#fff' }),
                getActiveMemory: () => fakeAgentMemory,
            },
            subTaskRegistry: { pruneSession: () => {} },
        },
    });

    await handleNewSession.call(fakeThis);

    t.false(files.has(todoPath), 'plik todo sesji poszedł do kasacji razem z odrzuceniem sesji');
    t.is(fakeThis._activeTodoState, null, 'panel todo wyczyszczony też na ścieżce z modalem');
    t.is(fakeThis._bottomBarMode, 'input');
});
