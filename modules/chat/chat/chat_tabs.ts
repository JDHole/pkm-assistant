/**
 * Multi-agent tab management — init, switch, close, picker, tab bar rendering.
 * Methods mixed into ChatView.prototype.
 */
import { Notice } from 'obsidian';
import { SkinManager, hexToRgbTriplet, setSvg } from '../../crystal-soul/index.js';
import { TokenTracker } from '../../../core/index.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import { DEFAULT_BOTTOM_BAR_MODE } from './todoPanel.js';
// AUD-security-114: zamknięcie zakładki zatrzymuje też JEJ suby — po tym samym adresie
// zwrotnym, co zamknięcie całego panelu (`stop_all_turns`).
import { collectSubTaskIdsForOwners } from './turnAbort.js';

// TS-any: receiver legacy mixinów składany runtime przez Object.assign.
type ChatViewMixinContext = any;

/**
 * Initialize chatTabs from the current active agent.
 * Called once in renderView.
 */
export function _initTabs(this: ChatViewMixinContext) {
    const activeAgent = this.plugin?.agentManager?.getActiveAgent();
    const activeAgentName = activeAgent?.name || 'Jaskier';

    if (this.chatTabs.length === 0) {
        this.chatTabs.push({ agentName: activeAgentName, sessionId: activeAgentName, isActive: true });
    }

    const activeTab = this.chatTabs.find((t: ChatViewMixinContext) => t.isActive) || this.chatTabs[0];
    const activeKey = _tabKey(activeTab);
    if (!this._agentStates.has(activeKey)) {
        this._agentStates.set(activeKey, {
            rollingWindow: this.rollingWindow,
            tokenTracker: this.tokenTracker,
            autonomy: this.currentAutonomy,
            currentArtifactId: this.currentArtifactId,
            scrollTop: 0,
        });
    }
}

/**
 * Render the tab bar (replaces old pkm-chat-header).
 */
export function _renderTabBar(this: ChatViewMixinContext, container: ChatViewMixinContext) {
    container.empty();
    const topbar = container.createDiv({ cls: 'cs-chat-topbar cs-root' });
    const activeAgentColor = this._getAgentColor();
    topbar.style.setProperty('--cs-agent-color-rgb', hexToRgbTriplet(activeAgentColor));

    for (const tab of this.chatTabs) {
        const agent = this.plugin?.agentManager?.getAgent(tab.agentName);
        const color = SkinManager.getAgentColor(agent || tab.agentName);

        const tabEl = topbar.createDiv({
            cls: `cs-tab ${tab.isActive ? 'cs-tab--active' : ''}`
        });
        tabEl.style.setProperty('--cs-agent-color-rgb', hexToRgbTriplet(color));

        const crystal = tabEl.createDiv({ cls: 'cs-tab__crystal' });
        setSvg(crystal, SkinManager.getCrystal(agent || tab.agentName, { size: 14, color, glow: false }));

        tabEl.createSpan({ cls: 'cs-tab__name', text: tab.sessionLabel || tab.agentName });

        tabEl.addEventListener('click', () => this._switchTab(_tabKey(tab)));
    }

    const addTab = topbar.createDiv({ cls: 'cs-tab cs-tab--add' });
    addTab.textContent = '+';
    addTab.addEventListener('click', () => this._openAgentPickerModal());

    // Token counters (right side)
    this._topbarTokensWrap = topbar.createDiv({ cls: 'cs-topbar-tokens' });
    this._slimBarTokenMain = this._buildTokenRow(this._topbarTokensWrap, 'main');
    this._slimBarTokenMinion = this._buildTokenRow(this._topbarTokensWrap, 'minion');
    // Wiersz 'master' skasowany w fabryce kasacji S1 (2026-09-02, AUD-dead-code-119) — patrz
    // modules/chat/chat/chat_ui.ts `_updateSlimBarTokens`.
    this._updateSlimBarTokens();
}

