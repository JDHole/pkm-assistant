/**
 * Rejestracja zakładki „Konektory" w Zapleczu.
 *
 * Ta zakładka jest INFORMACYJNA: opisuje podłączone serwery MCP i ich narzędzia oraz realną
 * listę narzędzi wbudowanych. Zero akcji zarządzających — podłączanie żyje w Ustawieniach,
 * włączanie per agent w profilu → Umiejętności → Konektory.
 *
 * Render leży w `ConnectorsBackstageTab.js` i jest lazy-loadowany (barrel modułu zostaje
 * bez zbędnych zależności UI w ścieżce importu).
 */
import { UiIcons } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import type { ConnectorsPluginLike } from './ConnectorsBackstageTab.js';

/** Zakladka Zaplecza tak, jak przyjmuje ja rejestr z `modules/shell/sidebar/BackstageViews`. */
export interface BackstageTabDef {
    id: string;
    label: string;
    iconFn: (size?: number) => string;
    order?: number;
    render: (content: HTMLElement, plugin: ConnectorsPluginLike) => unknown;
}

/** Rejestr Zaplecza — ten modul zna z niego wylacznie `register`. */
export interface BackstageRegistryLike {
    register: (tab: BackstageTabDef) => void;
}

export function registerBackstage(registry: BackstageRegistryLike): void {
    registry.register({
        id: 'connectors',
        label: t('backstage.connectors'),
        iconFn: (size?: number) => UiIcons.externalLink(size),
        order: 30,
        render: async (content: HTMLElement, plugin: ConnectorsPluginLike) => {
            const { renderConnectorsTab } = await import('./ConnectorsBackstageTab.js');
            return renderConnectorsTab(content, plugin);
        },
    });
}
