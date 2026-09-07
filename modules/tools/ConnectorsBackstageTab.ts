/**
 * Zaplecze → zakładka „Konektory" (S27 Z5) — INFORMACYJNIE, zero akcji zarządzających (D5).
 *
 * Dwie sekcje:
 *  1. „Twoje konektory" — zewnętrzne serwery MCP usera: nazwa, transport, status
 *     (podłączony / wyłączony / błąd + lastError), liczba narzędzi + rozwijana lista narzędzi.
 *     Serwer rozłączony dostaje uczciwy komunikat zamiast pustej listy.
 *  2. „Wbudowane narzędzia pluginu" — REALNA lista z `ToolRegistry` (nie z `TOOL_INFO`, gdzie
 *     świadomie leżą martwe wpisy do renderowania historii starych czatów), pogrupowana
 *     po serwerze wbudowanym, z opisami.
 *
 * Podłączanie serwera = Ustawienia. Włączanie per agent = profil → Umiejętności → Konektory.
 * Ta zakładka tylko OPISUJE — dlatego nie ma tu ani jednego guzika zmieniającego stan.
 */
import { UiIcons, setSvgLabel } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import type { ExternalServerUiRow } from './ExternalMcpManager.js';
import type { ToolDefinition } from './ToolRegistry.js';

/** Narzedzie tak, jak pokazuje je ta zakladka (nazwa + opis). */
interface ToolRow {
    name: string;
    description: string;
}

/**
 * Plugin widziany przez zakladke: rejestr narzedzi wbudowanych + manager konektorow.
 * Wszystko opcjonalne, bo kod czyta to defensywnie (`?.`) — zakladka ma sie narysowac
 * takze wtedy, gdy ktorys manager jeszcze nie wstal.
 */
export interface ConnectorsPluginLike {
    externalMcpManager?: {
        listServersForUi?: () => ExternalServerUiRow[];
        getServerTools?: (serverId: string) => ToolRow[];
    } | null;
    toolRegistry?: {
        getAllTools?: () => ToolDefinition[];
        getBuiltinServerForTool?: (name: string) => string | null;
    } | null;
}

export function renderConnectorsTab(content: HTMLElement, plugin: ConnectorsPluginLike): void {
    content.createEl('p', { text: t('backstage.connectors_intro'), cls: 'cs-backstage-intro' });
    content.createEl('p', { text: t('backstage.connectors_where'), cls: 'cs-backstage-intro' });

    renderExternalSection(content, plugin);
    renderBuiltinSection(content, plugin);
}

// ─────────────────────────────────────────────────────────────
// 1. Twoje konektory (zewnętrzne serwery MCP)
// ─────────────────────────────────────────────────────────────

function renderExternalSection(content: HTMLElement, plugin: ConnectorsPluginLike): void {
    const head = content.createDiv({ cls: 'cs-section-title cs-section-title--flush-gap' });
    setSvgLabel(head, UiIcons.externalLink(12), t('backstage.connectors_yours'));

    const servers = safeListServers(plugin);
    if (servers.length === 0) {
        content.createEl('p', { text: t('backstage.connectors_none'), cls: 'sidebar-empty-text' });
        return;
    }

    const list = content.createDiv({ cls: 'cs-item-list' });
    for (const server of servers) {
        const card = list.createDiv({ cls: 'cs-item-card cs-item-card--builtin' });

        const nameDiv = card.createDiv({ cls: 'cs-item-card__name' });
        setSvgLabel(nameDiv, UiIcons.wrench(13), server.name);

        const meta = card.createDiv({ cls: 'cs-item-card__meta' });
        meta.createSpan({
            cls: 'cs-item-card__badge',
            text: server.transport === 'http'
                ? t('backstage.connector_transport_http')
                : t('backstage.connector_transport_stdio'),
        });
        const statusKind = server.connected ? 'connected' : (server.status === 'error' ? 'error' : 'off');
        meta.createSpan({
            cls: `cs-item-card__badge cs-connector-status--${statusKind}`,
            text: t(`backstage.connector_status_${statusKind}`),
        });
        meta.createSpan({
            cls: 'cs-item-card__badge cs-item-card__badge--version',
            text: t('backstage.connector_tool_count', { n: server.toolCount || 0 }),
        });

        if (server.lastError) {
            card.createDiv({ cls: 'cs-item-card__desc', text: server.lastError });
        }

        renderServerTools(card, plugin, server);
    }
}

