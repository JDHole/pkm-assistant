/**
 * autonomy.js — Rdzeń modelu autonomii (D21 / F12, refaktor v2.2 E2.3).
 *
 * NOWY MODEL KONTROLI (D21) — dwie NIEZALEŻNE osie:
 *   1. UPRAWNIENIA = własność AGENTA (co agentowi WOLNO). Bez zmian — żyją w
 *      `agent.permissions` i egzekwuje je PermissionSystem/AccessGuard.
 *   2. AUTONOMIA = własność CZATU (czy PYTAĆ, zanim zrobi to, co mu wolno). TU.
 *
 *   Autonomia NIE nadaje uprawnień. Znosi (albo dokłada) PYTANIA — nic więcej.
 *   Agent bez `edit_notes` nie zapisze pliku nawet w trybie `yolo`; agent z
 *   whitelistą (focusFolders) w `yolo` dalej nie wyjdzie poza whitelistę.
 *
 * TRZY TRYBY (F12):
 *   - 'yolo' — nie pytaj o nic. Znosi WSZYSTKIE pytania (approval + diff).
 *              No-Go i pliki chronione dalej blokują ABSOLUTNIE (to nie „pytania”,
 *              to twarde granice uprawnień — patrz PermissionSystem.checkPermission).
 *   - 'edge' — pytaj-na-krawędzi (DEFAULT). Pyta tylko o akcje „na krawędzi”.
 *              Netto ≈ dzisiejsze domyślne zachowanie (najmniejsze zaskoczenie).
 *   - 'all'  — pytaj-o-wszystko. Pyta o KAŻDE narzędzie (poza ask_user — pytanie
 *              o zgodę na zadanie pytania to absurd).
 *
 * DEFINICJA KRAWĘDZI (F12): zapis / kasowanie / web / wysyłka / delegacja / mcp /
 *   komendy / budowanie agentów.
 *   Implementacja FAIL-CLOSED: BEZPIECZNE są TYLKO odczyt (`read_notes`) i myślenie
 *   (`thinking`). KAŻDA inna kategoria uprawnienia — również przyszła, jeszcze
 *   nieznana — JEST krawędzią. Dzięki temu nowe uprawnienie dodane bez dotknięcia
 *   tego pliku domyślnie WYMAGA pytania (bezpieczniej niż domyślnie ciche).
 *
 * Ten moduł jest LIŚCIEM (nie importuje z PermissionSystem) — PermissionSystem
 * importuje z niego. SAFE_PERMISSION_TYPES trzyma literały wartości
 * PERMISSION_TYPES.READ_NOTES / THINKING, żeby uniknąć cyklu importów (odczyt
 * PERMISSION_TYPES podczas inicjalizacji cyklicznej trafiłby na temporal dead zone).
 * Fail-closed dodatkowo chroni: gdyby literał rozjechał się z PERMISSION_TYPES,
 * najwyżej coś stanie się krawędzią (pytamy więcej), nigdy odwrotnie.
 */

/** Tryb autonomii czatu. */
export type AutonomyMode = 'yolo' | 'edge' | 'all';

/** Poziom ryzyka narzędzia (światła A3). */
export type ToolRiskLevel = 'green' | 'yellow' | 'red';

/** Wszystkie prawidłowe tryby autonomii. */
export const AUTONOMY_MODES: AutonomyMode[] = ['yolo', 'edge', 'all'];

/** Domyślny tryb (pytaj-na-krawędzi). */
export const DEFAULT_AUTONOMY: AutonomyMode = 'edge';

/**
 * Trzy poziomy ryzyka narzędzia (A3, 2026-07-24).
 *
 * GREEN  — czysty odczyt / myślenie / pytanie usera.
 * YELLOW — akcja odwracalna albo ograniczona; user może wyłączyć pytanie per narzędzie.
 * RED    — kasowanie, modyfikacja istniejących danych, wysyłka danych lub cudzy kod.
 *          W trybie edge pytanie jest obowiązkowe i toggle go nie wyłącza.
 */
export const TOOL_RISK_LEVELS = Object.freeze({
    GREEN: 'green',
    YELLOW: 'yellow',
    RED: 'red',
} as const);

/**
 * Kategorie uprawnień, które NIE są krawędzią (bezpieczne — sam odczyt i myślenie).
 * Wartości = PERMISSION_TYPES.READ_NOTES / THINKING (literały, patrz nagłówek).
 */
export const SAFE_PERMISSION_TYPES: Set<string> = new Set([
    'read_notes', // PERMISSION_TYPES.READ_NOTES
    'thinking',   // PERMISSION_TYPES.THINKING
]);

/**
 * Czy dany typ uprawnienia jest „krawędzią” (wymaga pytania w trybie edge).
 * FAIL-CLOSED: undefined / null / nieznany typ → true (traktuj jak krawędź).
 * @param permissionType - wartość z ACTION_PERMISSIONS
 * @returns true = krawędź, false = bezpieczne (read/think)
 */
export function isEdgePermissionType(permissionType: string | null | undefined): boolean {
    if (!permissionType) return true; // brak mapowania → fail-closed
    return !SAFE_PERMISSION_TYPES.has(permissionType);
}

