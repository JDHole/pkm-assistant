import test from 'ava';
import { buildRenderResult } from './render.js';
import { createAppExecutor } from './index.js';

const observation = { blocks: [
    { language: 'dataviewjs', text: 'private widget content', error: null },
    { language: 'dataview', text: 'private error message', error: 'private error message' },
    { language: 'js', text: ' ', error: null },
], errors: ['global secret error'], errorsTruncated: false, stabilized: true, elapsedMs: 501, mode: 'preview' };

test('status is content free; details classify, mask and limit text', t => {
    const status = buildRenderResult(observation, false);
    t.deepEqual(status.blocks, [{ number: 1, language: 'dataviewjs', status: 'rendered' }, { number: 2, language: 'dataview', status: 'error' }, { number: 3, language: 'other', status: 'empty' }]);
    t.false(JSON.stringify(status).includes('private widget content'));
    t.false(JSON.stringify(status).includes('private error message'));
    const detail = buildRenderResult(observation, true);
    t.deepEqual(detail.blocks[1], { number: 2, language: 'dataview', status: 'error', text: 'private error message', text_truncated: false, error: 'private error message', error_truncated: false });
    t.deepEqual(detail.global_errors, [{ text: 'global secret error', truncated: false, attribution: 'unassigned' }]);
    t.is(buildRenderResult({ ...observation, stabilized: false }, false).blocks[0].status, 'timeout');
    const long = buildRenderResult({ ...observation, blocks: [{ language: 'js', text: 'x'.repeat(2100) + ' sk-abcdefghijklmnopqrstuvwxyz1234567890', error: 'e'.repeat(1100) }], errors: Array(21).fill('e') }, true);
    const first = long.blocks[0];
    if (!('text' in first)) return t.fail('details missing');
    t.is(first.text.length, 2000); t.true(first.text_truncated); t.true(first.error_truncated); t.true(long.global_errors_truncated);
    const masked = buildRenderResult({ ...observation, blocks: [{ language: 'js', text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', error: null }] }, true);
    t.false(JSON.stringify(masked).includes('abcdefghijklmnopqrstuvwxyz123456'));
});

test('executor denies before open and aborts render wait', async t => {
    let opens = 0; let active = '';
    let started = () => {}; const ready = new Promise<void>(resolve => { started = resolve; });
    const execute = createAppExecutor({ listLeaves: () => [], getActivePath: () => active, fileExists: () => true,
        openPath: async path => { opens++; active = path; }, readSource: async () => '',
        observeRender: async (_path, _wait, signal) => { started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return observation; },
    });
    const denied = await execute({ action: 'render_check', path: 'A.md' }, { agentKnown: true, authorizeFileRead: () => ({ allowed: false }) });
    t.deepEqual(denied, { ok: false, success: false, error: { code: 'access_denied', message: 'access_denied' } }); t.is(opens, 0);
    const sub = await execute({ action: 'render_check', path: 'A.md', _invocationToolNames: [] });
    t.deepEqual(sub, { ok: false, success: false, error: { code: 'sub_agent_denied', message: 'sub_agent_denied' } });
    const controller = new AbortController();
    const result = execute({ action: 'render_check', path: 'A.md' }, { agentKnown: true, authorizeFileRead: () => ({ allowed: true }), abortSignal: controller.signal });
    await ready; controller.abort();
    t.deepEqual(await result, { ok: false, success: false, error: { code: 'aborted', message: 'aborted' } }); t.is(opens, 1);
});

test('executor discloses details only with trusted admin flag', async t => {
    let active = '';
    const execute = createAppExecutor({ listLeaves: () => [], getActivePath: () => active, fileExists: () => true,
        openPath: async path => { active = path; }, readSource: async () => '', observeRender: async () => observation });
    const context = { agentKnown: true, authorizeFileRead: () => ({ allowed: true }) };
    const status = await execute({ action: 'render_check', path: 'A.md', adminAccess: true }, context);
    t.true(status.ok); t.false(JSON.stringify(status).includes('private widget content')); t.false(JSON.stringify(status).includes('private error message'));
    const detail = await execute({ action: 'render_check', path: 'A.md' }, { ...context, canDiscloseDetails: () => true });
    t.true(detail.ok); t.true(JSON.stringify(detail).includes('private widget content')); t.true(JSON.stringify(detail).includes('private error message'));
    const unknown = await execute({ action: 'render_check', path: 'A.md' }, { authorizeFileRead: () => ({ allowed: true }), canDiscloseDetails: () => true });
    t.deepEqual(unknown, { ok: false, success: false, error: { code: 'access_denied', message: 'access_denied' } });
});

test('coverage uses source fence lines and distinguishes unrendered blocks', t => {
    const source = 'intro\n```dataviewjs\nx\n```\n~~~dataview\ny\n~~~';
    const partial = buildRenderResult({ ...observation, blocks: [] }, false, source);
    t.deepEqual(partial.source_blocks, { count: 2, dataview: [5], dataviewjs: [2] });
    t.deepEqual(partial.observed_blocks, { count: 0, dataview: 0, dataviewjs: 0 });
    t.is(partial.coverage, 'partial'); t.is(partial.coverage_note, 'Some blocks were not rendered by Obsidian (lazy rendering or collapsed headings) and were not checked.');
    const complete = buildRenderResult(observation, false, source);
    t.is(complete.coverage, 'complete'); t.is(complete.block_numbering, 'observed_order');
});
