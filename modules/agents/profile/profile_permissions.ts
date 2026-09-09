/**
 * Permissions tab (Uprawnienia). Trzy sekcje:
 *  1. „Co może robić" - grupy narzędzi (manifesty) → dropdown z toggle per narzędzie
 *     (edytuje jedną oś `disabled_tools`) + „Pamięć agenta (odczyt)" (permissions.memory).
 *  2. „Miejsce pracy" - tryb Pełen dostęp / Tylko przypisane (guidance_mode) + przypisane
 *     foldery (chipy 👁️/📝) + GRUPY z Settings→Vault + podgląd mapy vaulta.
 *  3. „Kiedy pyta" - domyślna autonomia per agent + pytania przed działaniem (approval).
 *
 * Terminologia: w UI ZAWSZE „przypisane foldery"; zero „guidance mode"/„whitelist".
 */
import { Notice } from 'obsidian';
import { APPROVAL_DEFAULTS, getAgentSafeName } from '../../../core/index.js';
import { HiddenFileEditorModal } from './HiddenFileEditorModal.js';
import { UiIcons, setSvgLabel, setSvg } from '../../crystal-soul/index.js';
import { renderToggle, renderShard, getAllVaultFolders } from './profile_helpers.js';
import { BUILTIN_TOOL_GROUPS, GROUP_META, getGroupLabel, getPermissionToolLabel } from '../toolAxis.js';
import { t } from '../../../core/i18n/index.js';

// TS-any: permissions UI reads dynamic vault/group and plugin extension data.
type UiBoundary = any;
import { log } from '../../../core/utils/Logger.js';

/**
 * @param {Object} ctx - shared context
 * @param {HTMLElement} el
 */
export function renderPermissionsTab(ctx: UiBoundary, el: HTMLElement) {
    const { formData, agent } = ctx;
    // Bufor inicjalizowany TYLKO gdy jeszcze nie istnieje - wzór linii niżej (`disabled_tools`)
    // i `approval_toggles` (sekcja 3). Bez tego guardu każdy powrót na tę zakładkę nadpisywał
    // niezapisane zmiany (tryb dostępu, pamięć agenta) kopią z dysku - `formData.permissions`
    // już RAZ powstaje w `AgentProfileView.ts` przy otwarciu panelu.
    if (agent && !formData.permissions) formData.permissions = { ...agent.permissions };
    if (!Array.isArray(formData.disabled_tools)) formData.disabled_tools = [...(agent?.disabled_tools || [])];

    _renderToolGroups(ctx, el);
    _renderWorkspace(ctx, el);
    _renderWhenAsks(ctx, el);
}

// ─────────────────────────────────────────────────────────────
// SEKCJA 1 - Co może robić (narzędzia, jedna oś disabled_tools)
// ─────────────────────────────────────────────────────────────

function _renderToolGroups(ctx: UiBoundary, el: HTMLElement) {
    const { formData, plugin } = ctx;

    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.shield(14));
    head.createSpan({ text: t('profile.perm.section_can_do') });
    el.createDiv({ text: t('profile.perm.section_can_do_desc'), cls: 'setting-item-description' });

    // Które narzędzia są realnie zarejestrowane (np. komunikator znika przy kill-switchu).
    const registered = new Set(plugin?.toolRegistry?.getAllToolNames?.() || []);
    const isRegistered = (name: string) => registered.size === 0 || registered.has(name);

    const disabled = new Set(formData.disabled_tools);
    const commit = () => { formData.disabled_tools = [...disabled]; };

    for (const [group, tools] of Object.entries(BUILTIN_TOOL_GROUPS)) {
        if (group === 'core') continue; // ask_user zawsze ON, nieusuwalny
        const groupTools = tools.filter(isRegistered);
        const isMemory = group === 'memory';
        if (groupTools.length === 0 && !isMemory) continue;

        const meta = GROUP_META[group] || {};
        const groupHead = el.createDiv({ cls: 'cs-section-head cs-section-head--clickable' });
        const titleSpan = groupHead.createSpan();
        const body = el.createDiv({ cls: 'cs-group-b-toggles cs-collapsed' });

        const enabledCount = () => groupTools.filter(tn => !disabled.has(tn)).length;
        const renderTitle = () => {
            titleSpan.textContent = `${meta.icon || ''} ${getGroupLabel(group)}  ${enabledCount()}/${groupTools.length} ▾`;
        };
        renderTitle();
        groupHead.addEventListener('click', () => {
            body.classList.toggle('cs-collapsed');
        });

        for (const toolName of groupTools) {
            renderToggle(body, getPermissionToolLabel(toolName), null, !disabled.has(toolName), (v) => {
                if (v) disabled.delete(toolName); else disabled.add(toolName);
                commit();
                renderTitle();
            });
        }

        // Pamięć: dodatkowa pozycja „Pamięć agenta (odczyt)" = permissions.memory (nie narzędzie).
        if (isMemory) {
            renderToggle(body, t('tools.memory_read.label'), t('tools.memory_read.desc'),
                formData.permissions.memory === true, (v) => { formData.permissions.memory = v; });
        }

        // Komunikator ma DRUGĄ oś - samo uczestnictwo. Wyłączony agent jest duchem
        // (nie ma go na liście adresatów, skrzynka znika z paneli, ping milczy), niezależnie
        // od tego, czy ma włączone narzędzia poczty.
        if (group === 'komunikator') {
            renderToggle(body, t('profile.perm.komunikator_visible'), t('profile.perm.komunikator_visible_hint'),
                formData.komunikator_visible !== false, (v) => { formData.komunikator_visible = v; });
        }
    }
}

