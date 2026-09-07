/**
 * `utils/releasePrep.ts` — czyste funkcje przygotowania wydania wyjęte z `release.js`:
 * walidacja spójności wersji, nazwa taga, normalizacja odpowiedzi z konsoli.
 *
 * Po co osobny plik: `release.js` czyta stdin, więc pod AVA nie da się go uruchomić.
 * Wszystko, co da się sprawdzić bez stdinu, mieszka tutaj.
 *
 * Nazwa i zawartość PO cięciu z 2026-09-07: do tej daty plik nazywał się
 * `releaseGithub.ts` i trzymał też budowę żądania do REST API GitHuba, listę assetów
 * i maskowanie tokena — wszystko wycięte razem z publikacją przez `release.js` (tag
 * `push` uruchamia teraz `.github/workflows/release.yml`, patrz `RELEASE_PROCESS.md`).
 * Zostało tylko to, co dotyczy PRZYGOTOWANIA wydania, stąd nowa nazwa.
 *
 * Plik jest świadomą sierotą grafu produkcyjnego — woła go wydanie, nie kod wtyczki.
 */

/** Błąd przerywający wydanie. `release.js` łapie go, drukuje `message` i robi `exit 1`. */
export class ReleaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReleaseError';
    }
}

/** Zmienna `.env` sterująca auto-deployem po KAŻDYM udanym buildzie (nie tylko wydaniowym). */
export const DEPLOY_ENV_VAR = 'DESTINATION_VAULTS';

/** Pełny semver bez prefiksu — dokładnie trzy segmenty liczbowe. */
const BARE_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Twarda walidacja spójności wersji. Skrypt SAM NICZEGO NIE BUMPUJE — bump jest
 * krokiem człowieka na branchu roboczym.
 *
 * Rozjazd `package.json.version` ↔ `manifest.json.version` → {@link ReleaseError}
 * z komunikatem cytującym OBIE wartości (żeby było widać, którą poprawić).
 */
export function assertVersionsMatch(pkgVersion: string, manifestVersion: string): void {
    if (pkgVersion === manifestVersion) return;
    throw new ReleaseError(
        `Rozjazd wersji: package.json=${pkgVersion}, manifest.json=${manifestVersion}. `
        + 'Zbumpuj obie w kroku 2 procesu wydania (albo odpal `npm run build`, ktory stempluje manifest).',
    );
}

/**
 * Nazwa taga = potwierdzona wersja, ZNAK W ZNAK, BEZ `v`.
 * To wymóg katalogu społeczności Obsidiana (workflow wydania sprawdza to jeszcze raz
 * po pushu taga — patrz `release.yml`), nie preferencja projektu.
 *
 * - `releaseTagName('2.2.0')` → `'2.2.0'`
 * - `releaseTagName('v2.2.0')` → rzuca (prefiks `v` jest błędem od 2.2.0 w górę)
 * - `releaseTagName('2.2')` → rzuca (musi być pełny semver X.Y.Z)
 */
export function releaseTagName(confirmedVersion: string): string {
    if (!BARE_SEMVER.test(confirmedVersion)) {
        throw new ReleaseError(
            `Wersja "${confirmedVersion}" nie jest golym semverem X.Y.Z. `
            + 'Katalog spolecznosci szuka wydania o tagu ROWNYM manifest.version — bez litery "v".',
        );
    }
    return confirmedVersion;
}

/**
 * Normalizacja odpowiedzi z konsoli na pytanie `Confirm release version (X.Y.Z): `.
 * Sam ENTER (pusty string / same białe znaki) → GOŁA wartość z `package.json`.
 */
export function confirmedVersionOf(rawAnswer: string, packageVersion: string): string {
    const answer = rawAnswer.trim();
    return answer.length > 0 ? answer : packageVersion;
}
