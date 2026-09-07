# modules/multimodal/

**Audio + Image + Vision** (neutralne, generic). 3 obszary:
- **Audio STT** (Speech-to-Text) — 6 platform (`SttAdapter`)
- **Image Gen** — 6 platform (OpenRouter, DALL-E 3, Stability AI, Replicate Flux, Gemini Imagen 3, xAI)
- **Vision INPUT** — 3-warstwowy detektor modelu multimodalnego (`_is_model_multimodal()` w `modules/models/`), auto-strip images dla non-vision

> 🗑️ **E3.2 (2026-07-25):** ComfyUI wypadł z Image Gen razem z wywałką modułu `modules/comfy/`. Zostaje 6 platform chmurowych — zero lokalnego generatora, zero workflow builderów.

**Status:** 🚀 **ACTIVE.** Kod fizycznie w `modules/multimodal/` od Mapy-4 (2026-04-26).

**Sprint Refaktoru — który mnie dotyka:**
- [Sprint 01 Quick Wins + Security](../../Refaktor/Sprinty/SPRINT_01_Quick_Wins_Security.md) — Z4 Google STT _blobToBase64 ReferenceError fix (BUG-1 🔴)
- [Sprint 13a Security + Architecture](../../Refaktor/Sprinty/SPRINT_13a_Security_Architecture.md) — Oczko (active note attachment) → multimodal/active_note.js (CH-17 ARCH-7)
- [Sprint 13b Polish + Decyzje](../../Refaktor/Sprinty/SPRINT_13b_Polish_Decyzje.md) — ~12 multimodal drobnic

---

## Co tu jest (kod)

```
modules/multimodal/
├── SttAdapter.ts          # 6 platform STT (Groq, OpenAI, Google, Deepgram, AssemblyAI, Ollama-placeholder)
├── ImageGenAdapter.ts     # 6 platform image gen (OpenRouter, OpenAI DALL-E 3, Stability, Replicate, Gemini Imagen, xAI Grok Imagine)
├── AudioRecorder.ts       # MediaRecorder API recording component (klasa)
├── active_note.ts         # Oczko: kontekst aktywnej notatki + embedy obrazów (S13a CH-17)
├── index.ts               # barrel — public API
└── CLAUDE.md              # ten plik
```

Test jako sibling: `active_note.test.ts`.

> **TS-3 (2026-07-31)** — cały moduł jest w TypeScripcie. **Specifiery importów zostają z `.js`**
> (kontrakt kampanii: `./SttAdapter.js` wskazuje `SttAdapter.ts`) — konsumenci (`modules/chat`,
> `modules/tools`) nie zmieniali ani jednej linii. `active_note.ts` bierze `App`/`TFile` przez
> `import type` z `obsidian`, więc plik DALEJ nie wciąga obsidiana do runtime'u (jego test
> importuje go w gołym Node).

Razem **~840 LOC** (było ~1,080 — E3.2 wyciął 244 LOC ComfyUI z `ImageGenAdapter.js`).

**MCP tools korzystające z multimodal (poza modułem, w `modules/tools/`):**
- `GenerateImageTool.js` — agent woła z prompt → `generateImage()` (wynik zapisywany prosto do vaulta)
- `AddTextToImageTool.js` — dodaj tekst do obrazu (sesja 124)

**Settings:**
- `pkmAssistant.imageGen.platform` (default platform dla generate_image)
- `pkmAssistant.stt.platform` + `pkmAssistant.stt.language` (default platform + język dla STT)

---

## Public API

`modules/multimodal/index.ts` eksportuje (5, po przycince S30 Z4):

- **`transcribeAudio(platform, keys, audioBlob, language='pl')`** — funkcja, zwraca `{ text }`
- **`generateImage(platform, keys, params)`** — funkcja, zwraca `{ base64, format, revised_prompt? }`
- **`IMAGE_GEN_PLATFORMS`** — stała tablica `[{ id, name, requiresKey }]` — SSOT dla UI dropdownu **i walidacji platformy** w `modules/tools/GenerateImageTool.js`
- **`AudioRecorder`** — klasa, MediaRecorder API wrapper z callbackami `onComplete/onError/onTick`. Od E3.4 ma też **`cancel()`** — idempotentne przerwanie BEZ transkrypcji: synchronicznie zwalnia strumień mikrofonu i timer (strumień żyje w polu `this._stream`, sprzątany w `_cleanup()`). `ChatView.onClose` woła `cancel()` — wcześniej zamknięcie czatu w trakcie nagrywania zostawiało AKTYWNY mikrofon (bug prywatności, naprawiony w E3.4 D1).
- **Oczko (active note, S13a)** — `buildActiveNoteContext(app, opts?)` (kontekst aktywnej notatki + embedy obrazów dla chatu). **K23:** `opts.canReadImage?: (vaultPath) => boolean` bramkuje osadzone obrazy; brak = fail-closed, zero obrazów z osadzeń (gotcha niżej)

