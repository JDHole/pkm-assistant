import { captureSessionLifecycle, requestSessionLifecycle, serializeSessionLifecycle, selectSessionLifecycle } from './sessionLifecycle.js';
import type { SessionLifecycleOwner } from './sessionLifecycle.js';
import { sendAdmission } from './sendAdmission.js';
import type { FrozenTurnOwner } from './turnOwner.js';
import { cancelMessageEdit } from './messageEdit.js';
/**
 * Session management — save, load, consolidate, rolling window creation.
 * Methods mixed into ChatView.prototype.
 */
import { Notice } from 'obsidian';
import { RollingWindow } from './RollingWindow.js';
import { IdleScheduler, sessionMessageId } from '../../memory/index.js';
import { runSaveSessionFlow } from '../slash-commands/save_session.js';
import { SessionCloseModal } from '../SessionCloseModal.js';
import { OpenSessionModal } from '../OpenSessionModal.js';
// Jedyny publiczny akt sprzątania pliku todo (`modules/tools`, publiczne drzwi) - patrz
// `handleNewSession`, gałąź `discard` (BUG C3).
import { retireTodoFile } from '../../tools/index.js';
import { log } from '../../../core/utils/Logger.js';
import { t } from '../../../core/i18n/index.js';
import { TokenTracker } from '../../../core/index.js';
import {
    buildOwnerWindowOptions,
    isFrozenTurnOwnerCurrent, publishTurnSessionIdentity, resolveOwnerAgentName,
    resolveOwnerMemory,
} from './turnOwner.js';
// `_agentStates` MUSI być kluczowana dokładnie tym, co liczy `_switchTab` - inaczej wynik
// suba / cleanup tury trafia do złej zakładki. `_tabKey` jest eksportowany DOKŁADNIE po to,
// żeby nie było czwartego miejsca przepisującego
// `sessionId || sessionPath || sessionName || agentName` ręcznie.
import { _tabKey } from './chat_tabs.js';
// Receiver mixina = ZŁOŻONY widok (`ChatViewLike`: klasa + osiem paczek mixinów).
import type { ChatViewLike } from './chatViewShape.js';
import type { AgentMemory } from '../../memory/index.js';
import type { ActiveSessionEventInput, ActiveSessionInfo } from '../../memory/index.js';

/**
 * Sesja odtworzona z dysku. Gałąź główna dostaje pełny wpis `ActiveSessionInfo`, gałąź
 * ratunkowa (`restoreActiveSession`) składa minimalny — stąd wszystko poza ścieżką opcjonalne.
 */
interface RestoredSession {
    agentName: string;
    session: { path: string; name?: string; label?: string; mtime?: number; epoch?: string | null };
    rollingWindow: RollingWindow;
    tokenTracker: TokenTracker;
    sessionEpoch: string | null;
}

/**
 * Initialize session manager — auto-save timer + restore last active session.
 * Memory v3 drops the v2 draft recovery flow: sessions live in active/ and archive/ only.
 */
export async function initSessionManager(this: ChatViewLike) {
    // Unlike beforeunload, Obsidian's graceful quit lets us contribute awaited tasks.
    this.registerEvent(this.app.workspace.on('quit', tasks => {
        this.stop_all_turns('close');
        tasks.addPromise((async () => {
            await this._waitForSendAdmissions?.();
            await this.handleSaveSession();
        })());
    }));
    // registerInterval ties the timer to the view lifecycle (Component clears it on unload),
    // same as the idle tick below — no manual field, no clearInterval in onClose.
    const autoSaveInterval = this.env?.settings?.pkmAssistant?.autoSaveInterval;
    if (autoSaveInterval && autoSaveInterval > 0) {
        this.registerInterval(window.setInterval(() => {
            if (this.rollingWindow?.messages?.length > 0 || this.rollingWindow?.removedMessageIds?.length > 0 || this.rollingWindow?.removedMessageRanges?.length > 0) {
                void this.handleSaveSession();
            }
        }, autoSaveInterval * 60 * 1000));
    }

    // Idle consolidation. Every 60s, if the session has been idle past the threshold AND has
    // new entries since the last idle save, run a lightweight handleSaveSession (mechanical
    // transcript save, no background LLM). registerInterval ties it to the view lifecycle so
    // it clears on unload.
    this._idleScheduler = new IdleScheduler({ minNewEntries: 2 });
    this._lastIdleSaveMsgCount = 0;
    this.registerInterval(window.setInterval(() => { void this._idleTick(); }, 60 * 1000));

    await this._restoreActiveSession();
}

/**
 * One idle check. Live-reads idleConsolidationMinutes (default 20, 0=off) so a Settings
 * change takes effect without reloading the view. Best-effort — never throws upward.
 */
export async function _idleTick(this: ChatViewLike) {
    try {
        if (!this._idleScheduler) return;
        const idleMinutes = this.env?.settings?.pkmAssistant?.idleConsolidationMinutes ?? 20;
        this._idleScheduler.idleMinutes = Number(idleMinutes) || 0;
        const msgCount = this.rollingWindow?.messages?.length || 0;
        const newEntries = msgCount - (this._lastIdleSaveMsgCount || 0);
        const fire = this._idleScheduler.shouldFire({
            nowMs: Date.now(),
            lastActivityMs: this.lastMessageTimestamp || null,
            newEntries
        });
        if (!fire) return;
        this._lastIdleSaveMsgCount = msgCount;
        await this.handleSaveSession();
        log.info('Chat', `Idle consolidation: saved session after ${this._idleScheduler.idleMinutes} min idle (${newEntries} new entries)`);
    } catch (e) {
        log.warn('Chat', `Idle tick failed (non-fatal): ${(e as Error)?.message || String(e)}`);
    }
}