/**
 * Switch to a different agent tab.
 */
export async function _switchTab(this: ChatViewMixinContext, tabIdOrAgentName: string) {
    const currentTab = this.chatTabs.find((t: ChatViewMixinContext) => t.isActive);
    const targetTab = this.chatTabs.find((t: ChatViewMixinContext) => _tabKey(t) === tabIdOrAgentName)
        || this.chatTabs.find((t: ChatViewMixinContext) => t.agentName === tabIdOrAgentName);
    if (!targetTab) return;

    const currentKey = currentTab ? _tabKey(currentTab) : null;
    const targetKey = _tabKey(targetTab);
    const agentName = targetTab.agentName;
    if (currentKey === targetKey) return;

    // 0. AUD-bledy-015: rozbrój dren kolejki poprzedniej zakładki. Timer był goły
    // (`setTimeout` bez uchwytu), więc wybudzał się po przełączeniu i startował turę
    // u agenta, który akurat jest na wierzchu. Sam slot ZOSTAJE pełny — wiadomość czeka
    // na powrót na swoją zakładkę (właściciela porównuje `queuedOwnerMatches`).
    this._clearQueuedDrainTimer?.();

    // 0b. Review opusa (P1): rozbrój throttle malowania strumienia. Klatka uzbrojona ≤80 ms
    // przed przełączeniem wystrzeliłaby PO przerysowaniu listy (krok 7) i PO przywróceniu
    // `scrollTop` (krok 9): tekst poszedłby w wypięte węzły starej zakładki (niewidoczny),
    // ale `scrollToBottom` przewinąłby NOWĄ zakładkę na dół. Nic nie ginie — tura leci dalej
    // w tle, a jej finalna treść i tak wchodzi do okna kontekstu i na listę po powrocie.
    // Druga linia obrony (na wypadek nowego `await` przed tym miejscem): bramka
    // `shouldPaintFrame` w `_paintStreamFrame`.
    this._renderThrottle?.cancel();

    // 1. Save current state
    if (currentTab) {
        const scrollTop = this.messages_container?.scrollTop || 0;
        this._agentStates.set(currentKey, {
            rollingWindow: this.rollingWindow,
            tokenTracker: this.tokenTracker,
            autonomy: this.currentAutonomy,
            currentArtifactId: this.currentArtifactId,
            scrollTop,
            isGenerating: this.is_generating,
        });
    }

    // 2. Switch active flag
    for (const tab of this.chatTabs) {
        tab.isActive = _tabKey(tab) === targetKey;
    }

    // 3. Switch agent in AgentManager
    const agentManager = this.plugin?.agentManager;
    if (agentManager) {
        agentManager.switchAgent(agentName);
        const memory = agentManager.getAgentMemory?.(agentName);
        if (memory && targetTab.sessionPath) {
            memory.activeSessionPath = targetTab.sessionPath;
            await memory._persistActiveSession?.();
        }
    }

    // 3a. Sync built-in MCP servers for the newly active agent
    this.plugin?.serverManager?.syncBuiltInServersForAgent?.(agentManager?.getActiveAgent?.());

    // 3b. Invalidate global model singleton
    if (this.env?.chatModel) {
        this.env.chatModel = null;
    }

    // 4. Restore or create state for new agent
    const stored = this._agentStates.get(targetKey);
    // E2.8 A6 (S5): agent już przełączony na tym etapie — getActiveAgent() zwraca właściwego,
    // więc jego default_autonomy startuje nową sesję (per-czat override działa dalej w locie).
    const switchedAgent = this.plugin?.agentManager?.getActiveAgent?.();
    if (stored) {
        this.rollingWindow = stored.rollingWindow;
        this.tokenTracker = stored.tokenTracker;
        this.currentAutonomy = stored.autonomy ?? this._getDefaultAutonomy(switchedAgent);
        this.currentArtifactId = stored.currentArtifactId ?? null;
    } else {
        this.rollingWindow = this._createRollingWindow(agentName);
        this.tokenTracker = new TokenTracker();
        this.currentAutonomy = this._getDefaultAutonomy(switchedAgent);
        this.currentArtifactId = null;
        this._agentStates.set(targetKey, {
            rollingWindow: this.rollingWindow,
            tokenTracker: this.tokenTracker,
            autonomy: this.currentAutonomy,
            currentArtifactId: this.currentArtifactId,
            scrollTop: 0,
            isGenerating: false,
        });
    }
    // Mirror for sub-agent inheritance.
    if (this.plugin) this.plugin.currentAutonomy = this.currentAutonomy;

    // 5. Restore generating state
    this.set_generating(stored?.isGenerating || false);

    // 6. Update UI
    this._updateAutonomyButton();
    this.updatePermissionsBadge();
    this.renderSubAgentButtons?.();
    this.renderSkillButtons();
    this.renderMcpServerButtons?.();
    this._renderArtifactChip?.();   // E2.9 FAZA B (B4): chip aktywnego artefaktu per-tab
    this._activeTodoState = null;   // E2.9 FAZA D (D2): todo jest per-agent — czyścimy przy switchu
    this._prevTodoModel = null;     // N4: bez tego resolver widziałby listę POPRZEDNIEGO agenta
    this._bottomBarMode = DEFAULT_BOTTOM_BAR_MODE;  // N4: nowa zakładka zaczyna od pola tekstowego
    this._renderTodoPanel?.();
    // Pasek biegów subów jest PER ZAKŁADKA — nowa zakładka = inne biegi (i zwinięty szczegół).
    this._subStripExpandedId = null;
    this._renderSubTaskStrip?.();
    this.updateTokenCounter();
    this._updateTokenPanel();

    // 6. Update agent color
    const agentRgb = this._getAgentRgb();
    const bottomPanel = this.container?.querySelector('.cs-input-panel');
    if (bottomPanel) {
        bottomPanel.style.setProperty('--cs-agent-color-rgb', agentRgb);
    }
    if (this._slimBar) {
        this._slimBar.style.setProperty('--cs-agent-color-rgb', agentRgb);
        this._renderSlimBar();
    }

    // 7. Re-render messages
    this.render_messages();
    if (this.rollingWindow.messages.length === 0) {
        this.add_welcome_message();
    }

    // 8. Re-render tab bar
    if (this._tabBarContainer) {
        this._renderTabBar(this._tabBarContainer);
    }

    // 9. Restore scroll position
    if (stored?.scrollTop && this.messages_container) {
        this.messages_container.scrollTop = stored.scrollTop;
    }

    // 10. Refresh if background stream completed
    const switchedTab = this.chatTabs.find((t: ChatViewMixinContext) => _tabKey(t) === targetKey);
    if (switchedTab?._needsRefresh) {
        delete switchedTab._needsRefresh;
        this.render_messages();
        this.scrollToFinalMessage();
    }

    // 11. F2: wynik suba dla TEJ zakładki mógł przyjść, gdy była w tle — dostawca odmawiał
    // wtedy przyjęcia (auto-tura za plecami usera). Teraz zakładka jest na wierzchu, więc
    // ponawiamy próbę. Nic nie czeka = drain jest darmowy.
    this._drainSubTasks?.();
}

