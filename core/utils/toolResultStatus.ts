/**
 * JEDEN kształt porażki narzędzia (AUD-bledy-027/058/025/013).
 *
 * W repo współżyją dwie konwencje: narzędzia wbudowane (`write`, `delete`, `read`, `list`,
 * `search`, `memory_*`, `kom_*`, `web_*`, `ask_user`, `delegate`) sygnalizują porażkę przez
 * `{success:false, error}`, a `MCPClient` (własny catch), wrapper external MCP i rodzina
 * `artifact_*`/`todo` przez `{isError:true, error}`. Warstwa prezentacji i telemetrii znała
 * WYŁĄCZNIE `isError`, więc nieudany zapis rysował się w czacie jako sukces — z zielonym
 * statusem i klikalnym linkiem do pliku, którego narzędzie nie zapisało.
 *
 * Kontrakt po naprawie:
 *  1. `MCPClient.executeToolCall` NORMALIZUJE — dopisuje `isError:true` porażce, NIE kasując
 *     `success`/`error`/reszty pól (testy narzędzi i `formatToolOutput` czytają je dalej).
 *  2. KAŻDY czytelnik statusu (status chipa, link do pliku, odtwarzanie historii, status
 *     kroku `tool.post` w biegu suba) pyta o wynik TĄ funkcją. Dwie kopie reguły rozjadą się
 *     przy pierwszej zmianie i wrócimy do „UI mówi co innego niż narzędzie".
 *
 * PORAŻKA to nie to samo co PUSTY WYNIK: wyszukiwanie bez trafień oddaje `success:true`
 * z pustą tablicą, nigdy `success:false`.
 *
 * Plik jest czysty (zero importów, w szczególności zero `obsidian`) — wolno go wciągnąć
 * do UI, do pętli, do runnera subów i do testów node'owych. Mieszka w `core/`, bo czytają go
 * TRZY moduły (`tools`, `chat`, `sub-agents`), a złota zasada barreli zabrania deep-importu
 * do cudzych bebechów; barrel `modules/tools/index.js` odpada podwójnie — ciągnie cały runtime
 * klienta, a `sub-agents` dostałby przez `DelegateTool` cykl importów.
 */

/** Status wyniku narzędzia w jedynej postaci, jakiej potrzebuje UI i telemetria. */
export type ToolResultStatus = 'success' | 'error';

/** Flagi, których szuka `toolResultStatus` — każda opcjonalna, bo kształty są narzędziowe. */
interface FlaggedToolResult {
    isError?: unknown;
    success?: unknown;
    error?: unknown;
}

/**
 * Status wyniku narzędzia. Porażką jest: `isError === true`, `success === false` albo
 * niepusty `error` przy braku jawnego `success: true` (kształt spoza obu konwencji).
 * Wynik nie-obiektowy (string z external MCP, `null`, tablica) = brak sygnału porażki.
 */
export function toolResultStatus(result: unknown): ToolResultStatus {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return 'success';
    const flagged = result as FlaggedToolResult;
    if (flagged.isError === true) return 'error';
    if (flagged.success === false) return 'error';
    if (flagged.success !== true && typeof flagged.error === 'string' && flagged.error.length > 0) return 'error';
    return 'success';
}

/**
 * Czy pod wynikiem `write` wolno narysować link „otwórz zapisany plik".
 *
 * Ścieżka pochodzi z ARGUMENTÓW wywołania, czyli z tego, co model CHCIAŁ zapisać — dlatego
 * link ma wisieć na powodzeniu operacji, a nie na samej obecności ścieżki. Bez tego nieudany
 * zapis dawał klikalny odnośnik do pliku, którego nie ma.
 */
export function shouldLinkWrittenFile(result: unknown, path: unknown): boolean {
    return typeof path === 'string' && path.length > 0 && toolResultStatus(result) !== 'error';
}