/**
 * Memory v3: if .state.json lists an active session that loadActiveSession could not parse into
 * messages (empty/corrupted/stale), drop the pointer from state so it stops surfacing in restore
 * and /save session. The session FILE is never deleted — user can recover it manually from
 * sessions/active/ if needed.
 *
 * Earlier implementation deleted the file too. That destroyed a real session in Smoke 01 retake
 * because the parser is one corner case away from returning 0 even on a populated file. Never
 * again. State-only pruning is the safe contract.
 * @private
 */
async function _pruneEmptyActiveSessionFromState(agentMemory: AgentMemory, session: ActiveSessionInfo) {
    try {
        const path = session?.path;
        const name = session?.name || (path ? path.split('/').pop() : null);
        if (!name) return;

        if (agentMemory.stateManager?.removeActiveSession) {
            try { await agentMemory.stateManager.removeActiveSession(name); } catch { /* best-effort */ }
        }
        if (agentMemory.activeSessionPath === path) {
            agentMemory.activeSessionPath = null;
            await agentMemory._persistActiveSession?.();
        }
    } catch (e) {
        log.warn('Chat', `Prune empty active session pointer failed (non-fatal): ${(e as Error).message}`);
    }
}

/**
 * Odłóż starą sesję przy starcie nowej rozmowy (gałęzie „draft" i „odrzuć").
 *
 * Obie gałęzie NIE MOGĄ zostawić pliku w `sessions/active/` z wpisem w `.state.json` -
 * porzucona rozmowa wracałaby przy restarcie jako żywa zakładka albo wisiałaby jako
 * zombie-wpis. `AgentMemory.discardActiveSession` przenosi plik do
 * `sessions/active/.discarded/` (bez twardej kasacji - user authority) i wypisuje go
 * z ewidencji. Best-effort: pad nie może zablokować otwarcia nowej rozmowy.
 * @private
 */
async function _retireActiveSession(agentMemory: AgentMemory | null | undefined, reason: string, path: string) {
    try {
        if (!agentMemory?.discardActiveSession) return;
        const moved = await agentMemory.discardActiveSession(path);
        if (moved) log.info('Chat', `Old session retired to .discarded/ (${reason}): ${moved}`);
    } catch (e) {
        log.warn('Chat', `Retiring old session failed (non-fatal): ${(e as Error)?.message || String(e)}`);
    }
}

/**
 * Skasuj plik jednorazowego todo sesji, która właśnie odeszła do `.discarded/` (BUG C3,
 * drugi ogon). Sam plik `sessions/active/*.md` idzie do `.discarded/` przez
 * `_retireActiveSession` - `.pkm-assistant/artifacts/todo/<agent>-<sessionId>.md` żyje w
 * OSOBNYM drzewie (adapter, nie Vault API) i tamten przenos go nie dotyka.
 *
 * `sessionId` jest liczony DOKŁADNIE tak, jak `TodoTool.resolveSessionId` liczy go dla
 * wywołań narzędzia w tej sesji (basename ścieżki bez `.md`) - inny wzór dawałby złą nazwę
 * pliku i sprzątanie trafiałoby w próżnię. Best-effort: brak agenta/ścieżki albo pad
 * kasowania nie mają prawa zablokować odrzucenia sesji - user już to potwierdził w modalu.
 */
async function _retireTodoFileFor(view: ChatViewLike, agentName: string | undefined, sessionPath: string): Promise<void> {
    try {
        const adapter = view.app?.vault?.adapter;
        const sessionId = sessionPath.split('/').pop()?.replace(/\.md$/i, '');
        if (!adapter || !agentName || !sessionId) return;
        await retireTodoFile(adapter, agentName, sessionId);
    } catch (e) {
        log.warn('Chat', `Retiring todo file failed (non-fatal): ${(e as Error)?.message || String(e)}`);
    }
}

/** Jedna wiadomość odzyskana z pliku sesji — kształt `AgentMemory.loadActiveSession()`. */
type RestoredMessage = Awaited<ReturnType<AgentMemory['loadActiveSession']>>['messages'][number];

/**
 * Metadata do przekazania `RollingWindow.addMessage` przy restore z dysku.
 *
 * Bez tego `_restoreActiveSession` wołał `addMessage(role, content)` BEZ trzeciego
 * argumentu — nawet gdy plik sesji (format v3, `activeSessionFormat.ts`) niósł
 * `tool_call_id`/`tool_calls`, restore je odrzucał. Kolejna tura widziała `tool`
 * bez `tool_call_id` i `sanitizeToolTranscript` (`modules/agent-loop`) kasował go jako
 * sierotę (log `drop orphan tool message (tool_call_id="undefined")`) — KAŻDY tool
 * result sprzed restartu Obsidiana znikał z okna. Klucze są dokładane TYLKO gdy obecne
 * (`ActiveSessionMessage.toolCallId`/`toolCalls` są opcjonalne — brak w pliku legacy/v1/v2).
 */
