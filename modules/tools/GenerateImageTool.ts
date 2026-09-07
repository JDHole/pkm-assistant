/**
 * generate_image — MCP tool do generowania obrazow przez AI.
 * Uzywa ImageGenAdapter z konfigurowalna platforma.
 */
import { generateImage, IMAGE_GEN_PLATFORMS } from '../../modules/multimodal/index.js';
import type { ImageGenKeys } from '../../modules/multimodal/index.js';
import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { writeBinary, writeText } from './vault_binary_io.js';
import { validateVaultPath } from './vault_path_validator.js';
import type { BinaryIoApp } from './vault_binary_io.js';

/** Folder zapisu obrazów, gdy user nie ustawił własnego. */
const DEFAULT_SAVE_FOLDER = 'Attachments/generated';

/**
 * K2 (AUD-security-048): folder, do którego narzędzie NAPRAWDĘ pisze — liczony z ustawień,
 * nie z tekstu modelu. Jedno miejsce, bo czyta go i bramka (`contextExtractor`), i `execute`.
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

export function createGenerateImageTool() {
    const platformNames = IMAGE_GEN_PLATFORMS.map(p => p.name).join(', ');

    return {
        name: 'generate_image',
        description: `Wygeneruj obraz na podstawie opisu tekstowego.

JAK DZIALA:
- Wysylasz opis (prompt) → dostajesz wygenerowany obraz zapisany w vaultcie
- Obslugiwane platformy: ${platformNames}
- Platforma jest konfigurowalna w ustawieniach pluginu

KIEDY UZYWAC:
- User prosi o wygenerowanie obrazu, grafiki, ilustracji
- User mowi: "wygeneruj obraz", "zrob grafike", "narysuj", "create image"
- Potrzebujesz wizualizacji do notatki
- User chce thumbnail, ikone, ilustracje do artykulu

JAK FORMULOWAC PROMPTY:
- Pisz po angielsku (lepsze wyniki na wiekszosci platform)
- Badz szczegolowy: "A serene mountain landscape at sunset with purple clouds" > "gory"
- Opisz styl jesli wazny: "digital art", "oil painting", "photorealistic", "minimalist"

ROZMIARY:
- 1024x1024 (kwadrat, domyslny)
- 1024x1792 (portret)
- 1792x1024 (krajobraz)

UWAGI:
- Wymaga skonfigurowanej platformy i klucza API w ustawieniach
- Obraz jest automatycznie zapisywany do Attachments/generated/ (albo ustawionego folderu — Ustawienia -> Image Gen; .pkm-assistant/ jest niedostepne dla tego narzedzia)
- Generowanie moze trwac 5-30 sekund (zalezne od platformy)`,

        inputSchema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Opis obrazu do wygenerowania. Najlepiej po angielsku, szczegolowy.'
                },
                size: {
                    type: 'string',
                    enum: ['1024x1024', '1024x1792', '1792x1024'],
                    description: 'Rozmiar obrazu. Domyslnie 1024x1024 (kwadrat).'
                },
                style: {
                    type: 'string',
                    description: 'Styl obrazu (np. vivid, natural, digital-art). Opcjonalny.'
                },
            },
            required: ['prompt'],
        },

        // K2 (AUD-security-048): bramka dostaje FOLDER ZAPISU, nie prompt. Dawniej
        // `_extractToolContext` oddawał tu `args.prompt`, więc AccessGuard i koniunkcyjna bariera
        // `scope.folders` suba oceniały tekst, który model sam pisze (dopisanie „Projekty/” na
        // początku promptu wystarczało, żeby strażnik powiedział „whitelist: Projekty”), a dwa
        // realne zapisy szły gdzie indziej — bez żadnej kontroli. Prompt jedzie do okna zgody
        // jako osobne pole, tak jak `memoryContent` przy pamięci.
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

                // K2 (AUD-security-048): folder zapisu przez centralną walidację ZANIM cokolwiek
                // policzymy — źle ustawiony `saveFolder` (`../`, `.pkm-assistant/`, plik chroniony)
                // nie może być furtką do zapisu poza vaultem ani do pamięci innego agenta.
                const saveFolder = resolveSaveFolder(plugin);
                const folderCheck = validateVaultPath(saveFolder);
                if (!folderCheck.ok) {
                    return {
                        success: false,
                        error: t('mcp.image.error', { error: `Niedozwolony folder zapisu "${saveFolder}": ${folderCheck.error}` }),
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

                // Write binary (E2.6 API-first: vault.createBinary; adapter fallback dla ukrytych ścieżek).
                // writeBinary sam zapewnia folder docelowy (vault.createFolder / adapter.mkdir).
                const binaryData = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
                await writeBinary(appRef, savePath, binaryData.buffer);

                // Utwórz notatkę Obsidiana z embeddowanym obrazem
                const noteFilename = `generated_${timestamp}.md`;
                const notePath = `${folderCheck.safePath}/${noteFilename}`;
                const modelUsed = (imageGenSettings[`${platform}_model`] as string) || t('mcp.image.default_model');
                const noteContent = `![[${filename}]]\n\n**Prompt:** ${prompt}\n**Platforma:** ${platform}\n**Model:** ${modelUsed}\n**Wygenerowano:** ${new Date().toLocaleString('pl-PL')}\n`;
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
