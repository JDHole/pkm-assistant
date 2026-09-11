// `esbuild.js` — build produkcyjny wtyczki.
//
//   node esbuild.js            (`npm run build`) — jeden przebieg i koniec
//   node esbuild.js --watch    (`npm run dev`)   — watcher zostaje żywy
//
// Skrypt jest rootowym plikiem `.js` uruchamianym wprost przez Node, dlatego helpery
// importuje z rozszerzeniem `.ts`: Node >=22.18 strippuje typy z plików uruchamianych
// wprost, ale NIE przepisuje specyfierów — `'./x.js'` przy pliku `x.ts` na dysku kończy
// się `ERR_MODULE_NOT_FOUND`. To jedyny sankcjonowany wyjątek od reguły „specyfiery
// zawsze z `.js`" obowiązującej w kodzie wtyczki.
//
// Kolejność kroków jest kontraktem: NAJPIERW stemplujemy źródłowy `manifest.json`
// wersją z `package.json`, dopiero potem kopiujemy go do `dist/`. Odwrotna kolejność
// dałaby `dist/manifest.json` zgodny z `package.json` i źródłowy manifest w rozjeździe,
// czyli dokładnie ten fałszywy zielony, który łapie w CI `git diff --exit-code`.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { buildBanner } from './utils/banner.ts';
import {
    DIST_ARTIFACTS,
    DIST_DIR_NAME,
    HOT_RELOAD_MARKER,
    parseDestinationVaults,
    pluginDeployDir,
    stampManifestVersion,
} from './utils/buildManifest.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT, DIST_DIR_NAME);
const ENTRY_POINT = path.join(ROOT, 'src', 'main.ts');
const STYLESHEET = path.join(ROOT, 'src', 'styles.css');
const MANIFEST_FILE = path.join(ROOT, 'manifest.json');

// `.env` wczytuje sam Node (`process.loadEnvFile`, od 20.12) — bez pakietu `dotenv`, który walidator
// katalogu wytyka jako zbędną zależność. Zmienne już obecne w środowisku mają pierwszeństwo
// (tak jak dotąd); brak pliku = brak deployu do vaultów, nic więcej.
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const watchMode = process.argv.includes('--watch');

/** Czyta plik JSON z roota repo i oddaje go jako zwykły obiekt. */
function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Wpisuje wersję z `package.json` do ŹRÓDŁOWEGO `manifest.json`.
 *
 * Zapis leci tylko przy realnej różnicy — build nie ma prawa brudzić drzewa
 * (`git diff --exit-code manifest.json versions.json` w CI). Serializacja
 * z `stampManifestVersion` jest zawsze na LF; przy zapisie oddajemy plikowi
 * końce linii, z jakimi leżał na dysku, żeby build nie przestawiał checkoutu
 * pod Windowsem (repo trzyma LF, checkout bywa CRLF — patrz `.gitattributes`).
 */
function stampSourceManifest(version) {
    const before = fs.readFileSync(MANIFEST_FILE, 'utf8');
    const stamped = stampManifestVersion(before, version);
    const after = before.includes('\r\n') ? stamped.replace(/\n/g, '\r\n') : stamped;
    if (after !== before) {
        fs.writeFileSync(MANIFEST_FILE, after, 'utf8');
        console.log(`[build] manifest.json ostemplowany wersja ${version}`);
    }
}

/**
 * Wspólna fabryka pluginów „plik tekstowy jako moduł JS".
 *
 * Kod wtyczki importuje arkusze i notatki atrybutem (`with { type: 'css' }`,
 * `with { type: 'markdown' }`), a deklaracje `*.css` / `*.md` mówią `tsc`, co
 * z takiego importu wypada. Tu domykamy to po stronie builda: plik wjeżdża do
 * bundla jako moduł JS, a jego treść jest osadzana przez `JSON.stringify`,
 * nie wklejana w szablon — inaczej apostrof albo backtick w tekście wysadziłby bundle.
 */
function textImportPlugin({ name, filter, attribute, toModule }) {
    const namespace = `${name}-tresc`;
    return {
        name,
        setup(build) {
            build.onResolve({ filter }, args => {
                const declared = args.with?.type;
                if (declared && declared !== attribute) return null;
                return { path: path.resolve(args.resolveDir, args.path), namespace };
            });
            build.onLoad({ filter: /.*/, namespace }, async args => {
                // Końce linii zawsze LF: przy `core.autocrlf=true` checkout na Windows daje CRLF,
                // a osadzony tekst trafia do bundla bajt w bajt — bez normalizacji main.js z laptopa
                // różnił się od main.js z CI (walidator katalogu: build nie zgadza się z assetem).
                const raw = (await fs.promises.readFile(args.path, 'utf8')).replace(/\r\n?/g, '\n');
                return { contents: toModule(raw), loader: 'js', watchFiles: [args.path] };
            });
        },
    };
}

/** Import arkusza z atrybutem `with { type: 'css' }` → gotowy `CSSStyleSheet`. */
const cssImportPlugin = textImportPlugin({
    name: 'import-css',
    filter: /\.css$/,
    attribute: 'css',
    toModule: css => [
        'const sheet = new CSSStyleSheet();',
        `sheet.replaceSync(${JSON.stringify(css)});`,
        'export default sheet;',
    ].join('\n'),
});

