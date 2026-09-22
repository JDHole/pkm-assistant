import test from 'ava';
import { RollingWindow } from './RollingWindow.js';
import { _restoreActiveSession, handleNewSession } from './chat_session.js';
import { SessionWriteConsent } from '../../../core/index.js';

/**
 * BUG C1 — restore po restarcie Obsidiana gubił `tool_call_id`/`tool_calls`.
 *
 * `_restoreActiveSession` czyta `AgentMemory.loadActiveSession()` (format v3,
 * `modules/memory/activeSessionFormat.ts` niesie już `toolCallId`/`toolCalls` na
 * `ActiveSessionMessage`), ale wołał `rollingWindow.addMessage(msg.role, msg.content)`
 * BEZ trzeciego argumentu — odrzucał te pola, mimo że czytnik je odzyskał. Kolejna tura
 * widziała `tool` message bez `tool_call_id` i `sanitizeToolTranscript`
 * (`modules/agent-loop`) kasował go jako sierotę (log
 * `drop orphan tool message (tool_call_id="undefined")`).
 *
 * `chat_session.ts` importuje `obsidian`, ale harness dostarcza atrapę dla AVA (patrz
 * `modules/chat/CLAUDE.md`, "Watchdog vs test bez ChatView" — ten plik pokazuje, że
 * przynajmniej `chat_session.ts` JEST importowalny; dokumentacja aktualizowana w tym samym
 * commicie).
 */

// TS-any: fake `this` (ChatViewLike) — test podaje tylko pola, których realnie dotyka
// `_restoreActiveSession`, nie cały kontrakt widoku.
type TestDynamic = any;

function buildFakeThis(parsedMessages: TestDynamic[]): TestDynamic {
    const fakeAgent = { name: 'Jaskier' };
    const fakeSession = { path: 'sessions/active/Jaskier_2026-08-09.md', name: 'Jaskier_2026-08-09.md', mtime: 1 };
    const fakeAgentMemory = {
        listActiveSessions: async () => [fakeSession],
        loadActiveSession: async () => ({ messages: parsedMessages, metadata: {}, summary: null }),
        activeSessionPath: null as string | null,
        _persistActiveSession: async () => {},
    };
    const fakeAgentManager = {
        getAllAgents: () => [fakeAgent],
        getActiveAgent: () => fakeAgent,
        getAgentMemory: () => fakeAgentMemory,
        getActiveMemory: () => fakeAgentMemory,
        switchAgent: () => {},
    };
    return {
        plugin: { agentManager: fakeAgentManager },
        _createRollingWindow: () => new RollingWindow({ maxTokens: 100000, systemPrompt: 'sys' }),
        chatTabs: [],
        _agentStates: new Map(),
        currentAutonomy: 'edge',
        render_messages: async () => {},
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
        _tabBarContainer: null,
    };
}

test('BUG C1: _restoreActiveSession forwards tool_call_id/tool_calls into RollingWindow', async t => {
    const parsedMessages = [
        { role: 'user', content: 'pokaż listę plików', seq: 1 },
        {
            role: 'assistant',
            content: '',
            seq: 2,
            toolCalls: [{ id: 'call_abc123', function: { name: 'list', arguments: '{"path":"."}' } }],
        },
        { role: 'tool', content: 'a.md\nb.md', seq: 3, toolCallId: 'call_abc123' },
    ];
    const fakeThis = buildFakeThis(parsedMessages);

    await _restoreActiveSession.call(fakeThis);

    const rw: RollingWindow = fakeThis.rollingWindow;
    t.truthy(rw, 'restore ustawił rollingWindow na fake this');

    const assistantMsg = rw.messages.find(m => m.role === 'assistant');
    const toolMsg = rw.messages.find(m => m.role === 'tool');
    t.is(assistantMsg?.tool_calls?.[0]?.id, 'call_abc123', 'assistant.tool_calls[0].id odtworzony');
    t.is(toolMsg?.tool_call_id, 'call_abc123', 'tool.tool_call_id odtworzony');

    // Skutek realny: sanitizer (wołany przez getMessagesForAPI) NIE kasuje wyniku narzędzia.
    const api = rw.getMessagesForAPI();
    t.true(
        api.some(m => m.role === 'tool' && m.tool_call_id === 'call_abc123'),
        'wynik narzędzia sprzed restartu przeżył sanityzację transkryptu po restore',
    );
});

