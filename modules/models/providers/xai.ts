/**
 * `modules/models/providers/xai.ts` — dostawca `xai`.
 *
 * Kształt czatu OpenAI pod `https://api.x.ai/v1`, klucz w nagłówku `Authorization: Bearer`.
 * Dwie rzeczy różnią tę platformę od reszty rodziny:
 *
 *  • **strumienia w pluginie NIE MA** — `streamMode: 'complete'`. Strona `app://obsidian.md`
 *    nie dostaje od tego API nagłówków pozwalających jej czytać odpowiedź na żywo, więc
 *    `ChatModel` emuluje strumień JEDNYM wywołaniem bez strumienia: cała treść jako jeden
 *    kawałek, potem domknięcie. To WŁAŚCIWOŚĆ dostawcy, nie podmiana klasy przy starcie
 *    pluginu;
 *  • **nagłówek rozmowy** `x-grok-conv-id` — po nim platforma poznaje, że kolejne żądania
 *    należą do tej samej rozmowy, i może ponownie użyć policzonego już początku promptu.
 *
 * Prośba o rozliczenie tokenów w streamie (`stream_options`) jest tu bez sensu — strumienia
 * nie ma — więc metryczka ma ją wyłączoną.
 */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { ChatProviderInfo, ChatRequest, ProviderContext } from '../contracts.js';

/** Metryczka platformy — fakty kontraktowe. */
const XAI_INFO: ChatProviderInfo = {
    id: 'xai',
    label: 'xAI',
    local: false,
    needsApiKey: true,
    defaultModel: 'grok-3-mini-beta',
    defaultEndpoint: 'https://api.x.ai/v1/chat/completions',
    modelsEndpoint: 'https://api.x.ai/v1/models',
    apiKeyHeader: 'Authorization',
    streaming: true,
    // Strumień jest EMULOWANY jednym wywołaniem bez strumienia — patrz nagłówek pliku.
    streamMode: 'complete',
    supportsTools: true,
    supportsVision: 'per-model',
    supportsReasoning: true,
    streamUsage: false,
};

/** Alfabet losowego ogona identyfikatora rozmowy (małe litery + cyfry). */
const TAIL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Długość losowego ogona — tyle wystarczy, żeby dwie rozmowy tego samego dnia się rozeszły. */
const TAIL_LENGTH = 6;

/**
 * Identyfikatory rozmów wydane w tym uruchomieniu, po jednym na agenta.
 *
 * ⚠️ To NIE jest stan tury (ten żyje w dekoderze i w `ChatModel`) — dostawca dalej obsługuje
 * dowolnie wiele równoległych tur. To pamięć jednej metadanej: gdyby każde żądanie dostawało
 * świeży identyfikator, platforma za każdym razem widziałaby NOWĄ rozmowę i nagłówek nie
 * oszczędziłby ani jednego tokenu. Wpis jest ważny jeden dzień — dłuższa rozmowa i tak
 * dawno wypadła z pamięci podręcznej po tamtej stronie.
 */
const conversationIds = new Map<string, { day: string; id: string }>();

export class XaiProvider extends OpenAiCompatibleProvider {
    override get info(): ChatProviderInfo {
        return XAI_INFO;
    }

    /**
     * Nagłówek rozmowy. Nazwa agenta jest METADANĄ wołacza — dostawca ją tu zużywa i zamienia
     * na nagłówek, więc nigdy nie wychodzi w ciele pod własną nazwą. Bez nazwy agenta
     * nagłówka nie ma: identyfikator „niczyjej" rozmowy sklejałby ze sobą wszystkie czaty.
     */
    protected override decorateHeaders(
        headers: Record<string, string>,
        req: ChatRequest,
        ctx: ProviderContext,
    ): void {
        const agent = agentSlug(req.agentName ?? ctx.agentName);
        if (agent) headers['x-grok-conv-id'] = conversationId(agent);
    }
}

/** `'Klara Test'` → `'Klara-Test'`; znaki spoza liter, cyfr i myślnika wypadają. */
function agentSlug(agentName: string | undefined): string {
    return (agentName ?? '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^A-Za-z0-9-]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** `pkm-<Agent>-<RRRR-MM-DD>-<losowy ogon>` — stałe dla agenta przez cały dzień. */
function conversationId(agent: string): string {
    const day = today();
    const known = conversationIds.get(agent);
    if (known && known.day === day) return known.id;

    // Wpisy z poprzednich dni nie mają już wartości — niech nie zostają w pamięci.
    for (const [key, entry] of conversationIds) {
        if (entry.day !== day) conversationIds.delete(key);
    }

    const fresh = { day, id: `pkm-${agent}-${day}-${randomTail()}` };
    conversationIds.set(agent, fresh);
    return fresh.id;
}

/** Dzisiejsza data jako `RRRR-MM-DD` (czas uniwersalny — identyfikator ma być stabilny). */
function today(): string {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Losowy ogon o STAŁEJ długości. Własny alfabet zamiast zapisu liczby losowej przy
 * podstawie 36: ta przy losie równym zeru oddaje pusty ogon, a pusty ogon złamałby kształt
 * identyfikatora.
 */
function randomTail(): string {
    let out = '';
    for (let i = 0; i < TAIL_LENGTH; i++) {
        out += TAIL_ALPHABET[Math.floor(Math.random() * TAIL_ALPHABET.length)];
    }
    return out;
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const xaiProvider = new XaiProvider();
