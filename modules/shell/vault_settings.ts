import { t } from '../../core/i18n/index.js';
import { AccessGuard } from '../../core/index.js';
import { setSvgLabel } from '../../modules/crystal-soul/index.js';
import type { ButtonComponent, TextComponent, ToggleComponent } from 'obsidian';

interface VaultFolderSetting {
    path: string;
    access: string;
}

type VaultFolderEntry = string | VaultFolderSetting;

interface VaultGroupSetting {
    name: string;
    folders: VaultFolderEntry[];
}

interface VaultPkmSettings {
    vaultGroups: VaultGroupSetting[];
    artifactsFolder?: string;
    indexArtifacts?: boolean;
}

interface LoadedVaultFileLike {
    path: string;
    children?: unknown;
}

interface VaultAgentManagerLike {
    readVaultMap?(): Promise<string>;
    writeVaultMap?(content: string): Promise<unknown>;
}

interface VaultPluginLike {
    app?: { vault?: { getAllLoadedFiles?(): LoadedVaultFileLike[] } };
    agentManager?: VaultAgentManagerLike;
}

interface VaultIconsLike {
    folder?: (size: number) => string;
    globe?: (size: number) => string;
}

interface VaultSectionContext {
    pkm: VaultPkmSettings;
    save: () => Promise<unknown>;
    icons?: VaultIconsLike;
    Setting: typeof import('obsidian').Setting;
    plugin?: VaultPluginLike;
}

/**
 * Settings → Vault (E2.8 B1 / S19b).
 *
 * Two things live here, both consumed by agents' focus folders / the environment prompt:
 *  1. GRUPY folderów — named, reusable bundles of folders (`settings.pkmAssistant.vaultGroups`).
 *     An agent references a group via `{group: 'Nazwa'}` in its focus folders (assignment UI = phase C).
 *  2. Opisy stref vaulta — the global vault map (`.pkm-assistant/agents/vault_map.md`): folder
 *     descriptions appended to the environment section of every agent's system prompt.
 */
