import test, { type ExecutionContext } from 'ava';
import { Menu, Platform } from 'obsidian';
import { AttachmentManager } from './AttachmentManager.js';
import { getLocale, setLocale } from '../../core/i18n/index.js';
import type { PluginApi } from '../../core/index.js';

type Options = NonNullable<ConstructorParameters<typeof AttachmentManager>[2]>;
type PdfLib = NonNullable<Awaited<ReturnType<NonNullable<Options['loadPdfJs']>>>>;
type HostMenu = Menu & { items: { title: string; callback: () => void }[] };
const FILE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.md,.txt,.js,.ts,.jsx,.tsx,.css,.scss,.html,.htm,.json,.yaml,.yml,.xml,.csv,.py,.rb,.java,.c,.cpp,.h,.rs,.go,.sh,.bat,.ps1,.sql,.r,.lua,.toml,.ini,.cfg,.env,.log,.svg,.pdf';

function fixture(t: ExecutionContext, options: Options = {}, platform = 'phone', locale = 'en') {
    const previous = { phone: Platform.isPhone, mobile: Platform.isMobile, tablet: Platform.isTablet, locale: getLocale() };
    Platform.isPhone = platform === 'phone';
    Platform.isMobile = platform !== 'desktop';
    Platform.isTablet = platform === 'tablet';
    setLocale(locale);
    const menus: HostMenu[] = [], inputs: HTMLInputElement[] = [];
    const show = Menu.prototype.showAtMouseEvent;
    Menu.prototype.showAtMouseEvent = function () { menus.push(this as HostMenu); return this; };
    const create = globalThis.createEl;
    // The harness DOM has no event dispatch or attributes. Supply browser boundaries,
    // leaving the actual button handler, Menu and file intake in production code.
    const listenerCounts = new Map<HTMLElement, Set<string>>();
    globalThis.createEl = ((...args: Parameters<typeof createEl>) => {
        const el = create(...args);
        const events = new EventTarget();
        const listeners = new Set<string>();
        listenerCounts.set(el, listeners);
        el.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, opts?: AddEventListenerOptions | boolean) => {
            listeners.add(type);
            events.addEventListener(type, listener, opts);
        };
        el.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, opts?: EventListenerOptions | boolean) => {
            listeners.delete(type);
            events.removeEventListener(type, listener, opts);
        };
        el.dispatchEvent = events.dispatchEvent.bind(events);
        el.click = () => { el.dispatchEvent(new Event('click')); };
        const attributes = new Map<string, string>();
        el.setAttribute = (name, value) => { attributes.set(name, value); };
        el.getAttribute = name => attributes.get(name) ?? null;
        if (args[0] === 'input') {
            const input = el as HTMLInputElement;
            Object.defineProperty(input, 'files', { configurable: true, writable: true, value: null });
            inputs.push(input);
        }
        return el;
    }) as typeof createEl;
    const globalPdf = window as Window & { pdfjsLib?: PdfLib };
    const pdf = globalPdf.pdfjsLib;
    delete globalPdf.pdfjsLib;
    const reader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
    // FileReader's transport boundary uses real Blob bytes, not a canned attachment.
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: class {
        result = '';
        onload?: () => void;
        onerror?: (error: unknown) => void;
        readAsDataURL(blob: Blob) {
            void blob.arrayBuffer().then(buffer => {
                this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
                this.onload?.();
            }, error => this.onerror?.(error));
        }
    } });
    const rejected: string[] = [];
    const manager = new AttachmentManager(createDiv(), {} as PluginApi, {
        onReject: message => rejected.push(message), ...options,
    });
    t.teardown(() => {
        manager.destroy();
        globalThis.createEl = create;
        Menu.prototype.showAtMouseEvent = show;
        Platform.isPhone = previous.phone; Platform.isMobile = previous.mobile; Platform.isTablet = previous.tablet;
        setLocale(previous.locale);
        if (pdf === undefined) delete globalPdf.pdfjsLib;
        else globalPdf.pdfjsLib = pdf;
        if (reader) Object.defineProperty(globalThis, 'FileReader', reader);
        else Reflect.deleteProperty(globalThis, 'FileReader');
    });
    return { manager, inputs, menus, rejected, globalPdf, listenerCounts };
}

