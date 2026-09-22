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
 * `closedStatusOf(statusy)` (własna nazwa końcowa typu usera, fallback = ostatni w liście).
 * @param {string} status
 * @param {string[]} statusy - lista statusów typu (ostatni = domknięcie, gdy brak roli rozpoznanej)
 * @returns {boolean}
 */
export function isClosedStatus(status: string, statusy: string[] = []): boolean {
    if (statusRole(status) === 'closed') return true;
    const list = Array.isArray(statusy) ? statusy : [];
    return list.length > 0 && status === closedStatusOf(list);
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
    // `pending` (w KTÓRYMKOLWIEK języku), zaproponuj przejścia w TYM SAMYM języku co status,
    // zamiast milczeć tylko dlatego, że nie ma listy do przeszukania.
    const unrestricted = list.length === 0;

    if (status === pendingStatusOf(list) || (unrestricted && statusRole(status) === 'pending')) {
        const locale = unrestricted ? statusLocaleOf(status) : null;
        const acceptedTarget = acceptedStatusOf(list) ?? (locale ? statusLiteral('accepted', locale) : null);
        const remarksTarget = remarksStatusOf(list) ?? (locale ? statusLiteral('remarks', locale) : null);
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