test('_restoreActiveSession restauruje wiadomości bez tool_call_id jak dotąd (brak regresji)', async t => {
    const parsedMessages = [
        { role: 'user', content: 'cześć', seq: 1 },
        { role: 'assistant', content: 'hej', seq: 2 },
    ];
    const fakeThis = buildFakeThis(parsedMessages);

    await _restoreActiveSession.call(fakeThis);

    const rw: RollingWindow = fakeThis.rollingWindow;
    t.deepEqual(rw.messages.map(m => ({ role: m.role, content: m.content })), [
        { role: 'user', content: 'cześć' },
        { role: 'assistant', content: 'hej' },
    ]);
    t.is(rw.messages[0].tool_call_id, undefined);
    t.is(rw.messages[1].tool_calls, undefined);
});

// ─── handleNewSession kasuje zgodę sesyjną DLA STAREJ ścieżki (per-recenzja: nazwa pliku sesji
// ma rozdzielczość minutową i po archiwizacji/odrzuceniu wraca do puli - bez czyszczenia stara
// zgoda "wracałaby" razem z reużytą nazwą) ───

function buildFakeThisForNewSession(activeSessionPath: string, sessionWriteConsent: SessionWriteConsent): TestDynamic {
    const fakeAgentMemory = {
        activeSessionPath,
        startNewSession: async () => {},
    };
    return {
        is_generating: false,
        stop_generation: () => {},
        rollingWindow: { messages: [] as unknown[] },
        tokenTracker: { clear: () => {} },
        plugin: {
            agentManager: { getActiveMemory: () => fakeAgentMemory },
            mcpClient: { sessionWriteConsent },
        },
        _createRollingWindow: () => new RollingWindow({ maxTokens: 100000, systemPrompt: 'sys' }),
        render_messages: async () => {},
        add_welcome_message: () => {},
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
        _resetTodoPanelState: () => {},
    };
}

test('handleNewSession: kasuje zgodę sesyjną DLA STAREJ ścieżki, inna sesja zostaje', async t => {
    const consent = new SessionWriteConsent();
    consent.grant('sessions/active/Jaskier_2026-09-22_10-00.md', 'Notatki/a.md');
    consent.grant('sessions/active/Inna_sesja.md', 'Notatki/b.md');

    const fakeThis = buildFakeThisForNewSession('sessions/active/Jaskier_2026-09-22_10-00.md', consent);
    await handleNewSession.call(fakeThis);

    t.false(
        consent.has('sessions/active/Jaskier_2026-09-22_10-00.md', 'Notatki/a.md'),
        'zgoda dla sesji, która WŁAŚNIE się kończy, ma zniknąć - inaczej wróci razem z reużytą nazwą pliku (rozdzielczość minutowa)',
    );
    t.true(
        consent.has('sessions/active/Inna_sesja.md', 'Notatki/b.md'),
        'zgoda dla INNEJ sesji (inny plik) ma zostać nietknięta',
    );
});

test('handleNewSession: brak aktywnej ścieżki sesji (świeża zakładka) - nic nie wybucha, konsola bez zgód nietknięta', async t => {
    const consent = new SessionWriteConsent();
    consent.grant('sessions/active/Inna_sesja.md', 'Notatki/b.md');

    const fakeThis = buildFakeThisForNewSession('', consent);
    await handleNewSession.call(fakeThis);

    t.true(consent.has('sessions/active/Inna_sesja.md', 'Notatki/b.md'));
});
