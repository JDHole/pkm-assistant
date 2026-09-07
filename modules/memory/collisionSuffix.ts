/**
 * collisionSuffix.ts — AUD-testy-042.
 *
 * JEDNO źródło prawdy dla wzorca „znajdź wolną nazwę pliku przy kolizji", do 2026-09-01
 * powielonego SZEŚĆ razy w `AgentMemory.ts` jako sześć identyczne pętle (`startActiveSession`,
 * `discardActiveSession`, `saveSession`, `writeBrainNote`, `writePendingRescue`,
 * `archiveBrainNote`). Audyt testów potwierdził mutacyjnie: podniesienie progu `suffix > 50` w
 * PIĘCIU z sześciu kopii naraz (`throw` zamiast `break`, dokładnie ten błąd, jaki kiedyś miał
 * `ArchiveWorkflow.applyDedup` — patrz `ArchiveWorkflow.test.ts` „F01 runda 2") zostawiało CAŁY
 * pakiet testów (2465) zielonym — strażnik przed cichym zapisem nad cudzym plikiem nie miał
 * pokrycia strony „blokuje" dla pięciu z sześciu kopii.
 *
 * Kontrakt (K4, AUD-bledy-061): `probeFile` traktuje `'unknown'` (padnięty odczyt — dyski
 * sieciowe / Dysk Google) TAK SAMO jak `'exists'` — fail-closed, kłamiący `exists()` nie dostaje
 * szansy nadpisać cudzego pliku. Próbuje po kolei: `<dir>/<baseFilename>`, potem
 * `<dir>/<baseFilename bez .md>_2.md`, `_3.md`, ... aż `_50.md` (50 kandydatów łącznie, licząc
 * nazwę bazową). Gdy wszystkie 50 są zajęte (albo padają), RZUCA zamiast oddać zajętą nazwę
 * wołającemu — nic tego kodu nie wolno „uprościć" do przerwania pętli bez `throw`
 * (`break`/`continue`), bo wtedy wołający pisze pod nazwą, o której ta sama pętla przed chwilą
 * orzekła „zajęta".
 *
 * ⚠️ Sufiks dokleja się do GOTOWEJ nazwy pliku (`baseFilename.replace(/\.md$/, ...)`), NIE do
 * tekstu wchodzącego do ewentualnej slugifikacji U WOŁAJĄCEGO (AUD-code-review-010) — dla nazw
 * ucinanych do stałej długości sufiks dorzucony PRZED ucięciem dawał identyczną nazwę w każdej
 * iteracji, więc pętla mieliła 50 identycznych prób i rzucała już przy pierwszej kolizji.
 * Wołający MUSI więc oddać tu już gotowy `baseFilename` (po slugifikacji), nie surowy tekst.
 */
import { probeFile } from '../../core/index.js';
import type { ProbeCapableAdapter } from '../../core/index.js';

/** Wynik doboru wolnej nazwy: ostateczna ścieżka i sama nazwa pliku (bazowa albo z sufiksem). */
export interface FreeCollisionPath {
    path: string;
    filename: string;
}

/** Sufiks maksymalny (`_2`..`_50`) — 50 kandydatów łącznie z nazwą bazową. Bez zmian od zawsze. */
const MAX_SUFFIX = 50;

/**
 * Znajduje wolną (nieistniejącą wg `probeFile`) ścieżkę `<dir>/<filename>`.
 *
 * @param adapter - adapter vaulta (tylko `exists`/`read` w zakresie, jakiego potrzebuje `probeFile`)
 * @param dir - folder docelowy (bez końcowego `/`)
 * @param baseFilename - GOTOWA nazwa pliku (np. `reference_notatka.md`), już po ewentualnej slugifikacji
 * @param errorPrefix - prefiks komunikatu wyjątku po wyczerpaniu prób, np.
 *   `"writeBrainNote: brak wolnej nazwy notatki"` — do niego dokleja się ` w ${dir}`, żeby każde
 *   z sześciu miejsc zachowało DOKŁADNIE swój dawny tekst błędu (niektóre testy go asertują).
 * @throws gdy wszystkie `MAX_SUFFIX` kandydatów są zajęte (albo `probeFile` nie potrafi
 *   potwierdzić „nie ma" — fail-closed)
 */
export async function findFreeCollisionPath(
    adapter: ProbeCapableAdapter,
    dir: string,
    baseFilename: string,
    errorPrefix: string,
): Promise<FreeCollisionPath> {
    let filename = baseFilename;
    let path = `${dir}/${filename}`;
    for (let suffix = 2; (await probeFile(adapter, path)) !== 'missing'; suffix++) {
        if (suffix > MAX_SUFFIX) {
            throw new Error(`${errorPrefix} w ${dir}`);
        }
        filename = baseFilename.replace(/\.md$/, `_${suffix}.md`);
        path = `${dir}/${filename}`;
    }
    return { path, filename };
}
