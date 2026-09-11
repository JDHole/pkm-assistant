import { Notice, type App } from 'obsidian';
import { SaveSessionWorkflow, CostLog, normalizeUsage } from '../../memory/index.js';
import type { SaveSessionOutcome, SaveSessionPrep, SessionMessageLike, StreamChatModelLike } from '../../memory/index.js';
import { SaveSessionModal } from '../SaveSessionModal.js';
import { createModelForRole } from '../../models/index.js';
import { startConsolidationRun } from '../consolidationRunner.js';
import { getLimits } from '../../../config/limits.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import type { Agent } from '../../agents/index.js';
import type { CrystalNoticeOptions } from '../../../core/index.js';
import type { ResolverAgentLike, ResolverPluginLike } from '../../models/index.js';

type ErrLike = { message?: string };

type WorkflowAgentMemory = ConstructorParameters<typeof SaveSessionWorkflow>[0];
type SaveSessionDecision = Awaited<ReturnType<SaveSessionModal['prompt']>>;
type ConsolidationAgentMemory = NonNullable<Parameters<typeof startConsolidationRun>[0]['agentMemory']>;

type AgentMemoryLike = WorkflowAgentMemory & {
    agentName: string;
    activeSessionPath?: string | null;
    vault: WorkflowAgentMemory['vault'] & {
        adapter: WorkflowAgentMemory['vault']['adapter'] & {
            read(path: string): Promise<string>;
        };
    };
    _persistActiveSession?(): Promise<unknown>;
    startActiveSession(agentName: string): Promise<string>;
};

interface ChatTabLike {
    isActive?: boolean;
    sessionPath?: string | null;
    sessionId?: string;
    sessionName?: string;
    sessionLabel?: string;
    agentName?: string;
}

interface RollingWindowLike {
    messages?: SessionMessageLike[];
}

interface SaveSessionView {
    app: App;
    chatTabs: ChatTabLike[];
    rollingWindow?: RollingWindowLike;
    tokenTracker?: { clear?(): void };
    resetInputArea?(): void;
    _createRollingWindow(): RollingWindowLike;
    render_messages?(): void;
    add_welcome_message?(): void;
    updateTokenCounter?(): void;
    _updateTokenPanel?(): void;
    _tabBarContainer?: HTMLElement | null;
    _renderTabBar(container: HTMLElement): void;
    _switchTab?(key: string | undefined): void;
}

interface AgentManagerLike {
    getActiveMemory?(): AgentMemoryLike | null;
    /** Pełny profil agenta — `modules/agents` jest jego właścicielem. */
    getActiveAgent?(): Agent | null;
}

interface PkmAssistantSettings extends Record<string, unknown> {
    limits?: Record<string, unknown>;
}

interface SaveSessionPlugin {
    agentManager?: AgentManagerLike;
    settings?: { pkmAssistant?: PkmAssistantSettings };
    env?: NonNullable<ResolverPluginLike>['env'];
    showCrystalNotice?(message: string, options?: CrystalNoticeOptions): unknown;
}

interface SaveSessionCommandContext {
    view: SaveSessionView;
    plugin: SaveSessionPlugin;
}

interface SaveSessionCommand {
    name: string;
    description: string;
    handler(context: SaveSessionCommandContext): Promise<void>;
}

interface ActiveSessionLike {
    path: string | null | undefined;
    messages: SessionMessageLike[];
    agentName: string;
    artifacts: SessionArtifactLike[];
}

interface SessionArtifactLike {
    title?: string;
    content?: string;
}

interface PrepareWithCancelOptions {
    workflow: SaveSessionWorkflow;
    activeSession: ActiveSessionLike;
    modal: SaveSessionModal;
    decisionPromise: Promise<SaveSessionDecision>;
    plugin: SaveSessionPlugin;
}

type PrepareWithCancelResult =
    | { cancelled: true }
    | { cancelled: false; prep: SaveSessionPrep };

interface ModelCostMetadata {
    modelKey?: string;
    modelId?: string;
    model_name?: string;
}

interface LogSaveSessionCostOptions {
    agentMemory: AgentMemoryLike;
    agentName: string;
    model: ModelCostMetadata | null;
    usage: unknown;
}

export function createSaveSessionCommand(): SaveSessionCommand {
    return {
        name: '/save session',
        description: 'Archive the current Memory v3 live session.',
        handler: runSaveSessionFlow
    };
}

/**
 * The canonical Memory v3 save/consolidation flow: LLM proposes brain notes → user reviews in
 * SaveSessionModal → archive the active session → maybe trigger ArchiveWorkflow at threshold.
 *
 * This is the SINGLE consolidation path. It is the `/save session` slash handler AND the
 * target that chat_session.consolidateSession() (🧠 button, /memory, SessionCloseModal "archive")
 * reroutes to.
 * @param {{view: Object, plugin: Object}} ctx
 */
