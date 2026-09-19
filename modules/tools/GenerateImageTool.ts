/**
 * generate_image — MCP tool do generowania obrazow przez AI.
 * Uzywa ImageGenAdapter z konfigurowalna platforma.
 */
import { generateImage, IMAGE_GEN_PLATFORMS } from '../../modules/multimodal/index.js';
import type { ImageGenKeys } from '../../modules/multimodal/index.js';
import { log } from '../../core/utils/Logger.js';
import { getDateLocale, t } from '../../core/i18n/index.js';
import { writeBinary, writeText } from './vault_binary_io.js';
import { validateVaultPath } from './vault_path_validator.js';
import type { BinaryIoApp } from './vault_binary_io.js';

/** Folder zapisu obrazów, gdy user nie ustawił własnego. */
const DEFAULT_SAVE_FOLDER = 'Attachments/generated';

/**
 * Folder, do którego narzędzie NAPRAWDĘ pisze — liczony z ustawień, nie z tekstu modelu.
 * Jedno miejsce, bo czyta go i bramka (`contextExtractor`), i `execute`.
 */
function resolveSaveFolder(plugin: GenerateImagePlugin | null | undefined): string {
    const raw = plugin?.env?.settings?.pkmAssistant?.imageGen?.saveFolder || DEFAULT_SAVE_FOLDER;
    return String(raw).replace(/\/$/, '');
}

/** Argumenty `generate_image` wg `inputSchema`. */
interface GenerateImageArgs {
    prompt?: unknown;
    size?: string;
    style?: string;
    [extra: string]: unknown;
}

/**
 * Slice `settings.pkmAssistant.imageGen`. Klucz modelu jest dynamiczny
 * (`<platforma>_model`), stąd sygnatura indeksowa.
 */
interface ImageGenSettings {
    platform?: string;
    saveFolder?: string;
    stability_api_key?: string;
    replicate_api_key?: string;
    [extra: string]: unknown;
}

/** Minimalny widok pluginu: ustawienia generowania obrazów + pula kluczy API. */
interface GenerateImagePlugin {
    env?: {
        settings?: {
            pkmAssistant?: {
                imageGen?: ImageGenSettings;
                chat?: { apiKeys?: Record<string, string | undefined> };
            };
        };
    } | null;
}

/** Wejście {@link buildImageNoteContent}. */
interface ImageNoteContentArgs {
    filename: string;
    prompt: string;
    platform: string;
    model: string;
    date: Date;
}

/**
 * Treść notatki Obsidiana utworzonej razem z wygenerowanym obrazem.
 *
 * Etykiety `Platforma`/`Wygenerowano` i data (`toLocaleString`) szły dotąd na sztywno po polsku
 * niezależnie od języka interfejsu (`mcp.image.note.platform`/`mcp.image.note.generated` +
 * `getDateLocale()`). `Prompt`/`Model` zostają neutralne (nie są zdaniem w żadnym języku).
 * Czysta funkcja (bez I/O) - wydzielona, żeby dało się przypiąć testem bez atrapy vaulta.
 */
export function buildImageNoteContent(args: ImageNoteContentArgs): string {
    const { filename, prompt, platform, model, date } = args;
    return `![[${filename}]]\n\n**Prompt:** ${prompt}\n**${t('mcp.image.note.platform')}:** ${platform}\n**Model:** ${model}\n**${t('mcp.image.note.generated')}:** ${date.toLocaleString(getDateLocale())}\n`;
}

