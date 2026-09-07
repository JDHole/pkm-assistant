/**
 * `modules/models/providers/ollama.ts` — dostawca `ollama`, czyli demon działający na
 * maszynie użytkownika.
 *
 * Ollama nie należy do rodziny OpenAI i różni się od niej w czterech miejscach naraz:
 *
 *  1. **Strumień to NDJSON, nie SSE.** Każda linia odpowiedzi jest osobnym, gołym obiektem
 *     JSON — bez prefiksu `data: ` i bez tekstowego znacznika końca. Rozcinaniem linii
 *     zajmuje się wspólny {@link NdjsonFrames} z `core/http`.
 *  2. **Koniec tury rozpoznaje się STRUKTURALNIE.** Liczy się pole `done` albo `done_reason`
 *     w OSTATNIM parsowalnym obiekcie porcji — nigdy podciąg w tekście, bo model potrafi
 *     o tych polach zwyczajnie opowiadać (OL-06, OL-07).
 *  3. **Treść jest zawsze stringiem, a obrazy jadą osobno** — jako tablica `images`
 *     z gołym base64 przy wiadomości (bez nagłówka `data:`).
 *  4. **Myślenie ma własne pole.** `message.thinking` (tryb `think`) wyłącza parser
 *     znaczników `<think>`, bo skoro dostawca oddziela rozumowanie sam, to znacznik
 *     w treści jest już zwykłym tekstem (TT-13, TT-15).
 *
 * Limit odpowiedzi wchodzi jako `options.num_predict`, a czas trzymania modelu w pamięci
 * jako `keep_alive` (OL-03). Katalog modeli to `GET /api/tags` (OL-08).
 */
import { NdjsonFrames, normalizeError } from '../../../core/index.js';
import { t } from '../../../core/i18n/index.js';
import { isVisionModel } from '../capabilities.js';
import { resolveMaxOutputTokens } from '../cache_utils.js';
import { ReasoningTagFilter } from '../ReasoningTagFilter.js';
import { OLLAMA_DEFAULT_KEEP_ALIVE } from '../contracts.js';
import type {
    ChatProvider,
    ChatProviderInfo,
    ChatRequest,
    HttpClient,
    HttpRequestSpec,
    ModelInfo,
    OpenAiCompletion,
    OpenAiContentBlock,
    OpenAiRequestMessage,
    OpenAiResponseTransformedMessage,
    OpenAiToolCall,
    ProviderContext,
    StreamDecoder,
    StreamEvent,
    StreamFrame,
    UsageLike,
} from '../contracts.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Stałe protokołu
// ═══════════════════════════════════════════════════════════════════════════════

/** Adres demona, gdy użytkownik nie podał własnego hosta. */
const DOMYSLNY_HOST = 'http://localhost:11434';

/** Ścieżka czatu doklejana do hosta. */
const SCIEZKA_CZATU = '/api/chat';

/** Ścieżka katalogu modeli pobranych lokalnie. */
const SCIEZKA_KATALOGU = '/api/tags';

/** Model brany, gdy nikt nie wskazał innego. */
const DOMYSLNY_MODEL = 'llama3';

/** Rodziny, którymi Ollama oznacza modele umiejące czytać obrazy. */
const RODZINY_OBRAZOWE: ReadonlySet<string> = new Set(['clip', 'mllama']);

/** Obraz wklejony wprost w adres (`data:<mime>;base64,<ładunek>`). */
const OBRAZ_WKLEJONY = /^data:[^;,]*;base64,(.+)$/i;

