# modules/crystal-soul/

> **TS-4 (2026-07-31):** fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej oznaczają historyczne nazwy albo specyfikatory importów, które zgodnie z konwencją TS-0 celowo pozostają `.js`.

**Wizualny system pluginu.** Generatory SVG (ikony, kryształy, konektory), paleta kolorów per-agent, ~40+ ikon UI. **Crystal Soul v2** od sesji 47 — każdy agent ma "duszę" reprezentowaną przez kryształ (kształt + kolor + blask).

**Status:** 🚀 **ACTIVE** (kod fizycznie w `modules/crystal-soul/` od sesji Mapy 2026-04-25). Pierwszy moduł zmapowany po memory + core z MAX. 89 importów zostało przepiętych na barrel `modules/crystal-soul/index.js`.

**Sprint Refaktoru — który mnie dotyka:**
- ✅ [Sprint 10 Settings v2 + Backstage v2](../../Refaktor/Sprinty/SPRINT_10_Settings_v2_Backstage_v2.md) **DONE (2026-05-02 + hotfix)** — `SettingsContent.js` renderuje sekcję "Wygląd" (język UI + kolory usera); `SettingsSection.js` rejestruje realny render. Plus S10: category colors, hash helper, alias `lightning -> zap` i cleanupy Crystal Soul.
- ✅ [Sprint 12 Skiny pluginu](../../Refaktor/Sprinty/SPRINT_12_Skiny_Pluginu.md) **DONE (2026-05-06)** — `SkinManager` singleton + Default skin (monogram, Obsidian CSS vars) + Crystal Soul jako named skin + custom YAML loader + settings dropdown/reload/sample + hot reload dla chat/sidebar + migracja głównych konsumentów avatar/color na SkinManager.

---

## Co tu jest (kod w `modules/crystal-soul/`)

```
modules/crystal-soul/
├── IconGenerator.js                # ~660 LOC — proceduralne ikony (5 kategorii × 8 templates)
├── UiIcons.js                      # ~297 LOC — kuratorska kolekcja 51 nazwanych ikon (18 nieużywanych + alias `lightning` + helper `svgFill` skasowane AUD-dead-code-094/144/150/195, 2026-09-02)
├── CrystalGenerator.js             # ~225 LOC — kryształy agentów (8 kształtów + blask)
├── ColorPalette.js                 # ~110 LOC — paleta 64 kolorów (8 grup × 8) per agent
├── SkinManager.js                  # S12 — singleton aktywnego skina (Default / Crystal Soul / Custom)
├── SkinLoader.js                   # S12 — loader .pkm-assistant/skins/*.yaml
├── skins/
│   ├── default.js                  # S12 — Obsidian-adaptive monogram skin
│   └── crystal-soul.js             # S12 — obecny wygląd jako named skin
├── styleSheets.js                  # adoptSheet/removeSheet/removeAdoptedSheets — arkusze adoptowane do dokumentu (gotcha niżej)
├── SvgHelper.js                    # 28 LOC  — toElement + hexToRgbTriplet
├── domUtils.js                     # E3.4 — setSvg / setSvgLabel (ikona przez DOM, label ZAWSZE text node)
├── add_icons.js                    # add_pkm_icon (Obsidian addIcon; przyszedł z E1.6 B3; NIE w barrelu — wołany bezpośrednio z main.js). `add_smart_dice_icon` skasowana AUD-dead-code-086, 2026-09-02 — rejestrowana przy każdym starcie, zero wołaczy ikony 'smart-dice' w całym repo.
├── category_colors.js              # 42 LOC  — getCategoryColor + deriveDelegateCategory (S10 Z7)
├── category_colors.test.js         # AVA test
├── SettingsContent.js              # S10 hotfix — render sekcji Wygląd
├── SettingsSection.js              # 10 LOC  — rejestruje sekcję "Wyglad" w SettingsRegistry (S10)
├── utils/
│   └── hash.js                     # seededStringHash() — wspólny helper dla Icon/Crystal/Palette (S10 hotfix)
└── index.js                        # barrel exports
```

Razem **~2,200 LOC** (po S10 + S12 Skiny + E1.6 B3: `add_icons.js` przyszedł z `src/utils/`).

---

## Public API — 16 eksportów (zmierzone 2026-09-02 z bloków `export { ... } from` w index.ts, bez `export type`)

