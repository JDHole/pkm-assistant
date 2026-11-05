import test from 'ava';
import { SubTaskRegistry } from './index.js';

const owner = { agentName: 'Jaskier', sessionPath: 'chat.md', sessionEpoch: 'e1' };
const signal = () => new AbortController().signal;

async function fill(registry: SubTaskRegistry) {
    return Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => registry.acquire(owner, id, signal())));
}

test('five leases, synchronous FIFO enqueue, one release admits exactly one; duplicate release is inert', async t => {
    const registry = new SubTaskRegistry();
    const leases = await fill(registry);
    const sixth = registry.acquire(owner, 'f', signal());
    const seventh = registry.acquire(owner, 'g', signal());
    t.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => registry.getRunActivity(id)),
        ['working', 'working', 'working', 'working', 'working', 'queued', 'queued']);
    leases[0].release();
    leases[0].release();
    const next = await sixth;
    t.deepEqual(['a', 'f', 'g'].map(id => registry.getRunActivity(id)), ['inactive', 'working', 'queued']);
    next.release();
    const last = await seventh;
    t.deepEqual(['f', 'g'].map(id => registry.getRunActivity(id)), ['inactive', 'working']);
    last.release();
    leases.forEach(lease => lease.release());
    registry.dispose();
});

test('complete owner separates sessions, agents and epochs; tab is not identity', async t => {
    const registry = new SubTaskRegistry();
    const leases = await fill(registry);
    const other = await Promise.all([
        registry.acquire({ ...owner, sessionPath: 'other.md' }, 'other-path', signal()),
        registry.acquire({ ...owner, agentName: 'Klara' }, 'other-agent', signal()),
        registry.acquire({ ...owner, sessionEpoch: 'e2' }, 'other-epoch', signal()),
    ]);
    const same = { ...owner, tabKey: 'other-tab' };
    const queued = registry.acquire(same, 'same', signal());
    t.deepEqual(['other-path', 'other-agent', 'other-epoch', 'same'].map(id => registry.getRunActivity(id)),
        ['working', 'working', 'working', 'queued']);
    leases[0].release();
    (await queued).release();
    [...leases, ...other].forEach(lease => lease.release());
    registry.dispose();
});

test('missing owner does not combine unrelated legacy runs', async t => {
    const registry = new SubTaskRegistry();
    const leases = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(id => registry.acquire({ agentName: 'Jaskier' }, id, signal())));
    t.deepEqual(['a', 'b', 'c', 'd', 'e', 'f'].map(id => registry.getRunActivity(id)),
        ['working', 'working', 'working', 'working', 'working', 'working']);
    leases.forEach(lease => lease.release());
    registry.dispose();
});

test('cancel before admission removes waiting entry and admits the next FIFO entry', async t => {
    const registry = new SubTaskRegistry();
    const leases = await fill(registry);
    const controller = new AbortController();
    const cancelled = registry.acquire(owner, 'cancelled', controller.signal);
    const rejection = t.throwsAsync(cancelled, { message: 'Sub-agent admission cancelled' });
    const next = registry.acquire(owner, 'next', signal());
    controller.abort();
    leases[0].release();
    const lease = await next;
    await rejection;
    t.deepEqual(['cancelled', 'next'].map(id => registry.getRunActivity(id)), ['inactive', 'working']);
    lease.release(); leases.forEach(lease => lease.release()); registry.dispose();
});

test('already aborted request cannot take a slot; abort after admission does not release working lease', async t => {
    const registry = new SubTaskRegistry();
    const controller = new AbortController(); controller.abort();
    await t.throwsAsync(registry.acquire(owner, 'cancelled', controller.signal), { message: 'Sub-agent admission cancelled' });
    const live = new AbortController();
    const working = await registry.acquire(owner, 'working', live.signal);
    live.abort();
    t.deepEqual(['cancelled', 'working'].map(id => registry.getRunActivity(id)), ['inactive', 'working']);
    working.release(); registry.dispose();
});

test('release and reacquire joins the FIFO tail without changing running task status', async t => {
    const registry = new SubTaskRegistry();
    const task = registry.create({ id: 'a', agentName: 'Jaskier', origin: owner });
    const leases = await fill(registry);
    const first = registry.acquire(owner, 'first', signal());
    leases[0].release();
    const resumed = registry.acquire(owner, 'a', signal());
    t.deepEqual({ status: task.status, activity: registry.getRunActivity('a'), first: registry.getRunActivity('first') },
        { status: 'running', activity: 'queued', first: 'working' });
    (await first).release();
    const lease = await resumed;
    t.deepEqual({ status: task.status, activity: registry.getRunActivity('a') }, { status: 'running', activity: 'working' });
    lease.release(); leases.forEach(lease => lease.release()); registry.dispose();
});

test('dispose cancels all pending acquisitions and prevents new admissions', async t => {
    const registry = new SubTaskRegistry();
    const leases = await fill(registry);
    const pending = ['f', 'g'].map(id => t.throwsAsync(registry.acquire(owner, id, signal()), { message: 'Sub-agent admission cancelled' }));
    registry.dispose();
    await Promise.all(pending);
    await t.throwsAsync(registry.acquire(owner, 'h', signal()), { message: 'Sub-agent admission cancelled' });
    leases.forEach(lease => lease.release());
    t.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => registry.getRunActivity(id)),
        ['inactive', 'inactive', 'inactive', 'inactive', 'inactive', 'inactive', 'inactive', 'inactive']);
});

test('provider batch constraint shares the lease, never occupies a conversation slot while queued', async t => {
    const registry = new SubTaskRegistry();
    const group = { limit: 1 };
    const first = await registry.acquire(owner, 'first', signal(), group);
    const next = registry.acquire(owner, 'next', signal(), group);
    t.deepEqual(['first', 'next'].map(id => registry.getRunActivity(id)), ['working', 'queued']);
    first.release();
    const lease = await next;
    t.deepEqual(['first', 'next'].map(id => registry.getRunActivity(id)), ['inactive', 'working']);
    lease.release(); registry.dispose();
});
