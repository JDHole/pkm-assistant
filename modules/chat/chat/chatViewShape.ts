/**
 * `chatViewShape.ts` — KSZTAŁT widoku czatu, w całości type-only.
 *
 * `ChatView` jest składany w runtime: klasa (`chat_view.ts`) + osiem modułów mixinów wpiętych
 * na prototyp przez `Object.assign`. `ChatViewLike` niżej jest tym złożeniem po stronie typów —
 * TO ON jest `this` każdej funkcji mixina, nie sama klasa.
 *
 * DLACZEGO OSOBNY PLIK, a nie deklaracja scalona z klasą w `chat_view.ts`:
 *  • scalanie klasy z interfejsem tej samej nazwy jest BŁĘDEM lintera
 *    (`@typescript-eslint/no-unsafe-declaration-merging`), a reguł nie wyłączamy;
 *  • plik nie ma eksportów wartości i nikt nie importuje go inaczej niż `import type`, więc
 *    esbuild nigdy go nie parsuje — kształt nie dokłada ani bajta do bundla.
 *
 * Podział pól: to, co ustawia KONSTRUKTOR, deklaruje klasa (`declare x: T`, zero emitu);
 * to, co dokładają dopiero mixiny (DOM widoku, popovery, kolejka), stoi tutaj.
 */
import * as modelMethods from './chat_model.js';
import * as uiMethods from './chat_ui.js';
import * as tabMethods from './chat_tabs.js';
import * as messageMethods from './chat_messages.js';
import * as streamingMethods from './chat_streaming.js';
import * as artifactMethods from './chat_artifacts.js';
import * as popoverMethods from './chat_popovers.js';
import * as sessionMethods from './chat_session.js';
import type { ChatView } from '../chat_view.js';
import type { TokenTracker } from '../../../core/index.js';

import type { Agent, AgentManager } from '../../agents/index.js';
import type { AgentMemory } from '../../memory/index.js';
import type { SubAgentData } from '../../sub-agents/index.js';
import type { MCPClient, OpenAiToolDefinition, ServerVisibilityAgent, ToolRegistry } from '../../tools/index.js';
import type { ChatModel, ChatRuntimeConfig, ModelLibraryEntry, PkmModelSettings } from '../../models/index.js';
import type { SubTaskNotifier, SubTaskRegistry } from '../../sub-agents/index.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { AttachmentManager, MentionAutocomplete } from '../../ui-components/index.js';
import type { AudioRecorder } from '../../multimodal/index.js';
import type { IdleScheduler } from '../../memory/index.js';
import type {
    AutonomyMode,
    PkmAssistantSettings,
    PluginApi,
    PluginRuntime,
    RuntimeConfig,
    SettingsBag,
    StreamWatchdog,
    TraceLog,
} from '../../../core/index.js';
import type { RollingWindow } from './RollingWindow.js';
import type { TriggerPopup } from './TriggerPopup.js';
import type { TokenViewerWidget } from './TokenViewerWidget.js';
import type { QueuedChatMessage } from './queuedMessage.js';
import type { TurnAbortHandle } from './turnAbort.js';
import type { PermissionSystemLike } from './vaultReadGate.js';
import type { DelegationProposal } from './chat_artifacts.js';

// ── Powierzchnia pluginu, z której korzysta czat ───────────────────────────────

/**
 * Pola dokładane do pluginu w inicjalizacji. W `PluginApi` są `unknown` z premedytacją —
 * ich kształt należy do modułów właścicieli, więc zawężamy je TUTAJ, typami z ich barreli.
 */
/**
 * Przepis skilla w zakresie, w jakim czyta go czat (guziki slim bara + mini-formularz
 * pre-questions + wstrzyknięcie przepisu do promptu tury).
 */
export interface ChatSkillConfig {
    name: string;
    slug?: string;
    description?: string;
    prompt?: string;
    icon_category?: string;
    userInvocable?: boolean;
    preQuestions?: ChatSkillPreQuestion[];
}

/** Jedno pytanie mini-formularza skilla (`_showSkillPreQuestions`). */
export interface ChatSkillPreQuestion {
    key: string;
    question: string;
    type?: 'text' | 'textarea' | 'select';
    default?: string;
    placeholder?: string;
    rows?: number;
    depends_on?: string;
    options?: Array<string | { value: string; label?: string; group?: string }>;
}

