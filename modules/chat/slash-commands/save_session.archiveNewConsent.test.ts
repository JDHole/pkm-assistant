/**
 * `applyPostArchiveAction` - `/save session` jest DRUGĄ drogą zakończenia sesji obok
 * `handleNewSession` (`modules/chat/chat/chat_session.ts`). Wszystkie trzy warianty
 * (`archive`/`archive_new`/`archive_close`) mają zgasić `SessionWriteConsent` dla sesji, która
 * WŁAŚNIE się kończy - inaczej nazwa pliku sesji (rozdzielczość MINUTOWA,
 * `AgentMemory._generateActiveSessionFilename`) mogłaby zostać reużyta w tej samej minucie i
 * odziedziczyć cudzą zgodę „nie pytaj więcej" (patrz `modules/tools/CLAUDE.md`, gotcha „Zgoda na
 * zapis").
 *
 * Behawioralny, nie po źródle: `save_session.ts` importuje `obsidian`, ale harness dostarcza
 * atrapę dla AVA od 2026-09-11 (ten sam fakt, który `chat/chat_session.test.ts` już wykorzystuje)
 * - `applyPostArchiveAction` jest tu wyeksportowana WYŁĄCZNIE dla tego testu (import względny w
 * tym samym katalogu, nie przez barrel modułu).
 */
import test from 'ava';
import { applyPostArchiveAction } from './save_session.js';
import { SessionWriteConsent } from '../../../core/index.js';
import type { SaveSessionOutcome } from '../../memory/index.js';

test('applyPostArchiveAction: archive_new kasuje zgodę sesyjną dla STAREJ ścieżki, inna sesja zostaje nietknięta', async t => {
    const consent = new SessionWriteConsent();
    consent.grant('sessions/active/Jaskier_stara.md', 'Notatki/a.md');
    consent.grant('sessions/active/Inna_sesja.md', 'Notatki/b.md');

    const activeTab = {
        isActive: true,
        sessionPath: 'sessions/active/Jaskier_stara.md' as string | null | undefined,
        sessionId: undefined as string | undefined,
        sessionName: undefined as string | undefined,
        sessionLabel: undefined as string | undefined,
    };

    const view = {
        chatTabs: [activeTab],
        rollingWindow: { messages: [] },
        tokenTracker: { clear: () => {} },
        _createRollingWindow: () => ({ messages: [] }),
        render_messages: () => {},
        add_welcome_message: () => {},
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
        _tabBarContainer: null,
        _renderTabBar: () => {},
    };

    const plugin = { mcpClient: { sessionWriteConsent: consent } };

    const agentMemory = {
        agentName: 'Jaskier',
        activeSessionPath: 'sessions/active/Jaskier_stara.md',
        _persistActiveSession: async () => {},
        startActiveSession: async () => 'sessions/active/Jaskier_nowa.md',
    };

    const result = { action: 'archive_new' } as unknown as SaveSessionOutcome;

    await applyPostArchiveAction(
        view as unknown as Parameters<typeof applyPostArchiveAction>[0],
        plugin as unknown as Parameters<typeof applyPostArchiveAction>[1],
        agentMemory as unknown as Parameters<typeof applyPostArchiveAction>[2],
        result,
        'sessions/active/Jaskier_stara.md',
    );

    t.false(
        consent.has('sessions/active/Jaskier_stara.md', 'Notatki/a.md'),
        'zgoda dla sesji, która WŁAŚNIE się zarchiwizowała (archive_new), ma zniknąć',
    );
    t.true(
        consent.has('sessions/active/Inna_sesja.md', 'Notatki/b.md'),
        'zgoda dla INNEJ sesji ma zostać nietknięta',
    );
    t.is(
        activeTab.sessionPath,
        'sessions/active/Jaskier_nowa.md',
        'archive_new nadal wpisuje NOWĄ ścieżkę na zakładkę - zachowanie bez zmian poza czyszczeniem zgody',
    );
});

test('applyPostArchiveAction: brak closingSessionPath (np. świeża zakładka bez sesji) - nic nie wybucha, konsola bez zgód nietknięta', async t => {
    const consent = new SessionWriteConsent();
    consent.grant('sessions/active/Inna_sesja.md', 'Notatki/b.md');

    const view = {
        chatTabs: [] as unknown[],
        rollingWindow: { messages: [] },
        tokenTracker: { clear: () => {} },
        _createRollingWindow: () => ({ messages: [] }),
        render_messages: () => {},
        add_welcome_message: () => {},
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
        _tabBarContainer: null,
        _renderTabBar: () => {},
    };
    const plugin = { mcpClient: { sessionWriteConsent: consent } };
    const agentMemory = {
        agentName: 'Jaskier',
        activeSessionPath: null,
        _persistActiveSession: async () => {},
        startActiveSession: async () => 'sessions/active/Jaskier_nowa.md',
    };
    const result = { action: 'archive_new' } as unknown as SaveSessionOutcome;

    await applyPostArchiveAction(
        view as unknown as Parameters<typeof applyPostArchiveAction>[0],
        plugin as unknown as Parameters<typeof applyPostArchiveAction>[1],
        agentMemory as unknown as Parameters<typeof applyPostArchiveAction>[2],
        result,
        null,
    );

    t.true(consent.has('sessions/active/Inna_sesja.md', 'Notatki/b.md'));
});
