/**
 * AudioRecorder - nagrywanie audio przez MediaRecorder API.
 * Prosty komponent: start() → stop() → onComplete(blob).
 */
import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';

/** Callbacki nagrywania. Wszystkie opcjonalne - recorder działa i bez nich. */
export interface AudioRecorderOptions {
    /** gotowe nagranie (po `stop()`); `cancel()` go NIE woła */
    onComplete?: (audioBlob: Blob) => void | Promise<void>;
    onError?: (error: unknown) => void;
    /** tyknięcie co sekundę */
    onTick?: (seconds: number) => void;
}

/**
 * Uchwyt timera zwracany przez `window.setInterval` - zawsze `number` (DOM).
 * `ReturnType<typeof setInterval>` (bez `window.`) rozjeżdża się na `NodeJS.Timeout`, bo
 * globals.d.ts z @types/node zlewa się z `Window & typeof globalThis`; `Window['setInterval']`
 * bierze sygnaturę wprost z DOM, bez tej kolizji.
 */
type TickTimer = ReturnType<Window['setInterval']>;

export class AudioRecorder {
    // `declare` (a nie zwykła deklaracja pola): przy `useDefineForClassFields: true`
    // realne pole wyemitowałoby `Object.defineProperty` przed ciałem konstruktora.
    // Tu wszystko nadaje konstruktor - dokładnie jak w JS przed konwersją.
    declare onComplete?: AudioRecorderOptions['onComplete'];
    declare onError?: AudioRecorderOptions['onError'];
    declare onTick?: AudioRecorderOptions['onTick'];
    /** czyta to `chat_model._toggleRecording` - dlatego bez `private` */
    declare recording: boolean;
    declare private _mediaRecorder: MediaRecorder | null;
    declare private _chunks: Blob[];
    declare private _timer: TickTimer | null;
    declare private _seconds: number;
    declare private _stream: MediaStream | null;
    declare private _cancelled: boolean;

    constructor(options: AudioRecorderOptions = {}) {
        this.onComplete = options.onComplete; // (audioBlob) => {}
        this.onError = options.onError;       // (error) => {}
        this.onTick = options.onTick;         // (seconds) => {} - co sekunde
        this.recording = false;
        this._mediaRecorder = null;
        this._chunks = [];
        this._timer = null;
        this._seconds = 0;
        this._stream = null;
        this._cancelled = false;
    }

    async start(): Promise<void> {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this._stream = stream;
            this._cancelled = false;
            // Prefer webm/opus, fallback to whatever browser supports
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm')
                    ? 'audio/webm'
                    : '';
            this._mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
            this._chunks = [];
            this._seconds = 0;

            this._mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this._chunks.push(e.data);
            };

            this._mediaRecorder.onstop = async () => {
                // cancel() already released everything and does NOT want transcription.
                if (this._cancelled) { this._cleanup(); return; }
                // Zawsze ustawiony - ten handler wisi na tej samej instancji, którą tu czytamy.
                const blob = new Blob(this._chunks, { type: this._mediaRecorder!.mimeType || 'audio/webm' });
                this._cleanup();
                log.debug('AudioRecorder', t('audio.recorded', { size: (blob.size / 1024).toFixed(0), seconds: this._seconds }));
                try { await this.onComplete?.(blob); } catch (e) { this.onError?.(e); }
            };

            this._mediaRecorder.onerror = (e) => {
                this._cleanup();
                // lib.dom typuje ten event jako gołe `Event`; spec (MediaRecorderErrorEvent)
                // niesie `error` - czytamy je przez asercję, bez zmiany wykonania.
                this.onError?.((e as Event & { error?: DOMException }).error || new Error(t('audio.error')));
            };

            this._mediaRecorder.start(1000); // chunk every second
            this.recording = true;

            // Timer
            this._timer = window.setInterval(() => {
                this._seconds++;
                this.onTick?.(this._seconds);
            }, 1000);

            log.debug('AudioRecorder', t('audio.started'));
        } catch (e) {
            log.error('AudioRecorder', t('audio.mic_error', { error: (e as { message?: string }).message || e }));
            this.onError?.(e);
        }
    }

    stop(): void {
        if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
            this._mediaRecorder.stop();
        }
        this.recording = false;
    }

    /**
     * Hard stop: release the microphone and the tick timer WITHOUT running onComplete
     * (no transcription of the take in progress). Used when the chat view closes mid-recording.
     * Idempotent and safe to call when nothing is recording.
     */
    cancel(): void {
        this._cancelled = true;
        const rec = this._mediaRecorder;
        if (rec && rec.state !== 'inactive') {
            // onstop fires later and early-returns on _cancelled; cleanup below is synchronous
            // so the mic is released even if the event never arrives (view being destroyed).
            try { rec.stop(); } catch { /* ignore - _cleanup() releases everything */ }
        }
        this._cleanup();
    }

    private _cleanup(): void {
        if (this._timer) { window.clearInterval(this._timer); this._timer = null; }
        if (this._stream) {
            try { this._stream.getTracks().forEach(track => track.stop()); } catch { /* already gone */ }
            this._stream = null;
        }
        this.recording = false;
        this._mediaRecorder = null;
        this._chunks = [];
    }

    get duration(): number { return this._seconds; }
}
