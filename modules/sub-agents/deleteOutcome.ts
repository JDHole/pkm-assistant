/**
 * deleteOutcome - co zameldować po próbie skasowania suba/szablonu.
 *
 * `SubAgentLoader.deleteSubAgent` i `SubAgentTemplateStore.delete` zwracają `false`, gdy
 * adapter rzuci przy usuwaniu plików. Dla żywego suba także nieudane, nierekurencyjne `rmdir`
 * daje `false` (np. gdy folder zawiera dodatkowy plik). Magazyn szablonów ignoruje błąd
 * `rmdir` i po usunięciu plików szablonu zwraca `true`, nawet gdy folder pozostał.
 * Wołacze MUSZĄ czytać wynik: bez tego przy `false` user dostaje „Usunięto: X", choć wpis
 * pozostał w cache i na liście.
 *
 * Moduł jest CZYSTY (zero DOM, zero i18n) - oddaje KLUCZ komunikatu, tłumaczy wołacz.
 */

/** Decyzja o komunikacie po kasowaniu. */
export interface DeleteOutcome {
    /** `true` wyłącznie wtedy, gdy kasowanie POTWIERDZIŁO skutek. */
    ok: boolean;
    /** Klucz i18n do `t()`. */
    messageKey: string;
    params: { name: string; copies?: string };
}

export function templateCopyNames(templateName: string, subAgents: readonly { name: string; from_template?: string | null }[]): string[] {
    const marker = new RegExp(`^${templateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} v[1-9]\\d*$`);
    return subAgents.filter(sub => typeof sub.from_template === 'string' && marker.test(sub.from_template)).map(sub => sub.name);
}

export function templateDeleteConfirmation(name: string, copies: readonly string[], noCopiesLabel: string): { messageKey: 'backstage.confirm_delete_sub_template'; name: string; copies: string } {
    return { messageKey: 'backstage.confirm_delete_sub_template', name, copies: copies.length > 0 ? copies.join(', ') : noCopiesLabel };
}

/**
 * @param deleted zwrotka `deleteSubAgent`/`delete` - `true` znaczy „skasowane".
 *   Cokolwiek innego (w tym `undefined` z opcjonalnego łańcucha, gdy magazynu nie ma)
 *   jest traktowane jako PORAŻKA: brak potwierdzenia to nie jest sukces.
 */
export function resolveDeleteOutcome(deleted: unknown, name: string, copies?: readonly string[]): DeleteOutcome {
    const ok = deleted === true;
    return {
        ok,
        messageKey: ok ? 'modal.sub_agent.deleted' : 'modal.sub_agent.delete_failed',
        params: { name, ...(copies ? { copies: copies.join(', ') } : {}) },
    };
}
