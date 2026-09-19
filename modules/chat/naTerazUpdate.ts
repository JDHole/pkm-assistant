/**
 * Normalizacja sekcji `BrainUpdate` ("Na teraz") + jej etykieta w oknie review `/save session`.
 *
 * BUG-2026-09: `SaveSessionModal._normalizeUpdate` domyślał `section` na `'## Bieżące'` -
 * nagłówek PLIKU `brain.md`, nie klucz API (`'user'` / `'environment'`). Etykieta
 * (`_naTerazLabel`) i tak pokazywała taki wpis jako „Na teraz: User" (fallback = wszystko poza
 * `'environment'`), user go zatwierdzał - ale zapis szedł przez `applyNaTerazOps`
 * (`modules/memory/BrainIndex.ts`), której `naTerazSectionKey('## Bieżące')` zwraca `null`
 * (nie pasuje do żadnego ze wzorców user/environment), więc operacja była po cichu odrzucana
 * (`if (!key) continue;`). User zatwierdzał coś, co nigdy się nie zapisywało.
 *
 * Naprawa: zapis ma trafić TAM, GDZIE POKAZUJE ETYKIETA. `normalizeNaTerazSection` i
 * `naTerazLabel` czytają dokładnie tę samą regułę (przez `naTerazSectionKey` z barrela
 * `modules/memory`), więc nie mogą się już rozjechać - fallback jest kluczem API ('user'),
 * nie nagłówkiem pliku.
 *
 * Czysty plik (zero `obsidian`/DOM): `SaveSessionModal.ts` ciągnie `obsidian` (Modal), więc
 * AVA go nie zaimportuje - wzór `modules/chat/saveSessionSectionLabel.ts`. Modal zostaje
 * cienkim wołaczem obu funkcji.
 */
import { naTerazSectionKey } from '../memory/index.js';
import { t } from '../../core/i18n/index.js';

export type NaTerazSectionKey = 'user' | 'environment';

/**
 * Kanoniczny klucz API sekcji "Na teraz" dla zapisu. `naTerazSectionKey` rozpoznaje warianty
 * `'environment'` (w tym `'Środowisko'`, `'srodow'`...) - wszystko inne (brak, pusty string,
 * nagłówek pliku, nieznany tekst) trafia do `'user'`, bo to właśnie DOMYŚLNĄ etykietę
 * ("Na teraz: User") widzi user przed zatwierdzeniem.
 */
export function normalizeNaTerazSection(section: string | undefined | null): NaTerazSectionKey {
    return naTerazSectionKey(section) === 'environment' ? 'environment' : 'user';
}

/** Etykieta w oknie review - MUSI zgadzać się z {@link normalizeNaTerazSection}. */
export function naTerazLabel(section: string | undefined | null): string {
    return normalizeNaTerazSection(section) === 'environment'
        ? t('modal.save_session.na_teraz_env')
        : t('modal.save_session.na_teraz_user');
}
