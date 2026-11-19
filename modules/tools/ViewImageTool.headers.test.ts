import test from 'ava';
import { createViewImageTool } from './ViewImageTool.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';
import { readImageHeader } from './imageHeader.js';
import { getLocale, setLocale } from '../../core/i18n/index.js';

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

// Valid 3x2 JPEG, generated locally with Pillow; APP1 below adds one TIFF orientation tag.
const jpeg3x2 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCpRRRX1R45/9k=';
function exifJpeg(orientation: number): ArrayBuffer {
    const jpeg = Buffer.from(jpeg3x2, 'base64');
    const app1 = [255, 225, 0, 34, 69, 120, 105, 102, 0, 0, // marker, size, Exif
        73, 73, 42, 0, 8, 0, 0, 0, 1, 0, // little-endian TIFF and IFD count
        18, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
    return Uint8Array.from([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]).buffer;
}

for (const locale of ['en', 'pl'] as const) for (let orientation = 1; orientation <= 8; orientation++) {
    test.serial(`R2: JPEG EXIF ${orientation}, ${locale}: accept display dimensions and retain original bytes`, async t => {
        const original = globalThis.createImageBitmap, previousLocale = getLocale();
        setLocale(locale);
        const width = orientation >= 5 ? 2 : 3, height = orientation >= 5 ? 3 : 2;
        let closed = 0;
        globalThis.createImageBitmap = async () => ({ width, height, close() { closed++; } }) as ImageBitmap;
        t.teardown(() => { globalThis.createImageBitmap = original; setLocale(previousLocale); });
        const bytes = exifJpeg(orientation);
        t.deepEqual(readImageHeader(bytes), { mime: 'image/jpeg', width: 3, height: 2 });
        t.deepEqual(await execute(bytes, 'phone.jpg'), {
            kind: 'media', summary: `phone.jpg | image/jpeg | ${width}x${height} | ${bytes.byteLength} ${locale === 'pl' ? 'bajtów' : 'bytes'}`,
            images: [{ mime: 'image/jpeg', base64: Buffer.from(bytes).toString('base64') }],
        });
        t.is(closed, 1);
    });
}

for (const format of ['png', 'gif', 'VP8X', 'VP8L', 'VP8 ', 'jpeg']) {
    test.serial(`R2: ${format} rejects incompatible decoded dimensions and closes bitmap`, async t => {
        const original = globalThis.createImageBitmap;
        let closed = 0;
        globalThis.createImageBitmap = async () => ({ width: format === 'jpeg' ? 4 : 2, height: 3, close() { closed++; } }) as ImageBitmap;
        t.teardown(() => { globalThis.createImageBitmap = original; });
        t.deepEqual(await execute(header(format, 3, 2), 'misleading.jpg'), { success: false, error: 'Could not read or decode the image.' });
        t.is(closed, 1);
    });
}

test.serial('R2: rotated JPEG scales using display axes and releases resources', async t => {
    const original = globalThis.createImageBitmap, originalCreate = globalThis.createEl;
    let closed = 0;
    const drawn: number[][] = [];
    const canvas = { width: 0, height: 0,
        getContext: () => ({ drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => drawn.push([w, h]) }),
        toBlob: (cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })),
    };
    globalThis.createEl = (() => canvas) as typeof createEl;
    globalThis.createImageBitmap = async () => ({ width: 3000, height: 4000, close() { closed++; } }) as ImageBitmap;
    t.teardown(() => { globalThis.createImageBitmap = original; globalThis.createEl = originalCreate; });
    t.deepEqual(await execute(header('jpeg', 4000, 3000), 'phone.jpg'), {
        kind: 'media', summary: 'phone.jpg | image/jpeg | 3000x4000 | 40 bytes',
        images: [{ mime: 'image/jpeg', base64: 'AQID' }],
    });
    t.deepEqual(drawn, [[1176, 1568]]);
    t.is(closed, 1);
    t.deepEqual([canvas.width, canvas.height], [0, 0]);
});
