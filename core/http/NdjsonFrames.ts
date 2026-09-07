/**
 * `NdjsonFrames` — jeden obiekt JSON na linię, bez prefiksu.
 * Puste linie pomijane; ostatnia, niekompletna linia zostaje w buforze.
 */
import type { FrameParser, StreamFrame } from './contracts.js';

/** Czy tekst jest KOMPLETNYM obiektem/wartością JSON — jedyny sprawdzian, jaki tu istnieje. */
function calyJson(tekst: string): boolean {
    try {
        JSON.parse(tekst);
        return true;
    } catch {
        return false;
    }
}

export class NdjsonFrames implements FrameParser {
    /** Ogon poprzedniej porcji: fragment linii bez własnego `\n`. */
    private bufor = '';

    /**
     * Dokłada porcję i oddaje linie ZAKOŃCZONE znakiem nowej linii.
     * Urwana ostatnia linia czeka w buforze — dostawca dośle jej resztę.
     */
    feed(chunk: string): StreamFrame[] {
        this.bufor += chunk;
        const gotowe: StreamFrame[] = [];
        let poczatek = 0;
        for (;;) {
            const koniec = this.bufor.indexOf('\n', poczatek);
            if (koniec === -1) break;
            const ramka = this.zbudujRamke(this.bufor.slice(poczatek, koniec));
            if (ramka) gotowe.push(ramka);
            poczatek = koniec + 1;
        }
        this.bufor = this.bufor.slice(poczatek);
        return gotowe;
    }

    /**
     * Domyka strumień. Serwer bywa oszczędny i nie kończy ostatniej linii `\n`, więc ogon
     * wychodzi jako ramka — ale WYŁĄCZNIE wtedy, gdy jest kompletnym JSON-em. Urwany
     * fragment ginie: dekoder dostawcy i tak nie miałby z niego pożytku.
     */
    finish(): StreamFrame[] {
        const ogon = this.bufor;
        this.bufor = '';
        const tresc = ogon.trim();
        if (!tresc || !calyJson(tresc)) return [];
        return [{ data: tresc }];
    }

    /** Puste linie (także same białe znaki i `\r` z CRLF) nie są ramkami. */
    private zbudujRamke(linia: string): StreamFrame | null {
        const tresc = linia.trim();
        return tresc ? { data: tresc } : null;
    }
}
