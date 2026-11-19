import { t } from '../../core/i18n/index.js';
import { ACTIVE_NOTE_MAX_DIM, ACTIVE_NOTE_MAX_IMAGE_BYTES } from '../multimodal/index.js';
import { arrayBufferToBase64 } from '../../core/index.js';
import { readImageHeader, MAX_IMAGE_PIXELS } from './imageHeader.js';
import { validateVaultPath } from './vault_path_validator.js';
import { isFolderLike, readBinary } from './vault_binary_io.js';
import type { BinaryIoApp } from './vault_binary_io.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

export function createViewImageTool() {
    return {
        name: 'view_image',
        description: t('mcp.view_image.desc'),
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: t('mcp.view_image.path') } }, required: ['path'] },
        contextExtractor: (args: { path?: unknown }) => ({ targetPath: args.path || '' }),
        execute: async (args: { path?: unknown }, app: BinaryIoApp, _plugin: unknown, context?: BuiltinToolExecutionContext) => {
            const fail = (key: string) => ({ success: false, error: t(`mcp.view_image.${key}`) });
            const path = validateVaultPath(args.path);
            if (!path.ok) return fail('denied');
            try {
                if (context?.authorizeFileRead?.(path.safePath)?.allowed !== true) return fail('denied');
            } catch { return fail('denied'); }
            const ext = path.safePath.split('.').pop()?.toLowerCase() ?? '';
            if (ext === 'svg') return fail('svg');
            if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return fail('unsupported');
            try {
                const file = app.vault.getAbstractFileByPath?.(path.safePath);
                if (!file || isFolderLike(file)) return fail('invalid');
                const stat = file as typeof file & { stat?: { size?: number } };
                if ((stat.stat?.size ?? 0) > ACTIVE_NOTE_MAX_IMAGE_BYTES) return fail('large');
                const bytes = await readBinary(app, path.safePath);
                if (bytes.byteLength > ACTIVE_NOTE_MAX_IMAGE_BYTES) return fail('large');
                const header = readImageHeader(bytes);
                if (!header) return fail('header');
                const { mime, width, height } = header;
                if (width * height > MAX_IMAGE_PIXELS) return fail('pixels');
                const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
                let image = { mime, base64: '' };
                try {
                    if (bitmap.width !== width || bitmap.height !== height) return fail('invalid');
                    if (Math.max(width, height) > ACTIVE_NOTE_MAX_DIM) {
                        const scale = ACTIVE_NOTE_MAX_DIM / Math.max(width, height);
                        const canvas = createEl('canvas');
                        try {
                            canvas.width = Math.max(1, Math.round(width * scale));
                            canvas.height = Math.max(1, Math.round(height * scale));
                            const ctx = canvas.getContext('2d');
                            if (!ctx) return fail('invalid');
                            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                            const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
                            if (!blob || blob.type !== 'image/jpeg') return fail('invalid');
                            image = { mime: blob.type, base64: arrayBufferToBase64(await blob.arrayBuffer()) };
                        } finally { canvas.width = 0; canvas.height = 0; }
                    } else image = { mime, base64: arrayBufferToBase64(bytes) };
                } finally { bitmap.close(); }
                return { kind: 'media' as const, summary: t('mcp.view_image.summary', { path: path.safePath, mime, width, height, size: bytes.byteLength }), images: [image] };
            } catch { return fail('invalid'); }
        },
    };
}
