/**
 * Strażnik kontraktu dostawy (audyt nocny 2026-08-21, moduł 11 - dead code i zależności).
 *
 * Pilnuje jednej rzeczy: każdy pakiet, który importuje kod PRODUKCYJNY, musi mieć
 * deklarację - albo w `dependencies` package.json, albo na liście `external` esbuilda
 * (czyli "runtime Obsidiana to dostarczy, nie pakuj tego do bundla").
 *
 * Pakiet spoza obu tych list działa dziś wyłącznie dlatego, że wpadł do node_modules
 * tranzytywnie z devDependencies. To znaczy trzy rzeczy naraz: instalacja produkcyjna
 * (`npm ci --omit=dev`) go nie ma, jego wersja jest wypadkową hoistingu zamiast decyzji,
 * a `npm audit` liczy go jako podatność devową, choć siedzi w kodzie produkcyjnym.
 *
 * Test jest CHARAKTERYZUJĄCY, nie zielony-życzeniowy: zapisuje stan faktyczny z dnia
 * pomiaru. Padnie w obie strony - gdy ktoś naprawi znany brak deklaracji (wtedy zdejmuje
 * go z listy niżej) i gdy ktoś dołoży NOWY niezadeklarowany pakiet.
 */
import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Katalogi z kodem produkcyjnym. Testy i harness są świadomie poza zakresem. */
const ZRODLA = ['src', 'core', 'modules', 'config', 'utils'];

/**
 * Stan faktyczny. Nocą 2026-08-21 (commit `962908d`) na liście był `js-yaml` — importowany
 * przez `core/utils/yamlParser.ts`, a wpadający do drzewa wyłącznie tranzytywnie. Naprawione
 * najpierw przenosinami do `dependencies`, a od TS-4 (2026-09-07) inaczej i trwalej: `js-yaml`
 * WYLECIAŁ z `package.json` w całości — `core/utils/yamlParser.ts` nie importuje ŻADNEGO
 * silnika YAML statycznie (silnik wstrzykiwany przez `setYamlEngine()`; w Obsidianie to
 * wbudowany `parseYaml`/`stringifyYaml` z modułu `obsidian`, już na liście `external`).
 * Lista jest PUSTA i ma taka zostać.
 */
const ZNANE_NIEZADEKLAROWANE: string[] = [];

function zbierzPliki(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === 'dist') continue;
            zbierzPliki(p, out);
        } else if (/\.(ts|js)$/.test(e.name) && !/\.test\.(ts|js)$/.test(e.name)) {
            out.push(p);
        }
    }
    return out;
}

/** Wycina komentarze, żeby ścieżka z JSDoc nie liczyła się jako import. */
function bezKomentarzy(txt: string): string {
    return txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Świadomie WĄSKI wzorzec: tylko `from '...'`, `import '...'`, `import('...')`,
 * `require('...')`. Wieloliniowy wildcard łapałby treść template stringów.
 */
const IMPORTY = /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

/**
 * Kształt legalnej nazwy modułu. Druga bramka po `bezKomentarzy` - odsiewa urwane
 * template stringi, które w kodzie sąsiadują z cudzysłowami i wpadają w regex.
 */
const NAZWA_MODULU = /^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/;

function nazwaPakietu(spec: string): string {
    return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

function zewnetrznePakiety(): Map<string, Set<string>> {
    const uzyte = new Map<string, Set<string>>();
    for (const katalog of ZRODLA) {
        for (const plik of zbierzPliki(path.join(ROOT, katalog))) {
            const kod = bezKomentarzy(fs.readFileSync(plik, 'utf8'));
            let m: RegExpExecArray | null;
            IMPORTY.lastIndex = 0;
            while ((m = IMPORTY.exec(kod))) {
                const spec = m[1];
                if (spec.startsWith('.') || spec.startsWith('/')) continue;
                if (!NAZWA_MODULU.test(spec)) continue;
                const nazwa = nazwaPakietu(spec);
                // Builtiny Node są dostępne zawsze - i z prefiksem `node:`, i bez niego.
                if (isBuiltin(spec) || isBuiltin(nazwa)) continue;
                if (!uzyte.has(nazwa)) uzyte.set(nazwa, new Set());
                uzyte.get(nazwa)!.add(path.relative(ROOT, plik));
            }
        }
    }
    return uzyte;
}

/** Lista `external` czytana z żywego `esbuild.js` - nie kopia, żeby nie rozjechała się po cichu. */
function externalZEsbuilda(): string[] {
    const txt = fs.readFileSync(path.join(ROOT, 'esbuild.js'), 'utf8');
    const blok = /external:\s*\[([\s\S]*?)\]/.exec(txt);
    if (!blok) return [];
    return [...blok[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
}

test('esbuild.js ma czytelną listę external (warunek pozostałych asercji)', t => {
    const external = externalZEsbuilda();
    t.true(external.length > 0, 'nie udało się odczytać listy external z esbuild.js');
    t.true(external.includes('obsidian'), 'external bez `obsidian` - wzorzec pliku się zmienił');
});

test('kod produkcyjny importuje tylko pakiety zadeklarowane w dependencies albo external', t => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
    };
    const zadeklarowane = new Set(Object.keys(pkg.dependencies || {}));
    const external = new Set(externalZEsbuilda());

    const uzyte = zewnetrznePakiety();
    t.true(uzyte.has('obsidian'), 'skaner nie widzi nawet `obsidian` - wzorzec importów się zmienił');

    const niezadeklarowane = [...uzyte.keys()]
        .filter(p => !zadeklarowane.has(p) && !external.has(p))
        .sort();

    t.deepEqual(
        niezadeklarowane,
        ZNANE_NIEZADEKLAROWANE,
        `Pakiety importowane przez kod produkcyjny bez deklaracji: ${niezadeklarowane.join(', ') || '(brak)'}. ` +
        'Doszedł nowy - zadeklaruj go w dependencies albo dopisz do external. ' +
        'Ubył - zdejmij go z ZNANE_NIEZADEKLAROWANE w tym pliku.'
    );
});