/** Import notatki z atrybutem `with { type: 'markdown' }` → string z treścią pliku. */
const markdownImportPlugin = textImportPlugin({
    name: 'import-markdown',
    filter: /\.md$/,
    attribute: 'markdown',
    toModule: markdown => `export default ${JSON.stringify(markdown)};\n`,
});

/** Kopiuje do `dist/` te dwa artefakty, których esbuild nie generuje sam. */
function copyStaticArtifacts() {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.copyFileSync(MANIFEST_FILE, path.join(DIST_DIR, 'manifest.json'));
    fs.copyFileSync(STYLESHEET, path.join(DIST_DIR, 'styles.css'));
}

/**
 * Wdrożenie świeżego builda do vaultów deweloperskich wskazanych przez `.env`.
 *
 * Brak `DESTINATION_VAULTS` albo pusta wartość = zero deployów, zero błędów, zero ostrzeżeń
 * (CI ustawia ją jawnie na pusty string, żeby nie polegać na braku pliku `.env`).
 * Błąd kopiowania do jednego vaulta nie wywraca builda — to wygoda dewelopera,
 * nie artefakt wydania.
 *
 * `DESTINATION_CONFIG_DIR` to nazwa folderu konfiguracji Obsidiana w vaultach docelowych.
 * Build z gołego Node'a nie ma `Vault#configDir`, a user może ten folder przemianować, więc
 * nazwy NIE ZGADUJEMY: gdy vaulty są podane, a ta zmienna nie, leci jedno ostrzeżenie
 * i deploy jest pomijany. Sam build kończy się sukcesem — deploy to wygoda, nie artefakt.
 */
function deployToVaults(pluginId) {
    const vaults = parseDestinationVaults(process.env.DESTINATION_VAULTS);
    if (vaults.length === 0) return;

    const configDir = (process.env.DESTINATION_CONFIG_DIR ?? '').trim();
    if (!configDir) {
        console.warn('[build] pomijam deploy do vaultow: DESTINATION_VAULTS jest ustawione, a DESTINATION_CONFIG_DIR nie - podaj nazwe folderu konfiguracji Obsidiana w vaultach docelowych (patrz .env.example)');
        return;
    }

    for (const vault of vaults) {
        const target = pluginDeployDir(vault, configDir, pluginId, path.join);
        try {
            fs.mkdirSync(target, { recursive: true });
            for (const artifact of DIST_ARTIFACTS) {
                fs.copyFileSync(path.join(DIST_DIR, artifact), path.join(target, artifact));
            }
            // Pusty marker dla wtyczki Hot-Reload: podmieniony build wstaje bez restartu Obsidiana.
            fs.writeFileSync(path.join(target, HOT_RELOAD_MARKER), '', 'utf8');
            console.log(`[build] wdrozono do ${target}`);
        } catch (err) {
            console.warn(`[build] nie udalo sie wdrozyc do ${target}: ${err?.message ?? err}`);
        }
    }
}

/**
 * Jedno miejsce, w którym kończy się KAŻDY przebieg — jednorazowy i każdy rebuild
 * watchera. Dzięki temu logika kopiowania i wdrożenia nie jest zdublowana.
 */
function finishBuildPlugin(pluginId) {
    return {
        name: 'artefakty-i-deploy',
        setup(build) {
            build.onEnd(result => {
                if (result.errors.length > 0) return;
                copyStaticArtifacts();
                deployToVaults(pluginId);
            });
        },
    };
}

async function main() {
    const pkg = readJson(path.join(ROOT, 'package.json'));
    stampSourceManifest(pkg.version);
    const manifest = readJson(MANIFEST_FILE);

    const ctx = await esbuild.context({
        entryPoints: [ENTRY_POINT],
        outfile: path.join(DIST_DIR, 'main.js'),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'es2022',
        charset: 'utf8',
        minify: true,
        keepNames: true,
        sourcemap: false,
        treeShaking: true,
        logLevel: 'info',
        banner: { js: buildBanner(pkg) },
        // Runtime hosta, nie paczka z npm — musi zostac poza bundlem, inaczej wciagnelibysmy
        // caly Obsidian. Lista jest LITERALEM czytanym regexem przez trzech niezaleznych
        // straznikow (core/deps_kontrakt, core/dead_code_zasieg, build_kontrakt) — nie sklejaj
        // jej ze zmiennych. `electron` NIE WRACA (zszedl ze swoim jedynym konsumentem).
        external: ['obsidian'],
        plugins: [cssImportPlugin, markdownImportPlugin, finishBuildPlugin(manifest.id)],
    });

    if (watchMode) {
        await ctx.watch();
        console.log('[build] watch: czekam na zmiany (Ctrl+C konczy)');
        return;
    }

    await ctx.rebuild();
    await ctx.dispose();

    const bytes = fs.statSync(path.join(DIST_DIR, 'main.js')).size;
    console.log(`[build] gotowe: dist/main.js (${bytes.toLocaleString('pl-PL')} B) + manifest.json + styles.css`);
}

main().catch(err => {
    // esbuild sam wypisal juz diagnostyke (logLevel), tu zostaje tylko czytelny werdykt.
    console.error(`[build] BLAD: ${err?.message ?? err}`);
    process.exit(1);
});