function _restoredMessageMeta(msg: Omit<RestoredMessage, 'seq'>) {
    const meta: { sessionMessageId?: string; parentConversationText?: string; tool_call_id?: string; tool_calls?: NonNullable<RestoredMessage['toolCalls']>; _subTaskResult?: { question: NonNullable<RestoredMessage['question']> } } = {};
    meta.sessionMessageId = sessionMessageId(msg);
    if (msg.parentConversationText !== undefined) meta.parentConversationText = msg.parentConversationText;
    if (msg.toolCallId) meta.tool_call_id = msg.toolCallId;
    if (msg.toolCalls) meta.tool_calls = msg.toolCalls;
    if (msg.question) meta._subTaskResult = { question: msg.question };
    return meta;
}

/** Restoring an existing history twice keeps a history-only tab without reviving work. */
function restoreSubTaskHistory(view: ChatViewLike, parsed: Awaited<ReturnType<AgentMemory['loadActiveSession']>>, agentName: string, sessionPath: string): boolean {
    const registry = view.plugin?.subTaskRegistry;
    if (!registry) return false;
    const owner = { agentName, sessionPath, sessionEpoch: String(parsed.metadata.epoch ?? '') };
    registry.importHistory(parsed.subTaskHistory ?? [], owner);
    return registry.listThreads(owner).length > 0;
}

/** Restore the last active session from disk. */
export async function _restoreActiveSession(this: ChatViewLike): Promise<void> {
    if (!this.rollingWindow) return _restoreSessions.call(this);
    const owner = captureSessionLifecycle(this);
    return requestSessionLifecycle(owner, 'restore', async () => {
        for (const key of new Set([...(this._preparingTurns?.keys() ?? []), ...(this._streamCtxMap?.keys() ?? [])])) this.stop_generation(key, 'restore');
        await serializeSessionLifecycle(owner, () => _restoreSessions.call(this, owner));
    });
}

async function _restoreSessions(this: ChatViewLike, owner?: SessionLifecycleOwner): Promise<void> {
    const current = () => !owner || owner.current();
    const pending = [...(this._preparingTurns?.values() ?? []), ...(this._streamCtxMap?.values() ?? [])];
    if (pending.length) {
        for (const key of new Set([...(this._preparingTurns?.keys() ?? []), ...(this._streamCtxMap?.keys() ?? [])])) this.stop_generation(key, 'restore');
        await this._waitForSendAdmissions?.();
        if (!current()) return;
    }
    try {
        const agentManager = this.plugin?.agentManager;
        if (!agentManager) return;

        const agents = agentManager.getAllAgents?.() || [];
        const activeAgentName = agentManager.getActiveAgent?.()?.name || 'Jaskier';
        const restored: RestoredSession[] = [];

        for (const agent of agents) {
            const agentName = agent?.name;
            if (!agentName) continue;
            const agentMemory = agentManager.getAgentMemory?.(agentName);
            if (!agentMemory?.listActiveSessions) continue;

            const sessions = await agentMemory.listActiveSessions();
            if (!current()) return;
            for (const session of sessions) {
                let parsed = null;
                try {
                    parsed = await agentMemory.loadActiveSession(session);
                    if (!current()) return;
                } catch (e) {
                    log.warn('Chat', `Could not load active session ${session?.name}: ${(e as Error).message}`);
                }
                if (!current()) return;
                const hasHistory = parsed && restoreSubTaskHistory(this, parsed, agentName, session.path);
                if (!parsed || (!parsed.messages.length && !hasHistory)) {
                    // Memory v3: do NOT delete the underlying file. We previously called
                    // _discardEmptyActiveSession here, which destroyed a real session for the user when
                    // the parser returned 0 messages. Only prune the .state.json pointer; the file
                    // stays on disk as a recovery anchor.
                    await _pruneEmptyActiveSessionFromState(agentMemory, session);
                    if (!current()) return;
                    continue;
                }

                const rollingWindow = this._createRollingWindow(agentName);
                for (const msg of parsed.messages) {
                    await rollingWindow.addMessage(msg.role, msg.content, _restoredMessageMeta(msg));
                    if (!current()) return;
                }

                restored.push({
                    agentName,
                    session: { ...session, epoch: typeof parsed.metadata.epoch === 'string' ? parsed.metadata.epoch : null },
                    rollingWindow,
                    tokenTracker: new TokenTracker(),
                    sessionEpoch: typeof parsed.metadata.epoch === 'string' ? parsed.metadata.epoch : null,
                });
            }
        }

        if (restored.length === 0) {
            const agentMemory = agentManager.getActiveMemory?.();
            const restoredPath = await agentMemory?.restoreActiveSession?.();
            if (!current()) return;
            if (!restoredPath) return;
            // `restoreActiveSession` zwraca ścieżkę pliku z `sessions/active/`, a ten jest
            // event-logiem. `loadSession` (parser transkryptu `## User`) wyciągnąłby z niego
            // ZERO wiadomości i restore po cichu by się nie odbył - dlatego czytamy tym samym
            // czytnikiem co gałąź główna wyżej (`loadActiveSession` → `parseActiveSession`,
            // rozumie format A, B i pliki MIESZANE).
            // `restoredPath` jest niepuste tylko wtedy, gdy `agentMemory` istnieje (linia wyżej).
            const parsed = await agentMemory!.loadActiveSession(restoredPath);
            if (!current()) return;
            const hasHistory = restoreSubTaskHistory(this, parsed, activeAgentName, restoredPath);
            if (!parsed.messages.length && !hasHistory) return;

            const rollingWindow = this._createRollingWindow(activeAgentName);
            for (const msg of parsed.messages) {
                await rollingWindow.addMessage(msg.role, msg.content, _restoredMessageMeta(msg));
                if (!current()) return;
            }
            restored.push({
                agentName: activeAgentName,
                session: {
                    path: restoredPath,
                    name: restoredPath.split('/').pop(),
                    label: activeAgentName
                },
                rollingWindow,
                tokenTracker: new TokenTracker(),
                sessionEpoch: typeof parsed.metadata.epoch === 'string' ? parsed.metadata.epoch : null,
            });
        }

        restored.sort((a, b) => {
            const aActive = a.agentName === activeAgentName ? 1 : 0;
            const bActive = b.agentName === activeAgentName ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive;
            return (b.session?.mtime || 0) - (a.session?.mtime || 0);
        });

        // Restore zastępuje obiekty zakładek i okna. Najpierw przerwij tury, które
        // rozpoczęły się podczas odczytu, aby żadna nie straciła uchwytu Stopu.
        for (const key of new Set([...(this._streamCtxMap?.keys() || []), ...(this._preparingTurns?.keys() || [])])) {
            this.stop_generation(key, 'restore');
        }
        if ([...(this._preparingTurns?.values() ?? []), ...(this._streamCtxMap?.values() ?? [])]
            .some(ctx => sendAdmission(ctx.rollingWindow))) {
            await this._waitForSendAdmissions();
            if (!current()) return;
            return _restoreSessions.call(this, owner);
        }
        if (!current()) return;
        this.chatTabs = restored.map((item, index) => ({
            agentName: item.agentName,
            sessionId: item.session.path,
            sessionPath: item.session.path,
            sessionName: item.session.name,
            sessionLabel: item.session.label,
            sessionEpoch: item.sessionEpoch,
            isActive: index === 0
        }));
        this._agentStates.clear();
        restored.forEach((item, index) => {
            // `_tabKey(this.chatTabs[index])` - kanoniczny klucz, nie ręczna kopia
            // `item.session.path` (dziś równa się `sessionId`/`sessionPath` zbudowanym wyżej
            // TYLKO dlatego, że oba pola dostały tę samą wartość przy tworzeniu `chatTabs`;
            // jedna przyszła zmiana kształtu taba rozjeżdża klucz cicho, bez żadnego testu,
            // który by to złapał).
            this._agentStates.set(_tabKey(this.chatTabs[index]), {
                rollingWindow: item.rollingWindow,
                tokenTracker: item.tokenTracker,
                autonomy: this.currentAutonomy,
                scrollTop: 0,
                isGenerating: false
            });
            const memory = agentManager.getAgentMemory?.(item.agentName);
            if (memory && item.session.path) {
                memory.setActiveSessionIdentity?.(item.session.path, item.sessionEpoch);
                if (!memory.setActiveSessionIdentity) memory.activeSessionPath = item.session.path;
            }
        });

        const active = restored[0];
        agentManager.switchAgent?.(active.agentName);
        const activeMemory = agentManager.getAgentMemory?.(active.agentName);
        if (activeMemory && active.session.path) {
            activeMemory.setActiveSessionIdentity?.(active.session.path, active.sessionEpoch);
            if (!activeMemory.setActiveSessionIdentity) activeMemory.activeSessionPath = active.session.path;
        }
        this.rollingWindow = active.rollingWindow;
        this.tokenTracker = active.tokenTracker;
        void this.render_messages();
        this.updateTokenCounter();
        this._updateTokenPanel();
        if (this._tabBarContainer) this._renderTabBar(this._tabBarContainer);
        this._renderSubTaskStrip?.();
        log.info('Chat', `Restored ${restored.length} active session(s)`);
        await activeMemory?._persistActiveSession?.();
    } catch (e) {
        log.warn('Chat', `Session restore failed: ${(e as Error).message}`);
    }
}