/** Kontekst pojedynczego wywołania narzędzia, na podstawie którego liczymy światło. */
export interface ToolRiskContext {
    action?: string | null;
    permissionType?: string | null;
    toolName?: string | null;
    operationMode?: string | null;
    isExternalTool?: boolean;
}

/**
 * Sklasyfikuj konkretne wywołanie narzędzia.
 *
 * Jawne wyjątki narzędziowe wygrywają z szeroką kategorią uprawnienia. Przykład:
 * artifact_update ma kategorię edit_notes, ale zapisuje przez kontrolowany silnik
 * artefaktów, więc jest YELLOW; zwykły write na istniejącym pliku jest RED.
 *
 * FAIL-CLOSED: brak danych / nowe nieznane narzędzie → RED.
 *
 * @param ctx
 */
export function classifyToolRisk({
    action = null,
    permissionType = null,
    toolName = null,
    operationMode = null,
    isExternalTool = false,
}: ToolRiskContext = {}): ToolRiskLevel {
    const tool = String(toolName || '');

    if (tool === 'ask_user') return TOOL_RISK_LEVELS.GREEN;

    // Cudzy serwer / kod: nawet deklaracja "read" nie jest przez nas weryfikowalna.
    if (isExternalTool) return TOOL_RISK_LEVELS.RED;

    const greenTools = new Set([
        'read', 'list', 'search',
        'artifact_read', 'artifact_list',
        'vault_read', 'vault_list', 'vault_search',
        // S28: czytanie WŁASNEJ skrzynki. `kom_read` odhacza `ai_read` w swoim pliku, ale to
        // techniczny ptaszek statusu, nie zmiana danych usera — dla usera to czysty odczyt.
        'kom_list', 'kom_read',
    ]);
    if (greenTools.has(tool)) return TOOL_RISK_LEVELS.GREEN;

    // Todo jest kontrolowanym notesem roboczym. Sam odczyt jest GREEN,
    // modyfikacje są YELLOW (domyślnie ciche przez osobny toggle).
    if (tool === 'todo') {
        return ['get', 'list', 'read'].includes(String(operationMode || '').toLowerCase())
            ? TOOL_RISK_LEVELS.GREEN
            : TOOL_RISK_LEVELS.YELLOW;
    }

    // Create-only zwykłego pliku jest odwracalne. Każda modyfikacja istniejącego
    // pliku (replace/patch/append/prepend; także brak jawnego mode) jest RED.
    if (tool === 'write' || tool === 'vault_write') {
        return operationMode === 'create'
            ? TOOL_RISK_LEVELS.YELLOW
            : TOOL_RISK_LEVELS.RED;
    }

    // S28 (D3): `kom_send` tworzy JEDEN nowy plik w skrzynce wewnątrz vaulta (create-only,
    // nic nie nadpisuje, nic nie wychodzi na zewnątrz) → YELLOW z przełącznikiem. Jawny
    // wyjątek narzędziowy musi wyprzedzić szeroką regułę `action === 'agent.message'` niżej —
    // ten sam wzór co artifact_update vs write.
    //
    // K17 (AUD-security-109): `agent_delegate` dołącza do wyjątku, bo od tej naprawy jedzie
    // pod akcją `agent.message` (wysyła list TYM SAMYM kodem co `kom_send`). Bez wpisu tutaj
    // szeroka reguła niżej dałaby mu RED, czyli pytanie MOCNIEJSZE niż przy zwykłej poczcie —
    // a to ta sama czynność o tym samym skutku i ma podlegać temu samemu przełącznikowi.
    if (tool === 'kom_send' || tool === 'agent_delegate') return TOOL_RISK_LEVELS.YELLOW;

    const redTools = new Set([
        'delete', 'vault_delete', 'memory_delete',
        // `agent_message`/`connect_to_server` już nie istnieją — wpisy zostają fail-closed
        // na wypadek wywołania po starej nazwie (wzór E3.1 faza C).
        'agent_message', 'connect_to_server',
    ]);
    if (redTools.has(tool)) return TOOL_RISK_LEVELS.RED;

    // Nierozpoznane narzędzie deklarujące wysyłkę do innego agenta = czerwone.
    if (action === 'agent.message') return TOOL_RISK_LEVELS.RED;

    const yellowTools = new Set([
        'create_folder', 'vault_create_folder',
        'memory_save',
        'artifact_create', 'artifact_update',
        'web_search', 'web_read',
        // K17: `agent_delegate` NIE stoi już w tym zbiorze — ma jawny wyjątek wyżej, tak jak
        // `kom_send`. Jedna nazwa w dwóch miejscach kończy się pytaniem „która wygrywa".
        'delegate',
        'generate_image', 'add_text_to_image',
    ]);
    if (yellowTools.has(tool)) return TOOL_RISK_LEVELS.YELLOW;

    if (SAFE_PERMISSION_TYPES.has(permissionType as string)) return TOOL_RISK_LEVELS.GREEN;

    return TOOL_RISK_LEVELS.RED;
}

/**
 * Znormalizuj wartość trybu autonomii. Nieznane / brak → DEFAULT_AUTONOMY.
 * @param value - cokolwiek (ustawienia usera / pole czatu) — stąd `unknown`
 */
export function normalizeAutonomy(value: unknown): AutonomyMode {
    return AUTONOMY_MODES.includes(value as AutonomyMode) ? value as AutonomyMode : DEFAULT_AUTONOMY;
}
