/**
 * MCPServerEditorModal - Add / edit an EXTERNAL MCP server.
 *
 * Real MCP protocol client (ExternalMcpManager): stdio = local process (desktop only),
 * http = remote server (also mobile). Config is persisted in plugin settings
 * (`settings.pkmAssistant.externalMcpServers[]` → data.json), NOT in vault files - command/env may
 * carry secrets that must not sync with the vault.
 */
import { Modal, Setting, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../../core/i18n/index.js';
import { ExternalMcpManager, MCP_SERVER_PRESETS, getMcpServerPreset } from '../tools/index.js';
import type { ExternalMcpServerConfig, ExternalToolRegistryLike } from '../tools/index.js';
import type { PluginApi, PkmAssistantSettings } from '../../core/index.js';

/** Kształt błędu w `catch` bez narzucania typu wyjątku (jak `ExternalMcpManager._configuredServers`). */
type ErrLike = { message?: string };

/** Plugin widziany przez ten modal: managery MCP + ustawienia; reszta z `PluginApi`. */
interface McpServerEditorPlugin extends PluginApi {
    toolRegistry?: ExternalToolRegistryLike;
    externalMcpManager?: ExternalMcpManager;
}

/** Callback po udanym zapisie serwera. */
type OnSavedCallback = (config: ExternalMcpServerConfig) => void;

/** Opcje konstruktora - patrz JSDoc niżej. */
interface McpServerEditorOptions {
    onSaved?: OnSavedCallback | null;
    existingServer?: ExternalMcpServerConfig | null;
    save?: () => Promise<void> | void;
}

/** `PkmAssistantSettings` (core) nie modeluje `externalMcpServers` - to pole tools-module-owned. */
type PkmSettingsWithServers = PkmAssistantSettings & { externalMcpServers?: ExternalMcpServerConfig[] };

/** Stan formularza - wszystkie pola są tekstowe/bool, parsowane dopiero przy zapisie. */
interface McpEditorForm {
    id: string;
    name: string;
    transport: string;
    command: string;
    argsText: string;
    envText: string;
    url: string;
    headersText: string;
    autostart: boolean;
    enabled: boolean;
}

// Fallback list if the registry is unavailable - must mirror BUILTIN_TOOL_MAP keys.
const BUILTIN_SERVER_NAMES = ['core', 'artifacts', 'vault', 'memory', 'web', 'multimodal', 'delegation', 'komunikator'];

/** Parse a textarea into a trimmed, non-empty line array (args). */
function parseLines(text: unknown): string[] {
    return String(text || '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
}

/** Parse `KEY=value` lines into an object (env). First `=` splits; later `=` stay in value. */
function parseKeyValueEq(text: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of parseLines(text)) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
}

/** Parse `Name: value` lines into an object (http headers). First `:` splits. */
function parseKeyValueColon(text: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of parseLines(text)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
}

function toEnvText(env: unknown): string {
    if (!env || typeof env !== 'object') return '';
    return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
}

function toHeadersText(headers: unknown): string {
    if (!headers || typeof headers !== 'object') return '';
    return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}

export class MCPServerEditorModal extends Modal {
    declare private plugin: McpServerEditorPlugin;
    declare private onSaved: OnSavedCallback | null;
    declare private existing: ExternalMcpServerConfig | null;
    declare private _save: () => Promise<void> | void;
    declare private isEdit: boolean;
    declare private _presetId: string;
    declare private form: McpEditorForm;
    // `| undefined` - pola żyją dopiero PO `onOpen()` (Obsidian tworzy modal, potem otwiera);
    // kod już się przed tym broni gołymi `if`/`?.` (patrz `_runPreview()` i `_renderTransportFields()`
    // niżej) - `HTMLElement` bez `undefined` czyniło te guardy martwe na poziomie typów.
    declare private _transportEl: HTMLElement | undefined;
    declare private _previewBtn: HTMLButtonElement | undefined;
    declare private _previewResultEl: HTMLElement | undefined;
    /**
     * @param {Object} app - Obsidian App
     * @param {Object} plugin - Plugin instance (settings + toolRegistry + externalMcpManager)
     * @param {Object} [options]
     * @param {Function} [options.onSaved] - callback(serverConfig) after a successful save
     * @param {Object|null} [options.existingServer] - config to edit (null = add new)
     * @param {Function} [options.save] - async persistence callback (defaults to env.settingsStore.save)
     */
    constructor(app: App, plugin: McpServerEditorPlugin, options: McpServerEditorOptions = {}) {
        super(app);
        this.plugin = plugin;
        this.onSaved = options.onSaved || null;
        this.existing = options.existingServer || null;
        this._save = options.save || (async () => this.plugin?.env?.settingsStore?.save?.());
        this.isEdit = !!this.existing;
        /** Wybrany preset (tylko w trybie NOWEGO serwera); '' = „własny". */
        this._presetId = '';

        const src: Partial<ExternalMcpServerConfig> = this.existing || {};
        this.form = {
            id: src.id || '',
            name: src.name || '',
            transport: src.transport || 'stdio',
            command: src.command || '',
            argsText: Array.isArray(src.args) ? src.args.join('\n') : '',
            envText: toEnvText(src.env),
            url: src.url || '',
            headersText: toHeadersText(src.headers),
            autostart: !!src.autostart,
            // Kill-switch: przy EDYCJI zachowujemy stan włącznika; nowy serwer = włączony.
            // `_handleSave` NIE MOŻE wpisywać `enabled: true` bezwarunkowo, bo wtedy każda edycja
            // po cichu odwracałaby wyłączenie serwera przez usera.
            enabled: src.enabled !== false,
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('mcp-server-editor-modal');

        new Setting(contentEl)
            .setName(this.isEdit ? t('modal.mcp_server_editor.edit_title') : t('modal.mcp_server_editor.new_title'))
            .setHeading();

        // Preset - only when adding a new server; it just fills the form below.
        if (!this.isEdit) this._renderPresetPicker(contentEl);

        // Name
        new Setting(contentEl)
            .setName(t('modal.mcp_server_editor.name_label'))
            .setDesc(t('modal.mcp_server_editor.name_desc'))
            .addText(text => {
                text.setPlaceholder('Blender');
                text.setValue(this.form.name);
                text.onChange(v => { this.form.name = v; });
            });

        // Id (slug) - immutable in edit mode (it is the tool prefix + the agent pin key).
        new Setting(contentEl)
            .setName(t('modal.mcp_server_editor.id_label'))
            .setDesc(t('modal.mcp_server_editor.id_desc'))
            .addText(text => {
                text.setPlaceholder('blender');
                text.setValue(this.form.id);
                text.onChange(v => { this.form.id = v.toLowerCase().replace(/[^a-z0-9-]/g, ''); });
                if (this.isEdit) text.setDisabled(true);
            });

        // Transport
        new Setting(contentEl)
            .setName(t('modal.mcp_server_editor.transport_label'))
            .addDropdown(drop => {
                drop.addOption('stdio', t('modal.mcp_server_editor.transport_stdio'));
                drop.addOption('http', t('modal.mcp_server_editor.transport_http'));
                drop.setValue(this.form.transport);
                drop.onChange(v => { this.form.transport = v; this._renderTransportFields(); });
            });

        // Transport-specific fields live in this container (re-rendered on transport change).
        this._transportEl = contentEl.createDiv({ cls: 'mcp-server-editor-transport' });
        this._renderTransportFields();

        // Voluntary connection test - see the server's tool list BEFORE saving it.
        this._renderPreviewSection(contentEl);

        // Autostart
        new Setting(contentEl)
            .setName(t('modal.mcp_server_editor.autostart_label'))
            .setDesc(t('modal.mcp_server_editor.autostart_desc'))
            .addToggle(tg => {
                tg.setValue(this.form.autostart);
                tg.onChange(v => { this.form.autostart = v; });
            });

        // Action buttons
        const actions = contentEl.createDiv({
            cls: 'pkm-editor-actions',
        });
        const cancelBtn = actions.createEl('button', { text: t('generic.cancel') });
        cancelBtn.addEventListener('click', () => this.close());
        const saveBtn = actions.createEl('button', { text: t('modal.mcp_server_editor.save_button'), cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => { void this._handleSave(); });
    }

    /**
     * Dropdown „Preset": gotowe serwery MCP wpisane w kodzie (`MCP_SERVER_PRESETS`).
     * Wybór tylko WYPEŁNIA formularz (name/id/command/args/env) i pokazuje podpowiedź co uzupełnić;
     * user może potem zmienić każde pole, a walidacja przy zapisie działa jak zawsze (id może
     * kolidować z już dodanym serwerem - wtedy zapis odbije z komunikatem).
     */
    _renderPresetPicker(contentEl: HTMLElement): void {
        new Setting(contentEl)
            .setName(t('modal.mcp_server_editor.preset_label'))
            .setDesc(t('modal.mcp_server_editor.preset_desc'))
            .addDropdown(drop => {
                drop.addOption('', t('modal.mcp_server_editor.preset_none'));
                for (const preset of MCP_SERVER_PRESETS) drop.addOption(preset.id, preset.name);
                drop.setValue(this._presetId);
                drop.onChange(v => this._applyPreset(v));
            });

        const preset = getMcpServerPreset(this._presetId);
        if (preset) {
            const hint = contentEl.createDiv({ cls: 'mcp-server-editor-preset-hint setting-item-description' });
            hint.createSpan({ text: t(preset.hint) });
        }
    }

    /** @private Wypełnij formularz presetem (albo wyczyść wybór) i przerysuj modal. */
    _applyPreset(presetId: string): void {
        this._presetId = presetId || '';
        const preset = getMcpServerPreset(this._presetId);
        if (preset) {
            this.form.id = preset.id;
            this.form.name = preset.name;
            this.form.transport = preset.transport || 'stdio';
            this.form.command = preset.command || '';
            this.form.argsText = Array.isArray(preset.args) ? preset.args.join('\n') : '';
            this.form.envText = toEnvText(preset.env);
            this.form.url = '';
            this.form.headersText = '';
        }
        this.onOpen(); // onOpen zaczyna od contentEl.empty() - bezpieczne przerysowanie
    }

    /**
     * „Sprawdź połączenie i pokaż narzędzia" - DOBROWOLNY podgląd. Nie blokuje zapisu
     * (serwer bywa offline), ale daje szansę zobaczyć, co dokładnie dostanie agent, ZANIM
     * konfiguracja wyląduje w data.json. Próba jest efemeryczna - `previewTools` zamyka
     * połączenie po sobie i niczego nie rejestruje.
     */
    _renderPreviewSection(contentEl: HTMLElement): void {
        const wrap = contentEl.createDiv({ cls: 'mcp-server-editor-preview' });
        wrap.createEl('p', {
            text: t('modal.mcp_server_editor.preview_desc'),
            cls: 'setting-item-description',
        });
        this._previewBtn = wrap.createEl('button', { text: t('modal.mcp_server_editor.preview_button') });
        this._previewResultEl = wrap.createDiv({ cls: 'mcp-server-editor-preview-result' });
        this._previewBtn.addEventListener('click', () => this._runPreview());
    }

    /** @private Zbuduj config z AKTUALNYCH pól formularza (bez zapisu, bez walidacji nazwy). */
    _buildConfigFromForm(): ExternalMcpServerConfig {
        const f = this.form;
        const config: ExternalMcpServerConfig = {
            id: f.id,
            name: f.name.trim(),
            transport: f.transport,
            enabled: f.enabled !== false,
            autostart: !!f.autostart,
        };
        if (f.transport === 'stdio') {
            config.command = f.command.trim();
            config.args = parseLines(f.argsText);
            config.env = parseKeyValueEq(f.envText);
        } else {
            config.url = f.url.trim();
            config.headers = parseKeyValueColon(f.headersText);
        }
        return config;
    }

    /** @private Odpal podgląd narzędzi na configu z formularza i wyrenderuj wynik/błąd. */
    async _runPreview() {
        const result = this._previewResultEl;
        if (!result) return;
        result.empty();

        const cfg = this._buildConfigFromForm();
        // Minimalne wymagania transportu - bez nich nie ma czego próbować.
        if (cfg.transport === 'stdio' && !cfg.command) {
            new Notice(t('modal.mcp_server_editor.error_command_required'));
            return;
        }
        if (cfg.transport === 'http' && !cfg.url) {
            new Notice(t('modal.mcp_server_editor.error_url_required'));
            return;
        }

        const manager = this.plugin?.externalMcpManager;
        if (!manager?.previewTools) {
            result.createDiv({ text: t('modal.mcp_server_editor.preview_unavailable'), cls: 'setting-item-description' });
            return;
        }

        const btn = this._previewBtn;
        const originalLabel = btn?.textContent || t('modal.mcp_server_editor.preview_button');
        if (btn) {
            btn.disabled = true;
            btn.textContent = t('modal.mcp_server_editor.preview_running');
        }
        result.createDiv({ text: t('modal.mcp_server_editor.preview_running'), cls: 'setting-item-description' });

        let res: { success: boolean; tools?: Array<{ name: string; description: string }>; error?: string };
        try {
            res = await manager.previewTools(cfg);
        } catch (e) {
            // previewTools nie rzuca, ale defensywnie: modal nigdy nie zostaje z martwym guzikiem.
            res = { success: false, error: (e as ErrLike)?.message || String(e) };
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalLabel;
            }
        }

        result.empty();
        if (!res?.success) {
            const err = result.createDiv({ cls: 'setting-item-description' });
            err.addClass('pkm-editor-warn');
            err.setText(t('modal.mcp_server_editor.preview_failed', { error: res?.error || '?' }));
            return;
        }

        const tools = res.tools || [];
        if (tools.length === 0) {
            result.createDiv({ text: t('modal.mcp_server_editor.preview_no_tools'), cls: 'setting-item-description' });
            return;
        }
        result.createDiv({
            text: t('modal.mcp_server_editor.preview_ok', { count: tools.length }),
            cls: 'setting-item-description',
        });
        const ul = result.createEl('ul');
        for (const tool of tools) {
            const li = ul.createEl('li');
            li.createEl('code', { text: tool.name });
            if (tool.description) li.appendText(' — ' + tool.description);
        }
    }

    _renderTransportFields() {
        // `!` - zawsze wołane PO `onOpen()` przypisującym `_transportEl` (bezpośrednio na końcu
        // `onOpen()`, albo z listenera dropdownu, który istnieje dopiero PO tym przypisaniu);
        // TS nie widzi tej kolejności między metodami.
        const el = this._transportEl!;
        el.empty();
        // Zmiana transportu unieważnia poprzedni podgląd (dotyczył innego połączenia).
        if (this._previewResultEl) this._previewResultEl.empty();

        if (this.form.transport === 'stdio') {
            new Setting(el)
                .setName(t('modal.mcp_server_editor.command_label'))
                .setDesc(t('modal.mcp_server_editor.command_desc'))
                .addText(text => {
                    text.setPlaceholder('npx');
                    text.setValue(this.form.command);
                    text.onChange(v => { this.form.command = v; });
                });
            new Setting(el)
                .setName(t('modal.mcp_server_editor.args_label'))
                .setDesc(t('modal.mcp_server_editor.args_desc'))
                .addTextArea(area => {
                    area.setPlaceholder('-y\nblender-mcp');
                    area.setValue(this.form.argsText);
                    area.onChange(v => { this.form.argsText = v; });
                    area.inputEl.rows = 3;
                });
            new Setting(el)
                .setName(t('modal.mcp_server_editor.env_label'))
                .setDesc(t('modal.mcp_server_editor.env_desc'))
                .addTextArea(area => {
                    area.setPlaceholder('API_KEY=...');
                    area.setValue(this.form.envText);
                    area.onChange(v => { this.form.envText = v; });
                    area.inputEl.rows = 2;
                });
        } else {
            new Setting(el)
                .setName(t('modal.mcp_server_editor.url_label'))
                .setDesc(t('modal.mcp_server_editor.url_desc'))
                .addText(text => {
                    text.setPlaceholder('https://mcp.example.com');
                    text.setValue(this.form.url);
                    text.onChange(v => { this.form.url = v.trim(); });
                    text.inputEl.addClass('pkm-editor-input-wide');
                });
            new Setting(el)
                .setName(t('modal.mcp_server_editor.headers_label'))
                .setDesc(t('modal.mcp_server_editor.headers_desc'))
                .addTextArea(area => {
                    area.setPlaceholder('Authorization: Bearer ...');
                    area.setValue(this.form.headersText);
                    area.onChange(v => { this.form.headersText = v; });
                    area.inputEl.rows = 2;
                });
        }

        // Trust warning - honest, transport-specific, no theatre.
        const warn = el.createDiv({ cls: 'mcp-server-editor-trust cs-warning-banner' });
        warn.addClass('pkm-editor-warn');
        warn.createEl('strong', { text: '⚠ ' });
        warn.createSpan({
            text: this.form.transport === 'stdio'
                ? t('modal.mcp_server_editor.trust_warning_stdio')
                : t('modal.mcp_server_editor.trust_warning_http'),
        });
    }

    _builtinNames(): string[] {
        try {
            const map = this.plugin?.toolRegistry?.getBuiltinServerMap?.();
            if (map) return Object.keys(map);
        } catch { /* fall through */ }
        return BUILTIN_SERVER_NAMES;
    }

    _servers(): ExternalMcpServerConfig[] {
        const pkm = this.plugin?.env?.settings?.pkmAssistant || this.plugin?.settings?.pkmAssistant;
        if (!pkm) return [];
        // TS-boundary: `externalMcpServers` jest polem tools-module-owned w data.json, którego
        // core/runtime/contracts.ts (właściciel PkmAssistantSettings) nie modeluje - mirror
        // ExternalMcpManager._configuredServers().
        if (!Array.isArray((pkm as PkmSettingsWithServers).externalMcpServers)) (pkm as PkmSettingsWithServers).externalMcpServers = [];
        return (pkm as PkmSettingsWithServers).externalMcpServers as ExternalMcpServerConfig[];
    }

    async _handleSave() {
        const f = this.form;

        if (!f.name.trim()) {
            new Notice(t('modal.mcp_server_editor.error_name_required'));
            return;
        }

        // Id validation (slug + no built-in collision) - defense in depth with connect().
        const idCheck = ExternalMcpManager.validateServerId(f.id, this._builtinNames());
        if (!idCheck.ok) {
            new Notice(idCheck.reason === 'reserved'
                ? t('modal.mcp_server_editor.error_id_reserved', { id: f.id })
                : t('modal.mcp_server_editor.error_id_format'));
            return;
        }

        const servers = this._servers();
        // Uniqueness: on add, id must be free; on edit the id is fixed so we skip self.
        if (!this.isEdit && servers.some((s: ExternalMcpServerConfig) => s.id === f.id)) {
            new Notice(t('modal.mcp_server_editor.error_id_exists', { id: f.id }));
            return;
        }

        // Transport-specific required fields.
        if (f.transport === 'stdio' && !f.command.trim()) {
            new Notice(t('modal.mcp_server_editor.error_command_required'));
            return;
        }
        if (f.transport === 'http' && !f.url.trim()) {
            new Notice(t('modal.mcp_server_editor.error_url_required'));
            return;
        }

        // Build clean config (config-only - no runtime status).
        // `enabled` pochodzi z formularza (edycja zachowuje stan wyłącznika usera).
        const config = this._buildConfigFromForm();

        // Persist into settings (data.json). On edit, replace by id in place.
        // Mutacja PRZED zapisem musi się cofnąć, jeśli zapis padnie -
        // inaczej `servers[idx]` zostaje podmieniony w RAM (stara, działająca konfiguracja
        // usera znika z pamięci), a na dysku wciąż leży poprzednia wersja. Wzór
        // `persistOrRollback` z `modules/tools/settingsPersist.ts` - nie importowany
        // wprost, bo nie jest w barrelu `modules/tools/index.ts` (deep-import zakazany przez
        // ZŁOTĄ ZASADĘ / no-restricted-imports); logika jest jednak identyczna: cofnij mutację,
        // zamelduj, przerysowanie ze stanu prawdziwego robi wołacz przez `refresh()` (nie leci
        // `onSaved`, więc lista w Ustawieniach nie odświeży się na fałszywym stanie).
        let editedIdx = -1;
        let previousAtIdx: ExternalMcpServerConfig | undefined;
        if (this.isEdit) {
            const idx = servers.findIndex((s: ExternalMcpServerConfig) => s.id === f.id);
            if (idx >= 0) {
                editedIdx = idx;
                previousAtIdx = servers[idx];
                servers[idx] = config;
            } else {
                servers.push(config);
            }
        } else {
            servers.push(config);
        }

        try {
            await this._save();
        } catch (e) {
            if (editedIdx >= 0) {
                // `previousAtIdx` jest zawsze ustawione razem z `editedIdx >= 0` wyżej.
                servers[editedIdx] = previousAtIdx!;
            } else {
                servers.pop();
            }
            new Notice(t('modal.mcp_server_editor.error_write_failed', { error: (e as ErrLike).message }));
            return;
        }

        new Notice(t('modal.mcp_server_editor.saved_notice', { name: config.name }));
        this.close();
        if (this.onSaved) this.onSaved(config);
    }

    onClose() {
        this.contentEl.empty();
    }
}
