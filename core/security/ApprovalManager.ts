/**
 * ApprovalManager
 * Manages action approvals and "always approve" rules
 */
import { log } from '../utils/Logger.js';

/**
 * K2 (AUD-security-021): jawny token „to wywołanie nie miało celu". Nie jest wieloznacznikiem —
 * pasuje wyłącznie do innego wywołania bez celu tej samej akcji. Nawiasy trójkątne gwarantują,
 * że żadna prawdziwa ścieżka vaultowa go nie udaje (`sanitizePath` ich nie produkuje).
 */
const NO_TARGET_TOKEN = '<bez-celu>';

/**
 * K22 (AUD-security-104): jawny token „cel był DOSŁOWNĄ gwiazdką". Też nie jest
 * wieloznacznikiem — pasuje wyłącznie do innego wywołania z tym samym dosłownym celem.
 */
const STAR_TOKEN = '<gwiazdka>';

/**
 * AUD-code-review-058: jawny token „reguła bez aktywnego agenta" (klucz Mapy `null`) w
 * serializacji `alwaysApproved`. JS koerciuje klucz obiektu `null` do stringa `"null"` przy
 * indeksowaniu (`obj[null] === obj['null']`), a `Object.entries()` przy WCZYTYWANIU oddaje
 * klucz z definicji jako STRING — Map<string|null,...> dostawała więc po restarcie klucz
 * string `"null"`, a `isAlwaysApproved(null,...)` (wołane z prawdziwym `null`) robi
 * `Map.get(null)` i nie trafiał: reguła zapisana bez aktywnego agenta znikała po restarcie
 * Obsidiana. Ten sam wzorzec co `NO_TARGET_TOKEN`/`STAR_TOKEN` wyżej — jawny token zamiast
 * polegania na koercji property-key.
 */
const NO_AGENT_TOKEN = '<brak-agenta>';

/**
 * K22 (AUD-security-104): cel od wołacza to DOSŁOWNY TEKST — nigdy sterowanie.
 *
 * Dwa ciągi mają w kluczu reguły znaczenie sterujące: `*` (czyta go `isAlwaysApproved` jako
 * „dowolny cel") i `<bez-celu>` (K2). Argumenty narzędzi pisze MODEL, więc oba dałoby się
 * podstawić z zewnątrz — `delete {path:"*"}` produkowało klucz `vault.delete::*`, czyli trwałą
 * zgodę na każde przyszłe kasowanie. Dlatego zanim cel wejdzie do klucza:
 *
 * 1. podwajamy `<` — nasze tokeny mają dokładnie jeden `<` na początku, więc cel od wołacza
 *    nie ma jak ich udawać (`'<bez-celu>'` → `'<<bez-celu>'`),
 * 2. każdą gwiazdkę zamieniamy na token — `akcja::*` nie powstaje z argumentu.
 *
 * Kolejność jest istotna: gdyby najpierw szła gwiazdka, krok 1 rozbiłby świeżo wstawiony token.
 * Przelicznik jest ten sam przy zapisie, sprawdzeniu i kasowaniu reguły, więc cel `*` dalej
 * pasuje sam do siebie — po prostu do NICZEGO poza sobą.
 */
function literalTarget(raw: string): string {
    return raw.split('<').join('<<').split('*').join(STAR_TOKEN);
}

/** Trzy wyjścia z pytania o zgodę. */
export type ApprovalOutcome = 'approve' | 'deny' | 'redirect';

/** Opis akcji, o którą pytamy usera (buduje go wołacz — dziś `MCPClient`). */
export interface ApprovalAction {
    /** Typ akcji, np. `vault.write` / `external.call`. */
    type: string;
    description?: string;
    targetPath?: string;
    /**
     * Fix znaleziska TS-3 #9: wołacze (`MCPClient.invocationAgentName`, DiffModal) legalnie
     * podają `null` przy braku aktywnego agenta — runtime to toleruje (Map.get(null) = brak
     * reguł, fail-closed), więc typ przestaje kłamać, że agent zawsze jest.
     */
    agentName: string | null;
    preview?: string;
    /** R4 (E3.1): osobny cel reguły „zawsze" — dla narzędzi external prefiksowana nazwa narzędzia. */
    approvalTarget?: string;
    /** Wołacze dokładają własne pola informacyjne dla modala (np. `toolName`, `args`). */
    [key: string]: unknown;
}

