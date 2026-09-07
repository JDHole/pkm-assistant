/**
 * `modules/models/ReasoningTagFilter.ts` — filtr znaczników myślenia `<think>…</think>`.
 *
 * Część modeli lokalnych (i proxy, które je udają) nie ma osobnego pola na rozumowanie —
 * wpychają je do widocznej treści między znaczniki. Ten filtr jest maszyną stanów, która
 * czyta strumień porcjami i rozdziela treść od myślenia, nie gubiąc ani jednego znaku.
 *
 * Trzy reguły, które trzyma:
 *
 * 1. **Znacznik uzbraja filtr wyłącznie na początku wypowiedzi.** Jeśli przed `<think>`
 *    padł choć jeden widoczny znak, znacznik jest zwykłym tekstem — model piszący *o*
 *    znaczniku (proza, blok kodu) nie może stracić zdania.
 * 2. **Znacznik niedomknięty do końca tury nie był myśleniem.** Przy domknięciu cała
 *    wstrzymana treść wraca do widocznej odpowiedzi, a myślenie jest KASOWANE — pusty
 *    string wróciłby do modelu w następnej turze jako fałszywy blok rozumowania.
 * 3. **Rezerwa ≤ 8 znaków.** Sieć tnie odpowiedź w przypadkowych miejscach, więc ogon
 *    każdej porcji jest wstrzymywany na wypadek znacznika rozciętego na granicy porcji.
 *    Rezerwę dopycha {@link ReasoningTagFilter.finish}.
 *
 * Filtr jest jednorazowy: żyje przez jedną turę i umiera razem z dekoderem strumienia.
 * Gdy dostawca przysyła myślenie WŁASNYM polem, wołacz gasi filtr przez
 * {@link ReasoningTagFilter.disable} i treść leci dalej znak w znak.
 */

/** Znacznik otwierający blok rozumowania. */
const OPEN_TAG = '<think>';

/** Znacznik zamykający blok rozumowania. */
const CLOSE_TAG = '</think>';

/**
 * Ile znaków ogona wstrzymujemy na wypadek znacznika rozciętego między porcjami.
 * Dłuższy z obu znaczników ma 8 znaków, więc 8 wystarcza na każdy jego kawałek.
 */
const RESERVE_CHARS = 8;

/** Widoczna treść i myślenie wydzielone z jednej porcji. */
export interface ReasoningSplit {
    text: string;
    reasoning: string;
}

/** Domknięcie tury: dopchnięta rezerwa plus informacja o wycofaniu bloku myślenia. */
export interface ReasoningFlush extends ReasoningSplit {
    /** `true`, gdy otwarty blok nigdy się nie domknął i wrócił do widocznej treści. */
    reasoningDropped: boolean;
}

export class ReasoningTagFilter {
    /** Czy filtr w ogóle patrzy na znaczniki (gasi go natywne myślenie dostawcy). */
    private enabled = true;
    /** Czy znacznik kiedykolwiek uzbroił filtr w tej turze. */
    private engaged = false;
    /** Czy jesteśmy w środku bloku myślenia. */
    private inside = false;
    /** Czy padł już choć jeden widoczny znak treści (reguła 1). */
    private sawVisible = false;
    /** Ogon wstrzymany na wypadek rozciętego znacznika (reguła 3). */
    private reserve = '';
    /** Myślenie zebrane z JESZCZE NIEDOMKNIĘTEGO bloku (reguła 2). */
    private held = '';