export async function runSaveSessionFlow({ view, plugin }: SaveSessionCommandContext): Promise<void> {
    const agentManager = plugin?.agentManager;
    const agentMemory = agentManager?.getActiveMemory?.();
    if (!agentMemory) {
        new Notice(t('chat.session.no_active_agent') || 'Brak aktywnego agenta', 3000);
        return;
    }

    const activeTab = view.chatTabs?.find((tab: ChatTabLike) => tab.isActive);
    const path = activeTab?.sessionPath || agentMemory.activeSessionPath;
    const messages = view.rollingWindow?.messages || [];
    if (messages.length === 0) {
        new Notice(t('modal.save_session.empty') || 'Brak aktywnej sesji do archiwizacji', 3000);
        view.resetInputArea?.();
        return;
    }

    // TS-boundary: `modules/models` czyta agenta własnym, węższym kontraktem
    // (`ResolverAgentLike`) — to samo zawężenie co w `chat/chat_model.ts`.
    const activeAgent = (agentManager!.getActiveAgent?.() || null) as ResolverAgentLike;
    // Memory v3 LLM proposal: hand the workflow the agent + main-role model so it can run
    // save_session_prompt against transcript+brain.md. Both may be null on cold startup —
    // workflow falls back to regex proposeNotes() in that case (graceful degradation).
    let mainModel = null;
    // /save session (i jego dwaj wolacze - guzik konsolidacji 🧠 oraz SessionCloseModal
    // "archive") to operacja W TLE wzgledem aktywnej tury czatu tego samego agenta - nie jest
    // zarejestrowana w StreamingManager jako stream, wiec shouldUseFreshModel(localTurns, globalActiveStreams)
    // nie ma tu czego policzyc bez dorabiania nowego licznika. Ta sama semantyka co
    // profile_memory._runArchiveWorkflow: zawsze callerSkipCache=true. Koszt to jedna
    // konstrukcja adaptera na wywolanie flow (nie per request do API), za to zero ryzyka
    // dzielenia instancji z aktywna tura czatu w trakcie jej stream().
    try {
        mainModel = createModelForRole(plugin, 'main', activeAgent, null, true);
    } catch {
        // Model factory may throw when no API key is configured — fall back to regex.
        mainModel = null;
    }

    // BEZ `archiveWorkflow` — `applyDecision` zwraca `shouldTriggerArchive`, a przebieg
    // odpalamy przez `startConsolidationRun`: nieblokujący, z modalem przebiegu i paskiem statusu.
    // Istnieje jedna droga konsolidacji.
    const workflow = new SaveSessionWorkflow(agentMemory, {
        app: view.app,
        settings: plugin?.settings?.pkmAssistant || {},
        agent: activeAgent,
        model: mainModel as unknown as StreamChatModelLike | null,
    });

    const activeSession = {
        path,
        messages,
        agentName: activeAgent?.name || agentMemory.agentName,
        artifacts: collectSessionArtifacts(plugin, messages)
    };

    // UX: modal otwiera się NATYCHMIAST w stanie loading, propozycje dolatują potem.
    const modal = new SaveSessionModal(view.app, {
        state: 'loading',
        agentName: activeSession.agentName,
        messageCount: messages.length
    });
    const decisionPromise = modal.prompt();

    // „Anuluj" anuluje — wyścig decyzji usera ze strzałem do modelu + AbortSignal.
    const prepared = await prepareWithCancel({ workflow, activeSession, modal, decisionPromise, plugin });
    if (prepared.cancelled) {
        view.resetInputArea?.();
        return;
    }

    const prep = prepared.prep;
    // Koszt strzału propozycji księgujemy TU, zaraz po udanej analizie — tokeny spaliły się
    // niezależnie od tego, czy user zatwierdzi notatki, czy kliknie „Anuluj" w oknie przeglądu.
    // Jedno wywołanie LLM = jeden wpis, więc (inaczej niż w konsolidacji) nie ma delty do liczenia.
    logSaveSessionCost({ agentMemory, agentName: activeSession.agentName, model: mainModel, usage: prep.usage });
    modal.setProposals({
        agentName: activeSession.agentName,
        messageCount: messages.length,
        notes: prep.notes,
        brainUpdates: prep.brainUpdates,
        llmDriven: prep.llmDriven
    });

    const decision = await decisionPromise;
    const result = await workflow.applyDecision(activeSession, prep, decision);

    if (result.cancelled) {
        view.resetInputArea?.();
        return;
    }

    await applyPostArchiveAction(view, agentMemory, result);
    // `applyDecision` (modules/memory) nie przerywa się na padzie
    // jednej notatki — reszta pętli (rebuildBrainIndex, archiveActiveSession) dochodzi do końca,
    // a padnięte pozycje wracają w `result.noteFailures`. Bezwarunkowy Notice „gotowe" zamieniałby
    // tę widoczną awarię w CICHĄ utratę notatki, którą user właśnie zatwierdził w modalu — więc
    // niepusta lista dostaje WŁASNY, dłuższy Notice zamiast wspólnego „done".
    if (result.noteFailures && result.noteFailures.length > 0) {
        const names = result.noteFailures.map(f => f.name || '(bez nazwy)').join(', ');
        new Notice(t('modal.save_session.notes_failed', { count: result.noteFailures.length, names }), 8000);
    } else {
        new Notice(t('modal.save_session.done'), 4000);
    }
    if (result.shouldTriggerArchive) {
        // Zamiast notice'a „Czas na konsolidację pamięci" PO cichej kaskadzie — realny
        // przebieg z modalem, paskiem statusu i notice'em startowym PRZED pierwszym strzałem.
        startConsolidationRun({
            plugin,
            app: view.app,
            agentMemory: agentMemory as unknown as ConsolidationAgentMemory,
            agent: activeAgent,
            model: mainModel,
            settings: plugin?.settings?.pkmAssistant || {},
            // Trigger automatyczny (próg / idle-scheduler). Pusty plan = cisza, nie notice
            // po każdym zapisie sesji.
            source: 'auto',
        }).catch((e: unknown) => {
            log.error('SaveSession', `Start konsolidacji padł: ${(e as ErrLike)?.message || (e as string)}`);
            new Notice(t('memory.consolidation.notice_error', { reason: (e as ErrLike)?.message || String(e) }), 6000);
        });
    }
    view.resetInputArea?.();
}

