/**
 * core/ — Fundament pluginu PKM Assistant.
 *
 * Publiczne API które każdy moduł może używać. Zasada: poza `core/` wolno
 * importować TYLKO z `core/index.js` (nie z bebechów core/utils/... itd.)
 * — dokładnie tak jak z każdego innego modułu. Od S31 pilnuje tego ESLint
 * (`no-restricted-imports`), a nie już sama konwencja.
 *
 * Kryterium wstępu do core/ (ADR 003): używane przez ≥3 moduły +
 * infrastruktura (nie feature) + zmienia się rzadko.
 *
 * ── KONTRAKT: TEN BARREL JEST NODE-SAFE (S31) ────────────────────────────
 * Ten barrel MUSI dać się zaimportować BEZ Obsidiana. Egzekwuje to `npm test`:
 * AVA nie ma mocka `obsidian` (`"ava".require: []`), a testy importują pliki
 * produkcyjne, które importują ten barrel. Gdy barrel wciągnie `obsidian`,
 * sypie się połowa zestawu testów.
 *
 * ⚠️ Od kampanii TS dawny jednolinijkowiec `node --input-type=module -e
 * "await import('./core/index.js')"` już NIE jest sprawdzianem tego kontraktu:
 * pliki core są w `.ts`, a goły Node (choć strippuje typy) nie podmienia
 * rozszerzenia `.js`→`.ts` w specifierach. Sprawdzianem jest `npm test` (tsx).
 *
 * DLATEGO: pliki core/ dotykające `obsidian` NIE są tu eksportowane. Jest ich
 * dokładnie cztery i deep-importuje je WYŁĄCZNIE `src/main.js` (composition root):
 *   • core/PluginBase.js           (klasa pluginu — extends Obsidian.Plugin)
 *   • core/runtime/PluginRuntime.js (runtime — Notice/Platform/setIcon)
 *   • core/utils/obsidianNav.js    (wrappery nad Obsidian API)
 *   • core/security/MasterPasswordModal.js (Modal/Setting)
 * Dokładanie tu czegokolwiek, co (choćby pośrednio) importuje `obsidian` jako
 * WARTOŚĆ, łamie kontrakt — dlatego `SettingsContent.ts` ładuje MasterPasswordModal
 * leniwie. Sam `import type { … } from 'obsidian'` jest bezpieczny: znika przy
 * transpilacji (esbuild i tsx wycinają go w całości), więc do runtime'u nie trafia.
 *
 * ⚠️ AUD-code-review-037: „dokładnie cztery" liczy TYLKO pliki core/ dotykające
 * `obsidian` — to NIE jest kompletna lista wyjątków lintu na composition root.
 * `eslint.config.js` (`compositionRootPatterns`) ma DWA kolejne, z innym
 * uzasadnieniem: `core/selftest.js` (node-safe, `obsidian` NIE importuje — poza
 * barrelem świadomie, bo `src/main.ts` go ładuje leniwie `await import(...)` na
 * żądanie komendy self-testu, nie na starcie) i `modules/crystal-soul/icons.js`
 * (dotyka `obsidian`, ale fizycznie mieszka w innym module, więc reguła „core/
 * pliki dotykające obsidian" go nie obejmuje z definicji). Pełne uzasadnienie
 * obu — komentarz przy `compositionRootPatterns` w `eslint.config.js`.
 *
 * @see core/CLAUDE.md
 */

