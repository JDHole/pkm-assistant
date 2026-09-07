/**
 * `modules/models/providers/open_router.ts` — dostawca `open_router`.
 *
 * Pośrednik: jeden adres i jeden klucz, a za nimi setki modeli cudzych platform. Kształt
 * żądania jest kształtem czatu OpenAI, więc cała mechanika siedzi w bazie, a tutaj zostają
 * trzy różnice:
 *
 *  • prośba o rozliczenie tokenów w streamie jest WYŁĄCZONA — serwer waliduje nieznane
 *    pola żądania i odbija je błędem 400;
 *  • filtr znaczników `<think>` jest WPIĘTY, bo przez tego pośrednika jadą też modele
 *    rodziny rozumującej, które wypuszczają rozumowanie wprost w treści. Gdy jednak
 *    pośrednik przyśle rozumowanie WŁASNYM polem (`reasoning`), filtr wyłącza się od
 *    pierwszej porcji — robi to baza, a znacznik w treści zostaje wtedy zwykłym tekstem;
 *  • prośba o rozumowanie jedzie polem `reasoning` — metadana `thinking` z żądania
 *    zamienia się tu na pole API i nigdy nie wychodzi pod własną nazwą.
 *
 * Katalog modeli tej platformy opisuje rodzaje wejścia (`architecture`), więc lista modeli
 * wraca z gotową odpowiedzią na pytanie „czy ten model przyjmie obraz" — bez zgadywania
 * z nazwy.
 */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { ChatProviderInfo, ChatRequest, ModelInfo, ProviderContext } from '../contracts.js';

/** Metryczka platformy — fakty kontraktowe. */
const OPEN_ROUTER_INFO: ChatProviderInfo = {
    id: 'open_router',
    label: 'OpenRouter',
    local: false,
    needsApiKey: true,
    defaultModel: 'anthropic/claude-sonnet-4-20250514',
    defaultEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelsEndpoint: 'https://openrouter.ai/api/v1/models',
    apiKeyHeader: 'Authorization',
    streaming: true,
    streamMode: 'sse',
    supportsTools: true,
    supportsVision: 'per-model',
    supportsReasoning: true,
    streamUsage: false,
};

export class OpenRouterProvider extends OpenAiCompatibleProvider {
    override get info(): ChatProviderInfo {
        return OPEN_ROUTER_INFO;
    }

    protected override get parsesThinkTags(): boolean {
        return true;
    }

    /**
     * Prośba o rozumowanie. `true` włącza je z ustawieniami dostawcy modelu, liczba jest
     * budżetem tokenów rozumowania. Brak pola = brak prośby: modele, które rozumowania
     * nie mają, dostają wtedy żądanie bez ani jednego dodatkowego pola.
     */
    protected override decorateBody(
        body: Record<string, unknown>,
        req: ChatRequest,
        _ctx: ProviderContext,
        _stream: boolean,
    ): void {
        const reasoning = reasoningOption(req.thinking);
        if (reasoning) body.reasoning = reasoning;
    }

    /**
     * Katalog modeli pośrednika niesie opis rodzajów wejścia. Przepisujemy go na jedną
     * flagę, z której korzysta decyzja o wycięciu obrazu z transkryptu — dzięki temu
     * model o nieoczywistej nazwie nie traci obrazu tylko dlatego, że nazwa nic nie mówi.
     */
    protected override parseModelList(body: unknown): ModelInfo[] {
        return super.parseModelList(body).map(entry => {
            if (typeof entry.multimodal === 'boolean') return entry;
            const accepts = acceptsImages(entry);
            return accepts === undefined ? entry : { ...entry, multimodal: accepts };
        });
    }
}

/** Metadana `thinking` → pole API pośrednika. */
function reasoningOption(thinking: ChatRequest['thinking']): Record<string, unknown> | null {
    if (typeof thinking === 'number' && Number.isFinite(thinking) && thinking > 0) {
        return { max_tokens: thinking };
    }
    return thinking === true ? { enabled: true } : null;
}

/**
 * Czy wpis katalogu mówi o modelu przyjmującym obraz.
 *
 * Katalog opisuje to dwojako: listą rodzajów wejścia albo jednym napisem w rodzaju
 * `text+image->text`. Wpis, który nie mówi ani jednego, ani drugiego, zostaje bez flagi —
 * `undefined` znaczy „nie wiem", a wtedy decyduje warstwa wyżej, nie zgadywanie tutaj.
 */
function acceptsImages(entry: ModelInfo): boolean | undefined {
    const architecture = entry.architecture;
    if (typeof architecture !== 'object' || architecture === null) return undefined;
    const shape = architecture as Record<string, unknown>;

    const inputs = shape.input_modalities;
    if (Array.isArray(inputs)) {
        return inputs.some(kind => typeof kind === 'string' && kind.toLowerCase() === 'image');
    }

    const modality = shape.modality;
    if (typeof modality === 'string') {
        const [inputSide] = modality.toLowerCase().split('->');
        return (inputSide ?? '').split('+').some(kind => kind.trim() === 'image');
    }
    return undefined;
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const openRouterProvider = new OpenRouterProvider();
