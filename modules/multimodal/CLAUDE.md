# modules/multimodal/

**Audio + Image + Vision** (neutralne, generic). 3 obszary:
- **Audio STT** (Speech-to-Text) - 6 platform (`SttAdapter`)
- **Image Gen** - 6 platform (OpenRouter, DALL-E 3, Stability AI, Replicate Flux, Gemini Imagen 3, xAI)
- **Vision INPUT** - detektor modelu multimodalnego (`_is_model_multimodal()` w `modules/models/`), auto-strip images dla non-vision

Image Gen ma wyłącznie platformy chmurowe - zero lokalnego generatora, zero workflow builderów.

---

## Co tu jest

```
modules/multimodal/
├── SttAdapter.ts          # 6 platform STT (Groq, OpenAI, Google, Deepgram, AssemblyAI, Ollama-placeholder)
├── ImageGenAdapter.ts     # 6 platform image gen (OpenRouter, OpenAI DALL-E 3, Stability, Replicate, Gemini Imagen, xAI Grok Imagine)
├── AudioRecorder.ts       # MediaRecorder API recording component (klasa)
├── active_note.ts         # Oczko: kontekst aktywnej notatki + embedy obrazów
├── index.ts               # barrel - public API
└── CLAUDE.md              # ten plik
```

Test jako sibling: `active_note.test.ts`.

Cały moduł jest w TypeScripcie. **Specifiery importów zostają z `.js`** (konwencja repo: `./SttAdapter.js` wskazuje `SttAdapter.ts`) - konsumenci (`modules/chat`, `modules/tools`) nie zmieniają importów przy tym. `active_note.ts` bierze `App`/`TFile` przez `import type` z `obsidian`, więc plik DALEJ nie wciąga obsidiana do runtime'u (jego test importuje go w gołym Node).

**MCP tools korzystające z multimodal (poza modułem, w `modules/tools/`):**
- `GenerateImageTool.ts` - agent woła z prompt → `generateImage()` (wynik zapisywany prosto do vaulta)
- `AddTextToImageTool.ts` - dodaj tekst do obrazu

**Settings:**
- `pkmAssistant.imageGen.platform` (default platform dla generate_image)
- `pkmAssistant.stt.platform` + `pkmAssistant.stt.language` (default platform + język dla STT)

---

## Public API

`modules/multimodal/index.ts` eksportuje:

- **`transcribeAudio(platform, keys, audioBlob, language='pl')`** - funkcja, zwraca `{ text }`
- **`generateImage(platform, keys, params)`** - funkcja, zwraca `{ base64, format, revised_prompt? }`
- **`IMAGE_GEN_PLATFORMS`** - stała tablica `[{ id, name, requiresKey }]` - SSOT dla UI dropdownu **i walidacji platformy** w `modules/tools/GenerateImageTool.ts`
- **`AudioRecorder`** - klasa, MediaRecorder API wrapper z callbackami `onComplete/onError/onTick`. Ma też **`cancel()`** - idempotentne przerwanie BEZ transkrypcji: synchronicznie zwalnia strumień mikrofonu i timer (strumień żyje w polu `this._stream`, sprzątany w `_cleanup()`). `ChatView.onClose` woła `cancel()` - bez tego zamknięcie czatu w trakcie nagrywania zostawiało AKTYWNY mikrofon (bug prywatności).
- **Oczko (active note)** - `buildActiveNoteContext(app, opts?)` (kontekst aktywnej notatki + embedy obrazów dla chatu). `opts.canReadImage?: (vaultPath) => boolean` bramkuje osadzone obrazy; brak = fail-closed, zero obrazów z osadzeń (gotcha niżej)

`readVaultImageAsBlock` i `extractEmbeddedImagePaths` świadomie NIE są w barrelu (zero konsumentów spoza modułu) - obie funkcje obrazkowe wołane są przez `buildActiveNoteContext` w `active_note.ts`; test `active_note.test.ts` deep-importuje plik wprost.

`IMAGE_GEN_PLATFORMS` **zostaje** w barrelu, bo `GenerateImageTool` naprawdę na niej stoi (walidacja odrzucająca nieznane platformy); dropdown STT stoi na osobnej, ręcznie utrzymywanej liście w `modules/tools/SettingsContent.ts` (`sttPlatforms`) - `SttAdapter.ts` nie ma własnej listy platform STT eksportowanej publicznie; kto dokłada siódmą platformę STT, edytuje WYŁĄCZNIE `SettingsContent.ts`, ta lista jest jedynym SSOT-em dropdownu.

Plus **typy** (`export type` - zero emitu): `SttKeys`, `Transcription`, `ImageGenKeys`, `ImageGenParams`, `GeneratedImage`, `ImageGenPlatform`, `AudioRecorderOptions`, `ImageUrlBlock`, `ActiveNoteContext`.

**Vision INPUT detection (`_is_model_multimodal`)** żyje w `modules/models/adapters/chat_adapter_base.ts`. To detekcja per-model, nie operacja multimodalna.

---

## Zależności

