/**
 * artifactButtons.js — logika „status instancji → przyciski w notatce".
 *
 * Pure module (ZERO importów Obsidiana / i18n, poza `artifactStatuses.ts` - też pure) →
 * node-testowalne. Renderer (`artifactBlocks.js`) bierze z tego listę akcji, a etykiety
 * tłumaczy przez `t()` po `labelKey`. Rozdział celowy: decyzja „co pokazać" jest deterministyczna
 * i pokrywalna testem, „jak nazwać" żyje w i18n.
 *
 * Kontrakt akcji:
 *  - `action`   — identyfikator kliknięcia ('approve' | 'revise' | 'summon').
 *  - `statusTo` — docelowy status (set_field) LUB null (samo przywołanie bez zmiany statusu).
 *  - `labelKey` — klucz i18n etykiety przycisku.
 *  - `summonKey`— klucz i18n frazy „user zrobił X" wstrzykiwanej do wiadomości przywołania.
 *  - `icon`     — emoji przycisku.
 *
 * Mapa (dla typu `plan`, uogólniona na dowolny typ przez `statusy`, w OBU językach —
 * `modules/artifacts/artifactStatuses.ts`):
 *  - status = `closedStatusOf(statusy)` (LUB dowolny literał roli `closed` obu języków,
 *    niezależnie od deklaracji typu) → BRAK przycisków (artefakt domknięty).
 *  - status = `pendingStatusOf(statusy)` → [✅ Zatwierdź] (→ `acceptedStatusOf(statusy)`)
 *    [💬 Odeślij z uwagami] (→ `remarksStatusOf(statusy)`) - każdy przycisk TYLKO jeśli jego
 *    rola jest rozpoznana w `statusy` typu (własna nazwa usera dla accepted/remarks nie ma
 *    fallbacku pozycyjnego, patrz `artifactStatuses.ts`).
 *  - każdy inny status niedomknięty → [📣 Przywołaj agenta] (bez zmiany statusu).
 */
import {
    statusRole,
    statusLiteral,
    statusLocaleOf,
    pendingStatusOf,
    closedStatusOf,
    acceptedStatusOf,
    remarksStatusOf,
} from './artifactStatuses.js';

/** Status uznawany za „domknięty" w PL (zostaje jako stała wsteczna zgodność - wołaj `isClosedStatus`). */
export const CLOSED_STATUS = 'zamkniety';

export interface ArtifactButton {
    action: 'approve' | 'revise' | 'summon';
    statusTo: string | null;
    labelKey: string;
    summonKey: string;
    icon: string;
}

/**
 * Czy status oznacza domknięcie artefaktu (brak przycisków). Prawda gdy: literał ma rolę
 * `closed` w KTÓRYMKOLWIEK z dwóch języków (niezależnie od tego, czy typ w ogóle go deklaruje -
 * `'zamkniety'`/`'closed'` domykają zawsze, jak dotąd), ALBO status pasuje do
 * `closedStatusOf(statusy)` (rola rozpoznana w liście, fallback = ostatni w liście), ALBO
 * status jest dosłownie OSTATNIM elementem listy (zachowanie sprzed rejestru bilingwalnego -
 * `closedStatusOf` zwraca TYLKO JEDEN literał, więc dla typu z trzema statusami, gdzie rola
 * `closed` jest rozpoznana w ŚRODKU listy (np. `['open', 'zamkniety', 'archived']`), sam ostatni
 * element `'archived'` przestałby się liczyć jako domknięty bez tego drugiego, niezależnego
 * warunku).
 * @param {string} status
 * @param {string[]} statusy - lista statusów typu (ostatni = domknięcie, gdy brak roli rozpoznanej)
 * @returns {boolean}
 */
export function isClosedStatus(status: string, statusy: string[] = []): boolean {
    if (statusRole(status) === 'closed') return true;
    const list = Array.isArray(statusy) ? statusy : [];
    if (list.length === 0) return false;
    return status === closedStatusOf(list) || status === list[list.length - 1];
}

