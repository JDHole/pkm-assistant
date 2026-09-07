import Obsidian from "obsidian";
import type { EventRef } from "obsidian";
// TS-4 (2026-09-07): silnik YAML wbudowany w Obsidiana, zamiast paczki `js-yaml` — katalog
// społeczności wytyka `js-yaml` (module-replacements) i tak czy inaczej dubluje bibliotekę,
// którą Obsidian już wozi. `core/utils/yamlParser.ts` musi zostać node-safe (barrel core/
// wstaje bez `obsidian`), więc silnik jest WSTRZYKIWANY — composition root robi to tutaj,
// PRZED klasą pluginu, żeby żaden loader agentów/subów nie ruszył bez ustawionego silnika.
import { parseYaml, stringifyYaml } from "obsidian";
// D1 (2026-09-04): pomocnik żądań HTTP Obsidiana zniknął stąd razem z updaterem — plugin nie
// ma już ani jednego ruchu sieciowego, którego nie zaczął user. Klient HTTP runtime'u powstaje
// w `config/runtimeConfig.ts`, nie w composition roocie.
const {
  Notice,
  Platform,
} = Obsidian;

import { PluginRuntime } from '../core/runtime/PluginRuntime.js';
import { buildRuntimeConfig } from '../config/runtimeConfig.js';
import { readUiLanguage } from '../core/runtime/settingsArmor.js';
import { openNote } from "../core/utils/obsidianNav.js";

import {
  ReleaseNotesView,
  PkmSettingsTab,
  registerAgentSidebar,
  openAgentSidebar,
  SendToAgentModal,
  InlineCommentModal,
  requestApproval,
} from "../modules/shell/index.js";

import { registerPkmIcon } from "../modules/crystal-soul/icons.js";

import { PluginBase } from '../core/PluginBase.js';

// PKM Assistant custom components
import { ChatView } from "../modules/chat/index.js";
import { AgentManager } from "../modules/agents/index.js";
import { isKomunikatorEnabled, registerKomunikatorCleanup } from "../modules/komunikator/index.js";
// S31: obsidianowe bebechy core/ (PluginBase, runtime/PluginRuntime, utils/obsidianNav,
// security/MasterPasswordModal)
// deep-importuje TYLKO ten plik — jako composition root. Reszta core przychodzi barrelem
// (linia niżej), bo `core/index.js` musi zostać node-safe. Patrz nagłówek core/index.js.
import { MasterPasswordModal } from "../core/security/MasterPasswordModal.js";
import {
  // Runtime + registry
  ToolRegistry,
  MCPClient,
  ServerManager,
  // E3.1: prawdziwy klient MCP — zewnętrzne serwery stdio/HTTP przez oficjalny SDK
  ExternalMcpManager,
  // Vault prymitywy (E2.6): read/list mają scope vault|memory; write/delete/create_folder vault-only
  createReadTool,
  createListTool,
  createWriteTool,
  createDeleteTool,
  createCreateFolderTool,
  // E2.5: JEDNO narzędzie search (12 narzędzi retrieval skonsolidowane)
  createSearchTool,
  // Memory tools (odczyt pamięci przez read/list scope=memory)
  createMemorySaveTool,
  createMemoryDeleteTool,
  // Skille bez narzędzi (D17): odkrywalność = indeks w prompcie, przepis przez read()
  // Sub-agent + agent communication
  createDelegateTool,
  // Z7: przerwanie biegów delegacji przy demontażu (patrz onunload)
  stopAllDelegations,
  createAgentDelegateTool,
  createKomunikatorTools,
  // E2.9: artefakty żywe (gatunek 1)
  createArtifactCreateTool,
  createArtifactReadTool,
  createArtifactUpdateTool,
  createArtifactListTool,
  // E2.9 FAZA D: todo (gatunek 2)
  createTodoTool,
  // Web tools
  createWebSearchTool,
  createWebReadTool,
  // Communication
  createAskUserTool,
  // Multimodal
  createGenerateImageTool,
  createAddTextToImageTool,
} from "../modules/tools/index.js";
import { ArtifactStore, registerArtifactBlocks, migrateJsonArtifactsToNotes, DEFAULT_ARTIFACTS_FOLDER, buildArtifactsBaseContent, buildArtifactsBasePath } from "../modules/artifacts/index.js";
// F1 (przebudowa subów 2026): księga biegów sub-agentów. Stoi obok traceLog, bo trace.log
// jest jej pierwszym konsumentem (patrz modules/sub-agents/CLAUDE.md).
import { SubTaskRegistry, SubTaskNotifier } from "../modules/sub-agents/index.js";
import { log } from "../core/utils/Logger.js";
import {
  TraceLog,
  LogFileSink,
  maskSensitiveData,
  PermissionSystem,
  AccessGuard,
  ApprovalManager,
  SecretsStorage,
  VAULT_GITIGNORE_ENTRIES,
  // K7: proweniencja wiadomości czatu — wysyłka składana przez kod jest maszynowa.
  MACHINE_MESSAGE_META,
  // S35: przeprowadzka data.json ze starego folderu pluginu (.obsidian/plugins/obsek → nowe id).
  migrateOldPluginFolder,
  // AUD-dead-code-182: kanoniczny typ widoku czatu (zamiast trzech kopii literału).
  CHAT_VIEW_TYPE,
  setYamlEngine,
} from "../core/index.js";

// Silnik YAML wstrzyknięty NATYCHMIAST po imporcie — zanim jakikolwiek loader (agentów,
// sub-agentów, skilli, artefaktów) zdąży wywołać `parseYaml`/`stringifyYaml` z barrela `core/`.
setYamlEngine({ parse: parseYaml, stringify: stringifyYaml });
import { setLocale, t } from "../core/i18n/index.js";
import { SkinManager, adoptSheet, removeAdoptedSheets } from "../modules/crystal-soul/index.js";
// Embedding: indekser + providery. S31 Z4 — `src/embeddings/` wchłonięte do modułu,
// więc 6 lokalnych importów providerów wchodzi teraz przez te same drzwi co VaultIndexer.
import {
  VaultIndexer,
  EmbeddingRegistry,
  countDocs,
} from "../modules/embedding/index.js";
import { EmbeddingHelper } from "../modules/memory/index.js";

// TS-any: composition root scala dynamiczne API Obsidiana oraz otwarte kontrakty modułów pluginu.
type PluginDynamic = any;

export default class PkmAssistantPlugin extends PluginBase {
  [key: string]: PluginDynamic;
  /**
   * C-02/C-03: konfiguracja runtime'u powstaje w KONSTRUKTORZE (tanio, bez I/O), a `onload()`
   * podaje TĘ SAMĄ referencję konstruktorowi runtime'u — dzięki temu harness podmienia
   * dostawców RAZ, przed `onload()`, i podmiana jest widoczna po boocie.
   *
   * ⚠️ Klient HTTP (razem z pomocnikiem żądań Obsidiana) powstaje w `config/runtimeConfig.ts`, NIE tutaj.
   */
  constructor(app: PluginDynamic, manifest: PluginDynamic) {
    super(app, manifest);
    this.runtimeConfig = buildRuntimeConfig({ app: this.app as PluginDynamic });
  }

  get settingsTabClass(): PluginDynamic { return PkmSettingsTab; }


