/**
 * ChatView — coordinator.
 * Imports method modules from chat/ and wires them onto the prototype.
 */
import { PluginItemView } from '../ui-components/index.js';
import { TokenTracker } from '../../core/index.js';
import { CHAT_VIEW_TYPE } from './chatViewType.js';
import { t } from '../../core/i18n/index.js';
import { SkinManager } from '../crystal-soul/index.js';
import { createDefaultSlashCommands } from './chat/SlashCommandsRegistry.js';
import { createDefaultToolReactorRegistry } from './chat/ToolReactorRegistry.js';
import { DEFAULT_BOTTOM_BAR_MODE } from './chat/todoPanel.js';

// Method modules
import * as modelMethods from './chat/chat_model.js';
import * as uiMethods from './chat/chat_ui.js';
import * as tabMethods from './chat/chat_tabs.js';
import * as messageMethods from './chat/chat_messages.js';
import * as streamingMethods from './chat/chat_streaming.js';
import * as artifactMethods from './chat/chat_artifacts.js';
import * as popoverMethods from './chat/chat_popovers.js';
import * as sessionMethods from './chat/chat_session.js';

// TS-any: ChatView jest composition rootem składanym runtime z ośmiu modułów mixinów.
type Runtime = any;

/**
 * ChatView - Main chat interface for PKM Assistant
 * Provides a simple chat UI with streaming support
 */
export class ChatView extends PluginItemView {
    // Osiem miksinów dokłada metody i pola do prototypu w runtime (`Object.assign` na dole
    // pliku), więc widok potrzebuje otwartego indeksu. Baza `PluginItemView` go NIE ma —
    // trzyma zamknięty kontrakt (patrz `core/runtime/contracts.ts`), a otwartość jest
    // własnością TEJ klasy, nie każdego widoku.
    [key: string]: Runtime;
    // Widok czatu sięga po pola pluginu dokładane w inicjalizacji (menedżer agentów, rejestr
    // subów, notifier) — w kontrakcie `PluginApi` są `unknown` z premedytacją, bo ich kształt
    // należy do modułów właścicieli. Tutaj zawężamy je do otwartego typu widoku.
    declare readonly plugin: Runtime;
    // `renderView` jest w bazie OPCJONALNA (widok czatu dostaje ją miksinem, nie definiuje jej
    // w ciele klasy — `abstract` dałoby TS2515). Tutaj zawężamy ją z powrotem do obowiązkowej:
    // `Object.assign(ChatView.prototype, uiMethods)` na dole pliku ją wstrzykuje.
    declare renderView: (params?: Runtime) => Promise<void>;

    static get viewType() { return CHAT_VIEW_TYPE; }
    static get displayText() { return 'PKM Assistant'; }
    static get iconName() { return 'pkm-icon'; }

