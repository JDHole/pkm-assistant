import test from 'ava';
import { createViewImageTool } from './ViewImageTool.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

function header(format: string, width: number, height: number): ArrayBuffer {
    const b = new Uint8Array(40), v = new DataView(b.buffer);
    const str = (at: number, s: string) => b.set(new TextEncoder().encode(s), at);
    if (format === 'png') {
        b.set([137, 80, 78, 71, 13, 10, 26, 10]); v.setUint32(8, 13); str(12, 'IHDR');
        v.setUint32(16, width); v.setUint32(20, height);
    } else if (format === 'gif') {
        str(0, 'GIF89a'); v.setUint16(6, width, true); v.setUint16(8, height, true);
    } else if (format === 'jpeg') {
        b.set([255, 216, 255, 224, 0, 4, 0, 0, 255, 194, 0, 11, 8]);
        v.setUint16(13, height); v.setUint16(15, width);
    } else {
        str(0, 'RIFF'); v.setUint32(4, 32, true); str(8, 'WEBP'); str(12, format);
        v.setUint32(16, 20, true);
        if (format === 'VP8X') {
            const put = (p: number, x: number) => { b[p] = x; b[p + 1] = x >>> 8; b[p + 2] = x >>> 16; };
            put(24, width - 1); put(27, height - 1);
        } else if (format === 'VP8L') {
            b[20] = 47; v.setUint32(21, ((height - 1) << 14) | (width - 1), true);
        } else {
            b.set([157, 1, 42], 23); v.setUint16(26, width, true); v.setUint16(28, height, true);
        }
    }
    return b.buffer;
}
function execute(bytes: ArrayBuffer, path = 'a.png') {
    return createViewImageTool().execute({ path }, { vault: {
        getAbstractFileByPath: () => ({ path, name: path, stat: { size: bytes.byteLength } }),
        readBinary: async () => bytes,
    } } as never, {}, { authorizeFileRead: () => ({ allowed: true }), resultBudgetChars: 0, effectiveResultBudgetChars: 12000,
        shouldAbort: () => false, serializeFinalResult: JSON.stringify } as BuiltinToolExecutionContext);
}

for (const format of ['png', 'jpeg', 'gif', 'VP8X', 'VP8L', 'VP8 ']) {
    test.serial(`header ${format}: >40 MP refuses before browser decode`, async t => {
        const original = globalThis.createImageBitmap;
        let calls = 0;
        globalThis.createImageBitmap = async () => { calls++; return { width: 10000, height: 10000, close() {} } as ImageBitmap; };
        t.teardown(() => { globalThis.createImageBitmap = original; });
        t.deepEqual(await execute(header(format, 10000, 10000)), { success: false, error: 'Image exceeds the 40 megapixel limit.' });
        t.is(calls, 0);
    });
    test.serial(`header ${format}: actual MIME wins over filename`, async t => {
        const original = globalThis.createImageBitmap;
        let decodedMime = '';
        globalThis.createImageBitmap = async (blob: ImageBitmapSource) => { decodedMime = (blob as Blob).type; return { width: 2, height: 1, close() {} } as ImageBitmap; };
        t.teardown(() => { globalThis.createImageBitmap = original; });
        const mime = `image/${format.startsWith('VP8') ? 'webp' : format}`;
        const result = await execute(header(format, 2, 1), 'a.jpg');
        t.is(decodedMime, mime);
        t.like(result, { kind: 'media', images: [{ mime }] });
    });
}

test.serial('unreadable/truncated/zero-size header never reaches decoder', async t => {
    const original = globalThis.createImageBitmap;
    let calls = 0;
    globalThis.createImageBitmap = async () => { calls++; return { width: 1, height: 1, close() {} } as ImageBitmap; };
    t.teardown(() => { globalThis.createImageBitmap = original; });
    for (const bytes of [new ArrayBuffer(0), new Uint8Array(40).buffer, header('png', 0, 1), header('jpeg', 2, 1).slice(0, 16), header('VP8X', 2, 1).slice(0, 29)]) {
        t.deepEqual(await execute(bytes), { success: false, error: 'Cannot read the image header (PNG, JPEG, GIF or WebP required).' });
    }
    t.is(calls, 0);
});

test.serial('dimensions resize even a tiny file; release bitmap and canvas', async t => {
    const original = globalThis.createImageBitmap, originalCreate = globalThis.createEl;
    let closed = 0;
    const drawn: number[][] = [];
    const canvas = { width: 0, height: 0,
        getContext: () => ({ drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => drawn.push([w, h]) }),
        toBlob: (cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })),
    };
    globalThis.createEl = (() => canvas) as typeof createEl;
    globalThis.createImageBitmap = async () => ({ width: 2000, height: 1000, close() { closed++; } }) as ImageBitmap;
    t.teardown(() => { globalThis.createImageBitmap = original; globalThis.createEl = originalCreate; });
    t.like(await execute(header('png', 2000, 1000)), { kind: 'media', images: [{ mime: 'image/jpeg', base64: 'AQID' }] });
    t.deepEqual(drawn, [[1568, 784]]);
    t.is(closed, 1);
    t.deepEqual([canvas.width, canvas.height], [0, 0]);
});
