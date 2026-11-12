import test from 'ava';
import { createAppExecutor, createCapturePort, createWorkspacePort } from './index.js';

class ElementTree {
    children: ElementTree[] = [];
    parentElement: ElementTree | null = null;
    classList: string[];
    attributes: Record<string, string> = {};
    display = 'block'; height = 0;
    ownerDocument!: { defaultView: unknown; querySelectorAll: (selector: string) => ElementTree[] };
    constructor(classes = '') { this.classList = classes ? classes.split(' ') : []; }
    append(child: ElementTree) { child.parentElement = this; this.children.push(child); return child; }
    matches(selector: string) {
        return selector.split(',').some(part => {
            const value = part.trim();
            return value === '[class*="block-language-"]' ? this.classList.some(name => name.includes('block-language-')) : value.startsWith('.') && this.classList.includes(value.slice(1));
        });
    }
    querySelectorAll(selector: string): ElementTree[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    closest(selector: string): ElementTree | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    contains(child: ElementTree): boolean { return child === this || this.children.some(item => item.contains(child)); }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    isShown() { return true; }
    getBoundingClientRect() { return { left: 300, top: 80, right: 1200, bottom: 780, height: this.height }; }
}

test.serial('DOM capture classification and zoom fail closed', async t => {
    const previous = globalThis.HTMLElement;
    Object.defineProperty(globalThis, 'HTMLElement', { value: ElementTree, configurable: true });
    try {
        const docRoot = new ElementTree(); const content = docRoot.append(new ElementTree());
        const win = { innerWidth: 1400, innerHeight: 900, getComputedStyle: (el: ElementTree) => ({ display: el.display }) };
        content.ownerDocument = { defaultView: win, querySelectorAll: selector => docRoot.querySelectorAll(selector) };
        const leaf = { isDeferred: false, view: { contentEl: content, containerEl: content, getViewType: () => 'markdown' }, getViewState: () => ({ state: { file: 'Notes/A.md' } }) };
        const app = { workspace: { rootSplit: {}, getMostRecentLeaf: () => leaf, iterateAllLeaves: (fn: (value: unknown) => void) => fn(leaf) }, vault: {}, metadataCache: { getFirstLinkpathDest: (path: string) => ({ path }) } };
        const port = createWorkspacePort(app as never, (value): value is never => !!value && typeof value === 'object' && 'path' in value);
        const rects: unknown[] = []; let zoom: unknown = 2;
        const frame = { getSize: () => ({ width: 1, height: 1 }), resize: () => frame, toJPEG: () => Buffer.from('a') };
        const capture = createCapturePort(() => ({ remote: { getCurrentWebContents: () => ({ getZoomFactor: () => zoom, capturePage: async (rect: unknown) => { rects.push(rect); return frame; } }) } }));
        const execute = createAppExecutor(port, 1000, capture, { screenshot: 'enabled' });
        const context = { authorizeFileRead: (path: string) => ({ allowed: ['Notes/A.md', 'Notes/B.md', 'Allowed/Container.md'].includes(path) }) };
        const run = async (error: string | null) => {
            const before = rects.length; const result = await execute({ action: 'screenshot' }, context);
            if (error) t.deepEqual(result, { ok: false, success: false, error: { code: error, message: error } });
            else t.deepEqual(result, { ok: true, success: true, verified: true, effect: 'unchanged', kind: 'media', summary: 'Obsidian active note screenshot 1x1', images: [{ mime: 'image/jpeg', base64: 'YQ==', width: 1, height: 1 }] });
            t.is(rects.length - before, error ? 0 : 1);
        };
        const backlinks = content.append(new ElementTree('embedded-backlinks')); backlinks.display = 'none';
        await run(null); t.deepEqual(rects[0], { x: 600, y: 160, width: 1800, height: 1400 });
        backlinks.display = 'block'; backlinks.append(new ElementTree('search-result')); await run('restricted_content_visible');
        backlinks.display = 'none';
        for (const name of ['internal-query', 'cm-lang-query', 'block-language-sneaky', 'cm-preview-code-block', 'dataview']) {
            content.append(new ElementTree(name)); await run('restricted_content_visible'); content.children.pop();
        }
        const pre = content.append(new ElementTree()); pre.append(new ElementTree('language-js')); await run(null); content.children.pop();
        const embed = content.append(new ElementTree('internal-embed')); embed.attributes.src = 'Notes/B.md'; await run(null);
        embed.attributes.src = 'Allowed/Container.md'; const nested = embed.append(new ElementTree('image-embed')); nested.attributes.src = './secret.png'; await run('restricted_content_visible'); content.children.pop();
        const menu = docRoot.append(new ElementTree('menu')); await run('overlay_visible'); docRoot.children.pop();
        t.is(menu.parentElement, docRoot);
        zoom = undefined; await run('capture_unavailable');
    } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: previous, configurable: true }); }
});
