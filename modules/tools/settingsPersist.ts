/**
 * settingsPersist - decyzja "co zrobić, gdy zapis ustawień padnie" (AUD-bledy-028).
 *
 * Handlery zakładki Ustawienia → Narzędzia mutują worek ustawień W PAMIĘCI, a dopiero potem
 * wołają zapis. Do naprawy nikt tego zapisu nie łapał: odrzucenie wracało do `async`
 * listenera DOM i ginęło, a `refresh()` odrysowywał wiersz Z PAMIĘCI - user widział nowy
 * stan, którego na dysku nie było (po restarcie wracał stary).
 *
 * Helpery są CZYSTE (zero DOM, zero `Notice`, zero i18n) - meldunek i przerysowanie
 * zostają w UI, tutaj mieszka sama reguła.
 */

/** Wynik próby utrwalenia mutacji ustawień. */
interface PersistOutcome {
    /** `true` = zapis wrócił bez błędu; `false` = mutacja została COFNIĘTA. */
    saved: boolean;
    error?: unknown;
}

/**
 * Zapis z cofnięciem: przy padzie woła `rollback()` i oddaje `saved:false` + powód.
 * Nigdy nie rzuca - wołacz ma zameldować i przerysować się ze stanu prawdziwego.
 */
export async function persistOrRollback(
    persist: () => Promise<void> | void,
    rollback: () => void,
): Promise<PersistOutcome> {
    try {
        await persist();
        return { saved: true };
    } catch (error) {
        rollback();
        return { saved: false, error };
    }
}

/** Wynik przełączenia kill-switcha serwera MCP. */
interface KillSwitchOutcome {
    /** Czy zamknięcie serwera (wyrejestrowanie narzędzi) się wykonało. Tylko przy wyłączaniu. */
    closed: boolean;
    closeError?: unknown;
    saved: boolean;
    saveError?: unknown;
}

/**
 * Kill-switch serwera MCP: ZAMKNIĘCIE nie zależy od zapisu.
 *
 * Kolejność jest kontraktem - user, który wyłącza konektor, odbiera mu prawo dostarczania
 * narzędzi TU I TERAZ. Do naprawy `close()` stało za `await persist()`, więc pad zapisu
 * zostawiał narzędzia wyłączonego serwera w `ToolRegistry`, a wiersz i tak malował się
 * na "wyłączony". Dziś zamykamy najpierw, a zapis melduje się osobno (i cofa mutację,
 * gdy padnie).
 */
export async function applyServerKillSwitch(opts: {
    /** Docelowy stan przełącznika (`false` = wyłączamy serwer). */
    enable: boolean;
    /** Mutacja w pamięci (`cfg.enabled = enable`). */
    apply: () => void;
    /** Cofnięcie mutacji do stanu SPRZED kliknięcia (surowa wartość, nie zanegowana). */
    rollback: () => void;
    /** Zamknięcie serwera + wyrejestrowanie jego narzędzi. */
    close: () => Promise<void> | void;
    persist: () => Promise<void> | void;
}): Promise<KillSwitchOutcome> {
    const outcome: KillSwitchOutcome = { closed: false, saved: false };
    opts.apply();

    if (!opts.enable) {
        try {
            await opts.close();
            outcome.closed = true;
        } catch (error) {
            outcome.closeError = error;
        }
    }

    const persisted = await persistOrRollback(opts.persist, opts.rollback);
    outcome.saved = persisted.saved;
    if (!persisted.saved) outcome.saveError = persisted.error;
    return outcome;
}