/**
 * `AgentManager` w zakresie, jaki czyta czat.
 *
 * Menedżer jest już typowany, ale trzy wejścia oddaje jeszcze jako `any` (pamięć agenta,
 * loader subów, przepisy skilli — należą do modułów, które kampania typowania obrabia osobno).
 * Zawężamy je TUTAJ, typami właścicieli; redeklaracja jest legalna, bo wszystko jest
 * przypisywalne do `any`.
 */
export interface ChatAgentManager extends AgentManager {
    getAgentMemory(agentName: string): AgentMemory | null;
    getActiveMemory(): AgentMemory | null;
    getMemoryForAgent(agent: Agent | string | null | undefined): AgentMemory | null;
    getActiveAgentSkills(): ChatSkillConfig[];
    resolveSkillConfig(skillName: string, agent: Agent): ChatSkillConfig | null;
    subAgentLoader: { getAllSubAgents?(): SubAgentData[] } | null;
}

/**
 * `ServerManager` w zakresie, jaki czyta czat.
 *
 * NIE `extends ServerManager`: czat woła `getActiveToolDefinitions(serwery, narzędzia)`
 * DWOMA argumentami, a menedżer przyjmuje dziś tylko pierwszy (drugi jest ignorowany —
 * znana, zastana rozbieżność; naprawa należy do `modules/tools`, nie do fali typowania).
 */
export interface ChatServerManager {
    getAllowedServerNamesForAgent?(agent: ServerVisibilityAgent | null): string[];
    getActiveToolDefinitions(filterServers?: string[], preferredTools?: string[]): OpenAiToolDefinition[];
    syncBuiltInServersForAgent?(agent: ServerVisibilityAgent | null): void;
}

export interface ChatPlugin extends PluginApi {
    agentManager?: ChatAgentManager;
    toolRegistry?: ToolRegistry;
    mcpClient?: MCPClient;
    serverManager?: ChatServerManager;
    subTaskRegistry?: SubTaskRegistry;
    subTaskNotifier?: SubTaskNotifier;
    artifactStore?: ArtifactStore;
    permissionSystem?: PermissionSystemLike;
    traceLog?: TraceLog;
    /** Lustro autonomii aktywnej zakładki — dziedziczą je suby. */
    currentAutonomy?: AutonomyMode;
    /** Podgląd „Pokaż prompt" w Ustawieniach. */
    _lastSentSnapshot?: LastSentSnapshot;
    /** Runtime z zawężonym workiem ustawień — ten sam obiekt, który oddaje `ChatView.env`. */
    readonly env: ChatRuntime | null;
    /** Uchwyty oczekującego `ask_user` (odpowiedź usera wraca do `AskUserTool.execute`). */
    _askUserPromise?: Promise<string | null> | null;
    _askUserResolve?: ((answer: string | null) => void) | null;
    _askUserPending?: unknown;
}

/** Migawka ostatnio wysłanego promptu (Ustawienia → „Pokaż prompt"). */
export interface LastSentSnapshot {
    systemPrompt: string;
    conversationSummary: string;
    lastUserMessage: string;
    timestamp: number;
    agentName: string;
    agentEmoji: string;
}

/**
 * Ustawienia czatu żyjące pod `pkmAssistant`. Kontrakt `PkmAssistantSettings` trzyma indeks
 * otwarty (`[key: string]: unknown`), więc klucze czytane WYŁĄCZNIE przez czat deklarujemy tu —
 * inaczej każdy odczyt wracałby jako `unknown`.
 */
export interface ChatPkmSettings extends PkmAssistantSettings, PkmModelSettings {
    // Trzy pola deklarują OBA kontrakty bazowe, każdy własnym kształtem — redeklaracja musi być
    // przypisywalna do obu naraz (inaczej TS2320 na `extends`).
    modelLibrary?: Record<string, ModelLibraryEntry[] | undefined>;
    limits?: Record<string, number>;
    maxTokens?: Record<string, number>;
    autoSaveInterval?: number;
    idleConsolidationMinutes?: number;
    maxContextTokens?: number;
    summarizationThreshold?: number;
    toolTrimThreshold?: number;
    sessionTimeoutMinutes?: number;
    enableOczko?: boolean;
    enableAutoSummarization?: boolean;
    compactToolChips?: boolean;
    showThinking?: boolean;
    cacheTelemetryEnabled?: boolean;
    /** Domyslne prompty robocze (`resolveWorkPrompt` w core). */
    promptDefaults?: Record<string, unknown>;
    stt?: SttSettings;
}

