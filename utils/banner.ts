/**
 * `utils/banner.ts` — banner copyrightowy wstrzykiwany do `dist/main.js` przez
 * `esbuild.js` (`banner: { js: buildBanner(pkg) }`).
 *
 * Niezmienniki (pinowane przez `utils/banner.test.ts`):
 *  - wynik jest JEDNYM blokiem komentarza JS: zaczyna się `/`+`*`, kończy `*`+`/`,
 *    nie zawiera zagnieżdżonego zamknięcia komentarza w środku;
 *  - zawiera nazwę wtyczki, `pkg.version`, identyfikator licencji `GPL-3.0-or-later`,
 *    adres repozytorium ORAZ linijkę copyrightu;
 *  - jest deterministyczny — dwa wywołania z tym samym `pkg` dają identyczny string.
 *    Rok w copyrighcie jest LITERAŁEM w źródle, nie `new Date().getFullYear()`:
 *    inaczej bundle zmieniałby się z każdym Nowym Rokiem i determinizm padałby.
 *
 * Plik jest świadomą sierotą grafu produkcyjnego — woła go build, nie kod wtyczki.
 */

/**
 * Fragmenty, które MUSZĄ wystąpić w wyniku {@link buildBanner} — pinowane przez
 * `utils/banner.test.ts`.
 */
export const BANNER_REQUIRED_SUBSTRINGS = [
    'PKM Assistant',
    'GPL-3.0-or-later',
    'Copyright (c) 2026 JDHole', // rok to LITERAŁ, nie Date — inaczej bundle zmienia się
] as const;                     // z każdym Nowym Rokiem i determinizm pada

/**
 * Fragment `package.json`, którego dotyka banner builda.
 * `name` — nazwa paczki npm (`pkm-assistant`), `version` — semver bez `v`.
 */
export interface BannerPackageFacts {
    readonly name: string;
    readonly version: string;
}

/** Nazwa wtyczki tak, jak widzi ją użytkownik (zgodna z `manifest.name`). */
const PRODUCT_NAME = 'PKM Assistant';

/** Jednozdaniowy opis — po to, żeby banner mówił CO to jest, nie tylko czyje. */
const TAGLINE = 'Agenci AI mieszkajacy w Twoim vaultcie Obsidiana.';

/** Adres repozytorium — jedyny trwały wskaźnik na źródła (wymóg GPL: skąd wziąć kod). */
const REPOSITORY_URL = 'https://github.com/JDHole/pkm-assistant';

/** Linia copyrightu; rok celowo zapisany na sztywno — patrz nagłówek pliku. */
const COPYRIGHT_LINE = 'Copyright (c) 2026 JDHole';

/** Identyfikator licencji w notacji SPDX. */
const LICENSE_ID = 'GPL-3.0-or-later';

/**
 * Buduje banner copyrightowy doklejany na początek `dist/main.js`.
 *
 * Kształt wywołania (`esbuild.js`): `banner: { js: buildBanner(pkg) }`.
 */
export function buildBanner(pkg: BannerPackageFacts): string {
    const lines = [
        `${PRODUCT_NAME} ${pkg.version}`,
        TAGLINE,
        '',
        COPYRIGHT_LINE,
        `SPDX-License-Identifier: ${LICENSE_ID}`,
        '',
        `Pakiet: ${pkg.name}`,
        `Zrodla: ${REPOSITORY_URL}`,
    ];

    const body = lines.map(line => (line ? ` * ${line}` : ' *')).join('\n');
    return `/*\n${body}\n */`;
}