export async function startActiveSession(this: ChatViewLike, agentName: string) {
    const agentManager = this.plugin?.agentManager;
    const owner = resolveOwnerAgentName(agentManager, agentName);
    const agentMemory = resolveOwnerMemory(agentManager, owner);
    if (!agentMemory?.startActiveSession) return null;
    // `resolveOwnerMemory` oddaje pamiec TYLKO dla znanej nazwy - w tej galezi `owner` jest stringiem.
    return agentMemory.startActiveSession(owner!);
}

/**
 * Dopisz zdarzenie tury do event-logu sesji.
 *
 * Destynacja bierze się z `event.agentName` - czyli z TURY, która to zdarzenie wyprodukowała
 * (`chat_streaming` podaje je przy każdym wywołaniu), a NIE z `getActiveMemory()`: czytanie
 * aktywnej pamięci wsypywałoby wiadomości, wywołania narzędzi i ich WYNIKI do
 * `sessions/active/` zupełnie innego agenta, gdyby user przełączył zakładkę w trakcie tury.
 */
export async function appendToActiveSession(this: ChatViewLike, event: ActiveSessionEventInput, owner?: FrozenTurnOwner) {
    return persistSendEvent.call(this, event, owner);
}

export async function saveSendMessage(this: ChatViewLike, event: ActiveSessionEventInput, owner: FrozenTurnOwner,
    messages: Parameters<AgentMemory['saveSession']>[0], changes: Parameters<AgentMemory['saveSession']>[2]) {
    return persistSendEvent.call(this, event, owner, { messages, changes });
}