// ── Security ─────────────────────────────────────────────
export { AccessGuard } from './security/AccessGuard.js';
export {
  PermissionSystem,
  APPROVAL_DEFAULTS,
} from './security/PermissionSystem.js';
export {
  AUTONOMY_MODES,
  DEFAULT_AUTONOMY,
  normalizeAutonomy,
  classifyToolRisk,
} from './security/autonomy.js';
export { ApprovalManager } from './security/ApprovalManager.js';
export { SecretsStorage } from './security/SecretsStorage.js';
export {
  maskSensitiveData,
  warnIfSensitive,
} from './security/SensitiveDataGuard.js';
export {
  sanitizePath,
  isProtectedPath,
  VAULT_GITIGNORE_ENTRIES,
} from './security/keySanitizer.js';
export { expandFocusEntries } from './security/vaultGroups.js';
// AUD-code-review-033: konwersja glob→regex, dzielona przez `AccessGuard` (jedyny żywy wołacz
// od wywałki VaultZones 2026-09-03).
export { globPatternToRegex } from './security/globPattern.js';
// K9: ogrodzenie niezaufanej treści w system prompcie (jedna funkcja dla wszystkich kanałów).
export {
  fenceUntrusted,
} from './security/promptFence.js';
// K7: proweniencja wiadomości czatu (kto NAPISAŁ tekst tury) — bramka przywilejów człowieka.
export {
  HUMAN_MESSAGE_META,
  MACHINE_MESSAGE_META,
  machineMeta,
  resolveMessageOrigin,
  isHumanMessage,
} from './security/messageOrigin.js';

// ── i18n ─────────────────────────────────────────────────
export { t, setLocale, getLocale, getDateLocale } from './i18n/index.js';

// ── Utils ────────────────────────────────────────────────
export { log } from './utils/Logger.js';
export {
  parseYaml,
  stringifyYaml,
  parseFrontmatter,
  validateAgentSchema,
  setYamlEngine,
} from './utils/yamlParser.js';
export type { YamlEngine } from './utils/yamlParser.js';
export { slugify } from './utils/slugify.js';
// AUD-code-review-029: slug tożsamości agenta (nazwa → fragment ścieżki na dysku), format
// zamrożony — 20 kopii w 8 modułach + core/security ujednolicone na ten helper.
export { getAgentSafeName } from './utils/agentSlug.js';
export {
    countTokens,
    countTokensSimple,
    getTokenCount,
    calibrate,
    // AUD-wydajnosc-017/048: ta sama estymata ze STATYSTYK tekstu (długość + non-ASCII), żeby
    // okno kontekstu czatu mogło liczyć przyrostowo zamiast skanować całą historię co dopisek.
    countTokensFromStats,
    countNonAsciiChars,
} from './utils/tokenCounter.js';
export { EventEmitter } from './utils/EventEmitter.js';
// S31 Z4 — z wchłoniętego `src/utils/`. Oba pliki są czyste (zero `obsidian`), więc wchodzą
// do node-safe barrela.
export { TokenTracker } from './utils/TokenTracker.js';
export { arrayBufferToBase64, blobToBase64 } from './utils/binaryUtils.js';
export { StreamWatchdog } from './utils/StreamWatchdog.js';
export { TraceLog } from './utils/TraceLog.js';
export { LogFileSink } from './utils/LogFileSink.js';
// Okno startu przestało istnieć — start jest zdarzeniowy (spec §3.2), więc stała fallbacku
// i jej raport w harnessie zostały skasowane razem z plikiem.
// E2.8 B3: work-prompt resolver (agent > global > factory).
export { resolveWorkPrompt, WORK_PROMPT_KEYS } from './utils/workPromptResolver.js';
// S30 Z3: normalizacja błędów API modeli (1 kopia zamiast 5 w modules/models).
export { normalizeError, MAX_ERROR_MESSAGE_LENGTH, SECRET_BEARING_FIELDS } from './utils/errorUtils.js';
// AUD-bledy-027/058/025/013: JEDNA reguła „co jest porażką narzędzia" (czytają ją tools, chat
// i sub-agents — stąd `core/`, nie barrel narzędzi).
export { toolResultStatus, shouldLinkWrittenFile } from './utils/toolResultStatus.js';
// S30 Z3: adapterowy mkdir -p (1 kopia zamiast 3 wariantów).
export { ensureAdapterFolder } from './utils/vaultFs.js';
// K4 (AUD-bledy-061): „czy plik jest?" w trzech stanach — `exists()` kłamie na dyskach sieciowych.
export { probeFile } from './utils/vaultFs.js';
// K4, self-append: odczyt-najpierw WŁASNEGO pliku przed dopisaniem nowego wpisu (siostrzana
// wada `probeFile` — tam kandydaci nazw, tu treść znanego pliku do dokładki).
export { readIfExists } from './utils/vaultFs.js';
// S35 „Wielki Rename": migrator plikowy — konsument poza core/ to `src/main.ts`.
// `migrateNamespace` (settings-namespace) NIE jest tu reeksportowany (AUD-dead-code-116/177):
// jedyny wołacz to `core/PKMEnv.ts`, deep-import wewnątrz core/, barrel mu niepotrzebny.
export { migrateOldPluginFolder } from './utils/pluginFolderMigration.js';
export { registerSettings } from './SettingsSection.js';
// AUD-dead-code-182: kanoniczny typ widoku czatu. Żyje w core/, bo `modules/chat/index.js`
// nie jest node-safe (patrz core/utils/viewTypes.js) — shell i artifacts nie mogą go
// statycznie zaimportować bez ciągnięcia `obsidian` do swoich node-testowalnych plików.
export { CHAT_VIEW_TYPE } from './utils/viewTypes.js';

