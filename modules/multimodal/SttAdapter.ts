/**
 * SttAdapter — transkrypcja audio (speech-to-text) przez rozne platformy.
 * Kazda platforma: przyjmuje Blob audio, zwraca { text }.
 * Wszystkie requesty ida przez Obsidian requestUrl (CORS-free).
 */
import { requestUrl } from 'obsidian';
import { log } from '../../core/utils/Logger.js';
import { blobToBase64 } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';

// ═══════════════════════════════════════════
// GLOWNA FUNKCJA
// ═══════════════════════════════════════════

/** Klucze API per platforma STT — kazda funkcja bierze swoj jeden. */
export interface SttKeys {
    openai?: string;
    groq?: string;
    gemini?: string;
    deepgram?: string;
    assemblyai?: string;
}

/** Zwrotka kazdej platformy. */
export interface Transcription {
    text: string;
}

/**
 * Transkrybuj audio na tekst.
 * @param platform - Platforma: groq, openai, google, deepgram, assemblyai, ollama
 * @param keys - Klucze API: { openai, groq, gemini, deepgram, assemblyai }
 * @param audioBlob - Nagranie audio (webm/opus)
 * @param language - Kod jezyka (pl, en, de, auto)
 */
export async function transcribeAudio(
    platform: string,
    keys: SttKeys,
    audioBlob: Blob,
    language = 'pl',
): Promise<Transcription> {
    if (!audioBlob || audioBlob.size === 0) throw new Error(t('stt.no_audio'));

    switch (platform) {
        case 'groq': return _groqWhisper(keys.groq, audioBlob, language);
        case 'openai': return _openaiWhisper(keys.openai, audioBlob, language);
        case 'google': return _googleStt(keys.gemini, audioBlob, language);
        case 'deepgram': return _deepgram(keys.deepgram, audioBlob, language);
        case 'assemblyai': return _assemblyAI(keys.assemblyai, audioBlob, language);
        case 'ollama': return _ollamaWhisper(audioBlob, language);
        default: throw new Error(t('stt.unsupported_platform', { platform }));
    }
}

// ═══════════════════════════════════════════
// HELPER — Language locale mapping
// ═══════════════════════════════════════════

const LANG_LOCALE_MAP: Record<string, string> = {
    'pl': 'pl-PL', 'en': 'en-US', 'de': 'de-DE', 'fr': 'fr-FR',
    'es': 'es-ES', 'it': 'it-IT', 'pt': 'pt-BR', 'ja': 'ja-JP',
    'ko': 'ko-KR', 'zh': 'zh-CN', 'ru': 'ru-RU', 'uk': 'uk-UA',
    'cs': 'cs-CZ', 'nl': 'nl-NL', 'sv': 'sv-SE',
};

function _langToLocale(lang: string): string {
    return LANG_LOCALE_MAP[lang] || `${lang}-${lang.toUpperCase()}`;
}

// ═══════════════════════════════════════════
// HELPER — Blob → base64 / ArrayBuffer
// ═══════════════════════════════════════════

// blobToBase64 imported from utils/binaryUtils.js
// _blobToArrayBuffer removed — use blob.arrayBuffer() directly

/**
 * Build multipart/form-data with a file field.
 * Returns { body: ArrayBuffer, contentType: string }
 */
async function _buildMultipartFormData(
    fields: Record<string, string>,
    fileField: string,
    fileBlob: Blob,
    fileName: string,
): Promise<{ body: ArrayBuffer; contentType: string }> {
    const boundary = '----PKMSTT' + Date.now();
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];

    // Text fields
    for (const [key, value] of Object.entries(fields)) {
        parts.push(enc.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
        ));
    }

    // File field
    const fileHeader = enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileBlob.type || 'audio/webm'}\r\n\r\n`
    );
    const fileData = new Uint8Array(await fileBlob.arrayBuffer());
    const fileFooter = enc.encode(`\r\n--${boundary}--\r\n`);

    // Merge all parts
    const totalLength = parts.reduce((s, p) => s + p.length, 0) + fileHeader.length + fileData.length + fileFooter.length;
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) { merged.set(part, offset); offset += part.length; }
    merged.set(fileHeader, offset); offset += fileHeader.length;
    merged.set(fileData, offset); offset += fileData.length;
    merged.set(fileFooter, offset);

    return {
        body: merged.buffer,
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

// ═══════════════════════════════════════════
// ADAPTERY PER PLATFORMA
// ═══════════════════════════════════════════

/**
 * Ksztalty, w jakich CZYTAMY odpowiedzi platform — tylko pola, po ktore siega kod.
 * `error.message` jest tu wymagane, bo kod wchodzi tam dopiero po `if (data.error)`.
 */
interface WhisperResponse {
    error?: { message: string };
    text?: string;
}

/**
 * Groq Whisper — najszybszy STT, darmowy tier.
 */
async function _groqWhisper(apiKey: string | undefined, audioBlob: Blob, language: string): Promise<Transcription> {
    if (!apiKey) throw new Error(t('stt.no_api_key', { key: 'Groq' }));
    const fields: Record<string, string> = { model: 'whisper-large-v3-turbo' };
    if (language !== 'auto') fields.language = language;
    const { body, contentType } = await _buildMultipartFormData(fields, 'file', audioBlob, 'audio.webm');

    const resp = await requestUrl({
        url: 'https://api.groq.com/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': contentType,
        },
        body,
    });
    const data = resp.json as WhisperResponse;
    if (data.error) throw new Error(`Groq Whisper: ${data.error.message}`);
    return { text: data.text || '' };
}

/**
 * OpenAI Whisper.
 */
async function _openaiWhisper(apiKey: string | undefined, audioBlob: Blob, language: string): Promise<Transcription> {
    if (!apiKey) throw new Error(t('stt.no_api_key', { key: 'OpenAI' }));
    const fields: Record<string, string> = { model: 'whisper-1' };
    if (language !== 'auto') fields.language = language;
    const { body, contentType } = await _buildMultipartFormData(fields, 'file', audioBlob, 'audio.webm');

    const resp = await requestUrl({
        url: 'https://api.openai.com/v1/audio/transcriptions',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': contentType,
        },
        body,
    });
    const data = resp.json as WhisperResponse;
    if (data.error) throw new Error(`OpenAI Whisper: ${data.error.message}`);
    return { text: data.text || '' };
}

/**
 * Google Cloud STT via Gemini API.
 */
async function _googleStt(apiKey: string | undefined, audioBlob: Blob, language: string): Promise<Transcription> {
    if (!apiKey) throw new Error(t('stt.no_api_key', { key: 'Google' }));
    const base64Audio = await blobToBase64(audioBlob);

    const resp = await requestUrl({
        url: `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            config: {
                encoding: 'WEBM_OPUS',
                sampleRateHertz: 48000,
                languageCode: language === 'auto' ? 'pl-PL' : _langToLocale(language),
                enableAutomaticPunctuation: true,
            },
            audio: { content: base64Audio },
        }),
    });
    const data = resp.json as {
        error?: { message: string };
        results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
    if (data.error) throw new Error(`Google STT: ${data.error.message}`);
    const text = (data.results || [])
        .map(r => r.alternatives?.[0]?.transcript || '')
        .join(' ');
    return { text };
}