async function persistSendEvent(this: ChatViewLike, event: ActiveSessionEventInput, owner?: FrozenTurnOwner,
    plan?: { messages: Parameters<AgentMemory['saveSession']>[0]; changes: Parameters<AgentMemory['saveSession']>[2] }) {
    if (owner?.memory?.createSessionWriter) {
        const memory = owner.memory;
        const writer = memory.createSessionWriter(owner.sessionPath || null, owner.sessionEpoch);
        owner.sessionWriter = writer;
        const revision = memory.sessionIdentityRevision;
        const tab = owner.tab;
        const tabPath = owner.acceptedIdentity?.path ?? tab?.sessionPath;
        const tabKey = _tabKey(tab);
        if (!isFrozenTurnOwnerCurrent(this, owner)) return null;
        const path = plan
            ? await writer.saveSession(plan.messages, {}, { ...plan.changes,
                ...(owner.sessionPath ? { expectedSession: { path: owner.sessionPath, epoch: owner.sessionEpoch } } : {}) })
            : await writer.appendToActiveSession(event);
        owner.sessionPath = path;
        owner.sessionEpoch = writer.sessionEpoch;
        if (isFrozenTurnOwnerCurrent(this, owner)) {
            if (tab) {
                if (!tab.sessionId) tab.sessionId = tabKey;
                publishTurnSessionIdentity(owner);
            }
            if ((!tab || tab.isActive) && this.rollingWindow === owner.rollingWindow && memory.sessionIdentityRevision === revision) {
                memory.setActiveSessionIdentity(path, owner.sessionEpoch);
                if (path !== tabPath) await memory._persistActiveSession();
            }
        }
        return path;
    }
    if (plan && owner?.memory?.saveSession) {
        return owner.memory.saveSession(plan.messages, {}, { ...plan.changes,
            ...(owner.sessionPath ? { expectedSession: { path: owner.sessionPath, epoch: owner.sessionEpoch } } : {}) });
    }
    if (owner?.sessionPath && owner.memory?.appendSessionEvent) {
        return owner.memory.appendSessionEvent(owner.sessionPath, event, owner.sessionEpoch);
    }
    const agentManager = this.plugin?.agentManager;
    const ownerName = resolveOwnerAgentName(agentManager, event?.agentName);
    const agentMemory = resolveOwnerMemory(agentManager, ownerName);
    if (!agentMemory?.appendToActiveSession) return null;
    return agentMemory.appendToActiveSession(event);
}

/**
 * Handle new session — save, optionally compress, reset.
 */
export async function handleNewSession(this: ChatViewLike) {
    const owner = captureSessionLifecycle(this);
    return requestSessionLifecycle(owner, 'new', async () => {
        cancelMessageEdit(owner.window);
        if (this.is_generating) this.stop_generation();
        const prepared = await serializeSessionLifecycle(owner, async () => {
            if (!await selectSessionLifecycle(this, owner) || !owner.current() || this.rollingWindow !== owner.window) return;
            const msgCount = owner.window.messages.length;
            log.info('Chat', `handleNewSession: ${msgCount} wiadomości`);
            if (msgCount || owner.window.removedMessageIds?.length || owner.window.removedMessageRanges?.length) {
                await this.handleSaveSession(owner.agentName, owner.window,
                    owner.path ? { path: owner.path, epoch: owner.epoch } : undefined);
                if (!owner.current()) return;
            }
            if (!msgCount) return { hasMessages: false, decision: Promise.resolve({ choice: 'discard' as const }) };
            const agent = this.plugin?.agentManager?.getAgent?.(owner.agentName || '');
            const modal = new SessionCloseModal(this.app, {
                agentName: owner.agentName || 'Agent', agentColor: agent?.color || '', messageCount: msgCount,
            });
            // Do not hold the queue while a dialog waits: Close can invalidate its owner.
            return { hasMessages: true, decision: modal.prompt() };
        });
        if (!prepared || !owner.current()) return;
        const { choice } = await prepared.decision || { choice: 'cancel' };
        if (!owner.current() || choice === 'cancel') return;
        await serializeSessionLifecycle(owner, async () => {
            if (!await selectSessionLifecycle(this, owner) || !owner.current() || this.rollingWindow !== owner.window) return;
            if (choice === 'archive') {
                new Notice(t('chat.session.compressing'));
                // The existing review owns every outcome; never reset again here.
                await this.consolidateSession({ resetAfterArchive: true });
                return;
            }
            const path = owner.path || '';
            if (path && prepared.hasMessages) {
                this.plugin?.subTaskRegistry?.pruneSession?.(path);
                this._renderSubTaskStrip?.();
                // Explicit path: selecting another tab during I/O must not retire its file.
                await _retireActiveSession(owner.memory, 'discard', path);
                if (!owner.current()) return;
                await _retireTodoFileFor(this, owner.agentName, path);
                if (!owner.current()) return;
            }
            if (path) {
                // Unlike closing a tab, ending a session frees its path for reuse.
                // Consent and threads must be cleared for that captured path only.
                this.plugin?.mcpClient?.sessionWriteConsent.clearSession(path);
                this.plugin?.subTaskRegistry?.closeSessionThreads?.(owner.agentName || '', path);
            }
            // Only reset the shared memory cursor when it still points to this conversation.
            if (owner.memory && (!owner.memory.activeSessionPath || owner.memory.activeSessionPath === path)
                && (!owner.tab || owner.tab.isActive)) {
                await owner.memory.startNewSession();
                if (!owner.current()) return;
            }
            const tab = owner.tab;
            const previousKey = tab ? _tabKey(tab) : undefined;
            const state = previousKey ? this._agentStates?.get(previousKey) : undefined;
            const fresh = this._createRollingWindow(owner.agentName);
            if (tab) {
                tab.sessionPath = undefined;
                tab.sessionEpoch = null;
                tab.sessionId = undefined;
                tab.sessionName = undefined;
                tab.sessionLabel = undefined;
                if (state && previousKey) {
                    this._agentStates.delete(previousKey);
                    state.rollingWindow = fresh;
                    this._agentStates.set(_tabKey(tab), state);
                }
            }
            if (!tab || tab.isActive) {
                this.rollingWindow = fresh;
                this.tokenTracker.clear();
                void this.render_messages();
                this.add_welcome_message();
                this.updateTokenCounter();
                this._updateTokenPanel();
                this._resetTodoPanelState?.();
            } else state?.tokenTracker.clear();
        });
    });
}