    constructor(leaf: Runtime, plugin: Runtime) {
        super(leaf, plugin);

        // Initialize RollingWindow (summarizer attached later when model available)
        this.rollingWindow = this._createRollingWindow();
        this.is_generating = false;
        this.current_message_container = null;

        // AUD-wydajnosc-071/072: koalescencja malowania strumienia (`chat/renderThrottle.ts`,
        // leniwie w `_streamRenderThrottle`) + uchwyt zaplanowanego przerysowania łączników.
        // Oba rozbrajane w `onClose` — timer w zamkniętym widoku malowałby w nicość.
        this._renderThrottle = null;
        this._connectorRedrawCancel = null;

        // Input history state
        this.inputHistory = [];
        this.historyIndex = -1;

        // Session timeout tracking (detect return after long inactivity)
        this.lastMessageTimestamp = null;

        // Autonomy (E2.3 D21 / F12) — per-chat: whether the agent ASKS before acting.
        // Independent axis from permissions (what the agent MAY do). Mirrored on plugin
        // for sub-agent inheritance. Replaces the old Gadaj/Rób work mode entirely.
        // E2.8 A6 (S5): wartość startowa może przyjść z agenta (agent.default_autonomy).
        this.currentAutonomy = this._getDefaultAutonomy(this.plugin?.agentManager?.getActiveAgent?.());
        if (this.plugin) this.plugin.currentAutonomy = this.currentAutonomy;

        // E2.9 FAZA B (B3/A17): aktywny artefakt tej rozmowy (per-tab, wzór currentAutonomy).
        // Ustawiany przez przywołanie (B2) albo segment slim bara (C); null = brak aktywnego.
        this.currentArtifactId = null;

        // E2.9 FAZA D (D2): ostatni stan listy `todo` (live-widok w slocie inputu). Aktualizowany przez
        // reactor po tool-callu `todo`; czyszczony przy przełączeniu agenta (unikamy stanu cross-agent).
        this._activeTodoState = null;

        // N4: który widok pokazuje slot paska dolnego ('input' = textarea, 'todo' = lista zadań)
        // + model z poprzedniego renderu, po którym resolver poznaje pojawienie się/zniknięcie listy.
        this._bottomBarMode = DEFAULT_BOTTOM_BAR_MODE;
        this._prevTodoModel = null;

        // F2: bezpiecznik serializacji auto-tur z wynikami subów z tła. Ustawiany przez
        // `_deliverSubTaskResult` synchronicznie (drain woła dostawcę w pętli), gaszony
        // w `send_message` na `set_generating(true)` — dalej pilnuje już `is_generating`.
        this._subTaskTurnPending = false;

        // K5: „po Stopie nie sięgamy sami po zaległe wyniki subów". Dawniej rolę tego
        // bezpiecznika pełniło pole `_abortedStream` (jedna flaga przerwania na cały widok) —
        // a że gasiła je każda kolejna wiadomość, gasiła przy okazji przerwanie tury, która
        // wciąż biegła. Przerwanie zamieszkało w turze (`turnAbort.ts`), a bezpiecznik drenu
        // został tutaj: podnosi go Stop/watchdog, gasi start następnej tury.
        this._drainSuppressed = false;

        // Pasek biegów subów pod zakładkami: który bieg jest rozwinięty (jeden naraz) +
        // odpinacze subskrypcji rejestru i timer debounce'u. Stan MUSI żyć tutaj, a nie
        // w DOM — pasek przerysowuje się na każdym kroku suba.
        this._subStripExpandedId = null;
        this._subStripUnsubs = [];
        this._subStripTimer = null;

        // Z3 (FAIL 6): szkic usera przechwycony przez kolejkę wiadomości. Ustawia go
        // `set_generating(false)` tuż przed wysłaniem zakolejkowanej treści, a oddaje
        // `send_message` po `resetInputArea()`. Jednorazowy — poza tym oknem zawsze `null`.
        this._draftAfterSend = null;

        // Token usage tracking (per-session, per-role)
        this.tokenTracker = new TokenTracker();

        // Multi-agent tabs — per-agent state storage
        this.chatTabs = []; // [{agentName, isActive}]
        this._agentStates = new Map(); // agentName -> {rollingWindow, tokenTracker, autonomy, scrollTop, isGenerating}
        this._streamCtxMap = new Map(); // agentName -> streaming context (active streams)
        // K5: agentName -> uchwyt przerwania tury, która jest jeszcze W PRZYGOTOWANIU (guzik Stop
        // już się pali, ale prompt z pamięcią się buduje i wpisu w `_streamCtxMap` jeszcze nie ma).
        this._preparingTurns = new Map();
        this.slashCommands = createDefaultSlashCommands();
        this.toolReactors = createDefaultToolReactorRegistry();
    }

    async onOpen() {
        if (!this.plugin._ready) {
            this.container.empty();
            this.container.addClass('pkm-chat-view');
            const loadingDiv = this.container.createDiv({ cls: 'pkm-chat-loading cs-root' });
            // Static layout in chat_view.css; only the skin accent colour stays inline (dynamic).
            loadingDiv.createDiv({ cls: 'cs-breathing pkm-chat-loading__diamond', text: '\u25C6' })
                .style.color = SkinManager.getColor('accent', 'var(--interactive-accent)');
            loadingDiv.createDiv({ cls: 'pkm-chat-loading__label', text: t('main.loading') });

            this.plugin.onReady(async () => {
                loadingDiv.remove();
                await this.renderView();
                await this.initSessionManager();
                this._subscribeAgentManagerEvents();
                this._subscribeSkinEvents();
                this._wireSubTaskDeliverer();
                this._wireSubTaskStrip();
            });
            return;
        }

        await this.renderView();
        await this.initSessionManager();
        this._subscribeAgentManagerEvents();
        this._subscribeSkinEvents();
        // F2: dopiero TU, po `initSessionManager` (czyli po `_restoreActiveSession`) — dostawca
        // dopasowuje wynik do zakładki, więc zakładki muszą już stać. Wpięcie robi też pierwszy
        // `drain`: wyniki subów, które skończyły przy zamkniętym czacie, wjeżdżają od razu.
        this._wireSubTaskDeliverer();
        // Pasek biegów subów: subskrypcja rejestru na żywo (render stoi już z `renderView`).
        this._wireSubTaskStrip();
    }

