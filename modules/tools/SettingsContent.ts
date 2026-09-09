import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
import { persistOrRollback, applyServerKillSwitch } from './settingsPersist.js';
import { ExternalMcpManager } from './ExternalMcpManager.js';
import type { ExternalMcpServerConfig, ExternalServerStatus } from './ExternalMcpManager.js';
import { parseClaudeDesktopConfig, buildImportRows } from './claudeConfigImport.js';
import type { ClaudeImportRow } from './claudeConfigImport.js';
import { IMAGE_GEN_PLATFORMS } from '../../modules/multimodal/index.js';
import { setSvgLabel } from '../../modules/crystal-soul/index.js';
import type { ServerCatalogEntry } from './ServerLoader.js';
import type { SettingsSectionCtx } from '../../core/index.js';
import type { App, Notice as ObsidianNotice } from 'obsidian';
// no-alert (wytyczne katalogu Obsidiana): zamiennik window.confirm() bez blokowania pętli
// zdarzeń — patrz nagłówek modules/ui-components/ConfirmModal.ts.
import { confirmModal } from '../ui-components/index.js';

/** Slice `settings.pkmAssistant.imageGen` — same stringi (klucze modeli sa dynamiczne). */
export type ImageGenSettings = Record<string, string | undefined>;

/** Slice `settings.pkmAssistant.stt`. */
export interface SttSettings {
    platform?: string;
    language?: string;
    deepgram_api_key?: string;
    assemblyai_api_key?: string;
}

/** Modal edytora serwera MCP (`modules/shell`) — wstrzykiwany przez ctx, nie importowany. */
type McpServerEditorModalCtor = new (
    app: App,
    plugin: unknown,
    options: { save: () => Promise<void> | void; existingServer?: ExternalMcpServerConfig; onSaved?: () => void },
) => { open: () => void };

/** Modal potwierdzenia importu z Claude Desktop (`modules/shell`). */
type ClaudeImportModalCtor = new (
    app: App,
    options: { rows: ClaudeImportRow[]; onConfirm: (configs: ExternalMcpServerConfig[]) => Promise<void> | void },
) => { open: () => void };

/**
 * Worek DI z `pkm_settings_tab.buildSectionContext()`, zawezony do tego, czego uzywaja sekcje
 * TEGO modulu. Wzgledem publicznego `SettingsSectionCtx` dokladamy: slice'y ustawien, ktorych core
 * nie zna (`externalMcpServers` / `imageGen` / `stt`), `owner.render()` (przerysowanie zakladki),
 * dwa modale z shella i `plugin` z managerami MCP. `Notice` jest tu WYMAGANY (core ma go
 * opcjonalnie), bo ta sekcja wola go bezwarunkowo.
 */
export type ToolsSettingsCtx = Pick<SettingsSectionCtx, 'save' | 'icons' | 'Setting'> & {
    pkm: SettingsSectionCtx['pkm'] & {
        externalMcpServers?: ExternalMcpServerConfig[];
        imageGen?: ImageGenSettings;
        stt?: SttSettings;
    };
    owner: { app: App; render: () => unknown };
    plugin?: {
        serverManager?: { serverLoader?: { getServerCatalog?: () => ServerCatalogEntry[] } | null } | null;
        externalMcpManager?: {
            getStatus?: (id: string) => ExternalServerStatus;
            isConnected?: (id: string) => boolean;
            getServerTools?: (id: string) => Array<{ name: string; description?: string }>;
            connect?: (cfg: ExternalMcpServerConfig) => Promise<{ success?: boolean; tools?: string[]; error?: string }>;
            close?: (id: string) => Promise<void>;
        } | null;
        /**
         * `buildImportRows` + import `onConfirm` biorą stąd nazwy
         * wbudowane — TA SAMA lista, którą `MCPServerEditorModal._builtinNames()` daje
         * ręcznemu dodawaniu serwera (`ToolRegistry.getBuiltinServerMap`).
         */
        toolRegistry?: { getBuiltinServerMap?: () => Record<string, string[]> } | null;
    } | null;
    Notice: typeof ObsidianNotice;
    MCPServerEditorModal: McpServerEditorModalCtor;
    ClaudeImportModal: ClaudeImportModalCtor;
};

