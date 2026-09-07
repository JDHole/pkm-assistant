/**
 * Kolejka modali sprzątania (S28 D5) — mikro-decyzja Kuby: JEDEN modal na raz.
 */
import test from 'ava';
import { CleanupQueue } from './cleanupQueue.js';

/** Runner, który trzyma modal „otwarty" aż go ręcznie zamkniemy. */
function manualRunner() {
    const opened: Array<{ agent: string; id: string }> = [];
    let resolveCurrent: (() => void) | null = null;
    const runner = (item: { agent: string; id: string }) => new Promise<void>((resolve) => {
        opened.push(item);
        resolveCurrent = resolve;
    });
    return {
        runner,
        opened,
        closeCurrent() { const r = resolveCurrent; resolveCurrent = null; r?.(); },
    };
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('jeden modal na raz — kolejne czekają, aż poprzedni się zamknie', async t => {
    const m = manualRunner();
    const queue = new CleanupQueue(m.runner);

    queue.enqueue([
        { agent: 'Sonny', id: 'msg-1' },
        { agent: 'Sonny', id: 'msg-2' },
        { agent: 'Sonny', id: 'msg-3' },
    ]);
    await tick();

    t.is(m.opened.length, 1, 'tylko pierwszy modal otwarty');
    t.is(queue.size, 2);
    t.true(queue.isRunning);

    m.closeCurrent(); await tick();
    t.is(m.opened.length, 2);

    m.closeCurrent(); await tick();
    t.is(m.opened.length, 3);

    m.closeCurrent(); await tick();
    t.is(queue.size, 0);
    t.false(queue.isRunning);
    t.deepEqual(m.opened.map(i => i.id), ['msg-1', 'msg-2', 'msg-3']);
});

test('dedupe: ta sama wiadomość nie wchodzi do kolejki dwa razy', async t => {
    const m = manualRunner();
    const queue = new CleanupQueue(m.runner);

    queue.enqueue({ agent: 'Sonny', id: 'msg-1' });
    queue.enqueue({ agent: 'Sonny', id: 'msg-1' });   // duplikat (event z UI i z narzędzia)
    queue.enqueue({ agent: 'Tola', id: 'msg-1' });   // inny agent = inna wiadomość
    await tick();

    t.is(queue.size, 1);
    m.closeCurrent(); await tick();
    m.closeCurrent(); await tick();
    t.deepEqual(m.opened.map(i => `${i.agent}/${i.id}`), ['Sonny/msg-1', 'Tola/msg-1']);
});

test('ta sama wiadomość może wrócić do kolejki po obsłużeniu', async t => {
    const m = manualRunner();
    const queue = new CleanupQueue(m.runner);

    queue.enqueue({ agent: 'Sonny', id: 'msg-1' });
    await tick();
    m.closeCurrent(); await tick();

    queue.enqueue({ agent: 'Sonny', id: 'msg-1' });
    await tick();
    t.is(m.opened.length, 2);
});

test('niekompletne pozycje są ignorowane', async t => {
    const m = manualRunner();
    const queue = new CleanupQueue(m.runner);
    queue.enqueue([{ agent: 'Sonny' }, { id: 'msg-1' }, null, undefined] as unknown as Parameters<CleanupQueue['enqueue']>[0]);
    await tick();
    t.is(m.opened.length, 0);
    t.is(queue.size, 0);
});

test('wywrotka jednego modala nie zatyka kolejki', async t => {
    const opened: string[] = [];
    const queue = new CleanupQueue(async (item) => {
        opened.push(item.id);
        if (item.id === 'msg-1') throw new Error('modal padł');
    });

    queue.enqueue([{ agent: 'A', id: 'msg-1' }, { agent: 'A', id: 'msg-2' }]);
    await tick(); await tick();

    t.deepEqual(opened, ['msg-1', 'msg-2']);
    t.false(queue.isRunning);
});

test('clear() porzuca czekające pozycje (unload pluginu)', async t => {
    const m = manualRunner();
    const queue = new CleanupQueue(m.runner);
    queue.enqueue([{ agent: 'A', id: 'msg-1' }, { agent: 'A', id: 'msg-2' }]);
    await tick();

    queue.clear();
    m.closeCurrent(); await tick();

    t.is(m.opened.length, 1, 'porzucona pozycja nigdy się nie otwiera');
    t.is(queue.size, 0);
});
