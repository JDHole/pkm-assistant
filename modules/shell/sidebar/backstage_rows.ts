/**
 * Wiersze sekcji „Zaplecze" na ekranie domowym sidebara (S27 Z7).
 *
 * CZYSTA STRUKTURA DANYCH — bez DOM, bez obsidiana. Powód (D7): 2026-07-28 na Home wisiał
 * martwy wiersz „Narzędzia MCP" celujący w tab `tools`, którego nie było — Zaplecze po cichu
 * spadało na Skille i nikt tego nie łapał. Odkąd definicja wierszy jest danymi, test
 * sprawdza mapowanie wiersz→tab przeciw realnemu `BackstageRegistry` i taka wtopa
 * nie przejdzie bez czerwonego testu.
 *
 * Kontrakt wiersza:
 *   { id, labelKey, icon, count, tab }     → nawigacja do `zaplecze` z tą zakładką
 *   { id, labelKey, icon, count, viewId }  → nawigacja do osobnego widoku sidebara
 * `count: null` = wiersz bez licznika.
 */

/** Id widoków sidebara, na które wolno celować wierszom (rejestrowane w AgentSidebar). */
export const SIDEBAR_VIEW_IDS: readonly (string | undefined)[] = ['home', 'agent-profile', 'communicator', 'zaplecze', 'skill-detail', 'sub-agent-detail', 'triggers'];

// TS-any: plugin managers are dynamic runtime integrations during the migration.
type Runtime = any;
type ZapleczeCounts = {
    skillTemplates?: number;
    subTemplates?: number;
    connectedServers?: number;
};
/** `count: null` = wiersz bez licznika. */
type ZapleczeRow = { id: string; labelKey: string; icon: string; count: number | null; countTitleKey?: string; tab: string; viewId?: never }
    | { id: string; labelKey: string; icon: string; count: number | null; countTitleKey?: string; viewId: string; tab?: never };

/**
 * @param {Object} counts
 * @param {number} counts.skillTemplates - liczba szablonów skilli
 * @param {number} counts.subTemplates - liczba szablonów subów
 * @param {number} counts.connectedServers - liczba PODŁĄCZONYCH serwerów MCP
 * @returns {Array<Object>}
 */
export function buildZapleczeRows({
    skillTemplates = 0,
    subTemplates = 0,
    connectedServers = 0,
}: ZapleczeCounts = {}): ZapleczeRow[] {
    return [
        { id: 'skill-templates', labelKey: 'backstage.skills', icon: 'zap', count: skillTemplates, tab: 'skills' },
        { id: 'sub-templates', labelKey: 'backstage.sub_agents', icon: 'robot', count: subTemplates, tab: 'sub-agents' },
        {
            id: 'connectors', labelKey: 'backstage.connectors', icon: 'externalLink',
            count: connectedServers, countTitleKey: 'backstage.connectors_count_title', tab: 'connectors',
        },
        // Sprint 05.5 H2: Triggery to osobny widok sidebara, nie zakładka Zaplecza.
        { id: 'triggers', labelKey: 'sidebar.triggers', icon: 'sparkle', count: null, viewId: 'triggers' },
        // Wiersza „Biegi subów" tu NIE MA (2026-08-15): biegi żyją per agent i per sesja,
        // więc pokazuje je pasek w oknie czatu, nie globalny sidebar.
    ];
}

/**
 * Odczytaj liczniki z pluginu (jedyne miejsce, gdzie wiersze dotykają runtime'u).
 * @param {Object} plugin
 * @returns {{skillTemplates: number, subTemplates: number, connectedServers: number}}
 */
export function readZapleczeCounts(plugin: Runtime): Required<ZapleczeCounts> {
    const am = plugin?.agentManager;
    let connectedServers = 0;
    try {
        connectedServers = (plugin?.externalMcpManager?.listServersForUi?.() || []).filter((s: Runtime) => s.connected).length;
    } catch { connectedServers = 0; }
    return {
        skillTemplates: am?.skillTemplateStore?.count?.() || 0,
        // pkm-sub (wbudowany) zawsze jest na liście zakładki — stąd +1.
        subTemplates: (am?.subAgentTemplateStore?.count?.() || 0) + 1,
        connectedServers,
    };
}
