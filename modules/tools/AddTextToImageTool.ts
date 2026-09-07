/**
 * add_text_to_image — MCP tool do nakładania tekstu na obrazy.
 * Używa OffscreenCanvas (Electron) do renderowania tekstu na grafice.
 * Działa autonomicznie (render + zapis).
 */
import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { validateVaultPath } from './vault_path_validator.js';
import { renderTextOverlay } from './text_overlay_helper.js';
import type { TextOverlayStyle } from './text_overlay_helper.js';
import { readBinary, writeBinary } from './vault_binary_io.js';
import type { BinaryIoApp, VaultFileLike } from './vault_binary_io.js';

/**
 * `App` widziany przez to narzędzie: to samo co dla I/O binarnego, ale `getAbstractFileByPath`
 * jest tu WYMAGANE — istnienie obrazu sprawdzamy przez Vault API (to zwykły plik vaulta,
 * nie ukryta ścieżka), bez feature-detectu, który robi u siebie `vault_binary_io`.
 */
interface ImageOverlayApp extends BinaryIoApp {
    vault: BinaryIoApp['vault'] & { getAbstractFileByPath: (path: string) => VaultFileLike | null };
}

/** Werdykt bramki uprawnień w zakresie, jakiego dotyka to narzędzie. */
interface PermissionDecisionLike {
    allowed?: boolean;
    reason?: string;
}

/**
 * Agent w zakresie, jakiego dotyka bramka — narzędzie niczego z niego nie czyta samo,
 * tylko podaje go dalej do `PermissionSystem`.
 */
type OverlayAgent = Record<string, unknown>;

/**
 * K16 (AUD-security-102/126): minimalny widok pluginu — bramka uprawnień + rejestr agentów.
 * Lokalny typ strukturalny (konwencja modułu): `PKMPlugin` nie jest importowany, bo to
 * deep-import, a barrel `core` go nie eksportuje.
 */
interface AddTextToImagePlugin {
    permissionSystem?: {
        checkPermission(
            agent: OverlayAgent,
            action: string,
            targetPath?: string | null,
            opts?: { scopeFolders?: unknown },
        ): PermissionDecisionLike;
    } | null;
    agentManager?: {
        getAgent?: (name: string) => OverlayAgent | null | undefined;
        getActiveAgent?: () => OverlayAgent | null | undefined;
    } | null;
}

/**
 * K11/K16: odczyt zaufanego znacznika-listy z args (`_invocationScopeFolders`). Wszystko,
 * co nie jest niepustą tablicą stringów, znaczy „wołający nie zawęża" (kopia reguły
 * z `DelegateTool` — te znaczniki są kontraktem runtime'u, nie polem od modelu).
 */
function readScopeFolders(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    const out = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return out.length > 0 ? out : null;
}

/**
 * K16 (AUD-security-102/126) — OBRAZ ŹRÓDŁOWY PRZEZ PEŁNĄ BRAMKĘ UPRAWNIEŃ.
 *
 * `contextExtractor` oddaje bramce `MCPClienta` WYŁĄCZNIE cel zapisu (akcja `image.generate`),
 * bo to on jest zlewem. Źródło szło dotąd tylko przez `validateVaultPath` — a ta zna
 * `sanitizePath`, pliki chronione i granicę `.pkm-assistant/`, ale NIE zna whitelisty
 * `focusFolders`, strefy No-Go ani `scope.folders` suba. Agent z whitelistą `Publiczne`
 * i No-Go `Prywatne` wołał `{path:'Prywatne/skan.png', output_path:'Publiczne/kopia.png'}`,
 * bramka widziała sam legalny cel — i plik z `Prywatne/` lądował przepisany tam, gdzie agent
 * sięga. Dlatego źródło dostaje TĘ SAMĄ, pełną bramkę (`checkPermission` + `vault.read`),
 * a nie gołego `AccessGuard`: No-Go, pliki chronione, whitelista, zakres suba i `admin_access`
 * mają być liczone w jednym miejscu.
 *
 * Tożsamość i zakres biorą się z ZAUFANYCH znaczników wstrzykiwanych przez `MCPClient`
 * (`_invocationAgentName`, `_invocationScopeFolders`) — model ich nie podrabia. Rozwiązanie
 * agenta jest DOKŁADNIE takie samo jak w `MCPClient` (nazwa, a w jej braku aktywny agent),
 * żeby obie bramki oceniały tę samą tożsamość.
 *
 * Brak bramki albo brak jakiejkolwiek tożsamości (bieg poza `MCPClient`) = ODMOWA fail-closed.
 * Cichy fallback „no to czytaj" znaczyłby, że każda nowa droga wywołania omija kontrolę.
 *
 * @returns `null` gdy wolno; gotowy komunikat odmowy gdy nie.
 */