/**
 * AUD-security-114: zatrzymaj wszystko, co ZAMYKANA zakładka trzyma w locie.
 *
 * Co było zepsute: „Zamknij chat" zapisywał sesję i kasował stan zakładki, ale nigdy nie
 * wołał stopu — w odróżnieniu od sąsiedniego „Nowy chat" (`chat_session.ts`) i od zamknięcia
 * panelu (`onClose` → `stop_all_turns`). Tura leciała dalej: wykonywała narzędzia i po
 * zakończeniu dopisywała odpowiedź do właśnie zapisanej, „zamkniętej" sesji. Suby tej
 * zakładki przeżywały nawet późniejsze zamknięcie panelu, bo ich `origin.tabKey` wskazywał
 * zakładkę, której już nie ma w `chatTabs` (dopasowanie po właścicielach nie miało jak trafić).
 *
 * Nowego mechanizmu Stopu tu NIE MA: wołamy dokładnie to, co już istnieje — `stop_generation`
 * dla tury tej zakładki i `requestStop` dla jej biegów (te same funkcje co guzik Stop i
 * `stop_all_turns`). Stop leci PRZED zapisem i przed `_agentStates.delete`.
 */
function _stopTabWork(this: ChatViewMixinContext, tab: ChatViewMixinContext, tabKey: string) {
    const agentName = tab?.agentName;
    // Tylko gdy ta zakładka NAPRAWDĘ coś trzyma — `stop_generation` czyści stan streamingu
    // i podnosi `_drainSuppressed`, więc na cichej zakładce byłoby to szkodliwe.
    const wLocie = !!agentName && !!(
        this._streamCtxMap?.has?.(agentName) || this._preparingTurns?.has?.(agentName)
    );
    if (wLocie) {
        try {
            this.stop_generation(agentName, 'close_tab');
        } catch (e: ChatViewMixinContext) {
            log.warn('Chat', `Zatrzymanie tury zamykanej zakładki padło (zamykamy dalej): ${e?.message || e}`);
        }
    }

    // Suby zlecone Z TEJ zakładki — po adresie zwrotnym (`origin`), jak w `stop_all_turns`.
    // `requestStop` to PROŚBA: bieg gaśnie przy najbliższym punkcie przerwania swojej pętli.
    const registry = this.plugin?.subTaskRegistry;
    if (!registry?.list || !registry.requestStop) return;
    try {
        const ids = collectSubTaskIdsForOwners(registry.list(), {
            tabKeys: [tabKey],
            ...(agentName ? { agentNames: [agentName] } : {}),
        });
        for (const id of ids) {
            log.info('Chat', `Zamknięcie zakładki → zatrzymuję bieg suba ${id}`);
            registry.requestStop(id);
        }
    } catch (e: ChatViewMixinContext) {
        log.warn('Chat', `Zatrzymanie subów zamykanej zakładki padło: ${e?.message || e}`);
    }
}

