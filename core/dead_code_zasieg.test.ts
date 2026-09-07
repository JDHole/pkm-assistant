/**
 * Noc 29/30.08 - strażnicy modułu 11 (dead code i zależności).
 *
 * Moduł 11 biegł ostatnio 21.08. Od tamtej pory na `origin/main` wjechało ~150 commitów
 * i +13k linii (fabryka napraw 23-27.08, fala lint-zero, fala docs), czyli CAŁY materiał,
 * z którego biorą się sieroty, powstał PO ostatnim skanie. Ten plik nie zmienia zachowania
 * pluginu - zamraża trzy wyniki nocy jako strażników i pinuje jedno znalezisko.
 *
 * Lekcja z 21.08 wbudowana w pierwszy test: graf importów BEZ dynamicznych `await import(...)`
 * kłamie o rząd wielkości (wtedy 16 „martwych" plików i wszystkie fałszywe - repo ładuje
 * modale leniwie). Dlatego skaner niżej czyta cztery kształty specyfiera, nie jeden.
 */
import test from 'ava';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Katalogi poza grafem produkcyjnym: narzędzia biegu, atrapy testowe, wynik builda. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'audyt', 'scripts', 'test-support', '.claude', 'Refaktor', 'Nauka']); // test-support: atrapa `obsidian` + shim DOM dla AVA, z definicji poza grafem produkcyjnym (harness, ktory tez ich uzywa, mieszka od 2026-09-07 w osobnym repo); .claude: worktree'y agentow (kopie repo) i skille - nie kod pluginu; Refaktor + Nauka: archiwum decyzji i materialy nauki, a zalaczone kontrakty `.ts` to specyfikacje, nie kod produkcyjny

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(full, out);
        } else {
            out.push(relative(REPO_ROOT, full));
        }
    }
    return out;
}

const ALL_FILES = walk(REPO_ROOT);
const isTest = (f: string): boolean => /\.test\.ts$/.test(f);
const PROD_TS = ALL_FILES.filter(f => /\.ts$/.test(f) && !isTest(f) && !/\.d\.ts$/.test(f));
const PROD_SET = new Set(PROD_TS);

/** Cztery kształty specyfiera: import from, gołe import, re-eksport, dynamiczny import. */
const SPECIFIER_PATTERNS: RegExp[] = [
    /(?:^|\n)\s*import\s+[^;'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+[^;'"]*from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function specifiersOf(relPath: string): string[] {
    const source = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    const found = new Set<string>();
    for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source))) found.add(match[1]);
    }
    return [...found];
}

/** Repo pisze specyfiery z rozszerzeniem `.js`, a na dysku leżą `.ts` (TS-0). */
function resolveLocal(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = join(dirname(fromFile), specifier);
    const candidates = [
        base.replace(/\.js$/, '.ts'),
        `${base}.ts`,
        base,
        join(base, 'index.ts'),
        `${base.replace(/\.js$/, '')}/index.ts`,
    ];
    for (const candidate of candidates) {
        const norm = normalize(candidate);
        if (PROD_SET.has(norm)) return norm;
    }
    return null;
}

function reachableFromMain(): Set<string> {
    const entry = normalize('src/main.ts');
    const seen = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
        const current = queue.shift() as string;
        for (const specifier of specifiersOf(current)) {
            const resolved = resolveLocal(current, specifier);
            if (resolved && !seen.has(resolved)) {
                seen.add(resolved);
                queue.push(resolved);
            }
        }
    }
    return seen;
}

/**
 * Cztery sieroty ZNANE i uzasadnione - stan zamrożony nocą 21.08 i potwierdzony 30.08.
 * Nowa pozycja na tej liście = ktoś odpiął plik od grafu i nikt tego nie zauważył.
 */
