import test from 'ava';
import { createAppExecutor, type CaptureTarget } from './index.js';

const rect = { x: 300, y: 80, width: 900, height: 700 };
const leaf = { visible: true, active: true, identity: { kind: 'file' as const, path: 'Notes/A.md' }, viewType: 'markdown', title: 'A' };
const frame = { getSize: () => ({ width: 1, height: 1 }), resize: () => frame, toJPEG: () => Buffer.from('a') };
const context = { authorizeFileRead: (path: string) => ({ allowed: path.startsWith('Notes/') }) };
const ok = { ok: true, success: true, verified: true, effect: 'unchanged', kind: 'media', summary: 'Obsidian active note screenshot 1x1', images: [{ mime: 'image/jpeg', base64: 'YQ==', width: 1, height: 1 }] };

test('capture target checks view, embeds, dynamic content and overlays', async t => {
    const target: CaptureTarget = { kind: 'ok', leaf, rect, embeds: [], blocked: [], overlays: [] };
    let current: CaptureTarget = target; const calls: unknown[] = [];
    const execute = createAppExecutor({ describeCaptureTarget: () => current, listLeaves: () => [], getActivePath: () => null, fileExists: () => false, openPath: async () => {} }, 1000, { capture: async value => { calls.push(value); return frame; } });
    const cases: [CaptureTarget, string | null][] = [
        [target, null],
        [{ ...target, leaf: { ...leaf, viewType: 'graph' } }, 'no_capturable_view'],
        [{ ...target, leaf: { ...leaf, viewType: 'pkm-assistant-chat' } }, 'no_capturable_view'],
        [{ ...target, leaf: { ...leaf, visible: false } }, 'no_capturable_view'],
        [{ ...target, embeds: ['Secret/S.md'] }, 'restricted_content_visible'],
        [{ ...target, embeds: [null] }, 'restricted_content_visible'],
        [{ ...target, embeds: ['Notes/B.md'] }, null],
        [{ ...target, blocked: ['.block-language-dataview'] }, 'restricted_content_visible'],
        [{ ...target, overlays: ['.hover-popover'] }, 'overlay_visible'],
    ];
    for (const [value, error] of cases) {
        current = value; const count = calls.length;
        t.deepEqual(await execute({ action: 'screenshot' }, context), error ? { ok: false, success: false, error: { code: error, message: error } } : ok);
        t.deepEqual(calls.slice(count), error ? [] : [rect]);
    }
});

test('timed out capture stays busy and discards late frame', async t => {
    let release: (value: unknown) => void = () => {}; let count = 0; let encoded = 0;
    const pending = new Promise<unknown>(resolve => { release = resolve; });
    const delayed = { ...frame, toJPEG: () => { encoded++; return Buffer.from('a'); } };
    const execute = createAppExecutor({ describeCaptureTarget: () => ({ kind: 'ok', leaf, rect, embeds: [], blocked: [], overlays: [] }), listLeaves: () => [], getActivePath: () => null, fileExists: () => false, openPath: async () => {} }, 20, { capture: async () => { count++; return count === 1 ? pending : frame; } });
    t.deepEqual(await execute({ action: 'screenshot' }, context), { ok: false, success: false, error: { code: 'timeout', message: 'timeout' } });
    for (let i = 0; i < 2; i++) t.deepEqual(await execute({ action: 'screenshot' }, context), { ok: false, success: false, error: { code: 'busy', message: 'busy' } });
    t.is(count, 1); release(delayed); await pending; await new Promise(resolve => window.setTimeout(resolve, 0));
    t.is(encoded, 0); t.deepEqual(await execute({ action: 'screenshot' }, context), ok); t.is(count, 2);
});

test('stopped capture discards the late frame and remains busy', async t => {
    let release: (value: unknown) => void = () => {}; let encoded = 0;
    const pending = new Promise<unknown>(resolve => { release = resolve; });
    const controller = new AbortController();
    const execute = createAppExecutor({ describeCaptureTarget: () => ({ kind: 'ok', leaf, rect, embeds: [], blocked: [], overlays: [] }), listLeaves: () => [], getActivePath: () => null, fileExists: () => false, openPath: async () => {} }, 30, { capture: () => pending });
    const first = execute({ action: 'screenshot' }, { ...context, abortSignal: controller.signal });
    await new Promise(resolve => window.setTimeout(resolve, 0)); controller.abort();
    t.deepEqual(await first, { ok: false, success: false, error: { code: 'aborted', message: 'aborted' } });
    t.deepEqual(await execute({ action: 'screenshot' }, context), { ok: false, success: false, error: { code: 'busy', message: 'busy' } });
    release({ ...frame, toJPEG: () => { encoded++; return Buffer.from('a'); } });
    await pending; await new Promise(resolve => window.setTimeout(resolve, 0));
    t.is(encoded, 0);
});
