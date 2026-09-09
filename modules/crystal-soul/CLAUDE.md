# modules/crystal-soul/

**Wizualny system pluginu.** Generatory SVG (ikony, kryształy, konektory), paleta kolorów per-agent, ~40+ ikon UI. Każdy agent ma „duszę" reprezentowaną przez kryształ (kształt + kolor + blask).

---

## Co tu jest

```
modules/crystal-soul/
├── IconGenerator.ts                # proceduralne ikony (5 kategorii × 8 templates)
├── UiIcons.ts                      # kuratorska kolekcja nazwanych ikon
├── CrystalGenerator.ts             # kryształy agentów (8 kształtów + blask)
├── ColorPalette.ts                 # paleta 64 kolorów (8 grup × 8) per agent
├── SkinManager.ts                  # singleton aktywnego skina (Default / Crystal Soul / Custom)
├── SkinLoader.ts                   # loader .pkm-assistant/skins/*.yaml
├── skins/
│   ├── default.ts                  # Obsidian-adaptive monogram skin
│   └── crystal-soul.ts             # obecny wygląd jako named skin
├── styleSheets.ts                  # adoptSheet/removeSheet/removeAdoptedSheets - arkusze adoptowane do dokumentu (gotcha niżej)
├── SvgHelper.ts                    # toElement + hexToRgbTriplet + sanityzacja SVG (allowlist tagów, gotcha niżej)
├── domUtils.ts                     # setSvg / setSvgLabel (ikona przez DOM, label ZAWSZE text node)
├── icons.ts                        # registerPkmIcon() (Obsidian addIcon; NIE w barrelu - wołany bezpośrednio z main.ts)
├── category_colors.ts              # getCategoryColor + deriveDelegateCategory
├── SettingsContent.ts              # render sekcji „Wygląd"
├── SettingsSection.ts              # rejestruje sekcję „Wygląd" w SettingsRegistry
├── utils/
│   └── stableHash.ts               # seededStringHash() - wspólny helper dla Icon/Crystal/Palette
└── index.ts                        # barrel exports
```

---

## Public API

`modules/crystal-soul/index.ts`:

- `IconGenerator` - generator ikon UI
- `UiIcons` - collection kompozytów
- `SkinManager` - aktywny skin: `getColor()`, `getCrystal()`, `setActiveSkin()`, `applyCss()`
- `COLOR_GROUPS`, `ALL_COLORS`, `pickColor(seed)`, `getColorByHex(hex)` - paleta
- `getCategoryColor(category)`, `deriveDelegateCategory(toolsList)` - kategorie skilli/sub-agentów
- `SvgHelper` + `hexToRgbTriplet` - pomocnicze funkcje SVG
- `setSvg(el, svgMarkup)` / `setSvgLabel(el, svgMarkup, labelText)` - bezpieczne wstawianie ikon zamiast `el.innerHTML = ikona + ' ' + nazwa`. Tylko markup zaczynający się od `<svg` idzie przez parser (`SvgHelper.toElement`); reszta (emoji z YAML usera, ścieżki, nazwy narzędzi z zewnętrznych serwerów MCP) ląduje jako **text node**. `domUtils.ts` jest świadomie WOLNY od importu `obsidian` - barrel musi dać się załadować poza Obsidianem (patrz gotcha niżej).
- `adoptSheet(sheet, host?)` / `removeAdoptedSheets(host?)` - rejestr arkuszy CSS montowanych przez `document.adoptedStyleSheets`; `host` domyślnie to `document`
- `registerSettings(registry, plugin)` - rejestruje sekcję „Wygląd"

Reszta symboli modułu (m.in. `CrystalGenerator`, `SkinLoader`, oba definicje skinów, generator avatarów) świadomie NIE jest w barrelu - zero konsumentów spoza modułu. Avatar/kolor/ikonę pyta się dziś `SkinManager`, a on trzyma generator kryształów, loader skinów i oba skiny u siebie. Definicje żyją w bebechach.

`icons.ts` (`registerPkmIcon`) świadomie NIE jest re-eksportowany z `index.ts` - statycznie importuje `obsidian` (`addIcon`), co skaziłoby ten poza tym obsidian-free barrel i wywaliłoby każdy test AVA, który go ładuje tranzytywnie. Jedyny konsument to `src/main.ts` (kompozycja pluginu), który importuje plik bezpośrednio.

---

## Crystal Soul - koncept

Każdy agent dostaje:
- **Kryształ** - kształt SVG (8 rodzin w `CrystalGenerator.ts`: pryzmat, diament, igła, klaster, heksagon, podwójny, tarcza, odłamek - deterministyczny wybór wg seeda)
- **Kolor** - paleta 64 kolorów w 8 grupach po 8 (fiolety/błękity/turkusy/zielenie/czerwienie/pomarańcze/złota/neutralne)
- **Blask** - animacja (subtle, glow, pulse)

Razem to jego „dusza" wizualna w UI. Widoczne w:
- AgentSidebar (lista agentów)
- ChatView header (active agent)
- AgentProfileModal (preview)
- CommunicatorView (sidebar messages)

---

## Zależności

**Importuje z:**
- `core/utils/Logger.ts` (`log`) - `IconGenerator`, `SkinLoader`, `SkinManager`
- `core/i18n/index.ts` (`t`, `setLocale`) - `SettingsContent`, `SettingsSection`
- `core/index.ts` (barrel: `ensureAdapterFolder`, `parseYaml`) - `SettingsContent`, `SkinLoader`
- `obsidian` - `icons.ts` importuje `addIcon` naprawdę (dlatego świadomie NIE jest w barrelu, patrz komentarz w `index.ts`); `SkinLoader.ts`/`SkinManager.ts` importują **tylko typ** `Vault` (`import type`, zero na runtime)