/** Ustawienia rozpoznawania mowy (mikrofon w pasku inputu). */
export interface SttSettings {
    platform?: string;
    language?: string;
    deepgram_api_key?: string;
    assemblyai_api_key?: string;
}

export interface ChatSettingsBag extends SettingsBag {
    pkmAssistant?: ChatPkmSettings;
}

/**
 * Runtime widziany przez czat — TEN SAM obiekt, z zawężonymi trzema polami.
 *
 * Zawężenie jest po to, żeby `plugin` przechodził bez asercji do `createModelForRole`
 * (`modules/models` opisuje runtime własnym, węższym kontraktem `ResolverRuntimeLike`:
 * rejestr dostawców z konkretnymi kluczami, worek ustawień modeli, slot `ChatModel`).
 * Każda redeklaracja jest przypisywalna do swojego odpowiednika w `PluginRuntime`.
 */
export interface ChatRuntime extends PluginRuntime {
    readonly settings: ChatSettingsBag;
    readonly config: RuntimeConfig & { chat: ChatRuntimeConfig };
    chatModel: ChatModel | null;
}

// ── Stan zakładek ─────────────────────────────────────────────────────────────

/** Jedna zakładka czatu. Tożsamość liczy `_tabKey` (`chat_tabs.ts`). */
export interface ChatTab {
    agentName: string;
    isActive: boolean;
    sessionId?: string;
    sessionPath?: string;
    sessionName?: string;
    sessionLabel?: string;
    /** Tura skończyła się, gdy zakładka była w tle — przerysuj po powrocie. */
    _needsRefresh?: boolean;
}

/** Stan odkładany per zakładka (klucz mapy = `_tabKey(tab)`). */
export interface ChatTabState {
    rollingWindow: RollingWindow;
    tokenTracker: TokenTracker;
    autonomy: AutonomyMode;
    scrollTop: number;
    currentArtifactId?: string | null;
    isGenerating?: boolean;
}

/**
 * Minimalny wpis mapy tur (`_streamCtxMap`). Mechanika tury żyje w zamknięciu `turn`
 * w `send_message`; tutaj leży tylko to, co czytają INNE metody widoku.
 */
export interface ChatStreamContext {
    agentName: string;
    agent: Agent | null;
    rollingWindow: RollingWindow;
    tokenTracker: TokenTracker;
    turnId: number;
    abort: TurnAbortHandle;
    chatModel?: ChatModel | null;
    watchdog?: StreamWatchdog;
}

/** Wiersz licznika tokenów w pasku zakładek (`_buildTokenRow`). */
export interface TokenRowRefs {
    el: HTMLElement;
    valEl: HTMLElement;
}

// ── Typ instancji: klasa + osiem mixinów ──────────────────────────────────────

type ModelMethods = typeof modelMethods;
// `renderView` wypada z paczki mixina: baza `PluginItemView` deklaruje ją jako OPCJONALNĄ, a
// `extends` wymaga członków IDENTYCZNYCH. Zawężamy ją z powrotem do obowiązkowej deklaracją
// `declare` w ciele klasy niżej (`Object.assign` z `uiMethods` wstrzykuje implementację).
type UiMethods = Omit<typeof uiMethods, 'renderView'>;
type TabMethods = typeof tabMethods;
type MessageMethods = typeof messageMethods;
type StreamingMethods = typeof streamingMethods;
type ArtifactMethods = typeof artifactMethods;
type PopoverMethods = typeof popoverMethods;
type SessionMethods = typeof sessionMethods;

/**
 * Metody z ośmiu modułów mixinów + pola widoku, które dokładają DOPIERO one (DOM zbudowany
 * w `renderView`, popovery, kolejka wiadomości, wskaźniki malowania strumienia).
 * Pola ustawiane w konstruktorze deklaruje klasa — patrz nagłówek pliku.
 */
