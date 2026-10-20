/**
 * templateUseOutcome - co zameldować po „Użyj u agenta" w Zapleczu.
 *
 * `useTemplateAtAgent` robi DWA zapisy pod rząd (`store.instantiate` → kopia suba na dysku,
 * `agentManager.updateAgent` → przypisanie do agenta) i nie miał `try/catch`, a kafel odpalał
 * ten async handler bez `.catch`. Rzut z któregokolwiek zapisu leciał w próżnię: user nie
 * dostawał żadnego komunikatu, lista się nie odświeżała, a kopia suba mogła już leżeć na
 * dysku bez przypisania do agenta (drugie kliknięcie odlewało kolejną, z sufiksem `-2`).
 *
 * Moduł jest CZYSTY (zero DOM, zero obsidian, zero i18n) - oddaje KLUCZ komunikatu,
 * tłumaczy wołacz. Ten sam wzór co `deleteOutcome.ts`.
 */

/** Decyzja o komunikacie po próbie użycia szablonu u agenta. */
export interface TemplateUseOutcome {
    /** `true` wyłącznie wtedy, gdy operacja doszła do końca bez rzutu. */
    ok: boolean;
    /** Klucz i18n do `t()`; `null` przy sukcesie (komunikat sukcesu należy do samej operacji). */
    messageKey: string | null;
    params: { error: string };
    /** Surowy rzut - do `log.error`, nie do usera. */
    error: unknown;
    /** Błąd kompensacyjnego kasowania kopii - do zalogowania osobno. */
    cleanupError?: unknown;
}

export interface TemplateUseOperations {
    instantiate: () => Promise<{ success: boolean; name?: string; error?: string }>;
    assign: (copyName: string) => Promise<unknown>;
    deleteSubAgent: (copyName: string) => Promise<boolean>;
}

/** Wykonuje oba zapisy i usuwa kopię, gdy zapis przypisania zawiedzie. */
export async function useTemplateWithCompensation(operations: TemplateUseOperations): Promise<TemplateUseOutcome> {
    let copyName: string | undefined;
    try {
        const created = await operations.instantiate();
        if (!created.success || !created.name) throw new Error(created.error || 'template_not_created');
        copyName = created.name;
        await operations.assign(copyName);
        return { ok: true, messageKey: null, params: { error: '' }, error: null };
    } catch (error) {
        let cleanupError: unknown;
        if (copyName) {
            try {
                if (!await operations.deleteSubAgent(copyName)) cleanupError = 'delete_failed';
            } catch (cleanupFailure) {
                cleanupError = cleanupFailure;
            }
        }
        return {
            ok: false,
            messageKey: 'backstage.template_use_failed',
            params: { error: templateUseErrorText(error) },
            error,
            ...(cleanupError === undefined ? {} : { cleanupError }),
        };
    }
}

/**
 * Wyciąga zdanie z rzutu. Bez maskowania: to komunikat adaptera vaulta (ENOSPC, EACCES,
 * „folder już istnieje"), nie odpowiedź modelu ani nagłówek HTTP.
 */
export function templateUseErrorText(error: unknown): string {
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim()) return message;
    const text = error === null || error === undefined ? '' : _rawToString(error);
    return text && text !== '[object Object]' ? text : 'unknown error';
}

/**
 * Osobna funkcja graniczna: dopiero jej wywołanie resetuje zawężenie TS z powrotem do gołego
 * `unknown`, więc `String()` tutaj nie zgłasza no-base-to-string (ten sam wzorzec co
 * `_safeStringify` w `core/utils/errorUtils.ts`). Wynik `[object Object]` jest tu OCZEKIWANY
 * dla obiektów bez `message` - dlatego wołacz go osobno odfiltrowuje na 'unknown error'.
 */
function _rawToString(value: unknown): string {
    return String(value);
}

/**
 * Bezpiecznik kafla: cokolwiek `run` rzuci, user ma zobaczyć ZDANIE, a nie ciszę.
 *
 * @param run operacja kafla (`useTemplateAtAgent`) - jej własne ścieżki odmowy
 *   (brak agenta, `result.success === false`) meldują się same i kończą bez rzutu.
 */
export async function guardTemplateUse(run: () => Promise<unknown>): Promise<TemplateUseOutcome> {
    try {
        await run();
        return { ok: true, messageKey: null, params: { error: '' }, error: null };
    } catch (error) {
        return {
            ok: false,
            messageKey: 'backstage.template_use_failed',
            params: { error: templateUseErrorText(error) },
            error,
        };
    }
}
