/**
 * semanticNote — uczciwa nota degradacji dla narzędzi semantic (E1.4).
 *
 * Gdy vault_semantic / memory_semantic spada z warstwy embeddingów (L3) do
 * keyword (L2), dokładamy do wyniku dla modelu jawne zdanie DLACZEGO — na
 * podstawie `plugin.vaultIndexer.getStatus()`. Bez tego model dostaje ciche
 * wyniki L2 udające semantykę i nie wie, że indeks jest martwy/w budowie.
 */

import { t } from '../../core/i18n/index.js';

/** Zakres wyszukiwania, dla którego budujemy notę. */
export type SemanticScope = 'vault' | 'memory';

/** Status indeksera w zakresie, jaki czyta ten plik (pełny typ żyje w `modules/embedding`). */
export interface VaultIndexerStatus {
    status?: string;
    progress?: { indexed?: number; total?: number };
    lastError?: string;
}

/** Minimalny widok pluginu: tylko `vaultIndexer.getStatus()`. */
export interface SemanticNotePlugin {
    vaultIndexer?: { getStatus?: () => VaultIndexerStatus | null | undefined } | null;
}

/** Wejście `buildSemanticNote`. */
interface SemanticNoteParams {
    /** dostęp do plugin.vaultIndexer */
    plugin?: SemanticNotePlugin | null;
    scope?: SemanticScope;
}

/**
 * @returns nota (zawsze niepusta — powód degradacji)
 */
export function buildSemanticNote({ plugin, scope }: SemanticNoteParams = {}): string {
    // Pamięć agentów NIE jest indeksowana semantycznie (izolacja). L3 dla memory
    // jest z założenia niedostępny — powiedz to wprost.
    if (scope === 'memory') return t('mcp.semantic.unavailable_memory');

    const status = plugin?.vaultIndexer?.getStatus?.();
    if (!status) return t('mcp.semantic.unavailable_no_provider');

    switch (status.status) {
        case 'disabled_mobile':
            return t('mcp.semantic.unavailable_mobile');
        case 'building':
            return t('mcp.semantic.unavailable_building', {
                indexed: status.progress?.indexed ?? 0,
                total: status.progress?.total ?? 0,
            });
        case 'error':
            return t('mcp.semantic.unavailable_error', { error: status.lastError || '?' });
        case 'no_provider':
        default:
            return t('mcp.semantic.unavailable_no_provider');
    }
}
