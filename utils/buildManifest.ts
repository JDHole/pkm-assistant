/**
 * `utils/buildManifest.ts` — czyste funkcje builda wyjęte z `esbuild.js`:
 * stemplowanie manifestu wersją z `package.json`, rozbiór zmiennej deployu i
 * wyliczenie katalogu docelowego wtyczki w vaultcie.
 *
 * Po co osobny plik: `esbuild.js` jest skryptem CLI (czyta dysk, odpala esbuild),
 * więc pod AVA nie da się go uruchomić. Logika, która ma bramkę, mieszka tutaj.
 *
 * Plik jest świadomą sierotą grafu produkcyjnego — woła go build, nie kod wtyczki.
 */
import path from 'node:path';

/** Marker dla community-pluginu Hot-Reload: pusty plik zakładany przy każdym deployu. */
export const HOT_RELOAD_MARKER = '.hotreload';

/** Katalog wyjściowy builda produkcyjnego, względem roota repo. */
export const DIST_DIR_NAME = 'dist';

/**
 * Komplet instalacyjny: CI sprawdza istnienie DOKŁADNIE tych trzech plików w `dist/`;
 * katalog społeczności pobiera dokładnie te trzy z assetów wydania. Kolejność jest
 * kontraktem (deploy i lista assetów idą w tej kolejności).
 */
export const DIST_ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'] as const;

/** Podzbiór manifestu, który interesuje build. Reszta kluczy przechodzi bez zmian. */
interface ManifestShape {
    version?: unknown;
    [key: string]: unknown;
}

/**
 * Stempluje wersję z `package.json` w ŹRÓDŁOWYM `manifest.json`.
 *
 * ⚠️ NAJWAŻNIEJSZY NIEZMIENNIK CAŁEGO KLASTRA. CI robi po buildzie
 * `git diff --exit-code manifest.json versions.json`, więc serializacja musi być
 * bajt w bajt taka, jak plik zapisany w repozytorium: `JSON.stringify(m, null, 2)`
 * — wcięcie dwie spacje, końce linii LF, kolejność kluczy zachowana i BEZ znaku
 * nowej linii na końcu. Dopisanie `'\n'` albo inne wcięcie = CI czerwone przy
 * KAŻDYM buildzie.
 *
 * Kolejność kluczy zostaje, bo przypisanie do ISTNIEJĄCEGO klucza nie przenosi go
 * na koniec obiektu — a `version` w manifeście istnieje od zawsze.
 *
 * @param manifestJsonText surowa treść `manifest.json`
 * @param version wartość `package.json.version`
 * @returns nowa treść pliku; gdy wersja już się zgadza — string identyczny
 *          z tym, co dałoby ponowne stemplowanie (idempotencja).
 */
export function stampManifestVersion(manifestJsonText: string, version: string): string {
    const manifest = JSON.parse(manifestJsonText) as ManifestShape;
    manifest.version = version;
    return JSON.stringify(manifest, null, 2);
}

/**
 * Rozbiór zmiennej `DESTINATION_VAULTS` z `.env` (lista vaultów do auto-deployu
 * po każdym udanym buildzie).
 *
 * - lista rozdzielona przecinkami, każdy wpis przycięty z białych znaków;
 * - wpisy puste po przycięciu są POMIJANE (`'a,,b'` → dwa wpisy);
 * - `undefined`, `''` i `'   '` → `[]`. CI ustawia jawnie pusty string, żeby nie
 *   polegać na braku pliku `.env` — deploy ma być wtedy zerowy, bez błędu
 *   i bez ostrzeżenia.
 */
export function parseDestinationVaults(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

/**
 * Katalog docelowy deployu dla jednego vaulta:
 * `<vaultPath>/.obsidian/plugins/<pluginId>`.
 *
 * `pluginId` przychodzi z `manifest.id`, nigdy z literału w skrypcie — inaczej
 * zmiana identyfikatora wtyczki cicho rozjechałaby deploy z instalacją.
 *
 * ⚠️ Nazwa katalogu konfiguracyjnego jest tu ZAPISANA NA SZTYWNO i walidator katalogu
 * słusznie to zauważa (`Vault#configDir` pozwala ją userowi zmienić). To świadome:
 * funkcję woła build z gołego Node'a, gdzie żadnego `Vault` nie ma — a deploy celuje
 * w vault dewelopera, nie w instalację użytkownika. Zmiana wymagałaby przekazania
 * nazwy katalogu z `.env`, czego dziś nikt nie potrzebuje.
 */
export function pluginDeployDir(vaultPath: string, pluginId: string): string {
    return path.join(vaultPath, '.obsidian', 'plugins', pluginId);
}