/**
 * Save current session.
 *
 * Wołacz z TŁA (kompresja końca tury na zakładce, której user już nie ogląda) podaje agenta
 * i okno SWOJEJ tury. Bez argumentów zachowanie jest jak dotąd - bieżąca zakładka. Zapis
 * z tury w tle NIE MOŻE brać `getActiveMemory()` + `this.rollingWindow`: transkrypt agenta X
 * lądowałby w pliku sesji agenta Y.
 *
 * @param agentName - właściciel tury (opcjonalny)
 * @param rollingWindow - okno tury (opcjonalne; brak = okno bieżącej zakładki)
 */
export async function handleSaveSession(this: ChatViewLike, agentName?: string | null, rollingWindow?: RollingWindow | null, expectedSession?: { path: string; epoch: string | null }) {
    log.debug('Chat', 'handleSaveSession');
    if (!rollingWindow && !this.rollingWindow) return;
    // The default save also flushes hidden tabs, using their captured path/epoch.
    // beforeunload and view close call this same entrypoint.
    if (!rollingWindow && !agentName) {
        const active = this.chatTabs?.find(tab => tab.isActive);
        const saves = [handleSaveSession.call(this, active?.agentName, this.rollingWindow)];
        const seen = new Set([this.rollingWindow]);
        for (const tab of this.chatTabs ?? []) {
            if (tab.isActive) continue;
            const window = this._agentStates?.get(_tabKey(tab))?.rollingWindow;
            if (!window || seen.has(window) || !tab.sessionPath) continue;
            seen.add(window);
            saves.push(handleSaveSession.call(this, tab.agentName, window, { path: tab.sessionPath, epoch: tab.sessionEpoch ?? null }));
        }
        await Promise.all(saves);
        return;
    }
    const rw = rollingWindow || this.rollingWindow;
    const ownerTab = this.chatTabs?.find(tab => tab.isActive && this.rollingWindow === rw
        || this._agentStates?.get(_tabKey(tab))?.rollingWindow === rw);
    const capturedMemory = resolveOwnerMemory(this.plugin?.agentManager, agentName);
    const target = expectedSession ?? (ownerTab?.sessionPath ? { path: ownerTab.sessionPath, epoch: ownerTab.sessionEpoch ?? null }
        : capturedMemory?.activeSessionPath ? { path: capturedMemory.activeSessionPath, epoch: capturedMemory.sessionEpoch } : undefined);
    const committing = sendAdmission(rw);
    if (committing) await committing.done;
    expectedSession = ownerTab?.sessionPath && committing
        ? { path: ownerTab.sessionPath, epoch: ownerTab.sessionEpoch ?? null } : target;
    if (!rw?.messages?.length && !rw?.removedMessageIds?.length && !rw?.removedMessageRanges?.length) return;
    try {
        const agentManager = this.plugin?.agentManager;
        const ownerName = resolveOwnerAgentName(agentManager, agentName) || 'default';
        const memory = resolveOwnerMemory(agentManager, ownerName);

        const metadata = {
            created: new Date().toISOString(),
            agent: ownerName,
            tokens_used: rw.getCurrentTokenCount()
        };

        if (memory?.saveSession) {
            const removed = [...(rw.removedMessageIds ?? [])];
            const ranges = [...(rw.removedMessageRanges ?? [])];
            const savedPath = await memory.saveSession(rw.messages, metadata, { removedMessageIds: removed, removedRanges: ranges,
                ...(expectedSession ? { expectedSession } : memory.activeSessionPath ? { expectedSession: { path: memory.activeSessionPath, epoch: memory.sessionEpoch } } : {}),
            });
            const acknowledged = new Set(removed);
            rw.removedMessageRanges = (rw.removedMessageRanges ?? []).filter(range => !ranges.includes(range));
            rw.removedMessageIds = (rw.removedMessageIds ?? []).filter(id => !acknowledged.has(id));
            if (savedPath) {
                if (this.autosaveStatus) {
                    this.autosaveStatus.textContent = t('chat.session.autosave_saved', { agent: ownerName });
                    window.setTimeout(() => { if (this.autosaveStatus) this.autosaveStatus.textContent = ''; }, 2000);
                }
            }
        }
    } catch (e) {
        log.error('Chat', 'Error saving session:', e);
        if (this.autosaveStatus) this.autosaveStatus.textContent = t('chat.session.autosave_failed');
    }
}

/**
 * Load a session from disk. Modal z 3 opcjami przed loadem.
 */
