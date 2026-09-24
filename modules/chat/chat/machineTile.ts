/**
 * @module machineTile
 * Render współdzielony dla kafelka systemowego wiadomości maszynowej (spec A3/A3-fix, "Czat bez
 * ścian" 2.3.0) - JEDNA implementacja wołana z TRZECH miejsc: `chat_messages.ts`'s
 * `append_message` (żywa wysyłka) i `render_messages` (historia), oraz `chat_streaming.ts`'s
 * `_chatBeforeContinue` (dren kolejki wiadomości - QUEUE INJECT renderuje bez przechodzenia przez
 * `append_message`). Do A3-fix każde z tych trzech miejsc miało WŁASNĄ kopię tej logiki (uwaga 5,
 * recenzja A3: "argument 'cykl importu' jest słaby - trzeci plik w module importowany przez oba
 * mixiny nie tworzy cyklu") - trzeci plik usuwa duplikat bez łamania złotej zasady (import tylko
 * z `index.js` poza modułem; WEWNĄTRZ modułu pliki importują się swobodnie, więc oba mixiny mogą
 * importować stąd bez tworzenia cyklu wartości między sobą).
 *
 * Ten plik sam nie importuje `obsidian`, ale barrel `ui-components` (createTile) ciągnie go
 * przechodnio - w AVA działa dzięki atrapie `obsidian` z repo harnessu (preload AVA) plus
 * własnej, minimalnej atrapie `document`, jak w `Tile.test.ts`.
 *
 * Akcja "Otwórz" (B2 + uwaga 4, spec A3-fix):
 *  - **B2** - ścieżka notatki artefaktu jest rozwiązywana PRZY RENDERZE, PRZED budową kafelka
 *    (`plugin.artifactStore.read(id)`, async - wołacze są już funkcjami `async`, więc `await`
 *    przed `createTile` jest tani i deterministyczny - zero migotania przycisku). Sklep nie zna
 *    `id` (JSON bez `id`, artefakt skasowany między wysłaniem powiadomienia a renderem) ->
 *    przycisk zostaje WIDOCZNY, ale `disabled`, z tooltipem i18n
 *    `chat.tile.machine.open_unavailable` (`Tile.ts`'s `TileAction.disabled`/`title`) - dawne
 *    zachowanie (przycisk całkiem nieobecny ALBO zawsze klikalny, mimo że klik kończył się
 *    Notice) było mylące: user nie miał jak odróżnić "nic tu nie ma" od "spróbuj kliknąć".
 *  - **uwaga 4** - klik idzie przez wspólny opener notatek (`openNoteWithRegistry`, jednostka C;
 *    fallback `plugin.openNote(path)`, gdy rejestr pusty) i nic więcej. Dawna wersja szła przez
 *    `activateArtifactInChat`, która ma TRZY skutki uboczne poza otwarciem notatki
 *    (`openChatView`, rozwinięcie prawego panelu, przypięcie artefaktu jako aktywnego w
 *    pierwszym znalezionym widoku czatu - `leaves[0]`, może nie być tym klikniętym przy kilku
 *    otwartych zakładkach) - żadnego z nich "Otwórz" nie potrzebuje, bo ścieżka jest już znana z
 *    rozwiązania przy renderze.
 */
import { createTile, openNoteWithRegistry } from '../../ui-components/index.js';
import { UiIcons } from '../../crystal-soul/index.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/index.js';
import type { MachineView } from './machineMessage.js';
import type { ChatViewLike } from './chatViewShape.js';

function _machineTileIcon(kind: MachineView['kind']): string {
    return kind === 'artifact_summon' ? UiIcons.file(14) : UiIcons.robot(14);
}

/**
 * Ustala ścieżkę notatki artefaktu (B2 fix) - `plugin.artifactStore.read(id)` jest jedyną drogą
 * "id -> ścieżka", ten sam kontrakt co picker artefaktów w `chat_ui.ts`. Brak sklepu / błąd
 * sklepu / artefakt nieznany -> `undefined` (fail-safe: przycisk wychodzi `disabled`, nie
 * wybucha render).
 */
async function _resolveArtifactPath(plugin: ChatViewLike['plugin'], artifactId: string): Promise<string | undefined> {
    try {
        const thin = await plugin.artifactStore?.read(artifactId);
        return thin?.path ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Renderuje kafelek systemowy wiadomości maszynowej (spec A3) do `container`. `view.open`
 * nieobecny (np. powiadomienie suba, które nigdy nie niesie akcji) - kafelek bez `actions`, jak
 * dotąd.
 */
export async function renderMachineTile(container: HTMLElement, plugin: ChatViewLike['plugin'], view: MachineView): Promise<void> {
    let action: { label: string; onClick: (ev: MouseEvent) => void; disabled?: boolean; title?: string } | undefined;
    if (view.open) {
        const { label, artifactId } = view.open;
        const path = await _resolveArtifactPath(plugin, artifactId);
        action = path
            ? {
                label,
                // Uwaga 4: TYLKO `openNote` - żadnych skutków ubocznych `activateArtifactInChat`
                // (bez przypinania artefaktu, bez odsłaniania panelu, bez przełączania widoku).
                onClick: (ev: MouseEvent) => {
                    // Jednostka C: ten sam opener co linki notatek (glowne okno, nowa karta); bez
                    // zarejestrowanego openera fallback na plugin.openNote.
                    if (openNoteWithRegistry(path, ev)) return;
                    void plugin.openNote(path).catch((e: unknown) => {
                        log.warn('Chat', `Nie udało się otworzyć artefaktu z kafelka: ${(e as Error)?.message || String(e)}`);
                    });
                },
            }
            : {
                label,
                disabled: true,
                title: t('chat.tile.machine.open_unavailable'),
                onClick: () => { /* disabled - Tile.ts nie dopina listenera w ogóle */ },
            };
    } else if (view.kind === 'artifact_summon') {
        // B2, druga runda recenzji A3-fix: JSON bez `id` albo uszkodzony - przycisk WIDOCZNY i wylaczony,
        // zeby user odroznil "nie ma czego otworzyc" od "sprobuj kliknac" (spec A3-fix, bloker B2).
        action = {
            label: t('chat.tile.machine.open'),
            disabled: true,
            title: t('chat.tile.machine.open_unavailable'),
            onClick: () => { /* disabled - Tile.ts nie dopina listenera */ },
        };
    }
    const tile = createTile({
        role: 'system',
        status: view.status,
        iconSvg: _machineTileIcon(view.kind),
        title: view.title,
        summary: view.summary,
        details: view.details,
        actions: action ? [action] : undefined,
    });
    container.appendChild(tile.el);
}