    onClose(): Runtime {
        // F2: zamknięty czat nie ma jak dostarczyć wyniku suba (ani gdzie odpalić auto-tury).
        // Odpinamy dostawcę — wyniki zostają w kolejce notifiera do następnego otwarcia.
        this.plugin?.subTaskNotifier?.setDeliverer?.(null);
        this._unwireSubTaskStrip?.();
        this._unsubscribeSkinEvents?.();
        this._unsubscribeSkinEvents = null;
        if (this.handleGlobalKeydownBound) {
            document.removeEventListener('keydown', this.handleGlobalKeydownBound);
        }
        if (this.handleBeforeUnloadBound) {
            window.removeEventListener('beforeunload', this.handleBeforeUnloadBound);
        }

        if (this.mentionAutocomplete) {
            this.mentionAutocomplete.destroy();
            this.mentionAutocomplete = null;
        }

        if (this.attachmentManager) {
            this.attachmentManager.destroy();
            this.attachmentManager = null;
        }

        // N3: obserwator wysokości pływającego paska (rezerwuje miejsce pod nim w liście
        // wiadomości) — zamknięty widok nie ma czego mierzyć ani gdzie zapisywać paddingu.
        if (this._bottomPanelObserver) {
            this._bottomPanelObserver.disconnect();
            this._bottomPanelObserver = null;
        }

        // Closing mid-recording must release the microphone and the 1s tick timer.
        // cancel() (not stop()) — the take in progress is dropped, no transcription into a dead view.
        if (this._audioRecorder) {
            this._audioRecorder.cancel();
            this._audioRecorder = null;
        }
        if (this._agentManagerUnsub) {
            this._agentManagerUnsub();
            this._agentManagerUnsub = null;
        }

        this._cleanupAskUser();

        // K5 (AUD-security-068): zamknięcie panelu zatrzymuje KAŻDĄ turę tego widoku — także
        // te z zakładek w tle — i suby z nich zlecone. Wcześniej stało tu pytanie o jedno pole
        // widoku (`if (this.is_generating) this.stop_generation()`), które przełączenie zakładki
        // nadpisuje stanem zakładki DOCELOWEJ: tura z tła przeżywała zamknięcie, a linia wyżej
        // rozbrajała jej watchdoga, czyli ostatniego strażnika. Kolejność jest istotna —
        // najpierw STOP (każdy `stop_generation` rozbraja watchdog SWOJEJ tury), dopiero potem
        // pas zapasowy na timery, które mogły zostać bez wpisu w mapie.
        this.stop_all_turns('close');
        for (const ctx of this._streamCtxMap.values()) ctx.watchdog?.disarm();
        // AUD-wydajnosc-071/072: pas zapasowy na timery malowania. `stop_all_turns` rozbraja je
        // przez `stop_generation` → `_resetPaintTargets`, ale tylko dla tur, które BYŁY w mapie.
        this._renderThrottle?.cancel();
        this._cancelConnectorRedraw?.();
        if (this.rollingWindow?.messages?.length > 0) {
            this.handleSaveSession();
        }
    }

    _subscribeAgentManagerEvents() {
        if (this._agentManagerUnsub || !this.plugin?.agentManager?.on) return;
        this._agentManagerUnsub = this.plugin.agentManager.on((event: string) => {
            if (!['agents:loaded', 'agents:reloaded', 'agent:created', 'agent:deleted', 'agent:updated', 'communicator:project_updated'].includes(event)) {
                return;
            }
            if (this._tabBarContainer) {
                this._renderTabBar(this._tabBarContainer);
            }
            this.renderSubAgentButtons?.();
            this.renderSkillButtons?.();
            this.renderMcpServerButtons?.();
            this.renderArtifactButtons?.();
        });
    }

    _subscribeSkinEvents() {
        if (this._unsubscribeSkinEvents) return;
        this._unsubscribeSkinEvents = SkinManager.on('skin_changed', () => {
            void (async () => {
                await this.renderView();
                this.updateTokenCounter?.();
            })();
        });
    }
}

// Mix in all method modules
Object.assign(ChatView.prototype, modelMethods);
Object.assign(ChatView.prototype, uiMethods);
Object.assign(ChatView.prototype, tabMethods);
Object.assign(ChatView.prototype, messageMethods);
Object.assign(ChatView.prototype, streamingMethods);
Object.assign(ChatView.prototype, artifactMethods);
Object.assign(ChatView.prototype, popoverMethods);
Object.assign(ChatView.prototype, sessionMethods);
