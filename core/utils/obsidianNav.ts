/**
 * Nawigacja po notatkach (PL-10) — następca `obsidian_helpers`.
 *
 * ⚠️ Plik dotyka `obsidian` jako WARTOŚCI, więc NIE wchodzi do barrela `core/index.ts`
 * (kontrakt node-safe K-01/K-03). Deep-importuje go wyłącznie composition root.
 */
import { Keymap } from 'obsidian';

import { log } from './Logger.js';
import type { AppLike } from '../runtime/contracts.js';

const SCOPE = 'obsidianNav';

/** Gdzie ma się otworzyć notatka; `false` = w bieżącej karcie. */
type Target = false | 'tab' | 'split' | 'window';

/** Workspace w zakresie, jakiego dotyka nawigacja (Obsidian daje tu więcej). */
interface NavWorkspace {
    openLinkText?(
        linktext: string,
        sourcePath: string,
        newLeaf?: Target,
        openViewState?: { state?: Record<string, unknown> },
    ): Promise<void>;
}

/**
 * `App` albo cokolwiek, co je niesie w polu `app`.
 *
 * Composition root podaje SIEBIE (`openNote(this, …)`), bo klasa pluginu jest dla niego
 * jednym uchwytem na całe API Obsidiana. Rozpakowanie jest tutaj, a nie u wołacza, żeby
 * pomyłka w tę stronę nie kończyła się cichym „nic się nie otworzyło".
 */
function resolveApp(source: AppLike | { app?: AppLike } | null | undefined): AppLike | null {
    if (!source) return null;
    const nested = (source as { app?: AppLike }).app;
    const app = (nested && typeof nested === 'object' ? nested : source) as AppLike;
    return app.workspace ? app : null;
}

/**
 * Czyta z zdarzenia, gdzie user chce otworzyć notatkę.
 *
 * Modyfikatory zna Obsidian (`Keymap.isModEvent` respektuje ustawienie usera „Ctrl otwiera
 * nową kartę / podział"), więc nie zgadujemy ich sami. Zostaje jedno, czego `Keymap` nie
 * obsługuje: klik ŚRODKOWYM przyciskiem, który w każdej przeglądarce i w Obsidianie znaczy
 * „nowa karta".
 */
function resolveTarget(event: unknown): Target {
    const evt = event as { button?: number } | null | undefined;
    if (!evt || typeof evt !== 'object') return false;
    if (evt.button === 1) return 'tab';
    try {
        const fromKeymap = Keymap.isModEvent(evt as MouseEvent);
        if (fromKeymap === true) return 'tab';
        if (fromKeymap === 'tab' || fromKeymap === 'split' || fromKeymap === 'window') return fromKeymap;
    } catch {
        // Zdarzenie spoza Obsidiana (test, wywołanie programowe) — bieżąca karta.
    }
    return false;
}

async function openLink(
    source: AppLike | { app?: AppLike } | null | undefined,
    path: string,
    target: Target,
    viewState?: { state?: Record<string, unknown> },
): Promise<void> {
    const app = resolveApp(source);
    if (!app || typeof path !== 'string' || !path.trim()) {
        log.warn(SCOPE, `Nie otwieram notatki — brak workspace'u albo ścieżki (${String(path)})`);
        return;
    }
    const workspace = app.workspace as NavWorkspace;
    if (typeof workspace.openLinkText !== 'function') {
        log.warn(SCOPE, 'Workspace bez openLinkText — nawigacja nieczynna');
        return;
    }
    try {
        // Drugi argument to ścieżka źródłowa dla linków względnych; nawigujemy zawsze
        // ścieżką pełną od korzenia vaulta, więc źródło jest puste.
        await workspace.openLinkText(path, '', target, viewState);
    } catch (e) {
        log.error(SCOPE, `Nie udało się otworzyć "${path}"`, e);
    }
}

/** Otwiera notatkę; modyfikatory klawiatury decydują o nowej karcie / splicie. */
export function openNote(app: AppLike, path: string, event?: unknown): Promise<void> {
    return openLink(app, path, resolveTarget(event));
}

/** Otwiera plik źródłowy notatki w trybie źródła. */
export function openSource(app: AppLike, path: string): Promise<void> {
    return openLink(app, path, false, { state: { mode: 'source' } });
}