/** Worek potrzebny do zameldowania padu zapisu (bez reszty ctx - łatwiej podać z wiersza). */
type SaveReportCtx = Pick<ToolsSettingsCtx, 'save' | 'Notice' | 'owner'>;

/**
 * Pad zapisu MUSI być widoczny. Log z powodem, zdanie dla usera i
 * przerysowanie ZE STANU PRAWDZIWEGO - mutacja jest już cofnięta, więc `render()`
 * pokazuje to, co realnie leży na dysku, a nie to, co user przed chwilą kliknął.
 */
function reportSaveFailure(ctx: SaveReportCtx, error: unknown): void {
    log.error('SettingsContent', 'Zapis ustawień nie powiódł się', error);
    new ctx.Notice(t('settings.save_failed'));
    ctx.owner.render();
}

/**
 * Jedno pole ustawień: mutacja w pamięci → zapis → przy padzie COFNIĘCIE i meldunek.
 * Zwraca `true`, gdy zmiana realnie wylądowała na dysku.
 */
async function saveField<B extends object, K extends keyof B>(
    ctx: SaveReportCtx,
    bag: B,
    key: K,
    value: B[K],
): Promise<boolean> {
    const previous = bag[key];
    bag[key] = value;
    const outcome = await persistOrRollback(() => ctx.save(), () => { bag[key] = previous; });
    if (!outcome.saved) reportSaveFailure(ctx, outcome.error);
    return outcome.saved;
}

export function renderMediaToolsSection(container: HTMLElement, ctx: ToolsSettingsCtx): void {
    container.classList.add('cs-root');
    renderImageGenSettings(container, ctx);
    renderSttSettings(container, ctx);
}

export function renderMcpServersSection(container: HTMLElement, ctx: ToolsSettingsCtx): void {
    const { plugin, icons } = ctx;
    container.classList.add('cs-root');

    const h2 = container.createEl('h2', { cls: 'cs-settings-section' });
    setSvgLabel(h2, icons?.tools?.(18) || '', t('settings.mcp_servers_title'));
    container.createEl('p', {
        text: t('settings.mcp_servers_desc'),
        cls: 'setting-item-description'
    });

    // ── Built-in servers (informational, read-only) ──────────────────
    const catalog = plugin?.serverManager?.serverLoader?.getServerCatalog?.() || [];
    const builtin = catalog.filter((s: ServerCatalogEntry) => s.source === 'built-in');
    if (builtin.length > 0) {
        container.createEl('h4', { text: t('settings.mcp_servers_builtin_header'), cls: 'cs-settings-subsection' });
        const bwrap = container.createDiv({ cls: 'mcp-servers-listing' });
        builtin.forEach((s: ServerCatalogEntry) => {
            const row = bwrap.createDiv({ cls: 'mcp-server-row' });
            row.createSpan({ text: t('settings.mcp_servers_builtin_badge'), cls: 'mcp-server-badge' });
            const info = row.createDiv({ cls: 'pkm-tools-info' });
            info.createEl('strong', { text: s.name });
            info.createDiv({
                text: t('settings.mcp_servers_tools_count', { count: s.toolCount }) + (s.description ? ' - ' + s.description : ''),
                cls: 'setting-item-description'
            });
        });
    }

    // ── External MCP servers (real protocol client) ───────────
    renderExternalMcpServers(container, ctx);
}

/**
 * Read `%APPDATA%\Claude\claude_desktop_config.json` if it happens to be there.
 * Desktop-only and best-effort: no APPDATA (mobile), no fs, no file → null, and the caller
 * falls back to a manual file picker. Never throws.
 *
 * ⚠️ `window.require` (a nie `import('node:fs')`) świadomie: esbuild zostawia dynamiczny
 * import modułu zewnętrznego jako NATYWNY `import()`, a przeglądarkowy resolver w rendererze
 * nie zna specyfikatora `node:fs` i bundle wybucha w runtime — dokładnie ten sam bug, który
 * dotyka importu `obsidian` (patrz nagłówek `ExternalMcpManager.js`).
 * `window.require` istnieje w Obsidianie desktop; na mobile go nie ma → picker.
 *
 * @returns zawartość pliku albo null
 */
