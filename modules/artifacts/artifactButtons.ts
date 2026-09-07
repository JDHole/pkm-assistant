/**
 * artifactButtons.js — logika „status instancji → przyciski w notatce" (E2.9 FAZA B / B1).
 *
 * Pure module (ZERO importów Obsidiana / i18n) → node-testowalne. Renderer (`artifactBlocks.js`)
 * bierze z tego listę akcji, a etykiety tłumaczy przez `t()` po `labelKey`. Rozdział celowy:
 * decyzja „co pokazać" jest deterministyczna i pokrywalna testem, „jak nazwać" żyje w i18n.
 *
 * Kontrakt akcji:
 *  - `action`   — identyfikator kliknięcia ('approve' | 'revise' | 'summon').
 *  - `statusTo` — docelowy status (set_field) LUB null (samo przywołanie bez zmiany statusu).
 *  - `labelKey` — klucz i18n etykiety przycisku.
 *  - `summonKey`— klucz i18n frazy „user zrobił X" wstrzykiwanej do wiadomości przywołania (B2).
 *  - `icon`     — emoji przycisku.
 *
 * Mapa (makieta A10/A11 dla typu `plan`, uogólniona na dowolny typ przez `statusy`):
 *  - status = ostatni w `statusy` (lub 'zamkniety') → BRAK przycisków (artefakt domknięty).
 *  - status = 'do-akceptacji' → [✅ Zatwierdź] (→ 'zaakceptowany') [💬 Odeślij z uwagami] (→ 'uwagi')
 *    (każdy przycisk tylko jeśli jego status docelowy istnieje w `statusy` typu).
 *  - każdy inny status niedomknięty → [📣 Przywołaj agenta] (bez zmiany statusu).
 */

/** Status uznawany za „domknięty" (bez akcji), niezależnie od deklaracji typu. */
export const CLOSED_STATUS = 'zamkniety';

export interface ArtifactButton {
    action: 'approve' | 'revise' | 'summon';
    statusTo: string | null;
    labelKey: string;
    summonKey: string;
    icon: string;
}

/**
 * Czy status oznacza domknięcie artefaktu (brak przycisków).
 * @param {string} status
 * @param {string[]} statusy - lista statusów typu (ostatni = domknięcie)
 * @returns {boolean}
 */
export function isClosedStatus(status: string, statusy: string[] = []): boolean {
    if (status === CLOSED_STATUS) return true;
    const list = Array.isArray(statusy) ? statusy : [];
    return list.length > 0 && status === list[list.length - 1];
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
    // Pusta lista statusów typu = nie ograniczaj (przepuść propozycje przejść).
    const allows = (s: string) => list.length === 0 || list.includes(s);

    if (status === 'do-akceptacji') {
        const buttons: ArtifactButton[] = [];
        if (allows('zaakceptowany')) {
            buttons.push({
                action: 'approve',
                statusTo: 'zaakceptowany',
                labelKey: 'artifact.btn.approve',
                summonKey: 'artifact.summon.action.approve',
                icon: '✅',
            });
        }
        if (allows('uwagi')) {
            buttons.push({
                action: 'revise',
                statusTo: 'uwagi',
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
