import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { arrayBufferToBase64, fenceUntrusted } from '../../core/index.js';
// `import type` = ZERO emitu — plik dalej nie wciąga `obsidian` do runtime'u
// (test `active_note.test.ts` importuje go w gołym Node, bez mocka).
import type { App, TFile } from 'obsidian';

/** Blok obrazu w stylu OpenAI (`image_url` z data-URL-em). */
export interface ImageUrlBlock {
    type: 'image_url';
    image_url: { url: string };
}

/** Kontekst aktywnej notatki wstrzykiwany do promptu. */
export interface ActiveNoteContext {
    text: string;
    images: ImageUrlBlock[];
}

/** Opcje `buildActiveNoteContext` — patrz `canReadImage` (K23). */
export interface ActiveNoteOptions {
    /**
     * K23 (AUD-security-119): bramka dostępu do OSADZONYCH obrazów (`![[…]]`).
     *
     * Dostaje ścieżkę vaultową rozwiązanego pliku i mówi, czy agent tej tury ma prawo ją
     * czytać. Wołacz buduje ją z pełnego `PermissionSystem.checkPermission(agent,'vault.read',…)`
     * — No-Go, pliki chronione, whitelista `focusFolders`, `admin_access`. Ten moduł ma
     * zostać node-testowalny, więc NIE importuje `core/security` sam.
     *
     * BRAK predykatu = fail-closed: żaden osadzony obraz nie zejdzie z dysku. Nowy wołacz,
     * który zapomni go podać, dostanie sam tekst notatki zamiast kompletu obrazów.
     */
    canReadImage?: ((vaultPath: string) => boolean) | null;
}

const ACTIVE_NOTE_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const ACTIVE_NOTE_MAX_IMAGES = 5;
const ACTIVE_NOTE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACTIVE_NOTE_OPTIMIZE_THRESHOLD = 1024 * 1024;
const ACTIVE_NOTE_MAX_DIM = 1568;

/**
 * Ogrodzenie Oczka (K9 / AUD-security-002).
 *
 * `text` z tej funkcji dokleja się na KONIEC promptu systemowego (`chat_streaming`), a niesie
 * nazwę pliku, frontmatter i do 2000 znaków body — czyli tekst, którego operator nie pisał
 * (notatka z clippera, wynik `web_read` zapisany przez agenta, plik z synca). Bez ogrodzenia
 * nagłówek `## …` z notatki jest nagłówkiem promptu. Jedna funkcja dla wszystkich kanałów:
 * `core/security/promptFence.js` — escapuje treść, więc znacznika nie da się zamknąć od środka.
 */
function fenceActiveNote(text: string): string {
    return fenceUntrusted(text, 'active_note');
}

/**
 * Build active note context for prompt injection.
 * Returns { text, images } where images are OpenAI-style image_url blocks.
 * `text` wraca ZAWSZE w ogrodzeniu `<vault_content source="active_note">` (patrz `fenceActiveNote`).
 *
 * DWIE BRAMKI, DWIE RÓŻNE RZECZY (K9 + K23):
 *  - `text` (nazwa pliku, frontmatter, do 2000 znaków body) jest OGRODZONY — to obrona przed
 *    wstrzyknięciem instrukcji, nie przed wyciekiem.
 *  - `images` z OSADZEŃ przechodzą przez `opts.canReadImage` — to obrona przed wyniesieniem
 *    pliku, którego agent nie ma prawa czytać.
 *
 * Granica idzie po INTENCJI USERA: aktywny plik user otworzył SAM (jego wybór, jego ryzyko),
 * ale osadzenia `![[…]]` wciąga za nim treść notatki — a tę mógł napisać ktokolwiek
 * (clipper, sync, plik od kogoś). Dlatego bramkujemy osadzenia, nie sam otwarty plik.
 */