  get itemViews(): PluginDynamic {
    return {
      // Z9 (Sprint 02): widoki starego panelu podobieństw wycofane razem ze starym frameworkiem.
      ReleaseNotesView,
      ChatView,
    };
  }

  // GETTERS
  get obsidian() { return Obsidian; }
  get api() { return this._api; }
  async onload() {
    log.info('Plugin', `=== PKM Assistant v${this.manifest.version} START ===`);
    log.debug('Plugin', 'onload() — rejestracja komponentów');
    this._ready = false;
    this._readyCallbacks = [];
    this.app.workspace.onLayoutReady(this.initialize.bind(this));
    // E-02: runtime powstaje synchronicznie i tanio, PRZED pierwszym `await` — od tej linijki
    // `this.env` jest różne od `null` przez całe życie pluginu. `boot()` leci fire-and-forget.
    this.env = new PluginRuntime(this as PluginDynamic, this.runtimeConfig);
    // Rejestr embeddingu jest SLOTEM runtime'u, nie jego wytwórnią (`core/` nie importuje
    // z modułów) — wstawia go composition root, ZANIM `boot()` obudzi konsumentów
    // (`VaultIndexer`, `EmbeddingHelper`, sekcja „Modele" w Ustawieniach). Bez tej linijki
    // runtime zostaje z pustym rejestrem fail-closed i semantyka jest martwa mimo
    // skonfigurowanego dostawcy. Ustawienia czytane LENIWIE — zmiana dostawcy w Ustawieniach
    // działa bez restartu, a rejestr niczego nie dopisuje do worka (boot nie pisze).
    this.env.embeddings = new EmbeddingRegistry({
      // `core/` opisuje dostawców STRUKTURALNIE (`{ info: { id } }`), bo nie wolno mu importować
      // z modułów — zawężenie do konkretnego kontraktu należy do composition roota. Mapa jest
      // ta sama, którą zarejestrował `buildRuntimeConfig`, więc harness podmienia ją JEDNYM
      // podstawieniem w `plugin.runtimeConfig`, przed `onload()`.
      providers: this.runtimeConfig.embedding.providers as PluginDynamic,
      http: this.runtimeConfig.embedding.http,
      settings: () => this.env?.settings,
      log,
    });
    void this.env.boot();
    log.debug('Plugin', 'PluginRuntime utworzony, boot() wystartował');
    this.addSettingTab(new this.settingsTabClass(this.app as PluginDynamic, this as PluginDynamic));
    registerPkmIcon();
    // `registerItemViews()` ZOSTAJE tutaj: Obsidian odtwarza zapisane zakładki przy
    // layoutReady, więc typ widoku musi być znany zanim to nastąpi.
    this.registerItemViews();
    registerAgentSidebar(this);
    // E2.9 FAZA B (B1): render bloku ```pkm-artefakt``` (guziki akceptacji/przywołania w notatce).
    registerArtifactBlocks(this);

    // F2.16 + review W5-01/W5-04: komendy i wstążka MUSZĄ się rejestrować tutaj, w `onload()`.
    // F2.16 przeniosło je do `initialize()` (za `setLocale()`), przez co zależały od UDANEGO
    // bootu środowiska: wywrotka `PluginRuntime.boot()` = zero komend w palecie i zero ikon na wstążce,
    // a ikony wędrowały na koniec paska (Obsidian układa je w kolejności rejestracji).
    // Zostaje jednak prawdziwy powód F2.16: Obsidian zapamiętuje nazwę w chwili
    // `addCommand`/`addRibbonIcon`, więc język musi być znany WCZEŚNIEJ — stąd samodzielny,
    // tani odczyt `read_ui_language()` (jeden plik JSON), niezależny od całego env.
    // `initialize()` woła `setLocale()` jeszcze raz na w pełni zmergowanych ustawieniach —
    // to idempotentne i pilnuje przypadku, w którym tani odczyt nic nie znalazł.
    setLocale(await readUiLanguage(this.app?.vault?.adapter as PluginDynamic));
    this.registerCommands();
    this.registerRibbonIcons();
    log.debug('Plugin', 'onload() zakończone — czekam na layoutReady → initialize()');
  }

  /**
   * Register a callback to run when the plugin is fully initialized.
   * If already ready, the callback fires immediately.
   */
  onReady(callback: () => void) {
    if (this._ready) {
      callback();
    } else {
      this._readyCallbacks.push(callback);
    }
  }

  /**
   * Returns a Promise that resolves when the plugin is fully initialized.
   */
  waitForReady(): Promise<void> {
    if (this._ready) return Promise.resolve();
    return new Promise<void>(resolve => this._readyCallbacks.push(resolve));
  }

  /**
   * Show a Crystal Soul styled notification.
   * @param {string} message - notification text
   * @param {object} opts
   * @param {'info'|'success'|'warning'|'error'|'agent'} opts.type - color variant
   * @param {number} opts.timeout - auto-dismiss ms (default 4000, 0=persistent)
   * @param {string} opts.agentColor - hex color for type='agent'
   */
  /**
   * Apply user's personal color as a global CSS variable.
   * Called on init and from settings when user picks a new color.
   */
  applyUserColor(hex?: string) {
    const color = hex || this.env?.settings?.pkmAssistant?.userColor;
    if (color) {
      document.body.style.setProperty('--cs-user-color', color);
    }
  }

  /**
   * One-time migration: old model keys → modelLibrary format.
   * Only runs if modelLibrary doesn't exist yet.
   *
   * Migracja slotu 'master' (rola stratega) ZAMKNIĘTA 2026-09-02 (fabryka kasacji martwego
   * kodu S1, AUD-dead-code-173) — stary klucz `pkm.masterPlatform`/`masterModel` w
   * settings.json usera jest od teraz ignorowany. Slot `modelLibrary.master` był tylko do
   * zapisu: ta migracja go pisała, a `modelResolver.ts` po E3.6 nigdy go nie czytał (żaden
   * produkcyjny wołacz `createModelForRole`/`getModelsForRole` nie pytał o rolę stratega).
   */
  _migrateToModelLibrary() {
    const pkm = this.env?.settings?.pkmAssistant;
    if (!pkm || pkm.modelLibrary) return; // already migrated or no settings

    const sc = this.env?.settings?.pkmAssistant?.chat || {};
    const lib: PluginDynamic = { main: [], minion: [] };

    // Main model
    const mainPlatform = sc.platform;
    const mainModel = mainPlatform ? sc[`${mainPlatform}_model`] : null;
    if (mainPlatform && mainModel) {
      lib.main.push({ platform: mainPlatform, model: mainModel, isDefault: true });
    }

    // Minion model
    if (pkm.minionPlatform && pkm.minionModel) {
      lib.minion.push({ platform: pkm.minionPlatform, model: pkm.minionModel, isDefault: true });
    }

    const hasAnything = lib.main.length + lib.minion.length > 0;
    if (hasAnything) {
      // Realna migracja starych pól — zapis celowy i natychmiastowy.
      pkm.modelLibrary = lib;
      void this.env?.settingsStore?.save();
      log.info('Plugin', `Model Library: zmigrowano (main: ${lib.main.length}, minion: ${lib.minion.length})`);
    } else {
      // Nic do zmigrowania (świeży user albo load zdegradowany do defaultów po incydencie
      // dysku) — pusta biblioteka żyje w RAM przez SUROWY worek, z pominięciem proxy:
      // mutacja przez proxy zaplanowałaby zapis ustawień, a boot nie może pisać na dysk
      // (pancerz incydentu 2026-07-28). Na dysk trafi przy pierwszym realnym zapisie.
      const rawBag = (this.env?.settingsStore.raw as PluginDynamic)?.pkmAssistant;
      if (rawBag) rawBag.modelLibrary = lib;
    }
  }

