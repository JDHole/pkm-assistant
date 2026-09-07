import test from 'ava';
import { computeArtifactButtons, isClosedStatus, CLOSED_STATUS } from './artifactButtons.js';

const PLAN_STATUSY = ['do-akceptacji', 'uwagi', 'zaakceptowany', 'zamkniety'];

test('status do-akceptacji → dwa guziki: zatwierdź (→zaakceptowany) + odeślij (→uwagi)', t => {
    const btns = computeArtifactButtons('do-akceptacji', PLAN_STATUSY);
    t.is(btns.length, 2);
    const approve = btns.find(b => b.action === 'approve')!;
    const revise = btns.find(b => b.action === 'revise')!;
    t.is(approve.statusTo, 'zaakceptowany');
    t.is(revise.statusTo, 'uwagi');
    t.truthy(approve.labelKey);
    t.truthy(approve.summonKey);
});

test('status zaakceptowany → sam guzik przywołania (bez zmiany statusu)', t => {
    const btns = computeArtifactButtons('zaakceptowany', PLAN_STATUSY);
    t.is(btns.length, 1);
    t.is(btns[0].action, 'summon');
    t.is(btns[0].statusTo, null);
});

test('status uwagi → sam guzik przywołania', t => {
    const btns = computeArtifactButtons('uwagi', PLAN_STATUSY);
    t.is(btns.length, 1);
    t.is(btns[0].action, 'summon');
});

test('status zamkniety → brak guzików (artefakt domknięty)', t => {
    t.deepEqual(computeArtifactButtons('zamkniety', PLAN_STATUSY), []);
});

test('ostatni status typu (nie „zamkniety") też domyka — brak guzików', t => {
    // Typ z własnym „końcowym" statusem.
    t.deepEqual(computeArtifactButtons('gotowe', ['robocze', 'gotowe']), []);
    // 'zamkniety' domyka zawsze, niezależnie od deklaracji typu.
    t.deepEqual(computeArtifactButtons(CLOSED_STATUS, ['a', 'b']), []);
});

test('do-akceptacji ale typ NIE deklaruje zaakceptowany/uwagi → fallback przywołanie', t => {
    const btns = computeArtifactButtons('do-akceptacji', ['do-akceptacji', 'zamkniety']);
    t.is(btns.length, 1);
    t.is(btns[0].action, 'summon');
});

test('pusta lista statusów typu → nie ogranicza przejść (do-akceptacji daje 2 guziki)', t => {
    const btns = computeArtifactButtons('do-akceptacji', []);
    t.is(btns.length, 2);
});

test('dowolny status niedomknięty (np. szkic) → guzik przywołania', t => {
    const btns = computeArtifactButtons('szkic', ['szkic', 'zamkniety']);
    t.is(btns.length, 1);
    t.is(btns[0].action, 'summon');
});

test('isClosedStatus: zamkniety zawsze true, ostatni z listy true, środkowy false', t => {
    t.true(isClosedStatus('zamkniety', []));
    t.true(isClosedStatus('gotowe', ['robocze', 'gotowe']));
    t.false(isClosedStatus('robocze', ['robocze', 'gotowe']));
});