`modules/crystal-soul/index.js`:

- `IconGenerator` — generator ikon UI
- `UiIcons` — collection kompozytów (51 ikon; alias `lightning` skasowany, patrz K11 dead-code niżej)
- `SkinManager` — aktywny skin: `getColor()`, `getCrystal()`, `setActiveSkin()`, `applyCss()`
- `COLOR_GROUPS`, `ALL_COLORS`, `pickColor(seed)`, `getColorByHex(hex)` — paleta
- `getCategoryColor(category)`, `deriveDelegateCategory(toolsList)` — kategorie skilli/sub-agentów (S10 Z7, przeniesione z shell)
- `SvgHelper` + `hexToRgbTriplet` — pomocnicze SVG funkcje
- `setSvg(el, svgMarkup)` / `setSvgLabel(el, svgMarkup, labelText)` — **E3.4** bezpieczne wstawianie ikon zamiast `el.innerHTML = ikona + ' ' + nazwa`. Tylko markup zaczynający się od `<svg` idzie przez parser (`SvgHelper.toElement`); reszta (emoji z YAML usera, ścieżki, nazwy narzędzi z zewnętrznych serwerów MCP) ląduje jako **text node**. `domUtils.js` jest świadomie WOLNY od importu `obsidian` — barrel musi dać się załadować poza Obsidianem (patrz gotcha niżej).
- `adoptSheet(sheet, host?)` / `removeAdoptedSheets(host?)` — rejestr arkuszy CSS montowanych przez `document.adoptedStyleSheets`; `host` domyślnie to `document` (AUD-bledy-037, patrz Gotchas niżej)
- `registerSettings(registry, plugin)` — rejestruje sekcję "Wygląd" (S10 Z2)

