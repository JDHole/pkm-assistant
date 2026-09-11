/**
 * Lokator atrapy `obsidian` dla AVA (od 2026-09-11 — patrz `CLAUDE.md` sekcja test-support).
 *
 * PO CO: atrapa modułu `obsidian`, shim DOM i preload AVA właściwy (ten, co kiedyś stał tutaj)
 * przeprowadziły się do osobnego repo, `pkm-assistant-harness` — walidator katalogu Obsidiana
 * lintuje CAŁE to repo (repo pluginu) i flagował w atrapie rzeczy, których atrapa z definicji
 * potrzebuje (`globalThis`, gołe timery, `createEl('div')`). Ten plik zostaje pod TĄ SAMĄ
 * ścieżką (`package.json`'s `ava.nodeArguments` go nie zmienia) i robi jedną rzecz: znajduje
 * checkout harnessu na dysku i oddaje mu ster.
 *
 * PL: Jeśli ten plik rzuca — sklonuj https://github.com/JDHole/pkm-assistant-harness obok
 * katalogu tego pluginu (albo ustaw zmienną środowiskową PKM_ASSISTANT_HARNESS na jego ścieżkę).
 * EN: If this file throws — clone https://github.com/JDHole/pkm-assistant-harness next to this
 * plugin's directory (or point the PKM_ASSISTANT_HARNESS environment variable at its path).
 *
 * KOLEJNOŚĆ SZUKANIA harnessu:
 *   1. `PKM_ASSISTANT_HARNESS` (jawne wskazanie — tak może zrobić agent albo CI),
 *   2. `<korzeń pluginu>/.harness-ci` (tak stawia go CI tego repo: checkout osobnego repo do
 *      podkatalogu PRZED `npm test`, patrz `.github/workflows/ci.yml`),
 *   3. dla KAŻDEGO przodka korzenia pluginu (od rodzica w górę do systemowego roota):
 *      `<przodek>/pkm-assistant-harness` — dla zwykłego klona to `Desktop/pkm-assistant-harness`
 *      obok `Desktop/PKM Assistant`; dla worktree'a agenta (`.claude/worktrees/<x>`) przodkiem
 *      jest w końcu ten sam `Desktop`, więc trafia na ten sam checkout.
 * Kandydat liczy się, gdy ma `test-support/register-obsidian-for-ava.mjs` — plik, który
 * przejmuje robotę od tego miejsca.
 */
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Korzeń TEGO pluginu: katalog nad `test-support/`, gdziekolwiek fizycznie leży ten plik. */
const KORZEN_PLUGINU = dirname(dirname(fileURLToPath(import.meta.url)));

/** Plik, po którym poznajemy checkout harnessu — przejmuje robotę od tego lokatora. */
const WLASCIWY_PRELOAD = join('test-support', 'register-obsidian-for-ava.mjs');

function wygladaNaHarness(kandydat) {
  return existsSync(join(kandydat, WLASCIWY_PRELOAD));
}

/** Kandydaci w kolejności z nagłówka. Zwraca pierwszy trafiony albo `null`. */
function znajdzHarness() {
  const zEnv = process.env.PKM_ASSISTANT_HARNESS;
  if (zEnv && zEnv.trim() !== '') {
    const kandydat = resolve(zEnv.trim());
    if (wygladaNaHarness(kandydat)) return kandydat;
  }

  const wHarnessCi = join(KORZEN_PLUGINU, '.harness-ci');
  if (wygladaNaHarness(wHarnessCi)) return wHarnessCi;

  let przodek = dirname(KORZEN_PLUGINU);
  for (;;) {
    const kandydat = join(przodek, 'pkm-assistant-harness');
    if (wygladaNaHarness(kandydat)) return kandydat;
    const wyzej = dirname(przodek);
    if (wyzej === przodek) break;
    przodek = wyzej;
  }

  return null;
}

const KORZEN_HARNESSU = znajdzHarness();

if (!KORZEN_HARNESSU) {
  throw new Error(
    '[test-support] Nie znalazłem repo harnessu (pkm-assistant-harness).\n'
    + 'PL: Sklonuj https://github.com/JDHole/pkm-assistant-harness obok katalogu tego pluginu\n'
    + '    (albo ustaw PKM_ASSISTANT_HARNESS=<ścieżka do jego checkoutu>).\n'
    + 'EN: Clone https://github.com/JDHole/pkm-assistant-harness next to this plugin directory\n'
    + '    (or set PKM_ASSISTANT_HARNESS=<path to that checkout>).',
  );
}

// PKM_ASSISTANT_ROOT: ten sam kontrakt, którego harness już oczekuje od CI (`lib/pluginRoot.ts`
// w repo harnessu) — `??=` zamiast nadpisania na sztywno, żeby wywołanie spod harnessu (który
// sam ustawia tę zmienną na SWÓJ wybrany checkout pluginu) miało pierwszeństwo.
process.env.PKM_ASSISTANT_ROOT ??= KORZEN_PLUGINU;
// PKM_TEST_SUPPORT_DIR: jedyne miejsce, w którym testy pluginu (np.
// `modules/tools/GenerateImageTool.test.ts`) mają prawo szukać atrapy `obsidian.ts` fizycznie —
// ten katalog leży w repo harnessu, nie w tym repo.
process.env.PKM_TEST_SUPPORT_DIR = join(KORZEN_HARNESSU, 'test-support');

// Ostatni krok: przekazanie steru właściwemu preloadowi w harnessie. `import(<ścieżka
// wyliczona w runtime>)` jest dla `no-unsanitized/method` (walidator katalogu Obsidiana,
// `npm run lint:obsidian`) nie do odróżnienia od wstrzyknięcia kodu — reguła wymaga LITERAŁU
// wprost w wywołaniu (sam back-tracing do stałej `const` jej nie wystarcza — sprawdzone
// empirycznie). Ten sam problem (cel importu znany dopiero w runtime) rozwiązuje już hak niżej
// w harnessie dla specyfiera `obsidian`: hak `resolve` ESM Node'a (`node:module` → `register`)
// przekierowuje STATYCZNY, literałowy specyfier na wyliczoną ścieżkę przez `next(url, context)`
// — `register()` sam nie jest sprawdzanym „sinkiem" reguły, więc dowolność jego argumentu jest
// dla niej niewidoczna. Robimy to samo dla WŁASNEGO celu: literał `'pkm-assistant-harness:…'`
// w wywołaniu `import(...)` na samym dole MUSI zostać wpisany wprost (patrz tam) — ta stała
// (`PRELOAD_SPECIFIER`) służy tylko do zbudowania haka, żeby oba miejsca nie mogły się rozjechać.
const PRELOAD_SPECIFIER = 'pkm-assistant-harness:test-support-preload';
const PRELOAD_URL = pathToFileURL(join(KORZEN_HARNESSU, WLASCIWY_PRELOAD)).href;
const hookSource = `
const PRELOAD_URL = ${JSON.stringify(PRELOAD_URL)};

export async function resolve(specifier, context, next) {
  if (specifier === ${JSON.stringify(PRELOAD_SPECIFIER)}) return next(PRELOAD_URL, context);
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hookSource)}`);

// LITERAŁ WPROST (patrz komentarz wyżej) — musi być identyczny z `PRELOAD_SPECIFIER` powyżej.
await import('pkm-assistant-harness:test-support-preload');
