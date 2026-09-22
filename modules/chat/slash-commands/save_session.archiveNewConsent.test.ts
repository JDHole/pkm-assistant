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
 *
 * Testy `archive`/`archive_close` niżej pilnują mutacji „czyszczenie zgody zaszyte tylko w
 * gałęzi `archive_new`" - `closingSessionPath` jest gaszone JEDNYM wołaniem na wejściu funkcji,
 * PRZED odczytem `action`, więc powinno działać identycznie dla wszystkich trzech gałęzi; test
 * tylko na `archive_new` tej symetrii nie łapał.
 */
import test from 'ava';
import { applyPostArchiveAction, runSaveSessionFlow } from './save_session.js';
import { SessionWriteConsent } from '../../../core/index.js';
import { SaveSessionWorkflow } from '../../memory/index.js';
import type { SaveSessionOutcome, SaveSessionPrep } from '../../memory/index.js';
import { SaveSessionModal } from '../SaveSessionModal.js';

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

test('applyPostArchiveAction: plain archive (bez sufiksu) TEŻ kasuje zgodę sesyjną dla STAREJ ścieżki', async t => {
    const consent = new SessionWriteConsent();
    consent.grant('sessions/active/Jaskier_stara.md', 'Notatki/a.md');
    consent.grant('sessions/active/Inna_sesja.md', 'Notatki/b.md');

    const activeTab = {
        isActive: true,
        sessionPath: 'sessions/active/Jaskier_stara.md' as string | null | undefined,
        sessionId: 'sessions/active/Jaskier_stara.md' as string | undefined,
        sessionName: 'Jaskier_stara.md' as string | undefined,
        sessionLabel: 'Jaskier · stara' as string | undefined,
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
    const result = { action: 'archive' } as unknown as SaveSessionOutcome;

    await applyPostArchiveAction(
        view as unknown as Parameters<typeof applyPostArchiveAction>[0],
        plugin as unknown as Parameters<typeof applyPostArchiveAction>[1],
        agentMemory as unknown as Parameters<typeof applyPostArchiveAction>[2],
        result,
        'sessions/active/Jaskier_stara.md',
    );

    t.false(
        consent.has('sessions/active/Jaskier_stara.md', 'Notatki/a.md'),
        'zgoda dla sesji zarchiwizowanej PLAIN `archive` (bez sufiksu) ma zniknąć - mutacja "czyszczenie tylko przy archive_new" ma tu paść',
    );
    t.true(
        consent.has('sessions/active/Inna_sesja.md', 'Notatki/b.md'),
        'zgoda dla INNEJ sesji ma zostać nietknięta',
    );
    t.is(activeTab.sessionPath, null, 'plain archive czyści sessionPath zakładki (nowa sesja powstaje leniwie)');
    t.is(activeTab.sessionId, undefined);
    t.is(activeTab.sessionName, undefined);
    t.is(activeTab.sessionLabel, undefined);
});

test('applyPostArchiveAction: archive_close TEŻ kasuje zgodę sesyjną dla STAREJ ścieżki', async t => {
    const consent = new SessionWriteConsent();
    consent.grant('sessions/active/Jaskier_stara.md', 'Notatki/a.md');
    consent.grant('sessions/active/Inna_sesja.md', 'Notatki/b.md');

    const activeTab = { isActive: true, sessionPath: 'sessions/active/Jaskier_stara.md', agentName: 'Jaskier' };
    const otherTab = { isActive: false, sessionPath: 'sessions/active/Inna_sesja.md', agentName: 'Jaskier' };

    const view = {
        chatTabs: [activeTab, otherTab],
        rollingWindow: { messages: [] },
        tokenTracker: { clear: () => {} },
        _createRollingWindow: () => ({ messages: [] }),
        render_messages: () => {},
        add_welcome_message: () => {},
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
        _tabBarContainer: null,
        _renderTabBar: () => {},
        _switchTab: () => {},
    };
    const plugin = { mcpClient: { sessionWriteConsent: consent } };
    const agentMemory = {
        agentName: 'Jaskier',
        activeSessionPath: 'sessions/active/Jaskier_stara.md',
        _persistActiveSession: async () => {},
        startActiveSession: async () => 'sessions/active/Jaskier_nowa.md',
    };
    const result = { action: 'archive_close' } as unknown as SaveSessionOutcome;

    await applyPostArchiveAction(
        view as unknown as Parameters<typeof applyPostArchiveAction>[0],
        plugin as unknown as Parameters<typeof applyPostArchiveAction>[1],
        agentMemory as unknown as Parameters<typeof applyPostArchiveAction>[2],
        result,
        'sessions/active/Jaskier_stara.md',
    );

    t.false(
        consent.has('sessions/active/Jaskier_stara.md', 'Notatki/a.md'),
        'zgoda dla sesji zamkniętej przez archive_close ma zniknąć - mutacja "czyszczenie tylko przy archive_new" ma tu paść',
    );
    t.true(
        consent.has('sessions/active/Inna_sesja.md', 'Notatki/b.md'),
        'zgoda dla INNEJ sesji ma zostać nietknięta',
    );
    t.is(view.chatTabs.length, 1, 'archive_close realnie usuwa zakładkę z listy (skutek uboczny, nie no-op)');
    t.is(view.chatTabs[0], otherTab);
});

test('applyPostArchiveAction: brak closingSessionPath (np. świeża zakładka bez sesji) - zgoda innej sesji nietknięta, reszta funkcji i tak realnie startuje nową sesję', async t => {
    const consent = new SessionWriteConsent();
    consent.grant('sessions/active/Inna_sesja.md', 'Notatki/b.md');

    const activeTab = {
        isActive: true,
        sessionPath: undefined as string | null | undefined,
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

    t.true(consent.has('sessions/active/Inna_sesja.md', 'Notatki/b.md'), 'zgoda innej sesji nietknięta');
    // Skutek uboczny NIEZWIĄZANY ze zgodą, ale realny: `startActiveSession` musi się odpalić i
    // jego wynik musi trafić na zakładkę, tak jak przy zwykłym archive_new. Test z pustą tablicą
    // `chatTabs` (poprzednia wersja) przechodziłby identycznie przy CAŁKOWICIE pustej funkcji -
    // ta asercja wymaga, żeby funkcja faktycznie coś zrobiła.
    t.is(
        activeTab.sessionPath,
        'sessions/active/Jaskier_nowa.md',
        'mimo braku closingSessionPath, archive_new nadal wpisuje NOWĄ ścieżkę na zakładkę - pusta funkcja by tego nie zrobiła',
    );
});

// ─── `runSaveSessionFlow` (nie tylko `applyPostArchiveAction`) - `path` do wyczyszczenia zgody
// jest złapany PRZED `workflow.applyDecision()`, bo `applyDecision` (dla plain `archive`, przez
// `agentMemory.archiveActiveSession`) SAM zeruje `agentMemory.activeSessionPath`. Mutacja "odczyt
// PO applyDecision zamiast PRZED" zobaczyłaby tu już `null`/falsy i pominęłaby `clearSession`,
// zostawiając zgodę dla starej ścieżki wiszącą na zawsze. `SaveSessionWorkflow.prepareProposals`/
// `applyDecision` i `SaveSessionModal.prompt` są jedynymi trzema punktami, których
// `runSaveSessionFlow` NIE pozwala wstrzyknąć (konstruuje je sam) - `test.serial` +
// monkey-patch na prototypie + `finally` z przywróceniem oryginałów, jak reszta tego wzorca w
// repo (`chat/SessionCloseModal` w `chat_session.test.ts`). ───

test.serial('runSaveSessionFlow: plain archive - ścieżka do wyczyszczenia zgody złapana PRZED applyDecision, mimo że applyDecision sam zeruje activeSessionPath', async t => {
    const consent = new SessionWriteConsent();
    const oldPath = 'sessions/active/Jaskier_stara.md';
    consent.grant(oldPath, 'Notatki/a.md');
    consent.grant('sessions/active/Inna_sesja.md', 'Notatki/b.md');

    const origPrepareProposals = SaveSessionWorkflow.prototype.prepareProposals;
    const origApplyDecision = SaveSessionWorkflow.prototype.applyDecision;
    const origPrompt = SaveSessionModal.prototype.prompt;

    // `runSaveSessionFlow` konstruuje `SaveSessionWorkflow`/`SaveSessionModal` SAM (nie idą przez
    // `view`/`plugin`) - jedyny sposób kontroli to podmiana metod na prototypie na czas testu.
    SaveSessionWorkflow.prototype.prepareProposals = async function (): Promise<SaveSessionPrep> {
        return {
            sessionPath: oldPath,
            messages: [],
            notes: [],
            brainUpdates: [],
            llmDriven: false,
            messageCount: 0,
            usage: null,
        };
    };

    SaveSessionWorkflow.prototype.applyDecision = async function (
        this: InstanceType<typeof SaveSessionWorkflow>,
        _activeSession,
        _prep,
        decision,
    ): Promise<SaveSessionOutcome> {
        // Odwzorowuje REALNE zachowanie `agentMemory.archiveActiveSession` wołane WEWNĄTRZ
        // prawdziwego `applyDecision` dla plain `archive` - samo zeruje `activeSessionPath`
        // (patrz komentarz w `applyPostArchiveAction` w `save_session.ts`).
        (this.agentMemory as unknown as { activeSessionPath: string | null }).activeSessionPath = null;
        return {
            cancelled: false,
            action: decision?.action || 'archive',
            notesCreated: [],
            brainChanged: false,
            archivedPath: 'sessions/archive/Jaskier_stara.md',
            shouldTriggerArchive: false,
        };
    };

    // Rozstrzyga PRAWDZIWYM timerem (makrotask), nie od razu - `prepareWithCancel` ściga decyzję
    // usera z propozycją przez `Promise.race`; gdyby obie rozstrzygały się w tym samym mikrotasku,
    // kolejność byłaby przypadkowa. Timer gwarantuje, że propozycja (mikrotask, stub wyżej)
    // wygrywa zawsze, niezależnie od silnika.
    SaveSessionModal.prototype.prompt = function (): ReturnType<InstanceType<typeof SaveSessionModal>['prompt']> {
        return new Promise(resolve => {
            setTimeout(() => resolve({ action: 'archive', notes: [], brainUpdates: [] }), 5);
        });
    };

    try {
        const agentMemory = {
            agentName: 'Jaskier',
            activeSessionPath: oldPath as string | null,
            _persistActiveSession: async () => {},
            startActiveSession: async () => 'sessions/active/Jaskier_nowa.md',
        };

        const activeTab = {
            isActive: true,
            sessionPath: oldPath as string | null | undefined,
            sessionId: undefined as string | undefined,
            sessionName: undefined as string | undefined,
            sessionLabel: undefined as string | undefined,
        };

        const view = {
            app: {},
            chatTabs: [activeTab],
            rollingWindow: { messages: [{ role: 'user', content: 'cześć' }] },
            tokenTracker: { clear: () => {} },
            resetInputArea: () => {},
            _createRollingWindow: () => ({ messages: [] }),
            render_messages: () => {},
            add_welcome_message: () => {},
            updateTokenCounter: () => {},
            _updateTokenPanel: () => {},
            _tabBarContainer: null,
            _renderTabBar: () => {},
        };

        const plugin = {
            agentManager: {
                getActiveMemory: () => agentMemory,
                getActiveAgent: () => null,
            },
            settings: { pkmAssistant: {} },
            mcpClient: { sessionWriteConsent: consent },
        };

        await runSaveSessionFlow({
            view: view as unknown as Parameters<typeof runSaveSessionFlow>[0]['view'],
            plugin: plugin as unknown as Parameters<typeof runSaveSessionFlow>[0]['plugin'],
        });

        t.is(
            agentMemory.activeSessionPath,
            null,
            'kontrola: applyDecision faktycznie wyzerował activeSessionPath - potwierdza, że scenariusz mutacji ("odczyt PO applyDecision widzi null") był tu realny, nie martwy',
        );
        t.false(
            consent.has(oldPath, 'Notatki/a.md'),
            'po pełnym przebiegu runSaveSessionFlow (plain archive) zgoda dla STAREJ ścieżki ma zniknąć mimo że applyDecision już wyzerował agentMemory.activeSessionPath - dowód, że ścieżka do applyPostArchiveAction jest złapana PRZED applyDecision, nie po',
        );
        t.true(consent.has('sessions/active/Inna_sesja.md', 'Notatki/b.md'), 'zgoda innej sesji nietknięta');
    } finally {
        SaveSessionWorkflow.prototype.prepareProposals = origPrepareProposals;
        SaveSessionWorkflow.prototype.applyDecision = origApplyDecision;
        SaveSessionModal.prototype.prompt = origPrompt;
    }
});