/** Metryczka dostawcy — fakty kontraktowe, na których stoją rejestr i Ustawienia. */
const OLLAMA_INFO: ChatProviderInfo = {
    id: 'ollama',
    label: 'Ollama',
    local: true,
    needsApiKey: false,
    defaultModel: DOMYSLNY_MODEL,
    // Platforma lokalna: to sam adres bazowy, bo ścieżkę dokleja dostawca, a host
    // pochodzi z ustawień użytkownika.
    defaultEndpoint: DOMYSLNY_HOST,
    modelsEndpoint: `${DOMYSLNY_HOST}${SCIEZKA_KATALOGU}`,
    streaming: true,
    streamMode: 'ndjson',
    supportsTools: true,
    supportsVision: 'per-model',
    supportsReasoning: true,
    // Ollama ma WŁASNY kształt żądania — `stream_options` z rodziny OpenAI go nie dotyczy.
    streamUsage: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Drobne strażniki typu (demon bywa kapryśny — nic nie zakładamy w ciemno)
// ═══════════════════════════════════════════════════════════════════════════════

type Json = Record<string, unknown>;

function jestObiektem(wartosc: unknown): wartosc is Json {
    return typeof wartosc === 'object' && wartosc !== null && !Array.isArray(wartosc);
}

function jakoObiekt(wartosc: unknown): Json | null {
    return jestObiektem(wartosc) ? wartosc : null;
}

function jakoTekst(wartosc: unknown): string {
    return typeof wartosc === 'string' ? wartosc : '';
}

function jakoLiczba(wartosc: unknown): number | null {
    if (typeof wartosc === 'number') return Number.isFinite(wartosc) ? wartosc : null;
    // Pusty string i wartość logiczna dają po konwersji zero — to nie jest liczba, tylko brak.
    if (typeof wartosc !== 'string' || wartosc.trim() === '') return null;
    const liczba = Number(wartosc);
    return Number.isFinite(liczba) ? liczba : null;
}

function jakoTablica(wartosc: unknown): unknown[] {
    return Array.isArray(wartosc) ? wartosc : [];
}

/** Czy tekst jest kompletną wartością JSON — jedyny sprawdzian, jaki tu istnieje. */
function calyJson(tekst: string): boolean {
    try {
        JSON.parse(tekst);
        return true;
    } catch {
        return false;
    }
}

/** Obiekt z linii NDJSON albo `null`, gdy linia jest śmieciem transportowym. */
function sparsujLinie(linia: string): Json | null {
    try {
        return jakoObiekt(JSON.parse(linia));
    } catch {
        return null;
    }
}

/**
 * Ścieżki demona, które użytkownik potrafi wkleić do pola hosta razem z całym adresem
 * wywołania. Odcinamy je, zanim doklejimy własną.
 */
const SCIEZKI_API: readonly string[] = [
    SCIEZKA_CZATU,
    SCIEZKA_KATALOGU,
    '/api/generate',
    '/api/show',
    '/api/embed',
    '/api/embeddings',
];

/**
 * Sklejenie hosta ze ścieżką. KAŻDY adres dostawcy ma wychodzić od tego samego pnia
 * (BA-21), więc z hosta najpierw znika doklejona wcześniej ścieżka API — inaczej katalog
 * modeli wołany po hoście `…/api/chat` lądowałby pod `…/api/chat/api/tags`.
 */
function adres(host: string, sciezka: string): string {
    let pien = (host || DOMYSLNY_HOST).trim().replace(/\/+$/, '');
    if (!pien) return DOMYSLNY_HOST + sciezka;

    const male = pien.toLowerCase();
    for (const ogon of SCIEZKI_API) {
        if (male.endsWith(ogon)) {
            pien = pien.slice(0, -ogon.length).replace(/\/+$/, '');
            break;
        }
    }
    return pien ? pien + sciezka : DOMYSLNY_HOST + sciezka;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Transkrypt: kształt kanoniczny → kształt Ollamy
// ═══════════════════════════════════════════════════════════════════════════════

/** Wiadomość w kształcie, jaki przyjmuje `POST /api/chat`. */
interface WiadomoscOllamy {
    role: string;
    content: string;
    /** Obrazy jako GOŁY base64, bez nagłówka `data:` — tak chce demon. */
    images?: string[];
    /** Rozumowanie z poprzedniej tury (modele myślące trzymają je w osobnym polu). */
    thinking?: string;
    tool_calls?: unknown[];
    /** Nazwa narzędzia, którego wynik niesie wiadomość roli `tool`. */
    tool_name?: string;
}

/** Role, które demon rozumie wprost. */
const ROLE_OLLAMY: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Rola w kształcie, jaki przyjmuje demon. Nazwa spoza jego słownika schodzi do `user` —
 * wiadomość z nieznaną rolą ma dojechać do modelu jako zwykły głos rozmówcy, a nie
 * wywrócić całą turę na walidacji.
 */
function rolaDlaOllamy(rola: unknown): string {
    const nazwa = jakoTekst(rola).trim().toLowerCase();
    if (ROLE_OLLAMY.has(nazwa)) return nazwa;
    // `function` to stara nazwa wyniku narzędzia z kształtu OpenAI.
    if (nazwa === 'function') return 'tool';
    return 'user';
}

/** Czy blok treści niesie obraz (kształt kanoniczny dopuszcza kilka wariantów zapisu). */
function blokZObrazem(blok: unknown): boolean {
    const rekord = jakoObiekt(blok);
    if (!rekord) return false;
    if (rekord.type === 'image_url' || rekord.type === 'image' || rekord.type === 'input_image') return true;
    return rekord.image_url !== undefined && rekord.image_url !== null;
}

/** Goły base64 obrazu albo `null`, gdy obraz jest odsyłaczem, którego demon nie pobierze. */
function base64Obrazu(blok: OpenAiContentBlock): string | null {
    const adresObrazu = jakoTekst(blok.image_url?.url).trim() || jakoTekst(blok.data).trim();
    if (!adresObrazu) return null;
    const wklejony = OBRAZ_WKLEJONY.exec(adresObrazu);
    if (wklejony) return wklejony[1];
    // Adres http(s) wymagałby pobrania pliku przez plugin — to nie jest zadanie dostawcy.
    if (/^[a-z][a-z0-9+.-]*:/i.test(adresObrazu)) return null;
    // Ładunek podany wprost, bez nagłówka `data:`.
    return adresObrazu;
}

/** Treść i obrazy jednej wiadomości po sprowadzeniu do kształtu Ollamy. */
interface RozbitaTresc {
    tekst: string;
    obrazy: string[];
    /**
     * Czy któryś obraz NIE dojechał: albo model go nie przeczyta, albo był odsyłaczem,
     * którego demon sam nie pobierze. Obie drogi kończą się tym samym — model musi
     * dostać w treści informację, czego nie zobaczył.
     */
    pominietoObraz: boolean;
}

/**
 * Rozbija treść kanoniczną na tekst i obrazy. Bloki tekstowe sklejamy nową linią —
 * demon przyjmuje jeden string, więc podział na bloki i tak by przepadł.
 *
 * Obraz, który nie dojedzie, zostawia w SWOIM MIEJSCU `zastepnik`: wiadomość złożona
 * z samego obrazu zamienia się w ten komunikat w całości, a mieszana traci wyłącznie
 * blok obrazu i zachowuje kolejność wypowiedzi (BA-15/BA-16).
 */
function rozbijTresc(tresc: unknown, obrazyDozwolone: boolean, zastepnik: string): RozbitaTresc {
    if (typeof tresc === 'string') return { tekst: tresc, obrazy: [], pominietoObraz: false };
    if (!Array.isArray(tresc)) return { tekst: '', obrazy: [], pominietoObraz: false };

    const kawalki: string[] = [];
    const obrazy: string[] = [];
    let pominietoObraz = false;

    for (const blok of tresc) {
        const rekord = jakoObiekt(blok);
        if (!rekord) continue;
        if (blokZObrazem(rekord)) {
            const ladunek = obrazyDozwolone ? base64Obrazu(rekord) : null;
            if (ladunek) {
                obrazy.push(ladunek);
            } else {
                pominietoObraz = true;
                kawalki.push(zastepnik);
            }
            continue;
        }
        const tekst = jakoTekst(rekord.text);
        if (tekst) kawalki.push(tekst);
    }

    return { tekst: kawalki.join('\n'), obrazy, pominietoObraz };
}

/**
 * Argumenty wywołania narzędzia w kształcie, jakiego chce demon (OBIEKT).
 * Tekst, który da się odczytać jako obiekt JSON, rozpakowujemy; reszta idzie bez zmian,
 * żeby nic nie zniknęło po cichu.
 */
function argumentyDlaOllamy(argumenty: unknown): unknown {
    if (typeof argumenty !== 'string') return argumenty;
    try {
        const rozpakowane: unknown = JSON.parse(argumenty);
        return jestObiektem(rozpakowane) ? rozpakowane : argumenty;
    } catch {
        return argumenty;
    }
}

/** Wywołanie narzędzia z transkryptu przełożone na kształt Ollamy. */
function wywolanieDlaOllamy(wywolanie: unknown): Json | null {
    const rekord = jakoObiekt(wywolanie);
    if (!rekord) return null;
    const funkcja = jakoObiekt(rekord.function);
    const nazwa = jakoTekst(funkcja?.name);
    if (!nazwa) return null;
    const out: Json = { function: { name: nazwa, arguments: argumentyDlaOllamy(funkcja?.arguments) } };
    const identyfikator = jakoTekst(rekord.id);
    if (identyfikator) out.id = identyfikator;
    return out;
}

/**
 * Cały transkrypt na kształt Ollamy. Jedyna zmiana treści, jaką tu robimy, to wycięcie
 * obrazów kierowanych do modelu, który ich nie przeczyta: w miejsce obrazu wchodzi
 * komunikat z tłumaczeń, żeby model wiedział, czego nie dostał, a wysyłka nie została
 * zablokowana (BA-15/BA-16).
 */
function transkryptDlaOllamy(
    wiadomosci: OpenAiRequestMessage[],
    obrazyDozwolone: boolean,
    ctx: ProviderContext,
    modelId: string,
): WiadomoscOllamy[] {
    let ostrzezonoOObrazie = false;
    const zastepnik = t('model.image_stripped');
    const out: WiadomoscOllamy[] = [];

    for (const wiadomosc of wiadomosci) {
        if (!jestObiektem(wiadomosc)) continue;
        const rozbita = rozbijTresc(wiadomosc.content, obrazyDozwolone, zastepnik);

        // Ostrzeżenie leci RAZ na turę, nie raz na obraz — inaczej album zdjęć zalałby log.
        if (rozbita.pominietoObraz && !ostrzezonoOObrazie) {
            ostrzezonoOObrazie = true;
            ctx.log?.warn?.('models.image_stripped', { provider: OLLAMA_INFO.id, model: modelId });
        }

        const przelozona: WiadomoscOllamy = { role: rolaDlaOllamy(wiadomosc.role), content: rozbita.tekst };
        if (rozbita.obrazy.length > 0) przelozona.images = rozbita.obrazy;

        const myslenie = jakoTekst(wiadomosc.reasoning_content);
        if (myslenie) przelozona.thinking = myslenie;

        const nazwaNarzedzia = jakoTekst(wiadomosc.name);
        if (przelozona.role === 'tool' && nazwaNarzedzia) przelozona.tool_name = nazwaNarzedzia;

        const wywolania = jakoTablica(wiadomosc.tool_calls)
            .map(wywolanieDlaOllamy)
            .filter((wpis): wpis is Json => wpis !== null);
        if (wywolania.length > 0) przelozona.tool_calls = wywolania;

        out.push(przelozona);
    }

    return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Odpowiedź: kształt Ollamy → kształt kanoniczny
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Zużycie tokenów z liczników demona. Brak obu liczników oddaje `null`, żeby wołacz
 * zostawił `usage` PUSTYM obiektem — to jego sygnał „estymuj" (BA-08).
 */
function zuzycieZOdpowiedzi(surowe: Json): UsageLike | null {
    const wejscie = jakoLiczba(surowe.prompt_eval_count);
    const wyjscie = jakoLiczba(surowe.eval_count);
    if (wejscie === null && wyjscie === null) return null;

    const zuzycie: UsageLike = {};
    if (wejscie !== null) zuzycie.prompt_tokens = wejscie;
    if (wyjscie !== null) zuzycie.completion_tokens = wyjscie;
    if (wejscie !== null && wyjscie !== null) zuzycie.total_tokens = wejscie + wyjscie;
    return zuzycie;
}

/** Wywołanie narzędzia z odpowiedzi w kształcie kanonicznym. Argumenty idą jak przyszły (OL-05). */
function wywolanieKanoniczne(wywolanie: unknown): OpenAiToolCall | null {
    const rekord = jakoObiekt(wywolanie);
    if (!rekord) return null;
    const funkcja = jakoObiekt(rekord.function);
    const nazwa = jakoTekst(funkcja?.name);
    if (!nazwa) return null;

    const argumenty = funkcja?.arguments;
    const out: OpenAiToolCall = {
        type: 'function',
        function: {
            name: nazwa,
            // Demon oddaje argumenty gotowym OBIEKTEM i tak je przepuszczamy — pętla
            // agenta znosi oba kształty, a przepakowanie tylko gubiłoby typy liczb.
            arguments: typeof argumenty === 'string' || jestObiektem(argumenty)
                ? argumenty
                : '{}',
        },
    };
    const identyfikator = jakoTekst(rekord.id);
    if (identyfikator) out.id = identyfikator;
    return out;
}

/** Czy obiekt linii oznacza koniec tury. Wyłącznie pola STRUKTURALNE (OL-06). */
function koniecTury(obiekt: Json): boolean {
    if (obiekt.done === true) return true;
    return jakoTekst(obiekt.done_reason).trim() !== '';
}

/** Powód zakończenia w kształcie kanonicznym. */
function powodKonca(obiekt: Json): string {
    return jakoTekst(obiekt.done_reason).trim() || 'stop';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dekoder strumienia
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dekoder JEDNEJ tury strumienia NDJSON.
 *
 * Rozcinanie linii oddajemy wspólnemu {@link NdjsonFrames}, ale decyzję o tym, KIEDY
 * linia jest gotowa do parsowania, podejmujemy tutaj: demon nierzadko nie kończy
 * ostatniej linii znakiem nowej linii, a sygnał końca tury nie może czekać na domknięcie
 * ciała odpowiedzi. Dlatego ogon porcji, który sam w sobie jest już kompletnym JSON-em,
 * puszczamy dalej od razu; niekompletny czeka na resztę bajtów.
 */
class DekoderOllamy implements StreamDecoder {
    private readonly ramki = new NdjsonFrames();
    private readonly filtr = new ReasoningTagFilter();
    /** Tekst, który jeszcze nie trafił do parsera ramek (urwana ostatnia linia). */
    private ogon = '';
    /** Czy rezerwa filtra znaczników została już dopchnięta (raz na turę). */
    private domkniety = false;
    /** ST-11: ile linii poszło do kosza jako nieczytelne — `ChatModel` z tego robi ostrzeżenie. */
    private wyrzucone = 0;

    get droppedFrames(): number {
        return this.wyrzucone;
    }

    /** Seam obserwacyjny parsera znaczników myślenia (TT-16). */
    get reasoning(): { readonly active: boolean; readonly buffered: string } {
        return this.filtr;
    }

    feed(chunk: string): StreamEvent[] {
        this.ogon += chunk ?? '';
        return this.przetworz(this.ramki.feed(this.odetnijGotowe()));
    }

    finish(): StreamEvent[] {
        const reszta = this.ogon;
        this.ogon = '';
        const zdarzenia = this.przetworz([...this.ramki.feed(reszta), ...this.ramki.finish()]);
        this.domknijFiltr(zdarzenia);
        return zdarzenia;
    }

    /**
     * Odcina z bufora tę część, którą wolno już parsować: wszystko do ostatniego znaku
     * nowej linii plus — gdy jest kompletnym JSON-em — urwany ogon.
     */
    private odetnijGotowe(): string {
        let gotowe = '';
        const ostatniaLinia = this.ogon.lastIndexOf('\n');
        if (ostatniaLinia >= 0) {
            gotowe = this.ogon.slice(0, ostatniaLinia + 1);
            this.ogon = this.ogon.slice(ostatniaLinia + 1);
        }

        const reszta = this.ogon.trim();
        if (reszta && calyJson(reszta)) {
            gotowe += `${this.ogon}\n`;
            this.ogon = '';
        }
        return gotowe;
    }

    /**
     * Ramki jednej porcji na zdarzenia kanoniczne.
     *
     * O końcu tury decyduje OSTATNI parsowalny obiekt porcji, nie obecność sentinela
     * gdziekolwiek w niej (OL-07): dwie linie zlepione przez buforujące proxy nie mogą
     * zakończyć strumienia tylko dlatego, że pierwsza z nich niosła `done`.
     */
    private przetworz(ramki: StreamFrame[]): StreamEvent[] {
        const zdarzenia: StreamEvent[] = [];
        let ostatni: Json | null = null;

        for (const ramka of ramki) {
            const obiekt = sparsujLinie(ramka.data);
            // Śmieć transportowy nie rzuca, nie kończy strumienia i nie unieważnia
            // poprzedniej, poprawnej linii tej samej porcji — ale zostawia ślad (ST-11).
            if (!obiekt) {
                this.wyrzucone += 1;
                continue;
            }
            ostatni = obiekt;
            this.przetworzLinie(obiekt, zdarzenia);
        }

        if (ostatni && koniecTury(ostatni)) {
            this.domknijFiltr(zdarzenia);
            zdarzenia.push({ type: 'done', finishReason: powodKonca(ostatni) });
        }
        return zdarzenia;
    }

    /** Jedna linia NDJSON na zdarzenia. */
    private przetworzLinie(obiekt: Json, zdarzenia: StreamEvent[]): void {
        if (obiekt.error !== undefined && obiekt.error !== null) {
            zdarzenia.push({ type: 'error', error: normalizeError(obiekt.error) });
            return;
        }

        const wiadomosc = jakoObiekt(obiekt.message);
        if (wiadomosc) {
            const myslenie = jakoTekst(wiadomosc.thinking);
            if (myslenie) {
                // Rozumowanie przyszło własnym polem — znaczniki w treści są od teraz
                // zwykłym tekstem (TT-13).
                this.filtr.disable();
                zdarzenia.push({ type: 'reasoning', delta: myslenie });
            }

            const tresc = jakoTekst(wiadomosc.content);
            if (tresc) this.wypuscTresc(tresc, zdarzenia);

            const wywolania = jakoTablica(wiadomosc.tool_calls);
            for (let i = 0; i < wywolania.length; i++) this.wypuscWywolanie(wywolania[i], i, zdarzenia);
        }

        const zuzycie = zuzycieZOdpowiedzi(obiekt);
        if (zuzycie) zdarzenia.push({ type: 'usage', usage: zuzycie });
    }

    /** Widoczna treść przez filtr znaczników myślenia. */
    private wypuscTresc(tresc: string, zdarzenia: StreamEvent[]): void {
        const podzial = this.filtr.feed(tresc);
        if (podzial.reasoning) zdarzenia.push({ type: 'reasoning', delta: podzial.reasoning });
        if (podzial.text) zdarzenia.push({ type: 'text', delta: podzial.text });
    }

    /**
     * Wywołanie narzędzia. Demon przysyła je w JEDNEJ linii, w komplecie — nie ma tu
     * sklejania fragmentów jak w rodzinie OpenAI, więc slot wskazuje pozycja w tablicy.
     */
    private wypuscWywolanie(wywolanie: unknown, pozycja: number, zdarzenia: StreamEvent[]): void {
        const rekord = jakoObiekt(wywolanie);
        if (!rekord) return;
        const funkcja = jakoObiekt(rekord.function);
        const nazwa = jakoTekst(funkcja?.name);

        const zdarzenie: Extract<StreamEvent, { type: 'tool_call' }> = {
            type: 'tool_call',
            index: jakoLiczba(rekord.index) ?? pozycja,
        };
        const identyfikator = jakoTekst(rekord.id);
        if (identyfikator) zdarzenie.id = identyfikator;
        if (nazwa) zdarzenie.name = nazwa;

        const argumenty = funkcja?.arguments;
        if (typeof argumenty === 'string') {
            zdarzenie.argumentsDelta = argumenty;
        } else if (argumenty !== undefined && argumenty !== null) {
            // Argumenty przychodzą OBIEKTEM (OL-05), a zdarzenie strumienia niesie tekst —
            // idzie więc ich dosłowny zapis JSON, który wołacz i tak parsuje.
            zdarzenie.argumentsDelta = JSON.stringify(argumenty);
        }
        zdarzenia.push(zdarzenie);
    }

    /** Dopchnięcie rezerwy filtra (i wycofanie niedomkniętego bloku myślenia) — raz na turę. */
    private domknijFiltr(zdarzenia: StreamEvent[]): void {
        if (this.domkniety) return;
        this.domkniety = true;
        const resztka = this.filtr.finish();
        if (resztka.reasoning) zdarzenia.push({ type: 'reasoning', delta: resztka.reasoning });
        if (resztka.text) zdarzenia.push({ type: 'text', delta: resztka.text });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dostawca
// ═══════════════════════════════════════════════════════════════════════════════

/** Dostawca Ollamy: `POST /api/chat` (NDJSON) + katalog `GET /api/tags`. */
export class OllamaProvider implements ChatProvider {
    get info(): ChatProviderInfo {
        return OLLAMA_INFO;
    }

    /**
     * Katalog modeli ściągniętych na dysk użytkownika. Zgaszony demon, błędny status albo
     * śmieć w odpowiedzi oddają PUSTĄ listę — rozwijane pole w Ustawieniach ma się narysować
     * także wtedy, gdy nie ma z czym gadać (ST-21).
     */
    async listModels(ctx: ProviderContext, http: HttpClient): Promise<ModelInfo[]> {
        if (!http) return [];
        try {
            const odpowiedz = await http.send({
                url: adres(ctx.endpoint ?? '', SCIEZKA_KATALOGU),
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            });
            if (odpowiedz.status < 200 || odpowiedz.status >= 300) return [];
            return this.katalogZOdpowiedzi(odpowiedz.json());
        } catch {
            return [];
        }
    }

    /** Żądanie → opis HTTP. `body` jest STRINGIEM JSON, nigdy obiektem (BA-01). */
    buildRequest(req: ChatRequest, ctx: ProviderContext, stream: boolean): HttpRequestSpec {
        const modelId = (req.model ?? ctx.modelId ?? '').trim() || DOMYSLNY_MODEL;
        const obrazyDozwolone = isVisionModel({ modelId, modelKey: modelId, models: ctx.models });

        const opcje: Json = { num_predict: this.limitOdpowiedzi(req, ctx, modelId) };
        const temperatura = jakoLiczba(req.temperature ?? ctx.temperature);
        if (temperatura !== null) opcje.temperature = temperatura;

        const body: Json = {
            model: modelId,
            messages: transkryptDlaOllamy(req.messages ?? [], obrazyDozwolone, ctx, modelId),
            stream,
            // Jak długo demon ma trzymać model w pamięci po odpowiedzi (OL-03). Pusta albo
            // brakująca wartość spada na domyślną — inaczej demon wyładowywałby model
            // natychmiast i każda tura płaciłaby za ponowne wczytanie wag.
            keep_alive: jakoTekst(ctx.keepAlive).trim() || OLLAMA_DEFAULT_KEEP_ALIVE,
            options: opcje,
        };

        const narzedzia = jakoTablica(req.tools);
        if (narzedzia.length > 0) body.tools = narzedzia;
        // Tryb myślenia. Demon przyjmuje flagę, nie budżet w tokenach — liczba z żądania
        // znaczy więc tyle samo co `true`.
        if (req.thinking) body.think = true;

        return {
            url: adres(ctx.endpoint ?? '', SCIEZKA_CZATU),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        };
    }

    /**
     * Odpowiedź bez strumienia → kształt kanoniczny. Te same reguły co w strumieniu:
     * natywne `thinking` wygrywa z parserem znaczników, a niedomknięty `<think>` wraca
     * do widocznej treści (TT-14, TT-15).
     */
    parseCompletion(body: unknown, _req: ChatRequest, ctx: ProviderContext): OpenAiCompletion {
        const surowe = jakoObiekt(body) ?? {};
        const odpowiedz: OpenAiCompletion = {
            object: 'chat.completion',
            model: jakoTekst(surowe.model) || ctx.modelId,
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: null }],
            usage: zuzycieZOdpowiedzi(surowe) ?? {},
        };

        // Ładunek z polem `error` oddaje błąd zamiast rzucać — pętla ma dostać kształt,
        // na którym umie stanąć (BA-22).
        if (surowe.error !== undefined && surowe.error !== null) {
            odpowiedz.error = normalizeError(surowe.error);
            return odpowiedz;
        }

        const wiadomosc = jakoObiekt(surowe.message);
        const przelozona: OpenAiResponseTransformedMessage = {
            role: jakoTekst(wiadomosc?.role) || 'assistant',
            content: jakoTekst(wiadomosc?.content),
        };

        const myslenie = jakoTekst(wiadomosc?.thinking);
        if (myslenie) {
            przelozona.reasoning_content = myslenie;
        } else {
            const podzial = ReasoningTagFilter.apply(jakoTekst(wiadomosc?.content));
            przelozona.content = podzial.content;
            if (podzial.reasoning_content) przelozona.reasoning_content = podzial.reasoning_content;
        }

        const wywolania = jakoTablica(wiadomosc?.tool_calls)
            .map(wywolanieKanoniczne)
            .filter((wpis): wpis is OpenAiToolCall => wpis !== null);
        if (wywolania.length > 0) przelozona.tool_calls = wywolania;

        odpowiedz.choices = [{
            index: 0,
            message: przelozona,
            finish_reason: koniecTury(surowe) ? powodKonca(surowe) : null,
        }];
        return odpowiedz;
    }

    /** Świeży dekoder na JEDNĄ turę — stan znaczników myślenia jest per tura. */
    createStreamDecoder(_req: ChatRequest, _ctx: ProviderContext): StreamDecoder {
        return new DekoderOllamy();
    }

    // ── Wnętrze ──────────────────────────────────────────────────────────────

    /** Limit odpowiedzi: żądanie → kontekst → wyliczenie z platformy i nazwy modelu. */
    private limitOdpowiedzi(req: ChatRequest, ctx: ProviderContext, modelId: string): number {
        const zZadania = jakoLiczba(req.max_tokens);
        if (zZadania !== null && zZadania > 0) return zZadania;
        const zKontekstu = jakoLiczba(ctx.maxOutputTokens);
        if (zKontekstu !== null && zKontekstu > 0) return zKontekstu;
        return resolveMaxOutputTokens({ platform: OLLAMA_INFO.id, modelId });
    }

    /** Odpowiedź `/api/tags` → lista dla rozwijanego pola w Ustawieniach. */
    private katalogZOdpowiedzi(body: unknown): ModelInfo[] {
        const surowe = jakoObiekt(body);
        const wiersze = jakoTablica(surowe?.models);
        const out: ModelInfo[] = [];

        for (const wiersz of wiersze) {
            const wpis = jakoObiekt(wiersz);
            if (!wpis) continue;
            const id = jakoTekst(wpis.model).trim() || jakoTekst(wpis.name).trim();
            if (!id) continue;

            const model: ModelInfo = { ...wpis, id };
            const nazwa = jakoTekst(wpis.name).trim();
            if (nazwa) model.name = nazwa;

            // Demon sam mówi, czy model ma wieżę obrazową — ta metadana rozstrzyga
            // pytanie o vision lepiej niż zgadywanie po nazwie (VC-02).
            const rodziny = jakoTablica(jakoObiekt(wpis.details)?.families)
                .map(rodzina => jakoTekst(rodzina).toLowerCase());
            if (rodziny.some(rodzina => RODZINY_OBRAZOWE.has(rodzina))) model.multimodal = true;

            out.push(model);
        }
        return out;
    }
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const ollamaProvider = new OllamaProvider();