export function createGenerateImageTool() {
    const platformNames = IMAGE_GEN_PLATFORMS.map(p => p.name).join(', ');

    return {
        name: 'generate_image',
        description: t('mcp.generate_image.desc', { platforms: platformNames }),

        inputSchema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: t('mcp.generate_image.param.prompt')
                },
                size: {
                    type: 'string',
                    enum: ['1024x1024', '1024x1792', '1792x1024'],
                    description: t('mcp.generate_image.param.size')
                },
                style: {
                    type: 'string',
                    description: t('mcp.generate_image.param.style')
                },
            },
            required: ['prompt'],
        },

        // Bramka dostaje FOLDER ZAPISU, nie prompt: jeśli AccessGuard i koniunkcyjna bariera
        // `scope.folders` suba oceniałyby tekst, który model sam pisze, dopisanie „Projekty/” na
        // początku promptu wystarczyłoby, żeby strażnik powiedział „whitelist: Projekty”, podczas
        // gdy realny zapis szedłby gdzie indziej — bez żadnej kontroli. Prompt jedzie do okna
        // zgody jako osobne pole, tak jak `memoryContent` przy pamięci.
        contextExtractor: (args: { prompt?: unknown; size?: unknown }, ctx: { plugin?: unknown }) => ({
            targetPath: resolveSaveFolder(ctx?.plugin as GenerateImagePlugin | null | undefined),
            approvalContext: {
                imagePrompt: typeof args?.prompt === 'string' ? args.prompt : '',
                imageSize: (args?.size as string) || '1024x1024',
            },
        }),

        execute: async (args: GenerateImageArgs, appRef: BinaryIoApp, plugin: GenerateImagePlugin | null | undefined) => {
            try {
                const { prompt, size = '1024x1024', style } = args;
                if (!prompt || typeof prompt !== 'string') {
                    throw new Error(t('mcp.image.prompt_required'));
                }

                // Read settings
                const imageGenSettings = plugin?.env?.settings?.pkmAssistant?.imageGen || {};
                const platform = imageGenSettings.platform;

                // Folder zapisu przez centralną walidację ZANIM cokolwiek policzymy — źle
                // ustawiony `saveFolder` (`../`, `.pkm-assistant/`, plik chroniony) nie może być
                // furtką do zapisu poza vaultem ani do pamięci innego agenta.
                const saveFolder = resolveSaveFolder(plugin);
                const folderCheck = validateVaultPath(saveFolder);
                if (!folderCheck.ok) {
                    return {
                        success: false,
                        error: t('mcp.image.error', {
                            error: t('mcp.image.save_folder_denied', { folder: saveFolder, reason: folderCheck.error }),
                        }),
                    };
                }

                if (!platform || platform === 'disabled') {
                    return {
                        success: false,
                        error: t('mcp.image.disabled')
                    };
                }

                const validPlatforms = IMAGE_GEN_PLATFORMS.map(p => p.id);
                if (!validPlatforms.includes(platform)) {
                    return {
                        success: false,
                        error: t('mcp.image.unknown_platform', { platform, available: validPlatforms.join(', ') })
                    };
                }

                // Gather API keys
                const apiKeys = plugin?.env?.settings?.pkmAssistant?.chat?.apiKeys || {};
                const keys: ImageGenKeys = {
                    openai: apiKeys.openai,
                    open_router: apiKeys.open_router,
                    gemini: apiKeys.gemini,
                    xai: apiKeys.xai,
                    stability: imageGenSettings.stability_api_key,
                    replicate: imageGenSettings.replicate_api_key,
                };

                log.info('ImageGen', `Generowanie: "${prompt.slice(0, 60)}..." via ${platform}`);

                // Generate
                const result = await generateImage(platform, keys, {
                    prompt,
                    size,
                    style,
                    model: (imageGenSettings[`${platform}_model`] as string) || undefined,
                });

                // Save to vault
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const ext = result.format || 'png';
                const filename = `generated_${timestamp}.${ext}`;
                const savePath = `${folderCheck.safePath}/${filename}`;

                // Write binary (API-first: vault.createBinary; adapter fallback dla ukrytych ścieżek).
                // writeBinary sam zapewnia folder docelowy (vault.createFolder / adapter.mkdir).
                const binaryData = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
                await writeBinary(appRef, savePath, binaryData.buffer);

                // Utwórz notatkę Obsidiana z embeddowanym obrazem
                const noteFilename = `generated_${timestamp}.md`;
                const notePath = `${folderCheck.safePath}/${noteFilename}`;
                const modelUsed = (imageGenSettings[`${platform}_model`] as string) || t('mcp.image.default_model');
                const noteContent = buildImageNoteContent({ filename, prompt, platform, model: modelUsed, date: new Date() });
                await writeText(appRef, notePath, noteContent);

                log.info('ImageGen', `Zapisano: ${savePath} + notatka: ${notePath} (${Math.round(binaryData.length / 1024)} KB)`);

                return {
                    success: true,
                    path: savePath,
                    note_path: notePath,
                    base64: result.base64,
                    format: ext,
                    revised_prompt: result.revised_prompt || null,
                    message: t('mcp.image.generated', { path: savePath }),
                };
            } catch (e) {
                log.error('ImageGen', 'Blad generowania:', e);
                return {
                    success: false,
                    error: t('mcp.image.error', { error: (e as Error).message }),
                };
            }
        },
    };
}