/**
 * Close the active tab.
 *
 * Zapis MUSI się domknąć przed sprzątaniem stanu: do 2026-07-29 `handleSaveSession()` i
 * `_switchTab()` leciały fire-and-forget, więc zapis pliku sesji ścigał się z przełączeniem
 * agenta (`activeSessionPath` już przestawione) i z kasacją stanu zakładki — ostatnie
 * wiadomości potrafiły wylądować nie tam, gdzie trzeba, albo przepaść.
 * Pad zapisu nie może zablokować zamknięcia zakładki — łapiemy i lecimy dalej.
 *
 * AUD-security-114: zamknięcie zakładki NAJPIERW zatrzymuje to, co ta zakładka trzyma w locie
 * (turę + jej suby), a dopiero potem zapisuje i kasuje stan — kolejność jak w `onClose` (K5).
 */
export async function _closeActiveTab(this: ChatViewMixinContext) {
    const activeIndex = this.chatTabs.findIndex((t: ChatViewMixinContext) => t.isActive);
    if (activeIndex === -1) return;

    const activeTab = this.chatTabs[activeIndex];
    const activeKey = _tabKey(activeTab);

    _stopTabWork.call(this, activeTab, activeKey);

    if (this.rollingWindow?.messages?.length > 0) {
        try {
            await this.handleSaveSession();
        } catch (e: ChatViewMixinContext) {
            log.warn('Chat', `Save on tab close failed (non-fatal): ${e?.message || e}`);
        }
    }

    this._agentStates.delete(activeKey);

    if (this.chatTabs.length <= 1) {
        this.rollingWindow = this._createRollingWindow();
        this.render_messages();
        this.add_welcome_message();
        this.updateTokenCounter();
        this._updateTokenPanel();
        return;
    }

    this.chatTabs.splice(activeIndex, 1);
    const newActiveIndex = Math.min(activeIndex, this.chatTabs.length - 1);
    await this._switchTab(_tabKey(this.chatTabs[newActiveIndex]));
}