const ZNANE_SIEROTY: Record<string, string> = {
    'modules/onboarding/OnboardingModal.ts': 'wyłączony świadomie w S01 Z7, szkielet pod v3',
    'utils/releaseNotes.ts': 'notatki wydania, wołane spoza bundla (release.js)',
    'utils/releasePrep.ts': 'przygotowanie release u, wolane spoza bundla (release.js)',
    'utils/buildManifest.ts': 'helpery builda, wolane spoza bundla (esbuild.js)',
    'utils/banner.ts': 'banner builda, wołany z esbuild.js spoza bundla',
    // ── clean-room / F1: PLIKI CZEKAJĄCE NA WPIĘCIE W GRAF ─────────────────────────
    // Gałąź `cleanroom-base` postawiła kontrakt i puste implementacje; autorzy clean-room
    // wpinają je w graf plik po pliku. Ta lista ma od integracji fali 1 już tylko MALEĆ —
    // wpięty plik znika stąd tego samego dnia. Wpisy zdjęte 2026-09-06 (wpięte przez
    // autorów): `core/layoutReady.ts`, `core/runtime/{StatusBar,configMerge,
    // legacySettingsMigration}.ts`, `core/utils/settingsNamespaceMigration.ts`,
    // `modules/embedding/tokens.ts`, `modules/models/ReasoningTagFilter.ts`,
    // `config/defaultSettings.ts` (F7: `buildRuntimeConfig` naprawdę je woła).
    'core/ui/safeHtml.ts': 'czeka na wpięcie — konsumentem będzie NoticeCenter (guziki akcji)',
    'core/waitForLoaded.ts': 'czeka na PluginRuntime.whenLoaded()',
    'core/utils/httpLogSummary.ts': 'czeka na core/http — bezpieczna linia logu żądania',
    'modules/models/testing/harness.ts': 'atrapy testów klastra modeli — z definicji poza bundlem, jak `utils/release_helpers.ts`',
    'core/cleanRoomPattern.ts': 'wzorzec bramki „grep zero" — wspólny dla dwóch testów, z definicji poza bundlem',
};
/**
 * Klucze wyżej pisane są ze slashami (czytelność), a `walk()` oddaje ścieżki
 * z separatorem systemu — porównujemy więc po znormalizowanej formie.
 * `KomunikatorModal.ts` zniknął z listy 2026-09-04: plik nie istnieje od czasu
 * przepisania modułu na Komunikator v3.
 */
const ZNANE_SIEROTY_NORM = new Set(Object.keys(ZNANE_SIEROTY).map(normalize));

test('graf osiągalności z src/main.ts: żadnej NOWEJ sieroty', t => {
    const reachable = reachableFromMain();
    const orphans = PROD_TS.filter(f => !reachable.has(normalize(f))).sort();
    const nowe = orphans.filter(f => !ZNANE_SIEROTY_NORM.has(normalize(f)));

    t.deepEqual(nowe, [], `nowe pliki poza grafem: ${nowe.join(', ')}`);
    t.deepEqual(orphans.map(normalize), [...ZNANE_SIEROTY_NORM].sort());
    t.true(reachable.size > 300, `osiągalnych ${reachable.size} z ${PROD_TS.length}`);
});

/** Bare specifier -> nazwa pakietu (`@scope/pkg/sub` -> `@scope/pkg`). */
function packageOf(specifier: string): string {
    return specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
}

const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};
const DECLARED = new Set([
    ...Object.keys(PKG.dependencies ?? {}),
    ...Object.keys(PKG.devDependencies ?? {}),
]);

/** Wbudowane w Node - nie są niczyją zależnością. */
const NODE_BUILTINS = new Set([
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'child_process', 'events',
    'stream', 'zlib', 'buffer', 'readline', 'assert', 'net', 'tls', 'worker_threads',
    'perf_hooks', 'timers', 'process', 'string_decoder', 'module', 'v8', 'dns',
]);

/** Lista `external` z esbuild.js - te pakiety daje runtime Obsidiana, nie npm. */
function esbuildExternals(): Set<string> {
    const source = readFileSync(join(REPO_ROOT, 'esbuild.js'), 'utf8');
    const block = /external:\s*\[([\s\S]*?)\]/.exec(source);
    if (!block) return new Set();
    return new Set([...block[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]));
}

test('każdy pakiet importowany przez kod produkcyjny jest zadeklarowany albo external', t => {
    const externals = esbuildExternals();
    const nieznane: string[] = [];

    for (const file of PROD_TS) {
        for (const specifier of specifiersOf(file)) {
            if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
            const name = packageOf(specifier).replace(/^node:/, '');
            if (NODE_BUILTINS.has(name) || DECLARED.has(name) || externals.has(name)) continue;
            nieznane.push(`${file} -> ${name}`);
        }
    }

    t.deepEqual(nieznane, [], `import bez pokrycia w package.json ani w external: ${nieznane.join('; ')}`);
    // 2026-09-04: `electron` zszedł z listy external razem z `copy_to_clipboard`, jego jedynym
    // konsumentem (AUD-dead-code-002/101/157). Zostaje `obsidian` — jedyny nie-builtin, który
    // MUSI być external; gdyby wypadł, bundle wciągnąłby runtime hosta.
    t.true(externals.has('obsidian'));
});

