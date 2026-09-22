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

// ─── Typ EN (decyzja właściciela 19.09: nowy artefakt EN dostaje statusy EN w pliku) ───

const EN_PLAN_STATUSY = ['pending-approval', 'remarks', 'accepted', 'closed'];

test('typ EN w "pending-approval" → guziki approve→accepted, revise→remarks', t => {
    const btns = computeArtifactButtons('pending-approval', EN_PLAN_STATUSY);
    t.is(btns.length, 2);
    t.is(btns.find(b => b.action === 'approve')!.statusTo, 'accepted');
    t.is(btns.find(b => b.action === 'revise')!.statusTo, 'remarks');
});

test('typ EN w "closed" → brak guzików', t => {
    t.deepEqual(computeArtifactButtons('closed', EN_PLAN_STATUSY), []);
});

// ─── Typ własny usera (słownictwo spoza obu rejestrów) ───

const CUSTOM_STATUSY = ['todo', 'zaakceptowany', 'uwagi', 'done'];

test('własny typ w "todo" (rozpoznane zaakceptowany/uwagi w liście) → guziki approve/revise', t => {
    const btns = computeArtifactButtons('todo', CUSTOM_STATUSY);
    t.is(btns.length, 2);
    t.is(btns.find(b => b.action === 'approve')!.statusTo, 'zaakceptowany');
    t.is(btns.find(b => b.action === 'revise')!.statusTo, 'uwagi');
});

test('własny typ w "done" (rola closed = ostatni w liście, brak roli rozpoznanej) → brak guzików', t => {
    t.deepEqual(computeArtifactButtons('done', CUSTOM_STATUSY), []);
});

// ─── Typ raport wbudowany (bez approval flow - brak roli accepted w typie) ───

test('raport w "w-trakcie" → brak approve/revise (brak accepted/remarks w typie), tylko przywołanie', t => {
    const btns = computeArtifactButtons('w-trakcie', ['w-trakcie', 'gotowy', 'zamkniety']);
    t.is(btns.length, 1);
    t.is(btns[0].action, 'summon');
});

// ─── BLOKER (recenzja niezależna): ensureBuiltinTypes podmienia NIETKNIĘTY plik typu na język UI
// przy KAŻDYM starcie - instancja stworzona w JEDNYM języku (status na dysku) i typ, który w
// międzyczasie zaczął deklarować statusy w DRUGIM języku, muszą nadal dać approve/revise, w
// JĘZYKU INSTANCJI (nie typu) - inaczej przełączenie UI pl->en osiera wszystkie istniejące
// instancje PL na sam guzik "Przywołaj".

test('instancja PL "do-akceptacji" pod TYPEM EN (statusy re-seedowane) → approve→zaakceptowany, revise→uwagi', t => {
    const btns = computeArtifactButtons('do-akceptacji', EN_PLAN_STATUSY);
    t.is(btns.length, 2);
    t.is(btns.find(b => b.action === 'approve')!.statusTo, 'zaakceptowany');
    t.is(btns.find(b => b.action === 'revise')!.statusTo, 'uwagi');
});

test('instancja EN "pending-approval" pod TYPEM PL (statusy re-seedowane) → approve→accepted, revise→remarks', t => {
    const btns = computeArtifactButtons('pending-approval', PLAN_STATUSY);
    t.is(btns.length, 2);
    t.is(btns.find(b => b.action === 'approve')!.statusTo, 'accepted');
    t.is(btns.find(b => b.action === 'revise')!.statusTo, 'remarks');
});

// ─── DROBNE: isClosedStatus musi domykać po OSTATNIM elemencie NIEZALEŻNIE od tego, czy rola
// `closed` jest rozpoznana WCZEŚNIEJ w liście (closedStatusOf zwraca tylko JEDEN literał).

test('isClosedStatus: typ ["open","zamkniety","archived"] - "archived" (ostatni) też domyka, mimo że "zamkniety" (środek) ma rozpoznaną rolę', t => {
    const statusy = ['open', 'zamkniety', 'archived'];
    t.true(isClosedStatus('archived', statusy), 'ostatni element domyka jak na main sprzed rejestru');
    t.true(isClosedStatus('zamkniety', statusy), 'rola rozpoznana w środku listy domyka jak dotąd');
    t.false(isClosedStatus('open', statusy));
});