> **S30 Z4 — eksporty WYCIĘTE z barrela** (zero konsumentów spoza modułu):
> `readVaultImageAsBlock`, `extractEmbeddedImagePaths` — obie funkcje obrazkowe wołane są
> przez `buildActiveNoteContext` w `active_note.js`; test `active_note.test.js` deep-importuje
> plik wprost.
> ⚠️ Uwaga na asymetrię: `IMAGE_GEN_PLATFORMS` **zostaje**, bo `GenerateImageTool` naprawdę
> na niej stoi (walidacja odrzucająca osierocone `comfyui`); dropdown STT stoi na osobnej,
> ręcznie utrzymywanej liście w `modules/tools/SettingsContent.ts` (`sttPlatforms`).
>
> **Fabryka dead-code D7 (2026-09-02, AUD-dead-code-074/193):** `STT_PLATFORMS`
> (+ interfejs `SttPlatform`, który istniał wyłącznie żeby ją otypować) SKASOWANE z
> `SttAdapter.ts` w całości, nie tylko wycięte z barrela — poprzednia wersja tego akapitu
> TWIERDZIŁA, że „`STT_PLATFORMS` czyta `SttAdapter` u siebie", co było **nieprawdą**: stała
> nie miała żadnego czytelnika, nawet wewnątrz pliku (i sprzecznie z tym samym akapitem pięć
> linii niżej, który już wtedy poprawnie mówił „`STT_PLATFORMS` takiego wołacza nie ma"). Dwie
> listy platform STT rozjechały się dawno temu: martwa miała 6 wpisów bez `disabled` i twardy
> polski string `'Groq Whisper (najszybszy)'` poza i18n; żywa (`sttPlatforms` w
> `SettingsContent.ts`) ma 7 wpisów przez `t()`. Kto dokłada siódmą platformę STT — edytuje
> WYŁĄCZNIE `SettingsContent.ts`, ta lista jest jedynym SSOT-em dropdownu.

Plus **typy** (TS-3, `export type` — zero emitu): `SttKeys`, `Transcription`,
`ImageGenKeys`, `ImageGenParams`, `GeneratedImage`, `ImageGenPlatform`, `AudioRecorderOptions`,
`ImageUrlBlock`, `ActiveNoteContext`.

**Vision INPUT detection (`_is_model_multimodal`)** żyje w `modules/models/adapters/chat_adapter_base.js`. To detekcja per-model, nie operacja multimodalna.

---

## Zależności

**Importuje z:**
- `core/utils/Logger.js` (log)
- `core/i18n/index.js` (t)
- `core/index.js` (`blobToBase64`, `arrayBufferToBase64`) — generic binary util. **S31 Z4:** plik przeniesiony z `src/utils/binaryUtils.js` do `core/utils/`, a trzej konsumenci tego modułu (`SttAdapter.js`, `ImageGenAdapter.js`, `active_note.js`) biorą go przez barrel core, nie deep-importem
- `obsidian` (`requestUrl` — CORS-free HTTP)

**Importowany przez (przez barrel `modules/multimodal/index.js`; część ścieżek sprzed migracji `src/` → `modules/`):**
- `modules/chat/chat/chat_model.js` — `AudioRecorder`, `transcribeAudio` (mikrofon button + STT pipeline) + Oczko
- `modules/tools/GenerateImageTool.js` — `generateImage`, `IMAGE_GEN_PLATFORMS`
- (`AddTextToImageTool.js` nie używa multimodal — operuje na obrazie już istniejącym)

**Splot z innymi modułami (luźny):**
- `modules/models/` — `_is_model_multimodal()` żyje tam (vision detection per-model, nie operacja multimodalna)

---

## Kluczowe decyzje

- **Tylko generyczne image gen (E3.2)**: moduł `comfy` (ComfyUI + Zoja Command Center) skasowany w całości. Multimodal nie ma już żadnego splotu z lokalnym generatorem — dispatch to 6 platform chmurowych i tyle.
- **Vision INPUT detekcja w `modules/models/`** — `_is_model_multimodal()` nie jest tutaj, bo to jest detekcja czy model wspiera vision (per-model decision), a nie operacja multimodalna.
- **`_buildFormData()` zwraca `{body, boundary}`** (sesja 106 fix): Stability AI + niektóre platformy potrzebują explicit Content-Type z boundary. Inaczej upload zawisał.

---

## Gotchas

- ⚠️ **`_buildFormData` boundary forwarding** (sesja 106) — jak modyfikujesz request multipart, zachowaj `Content-Type: multipart/form-data; boundary=...` dokładnie. Inaczej cloud providers odrzucają.
- ⚠️ **Auto-strip images dla non-vision models** (sesja 101-103) — tylko warning, nie error. Agent dostaje pusty content image.
- ⚠️ **STT języki** — niektóre platformy (Groq) wymagają explicit language code. Bez tego transkrypcja po angielsku nawet jak nagrywałeś po polsku.
- ⚠️ **AudioRecorder permissions** — przeglądarka pyta o mikrofon. Pierwsza sesja może być problemowa.
- ⚠️ **K9 (2026-08-22): `buildActiveNoteContext` oddaje `text` ZAWSZE w ogrodzeniu.** Oczko wkleja
  nazwe pliku, frontmatter i do 2000 znakow body aktywnej notatki na KONIEC promptu systemowego
  (`chat_streaming`), wiec kazdy naglowek z notatki bylby naglowkiem promptu (AUD-security-002).
  Producent owija wynik w `<vault_content source="active_note">` przez `fenceUntrusted`
  (`core/security/promptFence.ts`, barrel `core/index.js`) — funkcja escapuje znacznik z wnetrza
  tresci, wiec nie da sie go zamknac od srodka. Dokladajac tu nowa galaz zwracajaca `text`,
  przepusc ja przez `fenceActiveNote` — inaczej ten kanal znow ominie ogrodzenie.
- ⚠️ **K23 (2026-08-23): Oczko ma DWIE bramki i pilnują różnych rzeczy.** `text` jest ogrodzony
  (K9 wyżej — obrona przed wstrzyknieciem instrukcji), a `images` z OSADZEN `![[...]]` przechodza
  przez **wstrzykiwany predykat `opts.canReadImage`** (obrona przed wyniesieniem pliku, ktorego
  agent nie ma prawa czytac — AUD-security-119). Do K23 osadzenia szly prosto do `vault.readBinary`:
  notatka z zewnatrz (clipper, sync, plik od kogos) z `![[Prywatne/skan.png]]` wysylala bajty
  ze strefy No-Go do dostawcy modelu po jednym otwarciu notatki. **Brak predykatu = ZERO obrazow
  z osadzen** (fail-closed) — nowy wolacz, ktory go zapomni, dostanie sam tekst, nie komplet
  obrazow. Predykat buduje WOLACZ (`modules/chat/chat/chat_model.ts`) z pelnego
  `PermissionSystem.checkPermission(agent, 'vault.read', path)`; ten modul **nie importuje
  `core/security`** i ma tak zostac — jego test chodzi w golym Node.
  Granica idzie po INTENCJI USERA: aktywny plik user otworzyl sam (jego wybor), osadzenia
  wciaga za nim tresc notatki, ktora mogl napisac ktokolwiek — dlatego bramkujemy osadzenia,
  a nie sam otwarty plik.
- ⚠️ **K2 (2026-08-22): o ścieżce zapisu obrazu decyduje `modules/tools/`, nie ten moduł.** Adaptery
  (`ImageGenAdapter`) oddają bajty; folder zapisu (`saveFolder`) i `output_path` walidują narzędzia
  `generate_image` / `add_text_to_image` przez `validateVaultPath`, a bramce uprawnień oddają CEL
  ZAPISU (dawniej: prompt i ścieżkę źródłową). Dokładając tu generowanie plików, przeprowadź ścieżkę
  tą samą drogą — inaczej zapis znów ominie whitelistę, No-Go i blokadę `.pkm-assistant/`.

---

## TODO

→ Pełen backlog: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md)