function denySourceReason(
    args: AddTextToImageArgs,
    plugin: AddTextToImagePlugin | null | undefined,
    safeSource: string,
): string | null {
    const permissionSystem = plugin?.permissionSystem;
    const agentManager = plugin?.agentManager;
    const invocationName = typeof args?._invocationAgentName === 'string' ? args._invocationAgentName : null;
    const agent = (invocationName ? agentManager?.getAgent?.(invocationName) : null)
        || agentManager?.getActiveAgent?.()
        || null;

    if (!agent || typeof permissionSystem?.checkPermission !== 'function') {
        return t('mcp.text_overlay.source_denied', {
            path: safeSource,
            reason: t('mcp.text_overlay.no_permission_gate'),
        });
    }

    const decision = permissionSystem.checkPermission(agent, 'vault.read', safeSource, {
        scopeFolders: readScopeFolders(args?._invocationScopeFolders),
    });
    if (decision?.allowed) return null;

    return t('mcp.text_overlay.source_denied', {
        path: safeSource,
        reason: decision?.reason || t('mcp.text_overlay.no_permission_gate'),
    });
}

/** Argumenty `add_text_to_image` wg `inputSchema` (`image_path` = deprecated alias `path`). */
interface AddTextToImageArgs {
    path?: string;
    image_path?: string;
    text?: unknown;
    position?: string;
    x?: number;
    y?: number;
    fontSize?: number;
    fontFamily?: string;
    color?: string;
    shadow?: boolean;
    shadowColor?: string;
    bold?: boolean;
    italic?: boolean;
    outline?: boolean;
    outlineColor?: string;
    outlineWidth?: number;
    output_path?: string;
    [extra: string]: unknown;
}

/**
 * K2 (AUD-security-016): ścieżka, pod którą narzędzie NAPRAWDĘ zapisze wynik.
 *
 * Domyślna wartość (`<obraz>_text.<ext>`) musi być liczona TAK SAMO w bramce i w `execute` —
 * inaczej bramka znów oceniałaby co innego niż zlew. Zwraca surowy ciąg; walidację robi wołacz.
 */
function outputPathFor(args: AddTextToImageArgs | null | undefined, sourceOverride?: string): string {
    const explicit = args?.output_path;
    if (typeof explicit === 'string' && explicit.trim()) return explicit;
    const source = sourceOverride || (args?.path || args?.image_path || '');
    if (!source) return '';
    const ext = source.split('.').pop();
    return `${source.replace(/\.[^.]+$/, '')}_text.${ext}`;
}

