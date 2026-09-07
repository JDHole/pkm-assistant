/**
 * ImageGenAdapter — generowanie obrazow przez rozne platformy.
 * Kazda platforma zwraca { base64, format, revised_prompt? }.
 * Wszystkie requesty ida przez Obsidian requestUrl (CORS-free).
 */
import { requestUrl } from 'obsidian';
import { log } from '../../core/utils/Logger.js';
import { arrayBufferToBase64 } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';

// ═══════════════════════════════════════════
// GLOWNA FUNKCJA
// ═══════════════════════════════════════════

/** Klucze API per platforma generowania obrazow. */
export interface ImageGenKeys {
    openai?: string;
    open_router?: string;
    stability?: string;
    replicate?: string;
    gemini?: string;
    xai?: string;
}

/** Wejscie generowania. `size` ma postac `"SZERxWYS"` (np. `"1024x1024"`). */
export interface ImageGenParams {
    prompt: string;
    size?: string;
    style?: string;
    model?: string;
}

/** Zwrotka kazdej platformy. */
export interface GeneratedImage {
    base64: string;
    format: string;
    revised_prompt?: string;
}

/** Wpis listy platform (do UI i walidacji w `modules/tools/GenerateImageTool.js`). */
export interface ImageGenPlatform {
    id: string;
    name: string;
    requiresKey: keyof ImageGenKeys;
}

/**
 * Wygeneruj obraz na podstawie prompta.
 * @param platform - Platforma: openrouter, openai, stability, replicate, gemini, xai
 * @param keys - Klucze API: { openai, open_router, stability, replicate, gemini, xai }
 * @param params - { prompt, size?, style?, model? }
 */
export async function generateImage(
    platform: string,
    keys: ImageGenKeys,
    params: ImageGenParams,
): Promise<GeneratedImage> {
    const { prompt } = params;
    if (!prompt) throw new Error(t('image.no_prompt'));

    switch (platform) {
        case 'openrouter': return _openRouter(keys.open_router, params);
        case 'openai': return _openaiDalle(keys.openai, params);
        case 'stability': return _stabilityAI(keys.stability, params);
        case 'replicate': return _replicate(keys.replicate, params);
        case 'gemini': return _geminiImagen(keys.gemini, params);
        case 'xai': return _xaiAurora(keys.xai, params);
        default: throw new Error(t('image.unsupported_platform', { platform }));
    }
}

/**
 * Lista dostepnych platform (do UI).
 */
export const IMAGE_GEN_PLATFORMS: ImageGenPlatform[] = [
    { id: 'openrouter', name: 'OpenRouter (GPT-5 Image, Gemini, Flux)', requiresKey: 'open_router' },
    { id: 'openai', name: 'OpenAI DALL-E 3', requiresKey: 'openai' },
    { id: 'stability', name: 'Stability AI (SDXL/SD3)', requiresKey: 'stability' },
    { id: 'replicate', name: 'Replicate (Flux)', requiresKey: 'replicate' },
    { id: 'gemini', name: 'Google Gemini (Imagen 3)', requiresKey: 'gemini' },
    { id: 'xai', name: 'xAI (Grok Imagine)', requiresKey: 'xai' },
];

// ═══════════════════════════════════════════
// ADAPTERY PER PLATFORMA
// ═══════════════════════════════════════════

/**
 * OpenRouter — image generation via chat completions.
 * Models: google/gemini-2.5-flash-image, openai/gpt-5-image-mini, openai/gpt-5-image
 * Image-only models (Flux, SD): modalities: ['image']
 * Chat+image models (GPT-5, Gemini): modalities: ['image', 'text']
 * Obrazy zwracane jako base64 data URL w message.images[].
 */
