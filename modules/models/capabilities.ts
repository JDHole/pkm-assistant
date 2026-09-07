/**
 * `modules/models/capabilities.ts` — katalog możliwości modelu.
 *
 * Dziś jedno pytanie: czy model umie czytać obrazy. Odpowiedź jest TRÓJWARSTWOWA
 * (B.6 BA-17): metadana z katalogu dostawcy → dokładna nazwa → rodzina/kształt nazwy.
 * Kolejność nie jest kosmetyczna: katalog `listModels()` wie o modelu więcej niż my,
 * więc gdy powiedział wprost `multimodal`, nie zgadujemy po literkach.
 */
import type { ModelInfo, VisionModelLike } from './contracts.js';

/**
 * Nazwy, o których wiemy WPROST. Trzymamy je jako pełne identyfikatory (nie prefiksy),
 * żeby dokładne trafienie było tańsze i czytelniejsze niż dopasowanie rodziny.
 */
const VISION_MODEL_IDS: ReadonlySet<string> = new Set([
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4-vision-preview',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'claude-sonnet-4-20250514',
]);

/**
 * Rodziny multimodalne. Dopasowanie po CZŁONIE nazwy, nie po gołym `startsWith`:
 * `gpt-4o-mini` i `claude-sonnet-4-20250514-v2` należą do rodziny, `gpt-4omega` nie.
 */
const VISION_FAMILIES: readonly string[] = [
    'gpt-4o',
    'gpt-4.1',
    'gpt-4-turbo',
    'gpt-5',
    'chatgpt-4o',
    'o1',
    'o3',
    'o4',
    'claude-3',
    'claude-sonnet-4',
    'claude-opus-4',
    'claude-haiku-4',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-haiku-5',
    'gemini',
    'grok-2-vision',
    'grok-4',
    'llava',
    'pixtral',
    'moondream',
    'minicpm-v',
    'internvl',
];

/**
 * Ostatnia warstwa: kształt nazwy. Człon `vision` / `vl` / `multimodal` gdziekolwiek
 * w nazwie (`llama3.2-vision`, `qwen2-vl`) rozstrzyga na TAK. Człon, nie podciąg —
 * inaczej `revisionist-7b` byłby modelem od obrazków.
 */
const VISION_NAME_PATTERN = /(?:^|[-_/.])(?:vision|vl|multimodal)(?:[-_/.]|$)/;

/** Czy `name` należy do rodziny `family` (równość albo `family` + separator członu). */
function inFamily(name: string, family: string): boolean {
    if (name === family) return true;
    if (!name.startsWith(family)) return false;
    const next = name.charAt(family.length);
    return next === '-' || next === '.' || next === '_' || next === '/' || next === ':';
}

/** Metadana katalogu dla DOKŁADNIE tej nazwy modelu (pusta nazwa też się liczy). */
function metadataFor(models: ModelInfo[] | undefined, name: string): ModelInfo | undefined {
    if (!Array.isArray(models)) return undefined;
    return models.find(entry => typeof entry?.id === 'string' && entry.id.trim().toLowerCase() === name);
}

/**
 * Czy model obsługuje obraz na wejściu.
 *
 * B.13 VC-01..VC-03 / B.6 BA-17. Bierze CAŁY opis modelu (konsument podaje instancję
 * `ChatModel`, dostawca — goły `{ modelId, models }`), bo o multimodalności decyduje
 * albo nazwa, albo katalog modeli pobrany z API.
 *
 * @param model Opis modelu (`modelKey`/`modelId` + opcjonalne metadane z `listModels()`).
 * @returns `true`, gdy model przyjmuje obrazy; `false` przy braku modelu i przy modelach tekstowych.
 */
export function isVisionModel(model: VisionModelLike | null | undefined): boolean {
    if (!model) return false;

    const name = String(model.modelKey ?? model.modelId ?? '').trim().toLowerCase();

    // Warstwa 1 — katalog dostawcy mówi wprost.
    const meta = metadataFor(model.models, name);
    if (meta && typeof meta.multimodal === 'boolean') return meta.multimodal;

    if (!name) return false;

    // Warstwa 2 — dokładna nazwa.
    if (VISION_MODEL_IDS.has(name)) return true;

    // Warstwa 3 — rodzina i kształt nazwy (sufiksy dat i wersji nie mogą psuć decyzji).
    if (VISION_FAMILIES.some(family => inFamily(name, family))) return true;
    return VISION_NAME_PATTERN.test(name);
}