// ─────────────────────────────────────────────────────────────
// SEKCJA 2 - Miejsce pracy (tryb + przypisane foldery + grupy)
// ─────────────────────────────────────────────────────────────

function _renderWorkspace(ctx: UiBoundary, el: HTMLElement) {
    const { formData } = ctx;

    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.folder(14));
    head.createSpan({ text: t('profile.perm.section_workspace') });

    // Tryb: Pełen dostęp (guidance_mode=true) / Tylko przypisane (guidance_mode=false).
    const seg = el.createDiv({ cls: 'cs-preset-row' });
    const modeDesc = el.createDiv({ cls: 'setting-item-description' });
    const modes = [
        { val: true, label: t('profile.perm.mode_full') },
        { val: false, label: t('profile.perm.mode_assigned') },
    ];
    const renderMode = () => {
        seg.empty();
        const isFull = formData.permissions.guidance_mode === true;
        for (const m of modes) {
            const active = isFull === m.val;
            const btn = seg.createEl('button', { text: m.label, cls: `cs-preset-btn ${active ? 'cs-preset-btn--active' : ''}` });
            btn.addEventListener('click', () => { formData.permissions.guidance_mode = m.val; renderMode(); });
        }
        modeDesc.textContent = isFull ? t('profile.perm.mode_full_desc') : t('profile.perm.mode_assigned_desc');
    };
    renderMode();

    _renderFocusFoldersSection(ctx, el);
    _renderVaultMapPreview(ctx, el);
}