export interface ChatViewMixins extends
    ModelMethods,
    UiMethods,
    TabMethods,
    MessageMethods,
    StreamingMethods,
    ArtifactMethods,
    PopoverMethods,
    SessionMethods {

    /**
     * Ten sam runtime co w bazie, z zawężonym workiem ustawień (`ChatPkmSettings`) i BEZ `null`.
     *
     * Zawężenie stoi tu, bo baza (`PluginItemView`) wystawia `env` AKCESOREM — deklaracja pola
     * w ciele klasy dałaby TS2610. Brak `null` opisuje stan faktyczny tej powierzchni: mixiny
     * biegają dopiero po `onReady`, a widok i tak czyta `this.env.settings` bez guardu
     * (dokładanie guardów byłoby zmianą runtime'u, nie typowania).
     */
    readonly env: ChatRuntime;


    // ── Zakładki ──

    // ── Rejestry ──

    // ── Malowanie strumienia ──
    current_message_bubble: HTMLElement | null;
    current_message_text: HTMLElement | null;
    _currentThinkingBlock: HTMLElement | null;
    _lastPaintedContent: string | null;
    _agentHeaderShown: boolean;
    _lastCompressionBlockEl: HTMLElement | null;

    // ── Kolejka wiadomości i tury w tle ──
    _queuedMessage: QueuedChatMessage | null;
    _queuedDrainTimer: number | null;
    _queuedIndicatorEl: HTMLElement | null;
    _autoTurnChainCounts?: Map<string, number>;
    _pendingDelegation: DelegationProposal | null;

    // ── Pasek biegów subów ──
    _subStripContainer: HTMLElement | null;

    // ── Lista `todo` w slocie inputu ──

    // ── DOM widoku (budowany w `renderView`) ──
    _tabBarContainer: HTMLElement | null;
    _chatBody: HTMLElement | null;
    messages_container: HTMLElement;
    _slimBar: HTMLElement | null;
    _artifactChipBar: HTMLElement | null;
    _inputRow: HTMLElement | null;
    _todoPanelBar: HTMLElement | null;
    _chipBar: HTMLElement;
    input_area: HTMLTextAreaElement;
    send_button: HTMLElement;
    stop_button: HTMLElement;
    toolbar: HTMLElement;
    _todoToggleBtn: HTMLElement | null;
    _autonomyBtn: HTMLElement;
    _permBtn: HTMLElement;
    permissionsBtn?: HTMLElement | null;
    _micBtn: HTMLElement;
    _tokenDisplay: HTMLElement | null;
    subAgentButtonsBar: HTMLElement | null;
    skillButtonsBar: HTMLElement | null;
    mcpServerButtonsBar: HTMLElement | null;
    artifactButtonsBar: HTMLElement | null;
    typingIndicator: HTMLElement | null;
    typingStatusEl: HTMLElement | null;
    autosaveStatus?: HTMLElement | null;
    _topbarTokensWrap: HTMLElement;
    _slimBarTokenMain: TokenRowRefs | null;
    _slimBarTokenMinion: TokenRowRefs | null;
    _tokenViewer: TokenViewerWidget | null;
    _bottomPanelObserver: ResizeObserver | null;

    // ── Popovery ──
    _autonomyPopover: HTMLElement | null;
    _toolsPopover: HTMLElement | null;
    _permPopover: HTMLElement | null;
    _triggerPopup: TriggerPopup | null;
    _triggerPos: number;

    // ── Współpracownicy UI ──
    mentionAutocomplete: MentionAutocomplete | null;
    attachmentManager: AttachmentManager | null;
    _audioRecorder: AudioRecorder | null;

    // ── Token Viewer (stan widgetu, trwały między otwarciami popovera) ──
    _tokenViewerRole?: string;
    _tokenViewerAutoUpdate?: boolean;
    _tokenViewerCompactView?: boolean;

    // ── Sesja ──
    _idleScheduler: IdleScheduler | null;
    _lastIdleSaveMsgCount: number;

    // ── Subskrypcje i uchwyty zdarzeń ──
    _agentManagerUnsub: (() => void) | null;
    _unsubscribeSkinEvents: (() => void) | null;
    handleGlobalKeydownBound: ((e: KeyboardEvent) => void) | null;
    handleBeforeUnloadBound: (() => void) | null;
}

/**
 * `this` każdej funkcji mixina: klasa + wszystko, co mixiny dokładają na prototyp.
 * Mixiny NIE mogą deklarować `this: ChatView` — sama klasa nie zna metod sąsiadów.
 */
export type ChatViewLike = ChatView & ChatViewMixins;

/** Kontekst komendy `/`: widok, w którym ją wpisano, i plugin. */
export interface SlashCommandContext {
    view: ChatViewLike;
    plugin: ChatPlugin;
}