**Importuje z:**
- `core/utils/Logger.ts` (log)
- `core/i18n/index.ts` (t)
- `core/index.ts` (`blobToBase64`, `arrayBufferToBase64`) - generic binary util, konsumenci tego modułu (`SttAdapter.ts`, `ImageGenAdapter.ts`, `active_note.ts`) biorą go przez barrel core, nie deep-importem
- `obsidian` (`requestUrl` - CORS-free HTTP)

**Importowany przez (przez barrel `modules/multimodal/index.ts`):**
- `modules/chat/chat/chat_model.ts` - `AudioRecorder`, `transcribeAudio` (mikrofon button + STT pipeline) + Oczko
- `modules/tools/GenerateImageTool.ts` - `generateImage`, `IMAGE_GEN_PLATFORMS`
- (`AddTextToImageTool.ts` nie używa multimodal - operuje na obrazie już istniejącym)

**Splot z innymi modułami (luźny):**
- `modules/models/` - `_is_model_multimodal()` żyje tam (vision detection per-model, nie operacja multimodalna)

---

## Kluczowe decyzje

- **Tylko generyczne image gen.** Moduł nie ma żadnego splotu z lokalnym generatorem obrazów - dispatch to 6 platform chmurowych i tyle.
- **Vision INPUT detekcja w `modules/models/`** - `_is_model_multimodal()` nie jest tutaj, bo to jest detekcja czy model wspiera vision (per-model decision), a nie operacja multimodalna.
- **`_buildFormData()` zwraca `{body, boundary}`**: Stability AI + niektóre platformy potrzebują explicit Content-Type z boundary. Inaczej upload zawisał.

---

## Gotchas

- ⚠️ **`_buildFormData` boundary forwarding** - jak modyfikujesz request multipart, zachowaj `Content-Type: multipart/form-data; boundary=...` dokładnie. Inaczej cloud providers odrzucają.
- ⚠️ **Auto-strip images dla non-vision models** - tylko warning, nie error. Agent dostaje pusty content image.
- ⚠️ **STT języki** - niektóre platformy (Groq) wymagają explicit language code. Bez tego transkrypcja po angielsku nawet jak nagrywałeś po polsku.
- ⚠️ **AudioRecorder permissions** - przeglądarka pyta o mikrofon. Pierwsza sesja może być problemowa.
- ⚠️ **`buildActiveNoteContext` oddaje `text` ZAWSZE w ogrodzeniu.** Oczko wkleja nazwę pliku, frontmatter i do 2000 znaków body aktywnej notatki na KONIEC promptu systemowego (`chat_streaming`), więc każdy nagłówek z notatki byłby nagłówkiem promptu. Producent owija wynik w `<vault_content source="active_note">` przez `fenceUntrusted` (`core/security/promptFence.ts`, barrel `core/index.js`) - funkcja escapuje znacznik z wnętrza treści, więc nie da się go zamknąć od środka. Dokładając tu nową gałąź zwracającą `text`, przepuść ją przez `fenceActiveNote` - inaczej ten kanał znów ominie ogrodzenie.
- ⚠️ **Oczko ma DWIE bramki i pilnują różnych rzeczy.** `text` jest ogrodzony (wyżej - obrona przed wstrzyknięciem instrukcji), a `images` z OSADZEŃ `![[...]]` przechodzą przez **wstrzykiwany predykat `opts.canReadImage`** (obrona przed wyniesieniem pliku, którego agent nie ma prawa czytać). Bez tego predykatu osadzenia szłyby prosto do `vault.readBinary`: notatka z zewnątrz (clipper, sync, plik od kogoś) z `![[Prywatne/skan.png]]` wysyłałaby bajty ze strefy No-Go do dostawcy modelu po jednym otwarciu notatki. **Brak predykatu = ZERO obrazów z osadzeń** (fail-closed) - wołacz, który go zapomni, dostanie sam tekst, nie komplet obrazów. Predykat buduje WOŁACZ (`modules/chat/chat/chat_model.ts`) z pełnego `PermissionSystem.checkPermission(agent, 'vault.read', path)`; ten moduł **nie importuje `core/security`** i ma tak zostać - jego test chodzi w gołym Node.
  Granica idzie po INTENCJI USERA: aktywny plik user otworzył sam (jego wybór), osadzenia wciągają za nim treść notatki, którą mógł napisać ktokolwiek - dlatego bramkujemy osadzenia, a nie sam otwarty plik.
- ⚠️ **O ścieżce zapisu obrazu decyduje `modules/tools/`, nie ten moduł.** Adaptery (`ImageGenAdapter`) oddają bajty; folder zapisu (`saveFolder`) i `output_path` walidują narzędzia `generate_image` / `add_text_to_image` przez `validateVaultPath`, a bramce uprawnień oddają CEL ZAPISU. Dokładając tu generowanie plików, przeprowadź ścieżkę tą samą drogą - inaczej zapis znów ominie whitelistę, No-Go i blokadę `.pkm-assistant/`.

## Znane ograniczenia

- Ollama STT jest listowane jako dostępna platforma, mimo że rzuca „not supported" w praktyce.
- Multipart helper (`_buildFormData` i pokrewne) ma zduplikowaną implementację między adapterami - kandydat do konsolidacji.

## Powiązane

- `modules/models/CLAUDE.md` - `_is_model_multimodal()` detekcja vision
