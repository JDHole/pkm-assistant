/**
 * deleteOutcome - co zameldować po próbie skasowania suba/szablonu (AUD-bledy-012).
 *
 * `SubAgentLoader.deleteSubAgent` i `SubAgentTemplateStore.delete` łapią wyjątek adaptera
 * i zwracają `false` (np. `rmdir` jest NIEREKURENCYJNE, więc wystarczy jeden dodatkowy plik
 * w folderze suba: plik konfliktu synchronizacji, `desktop.ini`, notatka usera). Do naprawy
 * wołacze tej wartości nie czytali: user dostawał „Usunięto: X", modal się zamykał, a sub
 * zostawał w cache i na liście.
 *
 * Moduł jest CZYSTY (zero DOM, zero i18n) - oddaje KLUCZ komunikatu, tłumaczy wołacz.
 */

/** Decyzja o komunikacie po kasowaniu. */
export interface DeleteOutcome {
    /** `true` wyłącznie wtedy, gdy kasowanie POTWIERDZIŁO skutek. */
    ok: boolean;
    /** Klucz i18n do `t()`. */
    messageKey: string;
    params: { name: string };
}

/**
 * @param deleted zwrotka `deleteSubAgent`/`delete` - `true` znaczy „skasowane".
 *   Cokolwiek innego (w tym `undefined` z opcjonalnego łańcucha, gdy magazynu nie ma)
 *   jest traktowane jako PORAŻKA: brak potwierdzenia to nie jest sukces.
 */
export function resolveDeleteOutcome(deleted: unknown, name: string): DeleteOutcome {
    const ok = deleted === true;
    return {
        ok,
        messageKey: ok ? 'modal.sub_agent.deleted' : 'modal.sub_agent.delete_failed',
        params: { name },
    };
}