async function settled(read: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (read()) return;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('File intake did not settle');
}

function select(input: HTMLInputElement, files: File[]) {
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change'));
}

function pdfLibrary(pages: string[][]): PdfLib {
    return { getDocument: () => ({ promise: Promise.resolve({
        numPages: pages.length,
        getPage: async number => ({ getTextContent: async () => ({ items: pages[number - 1].map(str => ({ str })) }) }),
    }) }) };
}

for (const locale of ['pl', 'en']) {
    test.serial(`F1 phone paperclip: literal menu and all picker routes (${locale})`, async t => {
        const { manager, inputs, menus, listenerCounts } = fixture(t, {}, 'phone', locale);
        manager.getAttachButton().click();
        t.is(inputs.length, 0);
        t.deepEqual(menus[0].items.map(item => item.title), locale === 'pl'
            ? ['Zrób zdjęcie', 'Zdjęcie z galerii', 'Plik'] : ['Take a photo', 'Photo from gallery', 'File']);
        for (let i = 0; i < 3; i++) {
            menus[0].items[i].callback();
            const input = inputs[i];
            t.deepEqual([input.type, input.accept, input.getAttribute('capture'), input.multiple], [
                'file', i === 2 ? FILE_ACCEPT : 'image/*', i === 0 ? 'environment' : null, i !== 0,
            ]);
            select(input, i === 2 ? [new File(['blue notebook'], 'note.txt', { type: 'text/plain' })]
                : [new File(['photo'], `photo${i}`, { type: 'image/jpeg' })]);
            await settled(() => manager.attachments.length === i + 1);
            t.is(listenerCounts.get(input)?.size, 0);
        }
        t.deepEqual(manager.snapshotAttachments().map(a => [a.type, a.name, a.content, a.mimeType]), [
            ['image', 'photo0', 'cGhvdG8=', 'image/jpeg'], ['image', 'photo1', 'cGhvdG8=', 'image/jpeg'],
            ['text', 'note.txt', 'blue notebook', 'text/plain'],
        ]);
    });
}
for (const platform of ['desktop', 'tablet']) {
    test.serial(`F1 ${platform}: paperclip immediately opens unchanged picker`, async t => {
        const { manager, inputs, menus } = fixture(t, {}, platform);
        manager.getAttachButton().click();
        t.deepEqual([inputs[0].type, inputs[0].accept, inputs[0].getAttribute('capture'), inputs[0].multiple],
            ['file', FILE_ACCEPT, null, true]);
        t.is(menus.length, 0);
        select(inputs[0], [new File(['unchanged'], 'note.txt')]);
        await settled(() => manager.attachments.length === 1);
        t.is(manager.buildMessageContent('Read').content, '📎 Attachment: note.txt\n```\nunchanged\n```\n\nRead');
    });
}

for (const end of ['cancel', 'empty change', 'replacement', 'destroy']) {
    test.serial(`F1 picker cleanup: ${end} removes listeners and prevents stale file intake`, async t => {
        const { manager, inputs, menus, listenerCounts } = fixture(t);
        manager.getAttachButton().click();
        menus[0].items[2].callback();
        const old = inputs[0];
        t.deepEqual([...listenerCounts.get(old)!].sort(), ['cancel', 'change']);
        if (end === 'cancel') old.dispatchEvent(new Event('cancel'));
        if (end === 'empty change') select(old, []);
        if (end === 'replacement') menus[0].items[2].callback();
        if (end === 'destroy') manager.destroy();
        t.is(listenerCounts.get(old)?.size, 0);
        t.false(document.body.contains(old));
        select(old, [new File(['stale'], 'stale.txt')]);
        // New intake still works after cancellation/replacement. For destroy, use a new manager.
        const next = end === 'destroy' ? new AttachmentManager(createDiv(), {} as PluginApi) : manager;
        if (end === 'destroy') t.teardown(() => next.destroy());
        await next._processFileList([new File(['current'], 'current.txt')]);
        t.deepEqual(next.snapshotAttachments().map(a => [a.name, a.content]), [['current.txt', 'current']]);
    });
}