function readClaudeDesktopConfigText(): string | null {
    try {
        const appData = (typeof process !== 'undefined' && process?.env?.APPDATA) || '';
        const nodeRequire = typeof window !== 'undefined' ? window.require : null;
        if (!appData || typeof nodeRequire !== 'function') return null;
        const fs = nodeRequire('fs') as { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string };
        const file = `${appData}\\Claude\\claude_desktop_config.json`;
        if (!fs.existsSync(file)) return null;
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null; // brak pliku / brak Node (mobile) → wybór pliku ręcznie
    }
}

/**
 * Hidden `<input type="file">` for picking claude_desktop_config.json by hand.
 * Zero innerHTML (createEl only); the input is removed once we have the text.
 */
function pickJsonFile(container: HTMLElement, onText: (text: string | null) => void): void {
    const input = container.createEl('input', { attr: { type: 'file', accept: '.json' } });
    input.addClass('pkm-hidden');
    input.addEventListener('change', () => {
        void (async () => {
            const file = input.files?.[0];
            let text: string | null = null;
            try {
                if (file) text = await file.text();
            } catch { text = null; }
            input.remove();
            onText(text);
        })();
    });
    input.click();
}

/** External MCP servers: config from settings + runtime status from the manager. */
function renderExternalMcpServers(container: HTMLElement, ctx: ToolsSettingsCtx): void {
    const { plugin, owner, Notice, MCPServerEditorModal, ClaudeImportModal, pkm, save } = ctx;
    const manager = plugin?.externalMcpManager;

    container.createEl('h4', { text: t('settings.mcp_external_header'), cls: 'cs-settings-subsection' });
    container.createEl('p', { text: t('settings.mcp_external_desc'), cls: 'setting-item-description' });

    if (!Array.isArray(pkm.externalMcpServers)) pkm.externalMcpServers = [];
    const servers = pkm.externalMcpServers;

    // config in data.json holds ONLY user configuration — strip runtime fields at save time.
    const persist = async () => {
        for (const s of servers) ExternalMcpManager.stripRuntimeFields(s);
        await save();
    };

    const wrapper = container.createDiv({ cls: 'mcp-external-listing' });

    const renderListing = () => {
        wrapper.empty();
        if (servers.length === 0) {
            wrapper.createEl('em', { text: t('settings.mcp_external_empty'), cls: 'setting-item-description' });
            return;
        }
        servers.forEach((cfg: ExternalMcpServerConfig) => renderExternalRow(wrapper, cfg, { manager, Notice, owner, plugin, MCPServerEditorModal, pkm, persist, save, refresh: renderListing }));
    };
    renderListing();

    const btnRow = container.createDiv({ cls: 'mcp-external-actions' });

    const addBtn = btnRow.createEl('button', { text: t('settings.mcp_external_add'), cls: 'mod-cta' });
    addBtn.addEventListener('click', () => {
        new MCPServerEditorModal(owner.app, plugin, {
            save,
            onSaved: () => renderListing(),
        }).open();
    });

    // Nazwy serwerów wbudowanych — TA SAMA lista, którą
    // `MCPServerEditorModal._builtinNames()` daje ręcznemu dodawaniu serwera. Fail-soft: brak
    // `toolRegistry` (stary/testowy host) = pusta lista, czyli tylko kolizja z `existing` +
    // format sluga są sprawdzane.
    const builtinNames = (): string[] => {
        try {
            const map = plugin?.toolRegistry?.getBuiltinServerMap?.();
            return map ? Object.keys(map) : [];
        } catch { return []; }
    };

    // ── „Importuj z Claude" — przenieś serwery z Claude Desktop ──
    const openImportModal = (jsonText: string | null) => {
        const parsed = parseClaudeDesktopConfig(jsonText);
        if (parsed.length === 0) {
            new Notice(t('settings.mcp_external_import_empty'));
            return;
        }
        new ClaudeImportModal(owner.app, {
            rows: buildImportRows(parsed, servers, builtinNames()),
            onConfirm: async (configs) => {
                if (!configs.length) return;
                // Obrona w głąb — TA SAMA walidacja unikalności/rezerwacji
                // id co ręczne dodawanie serwera (`MCPServerEditorModal._handleSave`), liczona
                // TU, tuż przed zapisem, a nie tylko w checkboxach modala (który jest celowo
                // GŁUPI i pokazuje stan sprzed ewentualnej edycji `servers` przez inne okno
                // otwarte równolegle). `takenIds` rośnie w trakcie pętli, więc duplikat
                // WEWNĄTRZ `configs` (np. dwa zaznaczone wiersze o tym samym slugu) też odpada
                // — drugi z nich koliduje z pierwszym, który ta sama pętla właśnie przyjęła.
                const names = builtinNames();
                const takenIds = new Set(servers.map(s => s.id));
                const accepted: ExternalMcpServerConfig[] = [];
                const skipped: string[] = [];
                for (const cfg of configs) {
                    const idCheck = ExternalMcpManager.validateServerId(cfg.id, names);
                    if (!idCheck.ok || takenIds.has(cfg.id)) {
                        skipped.push(cfg.name || cfg.id);
                        continue;
                    }
                    takenIds.add(cfg.id);
                    accepted.push(cfg);
                }
                if (accepted.length === 0) {
                    log.warn('SettingsContent', `Import serwerów z Claude: wszystkie ${configs.length} pozycji odrzucone walidacją id`, skipped);
                    // `mcp_external_import_empty` mówi
                    // "nie znalazłem żadnych serwerów w pliku" — NIEPRAWDA tutaj, bo parser
                    // ZNALAZŁ `configs.length` wpisów i user je zaznaczył; to DRUGA warstwa
                    // walidacji (id zarezerwowane/duplikat/format) odrzuciła wszystkie TUŻ przed
                    // zapisem. Osobny komunikat, żeby user nie szukał literówki w cudzym pliku,
                    // tylko wiedział, że to jego zaznaczenie odbiło się od kolizji nazw.
                    new Notice(t('settings.mcp_external_import_all_rejected', { count: configs.length }));
                    renderListing();
                    return;
                }
                for (const cfg of accepted) servers.push(cfg);
                // Import melduje liczbę serwerów DOPIERO po udanym zapisie.
                const outcome = await persistOrRollback(persist, () => {
                    for (const cfg of accepted) {
                        const i = servers.indexOf(cfg);
                        if (i >= 0) servers.splice(i, 1);
                    }
                });
                if (outcome.saved) {
                    new Notice(t('settings.mcp_external_import_added', { count: accepted.length }));
                    if (skipped.length > 0) {
                        log.warn('SettingsContent', `Import serwerów z Claude: ${skipped.length} pozycji pominięto (kolizja id)`, skipped);
                    }
                } else {
                    log.error('SettingsContent', 'Zapis ustawień (import serwerów z Claude) nie powiódł się', outcome.error);
                    new Notice(t('settings.save_failed'));
                }
                renderListing();
            },
        }).open();
    };

    const importBtn = btnRow.createEl('button', { text: t('settings.mcp_external_import_claude') });
    importBtn.addEventListener('click', () => {
        const auto = readClaudeDesktopConfigText();
        if (auto !== null) { openImportModal(auto); return; }
        pickJsonFile(btnRow, (text: string | null) => {
            if (text === null) { new Notice(t('settings.mcp_external_import_failed')); return; }
            openImportModal(text);
        });
    });
}