/**
 * Deepgram — streaming-capable, very accurate.
 */
async function _deepgram(apiKey: string | undefined, audioBlob: Blob, language: string): Promise<Transcription> {
    if (!apiKey) throw new Error(t('stt.no_api_key', { key: 'Deepgram (deepgram_api_key)' }));
    const audioBuffer = await audioBlob.arrayBuffer();
    const langParam = language === 'auto' ? '' : `&language=${language}`;

    const resp = await requestUrl({
        url: `https://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&smart_format=true${langParam}`,
        method: 'POST',
        headers: {
            'Authorization': `Token ${apiKey}`,
            'Content-Type': audioBlob.type || 'audio/webm',
        },
        body: audioBuffer,
    });
    const data = resp.json as {
        err_msg?: string;
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    if (data.err_msg) throw new Error(`Deepgram: ${data.err_msg}`);
    const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    return { text };
}

/**
 * AssemblyAI — upload → poll.
 */
async function _assemblyAI(apiKey: string | undefined, audioBlob: Blob, language: string): Promise<Transcription> {
    if (!apiKey) throw new Error(t('stt.no_api_key', { key: 'AssemblyAI (assemblyai_api_key)' }));
    const audioBuffer = await audioBlob.arrayBuffer();

    // Step 1: Upload audio
    const uploadResp = await requestUrl({
        url: 'https://api.assemblyai.com/v2/upload',
        method: 'POST',
        headers: {
            'authorization': apiKey,
            'Content-Type': 'application/octet-stream',
        },
        body: audioBuffer,
    });
    const uploadUrl = (uploadResp.json as { upload_url?: string } | null)?.upload_url;
    if (!uploadUrl) throw new Error(t('stt.assemblyai_upload_fail'));

    // Step 2: Create transcript
    const transcriptResp = await requestUrl({
        url: 'https://api.assemblyai.com/v2/transcript',
        method: 'POST',
        headers: {
            'authorization': apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            audio_url: uploadUrl,
            language_code: language === 'auto' ? null : language,
            punctuate: true,
        }),
    });
    const transcriptId = (transcriptResp.json as { id?: string } | null)?.id;
    if (!transcriptId) throw new Error(t('stt.assemblyai_create_error'));

    // Step 3: Poll for result (max 60s)
    const start = Date.now();
    while (Date.now() - start < 60000) {
        await new Promise(r => window.setTimeout(r, 2000));
        const pollResp = await requestUrl({
            url: `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
            method: 'GET',
            headers: { 'authorization': apiKey },
        });
        const data = pollResp.json as { status: string; text?: string; error?: string };
        if (data.status === 'completed') return { text: data.text || '' };
        if (data.status === 'error') throw new Error(`AssemblyAI: ${data.error}`);
        log.debug('STT', `AssemblyAI polling: ${data.status}...`);
    }
    throw new Error(t('stt.assemblyai_timeout'));
}

/**
 * Ollama — lokalny Whisper (jeśli zainstalowany).
 * Uwaga: Ollama nie ma natywnego STT — to jest placeholder na wypadek
 * gdyby pojawił się model whisper w Ollama ecosystem.
 */
async function _ollamaWhisper(_audioBlob: Blob, _language: string): Promise<Transcription> {
    // Ollama doesn't natively support STT yet
    // This is a placeholder for future compatibility
    throw new Error(t('stt.ollama_not_supported'));
}