  showCrystalNotice(message: string, opts: PluginDynamic = {}) {
    const { type = 'info', timeout = 4000, agentColor } = opts;
    // `createFragment()` — globalna pomocnicza Obsidiana (obsidianmd/prefer-create-el).
    // `test-support/dom-shim.ts` dokłada ją do `globalThis` (ogony-ogA, fala 3, 2026-09-04),
    // więc kod wstaje identycznie i w Obsidianie, i w harnessie (goły Node).
    const frag = createFragment();

    const header = frag.createDiv({ cls: 'cs-notice__header' });
    header.createSpan({ cls: 'cs-notice__diamond', text: '\u25C6' });
    // sentence-case chce „Pkm assistant" — to nazwa własna pluginu, nie zdanie UI.
    header.createSpan({ cls: 'cs-notice__title', text: `PKM Assistant` });

    const bodyCls = type !== 'info' ? `cs-notice__body cs-notice__body--${type}` : 'cs-notice__body';
    frag.createDiv({ cls: bodyCls, text: message });

    const notice = new Notice(frag, timeout);
    // `noticeEl` jest deprecated (@typescript-eslint/no-deprecated). Prawdziwy układ DOM
    // powiadomienia (zweryfikowany bezpośrednio w zainstalowanym Obsidianie 1.12.7, kod
    // `Notice`): `containerEl` to element ZEWNĘTRZNY z klasą `notice` (ten, w który celuje
    // arkusz skina `.notice.cs-notice` i `borderLeftColor`), a `messageEl`/`noticeEl`
    // (deprecated) wskazują na TEN SAM element WEWNĘTRZNY (`notice-message`) — dziś to
    // dosłownie jeden i ten sam obiekt (`this.messageEl = this.noticeEl = …`), więc oba pola
    // dawały ten sam (wewnętrzny) węzeł. `containerEl` (`@since 1.8.7`, bezpieczne przy
    // minAppVersion 1.11.0) jest więc JEDYNYM oficjalnym polem dającym element zewnętrzny —
    // dokładnie ten, który miał na myśli autor tego kodu (rama/tło/pasek koloru).
    notice.containerEl.addClass('cs-notice');

    if (type === 'agent' && agentColor) {
      notice.containerEl.style.setProperty('--cs-notice-agent-color', agentColor);
      notice.containerEl.style.borderLeftColor = agentColor;
    }
    return notice;
  }

  onunload() {
    log.debug('Main', "Unloading PKM Assistant plugin");
    // Z7 (AUD-bledy-054/056): NAJPIERW ZATRZYMAJ BIEGI, POTEM ODEPNIJ KANAŁY. Demontaż zrywał
    // szynę zdarzeń i czyścił mapę uchwytów abortu BEZ ich wywołania, a `mcpClient`/`toolRegistry`
    // żyją do końca procesu — sub odpalony w tle mielił po wyładowaniu dalej (realne narzędzia
    // na vaultcie, do 900 s), i to bez śladu w trace.log, bo konsumenci byli już odpięci.
    // `stopAll` tylko WOŁA uchwyty (abort streamu + flaga pętli) — nie czekamy na zejście
    // biegów, bo Obsidian nie czeka na obietnice z `onunload`.
    this.subTaskRegistry?.stopAll?.('unload');
    // Z7, druga siatka: bieg, który nie zdążył założyć bytu w rejestrze (config/model/prompt
    // budują się przed `onTaskCreated`), nie ma w nim uchwytu — jego kontrolka abortu żyje
    // po stronie narzędzia delegacji. Tam też trzeba sięgnąć, zanim znikną kanały.
    try { stopAllDelegations('unload'); } catch (e) { log.warn('Main', 'stopAllDelegations padł (demontaż leci dalej):', e); }
    // E3.1: zamknij zewnętrzne serwery MCP (SIGTERM procesów stdio) — nie zostawiać zombie.
    // Fire-and-forget: onunload jest synchroniczne, Obsidian nie czeka na obietnicę.
    this.externalMcpManager?.closeAll?.();
    // S28 D5: odepnij nasłuch sprzątania skrzynki (i porzuć kolejkę czekających modali).
    this._komunikatorCleanupUnsub?.();
    this._komunikatorCleanupUnsub = null;
    // F1/F2: odepnij konsumentów rejestru subów PRZED zamknięciem trace'u (rejestr do niego
    // pisze). Notifier jest konsumentem rejestru, więc znika PIERWSZY — inaczej odpinałby
    // subskrypcję od szyny, której już nie ma.
    this.subTaskNotifier?.dispose?.();
    this.subTaskNotifier = null;
    this.subTaskRegistry?.dispose?.();
    this.subTaskRegistry = null;
    // AUD-bledy-035: watcher plików agentów wiesza trzy nasłuchy na vaulcie POZA
    // `registerEvent` — bez tego wyłączony plugin dalej przeładowywał agentów (i dopisywał
    // pliki do vaulta) przy każdym zapisie yamla.
    try { this.agentManager?.dispose?.(); } catch (e) { log.warn('Main', 'AgentManager.dispose padł:', e); }
    // AUD-bledy-037: zdejmij WŁASNE arkusze (motyw usera, skin, CSS modułów) i znaczniki
    // z `document.body` — wyłączony plugin nie ma prawa dalej stylizować Obsidiana, a każdy
    // cykl wyłącz/włącz dokładał kolejne arkusze do `document.adoptedStyleSheets`.
    try {
      SkinManager.dispose?.();
      this._crystalSoulSheet = null;
      removeAdoptedSheets();
      document.body?.style?.removeProperty('--cs-user-color');
    } catch (e) {
      log.warn('Main', 'Zdejmowanie arkuszy CSS padło:', e);
    }
    this.traceLog?.dispose();   // flush + dispose trace sink (fail-soft, fire-and-forget)
    this.notices?.unload();
    void this.env?.dispose();
    // AUD-bledy-059/038: sink `pkm-assistant.log` zamykamy NA KOŃCU — kroki wyżej jeszcze
    // logują, a bufor czekał dotąd na debounce (1000 ms) i przy zamknięciu Obsidiana tuż po
    // wyłączeniu pluginu ogon logu z demontażu ginął bez śladu. Fire-and-forget, bo
    // `onunload` jest synchroniczne i Obsidian nie czeka na obietnicę.
    void log.disposeFileSink();
  }