const STATUS_DOT: Record<string, string> = { connected: '🟢', off: '⚪', error: '🔴' };

/** Zaleznosci jednego wiersza serwera — sklejane w `renderExternalMcpServers`. */
interface ExternalRowDeps {
    manager: NonNullable<ToolsSettingsCtx['plugin']>['externalMcpManager'];
    Notice: ToolsSettingsCtx['Notice'];
    owner: ToolsSettingsCtx['owner'];
    plugin: ToolsSettingsCtx['plugin'];
    MCPServerEditorModal: McpServerEditorModalCtor;
    pkm: ToolsSettingsCtx['pkm'];
    persist: () => Promise<void>;
    save: ToolsSettingsCtx['save'];
    refresh: () => void;
}

function renderExternalRow(container: HTMLElement, cfg: ExternalMcpServerConfig, deps: ExternalRowDeps): void {
    const { manager, Notice, owner, plugin, MCPServerEditorModal, persist, save, refresh } = deps;
    const status = manager?.getStatus?.(cfg.id) || { status: 'off', lastError: null, toolCount: 0 };
    const connected = !!manager?.isConnected?.(cfg.id);
    // Kill-switch: brak pola = włączony (wstecznie zgodne ze starymi configami).
    const enabled = cfg.enabled !== false;

    const box = container.createDiv({ cls: 'mcp-external-server' });

    const row = box.createDiv({ cls: 'pkm-mcp-row' });

    row.createSpan({ text: enabled ? (STATUS_DOT[status.status] || '⚪') : '⛔' });

    const info = row.createDiv({ cls: 'pkm-tools-info' });
    info.createEl('strong', { text: cfg.name || cfg.id });
    const transportLabel = (cfg.transport || 'stdio') === 'http'
        ? t('settings.mcp_external_transport_http')
        : t('settings.mcp_external_transport_stdio');
    const meta = [transportLabel];
    if (cfg.autostart) meta.push(t('settings.mcp_external_autostart_on'));
    if (!enabled) meta.push(t('settings.mcp_external_disabled_state'));
    else if (connected) meta.push(t('settings.mcp_external_tools_count', { count: status.toolCount }));
    else meta.push(t(`settings.mcp_external_status_${status.status}`));
    const metaEl = info.createDiv({ text: meta.join(' · '), cls: 'setting-item-description' });
    if (status.status === 'error' && status.lastError) {
        const err = info.createDiv({ text: status.lastError, cls: 'setting-item-description' });
        err.addClass('pkm-mcp-error');
    } else { void metaEl; }

    // Kill-switch per serwer. OFF = konfiguracja zostaje, ale serwer nie ma prawa
    // dostarczać narzędzi: rozłączamy natychmiast (wyrejestrowanie z ToolRegistry) i blokujemy
    // ręczne „Połącz". Autostart i tak respektuje `enabled` (nie ruszamy go).
    const toggleWrap = row.createDiv({ cls: 'pkm-mcp-enable' });
    const toggle = toggleWrap.createEl('input', { type: 'checkbox' });
    toggle.checked = enabled;
    toggle.id = `mcp-enable-${cfg.id}`;
    const toggleLabel = toggleWrap.createEl('label', { text: t('settings.mcp_external_enabled_label') });
    toggleLabel.setAttr('for', toggle.id);
    toggleLabel.addClass('setting-item-description');
    toggle.addEventListener('change', () => {
        void (async () => {
            const on = toggle.checked;
            const previousEnabled = cfg.enabled;
            toggle.disabled = true;
            try {
                // Zamknięcie serwera NIE zależy od zapisu - user, który wyłącza
                // konektor, odbiera mu prawo dostarczania narzędzi tu i teraz. Zapis melduje się
                // osobno i przy padzie cofa mutację, żeby wiersz nie malował stanu, którego nie ma.
                const outcome = await applyServerKillSwitch({
                    enable: on,
                    apply: () => { cfg.enabled = on; },
                    rollback: () => { cfg.enabled = previousEnabled; },
                    // Narzędzia znikają z rejestru od razu — nie czekamy na restart pluginu.
                    close: async () => { await manager?.close?.(cfg.id); },
                    persist,
                });
                if (outcome.closeError) {
                    log.warn('SettingsContent', `Nie udało się zamknąć serwera MCP ${cfg.id}:`, outcome.closeError);
                }
                if (outcome.saved) {
                    new Notice(t(on ? 'settings.mcp_external_enabled_notice' : 'settings.mcp_external_disabled_notice',
                        { name: cfg.name || cfg.id }));
                } else {
                    log.error('SettingsContent', 'Zapis ustawień (kill-switch serwera MCP) nie powiódł się', outcome.saveError);
                    new Notice(t('settings.save_failed'));
                }
            } finally {
                refresh();
            }
        })();
    });

    // Connect / Disconnect
    const connectBtn = row.createEl('button', {
        text: connected ? t('settings.mcp_external_disconnect') : t('settings.mcp_external_connect'),
    });
    if (!enabled && !connected) {
        connectBtn.disabled = true;
        connectBtn.title = t('settings.mcp_external_connect_disabled_hint');
    }
    connectBtn.addEventListener('click', () => {
        void (async () => {
            connectBtn.disabled = true;
            try {
                if (connected) {
                    await manager?.close?.(cfg.id);
                    new Notice(t('settings.mcp_external_disconnected_notice', { name: cfg.name || cfg.id }));
                } else {
                    new Notice(t('settings.mcp_external_connecting', { name: cfg.name || cfg.id }));
                    const res = await manager?.connect?.(cfg);
                    if (res?.success) {
                        new Notice(t('settings.mcp_external_connected_notice', { name: cfg.name || cfg.id, count: (res.tools || []).length }));
                    } else {
                        new Notice(t('settings.mcp_external_connect_failed', { name: cfg.name || cfg.id, error: res?.error || '?' }));
                    }
                }
            } finally {
                refresh();
            }
        })();
    });

    // Edit
    const editBtn = row.createEl('button', { text: t('settings.mcp_external_edit') });
    editBtn.addEventListener('click', () => {
        new MCPServerEditorModal(owner.app, plugin, {
            save,
            existingServer: cfg,
            onSaved: () => refresh(),
        }).open();
    });

    // Delete
    const deleteBtn = row.createEl('button', { text: t('settings.mcp_external_delete') });
    deleteBtn.addEventListener('click', () => {
        void (async () => {
            const confirmed = await confirmModal(owner.app, {
                title: t('settings.mcp_external_delete'),
                message: t('settings.mcp_external_delete_confirm', { name: cfg.name || cfg.id }),
                destructive: true,
            });
            if (!confirmed) return;
            if (connected) { try { await manager?.close?.(cfg.id); } catch { /* ignore */ } }
            const list = deps.pkm.externalMcpServers!;
            const idx = list.findIndex((s: ExternalMcpServerConfig) => s.id === cfg.id);
            if (idx >= 0) list.splice(idx, 1);
            // „Usunięto" tylko wtedy, gdy kasacja realnie wylądowała na dysku.
            const outcome = await persistOrRollback(persist, () => { if (idx >= 0) list.splice(idx, 0, cfg); });
            if (outcome.saved) {
                new Notice(t('settings.mcp_external_deleted_notice', { name: cfg.name || cfg.id }));
            } else {
                log.error('SettingsContent', 'Zapis ustawień (kasowanie serwera MCP) nie powiódł się', outcome.error);
                new Notice(t('settings.save_failed'));
            }
            refresh();
        })();
    });

    // Connected → preview the server's tools (name + description) before pinning to an agent.
    if (connected) {
        const tools = manager?.getServerTools?.(cfg.id) || [];
        if (tools.length > 0) {
            const det = box.createEl('details', { cls: 'mcp-external-tools' });
            det.addClass('pkm-mcp-details');
            det.createEl('summary', { text: t('settings.mcp_external_tools_header') });
            const ul = det.createEl('ul', { cls: 'pkm-mcp-tool-list' });
            for (const tool of tools) {
                const li = ul.createEl('li');
                li.createEl('code', { text: tool.name });
                if (tool.description) li.appendText(' — ' + tool.description);
            }
        }
    }
}