/** Kształt „nowy" wyniku modala. */
export interface ApprovalModalResult {
    result?: string;
    reason?: string;
    instruction?: string;
}

/**
 * Handler zwraca obiekt (kształt nowy) ALBO goły string (kształt stary) — kod obsługuje oba
 * (`modalResult?.result || modalResult`), dlatego typ jest unią, a odczyty pól idą przez asercję.
 */
export type ApprovalHandlerResult = ApprovalModalResult | string | null | undefined;

/** Funkcja pokazująca modal zgody (wstrzykiwana z warstwy UI — core nie zna modala). */
export type ApprovalHandler = (
    app: unknown,
    action: ApprovalAction,
) => Promise<ApprovalHandlerResult> | ApprovalHandlerResult;

/** Wynik `requestApproval`. */
export interface ApprovalResult {
    result: ApprovalOutcome;
    reason?: string;
    instruction?: string;
}

/** Slice ustawień, w którym mieszkają trwałe reguły „zawsze zezwalaj". */
export interface ApprovalStorage {
    alwaysApprovedRules?: Record<string, string[]>;
    /** Starsza nazwa klucza — czytana przy wczytywaniu dla kompatybilności. */
    alwaysApproved?: Record<string, string[]>;
}

/** Callback zapisu ustawień (może być async — wynik jest tylko obserwowany przez `.catch`). */
export type ApprovalStorageChangeHandler = (storage: ApprovalStorage) => unknown;

/** Wpis historii pytań o zgodę (bufor w pamięci, przycinany do `maxHistorySize`). */
export interface ApprovalHistoryEntry {
    timestamp: number;
    agentName: string | null;
    actionType: string;
    targetPath: string | undefined;
    description: string | undefined;
    result: string;
}

/** Opcje konstruktora. */
export interface ApprovalManagerOptions {
    storage?: ApprovalStorage;
    onChange?: ApprovalStorageChangeHandler;
}