  async initialize() {
    const initStart = Date.now();
    log.info('Plugin', 'initialize() START — czekam na runtime...');

    // S35: MUSI pójść przed pierwszym loadData() (isNewUser() niżej) — inaczej po
    // zmianie id pluginu user dostaje powitanie „nowy użytkownik" i modal Release Notes.
    // Od S35 id = 'pkm-assistant', więc wywołanie jest ŻYWE (wcześniej inertne przez guard).
    await migrateOldPluginFolder({
      adapter: this.app?.vault?.adapter,
      // Folder konfiguracji NIE musi się nazywać `.obsidian` — user może go zmienić, więc
      // pytamy Obsidiana. Twardy fallback zniknął stąd; `migrateOldPluginFolder` ma własny
      // (`configDir || '.obsidian'`), więc zachowanie bez zmian.
      configDir: this.app?.vault?.configDir,
      manifestId: this.manifest?.id,
      log,
    });

    // Restore debug mode from settings as early as possible
    const earlyPkm = this.env?.settings?.pkmAssistant;
    if (earlyPkm?.debugMode) {
      log.setDebug(true);
    }

    // New-user onboarding: wizard wyłączony w v2.0 (planowany powrót w v3.0).
    // Decyzja Mapa-8 (2026-04-26): wizard ma 31 znalezisk + 5×🔴 — defer do v3 z gruntownym rewrite.
    // OnboardingModal kod zostaje w modules/onboarding/ jako szkielet do reactivation w v3.
    void this.isNewUser().then(async (is_new: boolean) => {
      if (!is_new) return;
      log.info('Plugin', 'Nowy użytkownik — wizard wyłączony w v2.0, pokazuję notice');
      await this.env?.whenLoaded();
      // sentence-case chciałby „settings → API keys → modele → agenci" — a to nazwy pozycji
      // w UI (zakładka Obsidiana + nasze sekcje ustawień), nie zdanie do zdekapitalizowania.
      new Notice(
        "Onboarding wizard niedostępny w v2.0. Skonfiguruj plugin manualnie w Settings → API Keys → Modele → Agenci.",
        10000
      );
    });

    await this.env?.whenLoaded();

    // Klucze API żyją w .pkm-assistant/settings.json — te wpisy NIGDY nie mogą trafić
    // do repo vaulta usera (idempotentne; addToGitignore dopisuje tylko brakujące).
    // K8 (AUD-security-029): lista wpisów żyje w core/security/keySanitizer.ts, żeby dało
    // się ją objąć testem bez Obsidiana. Doszły logi pluginu i pliki sesji pamięci agentów.
    for (const entry of VAULT_GITIGNORE_ENTRIES) void this.addToGitignore(entry);
    log.timing('Plugin', 'runtime loaded', initStart);

    // Re-check debug mode after env is loaded (settings now available)
    const pkmSettings = this.env?.settings?.pkmAssistant;
    if (pkmSettings?.debugMode) {
      log.setDebug(true);
    }

    // Set UI language from settings (default: 'en')
    // Drugie (i ostatnie) `setLocale` w bootcie: `onload()` ustawił język z taniego odczytu
    // `.pkm-assistant/settings.json`, tutaj mamy go już z w pełni zmergowanych ustawień.
    // Wywołanie jest idempotentne — przy zgodnych wartościach nie zmienia nic, a ratuje
    // przypadek, w którym tani odczyt trafił na nieczytelny plik.
    setLocale(pkmSettings?.language || 'en');

    // E1.8: optional file-log sink — mirror logs to .pkm-assistant/logs/pkm-assistant.log so an
    // agent can smoke-test by reading files. No-op-safe; default on (settings flag).
    try {
      log.initFileSink({
        adapter: this.app.vault.adapter,
        enabled: pkmSettings?.fileLogEnabled !== false,
        level: pkmSettings?.debugMode ? 'debug' : 'info',
      });
      log.info('Plugin', `File-log sink: ${log.fileSinkActive ? 'ON (.pkm-assistant/logs/pkm-assistant.log)' : 'off'}`);
    } catch (e) {
      log.warn('Plugin', 'File-log sink init failed:', e);
    }

    // E2.2: cienki trace przebiegu pętli agenta → .pkm-assistant/logs/trace.log.
    // Osobny sink od pkm-assistant.log (obserwowalność pętli, nie ogólny log). Fail-soft.
    try {
      const traceSink = new LogFileSink({
        adapter: this.app.vault.adapter,
        path: '.pkm-assistant/logs/trace.log',
      });
      void traceSink.init(); // async dir + rotacja; buforowane write'y czekają wewnętrznie
      this.traceLog = new TraceLog({
        sink: traceSink,
        enabled: pkmSettings?.traceEnabled !== false,
        mask: maskSensitiveData,
      });
      log.info('Plugin', `Trace pętli agenta: ${this.traceLog.active ? 'ON (.pkm-assistant/logs/trace.log)' : 'off'}`);
    } catch (e) {
      log.warn('Plugin', 'Trace log init failed:', e);
    }

    // F1: rejestr biegów sub-agentów. Musi wstać PO traceLogu, bo dostaje go w konstruktorze
    // jako pierwszego konsumenta zdarzeń (`task:step` → linia w trace.log, format bez zmian).
    // Fail-soft: brak rejestru = SubAgentRunner wraca na ścieżkę sprzed F1 (trace wprost).
    try {
      this.subTaskRegistry = new SubTaskRegistry({
        traceLog: this.traceLog,
        mask: maskSensitiveData,
      });
      // F2 (delegacja w tle): skrzynka wyników subów odpalonych w tle. Bez rejestru nie ma
      // czego słuchać, więc wstaje tylko razem z nim. Dostawcę (czat) podłącza FAZA B przez
      // `subTaskNotifier.setDeliverer(...)`; do tego czasu wyniki po prostu czekają w kolejce.
      if (this.subTaskRegistry) {
        this.subTaskNotifier = new SubTaskNotifier({ registry: this.subTaskRegistry });
      }
    } catch (e) {
      log.warn('Plugin', 'SubTaskRegistry init failed:', e);
    }

    this.secretsStorage = new SecretsStorage(this.app);
    await this._unlockSecureStorageAtStartup();

    // Apply user color globally
    this.applyUserColor();

    // SkinManager: active visual skin (Crystal Soul by default, Default/Custom optional)
    try {
      await SkinManager.initialize(this as PluginDynamic);
      this.skinManager = SkinManager;
      log.info('Plugin', `SkinManager OK: aktywny skin ${SkinManager.getActiveSkinId()}`);
    } catch (e) {
      log.warn('Plugin', 'SkinManager init failed:', e);
    }

    // Migrate old model settings to modelLibrary (one-time)
    this._migrateToModelLibrary();

    // Z11 (Sprint 02): force pick embedding provider — bez defaultu. Notice jeśli pusty.
    this._checkEmbeddingProviderConfigured();

    // AgentManager
    try {
      log.debug('Plugin', 'Inicjalizacja AgentManager...');
      this.agentManager = new AgentManager(this.app.vault, this.env?.settings || {}, this as PluginDynamic);
      await this.agentManager.initialize();
      const agentCount = this.agentManager.agents?.size || 0;
      const activeAgent = this.agentManager.activeAgent?.name || 'brak';
      log.info('Plugin', `AgentManager OK: ${agentCount} agentów, aktywny: ${activeAgent}`);
    } catch (e) {
      log.error('Plugin', 'AgentManager FAIL:', e);
    }

    // E2.9 FAZA D: stary ArtifactManager (JSON w .pkm-assistant/artifacts/*.json) + store'y RAM
    // _planStore/_chatTodoStore/_chatTodoVersion SKASOWANE. Migrator (D4) przenosi stare JSONy na
    // notatki; artefakty żywe żyją jako notatki w vaulcie (ArtifactStore).

    // E2.9: silnik artefaktów żywych. Typy z AgentManager
    // (owner ArtifactTypeLoader). Folder z ustawień (A5) lub domyślny w store.
    try {
      this.artifactStore = new ArtifactStore({
        app: this.app,
        typeLoader: this.agentManager?.artifactTypeLoader,
        getArtifactsFolder: () => this.env?.settings?.pkmAssistant?.artifactsFolder as string,
        // AUD-wydajnosc-059/030/021/051: rejestr artefaktów utrzymuje się zdarzeniami
        // vaulta/metadataCache (patrz modules/artifacts/CLAUDE.md) — sprzątanie nasłuchów
        // przy onunload/reload pluginu, wzór `plugin` w `new VaultIndexer({...})` wyżej.
        registerEvent: (ref) => this.registerEvent(ref as EventRef),
      });
      // E2.9 FAZA D (D4): jednorazowy migrator starych JSONów (ArtifactManager) → notatki (fire-and-forget,
      // idempotentny przez marker). Musi biec PO seedowaniu typów (AgentManager.ensureBuiltinTypes) —
      // AgentManager jest już zainicjalizowany wyżej. Sprzątanie po migratorze.
      migrateJsonArtifactsToNotes({ adapter: this.app.vault.adapter, store: this.artifactStore })
        .then((res) => {
          if (res && !res.skipped) log.info('Plugin', `Migrator artefaktów: ${res.migrated} zmigrowanych, ${res.backedUp} do backupu`);
          return this.artifactStore.archive();
        })
        .catch(() => {});
    } catch (e) {
      log.error('Plugin', 'ArtifactStore FAIL:', e);
    }

    // No-Go folders (from settings → AccessGuard + embedding exclusions)
    AccessGuard.setConfigDir(this.app?.vault?.configDir);
    AccessGuard.setNoGoFolders(this.env?.settings?.pkmAssistant?.no_go_folders);
    // E2.8 B1: vault folder groups (Settings→Vault) → AccessGuard for `{group}` focus resolution.
    AccessGuard.setVaultGroups(this.env?.settings?.pkmAssistant?.vaultGroups as PluginDynamic);

    // E1.4 R1: żywy indeks semantyczny (Orama) → publikuje plugin.oramaDb.
    // Fire-and-forget — start pluginu NIE czeka na skan vaulta (własny catch w initialize()).
    try {
      const embeddingHelper = new EmbeddingHelper(this.env);
      const embedder = {
        isReady: () => { try { return embeddingHelper.isReady(); } catch { return false; } },
        embed: (text: string) => embeddingHelper.embed(text),
        embedBatch: (texts: string[]) => embeddingHelper.embedBatch(texts),
        // model_key = "provider:model" — zmiana któregokolwiek unieważnia indeks (rebuild).
        getModelKey: () => this.env?.embeddings?.default?.modelKey || '',
        // Wymiar wektora zadeklarowany przez adapter (jeśli zna); inaczej VaultIndexer
        // weźmie długość pierwszego zembedowanego wektora.
        getDims: () => {
          try {
            const d = this.env?.embeddings?.default?.dims;
            return (typeof d === 'number' && d > 0) ? d : null;
          } catch { return null; }
        },
      };
      this.vaultIndexer = new VaultIndexer({
        plugin: this,
        vault: this.app.vault as PluginDynamic,
        embedder,
        isMobile: !!Platform?.isMobile,
        logger: log,
        noGoFolders: () => this.env?.settings?.pkmAssistant?.no_go_folders || [],
        // E2.9: wyklucz folder artefaktów z indeksu, dopóki user nie włączy indexArtifacts.
        artifactsExclude: () => (this.env?.settings?.pkmAssistant?.indexArtifacts
          ? null
          : (this.env?.settings?.pkmAssistant?.artifactsFolder || 'PKM Assistant/Artefakty')),
      });
      this.vaultIndexer.initialize(); // no await
    } catch (e) {
      log.error('Plugin', 'VaultIndexer init FAIL:', e);
    }

    // MCP system
    try {
      log.debug('Plugin', 'Inicjalizacja MCP system...');
      this.permissionSystem = new PermissionSystem(this.app.vault, this.env?.settings || {});

      // SUROWY worek (bez proxy): dosztukowanie pustego kontenera `pkmAssistant.security`
      // to provisioning bootowy, nie zmiana usera. Przez obserwowane proxy każdy start
      // pluginu planował zapis CAŁYCH ustawień — a boot nie pisze (pancerz 2026-07-28,
      // ten sam wzór co `PluginRuntime.boot()`). Zapamiętane decyzje approvalu
      // trafiają na dysk przy pierwszym realnym zapisie, przez jawny `onChange` niżej.
      const pluginSettings = this.env?.settingsStore.raw || this.env?.settings || {};
      if (!pluginSettings.pkmAssistant) pluginSettings.pkmAssistant = {};
      if (!pluginSettings.pkmAssistant.security) pluginSettings.pkmAssistant.security = {};
      this.approvalManager = new ApprovalManager(this.app, {
        storage: pluginSettings.pkmAssistant.security,
        onChange: () => this.env?.settingsStore?.save?.(),
      });
      this.approvalManager.setApprovalHandler(requestApproval);
      // Kill-switch komunikatora (przewód z E1.2, semantyka od S28 D7): gate rejestracji
      // narzędzi `kom_*` i katalogu serwerów built-in. OFF = agent w ogóle ich nie widzi.
      const komunikatorEnabled = isKomunikatorEnabled(this.settings);

      this.toolRegistry = new ToolRegistry();
      this.mcpClient = new MCPClient(this.app, this as PluginDynamic, this.toolRegistry);

      // E2.6: read/list = prymitywy ze scope (vault|memory). memory_read/read_summary/
      // list_summaries wchłonięte przez read/list (scope=memory bramkowane uprawnieniem).
      // AUD-dead-code-020/089: fabryki niżej nie czytają `app` (realny `app` dociera do
      // narzędzia dopiero jako 2. argument `execute(args, app, plugin)`) — parametr zdjęty
      // z 16 sygnatur, więc rejestracja już nie potrzebuje rzutowania `as PluginDynamic`.
      this.toolRegistry.registerTool(createReadTool());
      this.toolRegistry.registerTool(createListTool());
      this.toolRegistry.registerTool(createWriteTool());
      this.toolRegistry.registerTool(createDeleteTool());
      this.toolRegistry.registerTool(createCreateFolderTool(this.app));
      // E2.5: JEDNO narzędzie `search` (scope vault/memory) zastąpiło 12 narzędzi retrieval.
      this.toolRegistry.registerTool(createSearchTool());
      this.toolRegistry.registerTool(createMemorySaveTool());
      this.toolRegistry.registerTool(createMemoryDeleteTool());
      // brain_update usunięty w E1.6 — direct brain.md writes wyłączone; runtime pisze przez memory_save / /save session.
      // skill_list/skill_execute skasowane w E2.4 (D17) — skille odkrywane indeksem w prompcie, przepis przez read().
      this.toolRegistry.registerTool(createDelegateTool(this.app));
      // agent_delegate stays: it works without the communicator (context ping is optional/null-safe).
      this.toolRegistry.registerTool(createAgentDelegateTool());
      // S28: poczta (kom_send/kom_list/kom_read) zależy od KomunikatorManagera — tylko przy fladze ON.
      if (komunikatorEnabled) {
        for (const tool of createKomunikatorTools()) {
          this.toolRegistry.registerTool(tool);
        }
        // S28 D5: modal sprzątania po drugim ptaszku (kolejka — jeden modal na raz).
        this._komunikatorCleanupUnsub = registerKomunikatorCleanup(this);
      }
      // E2.9: artefakty żywe (gatunek 1). Stare chat_todo/idea_review/plan_review skasowane (aliasy).
      this.toolRegistry.registerTool(createArtifactCreateTool());
      this.toolRegistry.registerTool(createArtifactReadTool());
      this.toolRegistry.registerTool(createArtifactUpdateTool());
      this.toolRegistry.registerTool(createArtifactListTool());
      // E2.9 FAZA D: prymitywne todo agenta (gatunek 2, default ON).
      this.toolRegistry.registerTool(createTodoTool());
      this.toolRegistry.registerTool(createWebSearchTool());
      this.toolRegistry.registerTool(createWebReadTool());
      this.toolRegistry.registerTool(createAskUserTool());
      this.toolRegistry.registerTool(createGenerateImageTool());
      this.toolRegistry.registerTool(createAddTextToImageTool());

      // Fix znaleziska TS-3 #10: ToolLoader (definicje z `.pkm-assistant/tools/*.json`) SKASOWANY —
      // od wyburzenia sandboxa (E3.1) rejestrował narzędzia-wabiki, których execute ZAWSZE zwracał
      // błąd „requires external MCP server". Zewnętrzne narzędzia = ExternalMcpManager.
      const toolCount = this.toolRegistry.tools?.size || 0;
      log.info('Plugin', `MCP system OK: ${toolCount} narzędzi zarejestrowanych`);

      // ServerManager — dynamic MCP server packages (Faza 2)
      this.serverManager = new ServerManager(this.app, this, { komunikatorEnabled });
      await this.serverManager.initialize();
      this.serverManager.syncBuiltInServersForAgent(this.agentManager?.getActiveAgent?.());

      // Built-in MCP servers follow the active agent's mcp_servers whitelist.
      if (this.agentManager) {
        this.agentManager.on((event: string, data: PluginDynamic) => {
          const lifecycleEvents = ['agent:switched', 'agents:loaded', 'agents:reloaded', 'agent:updated'];
          if (!lifecycleEvents.includes(event)) return;
          const activeAgent = this.agentManager?.getActiveAgent?.();
          if (event === 'agent:updated' && data?.agent !== activeAgent?.name) return;
          this.serverManager?.syncBuiltInServersForAgent(activeAgent);
        });
      }

      // E3.1 faza A: prawdziwy klient MCP — zewnętrzne serwery (stdio/HTTP przez SDK).
      // Autostart serwerów z enabled+autostart; cichy fail (D-D) — błąd zewnętrznego serwera
      // nie może wywalić wbudowanego systemu MCP. closeAll() woła onunload (patrz niżej).
      //
      // K11 (AUD-security-005): autostart NIE bramkuje `_ready` (wzór `vaultIndexer.initialize()`
      // wyżej). Do K11 czekaliśmy tu sekwencyjnie na każdy serwer, więc jeden, który przyjmuje
      // transport i milczy, trzymał czat i sidebar na spinnerze przez cały swój budżet.
      // Serwery dołączają, kiedy wstaną — do tego czasu ich narzędzi po prostu nie ma.
      try {
        this.externalMcpManager = new ExternalMcpManager(this as PluginDynamic, { isMobile: !!Platform?.isMobile });
        void this.externalMcpManager.autostart();
      } catch (e: PluginDynamic) {
        log.warn('Plugin', 'External MCP autostart problem (ignorowane):', e?.message);
      }
    } catch (e: PluginDynamic) {
      log.error('Plugin', 'MCP system FAIL:', e);
    }

    // Context menu: "Send to assistant" + "Inline comment"
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: PluginDynamic, editor: PluginDynamic, view: PluginDynamic) => {
        const selection = editor.getSelection();
        if (selection && selection.trim().length > 0) {
          menu.addItem((item: PluginDynamic) => {
            item.setTitle(t('main.send_to_assistant'))
              .setIcon('message-square')
              .onClick(() => {
                const filePath = view?.file?.path || '';
                new SendToAgentModal(this.app, this as PluginDynamic, selection, filePath).open();
              });
          });
          menu.addItem((item: PluginDynamic) => {
            item.setTitle(t('main.comment_to_assistant'))
              .setIcon('edit')
              .onClick(() => {
                const filePath = view?.file?.path || '';
                new InlineCommentModal(this.app, this, selection, filePath).open();
              });
          });
        }
      })
    );

    await this.show_release_notes_if_new_version();

    // Crystal Soul: load custom theme overrides
    await this._loadCrystalSoulTheme();

    // Signal that plugin is fully initialized
    this._ready = true;
    for (const cb of this._readyCallbacks) {
      try { cb(); } catch (e) { log.error('Plugin', 'onReady callback error:', e); }
    }
    this._readyCallbacks = [];

    log.timing('Plugin', 'PEŁNA INICJALIZACJA', initStart);
    log.info('Plugin', `=== PKM Assistant v${this.manifest.version} GOTOWY ===`);

    // Show "ready" notification
    const agentCount = this.agentManager?.agents?.size || 0;
    const activeAgent = this.agentManager?.activeAgent;
    const elapsed = ((Date.now() - initStart) / 1000).toFixed(1);
    this.showCrystalNotice(
      t('main.ready', { time: elapsed, count: agentCount, plural: agentCount === 1 ? '' : 's', active: activeAgent?.name || '—' }),
      { type: 'success', timeout: 3000 }
    );
  }

  async _unlockSecureStorageAtStartup() {
    const settings = this.env?.settings;
    const secureStorage = settings?.pkmAssistant?.secureStorage;
    if (!settings || !secureStorage?.enabled) return null;

    if (this.secretsStorage.backend === 'unavailable') {
      log.warn('Plugin', 'Secure storage unavailable: Web Crypto API missing.');
      new Notice('Secure storage unavailable. API keys stay locked.', 10000);
      return null;
    }

    const refs = secureStorage.refs || {};
    if (Object.keys(refs).length === 0) {
      return this.secretsStorage.hydrateSettings(settings);
    }

    const password = await MasterPasswordModal.request(this.app, {
      title: 'Unlock API keys',
      description: 'Enter your master password to unlock encrypted API keys for this session. Esc keeps the plugin running without API keys.',
      confirm: false,
      submitLabel: 'Unlock',
    });

    if (password) {
      try {
        await this.secretsStorage.unlock(password, secureStorage.masterSalt);
      } catch (error: PluginDynamic) {
        log.warn('Plugin', 'Secure storage unlock failed:', error?.message || error);
        new Notice('Secure storage unlock failed. API keys stay locked.', 10000);
      }
    } else {
      log.warn('Plugin', 'Secure storage not unlocked on startup. API keys stay unavailable until manual unlock.');
      // „API keys" to skrótowiec, „Settings" to nazwa zakładki Obsidiana — sentence-case
      // zrobiłby z nich „api keys"/„settings", co czyta się jak literówka.
      new Notice('Secure storage locked. API keys unavailable until unlock in Settings.', 10000);
    }

    const status = await this.secretsStorage.hydrateSettings(settings);
    if (status?.missing?.length) {
      log.warn('Plugin', `Secure storage hydrate incomplete: ${status.missing.length} key(s) unavailable.`);
    }
    return status;
  }

  /**
   * Crystal Soul: Load custom theme CSS from .pkm-assistant/theme.css
   * This file can be edited by user or written by agents via vault_write.
   * It overrides Crystal Soul --cs-* variables.
   */
  async _loadCrystalSoulTheme() {
    const THEME_PATH = '.pkm-assistant/theme.css';
    try {
      const exists = await this.app.vault.adapter.exists(THEME_PATH);
      if (!exists) return;

      const css = await this.app.vault.adapter.read(THEME_PATH);
      if (!css.trim()) return;

      if (this._crystalSoulSheet) {
        this._crystalSoulSheet.replaceSync(css);
      } else {
        this._crystalSoulSheet = new CSSStyleSheet();
        this._crystalSoulSheet.replaceSync(css);
        // AUD-bledy-037: przez `adoptSheet` — `onunload` zdejmuje arkusz zamiast zostawiać
        // motyw usera nad wyłączonym pluginem aż do restartu Obsidiana.
        adoptSheet(this._crystalSoulSheet);
      }
      log.info('Plugin', 'Crystal Soul custom theme loaded');
    } catch (e: PluginDynamic) {
      log.warn('Plugin', 'Crystal Soul theme load failed:', e);
    }
  }

  /**
   * Crystal Soul: Generate default theme.css template
   */
  async generateCrystalSoulTemplate() {
    const THEME_PATH = '.pkm-assistant/theme.css';
    const template = `/* Crystal Soul — Theme Customization
 * ${t('theme.comment')}
 */

.theme-dark, .theme-light {
  /* ${t('theme.accent')} */
  /* --cs-shard-color: var(--interactive-accent); */

  /* ${t('theme.diamond')} */
  /* --cs-diamond-size: 5px; */

  /* ${t('theme.border')} */
  /* --cs-border-accent-width: 3px; */

  /* ${t('theme.animation')} */
  /* --cs-breathing-duration: 3s; */

  /* ${t('theme.agent_colors')} */
  /* --cs-agent-amber-h: 37; --cs-agent-amber-s: 77%; --cs-agent-amber-l: 49%; */
  /* --cs-agent-aqua-h: 131; --cs-agent-aqua-s: 21%; --cs-agent-aqua-l: 51%; */
  /* --cs-agent-purple-h: 330; --cs-agent-purple-s: 29%; --cs-agent-purple-l: 46%; */
  /* --cs-agent-blue-h: 182; --cs-agent-blue-s: 33%; --cs-agent-blue-l: 40%; */
}
`;
    await this.app.vault.adapter.write(THEME_PATH, template);
    log.info('Plugin', 'Crystal Soul template wygenerowany');
    return THEME_PATH;
  }

  /**
   * Initialize ribbon icons with default visibility.
   */

  get ribbonIcons () {
    return {
      chat: {
        iconName: "pkm-icon",
        // F2.19: był twardy angielski napis — teraz przez i18n, jak bliźniacze `agents` niżej.
        description: t('main.ribbon_chat'),
        callback: () => { this.openChatView(); }
      },
      agents: {
        iconName: "users",
        description: t('main.agent_sidebar'),
        callback: () => { void openAgentSidebar(this); }
      }
    }
  }

  openChatView() {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (leaves.length > 0) {
      void this.app.workspace.revealLeaf(leaves[0]);
    } else {
      const leaf = this.app.workspace.getRightLeaf(false);
      void leaf!.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    if (this.app.workspace.rightSplit.collapsed) {
      this.app.workspace.rightSplit.toggle();
    }
  }

  /**
   * Send inline comment to active chat view.
   * Opens chat if not open, then sends a formatted message for the agent to edit the file.
   */
  sendInlineComment(filePath: string, selectedText: string, comment: string) {
    this.openChatView();
    // AUD-code-review-036: ten jednorazowy budzik był GOŁYM setTimeout, dokładnie ta sama
    // klasa błędu, którą naprawiono w budziku updatera (AUD-bledy-036/060; sam updater wycięty
    // 2026-09-04 przed katalogiem — D1, patrz show_release_notes_if_new_version) —
    // wyłączenie pluginu w oknie 300 ms strzelało na zdemontowanym egzemplarzu. registerInterval
    // przyjmuje uchwyt obu rodzajów (clearInterval kasuje w JS też uchwyty setTimeout). Guard na
    // `input_area`/`send_message` chroni drugą krawędź tego samego wyścigu: widok czatu jeszcze
    // się buduje (plugin nie jest `_ready`), więc `ChatView.renderView()` nie zdążył postawić pola.
    this.registerInterval(window.setTimeout(() => {
      const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
      if (leaves.length === 0) return;
      const chatView = leaves[0].view as PluginDynamic;
      if (!chatView?.input_area || typeof chatView.send_message !== 'function') {
        log.warn('Main', 'sendInlineComment: widok czatu jeszcze nie gotowy — komentarz porzucony');
        return;
      }
      const msg = [
        t('main.inline_comment'),
        t('main.file', { file: filePath }),
        t('main.fragment'),
        '```',
        selectedText,
        '```',
        t('main.what_to_change', { comment })
      ].join('\n');
      chatView.input_area.value = msg;
      // K7: wiadomość składa KOD z fragmentu notatki — user dopisał tylko komentarz, więc
      // przywileje człowieka (rejestr adresów, markery `@@skill:`, komendy `/`) nie należą się
      // treści zaznaczenia. Patrz core/security/messageOrigin.ts.
      chatView.send_message({ meta: MACHINE_MESSAGE_META });
    }, 300));
  }

  /**
   * Pokaż „co nowego" po podbiciu wersji pluginu — czysto lokalne, bez sieci.
   *
   * D1 (2026-09-04): updater wycięty 2026-09-04 przed katalogiem. Ta metoda odpytywała
   * `api.github.com` co 3 h (budzik 3 s + interwał 10800000 ms, oba przez `registerInterval`
   * — AUD-bledy-036/060) i podnosiła Notice o nowej wersji. Katalog społeczności zabrania
   * mechanizmów aktualizujących plugin, a samo sprawdzanie było i tak zbędne: katalog i BRAT
   * aktualizują same. Był to jedyny ruch sieciowy pluginu niewynikający z akcji usera.
   * Razem z nim poszły: `check_for_update()`, import `isNewerVersion` (+ `core/utils/versionCompare.ts`),
   * pomocnik żądań HTTP Obsidiana i pole `update_available`.
   */
  async show_release_notes_if_new_version() {
    if (await this.isNewPluginVersion(this.manifest.version)) {
      log.debug('Main', "opening release notes modal");
      try {
        void (ReleaseNotesView as PluginDynamic).openForVersion(this.app.workspace, this.manifest.version);
      } catch (e) {
        log.error('Main', 'Failed to open ReleaseNotesView', e);
      }
      await this.setLastKnownVersion(this.manifest.version);
    }
  }

  /**
   * Bridge: sync user's embed model preference to new embeddings collection.
   * The settings tab saves to env.settings.pkmAssistant.embedding[adapter].model_key
   * but the embedding registry keeps EmbeddingModel items instead.
   * If provider changed (e.g. transformers → ollama), creates a new model item.
   */
  /**
   * Z11 (Sprint 02): force pick embedding provider.
   *
   * Decyzja Kuby z Mapa-16 Q3: brak default providera, user musi explicit wybrać.
   * Plugin start: jeśli `embed_model.adapter` pusty → notice "Embedding niedostępny →
   * Settings → Embedding". NIE auto-detect z env vars (eksplicytna decyzja userowska).
   */
  _checkEmbeddingProviderConfigured() {
    try {
      const provider = this.env?.settings?.pkmAssistant?.embedding?.provider;
      if (!provider) {
        log.info('Plugin', 'Embedding provider niewybrany — pokazuję notice.');
        new Notice(
          'Embedding niedostępny.\n' +
          'Wybierz providera w Settings → Embedding\n' +
          '(Ollama / OpenAI / Gemini / LM Studio).',
          12000
        );
      }
    } catch (e: PluginDynamic) {
      log.debug('Plugin', 'embedding provider check error (env not ready):', e?.message || e);
    }
  }

  get commands() {
    return {
      ...super.commands,
      // Nazwy komend NIE zawierają nazwy pluginu — Obsidian dokleja "PKM Assistant: "
      // sam w palecie komend (https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
      random_connection: {
        id: "pkm-random-connection",
        name: t('command.random_note'),
        callback: async () => {
          await this.open_random_connection();
        }
      },
      open_chat: {
        id: "pkm-open-chat",
        name: t('command.open_chat'),
        callback: () => {
          this.openChatView();
        }
      },
      open_agents: {
        id: "pkm-open-agents",
        name: t('command.open_agents'),
        callback: () => {
          void openAgentSidebar(this);
        }
      },
      // Z9 (Sprint 02): insert_connections_codeblock wycofane razem z Connections wywałką.
      pkm_selftest: {
        id: "pkm-selftest",
        name: t('command.selftest'),
        callback: async () => { await this.run_self_test(); }
      },
      generate_artifacts_base: {
        id: "generate-artifacts-base",
        name: t('command.artifacts_base'),
        callback: async () => { await this.generate_artifacts_base(); }
      },
    };
  }

  /**
   * S32 Z7: wygeneruj plik `.base` (Obsidian Bases) z dwoma widokami artefaktów
   * („Wszystkie" + „Otwarte") w folderze artefaktów. NIE nadpisuje istniejącego pliku —
   * user mógł go sobie dostosować w GUI Bases.
   *
   * Sesje są poza zasięgiem: ich archiwum żyje w ukrytym `.pkm-assistant/`, którego
   * Obsidian nie indeksuje, więc Bases go nie widzi.
   */
  async generate_artifacts_base() {
    const folder = this.env?.settings?.pkmAssistant?.artifactsFolder || DEFAULT_ARTIFACTS_FOLDER;
    const path = buildArtifactsBasePath(folder);
    try {
      if (this.app.vault.getAbstractFileByPath?.(path)) {
        new Notice(t('artifact.base.exists', { path }), 8000);
        return;
      }
      const dir = path.slice(0, path.lastIndexOf('/'));
      let acc = '';
      for (const part of dir.split('/')) {
        acc = acc ? `${acc}/${part}` : part;
        if (this.app.vault.getAbstractFileByPath?.(acc)) continue;
        try { await this.app.vault.createFolder(acc); } catch { /* wyścig / już istnieje */ }
      }
      await this.app.vault.create(path, buildArtifactsBaseContent(folder));
      log.info('Plugin', `Widok Bases artefaktów wygenerowany: ${path}`);
      new Notice(t('artifact.base.created', { path }), 8000);
    } catch (e: PluginDynamic) {
      log.error('Plugin', 'Generowanie widoku Bases nie powiodło się:', e);
      new Notice(t('artifact.base.failed', { error: e?.message || String(e) }), 8000);
    }
  }

  /**
   * E1.8: run the "PKM Assistant: Self-test" diagnostic — READ-ONLY snapshot of plugin
   * health written to .pkm-assistant/logs/selftest-<stamp>.md (+ Notice summary).
   */
  async run_self_test() {
    try {
      const { buildSelfTestReport, formatSelfTestReport } = await import('../core/selftest.js');
      const report = await buildSelfTestReport(this as PluginDynamic, {
        countDocs: countDocs as PluginDynamic,
        isMobile: !!Platform?.isMobile,
        fileLogActive: log.fileSinkActive,
      });
      const md = formatSelfTestReport(report);

      const now = new Date();
      const p2 = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}-${p2(now.getMinutes())}`;
      const dir = '.pkm-assistant/logs';
      const path = `${dir}/selftest-${stamp}.md`;
      try { if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir); } catch { /* wyścig / już istnieje — jak w generate_artifacts_base wyżej */ }
      await this.app.vault.adapter.write(path, md);

      const { ok, warn, error } = report.summary;
      log.info('Plugin', `Self-test: ${ok} OK, ${warn} warn, ${error} error → ${path}`);
      new Notice(t('selftest.notice_done', { ok, warn, errors: error, path }), 8000);
    } catch (e: PluginDynamic) {
      log.error('Plugin', 'Self-test failed:', e);
      new Notice(t('selftest.notice_fail', { error: e?.message || String(e) }), 8000);
    }
  }

  show_release_notes() {
    return void (ReleaseNotesView as PluginDynamic).openForVersion(this.app.workspace, this.manifest.version);
  }

  async open_random_connection() {
    // Z9 (Sprint 02): panel podobieństw wycofany razem ze starym frameworkiem bazowym.
    // Restore w v3.0 z Orama scoring jeśli wymagane.
    new Notice('Connections feature wycofany w v2.0 — przywrócenie planowane na v3.0 z silnikiem Orama.');
  }

  async openNote(target_path: string, event: PluginDynamic = null) { await openNote(this as PluginDynamic, target_path, event); }

  /**
   * TODO: wynieść do `core/utils/` jako wspólne narzędzie.
   *
   * Dawniej stało tu `@deprecated extract into utility` — nadużycie tagu: `@deprecated`
   * znaczy „nie używaj tego", a metoda jest ŻYWA i wołana z `initialize()` dla
   * `VAULT_GITIGNORE_ENTRIES`. Efekt: lint zgłaszał użycie przestarzałego API na jedynym,
   * całkowicie poprawnym wołaczu. Zamiar (wynieść do utili) zostaje jako zwykłe TODO.
   */
  async addToGitignore(ignore: string, message: string | null = null) {
    if(!(await this.app.vault.adapter.exists(".gitignore"))) return;
    let gitignore_file = await this.app.vault.adapter.read(".gitignore");
    if (gitignore_file.indexOf(ignore) < 0) {
      await this.app.vault.adapter.append(".gitignore", `\n\n${message ? "# " + message + "\n" : ""}${ignore}`);
      log.debug('Main', "Added to .gitignore: " + ignore);
    }
  }

}