**Najważniejsze otwarte (po Mapa-4, 2026-04-26):**
- ✅ **BUG-1** — Google STT runtime crash: `_blobToBase64` nie istnieje (linia 164, 1-character fix) → **FIXED Sprint 01 Z4** (commit `71833da`)
- 🟠 **UX-1** — Ollama STT listowane mylnie jako dostępne (rzuca "not supported")
- 🟠 **ARCH-1** — duplikacja multipart helpera (2 różne implementacje)
- ✅ **ARCH-2** — splot ComfyUI workflow builders między multimodal a `modules/comfy/` → **MOOT (E3.2)**: buildery i cały moduł `comfy` skasowane

## Powiązane

- `modules/models/CLAUDE.md` — `_is_model_multimodal()` detekcja vision

## Historia

- **Sesja 101-103** — multimodal complete (Vision + Image Gen + Audio STT)
- **Sesja 106** — fix `_buildFormData` boundary
- **Sesja 124** — ComfyUI Preview Modal + AddTextToImageTool (Preview Modal skasowany w E3.2)
- **Sesja 128 D6** (2026-04-25) — placeholder rozbudowany do wzorca
- **Mapa-4 (2026-04-26)** — przenosiny `src/` → `modules/multimodal/` (3 pliki + barrel `index.js` + 2 importerów na barrel), commit `441014f`. Naprawione kłamstwo placeholdera D6 ("klasy" → "funkcje + stałe + 1 klasa"). 13 znalezisk → TODO (1×🔴 BLOCKER bug Google STT, 3×🟠, 3×🟡, 6×🟢). 3 atomic Nauka cards w Hogwarcie. Brak nowej Wizji przekrojowej — splot luźny. Sesja Mapa-4 oryginalnie oznaczona Mapa-3, przemianowana po fakcie bo równolegle leciała sesja Mapa-3 artifacts.

