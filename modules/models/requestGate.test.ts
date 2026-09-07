import test from 'ava';
import { acquireSlot, gateSnapshot, __test__ } from './requestGate.js';

test.beforeEach(() => {
    __test__.reset();
});

test.serial('limit 0 = bramka wyłączona: wszyscy od ręki', async t => {
    const a = acquireSlot('cloud', 0);
    const b = acquireSlot('cloud', 0);
    t.true(await a.admitted);
    t.true(await b.admitted);
    t.false(a.queued);
    t.false(b.queued);
    t.deepEqual(gateSnapshot('cloud'), { active: 0, queued: 0 });
});

test.serial('limit 1 serializuje: drugi czeka aż pierwszy odda slot', async t => {
    const a = acquireSlot('lm_studio', 1);
    const b = acquireSlot('lm_studio', 1);
    t.true(await a.admitted);
    t.false(a.queued);
    t.true(b.queued);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 1, queued: 1 });

    let bAdmitted = false;
    void b.admitted.then(ok => { bAdmitted = ok; });
    await new Promise(res => setTimeout(res, 10));
    t.false(bAdmitted); // b nadal wisi — a nie oddał slotu

    a.release();
    t.true(await b.admitted);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 1, queued: 0 });
    b.release();
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('cancel biletu w kolejce: admitted=false, następny w kolejce wjeżdża', async t => {
    const a = acquireSlot('lm_studio', 1);
    const b = acquireSlot('lm_studio', 1);
    const c = acquireSlot('lm_studio', 1);
    t.true(await a.admitted);

    b.cancel(); // b rezygnuje (timeout/stop) zanim dostał slot
    t.false(await b.admitted);

    a.release();
    t.true(await c.admitted); // c wjeżdża Z POMINIĘCIEM anulowanego b
    c.release();
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('cancel biletu, który TRZYMA slot, jest no-opem (slot zwalnia release)', async t => {
    const a = acquireSlot('lm_studio', 1);
    t.true(await a.admitted);
    a.cancel(); // biegnącego nie dotykamy
    t.deepEqual(gateSnapshot('lm_studio'), { active: 1, queued: 0 });
    a.release();
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('podwójny release nie psuje licznika', async t => {
    const a = acquireSlot('lm_studio', 1);
    t.true(await a.admitted);
    a.release();
    a.release();
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('osobne klucze = osobne bramki', async t => {
    const a = acquireSlot('lm_studio', 1);
    const b = acquireSlot('ollama', 1);
    t.true(await a.admitted);
    t.true(await b.admitted); // ollama nie czeka na lm_studio
    a.release();
    b.release();
});

// ─── F2 „delegacja w tle": priorytet main > sub w kolejce bramki ─────────────

test.serial('priorytet: main (1) wjeżdża PRZED czekającymi subami (0) przy limicie 1', async t => {
    const bieg = acquireSlot('lm_studio', 1, { priority: 0 });
    t.true(await bieg.admitted);

    const sub1 = acquireSlot('lm_studio', 1, { priority: 0 });
    const sub2 = acquireSlot('lm_studio', 1, { priority: 0 });
    const main = acquireSlot('lm_studio', 1, { priority: 1 });
    t.true(sub1.queued && sub2.queued && main.queued);

    const kolejnosc: string[] = [];
    void sub1.admitted.then(() => kolejnosc.push('sub1'));
    void sub2.admitted.then(() => kolejnosc.push('sub2'));
    void main.admitted.then(() => kolejnosc.push('main'));

    bieg.release();
    t.true(await main.admitted, 'główny czat nie stoi za subami');
    main.release();
    t.true(await sub1.admitted);
    sub1.release();
    t.true(await sub2.admitted);
    sub2.release();

    await new Promise(res => setTimeout(res, 0));
    t.deepEqual(kolejnosc, ['main', 'sub1', 'sub2'], 'main pierwszy, potem suby w kolejności zgłoszeń');
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('priorytet: brak opcji = 0 (domyślka bramki), więc jawny main go wyprzedza', async t => {
    const bieg = acquireSlot('ollama', 1);
    t.true(await bieg.admitted);

    const bezPriorytetu = acquireSlot('ollama', 1);
    const main = acquireSlot('ollama', 1, { priority: 1 });

    bieg.release();
    t.true(await main.admitted);
    main.release();
    t.true(await bezPriorytetu.admitted);
    bezPriorytetu.release();
    t.deepEqual(gateSnapshot('ollama'), { active: 0, queued: 0 });
});

test.serial('priorytet: FIFO w ramach jednej klasy zostaje nienaruszone', async t => {
    const bieg = acquireSlot('lm_studio', 1, { priority: 1 });
    t.true(await bieg.admitted);

    const a = acquireSlot('lm_studio', 1, { priority: 1 });
    const b = acquireSlot('lm_studio', 1, { priority: 1 });
    const c = acquireSlot('lm_studio', 1, { priority: 1 });

    bieg.release();
    t.true(await a.admitted);
    a.release();
    t.true(await b.admitted);
    b.release();
    t.true(await c.admitted);
    c.release();
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('priorytet: cancel biletu z kolejki nie psuje wpuszczania po priorytecie', async t => {
    const bieg = acquireSlot('lm_studio', 1, { priority: 0 });
    t.true(await bieg.admitted);

    const sub = acquireSlot('lm_studio', 1, { priority: 0 });
    const main = acquireSlot('lm_studio', 1, { priority: 1 });
    main.cancel(); // np. Stop usera / timeout tury zanim doszedł do slotu

    t.false(await main.admitted);
    bieg.release();
    t.true(await sub.admitted, 'anulowany main jest pomijany, sub wjeżdża normalnie');
    sub.release();
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('limit 2: trzeci czeka, zwolnienie dowolnego wpuszcza', async t => {
    const a = acquireSlot('lm_studio', 2);
    const b = acquireSlot('lm_studio', 2);
    const c = acquireSlot('lm_studio', 2);
    t.true(await a.admitted);
    t.true(await b.admitted);
    t.true(c.queued);
    b.release();
    t.true(await c.admitted);
    a.release();
    c.release();
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});