async function _openRouter(apiKey: string | undefined, params: ImageGenParams): Promise<GeneratedImage> {
    if (!apiKey) throw new Error(t('image.no_api_key', { key: 'OpenRouter' }));
    const { prompt, size = '1024x1024', model = 'google/gemini-2.5-flash-image' } = params;
    const { aspect } = _sizeToAspect(size);
    const modalities = _isImageOnlyModel(model) ? ['image'] : ['image', 'text'];
    const resp = await requestUrl({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/JDHole/pkm-assistant',
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            modalities,
            image_config: { aspect_ratio: aspect },
        }),
    });
    const data = resp.json as {
        error?: { message?: string };
        choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    };
    if (data.error) throw new Error(`OpenRouter: ${data.error.message || JSON.stringify(data.error)}`);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(t('image.no_response', { platform: 'OpenRouter' }));
    // Images in message.images[] as data URLs
    const imgBlock = msg.images?.[0];
    if (imgBlock?.image_url?.url) {
        const dataUrl = imgBlock.image_url.url;
        // Extract base64 from "data:image/png;base64,..."
        const base64Match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (base64Match) {
            return { base64: base64Match[2], format: base64Match[1] || 'png' };
        }
        // If it's a regular URL, fetch it
        const imgResp = await requestUrl({ url: dataUrl, method: 'GET' });
        return { base64: _arrayBufferToBase64(imgResp.arrayBuffer), format: 'png' };
    }
    throw new Error(t('image.try_other_model'));
}

/**
 * OpenAI DALL-E 3.
 */
async function _openaiDalle(apiKey: string | undefined, params: ImageGenParams): Promise<GeneratedImage> {
    if (!apiKey) throw new Error(t('image.no_api_key', { key: 'OpenAI' }));
    const { prompt, size = '1024x1024', style = 'vivid' } = params;
    const resp = await requestUrl({
        url: 'https://api.openai.com/v1/images/generations',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: params.model || 'dall-e-3',
            prompt,
            size,
            style,
            response_format: 'b64_json',
            n: 1,
        }),
    });
    const data = resp.json as {
        error?: { message: string };
        data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    };
    if (data.error) throw new Error(`DALL-E: ${data.error.message}`);
    const img = data.data?.[0];
    if (!img?.b64_json) throw new Error(t('image.no_image_data', { platform: 'DALL-E' }));
    return { base64: img.b64_json, format: 'png', revised_prompt: img.revised_prompt };
}

/**
 * Stability AI — Stable Diffusion (SD3, SDXL).
 */
async function _stabilityAI(apiKey: string | undefined, params: ImageGenParams): Promise<GeneratedImage> {
    if (!apiKey) throw new Error(t('image.no_api_key', { key: 'Stability AI (stability_api_key)' }));
    const { prompt, size = '1024x1024', style } = params;
    const { aspect } = _sizeToAspect(size);
    const { body: formBody, boundary } = _buildFormData({
        prompt,
        aspect_ratio: aspect,
        output_format: 'png',
        ...(style && { style_preset: style }),
    });
    const resp = await requestUrl({
        url: 'https://api.stability.ai/v2beta/stable-image/generate/core',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json',
        },
        contentType: `multipart/form-data; boundary=${boundary}`,
        body: formBody,
    });
    const data = resp.json as { errors?: unknown; message?: string; image?: string };
    if (data.errors || data.message) throw new Error(`Stability AI: ${data.message || JSON.stringify(data.errors)}`);
    if (!data.image) throw new Error(t('image.no_image_data', { platform: 'Stability AI' }));
    return { base64: data.image, format: 'png' };
}

/**
 * Replicate — Flux i inne modele.
 */