export function renderVaultSection(container: HTMLElement, ctx: VaultSectionContext): void {
    const { pkm, save, icons, Setting, plugin } = ctx;
    container.classList.add('cs-root');

    if (!Array.isArray(pkm.vaultGroups)) pkm.vaultGroups = [];

    const h2 = new Setting(container).setHeading();
    h2.settingEl.addClass('cs-settings-section');
    setSvgLabel(h2.nameEl, icons?.folder?.(18) || icons?.globe?.(18) || '', t('settings.vault_title'));
    container.createEl('p', { text: t('settings.vault_desc'), cls: 'setting-item-description' });

    // Shared folder autocomplete (all vault folders).
    const datalist = container.createEl('datalist');
    datalist.id = 'pkm-vault-folder-suggestions';
    try {
        const folders = (plugin?.app?.vault?.getAllLoadedFiles?.() || [])
            .filter(f => f && f.children) // TFolder has children
            .map(f => f.path)
            .filter(p => p && p !== '/');
        for (const p of folders.sort()) datalist.createEl('option', { value: p });
    } catch { /* no vault (tests) → empty datalist */ }

    // ── Section A: folder groups ──
    container.createEl('h4', { text: t('settings.vault_groups_title') });
    container.createEl('p', { text: t('settings.vault_groups_desc'), cls: 'setting-item-description' });

    const groupsWrap = container.createDiv({ cls: 'pkm-vault-groups' });

    const persist = async () => {
        await save();
        AccessGuard.setVaultGroups(pkm.vaultGroups); // live refresh for `{group}` resolution
    };

    const makeFolderInput = (value: string): HTMLInputElement => {
        // Element odklejony (dopięty ręcznie przez appendChild niżej) — global `createEl` Obsidiana
        // zamiast document.createElement (obsidianmd/prefer-create-el), ten sam kształt atrybutów.
        const input = createEl('input', {
            type: 'text',
            cls: 'pkm-vault-folder-input',
            attr: { list: datalist.id, placeholder: t('settings.vault_group_folder_placeholder') },
        });
        if (value) input.value = value;
        return input;
    };

    const renderGroups = () => {
        groupsWrap.empty();

        pkm.vaultGroups.forEach((group, gi) => {
            if (!group.folders) group.folders = [];
            const card = groupsWrap.createDiv({ cls: 'pkm-vault-group-card' });

            const head = card.createDiv({ cls: 'pkm-vault-group-head' });
            const nameInput = head.createEl('input', { type: 'text', value: group.name || '', cls: 'pkm-vault-group-name' });
            nameInput.placeholder = t('settings.vault_group_name_placeholder');
            nameInput.addEventListener('change', () => {
                void (async () => {
                    group.name = nameInput.value.trim();
                    await persist();
                })();
            });
            const delBtn = head.createEl('button', { text: '🗑', cls: 'clickable-icon' });
            delBtn.setAttribute('aria-label', t('settings.vault_group_remove'));
            delBtn.addEventListener('click', () => {
                void (async () => {
                    pkm.vaultGroups.splice(gi, 1);
                    await persist();
                    renderGroups();
                })();
            });

            // Folder rows
            group.folders.forEach((folder, fi) => {
                const path = typeof folder === 'string' ? folder : (folder.path || '');
                const access = typeof folder === 'string' ? 'readwrite' : (folder.access || 'readwrite');
                const row = card.createDiv({ cls: 'pkm-vault-folder-row' });

                const pathInput = makeFolderInput(path);
                row.appendChild(pathInput);
                pathInput.addEventListener('change', () => {
                    void (async () => {
                        group.folders[fi] = { path: pathInput.value.trim(), access };
                        await persist();
                    })();
                });

                const accessSel = row.createEl('select');
                accessSel.createEl('option', { value: 'readwrite', text: `📝 ${t('settings.vault_access_readwrite')}` });
                accessSel.createEl('option', { value: 'read', text: `👁️ ${t('settings.vault_access_read')}` });
                accessSel.value = access;
                accessSel.addEventListener('change', () => {
                    void (async () => {
                        group.folders[fi] = { path: pathInput.value.trim(), access: accessSel.value };
                        await persist();
                    })();
                });

                const rmFolder = row.createEl('button', { text: '✕', cls: 'clickable-icon' });
                rmFolder.setAttribute('aria-label', t('settings.vault_group_folder_remove'));
                rmFolder.addEventListener('click', () => {
                    void (async () => {
                        group.folders.splice(fi, 1);
                        await persist();
                        renderGroups();
                    })();
                });
            });

            // Add-folder row
            const addRow = card.createDiv({ cls: 'pkm-vault-folder-add-row' });
            const newPath = makeFolderInput('');
            addRow.appendChild(newPath);
            const addFolderBtn = addRow.createEl('button', { text: `+ ${t('settings.vault_group_folder_add')}` });
            addFolderBtn.addEventListener('click', () => {
                void (async () => {
                    const val = newPath.value.trim();
                    if (!val) return;
                    group.folders.push({ path: val, access: 'readwrite' });
                    await persist();
                    renderGroups();
                })();
            });
        });
    };
    renderGroups();

    new Setting(container)
        .setName(t('settings.vault_group_add'))
        .setDesc(t('settings.vault_group_add_desc'))
        .addText((text: TextComponent) => {
            text.setPlaceholder(t('settings.vault_group_name_placeholder'));
            text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
                void (async () => {
                    if (e.key === 'Enter' && text.getValue().trim()) {
                        pkm.vaultGroups.push({ name: text.getValue().trim(), folders: [] });
                        text.setValue('');
                        await persist();
                        renderGroups();
                    }
                })();
            });
        })
        .addButton((btn: ButtonComponent) => btn
            .setButtonText(t('settings.vault_group_add'))
            .setCta()
            .onClick(async () => {
                pkm.vaultGroups.push({ name: t('settings.vault_group_new_name'), folders: [] });
                await persist();
                renderGroups();
            }));

    // ── Section B: vault zone descriptions (global vault map) ──
    container.createEl('h4', { text: t('settings.vault_map_title') });
    container.createEl('p', { text: t('settings.vault_map_desc'), cls: 'setting-item-description' });

    const mapArea = container.createEl('textarea', { cls: 'cs-prompt-textarea cs-prompt-textarea--vault-map' });
    mapArea.placeholder = t('settings.vault_map_placeholder');

    const mgr = plugin?.agentManager;
    if (mgr?.readVaultMap) {
        mgr.readVaultMap().then((content: string) => { mapArea.value = content || ''; }).catch(() => {});
    } else {
        mapArea.disabled = true;
        mapArea.placeholder = t('settings.vault_map_unavailable');
    }

    const mapControls = container.createDiv({ cls: 'pkm-vault-map-controls' });
    const saveMapBtn = mapControls.createEl('button', { text: t('settings.vault_map_save'), cls: 'mod-cta' });
    saveMapBtn.addEventListener('click', () => {
        void (async () => {
            if (!mgr?.writeVaultMap) return;
            await mgr.writeVaultMap(mapArea.value);
            saveMapBtn.textContent = t('settings.vault_map_saved');
            window.setTimeout(() => { saveMapBtn.textContent = t('settings.vault_map_save'); }, 1500);
        })();
    });

    // ── Section C: artefakty żywe (E2.9) ──
    container.createEl('h4', { text: t('settings.artifacts_title') });
    container.createEl('p', { text: t('settings.artifacts_desc'), cls: 'setting-item-description' });

    new Setting(container)
        .setName(t('settings.artifacts_folder'))
        .setDesc(t('settings.artifacts_folder_desc'))
        .addText((text: TextComponent) => {
            text.setPlaceholder('PKM Assistant/Artefakty');
            text.setValue(pkm.artifactsFolder || 'PKM Assistant/Artefakty');
            text.onChange(async (v) => {
                pkm.artifactsFolder = v.trim() || 'PKM Assistant/Artefakty';
                await save();
            });
        });

    new Setting(container)
        .setName(t('settings.artifacts_index'))
        .setDesc(t('settings.artifacts_index_desc'))
        .addToggle((toggle: ToggleComponent) => {
            toggle.setValue(pkm.indexArtifacts === true);
            toggle.onChange(async (v) => {
                pkm.indexArtifacts = v;
                await save();
            });
        });
}