// ── Silnik ustawień + zdarzeń (własny, po wymianie odziedziczonych plików) ──
// Magazyn ustawień runtime'u. `deep_merge` zszedł z barrela razem z plikiem, z którego
// pochodził (F-06: zero konsumentów) — `deepMergeMissing` żyje wewnątrz `core/runtime/`.
export { SettingsStore } from './runtime/SettingsStore.js';

// ── Transport HTTP (podklaster `core/http`) ──────────────
// Wszystkie te pliki MUSZĄ wstawać w gołym Node (K-01/K-03) — `ObsidianHttpClient` dostaje
// `requestUrl` konstruktorem właśnie po to.
export { ObsidianHttpClient } from './http/ObsidianHttpClient.js';
export { FetchHttpClient } from './http/FetchHttpClient.js';
export { FetchStreamTransport } from './http/FetchStreamTransport.js';
export { SseFrames } from './http/SseFrames.js';
export { NdjsonFrames } from './http/NdjsonFrames.js';
export { STREAM_TRANSPORT_TIMEOUT_MS } from './http/contracts.js';

// ── Stałe i typy kontraktu runtime'u ─────────────────────
export {
  SETTINGS_DIR,
  SETTINGS_PATH,
  SETTINGS_LAST_GOOD_PATH,
  SETTINGS_BACKUPS_DIR,
  SETTINGS_BACKUP_RETENTION,
  SETTINGS_CORRUPT_PATH_PATTERN,
  SETTINGS_PRE_MIGRATION_PATH,
  SETTINGS_SAVE_DEBOUNCE_MS,
  NOTICE_DEFAULT_TIMEOUT_MS,
  NOTICE_ACTIONS_CSS_CLASS,
  STATUS_BAR_CSS_CLASSES,
  DEFAULT_UI_LANGUAGE,
  PluginRuntimeError,
  SettingsCorruptError,
} from './runtime/contracts.js';

// ══════════════════════════════════════════════════════════════════════════
// TYPY PUBLICZNE (kampania TS, fala TS-1)
//
// Te same drzwi co wartości — kontrakty publicznych API core wychodzą przez
// `export type`, które ZNIKA przy transpilacji (zero wpływu na bundle i na
// node-safety barrela). Lista celowo obejmuje tylko typy, które opisują
// eksportowane wyżej wartości; nic nie jest tworzone „pod eksport".
//
// Uwaga: `Unsubscribe` wychodzi z `EventBus` — `EventEmitter` eksportuje własny
// alias o tej samej nazwie i tym samym kształcie (`() => void`), więc reeksport
// obu naraz byłby kolizją nazw. Konsumenci EventEmittera pasują strukturalnie.
// ══════════════════════════════════════════════════════════════════════════