export class ApprovalManager {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3). Bez `private`,
    // bo to zwykłe pola instancji, po których chodzą wołacze w .js.
    declare app: unknown;
    declare storage: ApprovalStorage;
    declare onChange: ApprovalStorageChangeHandler | null;
    /** Agent -> Set of always-approved action patterns (klucz `null` = akcje bez agenta, patrz #9). */
    declare alwaysApproved: Map<string | null, Set<string>>;
    /** Approval history */
    declare history: ApprovalHistoryEntry[];
    declare maxHistorySize: number;
    declare approvalHandler: ApprovalHandler | null;

    /**
     * @param app - Obsidian App
     * @param options
     */
    constructor(app: unknown, options: ApprovalManagerOptions = {}) {
        this.app = app;
        this.storage = options.storage || {};
        this.onChange = typeof options.onChange === 'function' ? options.onChange : null;

        this.alwaysApproved = new Map();

        this.history = [];
        this.maxHistorySize = 500;
        this.approvalHandler = null;
        this.loadApprovals(this.storage);
    }

    setApprovalHandler(handler: ApprovalHandler | null): void {
        this.approvalHandler = typeof handler === 'function' ? handler : null;
    }

    /**
     * Request approval for an action
     * @param action - Action details
     */
    async requestApproval(action: ApprovalAction): Promise<ApprovalResult> {
        // R4 (E3.1): narzędzia zewnętrznych serwerów MCP niosą osobne `approvalTarget` (prefiksowana
        // nazwa narzędzia), żeby trwała reguła „zawsze" była per KONKRETNE narzędzie
        // (external.call::srv__tool), a nie za szeroka external.call::*. Dla pozostałych akcji
        // approvalTarget nie istnieje → fallback na targetPath (bez zmiany zachowania).
        const approvalTarget = action.approvalTarget ?? action.targetPath;

        // Check if action is always approved for this agent
        if (this.isAlwaysApproved(action.agentName, action.type, approvalTarget)) {
            this.logApproval(action, 'auto-approved');
            log.debug('ApprovalManager', 'Auto-approved:', action.type, approvalTarget);
            return { result: 'approve', reason: '' };
        }

        // Show approval modal — returns {result, reason?, instruction?}
        if (!this.approvalHandler) {
            throw new Error('ApprovalManager approval handler is not configured');
        }
        const modalResult = await this.approvalHandler(this.app, action);

        // Handle result (supports both old string and new object format)
        // Asercje, bo `modalResult` jest UNIĄ obiekt|string — wyrażenia zostają bez zmian.
        const resultKey = (modalResult as ApprovalModalResult | undefined)?.result || modalResult;
        const denyReason = (modalResult as ApprovalModalResult | undefined)?.reason || '';

        switch (resultKey) {
            case 'approve':
                this.logApproval(action, 'approved');
                return { result: 'approve', reason: '' };

            case 'always':
                // R4: zapisujemy regułę per approvalTarget (external = prefiksowana nazwa narzędzia).
                this.addToAlwaysApproved(action.agentName, action.type, approvalTarget);
                this.logApproval(action, 'always-approved');
                return { result: 'approve', reason: '' };

            // E2.3 (D21): trzecia ścieżka — użytkownik zatrzymuje akcję i przekierowuje
            // agenta instrukcją. Przepuszczamy kształt {result:'redirect', instruction}.
            case 'redirect':
                this.logApproval(action, 'redirect');
                return { result: 'redirect', instruction: (modalResult as ApprovalModalResult | undefined)?.instruction || '' };

            case 'deny':
            default:
                this.logApproval(action, 'denied');
                return { result: 'deny', reason: denyReason };
        }
    }

    /**
     * Check if action is always approved
     * @param agentName
     * @param actionType
     * @param targetPath
     */
    isAlwaysApproved(agentName: string | null, actionType: string, targetPath: string | undefined): boolean {
        const agentRules = this.alwaysApproved.get(agentName);
        if (!agentRules) return false;

        // Create pattern key
        const patternKey = this.createPatternKey(actionType, targetPath);

        // Check exact match
        if (agentRules.has(patternKey)) return true;

        // K2 (AUD-security-021): wieloznacznik `akcja::*` znaczy „dowolny CEL", więc wolno mu
        // pokryć wyłącznie wywołanie, które cel ma. Wywołanie BEZ celu ma własny, jawny klucz
        // (`akcja::<bez-celu>`) i musi trafić dokładnie w niego. Skutek uboczny: stara reguła
        // `akcja::*` zapisana jeszcze z pustego celu (np. `delegate`) przestaje pasować — user
        // klika „zawsze" raz jeszcze i dostaje regułę o właściwym znaczeniu.
        if (!String(targetPath ?? '').trim()) return false;

        // Check wildcard pattern (action type only)
        //
        // K22 (AUD-security-104): ta gałąź obsługuje już WYŁĄCZNIE reguły zastane w ustawieniach
        // — `createPatternKey` nie potrafi wyprodukować `akcja::*` z celu podanego przez wołacza,
        // a innej drogi zapisu reguły nie ma (ekran reguł tylko listuje i kasuje). Zostaje, żeby
        // nie zmienić po cichu znaczenia tego, co user ma już na dysku; `loadApprovals` o takich
        // regułach ostrzega. Dokładasz kiedyś JAWNĄ drogę „zezwalaj na wszystko"? Ma prowadzić
        // stąd — z ekranu reguł, nie z modala, który opisuje jedno konkretne wywołanie.
        const wildcardKey = `${actionType}::*`;
        if (agentRules.has(wildcardKey)) return true;

        return false;
    }

    /**
     * Add rule to always approved
     * @param agentName
     * @param actionType
     * @param targetPath
     */
    addToAlwaysApproved(agentName: string | null, actionType: string, targetPath: string | undefined): void {
        if (!this.alwaysApproved.has(agentName)) {
            this.alwaysApproved.set(agentName, new Set());
        }

        const patternKey = this.createPatternKey(actionType, targetPath);
        // Asercja, nie `?.`: linijkę wyżej wpis jest gwarantowany przez `has`/`set`.
        (this.alwaysApproved.get(agentName) as Set<string>).add(patternKey);

        log.debug('ApprovalManager', 'Added to always-approved:', agentName, patternKey);
        this.saveApprovals();
    }

    /**
     * Remove rule from always approved
     * @param agentName
     * @param actionType
     * @param targetPath
     */
    removeFromAlwaysApproved(agentName: string, actionType: string, targetPath: string | undefined): void {
        const agentRules = this.alwaysApproved.get(agentName);
        if (agentRules) {
            agentRules.delete(this.createPatternKey(actionType, targetPath));
            // K22: kasowanie musi sięgnąć też do reguł ZASTANYCH, zapisanych w formie dosłownej
            // sprzed tej naprawy (`akcja::*`). Ekran reguł rozbija wiersz po `::` i oddaje tu
            // surowy cel, więc bez tej linii user nie mógłby usunąć dokładnie tych reguł, które
            // ostrzeżenie każe mu przejrzeć. Kasowanie tylko zabiera uprawnienia — jest bezpieczne.
            agentRules.delete(`${actionType}::${String(targetPath ?? '').trim()}`);
            this.saveApprovals();
        }
    }

    /**
     * Load persistent rules from plugin settings.
     * Shape: { [agentName]: ["action::target"] }
     * @param storage
     */
    loadApprovals(storage: ApprovalStorage = {}): void {
        this.alwaysApproved.clear();
        const rulesByAgent = storage.alwaysApprovedRules || storage.alwaysApproved || {};
        /** K22: reguły wieloznaczne zastane w ustawieniach — do JEDNEGO ostrzeżenia niżej. */
        const legacyWildcards: string[] = [];
        for (const [agentName, rules] of Object.entries(rulesByAgent)) {
            if (!Array.isArray(rules)) continue;
            const clean = rules.filter(r => typeof r === 'string');
            for (const rule of clean) {
                if (rule.endsWith('::*')) legacyWildcards.push(`${agentName}: ${rule}`);
            }
            // AUD-code-review-058: odkręcamy sentinel z saveApprovals — inaczej reguła bez
            // agenta wraca pod kluczem Mapy STRING `NO_AGENT_TOKEN`, a `isAlwaysApproved(null,…)`
            // pyta o prawdziwy `null` i nigdy jej nie znajdzie.
            const key = agentName === NO_AGENT_TOKEN ? null : agentName;
            this.alwaysApproved.set(key, new Set(clean));
        }

        // K22 (AUD-security-104): od tej wersji `akcja::*` nie powstaje z celu podanego przez
        // wołacza — więc każda taka reguła W USTAWIENIACH jest zaszłością. Część mogła powstać
        // z jednego kliknięcia „Zawsze zezwalaj" na bezsensownym celu `*` albo (przed K2) na
        // wywołaniu bez celu, a odróżnić ich od świadomych nie da się. NIE kasujemy ich po cichu
        // — semantyka zastanych reguł zostaje bez zmian — ale user ma się o nich dowiedzieć
        // i przejrzeć je w Ustawienia → Bezpieczeństwo → „Approved actions".
        if (legacyWildcards.length) {
            log.warn(
                'ApprovalManager',
                `Zastane reguły „zawsze zezwalaj" obejmujące DOWOLNY cel (${legacyWildcards.length}) — przejrzyj je w Ustawieniach → Bezpieczeństwo: ${legacyWildcards.join(', ')}`,
            );
        }
    }

    /**
     * Persist rules back into settings and call the injected save callback.
     */
    saveApprovals(): void {
        const serialized: Record<string, string[]> = {};
        for (const [agentName, rules] of this.alwaysApproved.entries()) {
            // AUD-code-review-058: klucz null idzie pod jawnym sentinelem (NO_AGENT_TOKEN),
            // nie pod koercją property-key `"null"` — inaczej loadApprovals nie ma jak go
            // odróżnić od agenta, który miałby taką samą literalną nazwę.
            const key = agentName === null ? NO_AGENT_TOKEN : agentName;
            serialized[key] = Array.from(rules);
        }
        this.storage.alwaysApprovedRules = serialized;
        if (this.onChange) {
            try {
                // Asercja + typ w callbacku: `onChange` bywa async, a kod tylko podgląda `.catch`.
                const result = this.onChange(this.storage) as Promise<unknown> | undefined;
                if (result?.catch) result.catch((e: unknown) => log.warn('ApprovalManager', 'Save failed:', e));
            } catch (e) {
                log.warn('ApprovalManager', 'Save failed:', e);
            }
        }
    }

    /**
     * Create pattern key for storage
     *
     * K2 (AUD-security-021): „brak celu" i „dowolny cel" to DWIE różne rzeczy. Dawniej pusty
     * `targetPath` zapadał w `akcja::*`, czyli w wieloznacznik — jedno kliknięcie „Zawsze zezwalaj"
     * na wywołaniu bez ścieżki (a takie wywołanie i tak odbija się o walidację w narzędziu, więc
     * user klika je spokojnie) zapisywało regułę auto-zatwierdzającą KAŻDY przyszły zapis tego
     * agenta. Brak celu ma teraz własny, jawny token, który nie pasuje do niczego innego.
     *
     * K22 (AUD-security-104): druga połowa tej samej reguły. K2 zamknął drogę „pusty cel →
     * wieloznacznik", ale DOSŁOWNA gwiazdka z argumentu narzędzia (`delete {path:"*"}`) dalej
     * produkowała klucz `akcja::*` — modal pokazywał bezsensowny cel, wywołanie i tak padało
     * w walidacji narzędzia, więc user klikał spokojnie „Zawsze zezwalaj" i zapisywał trwałą
     * zgodę na KAŻDY przyszły cel tej akcji. Dziś cel przechodzi przez `literalTarget`, więc
     * **żaden wieloznacznik nie powstaje z celu podanego przez wołacza** — `akcja::*` może
     * przyjechać wyłącznie z reguł ZASTANYCH w ustawieniach (patrz `loadApprovals`).
     * @private
     */
    createPatternKey(actionType: string, targetPath: string | undefined): string {
        const target = String(targetPath ?? '').trim();
        return `${actionType}::${target ? literalTarget(target) : NO_TARGET_TOKEN}`;
    }

    /**
     * Log approval to history
     * @private
     */
    logApproval(action: ApprovalAction, result: string): void {
        const entry: ApprovalHistoryEntry = {
            timestamp: Date.now(),
            agentName: action.agentName,
            actionType: action.type,
            targetPath: action.targetPath,
            description: action.description,
            result
        };

        this.history.push(entry);

        // Trim if needed
        if (this.history.length > this.maxHistorySize) {
            this.history = this.history.slice(-this.maxHistorySize / 2);
        }
    }

    /**
     * Get approval history
     * @param limit
     */
    getHistory(limit = 100): ApprovalHistoryEntry[] {
        return this.history.slice(-limit);
    }

    /**
     * Get always-approved rules for agent
     * @param agentName
     */
    getAlwaysApprovedRules(agentName: string): string[] {
        const rules = this.alwaysApproved.get(agentName);
        return rules ? Array.from(rules) : [];
    }

    /**
     * Get all persistent rules for Settings -> Security management UI.
     */
    getAllAlwaysApprovedRules(): Array<{ agentName: string | null; rule: string }> {
        const rows: Array<{ agentName: string | null; rule: string }> = [];
        for (const [agentName, rules] of this.alwaysApproved.entries()) {
            for (const rule of rules) rows.push({ agentName, rule });
        }
        return rows;
    }
}