> **S30 Z4 — 7 eksportów WYCIĘTYCH z barrela** (zero konsumentów spoza modułu):
> `CrystalGenerator`, `CATEGORY_COLORS`, `SkinManagerClass`, `SkinLoader`, `defaultSkin`,
> `generateMonogramAvatar`, `crystalSoulSkin`. To domknięcie decyzji S12: **avatar/kolor/ikonę
> pyta się `SkinManager`**, a on trzyma generator kryształów, loader skinów i oba skiny u siebie.
> Nota w `modules/shell/CLAUDE.md` („shell importuje `CrystalGenerator`") była **nieprawdziwa** —
> jedyne trafienie grepa poza tym modułem to komentarz w `modules/agents/Agent.js`.
> Definicje ŻYJĄ w bebechach; `CATEGORY_COLORS` czyta `getCategoryColor()` u siebie.

> **AUD-dead-code K11 (2026-09-02) — druga przycinka barrela + kasacja martwej ścieżki ikon.**
> Barrel: `sanitizeSvgColor` i `removeSheet` OUT (zero konsumentów przez barrel — obie definicje
> żyją, wołane bezpośrednio z `CrystalGenerator.ts`/`SkinManager.ts` i przez testy z pliku
> źródłowego, patrz `AUD-dead-code-197`; 10 typów z barrela zostają jako świadomy parking).
> Cała ścieżka `SkinManager.getIcon()` / `.css()` → `skin.getIcon(name)` → `UiIcons[name]`
> skasowana (`AUD-dead-code-198`) — zero wołaczy w repo, custom skiny usera dziś i tak nie mogą
> podmienić ikony przez ten mechanizm. `IconGenerator.CATEGORIES` (`AUD-dead-code-249`) i typ
> `CategoryColor` (`AUD-dead-code-202`) skasowane — zero odczytów. 7× `export default` (jeden
> per plik: `UiIcons`, `SkinManager`, `IconGenerator`, `SkinLoader`, `CrystalGenerator`,
> `skins/default`, `skins/crystal-soul`) skasowane — zero importów domyślnych w repo
> (`AUD-dead-code-196`).

---

## Crystal Soul v2 koncept (sesja 47, 54)

Każdy agent dostaje:
- **Kryształ** — kształt SVG (8 rodzin, `SHAPE_NAMES` w `CrystalGenerator.ts`, zmierzone 2026-08-27: pryzmat, diament, igła, klaster, heksagon, podwójny, tarcza, odłamek — deterministyczny wybór wg seeda, nie 5 historycznych nazw prismatic/hexagonal/rounded/sharp/organic)
- **Kolor** — paleta **64 kolorów** w 8 grupach po 8 (fiolety/blekity/turkusy/zielenie/czerwienie/pomarancze/zlota/neutralne) (Klara: pomarańcz, Tola: róż, Zoja: fioletowy, Borys: niebieski, Wera: zielony, ...)
- **Blask** — animacja (subtle, glow, pulse)

Razem to jego "dusza" wizualna w UI. Widoczne w:
- AgentSidebar (lista agentów)
- ChatView header (active agent)
- AgentProfileModal (preview)
- CommunicatorView (sidebar messages)

---

## Zależności

**Importuje z (zmierzone 2026-08-27 grepem po `^import` w `modules/crystal-soul/**/*.ts`, bez testów):**
- `core/utils/Logger.js` (`log`) — `IconGenerator`, `SkinLoader`, `SkinManager`
- `core/i18n/index.js` (`t`, `setLocale`) — `SettingsContent`, `SettingsSection`
- `core/index.js` (barrel: `ensureAdapterFolder`, `parseYaml`) — `SettingsContent`, `SkinLoader`
- `obsidian` — `add_icons.ts` importuje `addIcon` naprawdę (dlatego świadomie NIE jest w barrelu,
  patrz komentarz w `index.ts`); `SkinLoader.ts`/`SkinManager.ts` importują **tylko typ** `Vault`
  (`import type`, zero na runtime)

> **NIEAKTUALNE (AUD-docs-039):** „TYLKO `core/utils/`" nie było prawdą nawet w dniu, w którym
> zostało napisane — `core/i18n` i `core/index` (barrel) są importowane od dawna przez
> `SettingsContent.ts`/`SettingsSection.ts`/`SkinLoader.ts`, a `obsidian` przez `add_icons.ts`
> (świadomie POZA barrelem — patrz gotcha „Barrel musi zostać WOLNY od `obsidian`" niżej — ale to
> dalej import W MODULE, nie poza nim). Moduł NIE jest obsidian-free jako całość; jest obsidian-free
> tylko jako **barrel** (`index.ts` sam nie ciągnie `obsidian` na żadnej ścieżce importu).

**Importowany przez:**
- `modules/shell/` (AgentSidebar, sidebar views, modale)
- `modules/agents/` (AgentProfileModal, avatary), `modules/komunikator/CommunicatorView.js`
- `modules/chat/` (chat_view + chat_* submoduły)
- `modules/onboarding/` (ikony/avatary w wizardzie)
- `src/main.js` (`add_icons.js` — rejestracja ikon Obsidiana; deep-import świadomie dozwolony, patrz komentarz w `index.js`)

  > Uwaga (E2.3): dawny importer `core/WorkMode.js` (UiIcons dla mode markers) zniknął — `WorkMode.js` skasowany wraz z trybami Gadaj/Rób.

---

## Kluczowe decyzje

- **Crystal Soul v2 zastąpił v1 emoji** (sesja 47): wcześniej agenci mieli emoji jako avatar. v2 = kryształy SVG = profesjonalne, własne, skalowalne.
- **64 kolorów paleta** (sesja 54): hand-picked w 8 grupach po 8, żeby pasowały do siebie i były odróżnialne (color-blind friendly też). ⚠️ Stara dokumentacja błędnie pisała "24" lub "62" — naprawione w sesji Mapy 2026-04-25.
- **`pickColor(seed)`** — deterministycznie wybiera kolor z palety na podstawie nazwy agenta. Stabilne między sesjami.
- ~~**`core/WorkMode.js → src/crystal-soul/UiIcons.js`**~~ — nieaktualne: `WorkMode.js` skasowany w E2.3 (tryby Gadaj/Rób out), więc ten wyjątek od reguły "core nie importuje z `modules/`" (ADR 003) już nie istnieje. Jedyny pozostały deep-import core→UiIcons to `src/main.js/add_icons.js`.

---

## Gotchas

- ⚠️ **`pickColor(seed)` deterministyczne** — zmiana seed (np. rename agenta) = zmiana koloru. Mitygacja: zachowaj stary `agent.color` w YAML zamiast pickować dynamicznie (ale obecnie nie wymuszane).
- ⚠️ **SVG render może być wolny** dla 20+ agentów na ekranie — performance optimization w przyszłości (lazy render, virtualization).
- ⚠️ **Animacje (`blask: pulse`)** — niektórzy users wolą static. Settings flag `disableAnimations` planowany, niezaimplementowany.
- ⚠️ **Barrel musi zostać WOLNY od `obsidian`** (E3.4). Pakiet `obsidian` z npm to same typy (`"main": ""`), więc statyczny `import ... from 'obsidian'` w pliku re-eksportowanym z `index.js` wywala testy AVA, które ładują barrel tranzytywnie (empirycznie: `DelegateTool.test.js`, `TriggerPopup.test.js`, `TriggersView.test.js` → 896 → 874). Dlatego `domUtils.js` NIE używa `sanitizeHTMLToDom` z `obsidian`, tylko `SvgHelper.toElement` (DOMParser, inertny) + `appendText`. Ten sam powód co dla `add_icons.js` (patrz komentarz w `index.js`).
- ⚠️ **Po S12 konsumenci UI powinni pytać SkinManager** o avatar/kolor/ikonę. Bezpośrednie `CrystalGenerator` zostaje do generatorów i edytorów palety, ale nowe UI nie powinno robić hardcoded Crystal Soul.
- ⚠️ **Arkusz wchodzi do dokumentu WYŁĄCZNIE przez `adoptSheet()`** (`styleSheets.js`, AUD-bledy-037).
  Dawny wzorzec „`if (!document.adoptedStyleSheets.includes(x)) document.adoptedStyleSheets = [...]`"
  stał w 7 miejscach i NIC go nie odwracało: wyłączony plugin stylizował Obsidiana do restartu,
  a każdy cykl wyłącz/włącz dokładał kolejny arkusz (świeży bundle = świeży obiekt, więc `.includes`
  starego nie widzi). Dziś `adoptSheet` rejestruje arkusz, `removeAdoptedSheets()` w `onunload`
  zdejmuje komplet, a `SkinManager.dispose()` dokłada swój arkusz i znaczniki z `document.body`.
  **Nie wracaj do ręcznego dopychania tablicy** — arkusza spoza rejestru nie ma kto zdjąć.
- ⚠️ **`SkinManager.ensureSettings()` dosztukowuje domyślny skin do SUROWEGO worka**
  (`env.settingsStore.raw`), nie przez obserwowane proxy (F7, 2026-09-06). Provisioning nie jest
  decyzją usera, a mutacja proxy planuje zapis CAŁEGO `.pkm-assistant/settings.json` (z kluczami
  API) sekundę po starcie — reguła „boot nie pisze", incydent 2026-07-28. Objaw był niewidoczny,
  dopóki fabryczne ustawienia niosły `activeSkin`; od clean-room prowizjonują tylko kontenery czatu
  i embeddingu (spec §4), więc gałąź stała się osiągalna przy każdym starcie nowego usera.
  **`setActiveSkin()` pisze DALEJ przez proxy** — to wybór usera i ma przeżyć restart.
  Strażnicy: `SkinManager.test.ts` (3 testy) + scenariusz harnessa `39_boot_nie_pisze`.

---

## TODO

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md)

