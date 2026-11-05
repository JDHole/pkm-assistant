import test from 'ava';
import { ApprovalManager } from './ApprovalManager.js';
import type { ApprovalAction, ApprovalHandlerResult } from './ApprovalManager.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const action = { type: 'delegate.share_conversation', agentName: 'Mira', preview: 'PRIVATE' };

test('one-time consent ignores existing always and never persists a new rule', async t => {
    const storage = { alwaysApprovedRules: { Mira: ['delegate.share_conversation::<bez-celu>'] } };
    let saves = 0;
    const manager = new ApprovalManager({}, { storage, onChange: () => { saves++; } });
    const seen: string[] = [];
    manager.setApprovalHandler((_app, value) => { seen.push(value.type); return { result: 'approve', rememberForSession: true }; });
    t.deepEqual(await manager.requestApproval(action), { result: 'approve', reason: '' });
    manager.setApprovalHandler((_app, value) => { seen.push(value.type); return { result: 'always' }; });
    t.deepEqual(await manager.requestApproval(action), { result: 'deny', reason: '' });
    t.deepEqual(seen, ['delegate.share_conversation', 'delegate.share_conversation']);
    t.deepEqual(storage, { alwaysApprovedRules: { Mira: ['delegate.share_conversation::<bez-celu>'] } });
    t.is(saves, 0);
    t.deepEqual(manager.history.map(item => ({ type: item.actionType, result: item.result, preview: Reflect.get(item, 'preview') })), [
        { type: 'delegate.share_conversation', result: 'approve', preview: undefined },
        { type: 'delegate.share_conversation', result: 'deny', preview: undefined },
    ]);
});

for (const stop of ['signal', 'dispose'] as const) {
    test(`one-time ${stop} settles pending consent, aborts the modal and ignores late approve`, async t => {
        const manager = new ApprovalManager({});
        const decision = deferred<ApprovalHandlerResult>();
        const control = new AbortController();
        let seen: ApprovalAction | undefined;
        manager.setApprovalHandler((_app, value) => { seen = value; return decision.promise; });
        const pending = manager.requestApproval({ ...action, signal: control.signal });
        if (stop === 'signal') control.abort(); else manager.dispose();
        t.deepEqual(await pending, { result: 'deny', reason: 'cancelled' });
        t.is(seen?.signal?.aborted, true);
        decision.resolve({ result: 'approve' });
        await decision.promise;
        t.deepEqual(manager.history.map(entry => entry.result), ['deny']);
        t.deepEqual(manager.getAlwaysApprovedRules('Mira'), []);
        if (stop === 'dispose') t.deepEqual(await manager.requestApproval(action), { result: 'deny', reason: 'cancelled' });
    });
}

test('one-time unavailable handler and handler failures fail closed', async t => {
    const manager = new ApprovalManager({});
    t.deepEqual(await manager.requestApproval(action), { result: 'deny', reason: 'handler_unavailable' });
    manager.setApprovalHandler(() => { throw new Error('private error'); });
    t.deepEqual(await manager.requestApproval(action), { result: 'deny', reason: 'handler_unavailable' });
    manager.setApprovalHandler(() => Promise.reject(new Error('private error')));
    t.deepEqual(await manager.requestApproval(action), { result: 'deny', reason: 'handler_unavailable' });
});

test('one-time redirect and denial preserve the user decision', async t => {
    const manager = new ApprovalManager({});
    manager.setApprovalHandler(() => ({ result: 'redirect', instruction: 'Ponów clean.' }));
    t.deepEqual(await manager.requestApproval(action), { result: 'redirect', instruction: 'Ponów clean.' });
    manager.setApprovalHandler(() => ({ result: 'deny', reason: 'Prywatne' }));
    t.deepEqual(await manager.requestApproval(action), { result: 'deny', reason: 'Prywatne' });
    const ctl = new AbortController(); ctl.abort();
    manager.setApprovalHandler(() => { throw new Error('must not open'); });
    t.deepEqual(await manager.requestApproval({ ...action, signal: ctl.signal }), { result: 'deny', reason: 'cancelled' });
});