function _renderFocusFoldersSection(ctx: UiBoundary, el: HTMLElement) {
    const { formData, plugin } = ctx;
    const section = el.createDiv({ cls: 'cs-focus-section' });
    section.createDiv({ text: t('profile.perm.assigned_folders'), cls: 'setting-item-name' });
    section.createDiv({ text: t('profile.perm.assigned_folders_desc'), cls: 'setting-item-description' });

    const chipContainer = section.createDiv({ cls: 'cs-focus-chips' });
    const rerender = () => _renderFocusChips(ctx, chipContainer, rerender);
    rerender();

    // + folder (autouzupełnianie)
    const inputRow = section.createDiv({ cls: 'cs-focus-input-row' });
    const input = inputRow.createEl('input', { type: 'text', placeholder: t('profile.perm.folder_placeholder'), cls: 'cs-focus-input' });
    const addBtn = inputRow.createEl('button', { text: '+', cls: 'cs-focus-add-btn' });
    const dropdown = section.createDiv({ cls: 'cs-focus-dropdown cs-collapsed' });
    const allFolders = getAllVaultFolders(plugin.app);

    input.addEventListener('input', () => {
        const query = input.value.trim().toLowerCase();
        dropdown.empty();
        if (!query) { dropdown.addClass('cs-collapsed'); return; }
        const existing = formData.focus_folders.filter((f: UiBoundary) => !f.group).map((f: UiBoundary) => typeof f === 'string' ? f : f.path);
        const matches = allFolders.filter(f => f.toLowerCase().includes(query) && !existing.includes(f)).slice(0, 10);
        if (matches.length === 0) { dropdown.addClass('cs-collapsed'); return; }
        dropdown.removeClass('cs-collapsed');
        for (const folder of matches) {
            const item = dropdown.createDiv({ cls: 'cs-focus-suggestion' });
            setSvgLabel(item, UiIcons.folder(12), folder);
            item.addEventListener('click', () => { input.value = folder; dropdown.addClass('cs-collapsed'); input.focus(); });
        }
    });
    input.addEventListener('blur', () => { window.setTimeout(() => { dropdown.addClass('cs-collapsed'); }, 200); });

    const addManualFolder = () => {
        const value = input.value.trim();
        if (!value) return;
        const existing = formData.focus_folders.filter((f: UiBoundary) => !f.group).map((f: UiBoundary) => typeof f === 'string' ? f : f.path);
        if (existing.includes(value)) return;
        formData.focus_folders.push({ path: value, access: 'readwrite' });
        rerender();
        input.value = '';
        dropdown.addClass('cs-collapsed');
    };
    addBtn.addEventListener('click', addManualFolder);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addManualFolder(); });

    // + grupa z Settings→Vault + link zarządzania.
    _renderGroupAdd(ctx, section, rerender);
}

/** Render both plain-folder chips and group-reference chips (📦). */
function _renderFocusChips(ctx: UiBoundary, container: HTMLElement, rerender: () => void) {
    const { formData, plugin } = ctx;
    container.empty();
    if (formData.focus_folders.length === 0) {
        container.createSpan({ text: t('profile.perm.no_restrictions'), cls: 'cs-focus-empty' });
        return;
    }
    const vaultGroups = _getVaultGroups(plugin);

    for (let i = 0; i < formData.focus_folders.length; i++) {
        const entry = formData.focus_folders[i];

        // Group reference chip
        if (entry && entry.group) {
            const def = vaultGroups.find((g: UiBoundary) => g.name === entry.group);
            const folderCount = def?.folders?.length ?? 0;
            const chip = container.createDiv({ cls: 'cs-focus-chip cs-focus-chip--group' });
            const nameSpan = chip.createSpan({ cls: 'cs-focus-chip__name' });
            nameSpan.textContent = `📦 ${t('profile.perm.group_prefix')}: ${entry.group}  (${folderCount} ▾)`;
            const preview = chip.createDiv({ cls: 'cs-focus-chip__preview cs-collapsed' });
            if (def?.folders?.length) {
                for (const f of def.folders) {
                    const icon = (f.access === 'read') ? '👁️' : '📝';
                    preview.createDiv({ cls: 'cs-focus-hint', text: `${icon} ${f.path}` });
                }
            } else {
                preview.createDiv({ cls: 'cs-focus-hint', text: t('profile.perm.group_missing') });
            }
            nameSpan.addEventListener('click', () => {
                preview.classList.toggle('cs-collapsed');
            });
            const removeBtn = chip.createSpan({ text: '×', cls: 'cs-focus-chip__remove' });
            removeBtn.addEventListener('click', (e) => { e.stopPropagation(); formData.focus_folders.splice(i, 1); rerender(); });
            continue;
        }

        // Plain folder chip (per-folder 👁️/📝)
        const path = typeof entry === 'string' ? entry : entry.path;
        const access = typeof entry === 'string' ? 'readwrite' : (entry.access || 'readwrite');
        const chip = container.createDiv({ cls: 'cs-focus-chip' });
        const chipNameSpan = chip.createSpan({ cls: 'cs-focus-chip__name' });
        setSvgLabel(chipNameSpan, UiIcons.folder(12), path);

        const accessBtn = chip.createSpan({ cls: 'cs-focus-chip__access' });
        setSvg(accessBtn, access === 'read' ? UiIcons.eye(12) : UiIcons.edit(12));
        accessBtn.title = access === 'read' ? t('profile.perm.read_only_title') : t('profile.perm.readwrite_title');
        accessBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            formData.focus_folders[i] = { path, access: access === 'read' ? 'readwrite' : 'read' };
            rerender();
        });

        const removeBtn = chip.createSpan({ text: '×', cls: 'cs-focus-chip__remove' });
        removeBtn.addEventListener('click', (e) => { e.stopPropagation(); formData.focus_folders.splice(i, 1); rerender(); });
    }
}