export async function handleLoadSession(this: ChatViewLike, path: string) {
    log.info('Chat', `handleLoadSession: ${path}`);
    const owner = captureSessionLifecycle(this);
    return requestSessionLifecycle(owner, `load:${path}`, async () => {
        if (this.is_generating) this.stop_generation();
        try {
            const prepared = await serializeSessionLifecycle(owner, async () => {
                if (!await selectSessionLifecycle(this, owner) || !owner.current() || this.rollingWindow !== owner.window) return;
                const agentMemory = owner.memory;
                if (!agentMemory) return;
                const filename = path.split('/').pop() || path;
                const parsed = await agentMemory.loadSession(path);
                if (!owner.current() || !parsed?.messages) return;
                const agent = this.plugin?.agentManager?.getAgent?.(owner.agentName || '');
                const modal = new OpenSessionModal(this.app, {
                    agentName: owner.agentName || 'Agent', agentColor: agent?.color || '',
                    sessionTitle: filename.replace(/\.md$/, ''),
                    sessionDate: typeof parsed.metadata?.created === 'string' ? parsed.metadata.created : filename,
                });
                return { agentMemory, filename, parsed, decision: modal.prompt() };
            });
            if (!prepared || !owner.current()) return;
            const choice = await prepared.decision;
            if (!owner.current() || choice === 'cancel') return;
            const { agentMemory, filename, parsed } = prepared;
            await serializeSessionLifecycle(owner, async () => {
                if (!await selectSessionLifecycle(this, owner) || !owner.current() || this.rollingWindow !== owner.window) return;
                cancelMessageEdit(owner.window);
                await this.handleSaveSession(owner.agentName, owner.window,
                    owner.path ? { path: owner.path, epoch: owner.epoch } : undefined);
                if (!owner.current()) return;
                const loadedWindow = this._createRollingWindow(owner.agentName);
                if (choice === 'continue') {
                    // Pełen load
                    for (const msg of parsed.messages) {
                        await loadedWindow.addMessage(msg.role, msg.content, _restoredMessageMeta(msg));
                        if (!owner.current()) return;
                    }
                    new Notice(t('chat.session.loaded_full', { count: parsed.messages.length }), 4000);
                } else if (choice === 'compress') {
                    // Załaduj L1 summary który includes tę sesję — przez frontmatter `included_in: [[l1_xxx]]`
                    const summaryText = await _findCoveringL1Summary.call(this, agentMemory, filename);
                    if (!owner.current()) return;
                    if (summaryText) {
                        await loadedWindow.addMessage('system', `Kontekst poprzedniej sesji (L1 summary):\n\n${summaryText}`);
                        if (!owner.current()) return;
                        new Notice(t('chat.session.loaded_compressed'), 4000);
                    } else {
                        // Fallback: brak L1 jeszcze (sesja niezaczęta przez consolidateLevel1) — załaduj summary z pliku jeśli jest
                        const fallback = parsed.summary || `${parsed.messages.length} wiadomości - pełen kontekst niedostępny w skompresowanej formie.`;
                        await loadedWindow.addMessage('system', `Kontekst poprzedniej sesji:\n\n${fallback}`);
                        if (!owner.current()) return;
                        new Notice(t('chat.session.compressed_fallback'), 4000);
                    }
                } else if (choice === 'fresh') {
                    // Brain + ostatnie 3 L1 jako kontekst, fresh start
                    const fresh = await _buildFreshAgentContext.call(this, agentMemory);
                    if (!owner.current()) return;
                    if (fresh) {
                        await loadedWindow.addMessage('system', fresh);
                        if (!owner.current()) return;
                    }
                    new Notice(t('chat.session.loaded_fresh'), 4000);
                }

                if (!owner.current()) return;
                if (owner.tab && !owner.tab.isActive) {
                    const state = this._agentStates.get(_tabKey(owner.tab));
                    if (state) state.rollingWindow = loadedWindow;
                    return;
                }
                this.rollingWindow = loadedWindow;
                void this.render_messages();
                this.updateTokenCounter();
                this._updateTokenPanel?.();
            });
        } catch (e) {
            log.error('Chat', 'Error loading session:', e);
        }
    });
}

/**
 * Znajdź L1 summary który includes sesję.
 * Wykorzystuje frontmatter `sessions:` w L1 (cascade contract).
 */
async function _findCoveringL1Summary(agentMemory: AgentMemory, sessionFilename: string) {
    try {
        const listed = await agentMemory.vault.adapter.list(agentMemory.paths.l1);
        for (const filePath of listed?.files || []) {
            if (!filePath.endsWith('.md')) continue;
            try {
                const content = await agentMemory.vault.adapter.read(filePath);
                const fm = agentMemory._parseFrontmatter(content);
                const sessions = Array.isArray(fm.sessions) ? fm.sessions : [];
                if (sessions.includes(sessionFilename)) {
                    // Strip frontmatter, return body
                    return content.replace(/^---[\s\S]*?---\n*/, '').trim();
                }
            } catch { /* skip */ }
        }
    } catch { /* L1 folder doesn't exist yet */ }
    return null;
}

/**
 * Zbuduj fresh agent context — brain + ostatnie 3 L1 summaries.
 */
async function _buildFreshAgentContext(agentMemory: AgentMemory) {
    const parts = [];
    try {
        const brain = await agentMemory.getBrain();
        if (brain && brain.trim()) {
            parts.push(`PAMIĘĆ DŁUGOTERMINOWA AGENTA:\n${brain.trim()}`);
        }
    } catch { /* no brain */ }
    try {
        const l1s = await agentMemory.vault.adapter.list(agentMemory.paths.l1);
        const l1Files = (l1s?.files || []).filter((f: string) => f.endsWith('.md')).sort().reverse().slice(0, 3);
        if (l1Files.length > 0) {
            const summaries = [];
            for (const path of l1Files) {
                try {
                    const content = await agentMemory.vault.adapter.read(path);
                    const body = content.replace(/^---[\s\S]*?---\n*/, '').trim();
                    summaries.push(`### ${path.split('/').pop()}\n${body}`);
                } catch { /* skip */ }
            }
            if (summaries.length > 0) {
                parts.push(`OSTATNIE PODSUMOWANIA (L1):\n${summaries.join('\n\n---\n\n')}`);
            }
        }
    } catch { /* no L1 yet */ }
    return parts.length > 0 ? parts.join('\n\n=====\n\n') : null;
}

