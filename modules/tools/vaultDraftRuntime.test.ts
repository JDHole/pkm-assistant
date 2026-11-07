import test from 'ava';
import * as fs from 'node:fs';
import { DRAFT_ROOT, DraftView } from '../vault-drafts/index.js';
import { SubTaskRegistry, SubTaskNotifier, parseSubTaskHistoryRecord } from '../sub-agents/index.js';
import { initializeVaultDrafts } from './vaultDraftRuntime.js';
import { draftFixture, owner, encoder } from './test-support/vaultDraftFixture.js';
import { buildSubTaskResultDelivery } from '../chat/chat/subTaskResultDelivery.js';
import { setLocale } from '../../core/i18n/index.js';
import delegation from './built-in-servers/delegation.manifest.js';

test('P5 runtime restart restores two literal proposals and history without executing work', async t => {
    const f = await draftFixture(t);
    const { task, draft } = await f.run('saved');
    await f.write(draft, 'x.md', 'Propozycja-X');
    await f.write(draft, 'y.md', 'Propozycja-Y');
    await f.registry.flushHistory();
    const saved = f.records.at(-1)!;
    t.deepEqual([parseSubTaskHistoryRecord(saved)?.draft, saved.state], [draft.reference(), 'running']);
    const restored = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry: restored });
    const boot = await initializeVaultDrafts({ ...f.ports, registry: restored });
    t.teardown(() => { boot.dispose(); restored.dispose(); notifier.dispose(); });
    const events: string[] = [];
    for (const event of ['task:created', 'task:finished', 'question:opened']) restored.events.on(event, () => events.push(event));
    t.is(restored.importHistory(f.records, owner), 1);
    const manifest = boot.store.list()[0];
    const view = new DraftView(boot.store, boot.persistence, f.ports.vault, manifest.draftId);
    t.deepEqual([manifest.phase, await view.read('x.md'), await view.read('y.md')], [{ kind: 'sealed', reason: 'restart' }, 'Propozycja-X', 'Propozycja-Y']);
    t.deepEqual([restored.getTask(task.id)?.status, restored.getTask(task.id)?.draft, restored.getTask(task.id)?.draftSummary?.pending], ['aborted', draft.reference(), 2]);
    t.deepEqual([events, notifier.pending(), [...f.files]], [[], [], [['x.md', 'Baza-X'], ['y.md', 'Baza-Y']]]);
    const output = await boot.tool.execute!({ action: 'list' }, undefined, undefined, { draftReview: f.context, shouldAbort: () => false } as never) as { kind: string; changes: Array<{ path: string; status: string }> };
    t.deepEqual([boot.tool.name, delegation.tools.includes(boot.tool.name), output.kind, output.changes.map(c => [c.path, c.status])],
        ['subagent_changes', true, 'listed', [['x.md', 'pending'], ['y.md', 'pending']]]);
});

test('P5 registry retention leaves agent-scoped proposals and isolates two sessions and agents', async t => {
    const f = await draftFixture(t, 1);
    for (const [id, who, path] of [
        ['old', owner, 'x.md'], ['other-session', { ...owner, sessionPath: 'other.md', sessionEpoch: 'b'.repeat(32) }, 'secret-session.md'],
        ['other-agent', { ...owner, agentName: 'Borys' }, 'secret-agent.md'], ['last', owner, 'y.md'],
    ] as const) {
        const { task, draft } = await f.run(id, who);
        await f.write(draft, path, id); await draft.close('finished'); f.registry.finish(task, f.result);
    }
    await f.runtime.flush();
    t.deepEqual(f.registry.list().map(task => task.id), ['last']);
    const session = await f.runtime.review.list(f.context, {}), agent = await f.runtime.review.list(f.context, { scope: 'agent' });
    t.deepEqual(session.kind === 'listed' ? session.changes.map(c => c.path).sort() : session, ['x.md', 'y.md']);
    t.deepEqual(agent.kind === 'listed' ? agent.changes.map(c => c.path).sort() : agent, ['secret-session.md', 'x.md', 'y.md']);
    const second = await f.runtime.review.list({ ...f.context, owner: { ...owner, sessionPath: 'other.md', sessionEpoch: 'b'.repeat(32) } }, {});
    t.deepEqual(second.kind === 'listed' ? second.changes.map(c => c.path) : second, ['secret-session.md']);
    t.deepEqual(f.registry.draftSummaries(owner).flatMap(s => s.changes.map(c => c.path)).sort(), ['x.md', 'y.md']);
});

