/**
 * turnAbort — przerwanie jako STAN TURY.
 *
 * Testy pinują trzy obietnice:
 *   1. Stop zatrzaskuje przerwanie na TEJ turze i nowa tura go NIE odkręca,
 *   2. zamknięcie widoku zbiera wszystkie tury w locie — także z zakładek w tle,
 *   3. suby zlecone z zamykanej zakładki są rozpoznawane po adresie zwrotnym, a cudze nie.
 */
import test from 'ava';
import { createTurnAbort, collectTurnsToStop, collectSubTaskIdsForOwners } from './turnAbort.js';

// ─── 1. Uchwyt tury ──────────────────────────────────────────────────────────

test('świeży uchwyt nie jest przerwany, abort() zatrzaskuje flagę i powód', (t) => {
    const a = createTurnAbort();
    t.false(a.isAborted());
    t.is(a.reason(), null);
    t.true(a.abort('stop'), 'pierwsze przerwanie zwraca true');
    t.true(a.isAborted());
    t.is(a.reason(), 'stop');
});

test('abort() jest idempotentny — powód pierwszego przerwania zostaje', (t) => {
    const a = createTurnAbort();
    a.abort('stop');
    t.false(a.abort('close'), 'drugie przerwanie zwraca false (nic nowego się nie stało)');
    t.is(a.reason(), 'stop');
});

test('nowa tura NIE gasi przerwania tury poprzedniej', (t) => {
    // Jedno pole widoku (`_abortedStream = null`, „nowa wiadomość = świeży start") nie
    // wystarczyłoby: `send_message` czyściłby je na wejściu, więc pętla zatrzymanej tury,
    // zaparkowana w długim narzędziu, po powrocie nie widziałaby już przerwania i wznawiałaby
    // iteracje. Uchwyt per tura nie daje się wyzerować z zewnątrz — nie ma takiego API —
    // a nowa tura dostaje własny, niezależny obiekt.
    const stara = createTurnAbort();
    stara.abort('stop');

    const nowa = createTurnAbort(); // user pisze kolejną wiadomość
    t.false(nowa.isAborted(), 'nowa tura startuje czysta');
    t.true(stara.isAborted(), 'stara tura ZOSTAJE przerwana mimo startu nowej');
});

// ─── 2. Zamknięcie widoku: wszystkie tury ────────────────────────────────────

test('zbieramy WSZYSTKIE tury w locie, nie tylko aktywną zakładkę', (t) => {
    const mapa = new Map([
        ['Borys', { agentName: 'Borys', abort: createTurnAbort() }],
        ['Jaskier', { agentName: 'Jaskier', abort: createTurnAbort() }],
    ]);
    t.deepEqual(collectTurnsToStop(mapa.values()), ['Borys', 'Jaskier']);
});

test('collectTurnsToStop: puste nazwy i duplikaty wypadają', (t) => {
    const wpisy = [
        { agentName: 'Borys' },
        { agentName: '  ' },
        { agentName: 'Borys' },
        { agentName: null },
        { agentName: 'Wera' },
    ];
    t.deepEqual(collectTurnsToStop(wpisy), ['Borys', 'Wera']);
});

test('collectTurnsToStop: brak wpisów = pusta lista (zamknięcie bezczynnego czatu nic nie robi)', (t) => {
    t.deepEqual(collectTurnsToStop(null), []);
    t.deepEqual(collectTurnsToStop([]), []);
});

// ─── 3. Suby zlecone z zamykanej zakładki ────────────────────────────────────

const bieg = (id: string, origin: unknown, extra: Record<string, unknown> = {}) =>
    ({ id, status: 'running', origin, ...extra } as never);

test('suby po adresie zwrotnym zakładki, cudze nietknięte', (t) => {
    const zadania = [
        bieg('sub/a#1', { agentName: 'Borys', tabKey: 'Borys::1' }),   // nasza zakładka
        bieg('sub/b#2', { agentName: 'Wera', tabKey: 'Wera::9' }),        // inny widok czatu
        bieg('sub/c#3', null),                                            // zlecenie spoza czatu
        bieg('sub/d#4', { agentName: 'Borys' }),                         // nasz agent, bez klucza zakładki
    ];
    const ids = collectSubTaskIdsForOwners(zadania, {
        tabKeys: ['Borys::1'],
        agentNames: ['Borys'],
    });
    t.deepEqual(ids, ['sub/a#1', 'sub/d#4']);
});

test('collectSubTaskIdsForOwners: zakończone i już zatrzymywane biegi pomijamy', (t) => {
    const zadania = [
        bieg('sub/done#1', { tabKey: 'T::1' }, { status: 'done' }),
        bieg('sub/stopping#2', { tabKey: 'T::1' }, { stopRequested: true }),
        bieg('sub/live#3', { tabKey: 'T::1' }),
    ];
    t.deepEqual(collectSubTaskIdsForOwners(zadania, { tabKeys: ['T::1'] }), ['sub/live#3']);
});
