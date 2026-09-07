// eslint.obsidian.config.js — E3.4 faza E (walidator katalogu)
//
// Official Obsidian plugin-review rules (eslint-plugin-obsidianmd, 41 rules).
// Deliberately a SEPARATE config from eslint.config.js: the main lint guards our
// own architecture (deep imports) and stays fast/green; this one mirrors what
// catalog reviewers flag and is run ON DEMAND via `npm run lint:obsidian`
// (before a catalog submission / release), not on every commit.

import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.claude/**',
      '**/*.test.js',
      // TS-0 (2026-07-30): odpowiednik `**/*.test.js` po migracji testów na TypeScript.
      // Ten walidator nigdy nie patrzył na testy — rename plików nie miał tego zmienić.
      '**/*.test.ts',
      'esbuild.js',
      'eslint.config.js',
      'eslint.obsidian.config.js',
    ],
  },
  // TS-0 (2026-07-30) — WYMAGANE od chwili, gdy w repo pojawił się pierwszy plik `.ts`.
  // `obsidianmd.configs.recommended` włącza dla `**/*.{ts,...}` zestaw
  // `typescript-eslint/recommended-type-checked` ORAZ własną regułę `obsidianmd/no-plugin-as-component`
  // — obie wymagają INFORMACJI O TYPACH. Sam plugin nie ustawia `parserOptions`, zakłada że robi to
  // konsument. Bez tego bloku `npm run lint:obsidian` nie zgłasza błędów, tylko WYWALA SIĘ z
  // "You have used a rule which requires type information" na pierwszym pliku .ts.
  // `projectService` bierze program z `tsconfig.json` w roocie (ten sam, co `npm run typecheck`).
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  ...obsidianmd.configs.recommended,
  // TS-1 (2026-07-30) — reguły TYPOWANE, których naprawa wymagałaby ZMIANY RUNTIME'U.
  // Kampania TS ma twardy kontrakt „diff runtime = 0" (raport TS-0), a te reguły flagują
  // wzorce ZASTANE w kodzie (fire-and-forget promises, celowe stringifikacje `String(cokolwiek)`,
  // leniwy `require('electron')`), które na `.js` były niewidoczne — konwersja je tylko ODSŁANIA,
  // nie tworzy. Degradacja do 'warn' (nie 'off'): informacja zostaje w wyjściu walidatora,
  // bramka „zero nowych ERRORÓW vs baseline 97" pozostaje egzekwowalna, a błędy typowane
  // naprawialne SAMYMI TYPAMI dalej wychodzą jako errory i fale mają je zamykać (TS-1: 32 takie
  // zamknięte). Przegląd tych warningów = po kampanii / Poligon (S34).
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
    },
  },
  // ogony-ogA fala 3 (2026-09-04) — `no-unsanitized/method` zdjęte z blankietowego 'warn' TS-1
  // wyżej i zwężone do JEDYNEGO pliku, który je realnie łapie: `core/ui/safeHtml.ts`
  // (`createContextualFragment` w `fragmentFromHtml`, patrz komentarz przy wywołaniu — sam
  // plik tłumaczy, dlaczego inline `eslint-disable-next-line` tu NIE działa: pod głównym
  // configem (`npm run lint`) plugin `no-unsanitized` w ogóle nie jest zarejestrowany, więc
  // odwołanie do nazwy reguły wywaliłoby SIĘ TAM jako „rule not found" — jeden plik, dwa
  // configy, żaden inline-disable nie dogodzi obu naraz). TS-1 (2026-07-30) zostawiało to jako
  // globalny 'warn' (poprawny opis ZASTANEGO ryzyka po konwersji na .ts), ale bramka katalogu
  // („obsidianmd/*+no-unsanitized/* = 0 ostrzeżeń") liczy realne wystąpienia w wyjściu, nie
  // samo obniżenie severity — stąd `off` tu, zamiast `warn` wszędzie. Sanityzacja pozostaje
  // defense-in-depth W KODZIE (script/foreignObject/on*/javascript: wycinane zaraz po
  // `createContextualFragment`, przed opuszczeniem funkcji) — przepisanie na inne API byłoby
  // zmianą runtime'u, poza zakresem tej sesji.
  {
    files: ['core/ui/safeHtml.ts'],
    rules: {
      'no-unsanitized/method': 'off',
    },
  },
  // TS-3 (2026-07-31) — ta sama klasa co blok TS-1 wyżej (§B raportu TS-1): errory ODSŁONIĘTE
  // przez konwersję modules/models na .ts, niezamykalne bez zmiany runtime'u. Osobny blok,
  // żeby nie dotykać wpisów TS-1 (tryb równoległy TS-2∥TS-3 — edycje addytywne).
  {
    files: ['**/*.ts'],
    rules: {
      // modelResolver / ChatModel: `ButtonComponent.setDisabled` (SettingsContent.ts ×4)
      // wymaga Obsidiana 1.2.3. Wpis powstał, gdy manifest deklarował minAppVersion 1.1.0
      // (dziś 1.11.0). Wywołania ZASTANE
      // (działały tak samo na .js — reguła ich tam nie widziała). Zamknięcie = podbicie
      // minAppVersion (decyzja produktowa bazy, poza kampanią) albo zmiana runtime'u.
      'obsidianmd/no-unsupported-api': 'warn',
      // Dostawcy modeli (`modules/models/providers/*`) ×3: `reject(normalizeError(...))` odrzuca
      // zwykły obiekt (kontrakt tej warstwy od zawsze) — opakowanie w Error = zmiana kształtu błędu dla wołaczy.
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
      // `modules/models/ChatModel.ts` ×1: `throw normalizeError(resp.error)` — jw., obiekt-błąd to kontrakt.
      '@typescript-eslint/only-throw-error': 'warn',
    },
  },
  // TS-4 (2026-07-31) — profile/backstage/modal code sits on dynamic Obsidian DOM extensions
  // (`createEl`, `createDiv`, lazy view modules) and plugin DI objects assembled in `src/main`.
  // The strict compiler contracts the owned kernels (Agent, loaders, managers, stores), while
  // these five rules recursively report every operation after the deliberately marked `any`
  // UI/YAML compatibility boundaries (`// TS-any:`). Replacing those boundaries with guessed
  // closed interfaces would either lie about user-authored schemas or require runtime guards —
  // both outside the zero-runtime-diff campaign. Keep the findings visible as warnings; the
  // compiler and all other typed rules remain errors.
  {
    files: [
      'modules/agents/**/*.ts',
      'modules/skills/**/*.ts',
      'modules/sub-agents/**/*.ts',
      'modules/komunikator/**/*.ts',
      'modules/artifacts/**/*.ts',
      'modules/prompts/**/*.ts',
      'modules/crystal-soul/**/*.ts',
      'modules/onboarding/**/*.ts',
      // TS-5: dynamic chat/shell/UI composition boundaries and the Obsidian composition root.
      'modules/chat/**/*.ts',
      'modules/shell/**/*.ts',
      'modules/ui-components/**/*.ts',
      'src/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      // TS-5: te trzy reguły widzą dopiero adnotacje typu. Ich automatyczny fixer
      // jednocześnie przepisywał zastane API DOM/timerów, więc w kampanii zero-runtime-diff
      // pozostawiamy znaleziska widoczne jako warningi zamiast mieszać refaktor behawioralny.
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
    },
  },
  // L1 (2026-08-27) — override scoped WYŁĄCZNIE do core/utils/Logger.ts. Logger to KANONICZNY
  // logger pluginu (globalny wyjątek importowy, ~230 importerów) — jedyne miejsce, które ma
  // świadomie wołać `console.*` bezpośrednio. Śledztwo L1 (fala lint-zero) ustaliło:
  // `obsidianmd/rule-custom-message` tu naprawdę owija wbudowaną regułę ESLint `no-console`
  // z `options: [{ allow: ['warn','error','debug'] }]`. 8 z 13 wywołań w tym pliku to były gołe
  // `console.log` — przeniesione na `console.debug` (zero zmiany w runtime: Node/Chromium
  // traktują je jak alias), więc już się łapią na domyślną białą listę. Pozostałe 5
  // (`groupCollapsed`/`groupEnd` ×2, `table` ×1) NIE MAJĄ odpowiednika w białej liście wytycznych
  // Obsidiana — ich sensem istnienia jest wizualne grupowanie/tabela w DevTools, którego
  // `warn/error/debug` nie potrafią odtworzyć. `log` CELOWO ZOSTAJE zakazany (nie dopisany do
  // allow) — przyszły przypadkowy `console.log`/`console.info`/`console.trace` w tym pliku ma
  // się dalej łapać.
  //
  // Inline `eslint-disable` jest tu ZABLOKOWANY (zweryfikowane empirycznie w śledztwie L1, nie
  // tylko przeczytane w docs): sekcja `eslint-comments/no-restricted-disable` w configu
  // `eslint-plugin-obsidianmd` (spread wyżej przez `...obsidianmd.configs.recommended`) wprost
  // wymienia `obsidianmd/*` i `no-console` jako niewyłączalne komentarzem — próba disable'a
  // (nawet blankietowego, bez nazwy reguły) kończy się osobnym błędem `no-restricted-disable`
  // zamiast przejść. Stąd override na poziomie configu, nie komentarz w pliku.
  //
  // ⚠️ PUŁAPKA #1: `obsidianmd/rule-custom-message` dostaje dla dopasowanego pliku CAŁY obiekt
  // opcji NA NOWO — nie da się „dopisać" tylko `no-console` i zostawić resztę domyślnego configu
  // pluginu. Dlatego `no-new-func` niżej jest PRZEPISANY 1:1 z domyślnego configu
  // `eslint-plugin-obsidianmd` (`dist/lib/index.js`) — nie dotykamy go merytorycznie, tylko
  // zapobiegamy temu, żeby ochrona przed `new Function(...)` zniknęła po cichu w Logger.ts razem
  // z podmianą `no-console`.
  //
  // ⚠️ PUŁAPKA #2 (złapana i zweryfikowana w śledztwie L1): klucz w `messages` MUSI być
  // DOKŁADNYM tekstem, jaki wygeneruje bazowa reguła DLA NASZEGO `allow` — ESLint składa
  // `allowed.join(', ')` do szablonu `messageId: 'limited'` (`node_modules/eslint/lib/rules/
  // no-console.js`). Kopiowanie klucza 1:1 z domyślnego configu pluginu (kończącego się na
  // "...debug.") NIE działa z rozszerzonym `allow` — dopasowanie w `ruleCustomMessage.js` jest
  // exact-albo-substring, więc przy niedopasowanym kluczu `context.report` NIGDY się nie woła
  // i cała reguła gaśnie CICHO dla tego pliku (gorzej niż brak override'u — zero błędu, zero
  // ostrzeżenia). Klucz niżej kończy się więc na pełnej liście z NASZEGO `allow`, w tej samej
  // kolejności co tablica — zweryfikowane sondą: tymczasowy `console.trace(...)` wstawiony do
  // Logger.ts pod tym configiem MUSIAŁ się złapać (i złapał się), inaczej override zgasiłby
  // regułę zamiast ją zawęzić. Raport pełnej sondy: `Refaktor/Decyzje_Sesji/` (fala lint-zero L1).
  {
    files: ['core/utils/Logger.ts'],
    rules: {
      'obsidianmd/rule-custom-message': ['error', {
        'no-console': {
          messages: {
            'Unexpected console statement. Only these console methods are allowed: warn, error, debug, groupCollapsed, groupEnd, table.':
              'Avoid unnecessary logging to console. See https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines#Avoid+unnecessary+logging+to+console',
          },
          options: [{ allow: ['warn', 'error', 'debug', 'groupCollapsed', 'groupEnd', 'table'] }],
        },
        'no-new-func': {
          messages: {
            'The Function constructor is eval': 'Using the `Function` constructor is dangerous because it executes arbitrary code, similar to `eval()`',
          },
        },
      }],
    },
  },
  // ── release 2.2.0 / fala 2 (2026-09-04): jawne wyjątki zamiast obejść ──
  //
  // (1) Wyjątek node-safe dla `prefer-window-timers`/`no-global-this` ZNIKNĄŁ 2026-09-07: od tej
  // pory jedynym mostem Obsidian ↔ goły Node jest `core/utils/hostWindow.ts` (patrz jego komentarz),
  // a walidator katalogu i tak nie zna naszych wyjątków — lokalny lint ma pokazywać to, co on.
  // (2) Sentence case — słownik nazw własnych i skrótów (reguła chce „Pkm assistant", „Npx",
  // „ollama"). Reszta ostrzeżeń tej reguły to placeholdery techniczne (`sk-...`, `r8_...`,
  // `60m`, przykładowe ścieżki) — łapane przez `ignoreRegex`, bo „Sk-..." zafałszowałoby format.
  //
  // ogony-ogA fala 3 (2026-09-04): DWIE naprawy w tym bloku.
  //
  // (a) DWA wpisy `ignoreRegex` niżej były CICHO ZEPSUTE od zawsze — `shouldIgnoreByRegex` w
  // `eslint-plugin-obsidianmd` woła `new RegExp(p)` na SUROWYM tekście z tej tablicy, a sam
  // string-literal w kodzie JS TEGO PLIKU nie przechodzi przez ten sam parser co źródło
  // regexa: sekwencja backslash+d w zwykłym stringu JS NIE jest rozpoznanym
  // escape'em (specyfikacja: nierozpoznany backslash+X = sam znak X, backslash ginie po
  // cichu), a backslash+b JEST rozpoznanym escape'em w stringu JS — ALE oznacza znak
  // BACKSPACE (U+0008), nie regexowy word-boundary. Zweryfikowane empirycznie na
  // node --input-type=module: `new RegExp(źle_zapisany_duration).source` dawało
  // '^d+[smhd]$' (bez backslasha), `new RegExp(źle_zapisany_npx).source` dawało '^npx'
  // (bez śladu granicy słowa) — obie reguły realnie nigdy nic nie ignorowały, skąd dwa
  // z 26 ostrzeżeń tej fali ('60m' w modules/models/SettingsContent.ts, 'npx' w
  // modules/shell/MCPServerEditorModal.ts) mimo pozornie pasującego wzorca w configu.
  // Naprawa niżej: podwójny backslash w źródle JS tego pliku, żeby string, który dostaje
  // new RegExp(...), faktycznie zawierał POJEDYNCZY backslash+d / backslash+b.
  //
  // (b) Pięć nowych wpisów — placeholdery/etykiety, które MUSZĄ zostać dokładnie takie,
  // jak są, bo reprezentują format spoza sentence-case (slug, nazwa pakietu npm) albo
  // ścieżkę nawigacji UI (nazwy własne zakładek/sekcji Ustawień, nie zdanie do
  // zdekapitalizowania): '[CUSTOM]' (plakietka-akronim w TriggerPopup.ts), 'blender'
  // (placeholder pola ID — celowo lowercase, bo pole samo robi .toLowerCase() na
  // wpisanej wartości; 'Blender' z dużą literą kłamałoby o oczekiwanym kształcie),
  // placeholder argumentów npx z pakietem 'blender-mcp' (REALNA, case-sensitive nazwa
  // pakietu npm — wymuszenie wielkiej litery byłoby błędną podpowiedzią), oraz dwa
  // Notice w src/main.ts ('Onboarding wizard...'/'Secure storage locked...') — oba
  // wskazują ścieżkę UI ('Settings', 'API Keys') nazwami WŁASNYMI zakładek Ustawień, nie
  // prozą; ten sam powód ma już sąsiedni komentarz przy tym Notice w main.ts.
  {
    files: ['**/*.ts'],
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', {
        brands: ['PKM Assistant', 'PKM', 'GitHub', 'JDHole', 'Ollama', 'Blender', 'Orama', 'OpenAI', 'Anthropic', 'Gemini', 'DeepSeek', 'Groq', 'OpenRouter', 'LM Studio', 'xAI', 'Claude', 'Obsidian', 'Artefakty'],
        acronyms: ['PKM', 'API', 'MCP', 'URL', 'RAM', 'JSON', 'YAML', 'HTTP', 'PDF', 'ID'],
        ignoreRegex: [
          '^(sk|r8)[-_]\.\.\.',
          '^\\d+[smhd]$',    // FIX ogony-ogA: był jeden backslash (martwy, patrz komentarz wyżej)
          '^npx\\b',         // FIX ogony-ogA: był jeden backslash (backspace, patrz komentarz wyżej)
          '^[A-Z_]+=',
          '^_private',
          '^GitHub:',
          '/',
          '^\\[CUSTOM\\]$',   // badge TriggerPopup.ts
          '^blender$',                 // placeholder pola ID (lowercase celowo)
          '^-y\\nblender-mcp$', // placeholder argumentów npx (nazwa pakietu npm)
          '^Onboarding wizard',         // Notice main.ts — ścieżka UI, nazwy własne zakładek
          '^Secure storage locked',     // Notice main.ts — jw.
        ],
      }],
    },
  },
  // (3) obsidianmd/hardcoded-config-path — i18n statyczne katalogi (ogony-ogA fala 3,
  // 2026-09-04). Cztery klucze (EN+PL = 8 znalezisk) to STATYCZNE stringi w słownikach
  // tłumaczeń, nie kod porównujący/budujący ścieżkę: `prompt.env.obsidian_folder` i
  // `mcp.create_folder.desc` opisują folder `.obsidian` MODELOWI (system prompt / opis
  // narzędzia MCP) — literał jest tam funkcjonalnie potrzebny, żeby agent rozpoznał tę
  // nazwę w argumencie ścieżki; `profile.perm.mode_full_desc` i
  // `profile.advanced.admin_access_hint` to tooltip UI dla człowieka. Reguła nie ma jak
  // dostać tu żywego `vault.configDir` — i18n to gołe obiekty {klucz: string} bez
  // kontekstu runtime, a przerobienie na szablon z {{configDir}} (t() wspiera
  // interpolację) wymagałoby zmiany API `FACTORY_DEFAULTS.environment` (dziś statyczny
  // getter bez argumentów) i przewodu do `mcp.create_folder.desc` w opisach narzędzi —
  // realna zmiana zachowania budowy promptu, poza zakresem sesji lint-cleanup. Wyjątek
  // na poziomie PLIKU (nie linii — inline `eslint-disable` dla `obsidianmd/*` jest
  // zablokowany, patrz L1 wyżej).
  {
    files: ['core/i18n/en.ts', 'core/i18n/pl.ts'],
    rules: {
      'obsidianmd/hardcoded-config-path': 'off',
    },
  },
  // (4) obsidianmd/hardcoded-config-path — trzy pliki z UDOKUMENTOWANYM, TESTOWANYM
  // defaultem (ogony-ogA fala 3, 2026-09-04). Wszystkie trzy już mają mechanizm ŻYWEGO
  // `vault.configDir` — literał '.obsidian' jest w nich celowym, bezpiecznym stanem
  // PRZED/BEZ niego, nie miejscem, gdzie live value jest ignorowana:
  //   - core/security/AccessGuard.ts `SYSTEM_NO_GO` (linia ~100) jest TWARDYM,
  //     bezwarunkowym dnem bezpieczeństwa (blokuje niezależnie od configDir; '.trash' w
  //     ogóle nie ma odpowiednika configDir) — usunięcie literału osłabiłoby fail-closed.
  //     `_configDir` (linia ~103) to WARTOŚĆ DOMYŚLNA pola nadpisywanego przez
  //     `setConfigDir()` (wołane z src/main.ts:656,
  //     `AccessGuard.setConfigDir(this.app?.vault?.configDir)`) — usunięcie literału
  //     zostawiłoby pole `undefined` w oknie między załadowaniem modułu a `initialize()`.
  //   - core/utils/pluginFolderMigration.ts:61 — `configDir` to udokumentowany
  //     OPCJONALNY parametr (`configDir?: string`), realna wartość dochodzi z
  //     src/main.ts:493 (`configDir: this.app?.vault?.configDir`); fallback
  //     `|| '.obsidian'` jest wprost przetestowany (pluginFolderMigration.test.ts,
  //     przypadek „configDir domyślnie .obsidian gdy nie podany”).
  //   - modules/embedding/VaultIndexer.ts:112 — `HARD_EXCLUDES` to statyczna baza (razem
  //     z '.pkm-assistant'/'.trash', żadne z nich nie ma odpowiednika configDir); realne
  //     wykluczenie idzie przez `_hardExcludes()` (linia ~923), która DOKŁADA żywy
  //     `vault.configDir` do tej bazy przy KAŻDYM wywołaniu (`_isExcluded` →
  //     `_hardExcludes()`, linia ~951) — literał w `HARD_EXCLUDES` jest fallbackiem na
  //     wypadek braku configDir (harness/testy), nie miejscem ignorującym go.
  {
    files: [
      'core/security/AccessGuard.ts',
      'core/utils/pluginFolderMigration.ts',
      'modules/embedding/VaultIndexer.ts',
    ],
    rules: {
      'obsidianmd/hardcoded-config-path': 'off',
    },
  },
  // (5) obsidianmd/settings-tab/prefer-setting-definitions — modules/shell/PluginSettingsTab.ts
  // (ogony-ogA fala 3, 2026-09-04). Reguła chce `getSettingDefinitions()` na klasach non-abstract
  // rozszerzających `PluginSettingTab` (Obsidian 1.13+ settings search). Nie jest to problem
  // wersji jak w (1)/setWarning — definiowanie metody na WŁASNEJ podklasie nic nie kosztuje na
  // starszym Obsidianie (silnik po prostu jej nie odpyta, to duck-typed opt-in, nie wywołanie API,
  // które by rzuciło). Powód wyjątku jest inny: ta klasa jest bazą (nie oznaczoną `abstract` w
  // TS, stąd reguła w ogóle ją widzi), a prawdziwe ustawienia renderują się DYNAMICZNIE przez
  // `SettingsRegistry` — wtyczkowy rejestr sekcji (order-based) dokładany przez ~10 modułów
  // (core/models/memory/tools/agents/crystal-soul + shell-owned Vault/Prompt), każdy z własnym
  // `SettingsContent.ts`. Statyczny katalog `getSettingDefinitions()` musiałby zwierciadlić CAŁY
  // ten dynamiczny system — realna integracja z wyszukiwarką ustawień Obsidiana 1.13+, czyli NOWY
  // FEATURE (zakazany podczas refaktoru, patrz CLAUDE.md „Priorytety pracy"), nie punktowa naprawa
  // lintu. Konkretna podklasa (`PkmSettingsTab`, `pkm_settings_tab.ts`) rozszerza TĘ bazę, nie
  // `PluginSettingTab` wprost, więc reguła (statyczne dopasowanie `superClass`) jej nie łapie —
  // wyjątek na samej bazie zamyka jedyne miejsce, gdzie się odzywa.
  {
    files: ['modules/shell/PluginSettingsTab.ts'],
    rules: {
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
];