    /**
     * Przepuszcza porcję widocznej treści. Myślenie wychodzi dopiero wtedy, gdy blok się
     * domknie — dzięki temu blok, który się nie domknie, nie zdąży wyciec do konsumenta.
     */
    feed(textDelta: string): ReasoningSplit {
        const incoming = textDelta ?? '';
        if (!this.enabled) {
            const passthrough = this.reserve + incoming;
            this.reserve = '';
            return { text: passthrough, reasoning: '' };
        }

        let rest = this.reserve + incoming;
        this.reserve = '';
        let text = '';
        let reasoning = '';

        for (;;) {
            if (this.inside) {
                const close = rest.indexOf(CLOSE_TAG);
                if (close === -1) {
                    const keep = Math.min(RESERVE_CHARS, rest.length);
                    this.held += rest.slice(0, rest.length - keep);
                    this.reserve = rest.slice(rest.length - keep);
                    break;
                }
                this.held += rest.slice(0, close);
                reasoning += this.held;
                this.held = '';
                this.inside = false;
                rest = rest.slice(close + CLOSE_TAG.length);
                continue;
            }

            const open = rest.indexOf(OPEN_TAG);
            if (open === -1) {
                const keep = Math.min(RESERVE_CHARS, rest.length);
                text += this.emit(rest.slice(0, rest.length - keep));
                this.reserve = rest.slice(rest.length - keep);
                break;
            }

            const before = rest.slice(0, open);
            if (!this.sawVisible && before.trim() === '') {
                // Reguła 1: przed znacznikiem sama biel — to prawdziwe otwarcie myślenia.
                text += this.emit(before);
                this.inside = true;
                this.engaged = true;
                rest = rest.slice(open + OPEN_TAG.length);
                continue;
            }

            // Znacznik po widocznej treści jest zwykłym tekstem — przepuszczamy go w całości.
            text += this.emit(rest.slice(0, open + OPEN_TAG.length));
            rest = rest.slice(open + OPEN_TAG.length);
        }

        return { text, reasoning };
    }

    /**
     * Domyka turę: dopycha rezerwę i — gdy blok myślenia nigdy się nie zamknął — wycofuje
     * go do widocznej treści (reguła 2).
     */
    finish(): ReasoningFlush {
        const tail = this.reserve;
        this.reserve = '';

        if (!this.enabled) {
            return { text: tail, reasoning: '', reasoningDropped: false };
        }

        if (this.inside) {
            const restored = this.held + tail;
            this.held = '';
            this.inside = false;
            this.engaged = false;
            this.emit(restored);
            return { text: restored, reasoning: '', reasoningDropped: true };
        }

        return { text: this.emit(tail), reasoning: '', reasoningDropped: false };
    }

    /** Gasi filtr — dostawca przysłał myślenie własnym polem, znaczniki są zwykłym tekstem. */
    disable(): void {
        this.enabled = false;
        this.inside = false;
        if (this.held) {
            // Nic z niedomkniętego bloku nie może zniknąć: wraca do rezerwy, którą
            // najbliższy `feed()` albo `finish()` wypuści jako widoczną treść.
            this.reserve = this.held + this.reserve;
            this.held = '';
        }
        this.engaged = false;
    }

    /** Czy znacznik uzbroił filtr w tej turze (seam obserwacyjny dla testów i guardów). */
    get active(): boolean {
        return this.enabled && this.engaged;
    }

    /** Zawartość rezerwy (seam obserwacyjny dla testów). */
    get buffered(): string {
        return this.reserve;
    }

    /**
     * Cała wypowiedź naraz — tor bez strumienia. Reguły są dokładnie te same, co w streamie,
     * więc nie ma dwóch rozjeżdżających się kopii logiki.
     */
    static apply(content: string): { content: string; reasoning_content?: string } {
        const filter = new ReasoningTagFilter();
        const streamed = filter.feed(content ?? '');
        const flushed = filter.finish();
        const reasoning = streamed.reasoning + flushed.reasoning;
        const out: { content: string; reasoning_content?: string } = {
            content: streamed.text + flushed.text,
        };
        if (reasoning) out.reasoning_content = reasoning;
        return out;
    }

    /** Odnotowuje, że poszła widoczna treść (blokuje późniejsze uzbrojenie znacznika). */
    private emit(chunk: string): string {
        if (chunk.trim() !== '') this.sawVisible = true;
        return chunk;
    }
}
