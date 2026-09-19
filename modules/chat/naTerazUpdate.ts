/**
 * Normalizacja sekcji `BrainUpdate` ("Na teraz") + jej etykieta w oknie review `/save session`.
 *
 * UTWARDZENIE KONTRAKTU, nie naprawa żywej utraty danych: `SaveSessionModal._normalizeUpdate`
 * domyślał `section` na `'## Bieżące'` - nagłówek PLIKU `brain.md`, nie klucz API
 * (`'user'` / `'environment'`). Ten fallback był w praktyce MARTWĄ gałęzią - jedyny producent
 * `BrainUpdate` to `SaveSessionWorkflow._parseNaTerazUpdates` (`modules/memory/`), który
 * iteruje literalną tablicę `['user', 'environment']`, więc `section` zawsze przychodzi jako
 * jeden z tych dwóch kluczy i fallback nigdy nie był realnie dotykany. Gdyby jednak KIEDYŚ
 * dotarła inna wartość (nowy producent, ręcznie sklejony payload), stary fallback
 * skleiłby się z UI (etykieta pokazywała „Na teraz: User" dla wszystkiego poza
 * `'environment'`), ale zapis szedłby przez `applyNaTerazOps`
 * (`modules/memory/BrainIndex.ts`), której `naTerazSectionKey('## Bieżące')` zwraca `null`
 * (nie pasuje do żadnego ze wzorców user/environment) - `if (!key) continue;` cicho odrzuciłby
 * operację, mimo że etykieta obiecywała zapis pod „User".
 *
 * Naprawa: fallback jest teraz KLUCZEM API ('user'), nie nagłówkiem pliku - `normalizeNaTerazSection`
 * i `naTerazLabel` czytają dokładnie tę samą regułę (przez `naTerazSectionKey` z barrela
 * `modules/memory`), więc etykieta i zapis nie mogą się już rozjechać, niezależnie od tego, co
 * kiedyś doda kolejny producent.
 *
 * Czysty plik (zero `obsidian`/DOM) - `SaveSessionModal.ts` ciągnie `obsidian` (Modal), ale pod
 * atrapą `obsidian` z harnessu DA SIĘ go zaimportować i skonstruować wprost w AVA (patrz
 * `modules/chat/SaveSessionModal.naTeraz.test.ts`); ta funkcja została mimo to wydzielona,
 * bo etykieta i normalizacja mają być JEDNYM miejscem prawdy, wzór
 * `modules/chat/saveSessionSectionLabel.ts`. Modal zostaje cienkim wołaczem obu funkcji.
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