function renderImageGenSettings(container: HTMLElement, ctx: ToolsSettingsCtx): void {
    const { pkm, owner, icons, Setting } = ctx;
    const h2 = container.createEl('h2', { cls: 'cs-settings-section' });
    setSvgLabel(h2, icons?.sparkle?.(18) || '', t('settings.image_gen_title'));
    container.createEl('p', {
        text: t('settings.image_gen_desc'),
        cls: 'setting-item-description'
    });

    if (!pkm.imageGen) pkm.imageGen = {};
    const ig = pkm.imageGen;

    // Lista platform z SSOT (modules/multimodal), nie z lokalnej kopii —
    // dropdown i walidacja w generate_image widzą zawsze ten sam zestaw.
    const platforms: Array<{ id: string; name: string; key?: string }> = [
        { id: 'disabled', name: t('settings.image_gen_disabled') },
        ...IMAGE_GEN_PLATFORMS.map(p => ({ id: p.id, name: p.name, key: p.requiresKey })),
    ];

    new Setting(container)
        .setName(t('settings.image_gen_platform'))
        .setDesc(t('settings.image_gen_platform_desc'))
        .addDropdown(dd => {
            for (const p of platforms) dd.addOption(p.id, p.name);
            // Zapisana platforma może być osierocona (np. 'comfyui' po wywałce modułu comfy)
            // — wtedy dropdown pokazuje pierwszą (domyślną) opcję zamiast pustki. Bez migracji danych.
            const savedPlatform = ig.platform || 'disabled';
            const knownPlatform = platforms.some(p => p.id === savedPlatform);
            dd.setValue(knownPlatform ? savedPlatform : platforms[0].id);
            dd.onChange(async (value) => {
                // Nowa platforma zostaje w UI tylko wtedy, gdy zapis przeszedł.
                if (await saveField(ctx, ig, 'platform', value)) owner.render();
            });
        });

    new Setting(container)
        .setName(t('settings.image_gen_save_folder'))
        .setDesc(t('settings.image_gen_save_folder_desc'))
        .addText(text => {
            text.setPlaceholder('Attachments/generated')
                .setValue(ig.saveFolder || '')
                .onChange(async (value) => {
                    await saveField(ctx, ig, 'saveFolder', value.trim());
                });
            text.inputEl.addClass('pkm-setting-input--w250');
        });

    if (ig.platform && ig.platform !== 'disabled') {
        const selected = platforms.find(p => p.id === ig.platform);

        if (ig.platform === 'stability') {
            new Setting(container)
                .setName(t('settings.image_gen_api_key_stability'))
                .addText(text => {
                    text.setPlaceholder('sk-...')
                        .setValue(ig.stability_api_key || '')
                        .onChange(async (value) => {
                            await saveField(ctx, ig, 'stability_api_key', value.trim());
                        });
                    text.inputEl.type = 'password';
                    text.inputEl.addClass('pkm-setting-input--w300');
                });
        }
        if (ig.platform === 'replicate') {
            new Setting(container)
                .setName(t('settings.image_gen_api_key_replicate'))
                .addText(text => {
                    text.setPlaceholder('r8_...')
                        .setValue(ig.replicate_api_key || '')
                        .onChange(async (value) => {
                            await saveField(ctx, ig, 'replicate_api_key', value.trim());
                        });
                    text.inputEl.type = 'password';
                    text.inputEl.addClass('pkm-setting-input--w300');
                });
        }

        const modelDefaults: Record<string, { placeholder: string; desc: string }> = {
            openrouter: { placeholder: 'google/gemini-2.5-flash-image', desc: 'np. google/gemini-2.5-flash-image, openai/gpt-5-image, openai/gpt-5-image-mini' },
            openai:     { placeholder: 'dall-e-3',                      desc: 'np. dall-e-3, dall-e-2' },
            replicate:  { placeholder: 'black-forest-labs/flux-schnell', desc: 'np. black-forest-labs/flux-schnell, black-forest-labs/flux-dev' },
            xai:        { placeholder: 'grok-imagine-image',             desc: 'np. grok-imagine-image, grok-imagine-image-pro' },
            gemini:     { placeholder: 'imagen-3.0-generate-002',        desc: 'np. imagen-3.0-generate-002' },
        };
        const modelCfg = modelDefaults[ig.platform];
        if (modelCfg) {
            const modelKey = `${ig.platform}_model`;
            new Setting(container)
                .setName(t('settings.image_gen_model'))
                .setDesc(modelCfg.desc)
                .addText(text => {
                    text.setPlaceholder(modelCfg.placeholder)
                        .setValue(ig[modelKey] || '')
                        .onChange(async (value) => {
                            await saveField(ctx, ig, modelKey, value.trim());
                        });
                    text.inputEl.addClass('pkm-setting-input--w300');
                });
        }

        if (selected?.key && !['stability', 'replicate'].includes(ig.platform)) {
            container.createEl('p', {
                text: t('settings.image_gen_reuses_key', { key: selected.key }),
                cls: 'setting-item-description',
            });
        }
    }
}