for (const platform of ['phone', 'desktop']) {
    test.serial(`F1 PDF ${platform}: lazy loader supplies literal page text to message`, async t => {
        const { manager } = fixture(t, { loadPdfJs: async () => pdfLibrary([['Blue', 'notebook'], ['Second page']]) }, platform);
        await manager._processFileList([new File(['pdf'], 'notes.pdf')]);
        t.is(manager.buildMessageContent('Read').content,
            '📎 Attachment: notes.pdf\n```\n--- Page 1 ---\nBlue notebook\n\n--- Page 2 ---\nSecond page\n```\n\nRead');
    });
}
for (const failure of ['throws', 'null', 'missing API']) {
    test.serial(`F1 PDF ${failure}: existing unavailable-text placeholder`, async t => {
        const options: Options = failure === 'missing API' ? {} : { loadPdfJs: async () => {
            if (failure === 'throws') throw new Error('host loader failed');
            return null;
        } };
        const { manager } = fixture(t, options);
        await manager._processFileList([new File(['pdf'], 'notes.pdf')]);
        t.is(manager.attachments[0].content, 'Attached PDF: notes.pdf (3 B) - text extraction unavailable');
    });
}
test.serial('F1 PDF: existing global wins over loader and contributes text', async t => {
    let loads = 0;
    const { manager, globalPdf } = fixture(t, { loadPdfJs: async () => { loads++; return null; } });
    globalPdf.pdfjsLib = pdfLibrary([['Already loaded']]);
    await manager._processFileList([new File(['pdf'], 'notes.pdf')]);
    t.is(manager.attachments[0].content, '--- Page 1 ---\nAlready loaded');
    t.is(loads, 0);
});
test.serial('F1 PDF: retains 50-page limit and skipped-page notice', async t => {
    const pages = Array.from({ length: 52 }, (_, i) => i === 49 ? ['Last extracted page'] : []);
    const { manager } = fixture(t, { loadPdfJs: async () => pdfLibrary(pages) });
    await manager._processFileList([new File(['pdf'], 'notes.pdf')]);
    t.is(manager.attachments[0].content, '--- Page 50 ---\nLast extracted page\n\n\n... skipped 2 pages ...');
});
for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    test.serial(`F1 ${mime} without extension: accepted into model content`, async t => {
        const { manager } = fixture(t);
        await manager._processFileList([new File(['photo'], 'camera', { type: mime })]);
        t.deepEqual(manager.buildMessageContent('Look').content, [
            { type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: `data:${mime};base64,cGhvdG8=` } },
        ]);
    });
}
for (const mime of ['image/heic', 'image/heif']) {
    test.serial(`F1 ${mime}: phone reports unsupported file and continues processing`, async t => {
        const { manager, rejected } = fixture(t, {}, 'phone', 'pl');
        await manager._processFileList([new File(['photo'], 'camera', { type: mime }), new File(['ok'], 'note.txt')]);
        t.deepEqual(rejected, [`Nieobsługiwany typ pliku: camera (.camera, mime: ${mime})`]);
        t.deepEqual(manager.snapshotAttachments().map(a => [a.name, a.content]), [['note.txt', 'ok']]);
    });
}

test.serial('F1 phone: supported camera MIME takes precedence over a HEIC filename', async t => {
    const { manager } = fixture(t);
    await manager._processFileList([new File(['photo'], 'camera.heic', { type: 'image/jpeg' })]);
    t.deepEqual(manager.buildMessageContent('Look').content, [
        { type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,cGhvdG8=' } },
    ]);
});
test.serial('F1 phone: HEIC extension without MIME reports existing rejection', async t => {
    const { manager, rejected } = fixture(t);
    await manager._processFileList([new File(['photo'], 'camera.heic')]);
    t.deepEqual(rejected, ['Unsupported file type: camera.heic (.heic, mime: )']);
    t.is(manager.buildMessageContent('Look').content, 'Look');
});
for (const platform of ['desktop', 'tablet']) {
    test.serial(`F1 ${platform}: image MIME intake remains unchanged`, async t => {
        const { manager } = fixture(t, {}, platform);
        await manager._processFileList([new File(['photo'], 'camera.heic', { type: 'image/heic' })]);
        t.deepEqual(manager.buildMessageContent('Look').content, [
            { type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/heic;base64,cGhvdG8=' } },
        ]);
    });
}
