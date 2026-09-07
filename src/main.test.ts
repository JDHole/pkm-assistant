/**
 * Strażnik po źródle dla `sendInlineComment` (AUD-code-review-036).
 *
 * `src/main.ts` importuje `obsidian` na samej górze (composition root), więc AVA go nie
 * zaimportuje — ten sam wzór, co `modules/chat/chat/stopSemantics.test.ts`: czytamy ŹRÓDŁO
 * regexami zamiast wywoływać kod.
 *
 * Wtopa: `sendInlineComment` odmierzała gotowość widoku czatu GOŁYM `setTimeout(300)` —
 * dokładnie ta sama klasa błędu, którą naprawiono w budziku updatera (AUD-bledy-036/060;
 * sam updater wycięty 2026-09-04 przed katalogiem — D1): wyłączenie pluginu w oknie budzika
 * strzelało na zdemontowanym egzemplarzu. Naprawa: budzik idzie przez
 * `this.registerInterval(...)` + guard na `chatView.input_area`/`send_message`, bo widok czatu może
 * jeszcze się budować (plugin nie jest `_ready`), a bez guardu callback rzucał `TypeError`
 * bez żadnego `try/catch` dookoła.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
// `t` jest w tym pliku zajęte przez kontekst wykonania AVA — stąd alias.
import { t as translate, setLocale } from '../core/i18n/index.js';
import { pl } from '../core/i18n/pl.js';
import { en } from '../core/i18n/en.js';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Kod bez komentarzy — strażnik pilnuje WYWOŁAŃ, nie opisów historii. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Ciało metody klasy od `<name>(...) {` do domykającego `\n  }` na tym samym poziomie wcięcia. */
function methodBody(src: string, name: string): string {
    const head = new RegExp(`\\n  (?:async )?${name}\\([^)]*\\)[^{]*\\{`).exec(src);
    if (!head) return '';
    const rest = src.slice(head.index + head[0].length);
    const to = rest.indexOf('\n  }');
    return stripComments(to < 0 ? rest : rest.slice(0, to));
}

const source = readSource('./main.ts');

