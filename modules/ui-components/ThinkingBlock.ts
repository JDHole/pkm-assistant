
import { UiIcons } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import { createTile } from './Tile.js';
import type { TileHandle } from './Tile.js';

/** Element `.cs-tile__details` z prywatnym expando polem, którym `updateThinkingBlock`
 *  pamięta ostatnio wpisaną treść NA ELEMENCIE (nie czyta `textContent` — jego getter jest O(n),
 *  patrz komentarz niżej). Zwykłe rozszerzenie `HTMLElement`, nie osobny typ DOM-u. */
interface ThinkingContentElement extends HTMLElement {
    _pkmThinkingText?: string;
}

/** Uchwyty Tile dla żywych bloków myślenia, kluczowane elementem `.cs-tile` zwróconym z
 *  `createThinkingBlock` — `finalizeThinkingBlock` dostaje WYŁĄCZNIE ten element (publiczna
 *  sygnatura `createThinkingBlock`/`updateThinkingBlock` bez zmian), więc uchwyt trzeba odzyskać
 *  z mapy, nie z domknięcia. Klucz to sam element, nigdy nie żyje dłużej niż on. */
const _tileHandles = new WeakMap<HTMLElement, TileHandle>();

/**
 * Creates a Crystal Soul .cs-tile for AI thinking/reasoning (rola `agent`, przez `createTile`).
 * Expandable: header (brain icon + "Myślenie" + time + status dot) → body (reasoning text).
 * @param {string} thinkingText - The reasoning content
 * @param {boolean} isStreaming - Whether still accumulating
 * @param {number|null} startTime - Timestamp when thinking started
 * @returns {HTMLElement}
 */
export function createThinkingBlock(thinkingText: string, isStreaming = false, startTime: number | null = null): HTMLElement {
    const handle = createTile({
        role: 'agent',
        status: isStreaming ? 'pending' : 'ok',
        iconSvg: UiIcons.brain(14),
        title: isStreaming ? t('thinking.active') : t('thinking.done'),
        meta: startTime ? `${((Date.now() - startTime) / 1000).toFixed(1)}s` : undefined,
        // Szczegóły to sam tekst myślenia — kafelek renderujący od razu w stanie streamingu
        // (expanded:true) wystawia je LENIWIE-ale-natychmiast (pierwsze rozwinięcie = konstrukcja),
        // więc `updateThinkingBlock` poniżej zastaje już gotowy węzeł `.cs-tile__details`.
        details: thinkingText || '',
        expanded: isStreaming,
    });
    _tileHandles.set(handle.el, handle);
    if (isStreaming) handle.el.classList.add('is-streaming');
    return handle.el;
}

/**
 * Updates existing thinking block text content.
 * @param {HTMLElement} block - The `.cs-tile` element
 * @param {string} text - New reasoning text
 * @param {number|null} startTime - If provided, update elapsed time
 */
export function updateThinkingBlock(block: HTMLElement | null | undefined, text: string, startTime: number | null = null): void {
    const content = block?.querySelector('.cs-tile__details') as ThinkingContentElement | null;
    if (content) {
        // `text` to ślad rozumowania ZAKUMULOWANY od początku tury, więc podmiana całości przy
        // każdym wywołaniu przepisywałaby O(K × długość) znaków i wymuszała przeliczenie
        // układu (`scrollHeight`) także wtedy, gdy nic się nie zmieniło. Ostatnio
        // wpisaną treść pamiętamy NA ELEMENCIE (nie czytamy `textContent` — jego getter sam jest
        // O(n) i wracałby ten sam koszt tylnymi drzwiami).
        const prev: string = typeof content._pkmThinkingText === 'string'
            ? content._pkmThinkingText
            : (content.textContent || '');
        if (prev !== text) {
            if (prev && text.startsWith(prev)) {
                content.append(text.slice(prev.length)); // dopisz samą deltę
            } else {
                content.textContent = text; // rollback / podmiana treści — pełne przepisanie
            }
            content._pkmThinkingText = text;
            // Auto-scroll if expanded - kontener PRZEWIJALNY to `.cs-tile__body` (ma
            // `overflow`/`max-height` w chat_view.css), NIE `.cs-tile__details` (goły tekst, bez
            // reguły overflow) - B3 fix, recenzja A1-fix: przed naprawą `scrollTop` lądował na
            // elemencie, który nigdy się nie przewijał, więc dopisywany tekst w trakcie
            // streamingu znikał pod dolną krawędzią bloku.
            if (block!.classList.contains('is-expanded')) {
                const scrollBody = block?.querySelector('.cs-tile__body') as HTMLElement | null;
                if (scrollBody) scrollBody.scrollTop = scrollBody.scrollHeight;
            }
        }
    }
    if (startTime) {
        const timeEl = block?.querySelector('.cs-tile__meta');
        if (timeEl) {
            timeEl.textContent = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        }
    }
}

/**
 * Finalizuje blok myśli po zakończeniu streamingu tury: zdejmuje `is-streaming` (CSS: body
 * wraca spod sufitu 200px na zwykłe zwijanie/rozwijanie), przełącza status na `ok` i zwija
 * kafelek. `chat_streaming.ts` woła to w CZTERECH miejscach (koniec naturalny, backstop przed
 * kontynuacją, Stop, błąd), gdzie dawniej samo zdjęcie klasy `streaming` było jedyną reakcją —
 * przed 2.3.0 status kafelka po prostu zostawał „pending" do końca życia bloku (kosmetyczny,
 * nieszkodliwy dryf: kafelek nigdy nie znikał, tylko dalej pulsował). Nowy eksport, publiczne
 * sygnatury `createThinkingBlock`/`updateThinkingBlock` bez zmian.
 * @param {HTMLElement|null|undefined} block - element zwrócony przez `createThinkingBlock`
 */
export function finalizeThinkingBlock(block: HTMLElement | null | undefined): void {
    if (!block) return;
    block.classList.remove('is-streaming');
    const handle = _tileHandles.get(block);
    if (handle) {
        handle.setStatus('ok');
        handle.setTitle(t('thinking.done'));
        handle.expand(false);
    }
}
