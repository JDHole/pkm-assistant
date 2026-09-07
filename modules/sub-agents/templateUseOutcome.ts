/**
 * templateUseOutcome - co zameldować po „Użyj u agenta" w Zapleczu (AUD-bledy-014).
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
}

/**
 * Wyciąga zdanie z rzutu. Bez maskowania: to komunikat adaptera vaulta (ENOSPC, EACCES,
 * „folder już istnieje"), nie odpowiedź modelu ani nagłówek HTTP.
 */
export function templateUseErrorText(error: unknown): string {
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim()) return message;
    const text = String(error ?? '');
    return text && text !== '[object Object]' ? text : 'unknown error';
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
