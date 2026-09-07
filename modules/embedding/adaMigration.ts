/**
 * adaMigration — meldunek z migracji `text-embedding-ada-002` → `text-embedding-3-small`.
 *
 * WHY (AUD-bledy-040): `src/main.ts` podmieniał klucz modelu w pamięci, pokazywał
 * 15-sekundowy Notice „Przełączam na 3-small. Wymagany reindex", a DOPIERO POTEM próbował
 * zapisać ustawienia — w `try { save() } catch (_) {}`. Gdy zapis padał (zajęty plik, dysk
 * sieciowy), nie zostawało ani logu, ani drugiego komunikatu: user szedł robić reindex pod
 * ustawienie, które przy następnym starcie wracało do ada-002.
 *
 * RULE: komunikat mówi to, co JEST — obietnica przełączenia leci wyłącznie po potwierdzonym
 * zapisie, a pad zapisu ma własny tekst (i własny wpis w logu).
 */

/** Wycofany model OpenAI (deprecation 2024). */
export const ADA_FROM = 'text-embedding-ada-002';
/** Następca o innych wymiarach wektora — stąd wymóg reindeksu. */
export const ADA_TO = 'text-embedding-3-small';

/** Czas życia komunikatu — migracja jest jednorazowa, user ma zdążyć przeczytać. */
export const ADA_NOTICE_MS = 15000;

export interface AdaMigrationPorts {
    /** Zapis ustawień (`settingsStore.save`). Sync albo async — obie drogi łapane. */
    save?: (() => Promise<void> | void) | null;
    /** Pokazanie komunikatu userowi (`Notice`). */
    notify: (message: string, durationMs: number) => void;
    /** Log padu zapisu (kontekst dla agenta czytającego pkm-assistant.log). */
    onError?: (error: unknown) => void;
}

const MSG_SAVED = [
    `OpenAI ${ADA_FROM} zostało wycofane.`,
    `Przełączam na ${ADA_TO}.`,
    "Wymagany reindex vault'a (wymiary embeddingu się zmieniły).",
].join('\n');

const MSG_NOT_PERSISTED = [
    `OpenAI ${ADA_FROM} zostało wycofane.`,
    `Przełączyłem na ${ADA_TO} TYLKO w tej sesji.`,
    'Zapis ustawień nie powiódł się - po restarcie Obsidiana wróci stary model.',
].join('\n');

/**
 * Utrwal migrację i zamelduj userowi jej PRAWDZIWY wynik.
 * @returns true tylko przy potwierdzonym zapisie ustawień.
 */
export async function announceAdaMigration(ports: AdaMigrationPorts): Promise<boolean> {
    const { save, notify, onError } = ports;
    try {
        if (typeof save !== 'function') throw new Error('brak zapisywacza ustawień (settingsStore.save)');
        await save();
    } catch (error) {
        try { onError?.(error); } catch { /* meldunek nigdy nie może wywalić startu */ }
        notify(MSG_NOT_PERSISTED, ADA_NOTICE_MS);
        return false;
    }
    notify(MSG_SAVED, ADA_NOTICE_MS);
    return true;
}
