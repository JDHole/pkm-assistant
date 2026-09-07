/**
 * Streszczanie treści stron tanim modelem (E3.3, DEC L13-5a).
 *
 * PROBLEM: `web_read` ucinał stronę na twardo (`slice(0, 8000)`) — model dostawał
 * przypadkowy początek i nie wiedział, co mu obcięto. Sedno artykułu bywa na końcu.
 *
 * ROZWIĄZANIE: gdy strona jest dłuższa niż limit, oddajemy ją modelowi Badacza
 * (tani slot `researcher`), który zwraca streszczenie + 3-5 DOSŁOWNYCH cytatów.
 * Cytaty są ważne osobno: to gotowy format {tytuł, url, fragment} dla Pamięci v3
 * — agent może zacytować źródło, a nie tylko parafrazę parafrazy.
 *
 * Ten plik NIE decyduje, czy streszczać — rzuca wyjątkiem przy każdym problemie
 * (brak modelu, błąd API, pusta odpowiedź). Decyzja i fallback na twarde cięcie
 * należą do `web_read` (`modules/tools/WebReadTool.js`).
 */
import { streamToComplete } from '../memory/index.js';
import { log } from '../../core/utils/Logger.js';

/** Dosłowny cytat wycięty z treści strony (gotowy format dla Pamięci v3). */
export interface WebCitation {
    fragment: string;
}

/** Wynik streszczania: tekst + dosłowne cytaty. */
export interface WebSummary {
    summary: string;
    citations: WebCitation[];
}

/**
 * Model widziany przez ten plik — TYLKO `.stream()`. Kontrakt niesie
 * `streamToComplete` (`modules/memory`); tu wystarczy sprawdzian obecności metody.
 */
export interface SummarizerModelLike {
    stream: (...args: never[]) => unknown;
}

/** Wejście `summarizeWebContent`. */
export interface SummarizeWebParams {
    title?: string;
    url?: string;
    /** pełna treść z readera */
    content: string;
    /** instancja `ChatModel` (slot `researcher`) */
    model: SummarizerModelLike | null;
    /** docelowa długość streszczenia */
    targetChars?: number;
}

/** Sufit wejścia do promptu — żeby nie wysadzić okna taniego modelu. */
export const SUMMARIZE_INPUT_MAX = 40000;

/**
 * Przycina wejście zachowując POCZĄTEK i KONIEC (3/4 + 1/4) z jawnym markerem
 * `[...]`. Środek długiego artykułu jest zwykle mniej gęsty niż wstęp i wnioski.
 *
 * Strażnik `typeof content === 'string'` ZOSTAJE — treść przychodzi z readera.
 */
export function clipForPrompt(content: string, max = SUMMARIZE_INPUT_MAX): string {
    const text = typeof content === 'string' ? content : '';
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.75);
    const tail = max - head;
    return `${text.slice(0, head)}\n\n[...]\n\n${text.slice(-tail)}`;
}

function buildPrompt(
    { title, url, content, targetChars }: Required<Pick<SummarizeWebParams, 'content' | 'targetChars'>>
        & Pick<SummarizeWebParams, 'title' | 'url'>,
): string {
    return [
        'Streść treść strony internetowej dla asystenta, który ma z niej korzystać dalej.',
        '',
        `TYTUŁ: ${title || '(brak)'}`,
        `URL: ${url || '(brak)'}`,
        '',
        'ZASADY:',
        `- Streszczenie do około ${targetChars} znaków.`,
        '- Zachowaj fakty, liczby, daty, nazwy własne i wnioski. Nie dopisuj niczego od siebie.',
        '- Pisz w języku oryginału treści.',
        '- Po streszczeniu wypisz 3-5 DOSŁOWNYCH cytatów (fragmenty 1-3 zdań), które najlepiej oddają sedno. Cytaty muszą być przepisane słowo w słowo z treści.',
        '',
        'FORMAT ODPOWIEDZI (dokładnie taki, bez komentarzy):',
        'STRESZCZENIE:',
        '<tekst streszczenia>',
        '',
        'CYTATY:',
        '- <dosłowny cytat>',
        '- <dosłowny cytat>',
        '',
        'TREŚĆ STRONY:',
        clipForPrompt(content),
    ].join('\n');
}