/**
 * Open the agent picker modal — grid of crystal cards.
 */
export function _openAgentPickerModal(this: ChatViewMixinContext) {
    const agentManager = this.plugin?.agentManager;
    if (!agentManager) return;

    const allAgents = agentManager.getAllAgents();
    const openNames = new Set(this.chatTabs.map((t: ChatViewMixinContext) => t.agentName));
    const available = allAgents.filter((a: ChatViewMixinContext) => !openNames.has(a.name));

    if (available.length === 0) {
        new Notice(t('chat.all_agents_open'));
        return;
    }

    const overlay = createDiv();
    overlay.className = 'cs-agent-picker-overlay';
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    const modal = overlay.appendChild(createDiv());
    modal.className = 'cs-agent-picker cs-root';

    modal.appendChild(createDiv()).className = 'cs-agent-picker__title';
    modal.querySelector('.cs-agent-picker__title')!.textContent = t('chat.select_agent');

    const grid = modal.appendChild(createDiv());
    grid.className = 'cs-agent-picker__grid';

    for (const agent of available) {
        const color = SkinManager.getAgentColor(agent);

        const card = grid.appendChild(createDiv());
        card.className = 'cs-agent-picker__card';
        card.style.setProperty('--cs-agent-color-rgb', hexToRgbTriplet(color));

        const crystalDiv = card.appendChild(createDiv());
        crystalDiv.className = 'cs-agent-picker__crystal';
        setSvg(crystalDiv, SkinManager.getCrystal(agent, { size: 32, color, glow: false }));

        const nameDiv = card.appendChild(createDiv());
        nameDiv.className = 'cs-agent-picker__name';
        nameDiv.textContent = agent.name;

        if (agent.role) {
            const roleDiv = card.appendChild(createDiv());
            roleDiv.className = 'cs-agent-picker__role';
            roleDiv.textContent = agent.role;
        }

        card.addEventListener('click', () => {
            this.chatTabs.push({ agentName: agent.name, sessionId: agent.name, isActive: false });
            overlay.remove();
            this._switchTab(agent.name);
        });
    }

    document.body.appendChild(overlay);
}

/**
 * Handle agent change (delegate to tab system).
 */
export async function handleAgentChange(this: ChatViewMixinContext, agentName: string) {
    if (!agentName) return;
    const hasTab = this.chatTabs.some((t: ChatViewMixinContext) => t.agentName === agentName);
    if (!hasTab) {
        this.chatTabs.push({ agentName, sessionId: agentName, isActive: false });
    }
    await this._switchTab(agentName);
}

/**
 * Tożsamość zakładki — jeden klucz, po którym rozpoznajemy ją w `_agentStates` i w originie tury.
 *
 * F2 faza B: EKSPORTOWANE, bo adres zwrotny delegacji w tle (`turn.origin.tabKey` w
 * `chat_streaming.js`) i dopasowanie wracającego wyniku (`matchTabForOrigin`) muszą liczyć
 * ten klucz DOKŁADNIE tak samo jak `_switchTab`. Druga kopia tej logiki = wynik suba trafiałby
 * do złej zakładki. Efekt uboczny eksportu: funkcja ląduje też na `ChatView.prototype`
 * (Object.assign kopiuje wszystkie eksporty) — nie czyta `this`, więc jest to nieszkodliwe.
 */
export function _tabKey(tab: ChatViewMixinContext) {
    if (!tab) return '';
    return tab.sessionId || tab.sessionPath || tab.sessionName || tab.agentName;
}
