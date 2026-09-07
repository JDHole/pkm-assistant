/**
 * `ReleaseNotesView` — widok „co nowego" (clean-room / F1, build-release).
 *
 * ŹRÓDŁO TREŚCI: statyczny `releases/latest_release.md`, WBUDOWANY do bundla przy
 * buildzie przez import z atrybutem `with { type: 'markdown' }`. Deklaracja typu tego
 * importu żyje w `modules/shell/markdown.d.ts` i ZOSTAJE. Skutek: brak pliku
 * `releases/latest_release.md` to BŁĄD BUILDA, nie błąd runtime — nie dokładać
 * runtime'owego fallbacku „gdy pusto".
 *
 * `open` NIE JEST tu nadpisywane — sygnatura bazy (`PluginItemView`) zostaje jedna
 * w całym repo (decyzja A4, cross-check §1.4). Podklasa dokłada tylko wygodny skrót
 * {@link ReleaseNotesView.openForVersion}, który woła bazę ze stanem `{ version }`.
 */
import { MarkdownRenderer } from 'obsidian';

import releaseNotesMarkdown from '../../releases/latest_release.md' with { type: 'markdown' };

import { log } from '../../core/utils/Logger.js';
import { PluginItemView } from '../ui-components/index.js';

/** Etykieta w logu. */
const SCOPE = 'ReleaseNotesView';

/** Klasa CSS kontenera notatek — hak dla arkusza stylów. */
const NOTES_CSS_CLASS = 'pkm-release-notes';

/**
 * Ścieżka źródłowa podawana rendererowi markdownu. Notatki wydania nie są notatką
 * z vaulta, więc nie ma czego rozwijać dla linków względnych — stąd pusto.
 */
const NO_SOURCE_PATH = '';

export class ReleaseNotesView extends PluginItemView {
    /**
     * B37: identyfikator zapisywany w układzie workspace'u usera (`workspace.json`).
     * ⚠️ Zmiana tego napisu = user traci otwartą kartę po aktualizacji.
     */
    static readonly viewType = 'pkm-release-notes-view';

    static readonly displayText = 'PKM Assistant';

    static readonly iconName = 'scroll-text';

    /** Treść wbudowana przy buildzie — patrz nagłówek pliku. */
    protected readonly notes: string = releaseNotesMarkdown;

    /**
     * Skrót wygodny — JEDYNY kształt wywołania u konsumenta (`src/main.ts`). Sprowadza
     * się do wywołania bazowego `open` ze stanem `{ version }`, żeby wersja dalej
     * jechała w `state` widoku bez rozszerzania kontraktu bazy o pojęcie „wersja".
     */
    static openForVersion(workspace: unknown, version: string): Promise<void> {
        return this.open(workspace, { version });
    }

    /**
     * Rysuje notatki jako markdown. Renderer Obsidiana dostaje `this` jako komponent
     * właściciela, więc wszystko, co dopnie (podglądy linków, bloki kodu), zostanie
     * sprzątnięte razem z zamknięciem karty.
     */
    async renderView(): Promise<void> {
        const target = this.container;
        target.empty();
        target.addClass(NOTES_CSS_CLASS);
        await this.paintMarkdown(this.notes, target);
    }

    /**
     * Jedyne miejsce, w którym ten widok rozmawia z rendererem Obsidiana.
     *
     * Pad renderu jest ZJADANY: notatki wydania to ekran informacyjny, a wyjątek
     * puszczony wyżej poleciałby przez `onOpen()` prosto w konsolę Obsidiana i wyglądał
     * jak awaria pluginu. User zostaje z pustą kartą, ślad zostaje w logu.
     */
    private async paintMarkdown(markdown: string, target: HTMLElement): Promise<void> {
        const { app } = this;
        try {
            await MarkdownRenderer.render(app, markdown, target, NO_SOURCE_PATH, this);
        } catch (e) {
            log.error(SCOPE, 'Render notatek wydania padł', e);
        }
    }
}
