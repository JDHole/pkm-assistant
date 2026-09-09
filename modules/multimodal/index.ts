/**
 * modules/multimodal - public API (barrel).
 *
 * Audio + Image + Vision (neutralne, generic).
 *
 * Eksporty:
 * - Audio STT (6 platform): transcribeAudio()
 * - Image Gen (6 platform): generateImage() + IMAGE_GEN_PLATFORMS
 * - Audio recorder (UI): AudioRecorder klasa
 * - Oczko: buildActiveNoteContext()
 *
 * Detekcja vision modeli (_is_model_multimodal) zostaje w modules/models/ - to per-model decyzja, nie operacja multimodalna.
 *
 * `STT_PLATFORMS`, `readVaultImageAsBlock` i `extractEmbeddedImagePaths` nie są eksportowane
 * z barrela - zero konsumentów spoza modułu (dropdown STT w Settings składa się z i18n, a obrazy
 * z aktywnej notatki wciąga `buildActiveNoteContext` u siebie). `IMAGE_GEN_PLATFORMS` zostaje -
 * jest SSOT dropdownu platform i walidacji w `modules/tools/GenerateImageTool.js`.
 *
 * `STT_PLATFORMS` (razem z interfejsem `SttPlatform`, który istniał wyłącznie żeby ją otypować)
 * jest skasowane z `SttAdapter.ts` w całości - w odróżnieniu od `readVaultImageAsBlock`/
 * `extractEmbeddedImagePaths` (te dwie naprawdę są wołane przez `buildActiveNoteContext` u
 * siebie), `STT_PLATFORMS` nie miała żadnego czytelnika, nawet wewnątrz modułu. Dropdown STT
 * w `modules/tools/SettingsContent.ts` to osobna, ręcznie utrzymywana lista (`sttPlatforms`,
 * 7 wpisów z pozycją `disabled`) - to jest dziś SSOT-em, nie ta stała.
 */

export { transcribeAudio } from './SttAdapter.js';
export { generateImage, IMAGE_GEN_PLATFORMS } from './ImageGenAdapter.js';
export { AudioRecorder } from './AudioRecorder.js';
export { buildActiveNoteContext } from './active_note.js';

// Typy publiczne modułu. `export type` ZNIKA przy transpilacji, więc powierzchnia
// runtime'u zostaje dokładnie taka, jak wyżej.
export type { SttKeys, Transcription } from './SttAdapter.js';
export type { ImageGenKeys, ImageGenParams, GeneratedImage, ImageGenPlatform } from './ImageGenAdapter.js';
export type { AudioRecorderOptions } from './AudioRecorder.js';
export type { ImageUrlBlock, ActiveNoteContext, ActiveNoteOptions } from './active_note.js';
