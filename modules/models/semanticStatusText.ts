/**
 * Renderer statusu indeksu semantycznego (W13, follow-up po review W5) — wyciągnięty do
 * czystej funkcji, żeby dało się go testować bez `obsidian` (AVA, node-owy proces).
 *
 * PRZED tą naprawą `case 'ready'` w `SettingsContent.ts` czytał `progress.total` —
 * czyli liczbę plików PRZESKANOWANYCH przez ostatni skan, nie liczbę wektorów faktycznie
 * leżących w indeksie. Po W5 (`VaultIndexer.getStatus()` ma `lastError` i indekser potrafi
 * opublikować odzyskany indeks mimo pada resyncu, patrz `modules/embedding/CLAUDE.md` gotcha 8)
 * to rozjechało się z rzeczywistością: pusty indeks (0 wektorów) po padniętym pierwszym skanie
 * dalej pokazywał „Aktywne — zaindeksowano 4420 plików", bo `total` liczy WEJŚCIE skanu, nie
 * jego WYNIK.
 *
 * Prawda o zawartości indeksu to `countDocs(plugin.oramaDb)` (`modules/embedding`) — realna
 * liczba dokumentów w silniku Orama. Ta funkcja dostaje ją już policzoną (wołacz w
 * `SettingsContent.ts` robi `await import('../embedding/index.js')`, tak jak dla
 * `migrateSCToOrama` w tym samym pliku — moduł `models` nie ma statycznej zależności od
 * `embedding`).
 */

/** Dane wejściowe — już wyciągnięte z `IndexerStatusSnapshot` + policzone `countDocs`. */
export interface SemanticStatusData {
    status?: string;
    /** `progress.total` — liczba plików PRZESKANOWANYCH przez ostatni skan (NIE liczba wektorów). */
    total?: number;
    /** `progress.indexed` — postęp trwającego skanu (`status === 'building'`). */
    indexed?: number;
    /** `countDocs(plugin.oramaDb)` — realna liczba dokumentów w indeksie. */
    docs?: number;
    lastError?: string | null;
    /** `vaultIndexer.skipped.size` — pliki pominięte po wyczerpaniu prób (patrz embedding gotcha 12). */
    skipped?: number;
}

export type SemanticStatusVariant =
    | 'idle'
    | 'building'
    | 'no_provider'
    | 'disabled_mobile'
    | 'error'
    | 'ready'
    | 'ready_empty';

export interface SemanticStatusResult {
    variant: SemanticStatusVariant;
    text: string;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * Czysta funkcja: dane statusu → wariant + tekst gotowy do `.setDesc()`.
 * Zero zależności od `obsidian` — `t` przychodzi wstrzyknięty (w produkcji `core/i18n`,
 * w testach dowolny stub).
 */
export function computeSemanticStatusText(data: SemanticStatusData | null | undefined, t: Translate): SemanticStatusResult {
    if (!data || !data.status) {
        return { variant: 'idle', text: t('settings.semantic_status_idle') };
    }

    const total = data.total ?? 0;
    const indexed = data.indexed ?? 0;
    const docs = data.docs ?? 0;
    const lastError = data.lastError || null;
    const skipped = data.skipped ?? 0;

    switch (data.status) {
        case 'ready': {
            // Skan przeszedł N plików, ale indeks jest pusty (pad pierwszego skanu przed
            // publikacją, albo `_publish()` z zerowym `db`) — powiedz to wprost, nie „Aktywne".
            const isEmpty = docs === 0 && total > 0;
            let text = isEmpty
                ? t('settings.semantic_status_ready_empty')
                : t('settings.semantic_status_ready', { count: docs });
            if (lastError) {
                text += ' ' + t('settings.semantic_status_last_error', { error: lastError });
            }
            if (skipped > 0) {
                text += ' ' + t('settings.semantic_status_skipped', { count: skipped });
            }
            return { variant: isEmpty ? 'ready_empty' : 'ready', text };
        }
        case 'building':
            return { variant: 'building', text: t('settings.semantic_status_building', { indexed, total }) };
        case 'no_provider':
            return { variant: 'no_provider', text: t('settings.semantic_status_no_provider') };
        case 'disabled_mobile':
            return { variant: 'disabled_mobile', text: t('settings.semantic_status_mobile') };
        case 'error':
            return { variant: 'error', text: t('settings.semantic_status_error', { error: lastError || '?' }) };
        default:
            return { variant: 'idle', text: t('settings.semantic_status_idle') };
    }
}