function renderServerTools(card: HTMLElement, plugin: ConnectorsPluginLike, server: ExternalServerUiRow): void {
    if (!server.connected) {
        card.createDiv({ cls: 'cs-item-card__desc', text: t('backstage.connector_offline_hint') });
        return;
    }

    let tools: ToolRow[] = [];
    try {
        tools = plugin?.externalMcpManager?.getServerTools?.(server.id) || [];
    } catch { tools = []; }

    if (tools.length === 0) {
        card.createDiv({ cls: 'cs-item-card__desc', text: t('backstage.connector_no_tools') });
        return;
    }

    const toggle = card.createEl('button', { cls: 'cs-template-use__btn' });
    setSvgLabel(toggle, UiIcons.chevronDown(10), t('backstage.connector_show_tools', { n: tools.length }));

    const box = card.createDiv({ cls: 'cs-connector-tools cs-collapsed' });
    for (const tool of tools) {
        const row = box.createDiv({ cls: 'cs-connector-tool' });
        row.createSpan({ cls: 'cs-connector-tool__name', text: tool.name });
        if (tool.description) row.createSpan({ text: ` — ${tool.description}` });
    }

    toggle.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        box.classList.toggle('cs-collapsed');
    });
}

// ─────────────────────────────────────────────────────────────
// 2. Wbudowane narzędzia pluginu (realny ToolRegistry)
// ─────────────────────────────────────────────────────────────

function renderBuiltinSection(content: HTMLElement, plugin: ConnectorsPluginLike): void {
    const head = content.createDiv({ cls: 'cs-section-title cs-section-title--flush-gap' });
    setSvgLabel(head, UiIcons.wrench(12), t('backstage.connectors_builtin'));

    const groups = groupBuiltinTools(plugin);
    if (groups.size === 0) {
        content.createEl('p', { text: t('backstage.connectors_builtin_none'), cls: 'sidebar-empty-text' });
        return;
    }

    for (const [server, tools] of groups) {
        const groupHead = content.createDiv({ cls: 'cs-section-head cs-section-head--sub' });
        groupHead.createSpan({ text: `${server} (${tools.length})` });

        const box = content.createDiv({ cls: 'cs-connector-tools' });
        for (const tool of tools) {
            const row = box.createDiv({ cls: 'cs-connector-tool' });
            row.createSpan({ cls: 'cs-connector-tool__name', text: tool.name });
            if (tool.description) {
                row.createSpan({ text: ` — ${firstSentence(tool.description)}` });
            }
        }
    }
}

/**
 * Pogrupuj REALNIE zarejestrowane narzędzia built-in po serwerze wbudowanym.
 * Narzędzia zewnętrznych serwerów (`source: 'user'`) idą do sekcji konektorów, nie tutaj.
 *
 * AUD-dead-code-021/166: `export` zdjęty — zero konsumentów poza tym plikiem, wołana
 * wyłącznie przez `renderConnectorsTab` niżej, u siebie.
 */
function groupBuiltinTools(plugin: ConnectorsPluginLike): Map<string, ToolRow[]> {
    const registry = plugin?.toolRegistry;
    const groups = new Map<string, ToolRow[]>();
    if (!registry?.getAllTools) return groups;

    for (const tool of registry.getAllTools()) {
        if (tool.source === 'user') continue;
        const server = registry.getBuiltinServerForTool?.(tool.name) || tool.serverName || 'other';
        if (!groups.has(server)) groups.set(server, []);
        groups.get(server)!.push({ name: tool.name, description: tool.description || '' });
    }
    for (const tools of groups.values()) {
        tools.sort((a, b) => a.name.localeCompare(b.name));
    }
    return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function safeListServers(plugin: ConnectorsPluginLike): ExternalServerUiRow[] {
    try {
        return plugin?.externalMcpManager?.listServersForUi?.() || [];
    } catch {
        return [];
    }
}

/** Opisy narzędzi idą do modelu i bywają wielolinijkowe — w UI pokazujemy pierwsze zdanie. */
function firstSentence(text: string): string {
    const line = String(text).split('\n')[0].trim();
    return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