Moduł NIE jest obsidian-free jako całość; jest obsidian-free tylko jako **barrel** (`index.ts` sam nie ciągnie `obsidian` na żadnej ścieżce importu).

**Importowany przez:**
- `modules/shell/` (AgentSidebar, sidebar views, modale)
- `modules/agents/` (AgentProfileModal, avatary), `modules/komunikator/CommunicatorView.ts`
- `modules/chat/` (chat_view + chat_* submoduły)
- `modules/onboarding/` (ikony/avatary w wizardzie)
- `src/main.ts` (`icons.ts` - rejestracja ikon Obsidiana; deep-import świadomie dozwolony, patrz komentarz w `index.ts`)

---

## Kluczowe decyzje

- **Kryształy SVG zamiast emoji jako avatar agenta** - profesjonalne, własne, skalowalne.
- **64 kolorów paleta** - hand-picked w 8 grupach po 8, żeby pasowały do siebie i były odróżnialne (color-blind friendly też).
- **`pickColor(seed)`** - deterministycznie wybiera kolor z palety na podstawie nazwy agenta. Stabilne między sesjami.
- **`core` nie importuje z `modules/`** - jedyny deep-import core→UiIcons to `src/main.ts`/`icons.ts`.

---

## Gotchas

- ⚠️ **`pickColor(seed)` deterministyczne** - zmiana seed (np. rename agenta) = zmiana koloru. Mitygacja: zachowaj stary `agent.color` w YAML zamiast pickować dynamicznie (ale obecnie nie wymuszane).
- ⚠️ **SVG render może być wolny** dla 20+ agentów na ekranie - performance optimization w przyszłości (lazy render, virtualization).
- ⚠️ **Animacje (`blask: pulse`)** - niektórzy users wolą static. Settings flag `disableAnimations` planowany, niezaimplementowany.
- ⚠️ **Barrel musi zostać WOLNY od `obsidian`.** Pakiet `obsidian` z npm to same typy (`"main": ""`), więc statyczny `import ... from 'obsidian'` w pliku re-eksportowanym z `index.ts` wywala testy AVA, które ładują barrel tranzytywnie. Dlatego `domUtils.ts` NIE używa `sanitizeHTMLToDom` z `obsidian`, tylko `SvgHelper.toElement` (DOMParser, inertny) + `appendText`. Ten sam powód co dla `icons.ts` (patrz komentarz w `index.ts`).
- ⚠️ **Konsumenci UI powinni pytać `SkinManager`** o avatar/kolor/ikonę. Bezpośrednie `CrystalGenerator` zostaje do generatorów i edytorów palety, ale nowe UI nie powinno robić hardcoded Crystal Soul.
- ⚠️ **Arkusz wchodzi do dokumentu WYŁĄCZNIE przez `adoptSheet()`** (`styleSheets.ts`). Dawny wzorzec „`if (!document.adoptedStyleSheets.includes(x)) document.adoptedStyleSheets = [...]`" nic nie odwracał: wyłączony plugin stylizował Obsidiana do restartu, a każdy cykl wyłącz/włącz dokładał kolejny arkusz (świeży bundle = świeży obiekt, więc `.includes` starego nie widzi). Dziś `adoptSheet` rejestruje arkusz, `removeAdoptedSheets()` w `onunload` zdejmuje komplet, a `SkinManager.dispose()` dokłada swój arkusz i znaczniki z `document.body`. **Nie wracaj do ręcznego dopychania tablicy** - arkusza spoza rejestru nie ma kto zdjąć.
- ⚠️ **`SkinManager.ensureSettings()` dosztukowuje domyślny skin do SUROWEGO worka** (`env.settingsStore.raw`), nie przez obserwowane proxy. Provisioning nie jest decyzją usera, a mutacja proxy planuje zapis CAŁEGO `.pkm-assistant/settings.json` (z kluczami API) sekundę po starcie - reguła „boot nie pisze". **`setActiveSkin()` pisze DALEJ przez proxy** - to wybór usera i ma przeżyć restart. Strażnik: `SkinManager.test.ts`.
- ⚠️ **Kolor z profilu agenta nie może wpisać markupu do SVG.** Generatory sklejają SVG stringiem (`fill="${color}"`), a `color` bierze się z pliku profilu agenta w vaultcie - wartość z cudzysłowem mogłaby zamknąć atrybut i dopisać własny element (np. `<image href="https://…">`, który po dołączeniu do żywego DOM-u strzela żądaniem na obcy serwer). `sanitizeSvgColor(color, fallback='currentColor')` (w `CrystalGenerator.ts`) przepuszcza tylko realne kształty: `#rgb`/`#rrggbb`/`#rrggbbaa`, `rgb()`/`rgba()`/`hsl()`/`hsla()`, `var(--x)`, nazwa CSS. Reszta → `currentColor`. Bramka stoi w `generate` **i** w `generateInner`.
- ⚠️ **`SvgHelper._scrub` ma allowlistę tagów, nie tylko `script`.** `_FORBIDDEN_TAGS` wycina `image`, `use`, `iframe`, `object`, `embed` i SMIL (`animate`, `animateTransform`, `animateMotion`, `set`) obok `script`/`foreignObject`, a z atrybutów leci KAŻDY zdalny `href`/`xlink:href`/`src` - zostaje wyłącznie lokalne `#id` (filtry glow generatorów działają dalej). Bez tego parser XML wpuszczałby payload z `<image href>`. Strażnik: `modules/crystal-soul/svgSafety.test.ts`.

## Powiązane

- `modules/agents/CLAUDE.md` - agenci używają Crystal Soul
- `modules/komunikator/CLAUDE.md` - UI z kryształami
- `modules/chat/CLAUDE.md` - chat header
