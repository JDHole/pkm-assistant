/**
 * `waitForLayoutReady` — czekanie na gotowość layoutu Obsidiana, wyłuskane z `PluginRuntime`.
 *
 * DLACZEGO OSOBNY PLIK: `PluginRuntime.ts` importuje `obsidian`, więc nie wstaje w AVA
 * (testy nie mają mocka `obsidian`). Ten plik nie importuje NICZEGO — dzięki temu
 * jedyny kawałek logiki startu, który da się sprawdzić naprawdę (a nie regexem po
 * źródle), jest sprawdzany naprawdę. `PluginRuntime.whenLoaded_layout_ready()` jest cienką
 * otoczką na tę funkcję.
 *
 * DLACZEGO W OGÓLE (naprawa 2026-08-23): start pluginu czekał wcześniej na DWA
 * dwa ślepe zegary odziedziczone po starym starcie (5000 ms + 3000 ms). Oba zastąpiło jedno
 * zdarzenie: `workspace.onLayoutReady`. Obsidian woła podany callback natychmiast,
 * jeśli layout już stoi, a w przeciwnym razie dokładnie wtedy, gdy stanie —
 * więc plugin czeka tyle, ile trzeba, i ani milisekundy dłużej.
 *
 * Poza Obsidianem (harness, testy, dry-boot w Node) workspace'u nie ma albo nie ma
 * on `onLayoutReady` — wtedy funkcja rozwiązuje się od razu. Bez tej gałęzi boot
 * poza Obsidianem zawisłby na zawsze.
 *
 * NIE eksportowane przez `core/index.ts` — konsument jest jeden i siedzi wewnątrz
 * `core/`, więc importuje wprost (złota zasada dotyczy wejścia Z ZEWNĄTRZ modułu).
 */

/** Minimalny kształt, którego tu potrzebujemy — `Workspace` Obsidiana go spełnia. */
export interface LayoutReadySource {
  onLayoutReady?: (callback: () => void) => void;
}

/**
 * Rozwiązuje się, gdy layout Obsidiana jest gotowy.
 * Brak workspace'u / brak `onLayoutReady` (kontekst bez Obsidiana) = resolve natychmiast.
 */
export function waitForLayoutReady(workspace?: LayoutReadySource | null): Promise<void> {
  const onLayoutReady = workspace?.onLayoutReady;
  if (typeof onLayoutReady !== 'function') return Promise.resolve();
  return new Promise<void>((resolve) => {
    // `.call(workspace, …)` — `onLayoutReady` to metoda Workspace'u; wywołanie
    // przez samą referencję zgubiłoby `this` i wywaliło się w prawdziwym Obsidianie.
    onLayoutReady.call(workspace, () => resolve());
  });
}