export function createAddTextToImageTool() {
    return {
        name: 'add_text_to_image',
        description: `Nałóż tekst (napis) na istniejący obraz w vaultcie.

JAK DZIAŁA:
- Podajesz ścieżkę do obrazu, tekst i pozycję → dostajesz nowy obraz z nałożonym tekstem
- Pozycje predefiniowane: top-left, top-center, top-right, center, bottom-left, bottom-center, bottom-right
- Albo podaj dokładne x,y (w pikselach)

KIEDY UŻYWAĆ:
- User prosi o dodanie napisu/tekstu/watermarku na obraz
- User mówi: "dodaj napis", "wstaw tekst na grafikę", "podpisz zdjęcie"
- User chce tytuł, watermark, podpis na wygenerowanej grafice

PARAMETRY STYLU:
- fontSize: rozmiar czcionki (domyślnie 32)
- fontFamily: nazwa czcionki (domyślnie "Arial")
- color: kolor tekstu (domyślnie "#ffffff")
- shadow: true/false — cień pod tekstem (domyślnie true)
- shadowColor: kolor cienia (domyślnie "rgba(0,0,0,0.7)")
- bold: true/false (domyślnie false)
- italic: true/false (domyślnie false)
- outline: true/false — obrys wokół tekstu (domyślnie false)
- outlineColor: kolor obrysu (domyślnie "#000000")
- outlineWidth: grubość obrysu (domyślnie 2)`,

        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Ścieżka do obrazu w vaulcie (np. "Attachments/generated/foto.png"). Sprint 04 Z9: canonical name (był `image_path`).'
                },
                image_path: {
                    type: 'string',
                    description: 'DEPRECATED Sprint 04 — użyj `path`. Alias działa z deprecation warning, breaking v3.0.'
                },
                text: {
                    type: 'string',
                    description: 'Tekst do nałożenia na obraz'
                },
                position: {
                    type: 'string',
                    enum: ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right', 'custom'],
                    description: 'Pozycja tekstu. Domyślnie "bottom-left". Użyj "custom" z x/y.'
                },
                x: {
                    type: 'number',
                    description: 'Pozycja X w pikselach (tylko gdy position="custom")'
                },
                y: {
                    type: 'number',
                    description: 'Pozycja Y w pikselach (tylko gdy position="custom")'
                },
                fontSize: {
                    type: 'number',
                    description: 'Rozmiar czcionki (domyślnie 32)'
                },
                fontFamily: {
                    type: 'string',
                    description: 'Czcionka (domyślnie "Arial")'
                },
                color: {
                    type: 'string',
                    description: 'Kolor tekstu, np. "#ffffff" (domyślnie biały)'
                },
                shadow: {
                    type: 'boolean',
                    description: 'Dodaj cień pod tekstem (domyślnie true)'
                },
                shadowColor: {
                    type: 'string',
                    description: 'Kolor cienia (domyślnie "rgba(0,0,0,0.7)")'
                },
                bold: {
                    type: 'boolean',
                    description: 'Pogrubienie (domyślnie false)'
                },
                italic: {
                    type: 'boolean',
                    description: 'Kursywa (domyślnie false)'
                },
                outline: {
                    type: 'boolean',
                    description: 'Obrys wokół tekstu (domyślnie false)'
                },
                outlineColor: {
                    type: 'string',
                    description: 'Kolor obrysu (domyślnie "#000000")'
                },
                outlineWidth: {
                    type: 'number',
                    description: 'Grubość obrysu w px (domyślnie 2)'
                },
                output_path: {
                    type: 'string',
                    description: 'Ścieżka zapisu wyniku. Domyślnie: oryginalny_plik_text.png'
                },
            },
            // Sprint 04 Z9: required is `text`; path/image_path either accepted (alias resolver in MCPClient).
            required: ['text'],
        },

        // K2 (AUD-security-016): bramka dostaje CEL ZAPISU, nie źródło. Dawniej `_extractToolContext`
        // spadał na `default` i oddawał `args.path` (obrazek wejściowy), więc AccessGuard oglądał
        // legalną ścieżkę, a `output_path` — pod który narzędzie NAPRAWDĘ pisało — nie był
        // sprawdzany przez nikogo (ani whitelista, ani No-Go, ani blokada `.pkm-assistant/`).
        contextExtractor: (args: AddTextToImageArgs) => ({
            targetPath: outputPathFor(args),
            approvalContext: { sourcePath: args?.path || args?.image_path || '' },
        }),

        execute: async (args: AddTextToImageArgs, appRef: ImageOverlayApp, plugin: AddTextToImagePlugin | null | undefined) => {
            try {
                // Sprint 04 Z9: prefer canonical `path`, fallback to legacy `image_path` (alias resolver
                // w MCPClient już to robi, ale duplikujemy dla robustness gdy tool jest wywoływany direct).
                const imagePathArg = args.path || args.image_path;
                const {
                    text,
                    position = 'bottom-left',
                    x, y,
                    fontSize = 32,
                    fontFamily = 'Arial',
                    color = '#ffffff',
                    shadow = true,
                    shadowColor = 'rgba(0,0,0,0.7)',
                    bold = false,
                    italic = false,
                    outline = false,
                    outlineColor = '#000000',
                    outlineWidth = 2,
                    // `output_path` czyta `outputPathFor` (wspólne z `contextExtractor`) — K2.
                } = args;

                if (!imagePathArg || typeof imagePathArg !== 'string') {
                    throw new Error(t('mcp.text_overlay.image_required'));
                }
                if (!text || typeof text !== 'string') {
                    throw new Error(t('mcp.text_overlay.text_required'));
                }

                // K2 (AUD-security-016): OBIE ścieżki przez centralną walidację (`validateVaultPath`),
                // a nie przez lokalną parę `sanitizePath` + `isProtectedPath`. Ta para nie znała
                // blokady `.pkm-assistant/` (pamięć innych agentów, indeks semantyczny), a cel
                // zapisu nie przechodził przez nic. Walidacja CELU idzie PRZED odczytem i renderem —
                // odmowa ma być natychmiastowa, nie po przerobieniu obrazka.
                const sourceCheck = validateVaultPath(imagePathArg);
                if (!sourceCheck.ok) {
                    throw new Error(t('mcp.text_overlay.invalid_path', { path: imagePathArg }) || `Invalid path: ${imagePathArg}`);
                }
                const safePath = sourceCheck.safePath;

                const wantedOut = outputPathFor(args, safePath);
                const outCheck = validateVaultPath(wantedOut);
                if (!outCheck.ok) {
                    throw new Error(`Invalid output path: ${wantedOut}`);
                }
                const savePath = outCheck.safePath;

                // K16 (AUD-security-102/126): obraz ŹRÓDŁOWY przez PEŁNĄ bramkę uprawnień —
                // No-Go, pliki chronione, whitelista `focusFolders`, zakres suba, `admin_access`.
                // Idzie PRZED sprawdzeniem istnienia pliku i przed odczytem: odmowa nie ma
                // prawa zdradzić nawet tego, czy plik istnieje. Szczegóły: `denySourceReason`.
                const sourceDenial = denySourceReason(args, plugin, safePath);
                if (sourceDenial) {
                    throw new Error(sourceDenial);
                }

                // Sprawdź czy plik istnieje — Vault API, nie adapter (to zwykły obraz w vaulcie)
                const file = appRef.vault.getAbstractFileByPath(safePath);
                if (!file) {
                    throw new Error(t('mcp.text_overlay.image_not_found', { path: safePath }));
                }

                const textStyle: TextOverlayStyle = {
                    text,
                    position,
                    x: x ?? null,
                    y: y ?? null,
                    fontSize,
                    fontFamily,
                    color,
                    shadow,
                    shadowColor,
                    bold,
                    italic,
                    outline,
                    outlineColor,
                    outlineWidth,
                };

                // Renderuj i zapisz (ścieżka wyjściowa policzona i zwalidowana wyżej — K2)
                log.info('TextOverlay', `Auto-render: "${text.slice(0, 40)}..." na ${safePath}`);

                // E2.6 API-first: vault.readBinary/createBinary; adapter fallback dla ukrytych ścieżek.
                const imageData = await readBinary(appRef, safePath);
                const resultBuffer = await renderTextOverlay(imageData, textStyle);

                // writeBinary sam zapewnia folder docelowy (vault.createFolder / adapter.mkdir).
                await writeBinary(appRef, savePath, resultBuffer);

                log.info('TextOverlay', `Zapisano: ${savePath}`);

                return {
                    success: true,
                    path: savePath,
                    message: t('mcp.text_overlay.saved', { path: savePath }),
                };
            } catch (e) {
                log.error('TextOverlay', 'Błąd:', e);
                return {
                    success: false,
                    error: t('mcp.text_overlay.error', { error: (e as Error).message }),
                };
            }
        },
    };
}

// S30 Z4: re-eksport `renderTextOverlay` USUNIĘTY. Istniał wyłącznie po to, żeby gwiazdka
// w barrelu (`export * from './AddTextToImageTool.js'`) wyniosła helper na zewnątrz modułu —
// a nikt go tam nigdy nie wołał (jedynym konsumentem był modal z wywalonego `modules/comfy`).
// Funkcja żyje w `text_overlay_helper.js` i importuje ją ten plik, wyżej.
