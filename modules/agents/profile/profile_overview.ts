/**
 * Overview tab (Przegląd) - witryna agenta: hero (nazwa/opis/kryształ/kolor/daty inline),
 * podstawowe info (model / autonomia / miejsce pracy) + statystyki.
 *
 * Zasada: to WITRYNA - zero szybkich akcji. Fun facty (tokeny/wywołania narzędzi) odłożone -
 * nie ma taniego per-agent źródła bez nowej maszynerii. Szlif wizualny później - tu funkcjonalna
 * kompletność, bez pikselowania.
 */
import { SkinManager, setSvg } from '../../crystal-soul/index.js';
import { COLOR_GROUPS, getColorByHex } from '../../crystal-soul/index.js';
import { UiIcons } from '../../crystal-soul/index.js';
import { hexToRgbTriplet } from '../../crystal-soul/index.js';
import { t, getDateLocale } from '../../../core/i18n/index.js';

// TS-any: the profile coordinator and Obsidian UI extensions are dynamic runtime boundaries.
type UiBoundary = any;

/**
 * @param {Object} ctx - shared context
 * @param {HTMLElement} el
 */
export async function renderOverviewTab(ctx: UiBoundary, el: HTMLElement) {
    const { formData, agent, agentManager, container, plugin } = ctx;
    const agentColor = agent?.color || formData.color || '#888888';
    const skillCount = formData.skills?.length || 0;
    const subAgentCount = formData.sub_agents?.length || 0;

    let stats = null;
    try { stats = agent ? await agentManager.getAgentStats?.(agent.name) : null; } catch { /* ignore */ }

    // ── HERO ──
    const hero = el.createDiv({ cls: 'cs-profile-hero' });
    const heroInfo = hero.createDiv({ cls: 'cs-profile-hero__info' });

    // Name (inline-editable like description; built-in agents keep a fixed name)
    const nameRow = heroInfo.createDiv({ cls: 'cs-profile-hero__desc-row' });
    const nameText = nameRow.createEl('h2', { text: formData.name, cls: 'cs-profile-hero__name' });
    if (!agent?.isBuiltIn) {
        const nameEditBtn = nameRow.createDiv({ cls: 'cs-profile-hero__edit', attr: { title: t('profile.overview.edit_name') } });
        setSvg(nameEditBtn, UiIcons.edit(10));
        nameEditBtn.addEventListener('click', () => {
            nameText.empty();
            const input = nameText.createEl('input', { cls: 'cs-profile-hero__name-input', attr: { type: 'text' } });
            input.value = formData.name || '';
            input.focus();
            input.select();
            nameEditBtn.addClass('cs-collapsed');
            const save = () => {
                const v = input.value.trim();
                if (v) formData.name = v;
                nameText.empty();
                nameText.textContent = formData.name;
                nameEditBtn.removeClass('cs-collapsed');
            };
            input.addEventListener('blur', save);
            input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
        });
    }

    // Editable description
    const descRow = heroInfo.createDiv({ cls: 'cs-profile-hero__desc-row' });
    const descText = descRow.createDiv({
        cls: 'cs-profile-hero__desc',
        text: formData.description || t('profile.overview.click_to_add_desc')
    });
    if (!formData.description) descText.classList.add('cs-profile-hero__desc--empty');
    const editBtn = descRow.createDiv({ cls: 'cs-profile-hero__edit' });
    setSvg(editBtn, UiIcons.edit(10));
    editBtn.addEventListener('click', () => {
        descText.empty();
        const input = descText.createEl('textarea', {
            cls: 'cs-profile-hero__desc-input',
            attr: { rows: 2, placeholder: t('profile.overview.desc_placeholder') }
        });
        input.value = formData.description || '';
        input.focus();
        editBtn.addClass('cs-collapsed');
        const save = () => {
            formData.description = input.value.trim();
            descText.empty();
            descText.textContent = formData.description || t('profile.overview.click_to_add_desc');
            descText.classList.toggle('cs-profile-hero__desc--empty', !formData.description);
            editBtn.removeClass('cs-collapsed');
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
    });

    // Meta - daty
    const heroMeta = heroInfo.createDiv({ cls: 'cs-profile-hero__meta' });
    if (formData.createdAt) {
        heroMeta.createSpan({ text: new Date(formData.createdAt).toLocaleDateString(getDateLocale()), cls: 'cs-profile-hero__date' });
    }
    if (stats?.lastActivity) {
        heroMeta.createSpan({ text: t('profile.overview.active_prefix') + new Date(stats.lastActivity).toLocaleDateString(getDateLocale()), cls: 'cs-profile-hero__date' });
    }

    // Color picker row
    const colorRow = heroInfo.createDiv({ cls: 'cs-profile-hero__color-row' });
    const colorDot = colorRow.createDiv({ cls: 'cs-profile-hero__color-dot cs-dyn-bg' });
    colorDot.style.setProperty('--cs-dyn-bg', agentColor);
    const colorMatch = getColorByHex(agentColor);
    const colorLabel = colorRow.createSpan({ text: colorMatch?.name || agentColor, cls: 'cs-profile-hero__color-hex' });

    const applyColor = (hex: string) => {
        colorDot.style.setProperty('--cs-dyn-bg', hex);
        const match = getColorByHex(hex);
        colorLabel.textContent = match?.name || hex;
        formData.color = hex;
        const rgb = hexToRgbTriplet(hex);
        container.style.setProperty('--cs-agent-color-rgb', rgb);
        const overviewSeed = formData.crystal_seed || formData.name;
        setSvg(crystalBox, SkinManager.getCrystal({ name: overviewSeed, color: hex }, { size: 100, color: hex, glow: true }));
    };

    let palettePopup: HTMLElement | null = null;
    const togglePalette = () => {
        if (palettePopup) { palettePopup.remove(); palettePopup = null; return; }
        palettePopup = heroInfo.createDiv({ cls: 'cs-palette-popup' });
        for (const colors of Object.values(COLOR_GROUPS)) {
            const row = palettePopup.createDiv({ cls: 'cs-palette-popup__row' });
            for (const c of colors) {
                const swatch = row.createDiv({ cls: 'cs-palette-popup__swatch cs-dyn-bg' });
                swatch.style.setProperty('--cs-dyn-bg', c.hex);
                swatch.title = c.name;
                if (c.hex.toLowerCase() === (formData.color || agentColor).toLowerCase()) {
                    swatch.classList.add('cs-palette-popup__swatch--active');
                }
                swatch.addEventListener('click', () => {
                    applyColor(c.hex);
                    palettePopup!.remove();
                    palettePopup = null;
                });
            }
        }
    };
    colorDot.addEventListener('click', togglePalette);
    colorLabel.addEventListener('click', togglePalette);

    // Reshape crystal (reroll seed) - kryształ+kolor żyją w Przeglądzie.
    let reshapeCounter = 0;
    const reshapeBtn = colorRow.createEl('button', {
        cls: 'cs-preset-btn cs-profile-hero__reshape',
        attr: { title: t('profile.persona.reroll_shape') }
    });
    setSvg(reshapeBtn, UiIcons.refresh ? UiIcons.refresh(11) : '↻');
    reshapeBtn.addEventListener('click', () => {
        reshapeCounter++;
        formData.crystal_seed = `${formData.name || 'Agent'}#${reshapeCounter}#${Date.now()}`;
        const hex = formData.color || agentColor;
        setSvg(crystalBox, SkinManager.getCrystal({ name: formData.crystal_seed, color: hex }, { size: 100, color: hex, glow: true }));
    });

    const overviewCrystalSeed = formData.crystal_seed || formData.name;
    const crystalBox = hero.createDiv({ cls: 'cs-profile__crystal' });
    setSvg(crystalBox, SkinManager.getCrystal({ name: overviewCrystalSeed, color: agentColor }, { size: 100, color: agentColor, glow: true }));

    // ── PODSTAWOWE INFO ──
    _sectionHead(el, UiIcons.settings(14), t('profile.overview.basic_info'));
    const infoGrid = el.createDiv({ cls: 'cs-shards' });

    const autonomyMode = agent?.default_autonomy || plugin?.env?.settings?.pkmAssistant?.defaultAutonomy || 'edge';
    // Kanon to models.main - legacy formData.model gaśnie po sync w AgentProfileView.ts
    // (modelFieldSync.ts), więc czytanie samego formData.model tu pokazywałoby „globalny" dla
    // KAŻDEGO agenta ze zmigrowanym modelem, mimo że ma jawnie ustawiony.
    const mainModel = formData.models?.main || '';
    _shard(infoGrid, t('profile.overview.model'), mainModel || t('profile.overview.global'), null, !!mainModel);
    _shard(infoGrid, t('profile.overview.default_autonomy'), t(`autonomy.${autonomyMode}`),
        agent?.default_autonomy ? t('profile.overview.autonomy_per_agent') : t('profile.overview.autonomy_global'), true);

    const workspace = _workspaceSummary(formData);
    _shard(infoGrid, t('profile.overview.workspace'), workspace.value, workspace.sub, workspace.filled);

    // ── STATYSTYKI ──
    _sectionHead(el, UiIcons.zap(14), t('profile.overview.statistics'));
    const statGrid = el.createDiv({ cls: 'cs-shards' });
    const brainKb = stats?.brainSize ? `${Math.round(stats.brainSize / 1024)} KB` : '0 KB';
    _shard(statGrid, t('profile.overview.sessions'), String(stats?.sessionCount ?? 0), null, (stats?.sessionCount ?? 0) > 0);
    _shard(statGrid, t('profile.overview.skills'), String(skillCount), null, skillCount > 0);
    _shard(statGrid, t('profile.overview.team'), String(subAgentCount), null, subAgentCount > 0);
    _shard(statGrid, t('profile.overview.brain_notes'),
        `${stats?.brainNoteCount ?? 0} ${t('profile.overview.notes_unit')}`, brainKb, (stats?.brainNoteCount ?? 0) > 0);
    _shard(statGrid, t('profile.overview.summaries_l1l2'),
        `${stats?.l1Count ?? 0} / ${stats?.l2Count ?? 0}`, null, (stats?.l1Count ?? 0) > 0);
    _shard(statGrid, t('profile.overview.archive_sessions'), String(stats?.archiveCount ?? 0), null, (stats?.archiveCount ?? 0) > 0);
}

/** Section header (icon + label). */
function _sectionHead(el: HTMLElement, iconHtml: string, label: string) {
    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, iconHtml);
    head.createSpan({ text: label });
}

/** Single stat shard (value + label + optional sub-label). */
function _shard(grid: HTMLElement, label: string, value: string, sub: string | null, filled: boolean) {
    const shard = grid.createDiv({ cls: `cs-shard ${filled ? 'cs-shard--filled' : 'cs-shard--empty'}` });
    shard.createDiv({ cls: 'cs-shard__value cs-shard__value--has', text: value });
    shard.createDiv({ cls: 'cs-shard__main-label', text: label });
    if (sub) shard.createDiv({ cls: 'cs-shard__sub-label', text: sub });
}

/** Human summary of the agent workspace (focus folders / whole vault). */
function _workspaceSummary(formData: UiBoundary) {
    const focus = formData.focus_folders || [];
    if (focus.length === 0) {
        return { value: t('profile.overview.whole_vault'), sub: null, filled: false };
    }
    const first = focus[0];
    const value = first.group ? `📦 ${first.group}` : (first.path || '');
    const sub = focus.length > 1 ? t('profile.overview.and_more', { count: focus.length - 1 }) : null;
    return { value, sub, filled: true };
}
