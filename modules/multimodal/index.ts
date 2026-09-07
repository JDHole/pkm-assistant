/**
 * modules/multimodal — public API (barrel).
 *
 * Audio + Image + Vision (neutralne, generic).
 *
 * Eksporty:
 * - Audio STT (6 platform): transcribeAudio()
 * - Image Gen (6 platform): generateImage() + IMAGE_GEN_PLATFORMS
 * - Audio recorder (UI): AudioRecorder klasa
 * - Oczko (S13a): buildActiveNoteContext()
 *
 * Detekcja vision modeli (_is_model_multimodal) zostaje w modules/models/ — to per-model decyzja, nie operacja multimodalna.
 *
 * S30 Z4 (przycinka powierzchni): `STT_PLATFORMS`, `readVaultImageAsBlock`
 * i `extractEmbeddedImagePaths` OUT — zero konsumentów spoza modułu (dropdown STT
 * w Settings składa się z i18n, a obrazy z aktywnej notatki wciąga `buildActiveNoteContext`
 * u siebie). `IMAGE_GEN_PLATFORMS` ZOSTAJE — jest SSOT dropdownu platform i walidacji
 * w `modules/tools/GenerateImageTool.js`.
 *
 * Fabryka dead-code D7 (2026-09-02, AUD-dead-code-074/193): `STT_PLATFORMS` (+ interfejs
 * `SttPlatform`, który istniał wyłącznie żeby ją otypować) SKASOWANE z `SttAdapter.ts` w
 * całości — w odróżnieniu od `readVaultImageAsBlock`/`extractEmbeddedImagePaths` (te dwie
 * NAPRAWDĘ są wołane przez `buildActiveNoteContext` u siebie), `STT_PLATFORMS` nie miała
 * ŻADNEGO czytelnika, nawet wewnątrz modułu. Dropdown STT w `modules/tools/SettingsContent.ts`
 * to osobna, ręcznie utrzymywana lista (`sttPlatforms`, 7 wpisów z pozycją `disabled`) — TA
 * jest dziś SSOT-em, nie ta stała.
 */

export { transcribeAudio } from './SttAdapter.js';
export { generateImage, IMAGE_GEN_PLATFORMS } from './ImageGenAdapter.js';
export { AudioRecorder } from './AudioRecorder.js';
export { buildActiveNoteContext } from './active_note.js';

// TS-3 — typy publiczne modułu. `export type` ZNIKA przy transpilacji, więc powierzchnia
// runtime'u zostaje dokładnie taka, jak wyżej.
export type { SttKeys, Transcription } from './SttAdapter.js';
export type { ImageGenKeys, ImageGenParams, GeneratedImage, ImageGenPlatform } from './ImageGenAdapter.js';
export type { AudioRecorderOptions } from './AudioRecorder.js';
export type { ImageUrlBlock, ActiveNoteContext, ActiveNoteOptions } from './active_note.js';