export async function buildActiveNoteContext(app: App, opts: ActiveNoteOptions = {}): Promise<ActiveNoteContext | null> {
    const file = app?.workspace?.getActiveFile?.();
    if (!file) return null;

    const ext = file.extension?.toLowerCase();
    const images: ImageUrlBlock[] = [];

    if (ACTIVE_NOTE_IMAGE_EXTENSIONS.includes(ext)) {
        const text = `## ${t('chat.model.open_image', { name: file.name })}\n${t('chat.model.note_path', { path: file.path })}`;
        const imgBlock = await readVaultImageAsBlock(app, file);
        if (imgBlock) images.push(imgBlock);
        return { text: fenceActiveNote(text), images };
    }

    if (ext !== 'md') {
        const text = `## ${t('chat.model.open_file', { name: file.name })}\n${t('chat.model.note_path', { path: file.path })}`;
        return { text: fenceActiveNote(text), images };
    }

    const lines = [`## ${t('chat.model.openNote', { name: file.basename })}`, `${t('chat.model.note_path', { path: file.path })}`];

    try {
        const cache = app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (fm && Object.keys(fm).length > 0) {
            const entries = Object.entries(fm)
                .filter(([k]) => k !== 'position')
                .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                .join('\n');
            if (entries) lines.push(`Frontmatter:\n${entries}`);
        }
    } catch (e) {
        log.warn('ActiveNote', 'Frontmatter read failed:', e);
    }

    let raw = '';
    try {
        raw = await app.vault.cachedRead(file);
        let content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
        if (content.length > 2000) {
            content = content.slice(0, 2000) + '\n' + t('chat.model.note_truncated');
        }
        if (content) lines.push(`${t('chat.model.note_content')}\n${content}`);
    } catch (e) {
        log.warn('ActiveNote', 'Content read failed:', e);
    }

    if (raw) {
        // K23: predykat czytany RAZ, przed pętlą — brak = żadnych bajtów (fail-closed).
        const canReadImage = typeof opts?.canReadImage === 'function' ? opts.canReadImage : null;
        const embeddedImages = extractEmbeddedImagePaths(raw);

        if (embeddedImages.length > 0 && !canReadImage) {
            log.warn('ActiveNote', `Embedded images skipped (${embeddedImages.length}): no access predicate (K23 fail-closed)`);
        }

        for (const imgPath of embeddedImages.slice(0, ACTIVE_NOTE_MAX_IMAGES)) {
            if (!canReadImage) break;
            try {
                const resolved = app.metadataCache.getFirstLinkpathDest(imgPath, file.path);
                if (!resolved || !ACTIVE_NOTE_IMAGE_EXTENSIONS.includes(resolved.extension?.toLowerCase())) continue;
                // Bramka PRZED odczytem bajtów: odmowa = obraz pomijany, nie wyjątek (reszta
                // osadzeń i tekst notatki lecą dalej). Rzut z predykatu = to samo, przez catch.
                if (!canReadImage(resolved.path)) {
                    log.warn('ActiveNote', `Embedded image denied by access gate: ${resolved.path}`);
                    continue;
                }
                const imgBlock = await readVaultImageAsBlock(app, resolved);
                if (imgBlock) images.push(imgBlock);
            } catch (e) {
                log.debug('ActiveNote', `Skip embedded image "${imgPath}":`, e);
            }
        }
    }

    return { text: fenceActiveNote(lines.join('\n')), images };
}

export async function readVaultImageAsBlock(app: App, file: TFile): Promise<ImageUrlBlock | null> {
    try {
        const fileSize = file.stat?.size || 0;
        if (fileSize > ACTIVE_NOTE_MAX_IMAGE_BYTES) {
            log.warn('ActiveNote', `Image too large (${Math.round(fileSize / 1024)}KB): ${file.path}`);
            return null;
        }
        const arrayBuffer = await app.vault.readBinary(file);
        const ext = file.extension?.toLowerCase();

        if (fileSize > ACTIVE_NOTE_OPTIMIZE_THRESHOLD && ext !== 'svg') {
            try {
                const blob = new Blob([arrayBuffer], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
                const bitmap = await createImageBitmap(blob);
                const { width, height } = bitmap;
                const scale = Math.min(1, ACTIVE_NOTE_MAX_DIM / Math.max(width, height));
                const newW = Math.round(width * scale);
                const newH = Math.round(height * scale);
                // Element odłączony: bufor offscreen do zmiany rozmiaru obrazu, nigdy nie
                // trafia do DOM — `createEl` globalny z obsidiana robi to samo co
                // `document.createElement('canvas')`, bez parenta. Ta gałąź kodu nie jest
                // wołana przez testy AVA (`active_note.test.ts`), więc plik zostaje node-safe.
                const canvas = createEl('canvas');
                canvas.width = newW;
                canvas.height = newH;
                // Świeży `<canvas>` zawsze oddaje kontekst 2D; gdyby nie — TypeError leci
                // do `catch (optErr)` poniżej i wracamy do oryginału, tak jak dotąd.
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                ctx.drawImage(bitmap, 0, 0, newW, newH);
                bitmap.close();
                const optimizedBlob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.85));
                canvas.width = 0;
                canvas.height = 0;
                // `toBlob` może oddać null — wtedy leci TypeError w to samo `catch` co wyżej.
                const optimizedBuffer = await optimizedBlob!.arrayBuffer();
                const base64 = arrayBufferToBase64(optimizedBuffer);
                log.info('ActiveNote', `Optimized ${file.name} ${width}x${height} -> ${newW}x${newH}`);
                return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } };
            } catch (optErr) {
                log.warn('ActiveNote', `Optimization failed, using original: ${file.name}`, optErr);
            }
        }

        const base64 = arrayBufferToBase64(arrayBuffer);
        const mime = ext === 'jpg' ? 'jpeg' : (ext === 'svg' ? 'svg+xml' : ext);
        return { type: 'image_url', image_url: { url: `data:image/${mime};base64,${base64}` } };
    } catch (e) {
        log.warn('ActiveNote', `Image read failed: ${file.path}`, e);
        return null;
    }
}

export function extractEmbeddedImagePaths(content: string): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    const wikiRe = /!\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wikiRe.exec(content)) !== null) {
        const p = m[1].trim();
        if (!seen.has(p) && looksLikeImage(p)) {
            seen.add(p);
            paths.push(p);
        }
    }
    const mdRe = /!\[[^\]]*?\]\(([^)]+?)\)/g;
    while ((m = mdRe.exec(content)) !== null) {
        const p = m[1].trim();
        if (!seen.has(p) && looksLikeImage(p) && !p.startsWith('http')) {
            seen.add(p);
            paths.push(p);
        }
    }
    return paths;
}

function looksLikeImage(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    // `pop()` na wyniku `split` nie jest undefined, ale TS tego nie wie — asercja zamiast
    // dokładania strażnika (runtime bez zmian).
    return ACTIVE_NOTE_IMAGE_EXTENSIONS.includes(ext as string);
}
