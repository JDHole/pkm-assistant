import test from 'ava';
import { EventEmitter } from '../../core/index.js';
import { SubTaskNotifier } from './SubTaskNotifier.js';
import type { SubTask } from './SubTaskRegistry.js';

/** Atrapa rejestru: tylko szyna zdarzeń — notifier niczego więcej z rejestru nie tyka. */
function makeRegistry() {
    const events = new EventEmitter();
    return {
        events,
        finish(task: SubTask) { events.emit('task:finished', task); },
    };
}

function makeTask(over: Partial<SubTask> = {}): SubTask {
    return {
        id: over.id || 'sub/pkm-sub#1',
        name: 'pkm-sub',
        agentName: 'Tester',
        status: 'done',
        createdAt: Date.now(),
        steps: [],
        budget: {},
        background: true,
        ...over,
    };
}

test('zakończony bieg w tle idzie do dostawcy OD RĘKI (kolejka zostaje pusta)', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry });
    const dostarczone: string[] = [];
    notifier.setDeliverer((task) => { dostarczone.push(task.id); return true; });

    registry.finish(makeTask({ id: 'sub/pkm-sub#a' }));

    t.deepEqual(dostarczone, ['sub/pkm-sub#a']);
    t.deepEqual(notifier.pending(), []);
});

test('bez dostawcy wynik czeka w kolejce, a drain po setDeliverer go oddaje', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry });

    registry.finish(makeTask({ id: 'sub/pkm-sub#a' }));
    registry.finish(makeTask({ id: 'sub/pkm-sub#b' }));
    t.deepEqual(notifier.pending().map(x => x.id), ['sub/pkm-sub#a', 'sub/pkm-sub#b']);

    const dostarczone: string[] = [];
    notifier.setDeliverer((task) => { dostarczone.push(task.id); return true; });
    t.deepEqual(notifier.pending().length, 2, 'samo podłączenie dostawcy NIC nie dostarcza');

    notifier.drain();
    t.deepEqual(dostarczone, ['sub/pkm-sub#a', 'sub/pkm-sub#b'], 'FIFO');
    t.deepEqual(notifier.pending(), []);
});

test('dostawca zwracający false = wynik ZOSTAJE w kolejce', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry });
    notifier.setDeliverer(() => false);

    registry.finish(makeTask({ id: 'sub/pkm-sub#a' }));

    t.deepEqual(notifier.pending().map(x => x.id), ['sub/pkm-sub#a']);
});

test('dostawca RZUCAJĄCY nie wywala notifiera, a wynik zostaje w kolejce', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry });
    notifier.setDeliverer(() => { throw new Error('czat padł'); });

    t.notThrows(() => registry.finish(makeTask({ id: 'sub/pkm-sub#a' })));
    t.deepEqual(notifier.pending().map(x => x.id), ['sub/pkm-sub#a']);

    // Po podmianie dostawcy na sprawny — drain dostarcza to samo zadanie.
    const dostarczone: string[] = [];
    notifier.setDeliverer((task) => { dostarczone.push(task.id); return true; });
    notifier.drain();
    t.deepEqual(dostarczone, ['sub/pkm-sub#a']);
});

test('biegi BEZ background są ignorowane (blokująca delegacja oddaje wynik do tury)', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry });
    const dostarczone: string[] = [];
    notifier.setDeliverer((task) => { dostarczone.push(task.id); return true; });

    registry.finish(makeTask({ id: 'sub/pkm-sub#sync', background: false }));
    registry.finish(makeTask({ id: 'sub/pkm-sub#brak', background: undefined }));

    t.deepEqual(dostarczone, []);
    t.deepEqual(notifier.pending(), []);
});

test('pendingFor filtruje po origin.agentName, a bez origin po właścicielu biegu', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry });

    registry.finish(makeTask({ id: '#1', origin: { agentName: 'Klara' } }));
    registry.finish(makeTask({ id: '#2', origin: { agentName: 'Tola' } }));
    registry.finish(makeTask({ id: '#3', agentName: 'Klara' })); // bez origin

    t.deepEqual(notifier.pendingFor('Klara').map(x => x.id), ['#1', '#3']);
    t.deepEqual(notifier.pendingFor('Tola').map(x => x.id), ['#2']);
    t.deepEqual(notifier.pendingFor('Duch'), []);
});

test('sufit kolejki: najstarsze wyniki wypadają, nowe zostają', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry, maxPending: 3 });

    for (let i = 1; i <= 5; i++) registry.finish(makeTask({ id: `#${i}` }));

    t.deepEqual(notifier.pending().map(x => x.id), ['#3', '#4', '#5']);
});

// `drain()` zdejmuje CAŁĄ kolejkę do zmiennej lokalnej, a dostawca w czacie jest
// reentrantny (`send_message` → koniec tury → `drain`) i w trakcie dostarczania może
// dojść NOWY wynik. Bez `left.concat(this._pending)` na końcu świeży wynik wyprzedziłby
// ten, który czekał od kwadransa — a to kolejność, w jakiej user widzi meldunki subów
// w rozmowie. Cicha do zepsucia: podmiana ostatniej linii `drain()` na
// `this._pending = left` przechodzi wszystkie pozostałe asercje tego pliku.
test('drain: wynik dorzucony W TRAKCIE dostarczania nie wyprzedza tego, co czekało', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry });

    registry.finish(makeTask({ id: '#stary' }));
    t.deepEqual(notifier.pending().map(x => x.id), ['#stary'], 'bez dostawcy wynik czeka');

    // Dostawca odbija każdy wynik (`false` = zostaw w kolejce), a przy pierwszej próbie
    // dorzuca nowy bieg — dokładnie jak czat, który w trakcie tury dostał wynik kolejnego suba.
    let pierwsza = true;
    notifier.setDeliverer(() => {
        if (pierwsza) {
            pierwsza = false;
            registry.finish(makeTask({ id: '#nowy' }));
        }
        return false;
    });

    notifier.drain();

    t.deepEqual(notifier.pending().map(x => x.id), ['#stary', '#nowy'], 'FIFO całości zachowane');
});

test('dispose odpina subskrypcję i czyści kolejkę', t => {
    const registry = makeRegistry();
    const notifier = new SubTaskNotifier({ registry });
    registry.finish(makeTask({ id: '#1' }));
    t.is(notifier.pending().length, 1);

    notifier.dispose();

    t.deepEqual(notifier.pending(), []);
    registry.finish(makeTask({ id: '#2' }));
    t.deepEqual(notifier.pending(), [], 'po dispose zdarzenia rejestru nas nie dotyczą');
    t.is(registry.events.listenerCount('task:finished'), 0);
});

test('brak rejestru / rejestr bez szyny nie wywala konstruktora', t => {
    t.notThrows(() => new SubTaskNotifier({ registry: null }));
    t.notThrows(() => new SubTaskNotifier({ registry: {} }));
    const notifier = new SubTaskNotifier({ registry: { events: null } });
    t.deepEqual(notifier.pending(), []);
});