test('zero martwych zależności: każda zadeklarowana ma ślad poza package.json', t => {
    const haystack = ALL_FILES
        .filter(f => /\.(ts|js|mjs|cjs|json)$/.test(f))
        .filter(f => f !== 'package.json' && f !== 'package-lock.json');
    const corpus = haystack.map(f => readFileSync(join(REPO_ROOT, f), 'utf8')).join('\n');

    // Pin wersji w `overrides` (dedup drzewa, AUD-wydajnosc-004/039) to ŚWIADOMY ślad,
    // choć żaden plik pakietu nie importuje — stąd `ajv` w `dependencies` bez ani jednego importu.
    const PINY = new Set(Object.keys((PKG as { overrides?: Record<string, unknown> }).overrides ?? {}));
    const martwe = [...DECLARED].filter(dep => !PINY.has(dep) && !corpus.includes(dep)).sort();
    // To jest strażnik klasy `swagger-jsdoc` (martwa devDep z 21.08, wycięta 28.08):
    // pakiet w package.json, którego nikt nie importuje ani nie konfiguruje.
    t.deepEqual(martwe, [], `zadeklarowane, bez ani jednego śladu w repo: ${martwe.join(', ')}`);
});

/* ── kontrakt klas CSS po fali lint-zero (27.08) ────────────────────────────── */

const CSS_FILES = ALL_FILES.filter(f => /\.css$/.test(f));
/** Własne prefiksy. Klasy Obsidiana (`mod-cta`, `setting-item`) mają regułę w JEGO arkuszu. */
const NASZ_PREFIKS = /^(pkm-|cs-)/;

function klasyZdefiniowaneWCss(): Map<string, string[]> {
    const defined = new Map<string, string[]>();
    for (const file of CSS_FILES) {
        const source = readFileSync(join(REPO_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const match of source.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) {
            const list = defined.get(match[1]) ?? [];
            if (!list.includes(file)) list.push(file);
            defined.set(match[1], list);
        }
    }
    return defined;
}

/** Klasy PRZEŁĄCZANE warunkowo - tylko one mogą być „przełącznikiem bez skutku". */
function klasyPrzelaczaneWTs(): Map<string, string[]> {
    const toggled = new Map<string, string[]>();
    const patterns = [
        /(?:toggleClass|removeClass)\s*\(\s*['"]([^'"$]+)['"]/g,
        /classList\.(?:toggle|remove)\s*\(\s*['"]([^'"$]+)['"]/g,
    ];
    for (const file of PROD_TS) {
        const source = readFileSync(join(REPO_ROOT, file), 'utf8');
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(source))) {
                for (const cls of match[1].split(/\s+/).filter(Boolean)) {
                    const list = toggled.get(cls) ?? [];
                    if (!list.includes(file)) list.push(file);
                    toggled.set(cls, list);
                }
            }
        }
    }
    return toggled;
}

/**
 * Fala lint-zero z 27.08 przepisała `style.display` na klasy w kilkunastu plikach UI.
 * Ta zamiana pęka po cichu wtedy, gdy klasa NIE MA reguły: gałąź „schowaj/pokaż" wykonuje
 * się, nic się nie dzieje, a żaden typecheck, lint ani test tego nie widzi.
 * Moduł 20 sprawdził 28.08 trzy takie miejsca ręcznie - ten test sprawdza WSZYSTKIE.
 */
test('żadna warunkowo przełączana klasa własnego prefiksu nie jest przełącznikiem bez skutku', t => {
    const defined = klasyZdefiniowaneWCss();
    const toggled = klasyPrzelaczaneWTs();

    const bezSkutku = [...toggled.entries()]
        .filter(([cls]) => NASZ_PREFIKS.test(cls))
        .filter(([cls]) => !defined.has(cls))
        .map(([cls, files]) => `.${cls} (${files.join(', ')})`)
        .sort();

    t.deepEqual(bezSkutku, [], `przełączane, bez reguły w żadnym arkuszu: ${bezSkutku.join('; ')}`);
    t.true([...toggled.keys()].filter(c => NASZ_PREFIKS.test(c)).length >= 10);
});

/**
 * PIN (znalezisko nocy 29/30.08). Picker ma w CSS DWA słowniki: `__option*` - ten renderuje
 * kod (`modules/agents/profile/profile_team.ts`) i on jest ostylowany - oraz `__row*`, którego
 * nie ustawia ani jeden plik w repo. To sierota po starszym kształcie komponentu; nic się
 * dziś przez nią nie psuje, ale arkusz opisuje UI, którego nie ma.
 * STAN 2026-09-04: reguły zdjęte (kampania dead-code) — pin zszedł z `.failing`
 * na zwykły test i pilnuje od teraz, żeby martwy słownik nie wrócił.
 */
test('rodzina .cs-picker__row* nie ma ani jednego ustawiającego (martwe reguły)', t => {
    const defined = klasyZdefiniowaneWCss();
    const kodTs = PROD_TS.map(f => readFileSync(join(REPO_ROOT, f), 'utf8')).join('\n');

    const osierocone = [...defined.keys()]
        .filter(cls => cls.startsWith('cs-picker__row'))
        .filter(cls => !new RegExp(`['"\`\\s]${cls}['"\`\\s]`).test(kodTs))
        .sort();

    t.deepEqual(osierocone, [], `reguły bez ustawiającego: ${osierocone.join(', ')}`);
});