## Sprint 13a update (2026-05-07)
- WebSearchProvider lives in modules/web/; Web Search settings are registered by modules/web/.
- Oczko active-note context now lives in modules/multimodal/active_note.js; chat calls the multimodal public API.

## E1.6 docs-freshness (2026-07-21)
- Dopisano `active_note.js` (Oczko, S13a) do struktury + Public API (`buildActiveNoteContext`/`readVaultImageAsBlock`/`extractEmbeddedImagePaths`); LOC ~909 → ~1,080. Ścieżki `_is_model_multimodal` (`modules/models/adapters/chat_adapter_base.js`) i MCP tools/importerów (`modules/mcp/`, `modules/chat/`) zsynchronizowane. `src/utils/binaryUtils.js` **wciąż istnieje** — bez zmian. Kod modułu bez zmian.


## E3.2 update (2026-07-25) — ComfyUI wycięte, zostaje 6 platform chmurowych
- `ImageGenAdapter`: `case 'comfyui'` + `_comfyui()` + `generateComfyPreview()` + `_extractComfyImages()` + `_pollComfyUI()` + `_buildComfyWorkflow()` + `_buildFluxWorkflow()` SKASOWANE (553 → 309 LOC). Wpis `comfyui` wypadł z `IMAGE_GEN_PLATFORMS`.
- `index.ts` nie eksportuje już `generateComfyPreview` — barrel to `generateImage` + `IMAGE_GEN_PLATFORMS` (+ STT, AudioRecorder, Oczko).
- Konsekwencja dla `generate_image`: nie ma trybu „podgląd w modalu", każda platforma zapisuje obraz od razu do vaulta. Zapisana w danych usera platforma `comfyui` jest odrzucana z listą dostępnych platform (test regresyjny: `modules/tools/GenerateImageTool.test.js`).

## TS-3 update (2026-07-31) — moduł na TypeScript

- 5 plików źródłowych + 1 test przeniesione `git mv` na `.ts`, `strict`, **zero `any`**. Zero zmian zachowania: esbuild wypluwa z `.ts` bajt w bajt to samo wyjście, co z dawnych `.js`.
- **Pola klasy `AudioRecorder` są zadeklarowane przez `declare`** (nie zwykłą deklaracją pola). Przy `useDefineForClassFields: true` zwykłe pole wyemitowałoby `Object.defineProperty` PRZED ciałem konstruktora — a tu wszystko nadaje konstruktor, dokładnie jak w JS. Nie zmieniaj tego na zwykłe pola.
- **`MediaRecorder.onerror` w lib.dom jest typowane jako gołe `Event`**, choć spec (i runtime) niesie `MediaRecorderErrorEvent` z polem `error`. Czytamy je przez asercję w miejscu użycia — nie przez `any`.
- `ImageGenKeys` jest SSOT-em dla `ImageGenPlatform.requiresKey: keyof ImageGenKeys` — literówka
  w nazwie klucza w `IMAGE_GEN_PLATFORMS` to błąd typechecku. `SttKeys` pełniło analogiczną rolę
  dla `SttPlatform`/`STT_PLATFORMS`, dopóki oba istniały (fabryka dead-code D7: skasowane,
  `SttKeys` zostaje — parametr `keys` funkcji `transcribeAudio` jest nim wciąż typowany).
