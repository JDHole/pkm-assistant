/**
 * Okno hosta — jedyny most między Obsidianem a gołym Node dla timerów, `fetch`, WebCrypto itd.
 *
 * PO CO: reguły recenzenta katalogu Obsidiana (`obsidianmd/no-global-this`,
 * `obsidianmd/prefer-window-timers`) każą sięgać po `window` (okna popout mają własny
 * global), a ten sam kod `core/` i `modules/` jedzie też w Node — testy AVA i harness
 * bootują plugin bez Obsidiana. Tam `window` z natury nie istnieje, więc KAŻDY kontekst
 * Node, który naprawdę wykonuje kod pluginu, dostarcza je sam:
 *   * testy AVA — `test-support/register-obsidian-for-ava.mjs` (od 2026-09-11 lokator: znajduje
 *     checkout harnessu i importuje stamtąd właściwy preload, który ustawia okno = global Node),
 *   * harness „Szklane Pudło" (osobne repo, https://github.com/JDHole/pkm-assistant-harness) —
 *     jego WŁASNY `test-support/dom-shim.ts` (to samo, plus atrapa `document`).
 * Jedyny kontekst BEZ okna to test importu barrela (`core/index_node_safe.test.ts`), który
 * tylko ładuje moduły — dlatego most nie może rzucać przy imporcie, tylko przy użyciu.
 *
 * UŻYCIE: `hostWindow.setTimeout(...)`, `hostWindow.fetch(...)`, `hostWindow.crypto`.
 * Nie zamrażaj pojedynczych funkcji w stałych modułu (`const f = hostWindow.fetch`) —
 * testy podmieniają `fetch` PO załadowaniu modułu i zamrożona referencja omijałaby podmianę.
 * `typeof window` jest tu jedynym dozwolonym „pytaniem o okno" w kodzie pluginu.
 *
 * UWAGA (kolejność importów): wartość jest zamrażana W CHWILI IMPORTU tego modułu. Kontekst
 * Node, który dostarcza okno (preload AVA, dom-shim harnessu), musi ustawić `window` ZANIM
 * załaduje cokolwiek z pluginu — statyczne importy są hoistowane, dlatego preload AVA importuje
 * moduły pluginu dynamicznie (`await import()`), już po ustawieniu okna.
 */
export const hostWindow: Window = typeof window !== 'undefined' ? window : (undefined as unknown as Window);

/**
 * Uchwyt timera z `hostWindow.setTimeout`/`setInterval`. Typowany po przeglądarkowej stronie mostu
 * (liczba); w Node pod spodem siedzi obiekt `Timeout`, ale kod pluginu nie ma go dotykać inaczej
 * niż przez `hostWindow.clearTimeout`/`clearInterval`.
 */
export type HostTimer = ReturnType<Window['setTimeout']>;
