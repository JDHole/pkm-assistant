/**
 * B6 druga runda (2026-09-02) — synchronizacja pola „Model główny" (legacy `model`) z
 * per-rolowym `models.main`.
 *
 * ŻYWY BUG (nie szkoda historyczna): `AgentProfileView.ts` budował `formData` z blokiem
 * „Sync model ↔ models.main", który — gdy `models.main` był ustawiony — KOPIOWAŁ jego wartość
 * do `formData.model` (legacy top-level pole). `profile_advanced.ts`'s onChange selecta robił
 * to samo w drugą stronę (pisał OBA pola naraz). Skutek: `profile_advanced.handleSave` zawsze
 * wysyła `updates.model = formData.model || null` — więc KAŻDY zapis profilu (dowolna zakładka,
 * niekoniecznie „Zaawansowane") dla agenta z ustawionym `models.main` DOPISYWAŁ do yamla
 * `model:` = kopię `models.main`. U Kuby wszyscy agenci mają ten sam `models.main` (lokalny
 * model przez LM Studio) → „ta sama twarda wartość u wszystkich agentów, 7/13 yamli" — dokładnie
 * objaw zgłoszony przez Ezrę.
 *
 * KANON od tej naprawy: `models.main`. Legacy `model` NIGDY nie jest kopiowany Z `models.main`
 * z powrotem — tylko odwrotnie, i tylko RAZ (jednorazowa migracja starych configów, które mają
 * TYLKO legacy `model` bez `models.main`). Gdy `models.main` istnieje (świeży ALBO właśnie
 * zmigrowany), `model` w wyniku jest ZAWSZE `null` — bez wyjątku dla agentów, którzy mieli
 * OBA pola ustawione naraz (resztki starego buga); inaczej takie yamle nigdy by się nie
 * doczyściły (patrz uzasadnienie przy `resolveMainModelForForm`, review Opusa p.3).
 *
 * Plik jest CZYSTY (bez `obsidian`, bez DOM) — testowalny w AVA (wzór `startPromptGenerator.ts`).
 */

/** Wartość nadpisania modelu: string „platforma/model" albo obiekt {platform, model}. */
export type ModelOverrideValue = string | { platform?: string; model?: string } | undefined;

export interface ModelFieldSyncInput {
    /** Legacy top-level pole agenta (`agent.model` / `formData.model`). */
    model?: string | null;
    /**
     * Per-rolowe nadpisania (`agent.models` / `formData.models`). Typ `unknown` w wartościach,
     * bo żywy `Agent.models` jest zadeklarowany jako `Record<string, unknown>` (YAML usera jest
     * permisywny) — normalizacja niżej sama sprawdza kształt w runtime.
     */
    models?: Record<string, unknown>;
}

export interface ModelFieldSyncResult {
    /** Wartość do pokazania w <select> „Model główny" — zawsze zwierciadło `models.main`. */
    selectValue: string;
    /** Nowa wartość legacy `model` — ZAWSZE `null` (gaśnie bezwarunkowo, nigdy kopia `models.main`). */
    model: string | null;
    /**
     * `models` po ew. jednorazowej migracji (main dopisany z legacy `model`, jeśli main był
     * pusty). Typ `unknown`-w-wartościach — patrz `ModelFieldSyncInput.models`.
     */
    models: Record<string, unknown>;
}

/** {platform, model} → "platforma/model"; string zostaje bez zmian; puste/niepełne/obce → ''. */
function normalizeOverrideToString(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    const override = value as ModelOverrideValue;
    if (typeof override === 'object' && override?.platform && override?.model) {
        return `${override.platform}/${override.model}`;
    }
    return '';
}

/**
 * Rozstrzyga stan pól „model" dla formularza profilu przy KAŻDYM (re)renderze.
 *
 * JEDNA reguła, bez wyjątków: **`model` w wyniku jest ZAWSZE `null`.** Gdy `models.main` już
 * istnieje, jest KANONEM — select go pokazuje, legacy `model` gaśnie (niezależnie od tego, co
 * niósł na wejściu; jeśli agent miał ustawione OBA pola naraz — stan po starym buggy sync —
 * to właśnie ten przebieg go sprząta, nie konserwuje starej wartości). Gdy jest TYLKO legacy
 * `model` (bez `models.main`), to jednorazowa migracja: `models.main` przejmuje wartość,
 * `model` gaśnie — efekt trafia na dysk przy najbliższym „Zapisz profil". Żadne z dwóch
 * nieustawione → puste pole, nic do migrowania.
 *
 * (Review Opusa, blocker p.3: wcześniejsza wersja w gałęzi „oba pola ustawione" ZWRACAŁA
 * `model: legacyModel` niezmieniony — więc agent z resztkami starego buga (oba pola z tą samą
 * wartością, po B6-2 rundzie 2) nigdy by się nie doczyścił: KAŻDY kolejny zapis profilu wciąż
 * pisałby `model:` do yamla, mimo że models.main jest kanonem od dawna. Po naprawie Step 4b
 * w `modules/models/modelResolver.ts` (p.1) rozstrzyganie modelu dla ról sub NIE zależy już
 * wyłącznie od `agent.model` — bezpiecznie zerować legacy pole bezwarunkowo.)
 */
export function resolveMainModelForForm(config: ModelFieldSyncInput): ModelFieldSyncResult {
    const models: Record<string, unknown> = { ...(config.models || {}) };
    const legacyModel = config.model || null;

    if (models.main) {
        const selectValue = normalizeOverrideToString(models.main);
        if (selectValue) models.main = selectValue; else delete models.main;
        return { selectValue, model: null, models };
    }

    if (legacyModel) {
        models.main = legacyModel;
        return { selectValue: legacyModel, model: null, models };
    }

    return { selectValue: '', model: null, models };
}

/**
 * Zastosuj zmianę selecta „Model główny" na `formData`-kształtnym obiekcie. Pisze TYLKO
 * `models.main` — legacy `model` ustawia na `null` i się nie odradza (wzór funkcji wyżej).
 * Czyszczenie pola (`v` puste) USUWA klucz `main` (nie zostawia `main: undefined` — inaczej
 * `Object.keys(this.models).length > 0` w `Agent.serialize()` zostawiłby puste `models: {}`).
 */
export function applyMainModelChange(models: Record<string, unknown> | undefined, v: string): { model: null; models: Record<string, unknown> } {
    const next: Record<string, unknown> = { ...(models || {}) };
    if (v) next.main = v; else delete next.main;
    return { model: null, models: next };
}
