/**
 * `SseFrames` — parser ramek `data:` / `event:` z buforem między porcjami.
 * Puste linie i komentarze (`:`) są pomijane; sentinel platformy wraca jako zwykła ramka.
 */
import type { FrameParser, StreamFrame } from './contracts.js';

/**
 * Zakończenia linii dopuszczone przez format zdarzeń serwera: `\r\n`, `\n`, `\r`.
 * Osobny obiekt na wywołanie nie jest potrzebny — wyrażenie ma flagę `g`, więc
 * `lastIndex` zerujemy jawnie przed każdym przebiegiem.
 */
const KONIEC_LINII = /\r\n|\n|\r/g;

/** Pojedyncza sytuacja pomijana bez śladu: pusta wartość `event:` znaczy „brak nazwy". */
function nazwaAlboBrak(wartosc: string): string | undefined {
    return wartosc === '' ? undefined : wartosc;
}

/** Znacznik kolejności bajtów. Format każe zignorować go NA POCZĄTKU STRUMIENIA. */
const ZNACZNIK_BOM = '\uFEFF';

export class SseFrames implements FrameParser {
    /** Ogon poprzedniej porcji: wszystko za ostatnim PEWNYM zakończeniem linii. */
    private bufor = '';
    /** Czy pierwszy znak strumienia był już oglądany (patrz {@link ZNACZNIK_BOM}). */
    private poczatekStrumienia = true;
    /** Linie `data:` bieżącej ramki — składane `\n`, tak jak wymaga format. */
    private dane: string[] = [];
    /** Nazwa zdarzenia z `event:`, jeśli dostawca ją wysłał. */
    private zdarzenie: string | undefined;

    /**
     * Dokłada porcję tekstu i oddaje ramki KOMPLETNE (zamknięte pustą linią).
     * Ramka rozcięta między porcjami czeka w buforze do następnego wywołania.
     */
    feed(chunk: string): StreamFrame[] {
        this.bufor += this.bezZnacznikaBom(chunk);
        return this.przetworzLinie(this.wytnijLinie(false));
    }

    /**
     * Domyka strumień. Niekompletny ogon (bez zamykającej pustej linii) jest PORZUCANY —
     * lepiej stracić urwaną ramkę niż podać dekoderowi połowę ładunku.
     */
    finish(): StreamFrame[] {
        const gotowe = this.przetworzLinie(this.wytnijLinie(true));
        this.bufor = '';
        this.dane = [];
        this.zdarzenie = undefined;
        this.poczatekStrumienia = true;
        return gotowe;
    }

    /**
     * Zdejmuje znacznik kolejności bajtów, ale WYŁĄCZNIE z pierwszego znaku strumienia.
     * Nie zdejmujemy go z każdej porcji: w środku ładunku to zwykły znak treści, a nie
     * nagłówek, i wycinanie go psułoby cudzy tekst.
     */
    private bezZnacznikaBom(chunk: string): string {
        if (!this.poczatekStrumienia || chunk === '') return chunk;
        this.poczatekStrumienia = false;
        return chunk.startsWith(ZNACZNIK_BOM) ? chunk.slice(ZNACZNIK_BOM.length) : chunk;
    }

    /**
     * Wycina z bufora linie ZAKOŃCZONE. Samotny `\r` na samym końcu bufora zostaje —
     * następna porcja może zacząć się od `\n` i wtedy to jedno zakończenie, nie dwa.
     */
    private wytnijLinie(domykamy: boolean): string[] {
        const linie: string[] = [];
        let poczatek = 0;
        KONIEC_LINII.lastIndex = 0;
        let trafienie: RegExpExecArray | null;
        while ((trafienie = KONIEC_LINII.exec(this.bufor)) !== null) {
            const polowkaPary = trafienie[0] === '\r'
                && KONIEC_LINII.lastIndex === this.bufor.length
                && !domykamy;
            if (polowkaPary) break;
            linie.push(this.bufor.slice(poczatek, trafienie.index));
            poczatek = KONIEC_LINII.lastIndex;
        }
        this.bufor = this.bufor.slice(poczatek);
        return linie;
    }

    /** Maszyna stanu formatu: pusta linia domyka ramkę, `:` na starcie to komentarz. */
    private przetworzLinie(linie: string[]): StreamFrame[] {
        const gotowe: StreamFrame[] = [];
        for (const linia of linie) {
            if (linia === '') {
                const ramka = this.domknijRamke();
                if (ramka) gotowe.push(ramka);
                continue;
            }
            if (linia.startsWith(':')) continue;
            this.przypiszPole(linia);
        }
        return gotowe;
    }

    /** Oddaje ramkę tylko wtedy, gdy zebrała choć jedną linię `data:`. */
    private domknijRamke(): StreamFrame | null {
        if (this.dane.length === 0) {
            this.zdarzenie = undefined;
            return null;
        }
        const ramka: StreamFrame = this.zdarzenie === undefined
            ? { data: this.dane.join('\n') }
            : { event: this.zdarzenie, data: this.dane.join('\n') };
        this.dane = [];
        this.zdarzenie = undefined;
        return ramka;
    }

    /** `pole: wartość` — jedna spacja po dwukropku należy do składni, nie do treści. */
    private przypiszPole(linia: string): void {
        const dwukropek = linia.indexOf(':');
        const pole = dwukropek === -1 ? linia : linia.slice(0, dwukropek);
        let wartosc = dwukropek === -1 ? '' : linia.slice(dwukropek + 1);
        if (wartosc.startsWith(' ')) wartosc = wartosc.slice(1);

        if (pole === 'data') this.dane.push(wartosc);
        else if (pole === 'event') this.zdarzenie = nazwaAlboBrak(wartosc);
        // `id`, `retry` i wszystko inne: transport ich nie potrzebuje, dekoder też nie.
    }
}
