import test from 'ava';
import { createViewImageTool } from './ViewImageTool.js';
import { asToolMedia, mediaTextPart, toToolMessageContent } from './toolMedia.js';
import { formatSessionEvent } from '../memory/activeSessionFormat.js';
import type { BinaryIoApp } from './vault_binary_io.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

function fixture(size = 68) {
    const calls: string[] = [];
    const file = { path: 'Images/a.png', name: 'a.png', extension: 'png', stat: { size } };
    const app = { vault: { getAbstractFileByPath: () => file, readBinary: async () => { calls.push('read'); return Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')).buffer; } } } as unknown as BinaryIoApp;
    const context = { authorizeFileRead: (path: string) => { calls.push(path); return { allowed: true }; } } as BuiltinToolExecutionContext;
    return { app, context, calls };
}

test.serial('view_image authorizes before reading and delivers media without base64 in text or session', async t => {
    const original = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} }) as ImageBitmap;
    t.teardown(() => { globalThis.createImageBitmap = original; });
    const f = fixture();
    const result = await createViewImageTool().execute({ path: 'Images/a.png' }, f.app, {}, f.context);
    t.deepEqual(f.calls, ['Images/a.png', 'read']);
    t.deepEqual(result, { kind: 'media', summary: 'Images/a.png | image/png | 1x1 | 68 bytes', images: [{ mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' }] });
    const media = asToolMedia('view_image', result)!;
    const text = toToolMessageContent(media, { vision: false, textPart: mediaTextPart('view_image', result) });
    t.is(text, '{"kind":"media","summary":"Images/a.png | image/png | 1x1 | 68 bytes","images":[{"mime":"image/png"}],"image_delivery":"not delivered: model without vision"}');
    const session = formatSessionEvent('mcp_call', { tool: 'view_image', result }, '2026-11-19T00:00:00.000Z');
    t.false(session.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='));
    t.true(session.includes('[image image/png ~1 kB]'));
    const vision = toToolMessageContent(media, { vision: true, textPart: mediaTextPart('view_image', result) });
    t.deepEqual(vision, [{ type: 'text', text: JSON.stringify(mediaTextPart('view_image', result)) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' } }]);
    t.true(session.includes('view_image'));
});

test.serial('view_image denies unauthorized, unsupported, oversized and corrupt files', async t => {
    const f = fixture();
    const denied = { ...f.context, authorizeFileRead: () => ({ allowed: false }) };
    t.deepEqual(await createViewImageTool().execute({ path: 'Images/a.png' }, f.app, {}, denied), { success: false, error: 'Invalid or inaccessible image path.' });
    t.deepEqual(f.calls, []);
    t.deepEqual(await createViewImageTool().execute({ path: '.pkm-assistant/a.png' }, f.app, {}, f.context), { success: false, error: 'Invalid or inaccessible image path.' });
    t.deepEqual(await createViewImageTool().execute({ path: 'Images/a.txt' }, f.app, {}, f.context), { success: false, error: 'The file is not a supported image.' });
    const big = fixture(10 * 1024 * 1024 + 1);
    t.deepEqual(await createViewImageTool().execute({ path: 'Images/a.png' }, big.app, {}, big.context), { success: false, error: 'Image exceeds the 10 MiB limit.' });
    t.deepEqual(big.calls, ['Images/a.png']);
    const original = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => { throw new Error('decoder detail'); };
    t.teardown(() => { globalThis.createImageBitmap = original; });
    t.deepEqual(await createViewImageTool().execute({ path: 'Images/a.png' }, f.app, {}, f.context), { success: false, error: 'Could not read or decode the image.' });
});