- 🟢 **`disableAnimations` flag** w settings — accessibility
- 🟢 **Lazy render dla 20+ agentów** — performance

## Powiązane

- `modules/agents/CLAUDE.md` — agenci używają Crystal Soul
- `modules/komunikator/CLAUDE.md` — UI z kryształami
- `modules/chat/CLAUDE.md` — chat header
- 🌐 **Wizja przekrojowa SKINY_pluginu** (zrealizowana w S12) — archiwum vaulta: `90_Archiwum/DevDesktop_Era2_2026-08-02/Projekty/PKM Assistant - Mapa/Wizje/SKINY_pluginu.md`. Koncept wymiennych skinów (Default neutralny + Crystal Soul + Custom user skins). **Crystal Soul w przyszłości stanie się jednym ze skinów, nie hardcoded UI.** Refaktor dotknie 12+ modułów.

## Historia

- **Sesja 47** — Crystal Soul v2 koncept (kryształy SVG zamiast emoji)
- **Sesja 54** — paleta 64 kolorów + IconGenerator + UiIcons
- **Sesja 128 D6** (2026-04-25) — placeholder rozbudowany do wzorca
- **Mapa-1** (2026-04-25) — fizyczna migracja `src/crystal-soul/` → `modules/crystal-soul/`, 89 importów na barrel, 13 znalezisk w `Hogwart/Moduly/crystal-soul/TODO.md` (wszystkie do Refaktoru), 3 atomic Nauka cards w Hogwarcie
- **E1.6 B3 + docs-freshness** (2026-07-21) — `add_icons.js` (add_smart_dice_icon/add_obsek_icon) przeniesiony z `src/utils/` tutaj (naturalny dom ikon); świadomie NIE re-eksportowany z `index.js` (wołany bezpośrednio przez `main.js`). Struktura + LOC (~1,510 → ~2,200) + ścieżki importerów zsynchronizowane ze stanem na dysku.