test('sendInlineComment: budzik idzie przez registerInterval, nie goły setTimeout (AUD-code-review-036)', t => {
    const body = methodBody(source, 'sendInlineComment');
    t.true(body.length > 0, 'nie znalazłem sendInlineComment w src/main.ts');
    // `window.` dopuszczone od 2026-09-04 (wytyczna katalogu `prefer-window-timers`:
    // budziki mają iść przez `window`, żeby działały w oknach wypiętych z głównego).
    // Istotne dla tego strażnika jest OPAKOWANIE w registerInterval, nie przedrostek.
    t.regex(body, /this\.registerInterval\((?:window\.)?setTimeout\(/,
        'goły setTimeout bez registerInterval przeżywa unload i strzela na zdemontowanym egzemplarzu');
});

test('sendInlineComment: guard na widoku czatu przed dotknięciem input_area/send_message (AUD-code-review-036)', t => {
    const body = methodBody(source, 'sendInlineComment');
    t.regex(body, /!chatView\?\.input_area/,
        'bez guardu na input_area callback rzuca TypeError, gdy widok czatu jeszcze się buduje');
    t.regex(body, /typeof chatView\.send_message !== 'function'/,
        'guard musi sprawdzić też send_message, nie tylko input_area');
});

/**
 * D1 (2026-09-04): updater wycięty przed zgłoszeniem do katalogu społeczności. Katalog zabrania
 * mechanizmów aktualizujących plugin, a samo odpytywanie `api.github.com` co 3 h było jedynym
 * ruchem sieciowym pluginu, którego nie zaczął user. Ten strażnik pilnuje, żeby nie wrócił.
 */
test('updater nie wraca: zero odwołań do api.github.com i check_for_update (D1)', t => {
    const code = stripComments(source);
    t.notRegex(code, /api\.github\.com/, 'plugin nie ma prawa odpytywać GitHuba o wersje — katalog i BRAT aktualizują same');
    t.notRegex(code, /check_for_update\b/, 'metoda updatera wycięta w D1 — nie przywracamy jej');
    t.notRegex(code, /isNewerVersion/, 'porównywarka wersji żyła tylko dla updatera (core/utils/versionCompare.ts skasowany)');
    t.notRegex(code, /requestUrl/, 'requestUrl w composition roocie byl tylko dla updatera; klient HTTP runtime powstaje w config/runtimeConfig.ts');
});

/**
 * Review W5-01/W5-04 (2026-09-04) — komendy i ikony wstążki wracają do `onload()`.
 *
 * F2.16 przeniosło obie rejestracje do `initialize()`, żeby stały ZA `setLocale()`. Cena była
 * za wysoka: `initialize()` biegnie dopiero po `onLayoutReady` i czeka na `wait_for({loaded:true})`,
 * więc wywrotka bootu środowiska (albo `waitForLoaded`, które przy `unloading` NIGDY się nie
 * rozwiązuje) zostawiała usera bez JEDNEJ komendy w palecie i bez ikon na wstążce — a ikony
 * dodatkowo zmieniały pozycję na pasku (Obsidian układa je w kolejności rejestracji).
 * Naprawa trzyma OBIE własności naraz: rejestracja w `onload()`, ale język znany wcześniej
 * z taniego, samodzielnego odczytu `.pkm-assistant/settings.json`.
 */
test('onload rejestruje komendy i wstążkę — nie initialize (review W5-01/W5-04)', t => {
    const onload = methodBody(source, 'onload');
    const initialize = methodBody(source, 'initialize');
    t.true(onload.length > 0, 'nie znalazłem onload() w src/main.ts');
    t.true(initialize.length > 0, 'nie znalazłem initialize() w src/main.ts');

    t.regex(onload, /this\.registerCommands\(\)/,
        'komendy muszą się rejestrować w onload() — inaczej padnięty boot env = pusta paleta');
    t.regex(onload, /this\.registerRibbonIcons\(\)/,
        'ikony wstążki muszą się rejestrować w onload() — inaczej wędrują na koniec paska i giną przy padzie env');
    t.notRegex(initialize, /this\.registerCommands\(\)/,
        'rejestracja komend w initialize() uzależnia paletę od udanego bootu środowiska (W5-01)');
    t.notRegex(initialize, /this\.registerRibbonIcons\(\)/,
        'rejestracja wstążki w initialize() zmienia pozycję ikon u userów (W5-04)');
});

test('onload: setLocale idzie PRZED rejestracją komend (F2.16 zachowane)', t => {
    const onload = methodBody(source, 'onload');
    const locale = onload.indexOf('setLocale(');
    const commands = onload.indexOf('this.registerCommands()');
    const ribbon = onload.indexOf('this.registerRibbonIcons()');

    t.true(locale >= 0, 'onload() musi ustawić język, zanim zarejestruje komendy');
    t.true(commands > locale,
        'Obsidian zapamiętuje nazwę komendy w chwili addCommand — bez setLocale wcześniej paleta jest zawsze angielska');
    t.true(ribbon > locale,
        'tooltip ikony wstążki też zapada w chwili rejestracji');
});

/**
 * Tani odczyt języka nie jest już metodą composition roota — mieszka w
 * `core/runtime/settingsArmor.ts` jako czysta funkcja `readUiLanguage(adapter)`, więc
 * strażnik po źródle zamienił się w test BEHAWIORALNY (`core/runtime/settingsArmor.test.ts`).
 * Tutaj zostaje jedno: composition root ma po nią sięgać, a nie odtwarzać jej u siebie.
 */
test('onload: język bierze się z readUiLanguage (pancerz), nie z własnej kopii w composition roocie', t => {
    const onload = methodBody(source, 'onload');
    t.regex(onload, /setLocale\(await readUiLanguage\(/,
        'composition root odtworzył własny odczyt języka — jedna kopia reguły „NIGDY exists()" wystarczy');
    t.regex(stripComments(source), /from ['"]\.\.\/core\/runtime\/settingsArmor\.js['"]/,
        'brak importu funkcji z pancerza');
    t.notRegex(stripComments(source), /read_ui_language|readUiLanguage\s*\(\s*\)\s*\{/,
        'stara metoda pluginu wróciła — byłaby drugą kopią kolejności kandydatów');
});

// ── C7.3/C7.4 ────────────────────────────────────────────────────────────────
test('onload: registerItemViews jest w onload(), a runtime powstaje PRZED pierwszym await', t => {
    const onload = methodBody(source, 'onload');

    t.regex(onload, /this\.registerItemViews\(\)/,
        'Obsidian odtwarza zapisane zakładki przy layoutReady — typ widoku musi być znany wcześniej');

    const runtimeAt = onload.indexOf('new PluginRuntime(');
    const firstAwait = onload.indexOf('await ');
    t.true(runtimeAt >= 0, 'composition root nie tworzy runtime w onload()');
    t.true(firstAwait < 0 || runtimeAt < firstAwait,
        'runtime powstaje PO pierwszym await — `plugin.env` byłby przez chwilę null i moduły trafiałyby w pustkę');
});

// ── C1.16b (droga harnessu) ──────────────────────────────────────────────────
test('runtimeConfig powstaje w KONSTRUKTORZE i TA SAMA referencja idzie do runtime pluginu', t => {
    const ctor = methodBody(source, 'constructor');
    t.regex(ctor, /this\.runtimeConfig\s*=\s*buildRuntimeConfig\(/,
        'config runtime musi powstac w konstruktorze — to JEDYNE wejście harnessu do podmiany dostawców przed onload()');

    const onload = methodBody(source, 'onload');
    t.regex(onload, /new PluginRuntime\([^)]*this\.runtimeConfig\)/,
        'onload() zbudował drugi config zamiast podać ten sam — podmiana providera przed onload() przepadłaby');
});

// ── clean-room / F7: rejestr embeddingu jest SLOTEM runtime'u, wstawia go composition root ──
test('rejestr embeddingu wstawiany PO runtime, a PRZED boot() — i z mapy z runtimeConfig', t => {
    const onload = methodBody(source, 'onload');
    const runtimeAt = onload.indexOf('new PluginRuntime(');
    const rejestrAt = onload.indexOf('new EmbeddingRegistry(');
    const bootAt = onload.indexOf('.boot()');

    t.true(rejestrAt >= 0,
        'bez tej linijki runtime zostaje z pustym rejestrem fail-closed i semantyka jest martwa mimo wybranego dostawcy');
    t.true(runtimeAt >= 0 && runtimeAt < rejestrAt,
        'rejestr wstawiany przed powstaniem runtime — konstruktor PluginRuntime i tak nadpisze slot pustym rejestrem');
    t.true(bootAt >= 0 && rejestrAt < bootAt,
        'rejestr wstawiany PO boot() — konsumenci obudzeni przez `loaded` mogą trafić w pusty slot');
    t.regex(onload, /providers:\s*this\.runtimeConfig\.embedding\.providers/,
        'rejestr zbudowany z innej mapy niż ta z runtimeConfig — podmiana dostawców przed onload() by przepadła');
    t.regex(onload, /settings:\s*\(\)\s*=>/,
        'ustawienia podane MIGAWKĄ zamiast funkcją — zmiana dostawcy w Ustawieniach wymagałaby restartu');
});

// ── C7.5 (P-01, luka F-14) ───────────────────────────────────────────────────
test('migracja folderu pluginu idzie PRZED pierwszym loadData()', t => {
    const initialize = methodBody(source, 'initialize');
    const migracja = initialize.indexOf('migrateOldPluginFolder(');
    const nowyUser = initialize.indexOf('isNewUser(');

    t.true(migracja >= 0, 'przeprowadzka data.json ze starego folderu zniknęła z initialize()');
    t.true(nowyUser >= 0, 'nie znalazłem pierwszego loadData() (isNewUser) w initialize()');
    t.true(migracja < nowyUser,
        'po zmianie id pluginu KAŻDY user dostałby powitanie „nowy użytkownik" i modal wydania');
});

// ── C7.8 (PL-11) ─────────────────────────────────────────────────────────────
test('onunload: kolejność kroków (notices → env.dispose → sink logu na końcu)', t => {
    const onunload = methodBody(source, 'onunload');
    const notices = onunload.indexOf('this.notices?.unload()');
    const dispose = onunload.indexOf('this.env?.dispose()');
    const sink = onunload.indexOf('log.disposeFileSink()');

    t.true(notices >= 0 && dispose >= 0 && sink >= 0, 'brakuje któregoś z trzech kroków demontażu');
    t.true(notices < dispose, 'powiadomienia trzeba zamknąć, zanim runtime zniknie spod nich');
    t.true(sink > dispose,
        'sink logu zamykamy NA SAMYM KOŃCU — kroki wyżej jeszcze logują, a bufor czeka na debounce');
});

/**
 * Sedno F2.16 od strony USERA: gdy w ustawieniach stoi `language: 'pl'`, do `addCommand`
 * ma pójść POLSKA nazwa. W gołym Node nie zaimportujemy `src/main.ts` (ciągnie `obsidian`),
 * więc bierzemy klucze `t('command.*')` prosto ze źródła i sprawdzamy, co `t()` z nich robi
 * po `setLocale('pl')` — czyli dokładnie to, co zobaczy Obsidian w chwili rejestracji.
 */
test('nazwy komend są polskie, gdy zapisany język to pl (F2.16 / review W5-01)', t => {
    const code = stripComments(source);
    const keys = [...code.matchAll(/name:\s*t\(\s*'(command\.[a-z0-9_]+)'\s*\)/g)].map(m => m[1]);
    t.true(keys.length >= 3, `w src/main.ts znalazłem tylko ${keys.length} nazw komend przez t() — strażnik mierzyłby pustkę`);

    setLocale('pl');
    for (const key of keys) {
        t.is(typeof pl[key], 'string', `brak polskiego tłumaczenia dla ${key}`);
        t.is(translate(key), pl[key], `t('${key}') po setLocale('pl') musi oddać polską nazwę`);
    }
    // Gdyby `setLocale` przestał cokolwiek zmieniać, powyższe przeszłoby na identycznych
    // słownikach — ta asercja pilnuje, że pl i en NAPRAWDĘ się różnią.
    t.true(keys.some(key => pl[key] !== en[key]),
        'żadna nazwa komendy nie różni się między pl a en — test nie mierzy niczego');
    setLocale('en');
});