function renderSttSettings(container: HTMLElement, ctx: ToolsSettingsCtx): void {
    const { pkm, owner, icons, Setting } = ctx;
    const h2 = container.createEl('h2', { cls: 'cs-settings-section' });
    setSvgLabel(h2, icons?.microphone?.(18) || '', t('settings.stt_title'));
    container.createEl('p', {
        text: t('settings.stt_desc'),
        cls: 'setting-item-description'
    });

    if (!pkm.stt) pkm.stt = {};
    const stt = pkm.stt;

    const sttPlatforms: Array<{ id: string; name: string; key?: string | null }> = [
        { id: 'disabled', name: t('settings.stt_disabled') },
        { id: 'groq', name: t('settings.stt_groq_name'), key: 'groq' },
        { id: 'openai', name: 'OpenAI Whisper', key: 'openai' },
        { id: 'google', name: 'Google Cloud STT', key: 'gemini' },
        { id: 'deepgram', name: 'Deepgram', key: 'deepgram' },
        { id: 'assemblyai', name: 'AssemblyAI', key: 'assemblyai' },
        { id: 'ollama', name: t('settings.stt_ollama_name'), key: null },
    ];

    new Setting(container)
        .setName(t('settings.stt_platform'))
        .setDesc(t('settings.stt_platform_desc'))
        .addDropdown(dd => {
            for (const p of sttPlatforms) dd.addOption(p.id, p.name);
            dd.setValue(stt.platform || 'disabled');
            dd.onChange(async (value) => {
                if (await saveField(ctx, stt, 'platform', value)) owner.render();
            });
        });

    if (stt.platform && stt.platform !== 'disabled') {
        new Setting(container)
            .setName(t('settings.stt_language'))
            .setDesc(t('settings.stt_language_desc'))
            .addDropdown(dd => {
                dd.addOption('pl', t('settings.stt_lang_pl'));
                dd.addOption('en', t('settings.stt_lang_en'));
                dd.addOption('de', t('settings.stt_lang_de'));
                dd.addOption('auto', t('settings.stt_lang_auto'));
                dd.setValue(stt.language || 'pl');
                dd.onChange(async (value) => {
                    await saveField(ctx, stt, 'language', value);
                });
            });

        if (stt.platform === 'deepgram') {
            new Setting(container)
                .setName(t('settings.stt_api_key_deepgram'))
                .addText(text => {
                    text.setPlaceholder(t('settings.stt_paste_key'))
                        .setValue(stt.deepgram_api_key || '')
                        .onChange(async (value) => {
                            await saveField(ctx, stt, 'deepgram_api_key', value.trim());
                        });
                    text.inputEl.type = 'password';
                    text.inputEl.addClass('pkm-setting-input--w300');
                });
        }
        if (stt.platform === 'assemblyai') {
            new Setting(container)
                .setName(t('settings.stt_api_key_assemblyai'))
                .addText(text => {
                    text.setPlaceholder(t('settings.stt_paste_key'))
                        .setValue(stt.assemblyai_api_key || '')
                        .onChange(async (value) => {
                            await saveField(ctx, stt, 'assemblyai_api_key', value.trim());
                        });
                    text.inputEl.type = 'password';
                    text.inputEl.addClass('pkm-setting-input--w300');
                });
        }

        if (stt.platform === 'ollama') {
            container.createEl('p', {
                text: t('settings.stt_ollama_warning'),
                cls: 'setting-item-description pkm-mcp-error',
            });
        }

        const selected = sttPlatforms.find(p => p.id === stt.platform);
        if (selected?.key && !['deepgram', 'assemblyai'].includes(stt.platform)) {
            container.createEl('p', {
                text: t('settings.stt_reuses_key', { key: selected.key }),
                cls: 'setting-item-description',
            });
        }
    }
}