## K11 update (2026-08-22) — kolor z profilu nie wpisuje markupu (twardnienie AUD-security-090)

- **`sanitizeSvgColor(color, fallback = 'currentColor')` (NOWE, w barrelu, pure).** Generatory
  sklejają SVG stringiem (`fill="${color}"`), a `color` bierze się z pliku profilu agenta
  w vaultcie — wartość z cudzysłowem zamykała atrybut i pozwalała dopisać własny element
  (np. `<image href="https://…">`, który po dołączeniu do żywego DOM-u strzela żądaniem na obcy
  serwer). Przepuszczamy tylko realne kształty: `#rgb`/`#rrggbb`/`#rrggbbaa`,
  `rgb()`/`rgba()`/`hsl()`/`hsla()`, `var(--x)`, nazwa CSS. Reszta → `currentColor`.
  Bramka stoi w `CrystalGenerator.generate` **i** w `generateInner` (bywa wołane wprost).
- **`SvgHelper._scrub` ma allowlistę tagów, nie tylko `script`.** `_FORBIDDEN_TAGS` wycina
  `image`, `use`, `iframe`, `object`, `embed` i SMIL (`animate`, `animateTransform`,
  `animateMotion`, `set`) obok `script`/`foreignObject`, a z atrybutów leci KAŻDY zdalny
  `href`/`xlink:href`/`src` — zostaje wyłącznie lokalne `#id` (filtry glow generatorów działają
  dalej). Do K11 znikało tylko `javascript:`, więc parser XML wpuszczał payload z `<image href>`.
- Źródło `color` jest dziś zamknięte (`.pkm-assistant/**` fail-closed dla narzędzi bez
  `admin_access`, UI zapisuje hex z zamkniętej palety), więc to **twardnienie, nie łata dziury**.
  Strażnik: `modules/crystal-soul/svgSafety.test.ts`.

## AUD-dead-code K11 update (2026-09-02) — kasacja martwej ścieżki ikon + druga przycinka barrela

Kawałek K11 audytu dead-code (nie mylić z „K11 update" wyżej, to inny K11 — numeracja
kawałków audytu jest per-bieg). Zakres:

- **19 z 70 wpisów `UiIcons` skasowanych** (`AUD-dead-code-150`/`195`, zbieg 4 rund audytu):
  `expand`, `unlock`, `bug`, `dotBlue`, `dotPurple`, `dotYellow`, `dotRed`, `chart`, `mask`,
  `lightbulb`, `hammer`, `pin`, `at`, `sparkles`, `star`, `chevronRight`, `arrowUp`, `arrowDown`
  + alias `lightning`. Zero wołaczy bezpośrednich, zero przez DI `ctx.icons` (ten kanał
  ma zamknięty zestaw nazw: `key`/`dotGreen`/`dotGray`/`wrench`/`shield`/`warning`/`info`/`robot`),
  zero przez `UiIcons[dynamiczna_nazwa]` (jedyne trzy miejsca: dwa martwe `skin.getIcon` niżej
  i `HomeView.ts` z zamkniętym zestawem `zap`/`robot`/`externalLink`/`sparkle` z
  `backstage_rows.ts`). `dotGreen`/`dotGray` ZOSTAJĄ (żywe przez `ctx.icons`). Helper `svgFill`
  (prywatny, nieeksportowany) skasowany razem — jego jedynymi konsumentami miały być
  wypełnione ikony `dot*`, a te budowały SVG inline, nie przez helper (`AUD-dead-code-094`/`144`).