test('P5 GC preserves C input until its last reference is released and keeps decision receipts', async t => {
    const f = await draftFixture(t);
    f.registry.createThread({ threadId: 'thread-A', name: 'A', owner, origin: owner, config: {} });
    const a = await f.run('A', owner, 'thread-A');
    await f.write(a.draft, 'x.md', 'A'); await a.draft.close('finished');
    f.registry.finish(a.task, f.result);
    const c = await f.run('C', owner, 'thread-A', true);
    const manifest = f.runtime.store.list()[0], change = manifest.changes[0];
    const decision = { action: 'reject' as const, draftId: manifest.draftId, changeId: change.id, revision: change.revision };
    t.deepEqual(await f.runtime.review.decide(f.context, decision), { kind: 'rejected' });
    f.registry.closeThread('thread-A');
    await f.runtime.flush();
    t.deepEqual([await c.draft.view.read('x.md'), f.runtime.store.snapshot(manifest.draftId).payloadCollected ?? false], ['A', false]);
    t.is((await f.storage.list(`${DRAFT_ROOT}/${manifest.draftId}/blobs`)).length, 2);
    await c.draft.close('stopped'); f.registry.finish(c.task, f.result); f.registry.endRun('thread-A', { successful: false });
    await f.runtime.flush();
    t.deepEqual([f.runtime.store.snapshot(manifest.draftId).payloadCollected, await f.storage.list(`${DRAFT_ROOT}/${manifest.draftId}/blobs`)], [true, []]);
    const registry = new SubTaskRegistry();
    const restarted = await initializeVaultDrafts({ ...f.ports, registry });
    t.teardown(() => { restarted.dispose(); registry.dispose(); });
    t.deepEqual(await restarted.review.decide(f.context, decision), { kind: 'rejected' });
    t.is(f.files.get('x.md'), 'Baza-X');
});

test.serial('P5 stopped and failed sub notifications keep draft ID and review instruction', async t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const f = await draftFixture(t);
    for (const end of [{ kind: 'stopped', by: 'user' }, { kind: 'failed', stage: 'work' }, { kind: 'timeout' }] as const) {
        const { task, draft } = await f.run(end.kind);
        await f.write(draft, 'x.md', 'Gotowe'); await draft.close(end.kind);
        const outcome = { end, completeness: 'partial' as const, hasAnswer: false, hasMaterial: true, effects: [] };
        f.registry.finish(task, { ...f.result, outcome, draft: draft.reference(), draftSummary: draft.summary() });
        const delivery = buildSubTaskResultDelivery(task, f.registry, 1);
        t.true(delivery.text.includes(`Kopia draft_id=${draft.reference()!.draftId}: 1 zmian.`));
        t.true(delivery.text.includes('Przejrzyj i rozstrzygnij pliki narzędziem subagent_changes.'));
        t.deepEqual((delivery.meta._subTaskResult as { outcome?: { end: unknown } }).outcome?.end, end);
        t.deepEqual((delivery.meta._subTaskResult as { draftSummary?: { changes: unknown } }).draftSummary?.changes, [{ path: 'x.md', status: 'pending' }]);
    }
});

test('P5 desktop publication cancels at the commit point and never overwrites a generation', async t => {
    const f = await draftFixture(t);
    const path = `${DRAFT_ROOT}/atomic/manifests/000001.json`;
    t.is(await f.storage.publish(path, encoder.encode('cancelled'), () => false), 'cancelled');
    t.deepEqual(await f.storage.list(`${DRAFT_ROOT}/atomic/manifests`), []);
    t.is(await f.storage.publish(path, encoder.encode('Complete'), () => true), 'published');
    await t.throwsAsync(f.storage.publish(path, encoder.encode('Overwrite'), () => true), { code: 'EEXIST' });
    t.is(new TextDecoder().decode(await f.storage.read(path)), 'Complete');
    t.deepEqual(fs.readdirSync(`${f.root}/${DRAFT_ROOT}/atomic/manifests`), ['000001.json']);
});

test('P5 durable history preserves the draft location independently of the run outcome', async t => {
    const f = await draftFixture(t);
    const { task, draft } = await f.run('history-effect');
    await f.write(draft, 'x.md', 'Szkic'); await draft.close('stopped');
    const ref = draft.reference()!;
    const outcome = { end: { kind: 'stopped', by: 'user' } as const, completeness: 'partial' as const, hasAnswer: false, hasMaterial: true,
        effects: [{ tool: 'write', action: 'vault.write', targets: [{ kind: 'vault-file' as const, path: 'x.md' }],
            outcome: 'returned' as const, check: 'matches' as const, location: { kind: 'draft' as const, draftId: ref.draftId } }] };
    f.registry.finish(task, { ...f.result, outcome }); await f.registry.flushHistory();
    const saved = parseSubTaskHistoryRecord(JSON.parse(JSON.stringify(f.records.at(-1))));
    t.deepEqual([saved?.draft, saved?.outcome], [ref, outcome]);
    t.is(f.files.get('x.md'), 'Baza-X');
});
