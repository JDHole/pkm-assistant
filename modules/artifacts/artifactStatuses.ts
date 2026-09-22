/**
 * Rejestr statusów artefaktów w OBU językach (PL/EN) - jedyne źródło prawdy dla `artifactButtons.ts`
 * (guziki wg statusu), `ArtifactStore.archive()` (sprzątanie domkniętych) i `basesView.ts`
 * (filtr „Otwarte"). Analogiczny do `modules/memory/brainSections.ts`, ale dla statusów typów
 * artefaktów zamiast nagłówków brain.md.
 *
 * KONTRAKT (decyzja właściciela 19.09): nowy artefakt utworzony z fabrycznego szablonu EN
 * dostaje statusy EN w PLIKU (np. `pending-approval`, nie `do-akceptacji`) - `ArtifactTypeLoader`
 * seeduje/podmienia szablon w języku UI. Silnik rozpoznaje OBA zestawy jednocześnie (typ
 * usera z mieszanym/własnym słownictwem też działa - patrz `pendingStatusOf`/`closedStatusOf`
 * niżej). Istniejące pliki instancji NIE są migrowane - status na dysku jest tym, co tam jest.
 *
 * Pure (zero importów Obsidiana/i18n) - node-testowalne, jak `artifactButtons.ts`.
 */

/** Rola statusu w cyklu życia artefaktu - język-niezależna. */
export type ArtifactStatusRole = 'draft' | 'pending' | 'remarks' | 'accepted' | 'closed' | 'in_progress' | 'ready';

/** Język PLIKU (literały statusów w tym pliku typu/instancji), nie język interfejsu na żywo. */
export type ArtifactStatusLocale = 'pl' | 'en';

const ROLES: readonly ArtifactStatusRole[] = ['draft', 'pending', 'remarks', 'accepted', 'closed', 'in_progress', 'ready'];

/** Literały statusów wbudowanych typów, per rola i JĘZYK PLIKU. */
export const ARTIFACT_STATUS_LITERALS: Readonly<Record<ArtifactStatusLocale, Readonly<Record<ArtifactStatusRole, string>>>> = {
    pl: {
        draft: 'szkic',
        pending: 'do-akceptacji',
        remarks: 'uwagi',
        accepted: 'zaakceptowany',
        closed: 'zamkniety',
        in_progress: 'w-trakcie',
        ready: 'gotowy',
    },
    en: {
        draft: 'draft',
        pending: 'pending-approval',
        remarks: 'remarks',
        accepted: 'accepted',
        closed: 'closed',
        in_progress: 'in-progress',
        ready: 'ready',
    },
};

/** Literał → `{role, locale}`, albo `null` gdy nierozpoznany (typ usera z własnym słownictwem). */
function findStatusEntry(literal: string): { role: ArtifactStatusRole; locale: ArtifactStatusLocale } | null {
    for (const locale of ['pl', 'en'] as ArtifactStatusLocale[]) {
        for (const role of ROLES) {
            if (ARTIFACT_STATUS_LITERALS[locale][role] === literal) return { role, locale };
        }
    }
    return null;
}

/** Rola danego literału statusu w OBU językach, albo `null` gdy nierozpoznany. */
export function statusRole(literal: string): ArtifactStatusRole | null {
    return findStatusEntry(literal)?.role ?? null;
}

/** Literał statusu dla danej roli, w podanym języku PLIKU. */
export function statusLiteral(role: ArtifactStatusRole, locale: ArtifactStatusLocale): string {
    return ARTIFACT_STATUS_LITERALS[locale][role];
}

/**
 * Status z rolą `pending` w LIŚCIE statusów typu, a gdy żaden nie ma tej roli (typ usera z
 * własnym słownictwem, np. `['todo', 'zaakceptowany', 'uwagi', 'done']`) - pierwszy status
 * listy (`statusy[0]`), z założenia „pierwszy etap = czeka na decyzję". Pusta lista -> `undefined`.
 */
export function pendingStatusOf(statusy: readonly string[]): string | undefined {
    return statusy.find(s => statusRole(s) === 'pending') ?? statusy[0];
}

/**
 * Status z rolą `closed` w liście, a gdy brak - OSTATNI status listy (`statusy[statusy.length-1]`,
 * z założenia „ostatni etap = domknięcie"). Pusta lista -> `undefined`.
 */
export function closedStatusOf(statusy: readonly string[]): string | undefined {
    return statusy.find(s => statusRole(s) === 'closed') ?? statusy[statusy.length - 1];
}

/**
 * Status z rolą `accepted` w liście, albo `null`. W przeciwieństwie do `pendingStatusOf`/
 * `closedStatusOf` NIE ma fallbacku pozycyjnego - własna nazwa usera dla „zaakceptowany" nie
 * jest tu rozpoznawana (nie ma jednoznacznej pozycji w liście, którą dałoby się zgadnąć).
 */
export function acceptedStatusOf(statusy: readonly string[]): string | null {
    return statusy.find(s => statusRole(s) === 'accepted') ?? null;
}

/** Status z rolą `remarks` w liście, albo `null` - ta sama zasada braku fallbacku co wyżej. */
export function remarksStatusOf(statusy: readonly string[]): string | null {
    return statusy.find(s => statusRole(s) === 'remarks') ?? null;
}

/**
 * Język PLIKU, do którego należy ten literał statusu (PL/EN), albo `null` gdy nierozpoznany.
 * Wołany wyłącznie przez `artifactButtons.ts` w gałęzi „typ nieznany/osierocony, statusy=[]"
 * (bez listy nie ma z czego wyliczyć `acceptedStatusOf`/`remarksStatusOf` - fallback bierze
 * język z SAMEGO bieżącego statusu, żeby zaproponować przejścia w TYM SAMYM języku).
 */
export function statusLocaleOf(literal: string): ArtifactStatusLocale | null {
    return findStatusEntry(literal)?.locale ?? null;
}
