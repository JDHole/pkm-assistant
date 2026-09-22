/**
 * ConsolidationProgressModal — okablowanie z RunController (bug recenzji #4b/#7).
 *
 * `ConsolidationProgressModal.ts` importuje `Modal`/`Notice` z `obsidian` jako WARTOŚCI (nie
 * tylko typy), więc plik wymaga atrapy `obsidian` z repo harnessu (patrz
 * `test-support/register-obsidian-for-ava.mjs`) - w przeciwieństwie do `SettingsContent.ts`,
 * które importuje `obsidian` wyłącznie jako typ. Sprawdzone bezpośrednio (ten plik faktycznie
 * się importuje i instancjonuje pod atrapą - `onOpen()` przechodzi przez pełny render checklisty
 * bez rzucania).
 *
 * Czego pilnuje: `onClose()` MUSI wołać `controller.onModalClosed()` (wyciszenie konsolidacji
 * opcjonalnej - `RunController.onModalClosed`, `consolidationRunner.ts`) i `onOpen()` MUSI wołać
 * `controller.onModalOpened()` (rozbrojenie flagi "okno zamknięte", bug recenzji #7) - bez tych
 * dwóch haków cały mechanizm wyciszenia po zamknięciu okna (i jego odwrócenie po ponownym
 * otwarciu) nigdy by się nie odpalił, bo modal jest JEDYNYM miejscem, które wie, kiedy user
 * naprawdę zamknął/otworzył okno.
 */
import test from 'ava';
import { ConsolidationProgressModal } from './ConsolidationProgressModal.js';
import { ConsolidationRun } from '../memory/index.js';
import type { App } from 'obsidian';

// TS-any: testowa `App` Obsidiana nie ma zamkniętego produkcyjnego kontraktu - ten sam wzorzec
// co `consolidationRunner.test.ts` (`type Runtime = any`). Modal przelotem porównuje tożsamość
// `app` i podaje go dalej - nic z niego realnie nie czyta w tym teście.
type Runtime = any;

type ModalOptions = NonNullable<ConstructorParameters<typeof ConsolidationProgressModal>[1]>;
type ModalController = NonNullable<ModalOptions['controller']>;

function makeRun(): ConsolidationRun {
    return new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
}

test('onClose() woła controller.onModalClosed() - wyciszenie konsolidacji opcjonalnej', t => {
    const run = makeRun();
    let closedCalls = 0;
    const controller: ModalController = {
        onModalClosed: () => { closedCalls++; },
        finishIfSettled: () => false,
    };
    const app: Runtime = {};
    const modal = new ConsolidationProgressModal(app as App, { run, controller, agentName: 'Jaskier', onClosed: () => {} });

    modal.onOpen();
    t.is(closedCalls, 0, 'onOpen NIE woła onModalClosed');
    modal.onClose();

    t.is(closedCalls, 1, 'onClose musi wołać onModalClosed dokładnie raz');
});

test('onOpen() woła controller.onModalOpened() - rozbraja flagę "okno zamknięte" (bug recenzji #7)', t => {
    const run = makeRun();
    let openedCalls = 0;
    const controller: ModalController = {
        onModalOpened: () => { openedCalls++; },
        finishIfSettled: () => false,
    };
    const app: Runtime = {};
    const modal = new ConsolidationProgressModal(app as App, { run, controller, agentName: 'Jaskier', onClosed: () => {} });

    modal.onOpen();

    t.is(openedCalls, 1, 'onOpen musi wołać onModalOpened dokładnie raz');
    modal.onClose(); // sprząta `window.setInterval` uzbrojony przez onOpen() - inaczej proces wisi
});

test('brak controller.onModalClosed/onModalOpened (atrapa starsza) nie wywala onOpen/onClose - haki są opcjonalne', t => {
    const run = makeRun();
    const controller: ModalController = { finishIfSettled: () => false };
    const app: Runtime = {};
    const modal = new ConsolidationProgressModal(app as App, { run, controller, agentName: 'Jaskier', onClosed: () => {} });

    t.notThrows(() => modal.onOpen());
    t.notThrows(() => modal.onClose());
});

test('pad wewnątrz controller.onModalClosed jest best-effort - onClose nie rzuca', t => {
    const run = makeRun();
    const controller: ModalController = {
        onModalClosed: () => { throw new Error('symulacja: hak wyciszenia padł'); },
        finishIfSettled: () => false,
    };
    const app: Runtime = {};
    const modal = new ConsolidationProgressModal(app as App, { run, controller, agentName: 'Jaskier', onClosed: () => {} });

    modal.onOpen();
    t.notThrows(() => modal.onClose(), 'pad haka wyciszenia nie ma prawa zablokować zamknięcia okna');
});
