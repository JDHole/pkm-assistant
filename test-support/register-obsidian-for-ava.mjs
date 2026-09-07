/**
 * Hak rozwiązywania modułów dla AVA: bare-specyfier `obsidian` → atrapa z `test-support/obsidian.ts`.
 *
 * PO CO: pakiet `obsidian` z npm to SAME TYPY — w `node_modules/obsidian` nie ma ani jednego
 * pliku wykonywalnego. Każdy test, który (choćby pośrednio) importuje plik produkcyjny
 * dotykający `obsidian` jako WARTOŚCI, wywracał się na `ERR_MODULE_NOT_FOUND` jeszcze przed
 * pierwszą asercją. Harness (osobne repo, https://github.com/JDHole/pkm-assistant-harness) rozwiązuje to aliasem esbuilda; AVA nie ma
 * etapu builda, więc ten sam alias zakładamy hakiem ESM Node'a (`node:module` → `register`).
 *
 * KSZTAŁT: plik jest wpinany przez `ava.nodeArguments` jako `--import`, ZA `--import=tsx`.
 * Sam hak (moduł `resolve`) siedzi w `data:`-URL-u poniżej, bo hak żyje w osobnym wątku
 * i nie ma prawa importować niczego względnego — cała jego wiedza to jeden adres atrapy,
 * wstrzyknięty tu jako literał.
 *
 * Rozwiązanie ODDAJE STER dalszym hakom (`next(...)` z adresem pliku atrapy) zamiast
 * zwracać wynik z `shortCircuit` — dzięki temu transpilacja `.ts` dalej należy do `tsx`.
 */
import { register } from 'node:module';

// Testy AVA jadą w gołym Node, gdzie `window` nie istnieje, a kod pluginu sięga po timery,
// `fetch` i WebCrypto WYŁĄCZNIE przez `window` (`core/utils/hostWindow.ts`, reguły katalogu
// Obsidiana). Tu — w preloadzie testów, nie w kodzie pluginu — okno to globalny obiekt Node.
//
// KOLEJNOŚĆ JEST KRYTYCZNA — musi wykonać się PRZED jakimkolwiek (choćby pośrednim) importem
// modułu, który dotyka `core/utils/hostWindow.ts`: ten plik zamraża `typeof window` W CHWILI
// IMPORTU w stałą modułu (`export const hostWindow = typeof window !== 'undefined' ? window :
// undefined`). Statyczny `import` silnika YAML w tym pliku byłby HOISTED (ES moduły zawsze
// wykonują importy przed resztą ciała modułu, niezależnie od kolejności w tekście) — załadowałby
// `core/utils/yamlParser.ts` → `Logger.ts` → `LogFileSink.ts` → `hostWindow.ts` ZANIM linia
// niżej zdąży ustawić `window`, a zamrożone `undefined` zostałoby tak już do końca procesu
// (moduły ESM cache'ują się raz) — KAŻDY test dotykający timerów przez `hostWindow`
// (`LogFileSink`, bramka strumieniowania `ChatModel`) wywalałby się `Cannot read properties
// of undefined (reading 'setTimeout')`. Dlatego silnik jest importowany DYNAMICZNIE, PO
// ustawieniu okna — `import()` nie jest hoisted, wykonuje się dokładnie tam, gdzie stoi.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

// Silnik YAML dla WSZYSTKICH testów AVA (nie tylko tych importujących 'obsidian'): produkcyjny
// `core/utils/yamlParser.ts` NIE ma silnika, dopóki ktoś nie wywoła `setYamlEngine()` — poza
// Obsidianem robi to composition root (`src/main.ts`, tylko w harnessie) albo — dla testów
// jednostkowych, które w ogóle nie ładują `src/main.ts` — TEN preload. Import jest RELATYWNY
// do fizycznego pliku `.ts` (nie przez barrel `.js`), ale tsx rozwiązuje oba specyfiery do tego
// samego pliku na dysku, więc to wciąż JEDEN moduł ze WSPÓLNYM stanem silnika (zweryfikowane
// testem `core/utils/yamlParser.test.ts`, który woła `parseYaml`/`stringifyYaml` przez
// specyfier `.js` z barrela). Opcje dumpu = dawne js-yaml (`noRefs: true, lineWidth: 120`):
// zero zawijania długich linii, zero kotwic `&`/`*`.
const [{ setYamlEngine }, YAML] = await Promise.all([
  import('../core/utils/yamlParser.ts'),
  import('yaml'),
]);
setYamlEngine({
  parse: (text) => YAML.parse(text),
  stringify: (value) => YAML.stringify(value, { lineWidth: 0, aliasDuplicateObjects: false, indent: 2 }),
});

const MOCK_URL = new URL('./obsidian.ts', import.meta.url).href;

const hookSource = `
const MOCK_URL = ${JSON.stringify(MOCK_URL)};

export async function resolve(specifier, context, next) {
  if (specifier === 'obsidian') return next(MOCK_URL, context);
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hookSource)}`);
