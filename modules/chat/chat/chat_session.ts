/**
 * Session management — save, load, consolidate, rolling window creation.
 * Methods mixed into ChatView.prototype.
 */
import { Notice } from 'obsidian';
import { RollingWindow } from './RollingWindow.js';
import { IdleScheduler } from '../../memory/index.js';
import { runSaveSessionFlow } from '../slash-commands/save_session.js';
import { SessionCloseModal } from '../SessionCloseModal.js';
import { OpenSessionModal } from '../OpenSessionModal.js';
import { log } from '../../../core/utils/Logger.js';
import { t } from '../../../core/i18n/index.js';
import { TokenTracker } from '../../../core/index.js';
import {
    buildOwnerWindowOptions,
    isOwnerTabActive,
    resolveOwnerAgentName,
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

/** Wybór z modalu zamknięcia sesji (`SessionCloseModal.prompt`). */
type SessionCloseChoice = { choice?: string };

/**
 * Sesja odtworzona z dysku. Gałąź główna dostaje pełny wpis `ActiveSessionInfo`, gałąź
 * ratunkowa (`restoreActiveSession`) składa minimalny — stąd wszystko poza ścieżką opcjonalne.
 */
interface RestoredSession {
    agentName: string;
    session: { path: string; name?: string; label?: string; mtime?: number };
    rollingWindow: RollingWindow;
    tokenTracker: TokenTracker;
}

/**
 * Initialize session manager — auto-save timer + restore last active session.
 * Memory v3 drops the v2 draft recovery flow: sessions live in active/ and archive/ only.
 */
export async function initSessionManager(this: ChatViewLike) {
    // registerInterval ties the timer to the view lifecycle (Component clears it on unload),
    // same as the idle tick below — no manual field, no clearInterval in onClose.
    const autoSaveInterval = this.env?.settings?.pkmAssistant?.autoSaveInterval;
    if (autoSaveInterval && autoSaveInterval > 0) {
        this.registerInterval(window.setInterval(() => {
            if (this.rollingWindow?.messages?.length > 0) {
                this.handleSaveSession();
            }
        }, autoSaveInterval * 60 * 1000));
    }

    // Idle consolidation. Every 60s, if the session has been idle past the threshold AND has
    // new entries since the last idle save, run a lightweight handleSaveSession (mechanical
    // transcript save, no background LLM). registerInterval ties it to the view lifecycle so
    // it clears on unload.
    this._idleScheduler = new IdleScheduler({ minNewEntries: 2 });
    this._lastIdleSaveMsgCount = 0;
    this.registerInterval(window.setInterval(() => { this._idleTick(); }, 60 * 1000));

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
        log.warn('Chat', `Idle tick failed (non-fatal): ${(e as Error)?.message || (e as string)}`);
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
async function _retireActiveSession(agentMemory: AgentMemory | null | undefined, reason: string) {
    try {
        if (!agentMemory?.discardActiveSession) return;
        const moved = await agentMemory.discardActiveSession();
        if (moved) log.info('Chat', `Old session retired to .discarded/ (${reason}): ${moved}`);
    } catch (e) {
        log.warn('Chat', `Retiring old session failed (non-fatal): ${(e as Error)?.message || (e as string)}`);
    }
}

/**
 * Restore the last active session from disk.
 */
export async function _restoreActiveSession(this: ChatViewLike) {
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
            for (const session of sessions) {
                let parsed = null;
                try {
                    parsed = await agentMemory.loadActiveSession(session);
                } catch (e) {
                    log.warn('Chat', `Could not load active session ${session?.name}: ${(e as Error).message}`);
                }
                if (!parsed?.messages?.length) {
                    // Memory v3: do NOT delete the underlying file. We previously called
                    // _discardEmptyActiveSession here, which destroyed a real session for the user when
                    // the parser returned 0 messages. Only prune the .state.json pointer; the file
                    // stays on disk as a recovery anchor.
                    await _pruneEmptyActiveSessionFromState(agentMemory, session);
                    continue;
                }

                const rollingWindow = this._createRollingWindow(agentName);
                for (const msg of parsed.messages) {
                    await rollingWindow.addMessage(msg.role, msg.content);
                }

                restored.push({
                    agentName,
                    session,
                    rollingWindow,
                    tokenTracker: new TokenTracker()
                });
            }
        }

        if (restored.length === 0) {
            const agentMemory = agentManager.getActiveMemory?.();
            const restoredPath = await agentMemory?.restoreActiveSession?.();
            if (!restoredPath) return;
            // `restoreActiveSession` zwraca ścieżkę pliku z `sessions/active/`, a ten jest
            // event-logiem. `loadSession` (parser transkryptu `## User`) wyciągnąłby z niego
            // ZERO wiadomości i restore po cichu by się nie odbył - dlatego czytamy tym samym
            // czytnikiem co gałąź główna wyżej (`loadActiveSession` → `parseActiveSession`,
            // rozumie format A, B i pliki MIESZANE).
            // `restoredPath` jest niepuste tylko wtedy, gdy `agentMemory` istnieje (linia wyżej).
            const parsed = await agentMemory!.loadActiveSession(restoredPath);
            if (!parsed?.messages?.length) return;

            const rollingWindow = this._createRollingWindow(activeAgentName);
            for (const msg of parsed.messages) {
                await rollingWindow.addMessage(msg.role, msg.content);
            }
            restored.push({
                agentName: activeAgentName,
                session: {
                    path: restoredPath,
                    name: restoredPath.split('/').pop(),
                    label: activeAgentName
                },
                rollingWindow,
                tokenTracker: new TokenTracker()
            });
        }

        restored.sort((a, b) => {
            const aActive = a.agentName === activeAgentName ? 1 : 0;
            const bActive = b.agentName === activeAgentName ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive;
            return (b.session?.mtime || 0) - (a.session?.mtime || 0);
        });

        this.chatTabs = restored.map((item, index) => ({
            agentName: item.agentName,
            sessionId: item.session.path,
            sessionPath: item.session.path,
            sessionName: item.session.name,
            sessionLabel: item.session.label,
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
            if (memory && item.session.path) memory.activeSessionPath = item.session.path;
        });

        const active = restored[0];
        agentManager.switchAgent?.(active.agentName);
        const activeMemory = agentManager.getAgentMemory?.(active.agentName);
        if (activeMemory && active.session.path) {
            activeMemory.activeSessionPath = active.session.path;
            await activeMemory._persistActiveSession?.();
        }
        this.rollingWindow = active.rollingWindow;
        this.tokenTracker = active.tokenTracker;
        this.render_messages();
        this.updateTokenCounter();
        this._updateTokenPanel();
        if (this._tabBarContainer) this._renderTabBar(this._tabBarContainer);
        log.info('Chat', `Restored ${restored.length} active session(s)`);
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
export async function appendToActiveSession(this: ChatViewLike, event: ActiveSessionEventInput) {
    const agentManager = this.plugin?.agentManager;
    const owner = resolveOwnerAgentName(agentManager, event?.agentName);
    const agentMemory = resolveOwnerMemory(agentManager, owner);
    if (!agentMemory?.appendToActiveSession) return null;
    return agentMemory.appendToActiveSession(event);
}

/**
 * Handle new session — save, optionally compress, reset.
 */
export async function handleNewSession(this: ChatViewLike) {
    // Nowa sesja NIE może zostawić trwającej tury jako zombie. Porzucona tura wisiałaby w tle
    // z uzbrojonym watchdogiem, który strzela „po agencie" i ubijałby requesty KOLEJNEJ tury
    // tego samego agenta. Ubijamy jawnie, zanim wymienimy sesję.
    if (this.is_generating) this.stop_generation();

    const msgCount = this.rollingWindow.messages.length;
    log.info('Chat', `handleNewSession: ${msgCount} wiadomości`);

    if (msgCount > 0) {
        await this.handleSaveSession();

        const agent = this.plugin?.agentManager?.getActiveAgent();
        const modal = new SessionCloseModal(this.app, {
            agentName: agent?.name || 'Agent',
            agentColor: agent?.color || '',
            messageCount: msgCount
        });
        // prompt() returns { choice }. SessionCloseModal nie ma kanału `options` - byłby
        // strukturalnie pusty i nieczytany.
        const { choice } = await modal.prompt() as SessionCloseChoice || { choice: 'cancel' };

        if (choice === 'cancel') return;

        const agentMemoryForOpts = this.plugin?.agentManager?.getActiveMemory();

        // Biegi subów należą do SESJI - zamknięcie (archive/discard) wymiata jej zakończone
        // biegi z rejestru, żeby chipy nie przeżywały do nowej rozmowy (inaczej klucz zakładki
        // nie odróżnia starej sesji od nowej). `running` zostają.
        const closingSessionPath = agentMemoryForOpts?.activeSessionPath || '';
        if (closingSessionPath) {
            this.plugin?.subTaskRegistry?.pruneSession?.(closingSessionPath);
            this._renderSubTaskStrip?.();
        }

        if (choice === 'archive') {
            new Notice(t('chat.session.compressing'));
            await this.consolidateSession();
        } else if (choice === 'discard') {
            // Modal już potwierdził z window.confirm. Plik NIE jest kasowany — ląduje
            // w sessions/active/.discarded/ i znika z .state.json, żeby nie wisiał jako
            // zombie-wpis do najbliższego restore.
            log.info('Chat', `Session discarded by user (${msgCount} msgs)`);
            await _retireActiveSession(agentMemoryForOpts, 'discard');
        }

        // SessionCloseModal ma tylko dwie gałęzie: „archiwizuj" i „odrzuć". Nie ma checkboxa
        // createContextArtifact ani gałęzi „draft" - propozycje „Na teraz" w brain.md (żywe
        // w /save session) przejęły rolę „nie zostawiamy nic z tyłu" bez osobnego artefaktu
        // kontekstu sesji czy pliku szkicu.
    }

    const agentMemory = this.plugin?.agentManager?.getActiveMemory();
    if (agentMemory) {
        await agentMemory.startNewSession();
    }

    this.rollingWindow = this._createRollingWindow();
    this.tokenTracker.clear();
    this.render_messages();
    this.add_welcome_message();
    this.updateTokenCounter();
    this._updateTokenPanel();
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
export async function handleSaveSession(this: ChatViewLike, agentName?: string | null, rollingWindow?: RollingWindow | null) {
    log.debug('Chat', 'handleSaveSession');
    const rw = rollingWindow || this.rollingWindow;
    if (!rw?.messages?.length) return;
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
            const savedPath = await memory.saveSession(rw.messages, metadata);
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
    try {
        const agentMemory = this.plugin?.agentManager?.getActiveMemory();
        if (!agentMemory) return;
        const filename = path.split('/').pop() as string;
        const parsed = await agentMemory.loadSession(filename);
        if (!parsed?.messages) return;

        // Modal otwórz starą sesję - 3 opcje + cancel. Default focus 'compress'.
        // Cancel → return.
        const agent = this.plugin?.agentManager?.getActiveAgent();
        const modal = new OpenSessionModal(this.app, {
            agentName: agent?.name || 'Agent',
            agentColor: agent?.color || '',
            sessionTitle: filename.replace(/\.md$/, ''),
            sessionDate: (parsed.metadata?.created as string) || filename
        });
        const choice = await modal.prompt();
        if (choice === 'cancel') return;

        this.rollingWindow = this._createRollingWindow();

        if (choice === 'continue') {
            // Pełen load
            for (const msg of parsed.messages) {
                await this.rollingWindow.addMessage(msg.role, msg.content);
            }
            new Notice(t('chat.session.loaded_full') || `Sesja załadowana: ${parsed.messages.length} wiad.`, 4000);
        } else if (choice === 'compress') {
            // Załaduj L1 summary który includes tę sesję — przez frontmatter `included_in: [[l1_xxx]]`
            const summaryText = await _findCoveringL1Summary.call(this, agentMemory, filename);
            if (summaryText) {
                await this.rollingWindow.addMessage('system', `Kontekst poprzedniej sesji (L1 summary):\n\n${summaryText}`);
                new Notice(t('chat.session.loaded_compressed') || 'Załadowano L1 summary (skompresowany kontekst)', 4000);
            } else {
                // Fallback: brak L1 jeszcze (sesja niezaczęta przez consolidateLevel1) — załaduj summary z pliku jeśli jest
                const fallback = parsed.summary || `${parsed.messages.length} wiadomości — pełen kontekst niedostępny w skompresowanej formie.`;
                await this.rollingWindow.addMessage('system', `Kontekst poprzedniej sesji:\n\n${fallback}`);
                new Notice(t('chat.session.compressed_fallback') || 'Brak L1 — załadowano summary z sesji', 4000);
            }
        } else if (choice === 'fresh') {
            // Brain + ostatnie 3 L1 jako kontekst, fresh start
            const fresh = await _buildFreshAgentContext.call(this, agentMemory);
            if (fresh) {
                await this.rollingWindow.addMessage('system', fresh);
            }
            new Notice(t('chat.session.loaded_fresh') || 'Nowy chat z perspektywy agenta (brain + 3 L1)', 4000);
        }

        this.render_messages();
        this.updateTokenCounter();
        this._updateTokenPanel?.();
    } catch (e) {
        log.error('Chat', 'Error loading session:', e);
    }
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
export async function consolidateSession(this: ChatViewLike) {
    await runSaveSessionFlow({ view: this, plugin: this.plugin });
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
    return new RollingWindow({
        maxTokens,
        triggerThreshold: threshold,
        toolTrimThreshold,
        // Kompresja LECI bezwarunkowo także dla zakładki w tle - ale to zasada o DANYCH
        // (transkrypt, sesja), nie o DOM-ie. `messages_container` jest JEDEN na cały widok,
        // więc bez tej bramki blok „skompresowano" agenta A malowałby się fizycznie w
        // rozmowie agenta B, którą user akurat czyta (z licznikami z okna A).
        onSummarized: (summary, count, messagesKept, isEmergency) => {
            if (!isOwnerTabActive(this, ownerAgentName)) return;
            this._renderCompressionBlock(summary, count, messagesKept, isEmergency);
            this._updateTokenPanel();
        },
        onToolsTrimmed: (info) => {
            log.info('Chat', `Faza 1: skrócono ${info.trimmed} wyników narzędzi (łącznie: ${info.totalTrimmed})`);
            if (!isOwnerTabActive(this, ownerAgentName)) return;
            this._renderTrimBlock(info);
            this._updateTokenPanel();
        },
        // Dedup context + durable-memory rescue. chat_session owns AgentMemory access;
        // RollingWindow only calls these providers (kierunek zależności jak dziś).
        // Szkielet kompresji (agent>global>factory) też jest w tej paczce.
        ...buildOwnerWindowOptions(this, ownerAgentName),
    });
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
            lines.push(`  ${(item.checked || item.done) ? '✅' : '⬜'} ${item.text}`);
        }
        parts.push(lines.join('\n'));
    }

    return parts.join('\n\n');
}