/**
 * Faza propozycji z DZIAŁAJĄCYM anulowaniem.
 *
 * Bez tego klik „Anuluj" zamykałby tylko okno, a strzał do modelu leciałby dalej w tle i po
 * minucie kończyłby się w próżni. Decyzja usera ściga się ze strzałem, a przegrany strzał
 * dostaje `abort()` tą samą drogą, co Stop w czacie. Pad/zwis nie spada po cichu na regexy —
 * modal pokazuje przyczynę i guzik „Ponów analizę".
 *
 * @returns {Promise<{cancelled: boolean, prep?: Object}>}
 */
async function prepareWithCancel({ workflow, activeSession, modal, decisionPromise, plugin }: PrepareWithCancelOptions): Promise<PrepareWithCancelResult> {
    const stallTimeoutMs = getLimits(plugin?.settings || {}).chat_stream_stall_timeout_ms;
    const cancelled = decisionPromise.then(() => ({ type: 'cancelled' as const }));

    for (;;) {
        const controller = new AbortController();
        const attempt = workflow.prepareProposals(activeSession, {
            onChunk: () => modal.noteChunk(),
            signal: controller.signal,
            watchdog: stallTimeoutMs > 0 ? { timeoutMs: stallTimeoutMs } : undefined,
        });

        const outcome = await Promise.race([
            cancelled,
            attempt.then((prep: SaveSessionPrep) => ({ type: 'prep' as const, prep }), (error: unknown) => ({ type: 'error' as const, error })),
        ]);

        if (outcome.type === 'prep') return { cancelled: false, prep: outcome.prep };
        if (outcome.type === 'cancelled') {
            controller.abort(); // strzał w locie kończy się natychmiast, nie mieli w tle
            return { cancelled: true };
        }

        // Pad albo zwis: zostajemy w oknie, user decyduje — „Ponów analizę" albo „Anuluj".
        log.warn('SaveSession', `Analiza sesji padła: ${(outcome.error as ErrLike)?.message || String(outcome.error)}`);
        const retry = modal.awaitRetry((outcome.error as ErrLike)?.message || String(outcome.error));
        const next = await Promise.race([cancelled, retry.then(() => ({ type: 'retry' as const }))]);
        if (next.type === 'cancelled') return { cancelled: true };
    }
}

/**
 * Wpis kosztu za JEDEN strzał propozycji `/save session`.
 *
 * `CostLog` obejmuje też ten strzał (nie tylko konsolidację pamięci, `memory-consolidation`) —
 * bez tego modal kosztów milczałby o wywołaniu LLM, które leci przy KAŻDYM zapisie sesji. Ścieżka
 * regexowa (brak modelu / awaria) nie ma `usage` → nie ma czego księgować, wychodzimy cicho.
 * Zapis jest best-effort: `CostLog.append` sam nie rzuca, a my dodatkowo nie czekamy na dysk
 * (dziennik kosztów nie może opóźniać okna).
 */