/**
 * Consolidate session: reroute to the SINGLE canonical /save session flow.
 *
 * The 🧠 button, /memory command and the SessionCloseModal "archive" choice all land here →
 * SaveSessionWorkflow proposes durable brain notes → user reviews in SaveSessionModal → the
 * active session is archived → ArchiveWorkflow fires at the threshold. Kept as a ChatView
 * method so the three callers stay unchanged.
 *
 * These entry points open the save-session review modal - they do not silently consolidate.
 * See modules/memory/CLAUDE.md.
 */
export async function consolidateSession(this: ChatViewLike, { resetAfterArchive = false }: { resetAfterArchive?: boolean } = {}) {
    await runSaveSessionFlow({ view: this, plugin: this.plugin, resetAfterArchive });
}

/**
 * Creates a RollingWindow with optional Summarizer.
 */
export function _createRollingWindow(this: ChatViewLike, agentName?: string | null) {
    const maxTokens = this.env?.settings?.pkmAssistant?.maxContextTokens || 100000;
    const threshold = this.env?.settings?.pkmAssistant?.summarizationThreshold || 0.9;
    const toolTrimThreshold = this.env?.settings?.pkmAssistant?.toolTrimThreshold || 0.7;
    log.debug('RollingWindow', `Init: maxTokens=${maxTokens}, threshold=${threshold}, toolTrim=${toolTrimThreshold}, trigger=${Math.round(maxTokens * threshold)}`);
    // Okno należy do KONKRETNEJ zakładki i jej agenta. Nazwę zamrażamy TU, przy zakładaniu
    // okna, a providery (prompt kompresji, model, indeks pamięci, ratunek pamięci) rozwiązują
    // się po niej - nie po globalnym `activeAgent` w chwili kompresji. Kompresja końca tury
    // leci także dla zakładek W TLE (chat_streaming: „Background tab finished").
    const ownerAgentName = resolveOwnerAgentName(this.plugin?.agentManager, agentName);
    // Tożsamość okna przetrwa zmianę sessionPath/sessionId w tej samej zakładce i odróżnia
    // dwie rozmowy tego samego agenta. Callbacki są wywoływane dopiero po konstrukcji okna.
    const isOwnerActive = () => this.rollingWindow === rollingWindow;
    const rollingWindow: RollingWindow = new RollingWindow({
        maxTokens,
        triggerThreshold: threshold,
        toolTrimThreshold,
        // Kompresja LECI bezwarunkowo także dla zakładki w tle - ale to zasada o DANYCH
        // (transkrypt, sesja), nie o DOM-ie. `messages_container` jest JEDEN na cały widok,
        // więc bez tej bramki blok „skompresowano" agenta A malowałby się fizycznie w
        // rozmowie agenta B, którą user akurat czyta (z licznikami z okna A).
        onSummarized: (summary, count, messagesKept, isEmergency) => {
            if (!isOwnerActive()) return;
            this._renderCompressionBlock(summary, count, messagesKept, isEmergency);
            this._updateTokenPanel();
        },
        onToolsTrimmed: (info) => {
            log.info('Chat', `Faza 1: skrócono ${info.trimmed} wyników narzędzi (łącznie: ${info.totalTrimmed})`);
            if (!isOwnerActive()) return;
            this._renderTrimBlock(info);
            this._updateTokenPanel();
        },
        // Dedup context + durable-memory rescue. chat_session owns AgentMemory access;
        // RollingWindow only calls these providers (kierunek zależności jak dziś).
        // Szkielet kompresji (agent>global>factory) też jest w tej paczce.
        ...buildOwnerWindowOptions(this, ownerAgentName, isOwnerActive),
    });
    return rollingWindow;
}

/**
 * Build emergency task context for summarization.
 */
export function _buildEmergencyTaskContext(this: ChatViewLike, agentName?: string | null) {
    const parts = [];

    // Ścieżka sesji do promptu awaryjnego = sesja WŁAŚCICIELA okna (inaczej kompresja
    // agenta X obiecywałaby modelowi plik sesji agenta Y).
    const sessionPath = resolveOwnerMemory(this.plugin?.agentManager, agentName ?? null)?.activeSessionPath;
    if (sessionPath) {
        parts.push(t('chat.session.full_saved', { path: sessionPath }));
    }

    // Emergency-kontekst listuje AKTYWNĄ listę `todo` (live-widok). Plany są artefaktami
    // w vaulcie (aktywny idzie do promptu osobno przez activeArtifactId).
    const todo = this._activeTodoState;
    if (todo?.items?.length) {
        const done = todo.items.filter((i) => i.checked || i.done).length;
        const total = todo.items.length;
        const lines = [`📋 TODO "${todo.title || t('chat.todo.panel_title')}" (${done}/${total} ${t('prompt.dt.done')}):`];
        for (const item of todo.items) {
            lines.push(`  ${(item.checked || item.done) ? '✅' : '⬜'} ${String(item.text)}`);
        }
        parts.push(lines.join('\n'));
    }

    return parts.join('\n\n');
}
