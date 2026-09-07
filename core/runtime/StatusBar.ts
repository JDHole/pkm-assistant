/** Kontroler paska statusu (SB-01..SB-04) + drugi kanał zdarzeń pamięci. */
import { log as globalLog } from '../utils/Logger.js';
import { STATUS_BAR_CSS_CLASSES } from './contracts.js';
import type { LoggerLike, StatusBarController, StatusBarRenderer } from './contracts.js';

export type { StatusBarController } from './contracts.js';

const SCOPE = 'StatusBar';

/** Klasa bazowa elementu paska i wariant klikalny (SB-03). */
const [CSS_ITEM, CSS_CLICKABLE] = STATUS_BAR_CSS_CLASSES;

export interface StatusBarDeps {
    /** Kontener z `host.addStatusBarItem()`; `null` poza Obsidianem. */
    container: HTMLElement | null;
    /** SB-02: override komponentu paska statusu. */
    renderer?: StatusBarRenderer;
    log?: LoggerLike;
}

/**
 * Pomocnicze metody Obsidiana na `HTMLElement` (`empty`, `createSpan`, `addClass`…) są
 * augmentacją globalną, a poza Obsidianem bywa ich brak. Sięgamy po nie przez ten
 * opcjonalny widok, więc atrapa elementu w teście / dry-boocie nie wywraca paska.
 */
interface ElementObsidiana {
    textContent: string | null;
    empty?: () => void;
    createSpan?: (opts?: unknown) => ElementObsidiana | undefined;
    addClass?: (...classes: string[]) => void;
    removeClass?: (...classes: string[]) => void;
    setText?: (text: string) => void;
    appendChild?: (child: never) => unknown;
    addEventListener?: (type: string, handler: () => void) => void;
    removeEventListener?: (type: string, handler: () => void) => void;
}

/**
 * Stawia pasek statusu na podanym kontenerze.
 *
 * `null` wraca, gdy kontenera nie ma (goły Node, dry-boot) — wołacz nie musi wtedy
 * niczego sprawdzać, bo cały kontroler jest opcjonalny.
 */
export function createStatusBar(deps: StatusBarDeps): StatusBarController | null {
    const kontener = deps.container as unknown as ElementObsidiana | null;
    if (!kontener) return null;
    const log = deps.log ?? globalLog;

    let tekst = '';
    let klik: (() => void) | null = null;
    let tresc: ElementObsidiana | null = null;
    let zdemontowany = false;

    const bezpiecznie = (co: string, fn: () => void): void => {
        try {
            fn();
        } catch (e) {
            // Pasek statusu jest ozdobą, nie funkcją krytyczną — jego pad nie ma prawa
            // zatrzymać startu ani demontażu pluginu.
            log.warn(SCOPE, `${co} padło:`, e);
        }
    };

    const naKlik = (): void => { klik?.(); };

    const narysuj = (): void => {
        if (zdemontowany) return;
        bezpiecznie('rysowanie paska', () => {
            kontener.empty?.();
            kontener.addClass?.(CSS_ITEM);
            const wlasny = deps.renderer?.render() as unknown as ElementObsidiana | undefined;
            if (wlasny) kontener.appendChild?.(wlasny as never);
            tresc = wlasny ?? kontener.createSpan?.() ?? null;
            ustawTekst(tekst);
            ustawKlikalnosc();
        });
    };

    const ustawTekst = (nowy: string): void => {
        const cel = tresc ?? kontener;
        if (typeof cel.setText === 'function') cel.setText(nowy);
        else cel.textContent = nowy;
    };

    const ustawKlikalnosc = (): void => {
        if (klik) {
            kontener.addClass?.(CSS_CLICKABLE);
            kontener.addEventListener?.('click', naKlik);
        } else {
            kontener.removeClass?.(CSS_CLICKABLE);
            kontener.removeEventListener?.('click', naKlik);
        }
    };

    narysuj();

    return {
        /** Przerysowanie treści paska (drugi kanał: zdarzenia „pulsu pamięci"). */
        refresh(): void {
            narysuj();
        },
        setText(nowy: string): void {
            tekst = nowy ?? '';
            if (zdemontowany) return;
            bezpiecznie('ustawienie tekstu paska', () => { ustawTekst(tekst); });
        },
        /** SB-03: przełącza wariant klikalny. */
        setClickable(handler: (() => void) | null): void {
            klik = typeof handler === 'function' ? handler : null;
            if (zdemontowany) return;
            bezpiecznie('przełączenie klikalności paska', ustawKlikalnosc);
        },
        dispose(): void {
            if (zdemontowany) return;
            zdemontowany = true;
            klik = null;
            bezpiecznie('demontaż paska', () => {
                kontener.removeEventListener?.('click', naKlik);
                kontener.empty?.();
            });
            tresc = null;
        },
    };
}
