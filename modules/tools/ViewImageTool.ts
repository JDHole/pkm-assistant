import { t } from '../../core/i18n/index.js';
import { ACTIVE_NOTE_IMAGE_EXTENSIONS, ACTIVE_NOTE_MAX_IMAGE_BYTES, imageBytesAsBlock } from '../multimodal/index.js';
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
            if (!ACTIVE_NOTE_IMAGE_EXTENSIONS.includes(ext)) return fail('unsupported');
            try {
                const file = app.vault.getAbstractFileByPath?.(path.safePath);
                if (!file || isFolderLike(file)) return fail('invalid');
                const stat = file as typeof file & { stat?: { size?: number } };
                if ((stat.stat?.size ?? 0) > ACTIVE_NOTE_MAX_IMAGE_BYTES) return fail('large');
                const bytes = await readBinary(app, path.safePath);
                if (bytes.byteLength > ACTIVE_NOTE_MAX_IMAGE_BYTES) return fail('large');
                const mime = `image/${ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext}`;
                const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
                const { width, height } = bitmap;
                bitmap.close();
                if (!width || !height) return fail('invalid');
                const block = await imageBytesAsBlock(bytes, ext, file.name, bytes.byteLength);
                const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/.exec(block.image_url.url);
                if (!match) return fail('invalid');
                return { kind: 'media' as const, summary: t('mcp.view_image.summary', { path: path.safePath, mime, width, height, size: bytes.byteLength }), images: [{ mime: match[1], base64: match[2] }] };
            } catch { return fail('invalid'); }
        },
    };
}
