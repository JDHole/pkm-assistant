/**
 * F2.17 (2026-09-04) — strażnik nazw komend przed zgłoszeniem do katalogu społeczności.
 *
 * Wytyczne Obsidiana (https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) mówią
 * wprost: nazwa komendy NIE powtarza nazwy pluginu, bo paleta dokleja ją sama — inaczej user
 * widzi „PKM Assistant: PKM Assistant: Otwórz czat".
 *
 * Pilnujemy dwóch stron tej samej reguły, bo każda potrafi się zepsuć osobno:
 *   1. WARTOŚCI kluczy `command.*` w obu słownikach (tłumacz może „pomóc" i dokleić markę),
 *   2. ŹRÓDŁO `src/main.ts` — twardy literał z prefiksem obok `addCommand`/`addRibbonIcon`
 *      omija słowniki w całości (tak żył tooltip ikony czatu do F2.19).
 *
 * ⚠️ Ikony wstążki są celowo POZA regułą 1: `main.agent_sidebar` i `main.ribbon_chat` NIOSĄ
 * prefiks „PKM Assistant: " świadomie (decyzja C2). Wstążka, w odróżnieniu od palety, nie
 * dokleja nazwy pluginu sama, a tooltip jest jedyną etykietą ikony.
 */
import test from 'ava';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pl } from './pl.js';
import { en } from './en.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PLUGIN_NAME = 'PKM Assistant';
const DICTIONARIES: [string, Record<string, string>][] = [['pl', pl], ['en', en]];

/** Same komendy — klucze `command.*`, których wartość jest zwykłym stringiem. */
function commandEntries(dict: Record<string, string>): [string, string][] {
    return Object.entries(dict)
        .filter(([key, value]) => key.startsWith('command.') && typeof value === 'string');
}

for (const [locale, dict] of DICTIONARIES) {
    test(`${locale}: żadna nazwa komendy nie zawiera nazwy pluginu (F2.17)`, t => {
        const entries = commandEntries(dict);
        t.true(entries.length > 0, `brak kluczy command.* w słowniku ${locale} — strażnik mierzyłby pustkę`);

        const offenders = entries
            .filter(([, value]) => value.toLowerCase().includes(PLUGIN_NAME.toLowerCase()))
            .map(([key, value]) => `${key} = "${value}"`);

        t.deepEqual(offenders, [],
            'paleta komend dokleja nazwę pluginu sama — w wartości klucza jej być nie może');
    });

    test(`${locale}: nazwa komendy nie zaczyna się od prefiksu z dwukropkiem (F2.17)`, t => {
        const offenders = commandEntries(dict)
            // „Otwórz czat: historia" jest OK — chodzi o PREFIKS marki na początku nazwy.
            .filter(([, value]) => /^\s*(pkm|pkm assistant|obsek)\s*:/i.test(value))
            .map(([key, value]) => `${key} = "${value}"`);

        t.deepEqual(offenders, [],
            'nazwa komendy ma opisywać akcję, nie podpisywać się marką pluginu');
    });
}

test('pl i en mają DOKŁADNIE ten sam zestaw kluczy command.* (F2.17)', t => {
    const keysPl = commandEntries(pl).map(([key]) => key).sort();
    const keysEn = commandEntries(en).map(([key]) => key).sort();
    t.deepEqual(keysPl, keysEn,
        'komenda obecna w jednym języku, a nie w drugim, pokazuje userowi surowy klucz');
});

test('src/main.ts nie wkłada nazwy pluginu w addCommand/addRibbonIcon (F2.17)', t => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'main.ts'), 'utf8');
    // Komentarze opisują historię i cytują wytyczne — pilnujemy KODU, nie opisów.
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    t.notRegex(code, new RegExp(`["'\`]${PLUGIN_NAME}:\\s`),
        'twardy literał "PKM Assistant: " w composition root omija słowniki i nie tłumaczy się nigdy');

    // Nazwy komend i tooltipy wstążki mają iść przez i18n, nie przez gołe stringi.
    const commandNames = [...code.matchAll(/\bname:\s*(['"`])([^'"`\n]*)\1/g)].map(m => m[2]);
    const branded = commandNames.filter(value => value.toLowerCase().includes(PLUGIN_NAME.toLowerCase()));
    t.deepEqual(branded, [], 'nazwa komendy w źródle nie może nieść marki pluginu');
});

/**
 * F2.16: Obsidian zapamiętuje nazwę komendy w chwili `addCommand`, więc rejestracja MUSI iść
 * po `setLocale()`. Wcześniej `registerCommands()` stało w `onload()`, a `setLocale()`
 * w `initialize()` — paleta była po angielsku nawet przy `language: 'pl'`.
 *
 * ⚠️ Aktualizacja po review W5-01/W5-04 (2026-09-04): F2.16 rozwiązało to przenosząc REJESTRACJĘ
 * do `initialize()` — i tym samym uzależniło paletę komend oraz wstążkę od udanego bootu
 * środowiska. Dziś jest odwrotnie: rejestracja wróciła do `onload()`, a przed nią stoi
 * `setLocale()` z taniego odczytu `.pkm-assistant/settings.json` (`read_ui_language()`).
 * Ten strażnik pilnuje tego, co się NIE zmieniło — kolejności — a to, że rejestracja siedzi
 * w `onload()`, pilnują strażnicy w `src/main.test.ts`.
 */
test('src/main.ts rejestruje komendy i wstążkę PO setLocale (F2.16)', t => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'main.ts'), 'utf8');
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    const locale = code.indexOf('setLocale(');
    const commands = code.indexOf('this.registerCommands()');
    const ribbon = code.indexOf('this.registerRibbonIcons()');

    t.true(locale > 0, 'nie znalazłem wywołania setLocale w src/main.ts');
    t.true(commands > 0, 'nie znalazłem wywołania registerCommands — komendy muszą się rejestrować');
    t.true(ribbon > 0, 'nie znalazłem wywołania registerRibbonIcons');

    t.true(commands > locale,
        'registerCommands PRZED setLocale = paleta komend zawsze po angielsku (F2.16)');
    t.true(ribbon > locale,
        'registerRibbonIcons PRZED setLocale = tooltipy ikon zawsze po angielsku (F2.16)');
});