// `[*: \t]*` po nazwie sekcji łyka każdy wariant zdobienia: `CYTATY:`, `**CYTATY:**`, `**CYTATY**:`.
const CITATIONS_HEADING = /(^|\n)[ \t]*(?:#{1,6}[ \t]*)?\*{0,2}CYTATY[*: \t]*(?=\n|$)/i;
const SUMMARY_HEADING = /(?:^|\n)?[ \t]*(?:#{1,6}[ \t]*)?\*{0,2}STRESZCZENIE[*: \t]*\n?/i;
const BULLET = /^[ \t]*(?:[-*•—]|\d+[.)])[ \t]+(.*\S)[ \t]*$/;

/**
 * Tolerancyjny parser odpowiedzi modelu. Model bywa niesforny: gubi nagłówki,
 * dokleja markdown, numeruje cytaty zamiast wypunktowywać. Dlatego:
 * - brak nagłówka `STRESZCZENIE:` → streszczeniem jest wszystko przed `CYTATY:`,
 * - brak sekcji `CYTATY:` → `citations = []` (nie jest to błąd),
 * - cytaty czytamy z wypunktowania (myślnik, gwiazdka, numeracja), zdejmując cudzysłowy.
 *
 * Strażnik `typeof text === 'string'` ZOSTAJE — wejściem jest odpowiedź modelu.
 */
export function parseSummaryResponse(text: string): WebSummary {
    const raw = typeof text === 'string' ? text : '';
    const citIdx = raw.search(CITATIONS_HEADING);
    const head = citIdx >= 0 ? raw.slice(0, citIdx) : raw;
    const tail = citIdx >= 0 ? raw.slice(citIdx).replace(CITATIONS_HEADING, '') : '';

    const summaryMatch = head.match(SUMMARY_HEADING);
    const summary = (summaryMatch
        // `match` z regexem bez flagi `g` zawsze wypełnia `index`.
        ? head.slice((summaryMatch.index as number) + summaryMatch[0].length)
        : head
    ).trim();

    const citations: WebCitation[] = [];
    for (const line of tail.split('\n')) {
        const match = line.match(BULLET);
        if (!match) continue;
        const fragment = match[1]
            .replace(/^["'„»«\s]+/, '')
            .replace(/["'”“»«\s]+$/, '')
            .trim();
        if (fragment) citations.push({ fragment });
    }

    return { summary, citations };
}

/**
 * Streszcza treść strony tanim modelem.
 * @throws gdy brak modelu, API zwróci błąd albo odpowiedź jest pusta
 */
export async function summarizeWebContent(
    { title, url, content, model, targetChars = 8000 }: SummarizeWebParams,
): Promise<WebSummary> {
    if (typeof model?.stream !== 'function') {
        throw new Error('summarizeWebContent: brak modelu do streszczania');
    }

    const prompt = buildPrompt({ title, url, content, targetChars });
    // SZEW z `modules/memory` (wciąż .js): zwrotka wchodzi tu bez typu, więc zawężamy
    // ją LOKALNIE do jedynego pola, którego ten plik używa.
    const { text } = (await streamToComplete(model, [{ role: 'user', content: prompt }])) as { text: string };
    const { summary, citations } = parseSummaryResponse(text);

    if (!summary) throw new Error('summarizeWebContent: model zwrócił pustą odpowiedź');

    log.debug('WebSummarize', `"${url}": ${content?.length || 0} → ${summary.length} znaków, ${citations.length} cytatów`);
    return { summary, citations };
}