async function _replicate(apiKey: string | undefined, params: ImageGenParams): Promise<GeneratedImage> {
    if (!apiKey) throw new Error(t('image.no_api_key', { key: 'Replicate (replicate_api_key)' }));
    const { prompt, size = '1024x1024', model = 'black-forest-labs/flux-schnell' } = params;
    const [w, h] = size.split('x').map(Number);
    // Create prediction
    const createResp = await requestUrl({
        url: 'https://api.replicate.com/v1/models/' + model + '/predictions',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            input: { prompt, width: w || 1024, height: h || 1024 },
        }),
    });
    const prediction = createResp.json as { error?: string; urls?: { get?: string }; id?: string };
    if (prediction.error) throw new Error(`Replicate: ${prediction.error}`);
    // Poll for result (max 60s)
    const pollUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`;
    const result = await _pollReplicate(apiKey, pollUrl, 60000);
    // Fetch image and convert to base64
    const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    if (!imageUrl) throw new Error(t('image.no_image_url'));
    const imgResp = await requestUrl({ url: imageUrl, method: 'GET' });
    const base64 = _arrayBufferToBase64(imgResp.arrayBuffer);
    return { base64, format: 'png' };
}

/**
 * Google Gemini — Imagen 3.
 */
async function _geminiImagen(apiKey: string | undefined, params: ImageGenParams): Promise<GeneratedImage> {
    if (!apiKey) throw new Error(t('image.no_api_key', { key: 'Gemini' }));
    const { prompt } = params;
    const geminiModel = params.model || 'imagen-3.0-generate-002';
    const resp = await requestUrl({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:predict?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1, aspectRatio: '1:1' },
        }),
    });
    const data = resp.json as {
        error?: { message: string };
        predictions?: Array<{ bytesBase64Encoded?: string }>;
    };
    if (data.error) throw new Error(`Gemini Imagen: ${data.error.message}`);
    const img = data.predictions?.[0];
    if (!img?.bytesBase64Encoded) throw new Error(t('image.no_image_data', { platform: 'Gemini Imagen' }));
    return { base64: img.bytesBase64Encoded, format: 'png' };
}

/**
 * xAI — Grok Imagine (image generation).
 * Endpoint: /v1/images/generations
 * Models: grok-imagine-image (standard), grok-imagine-image-pro (wyzsza jakosc)
 */
async function _xaiAurora(apiKey: string | undefined, params: ImageGenParams): Promise<GeneratedImage> {
    if (!apiKey) throw new Error(t('image.no_api_key', { key: 'xAI' }));
    const { prompt, size = '1024x1024' } = params;
    const { aspect } = _sizeToAspect(size);
    const resp = await requestUrl({
        url: 'https://api.x.ai/v1/images/generations',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: params.model || 'grok-imagine-image',
            prompt,
            n: 1,
            aspect_ratio: aspect,
            response_format: 'b64_json',
        }),
    });
    const data = resp.json as {
        error?: { message?: string };
        data?: Array<{ b64_json?: string; url?: string }>;
    };
    if (data.error) throw new Error(`xAI: ${data.error.message || JSON.stringify(data.error)}`);
    const img = data.data?.[0];
    if (!img) throw new Error(t('image.no_image_data', { platform: 'xAI' }));
    if (img.b64_json) {
        return { base64: img.b64_json, format: 'png' };
    }
    if (img.url) {
        const imgResp = await requestUrl({ url: img.url, method: 'GET' });
        const base64 = _arrayBufferToBase64(imgResp.arrayBuffer);
        return { base64, format: 'png' };
    }
    throw new Error(t('image.no_b64_or_url'));
}

// ═══════════════════════════════════════════
// HELPERY
// ═══════════════════════════════════════════

/**
 * Detect image-only models on OpenRouter (Flux, Stable Diffusion, etc.).
 * These need modalities: ['image'] instead of ['image', 'text'].
 */
function _isImageOnlyModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.includes('flux') || m.includes('stable-diffusion') || m.includes('sdxl')
        || m.includes('dall-e') || m.includes('imagen') || m.includes('sourceful');
}

// Re-export from shared utils for backward compat
const _arrayBufferToBase64 = arrayBufferToBase64;

/** Parse "1024x1024" → { w, h, aspect } */
function _sizeToAspect(size: string): { w: number; h: number; aspect: string } {
    const [w, h] = size.split('x').map(Number);
    const aspect = w === h ? '1:1' : w > h ? '16:9' : '9:16';
    return { w, h, aspect };
}

/** Odpowiedz predykcji Replicate w zakresie, ktory czyta ten plik. */
interface ReplicatePrediction {
    status: string;
    error?: string;
    output?: string | string[];
}

async function _pollReplicate(
    apiKey: string | undefined,
    url: string,
    timeoutMs: number,
): Promise<ReplicatePrediction> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await _sleep(2000);
        const resp = await requestUrl({
            url,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const data = resp.json as ReplicatePrediction;
        if (data.status === 'succeeded') return data;
        if (data.status === 'failed' || data.status === 'canceled') {
            throw new Error(`Replicate: ${data.error || t('image.generation_failed')}`);
        }
        log.debug('ImageGen', `Replicate polling: ${data.status}...`);
    }
    throw new Error(t('image.generation_timeout', { platform: 'Replicate' }));
}

function _sleep(ms: number): Promise<void> { return new Promise(r => window.setTimeout(r, ms)); }

/**
 * Build multipart/form-data body for Stability AI.
 * requestUrl doesn't support FormData natively, so we build the string manually.
 */
function _buildFormData(fields: Record<string, string>): { body: string; boundary: string } {
    const boundary = '----PKMBoundary' + Date.now();
    let body = '';
    for (const [key, value] of Object.entries(fields)) {
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    }
    body += `--${boundary}--\r\n`;
    return { body, boundary };
}