/**
 * Wylicz przyciski dla instancji.
 * @param {string} status - bieżący status instancji (frontmatter `status`)
 * @param {string[]} [statusy] - statusy zadeklarowane w typie (pusta lista = brak ograniczeń)
 * @returns {Array<{action:string, statusTo:string|null, labelKey:string, summonKey:string, icon:string}>}
 */
export function computeArtifactButtons(status: string, statusy: string[] = []): ArtifactButton[] {
    if (isClosedStatus(status, statusy)) return [];

    const list = Array.isArray(statusy) ? statusy : [];
    // Typ nieznany/osierocony (statusy=[]) — nie ograniczaj: jeśli sam status ma rolę
    // `pending` (w KTÓRYMKOLWIEK języku), zaproponuj przejścia zamiast milczeć tylko dlatego,
    // że nie ma listy do przeszukania.
    const unrestricted = list.length === 0;
    // „Czeka na decyzję" = albo pasuje do statusu wyliczonego z DZISIEJSZEJ listy typu, albo
    // sam ma rozpoznaną rolę `pending` w KTÓRYMKOLWIEK języku - drugi warunek jest KLUCZOWY:
    // `ensureBuiltinTypes` podmienia NIETKNIĘTY plik typu na język UI przy KAŻDYM starcie, więc
    // istniejąca instancja `do-akceptacji` (PL) pod typem, który w międzyczasie stał się EN
    // (`pendingStatusOf(list)` = `'pending-approval'`), inaczej przestawałaby być rozpoznana
    // jako „czeka na decyzję" i dostawałaby tylko generyczne „Przywołaj agenta" (bug zgłoszony
    // przez recenzję niezależną - probe [measured]).
    const isPending = status === pendingStatusOf(list) || statusRole(status) === 'pending';

    if (isPending) {
        const acceptedInList = acceptedStatusOf(list);
        const remarksInList = remarksStatusOf(list);
        // Język CELU przejścia idzie za językiem SAMEGO STATUSU (gdy rozpoznany), NIE za
        // językiem, w którym typ AKURAT dziś deklaruje swoje statusy - instancja ma zostać
        // wewnętrznie spójna w SWOIM języku, nawet gdy plik typu w międzyczasie zmienił język
        // (patrz wyżej). `acceptedInList`/`remarksInList` decydują TYLKO o tym, CZY typ w ogóle
        // chce tego kroku (którakolwiek rola w którymkolwiek języku) - nie o tym, w jakim
        // języku ma być literał. Typ własny bez rozpoznanej roli dla statusu (`locale===null`,
        // np. `'todo'`) trzyma się dosłownie tego, co deklaruje lista.
        const locale = statusLocaleOf(status);
        const acceptedTarget = (acceptedInList !== null || unrestricted)
            ? (locale ? statusLiteral('accepted', locale) : acceptedInList)
            : null;
        const remarksTarget = (remarksInList !== null || unrestricted)
            ? (locale ? statusLiteral('remarks', locale) : remarksInList)
            : null;
        const buttons: ArtifactButton[] = [];
        if (acceptedTarget) {
            buttons.push({
                action: 'approve',
                statusTo: acceptedTarget,
                labelKey: 'artifact.btn.approve',
                summonKey: 'artifact.summon.action.approve',
                icon: '✅',
            });
        }
        if (remarksTarget) {
            buttons.push({
                action: 'revise',
                statusTo: remarksTarget,
                labelKey: 'artifact.btn.revise',
                summonKey: 'artifact.summon.action.revise',
                icon: '💬',
            });
        }
        if (buttons.length > 0) return buttons;
    }

    // Domyślnie: sam guzik przywołania (np. status 'zaakceptowany' / 'uwagi' / 'szkic').
    return [{
        action: 'summon',
        statusTo: null,
        labelKey: 'artifact.btn.summon',
        summonKey: 'artifact.summon.action.summon',
        icon: '📣',
    }];
}