function logSaveSessionCost({ agentMemory, agentName, model, usage }: LogSaveSessionCostOptions): void {
    const totals = normalizeUsage(usage);
    if (!totals || (totals.inputTokens === 0 && totals.outputTokens === 0)) return;
    new CostLog(agentMemory.vault).append({
        agent: agentName || agentMemory.agentName,
        role: 'save-session',
        model: model?.modelKey || model?.modelId || model?.model_name || 'unknown',
        input_tokens: totals.inputTokens,
        output_tokens: totals.outputTokens,
        cached_tokens: totals.cachedTokens,
    }).catch((e: unknown) => log.warn('SaveSession', `CostLog append padło: ${(e as ErrLike)?.message || String(e)}`));
}

function collectSessionArtifacts(_plugin: SaveSessionPlugin, _messages: SessionMessageLike[]): SessionArtifactLike[] {
    // Nie ma czego zbierać. Artefakty żywe są własnymi notatkami w vaulcie (nie „kontekstem sesji"), a
    // todo to jednorazówka. Propozycje pamięci z transkryptu ("pamiętaj że X") idą przez
    // SaveSessionWorkflow.proposeNotes — to jedyne źródło, któremu ufamy.
    return [];
}

async function applyPostArchiveAction(view: SaveSessionView, agentMemory: AgentMemoryLike, result: SaveSessionOutcome): Promise<void> {
    const action = result.action || 'archive';
    const activeTab = view.chatTabs?.find((tab: ChatTabLike) => tab.isActive);

    if (action === 'archive_new') {
        agentMemory.activeSessionPath = null;
        await agentMemory._persistActiveSession?.();
        const newPath = await agentMemory.startActiveSession(agentMemory.agentName);
        if (activeTab) {
            activeTab.sessionPath = newPath;
            activeTab.sessionId = newPath;
            activeTab.sessionName = newPath.split('/').pop();
            activeTab.sessionLabel = `${agentMemory.agentName} · nowa sesja`;
        }
        resetVisibleChat(view);
        return;
    }

    if (action === 'archive_close') {
        closeArchivedTab(view);
        return;
    }

    // Akcja plain `archive` (bez `_new`/`_close`, czyli TAKŻE `result.action` domyślny).
    // `SaveSessionWorkflow.applyDecision` woła
    // `agentMemory.archiveActiveSession(sessionPath)` bezwarunkowo, DLA KAŻDEJ akcji — a
    // `AgentMemory.archiveActiveSession` zeruje `agentMemory.activeSessionPath` sam, gdy
    // archiwizowana ścieżka zgadza się z aktywną (AgentMemory.ts, `archiveActiveSession`).
    // Bez czyszczenia `activeTab.sessionPath` na zakładce, `_switchTab` (chat_tabs.ts), który
    // czyta `targetTab.sessionPath`, przy KAŻDYM powrocie na tę zakładkę WPISYWAŁBY tę wiszącą
    // ścieżkę z powrotem do `memory.activeSessionPath` — sesja "zmartwychwstawałaby" jako
    // wskaźnik na plik, którego już nie ma (przenosiny do sessions/archive/, przy odczycie
    // 'missing'). Czyścimy te same cztery pola co
    // `archive_new` wyżej, ale BEZ wpisywania nowej wartości — nowa sesja ma powstać
    // leniwie, przy pierwszym kolejnym zdarzeniu (dokładnie jak dla świeżej zakładki
    // w `chat_tabs._initTabs`, która też startuje bez `sessionPath`). Tożsamość zakładki
    // (`chat_tabs._tabKey`) spada z powrotem na `agentName`.
    if (activeTab) {
        activeTab.sessionPath = null;
        activeTab.sessionId = undefined;
        activeTab.sessionName = undefined;
        activeTab.sessionLabel = undefined;
    }
}

function resetVisibleChat(view: SaveSessionView): void {
    view.rollingWindow = view._createRollingWindow();
    view.tokenTracker?.clear?.();
    view.render_messages?.();
    view.add_welcome_message?.();
    view.updateTokenCounter?.();
    view._updateTokenPanel?.();
    if (view._tabBarContainer) view._renderTabBar(view._tabBarContainer);
}

function closeArchivedTab(view: SaveSessionView): void {
    const activeIndex = view.chatTabs?.findIndex((tab: ChatTabLike) => tab.isActive) ?? -1;
    if (activeIndex < 0) return;
    view.chatTabs.splice(activeIndex, 1);
    if (view.chatTabs.length === 0) {
        resetVisibleChat(view);
        return;
    }
    const next = view.chatTabs[Math.min(activeIndex, view.chatTabs.length - 1)];
    view._switchTab?.(next.sessionId || next.agentName);
}