// ── Typy: Security ───────────────────────────────────────
export type {
  AccessDecision,
  GuardedAgent,
  ScopeFolders,
  AccessCheckOptions,
} from './security/AccessGuard.js';
export type {
  PermissionedAgent,
  PermissionDecision,
  CheckPermissionOptions,
  ApprovalRiskContext,
  AccessLogEntry,
} from './security/PermissionSystem.js';
export type { AutonomyMode, ToolRiskLevel, ToolRiskContext } from './security/autonomy.js';
export type {
  ApprovalOutcome,
  ApprovalAction,
  ApprovalModalResult,
  ApprovalHandler,
  ApprovalHandlerResult,
  ApprovalResult,
  ApprovalStorage,
  ApprovalStorageChangeHandler,
  ApprovalHistoryEntry,
  ApprovalManagerOptions,
} from './security/ApprovalManager.js';
export type {
  SecretsSettings,
  SecureStorageSlice,
  EncryptedSecret,
  HydrateStatus,
  SecretsStorageOptions,
} from './security/SecretsStorage.js';
export type {
  FocusFolder,
  FocusEntry,
  VaultGroup,
  ExpandedFocusEntry,
} from './security/vaultGroups.js';
export type { MessageOrigin, MessageOriginMeta } from './security/messageOrigin.js';

// ── Typy: Utils ──────────────────────────────────────────
export type { TokenCountOpts } from './utils/tokenCounter.js';
export type { EventHandler } from './utils/EventEmitter.js';
export type { TokenEntry, RoleTotals, SessionTotal } from './utils/TokenTracker.js';
export type { StreamWatchdogOptions } from './utils/StreamWatchdog.js';
export type { TraceSink, ScopedTrace } from './utils/TraceLog.js';
export type {
  LogLevel,
  LogLineEntry,
  LogFileSinkAdapter,
  LogFileSinkOptions,
} from './utils/LogFileSink.js';
export type { WorkPromptSettings } from './utils/workPromptResolver.js';
export type { NormalizedError } from './utils/errorUtils.js';
export type { FolderCapableAdapter, FileProbe, ProbeCapableAdapter, ReadIfExistsResult } from './utils/vaultFs.js';
export type { PluginFolderAdapter } from './utils/pluginFolderMigration.js';

// ── Typy: silnik ustawień + zdarzeń ──────────────────────
export type {
  Unsubscribe,
  RuntimeState,
  RuntimeEventKey,
  RuntimeErrorCode,
  RuntimeLoadedSource,
  EventEmitterLike,
  SettingsBag,
  PkmAssistantSettings,
  ChatSettingsSlice,
  EmbeddingSettingsSlice,
  NoticesSettingsSlice,
  SettingsOwner,
  SettingsStoreOptions,
  SettingsSource,
  SettingsLoadResult,
  SettingsIo,
  SettingsArmorDeps,
  SettingsRegistryLike,
  SettingsSectionDef,
  SettingsSubFieldDef,
  LegacySettingsMigrationResult,
  NoticeAction,
  NoticeOptions,
  NoticeHandle,
  NoticeLike,
  StatusBarRenderer,
  StatusBarController,
  PluginHost,
  PluginVersionData,
  PluginApi,
  PluginManifestLike,
  PluginItemViewClass,
  PluginSettingsTabClass,
  ItemViewMap,
  CommandDef,
  RibbonIconDef,
  CrystalNoticeOptions,
  RuntimeConfig,
  ChatProviderLike,
  EmbeddingProviderLike,
  EmbeddingModelLike,
  EmbeddingRegistryLike,
  ChatModelLike,
  AppLike,
  VaultAdapterLike,
  LoggerLike,
} from './runtime/contracts.js';
export type { PluginRuntime } from './runtime/PluginRuntime.js';
export type {
  HttpClient,
  HttpRequestSpec,
  HttpResponse,
  StreamTransport,
  StreamOpenResult,
  StreamSink,
  FrameParser,
  StreamFrame,
} from './http/contracts.js';
// Kontrakt worka DI, który `modules/shell` buduje dla sekcji ustawień core.
export type { SettingsSectionCtx } from './SettingsContent.js';
export { hostWindow } from './utils/hostWindow.js';
export type { HostTimer } from './utils/hostWindow.js';