/** „+ grupa z Vaulta" button (menu of defined groups) + manage-groups link. */
function _renderGroupAdd(ctx: UiBoundary, section: HTMLElement, rerender: () => void) {
    const { formData, plugin } = ctx;
    const row = section.createDiv({ cls: 'cs-focus-group-row' });

    const addGroupBtn = row.createEl('button', { text: t('profile.perm.add_group'), cls: 'cs-focus-add-btn' });
    const menu = section.createDiv({ cls: 'cs-focus-dropdown cs-collapsed' });

    addGroupBtn.addEventListener('click', () => {
        menu.empty();
        const groups = _getVaultGroups(plugin);
        const used = new Set(formData.focus_folders.filter((f: UiBoundary) => f.group).map((f: UiBoundary) => f.group));
        const available = groups.filter((g: UiBoundary) => g.name && !used.has(g.name));
        if (available.length === 0) {
            menu.removeClass('cs-collapsed');
            menu.createDiv({ cls: 'cs-focus-suggestion', text: t('profile.perm.no_groups') });
            window.setTimeout(() => { menu.addClass('cs-collapsed'); }, 2500);
            return;
        }
        menu.removeClass('cs-collapsed');
        for (const g of available) {
            const item = menu.createDiv({ cls: 'cs-focus-suggestion', text: `📦 ${g.name} (${g.folders?.length || 0})` });
            item.addEventListener('click', () => {
                formData.focus_folders.push({ group: g.name });
                menu.addClass('cs-collapsed');
                rerender();
            });
        }
    });

    // Link „zarządzaj grupami → Settings → Vault"
    const link = row.createEl('a', { text: t('profile.perm.manage_groups'), cls: 'cs-focus-hint', href: '#' });
    link.addEventListener('click', (e) => {
        e.preventDefault();
        try {
            plugin.app.setting?.open?.();
            plugin.app.setting?.openTabById?.(plugin.manifest?.id || 'pkm-assistant');
        } catch { /* opening settings is best-effort */ }
    });
}

function _getVaultGroups(plugin: UiBoundary) {
    const pkm = plugin?.env?.settings?.pkmAssistant || plugin?.settings?.pkmAssistant || {};
    return Array.isArray(pkm.vaultGroups) ? pkm.vaultGroups : [];
}

function _renderVaultMapPreview(ctx: UiBoundary, parentEl: HTMLElement) {
    const { agent, plugin, formData } = ctx;
    const section = parentEl.createDiv({ cls: 'cs-vault-map' });

    const previewBtn = section.createEl('button', { cls: 'cs-vault-map__btn' });
    setSvgLabel(previewBtn, UiIcons.compass(14), t('profile.perm.vault_map_preview'));

    previewBtn.addEventListener('click', () => {
        void (async () => {
            if (!agent) { new Notice(t('profile.perm.save_before_preview')); return; }
            previewBtn.disabled = true;
            setSvgLabel(previewBtn, UiIcons.hourglass(14), t('profile.perm.compiling'));
            const origFolders = agent.focusFolders;
            try {
                const playbookManager = plugin.agentManager?.playbookManager;
                if (!playbookManager) { new Notice(t('profile.perm.playbook_unavailable')); return; }
                agent.focusFolders = formData.focus_folders;
                const compiled = await playbookManager.compileVaultMap(agent, plugin);
                const safeName = getAgentSafeName(agent.name);
                const path = `.pkm-assistant/agents/${safeName}/vault_map.md`;
                new HiddenFileEditorModal(plugin.app, path, `Vault Map: ${agent.name}`, compiled, {
                    agentName: agent.name, agentColor: agent.color || '', readOnly: true
                }).open();
            } catch (e: unknown) {
                log.error('VaultMapPreview', 'Error:', e);
                new Notice(t('profile.perm.vault_map_error') + (e as Error).message);
            } finally {
                agent.focusFolders = origFolders;
                previewBtn.disabled = false;
                setSvgLabel(previewBtn, UiIcons.compass(14), t('profile.perm.vault_map_preview'));
            }
        })();
    });

    section.createDiv({ text: t('profile.perm.vault_map_hint'), cls: 'cs-focus-hint' });
}

