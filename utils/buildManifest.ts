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
// `import * as path`, nie `import path`: walidator katalogu Obsidiana jedzie własną
// konfiguracją BEZ `esModuleInterop`, więc default-import z modułu CJS jest dla niego
// typem-błędem i każde `path.join(...)` daje mu kaskadę `no-unsafe-*`. Zachowanie identyczne.
import * as path from 'node:path';

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
 * `<vaultPath>/<configDir>/plugins/<pluginId>`.
 *
 * ŻADEN z trzech członów nie jest literałem w tym pliku, i to jest cała jego treść:
 * - `pluginId` przychodzi z `manifest.id` — inaczej zmiana identyfikatora wtyczki cicho
 *   rozjechałaby deploy z instalacją;
 * - `configDir` przychodzi ze zmiennej `DESTINATION_CONFIG_DIR` z `.env` (patrz
 *   `esbuild.js`) — nazwę folderu konfiguracji ustala user vaulta docelowego i build
 *   z gołego Node'a nie ma jak jej odczytać, więc jej NIE ZGADUJE: brak zmiennej =
 *   jedno ostrzeżenie i pominięty deploy, nie strzał w domyślną nazwę.
 */
export function pluginDeployDir(vaultPath: string, configDir: string, pluginId: string): string {
    return path.join(vaultPath, configDir, 'plugins', pluginId);
}