- **Cała ścieżka `skin.getIcon` skasowana** (`AUD-dead-code-198`): `SkinManagerClass.getIcon()` +
  `.css()`, implementacje `getIcon()` w `skins/default.ts` i `skins/crystal-soul.ts`
  (obie robiły `UiIcons[name]?.(size) || UiIcons.question(size)`), bind w `mergeSkin()` i pole
  `getIcon?` w typie `SkinSpec`. Zero wołaczy w całym repo — UI bierze ikony wprost z
  `UiIcons.<nazwa>()` albo z DI `ctx.icons`, nigdy przez `SkinManager`. Efekt uboczny: custom
  skin usera z YAML nie mógł (i nadal nie może) podmienić pojedynczej ikony tą drogą — jeśli to
  ma wrócić, to nowa funkcjonalność, nie reaktywacja martwego kodu.
- **Follow-up (2026-09-02, osobne cięcie poza listą id D8): pole `icons` wycięte z `SkinSpec`**
  razem z wartościami `icons: UiIcons` w `skins/default.ts` i `skins/crystal-soul.ts` (plus
  osierocone importy `UiIcons` w obu) oraz linią `icons: deepMerge(...)` w `mergeSkin()`.
  Jedynym czytelnikiem `skin.icons?.[key]` była skasowana wyżej `getIcon()`; grep po
  `core modules src config utils test-support` (ts/yaml/json, z testami) — zero innych. Wszystkie
  pozostałe `icons` w repo to kanał DI `ctx.icons` (typ `IconSet`, zasilany wprost `UiIcons`
  w `shell/pkm_settings_tab.ts`) — niezależny od skinów. **YAML usera z kluczem `icons:`**
  (archiwalny schemat w `Refaktor/Sprinty/SPRINT_12_Skiny_Pluginu.md` go pokazywał; szablon
  „Utwórz YAML" w ustawieniach go NIE generuje; vault Kuby nie ma dziś żadnego custom skina)
  ładuje się dalej: `SkinLoader` nie ma schematu, obcy klucz przechodzi przez `...custom`
  w `mergeSkin()` i nikt go nie czyta. Świadomie BEZ no-op `deepMerge` — to byłby martwy kod
  od nowa. Strażnik: test „tolerują obcy klucz `icons:`" w `SkinManager.test.ts`.
- **`IconGenerator.CATEGORIES`** (statyczny getter, `AUD-dead-code-249`) i typ **`CategoryColor`**
  w `category_colors.ts` (`AUD-dead-code-202`) skasowane — zero odczytów w repo.
- **7× `export default` skasowane** (`AUD-dead-code-196`): `UiIcons.ts`, `SkinManager.ts`,
  `IconGenerator.ts`, `SkinLoader.ts`, `CrystalGenerator.ts`, `skins/default.ts`,
  `skins/crystal-soul.ts`. Zero importów domyślnych z `crystal-soul` w repo — wszyscy importują
  eksporty nazwane, przez barrel.
- **Barrel przycięty o 2 wartości** (`AUD-dead-code-197`): `sanitizeSvgColor` i `removeSheet` OUT
  z `index.ts` — zero konsumentów PRZEZ BARREL (definicje żyją: `sanitizeSvgColor` wołana
  bezpośrednio z `CrystalGenerator.ts`, `removeSheet` z `SkinManager.dispose()`; oba testy
  importują bezpośrednio z pliku źródłowego, nie z barrela). **10 typów zostaje w barrelu**
  świadomie (parking, nie kasacja) — `IconCategory`, `IconOptions`, `AdoptableSheet`,
  `SheetHost`, `UiIcon`, `AgentVisual`, `SkinDefinition`, `SkinRenderOptions`, `SkinSpec`,
  `ColorEntry` — decyzja poza tym audytem.
- **Ikona `smart-dice`** (`AUD-dead-code-086`): `add_smart_dice_icon()` w `add_icons.ts`
  rejestrowała ikonę Obsidiana przy KAŻDYM starcie pluginu, zero `setIcon('smart-dice')` /
  `getIcon('smart-dice')` w całym repo. Skasowana razem z wywołaniem w `src/main.ts:242` —
  domyka TODO z `core/CLAUDE.md` wiszące od Mapy.

Bramka: `tsc --noEmit` zielony po każdej kasacji; `SkinManager.test.ts` (nie woła `getIcon`/`css`
ani wcześniej, ani po) i `category_colors.test.ts` (nie woła `CATEGORIES`/`CategoryColor`) nadal
zielone bez zmian w testach.