// ─────────────────────────────────────────────────────────────
// SEKCJA 3 - Kiedy pyta (autonomia per agent + approval toggles)
// ─────────────────────────────────────────────────────────────

function _renderWhenAsks(ctx: UiBoundary, el: HTMLElement) {
    const { formData } = ctx;

    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.shield(14));
    head.createSpan({ text: t('profile.perm.section_when_asks') });

    // Domyślna autonomia per agent ('' = globalny default z Settings).
    const grid = el.createDiv({ cls: 'cs-shards' });
    renderShard(grid, t('profile.perm.default_autonomy'), t('profile.perm.default_autonomy_hint'),
        formData.default_autonomy || '', 'select',
        v => formData.default_autonomy = v, {
            options: [
                { value: '', label: t('profile.perm.autonomy_global') },
                { value: 'yolo', label: t('autonomy.yolo') },
                { value: 'edge', label: t('autonomy.edge') },
                { value: 'all', label: t('autonomy.all') },
            ]
        });

    _renderApprovalToggles(ctx, el);
}

function _renderApprovalToggles(ctx: UiBoundary, el: HTMLElement) {
    const { formData, agent } = ctx;

    if (!formData.approval_toggles) {
        formData.approval_toggles = { ...(agent?.approvalToggles || {}) };
    }

    el.createDiv({ text: t('profile.perm.action_notifications_desc'), cls: 'setting-item-description' });

    // YELLOW - odwracalne/ograniczone akcje. Toggle działa wyłącznie dla żółtych.
    const groupA = [
        { key: 'vault_write', tool: 'write', label: t('profile.perm.create_file_only') },
        { key: 'vault_create_folder', tool: 'create_folder' },
        { key: 'memory_save', tool: 'memory_save' },
        { key: 'web_search', tool: 'web_search' },
        // Osobny wiersz dla pobierania strony - niezależny toggle od web_search.
        { key: 'web_read', tool: 'web_read' },
        { key: 'generate_image', tool: 'generate_image' },
        // Wysyłka poczty do innego agenta (YELLOW, default „pytaj").
        { key: 'kom_send', tool: 'kom_send' },
    ];
    for (const { key, tool, label } of groupA) {
        const defaultVal = APPROVAL_DEFAULTS[key] ?? true;
        const currentVal = formData.approval_toggles[key] ?? defaultVal;
        renderToggle(el, label || getPermissionToolLabel(tool), t('profile.perm.ask_before'), currentVal,
            v => { formData.approval_toggles[key] = v; });
    }

    // Pozostałe YELLOW - domyślnie ciche (rozwijane).
    const groupBHead = el.createDiv({ cls: 'cs-section-head cs-section-head--clickable' });
    setSvg(groupBHead, UiIcons.settings(14));
    groupBHead.createSpan({ text: t('profile.perm.optional_notifications') });
    const groupBContainer = el.createDiv({ cls: 'cs-group-b-toggles cs-collapsed' });
    groupBHead.addEventListener('click', () => {
        groupBContainer.classList.toggle('cs-collapsed');
    });

    const groupB = [
        { key: 'delegate', tool: 'delegate' },
        // Artefakty żywe - domyślnie bez pytania.
        { key: 'artifact_create', tool: 'artifact_create' },
        { key: 'artifact_update', tool: 'artifact_update' },
        { key: 'todo', tool: 'todo' },
    ];
    for (const { key, tool } of groupB) {
        const defaultVal = APPROVAL_DEFAULTS[key] ?? false;
        const currentVal = formData.approval_toggles[key] ?? defaultVal;
        renderToggle(groupBContainer, getPermissionToolLabel(tool), t('profile.perm.ask_before'), currentVal,
            v => { formData.approval_toggles[key] = v; });
    }

    const redHead = el.createDiv({ cls: 'cs-section-head' });
    setSvg(redHead, UiIcons.lock(14));
    redHead.createSpan({ text: t('profile.perm.risk_red_title') });
    el.createDiv({ text: t('profile.perm.risk_red_desc'), cls: 'setting-item-description' });
}
