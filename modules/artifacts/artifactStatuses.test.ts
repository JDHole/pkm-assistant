import test from 'ava';
import {
    ARTIFACT_STATUS_LITERALS,
    statusRole,
    statusLiteral,
    statusLocaleOf,
    pendingStatusOf,
    closedStatusOf,
    acceptedStatusOf,
    remarksStatusOf,
} from './artifactStatuses.js';

const ROLES = ['draft', 'pending', 'remarks', 'accepted', 'closed', 'in_progress', 'ready'] as const;

// ─── statusRole / statusLiteral (oba języki) ───

test('statusRole rozpoznaje wszystkie 14 literałów (7 ról × 2 języki)', t => {
    for (const role of ROLES) {
        t.is(statusRole(ARTIFACT_STATUS_LITERALS.pl[role]), role, `PL ${ARTIFACT_STATUS_LITERALS.pl[role]}`);
        t.is(statusRole(ARTIFACT_STATUS_LITERALS.en[role]), role, `EN ${ARTIFACT_STATUS_LITERALS.en[role]}`);
    }
});

test('statusRole: nierozpoznany literał (własna nazwa usera) -> null', t => {
    t.is(statusRole('todo'), null);
    t.is(statusRole('done'), null);
    t.is(statusRole(''), null);
});

test('statusLiteral zwraca literał dla roli i języka', t => {
    t.is(statusLiteral('draft', 'pl'), 'szkic');
    t.is(statusLiteral('draft', 'en'), 'draft');
    t.is(statusLiteral('pending', 'pl'), 'do-akceptacji');
    t.is(statusLiteral('pending', 'en'), 'pending-approval');
    t.is(statusLiteral('closed', 'pl'), 'zamkniety');
    t.is(statusLiteral('closed', 'en'), 'closed');
});

test('statusLocaleOf: literał PL/EN -> jego język; nierozpoznany -> null', t => {
    t.is(statusLocaleOf('do-akceptacji'), 'pl');
    t.is(statusLocaleOf('pending-approval'), 'en');
    t.is(statusLocaleOf('todo'), null);
});

// ─── pendingStatusOf / closedStatusOf: PL, EN, i typ WŁASNY (fallback pozycyjny) ───

const PL_STATUSY = ['do-akceptacji', 'uwagi', 'zaakceptowany', 'zamkniety'];
const EN_STATUSY = ['pending-approval', 'remarks', 'accepted', 'closed'];
const CUSTOM_STATUSY = ['todo', 'zaakceptowany', 'uwagi', 'done'];

test('pendingStatusOf: typ PL -> "do-akceptacji" (rola rozpoznana)', t => {
    t.is(pendingStatusOf(PL_STATUSY), 'do-akceptacji');
});

test('pendingStatusOf: typ EN -> "pending-approval" (rola rozpoznana)', t => {
    t.is(pendingStatusOf(EN_STATUSY), 'pending-approval');
});

test('pendingStatusOf: typ własny bez roli rozpoznanej -> statusy[0] ("todo")', t => {
    t.is(pendingStatusOf(CUSTOM_STATUSY), 'todo');
});

test('pendingStatusOf: pusta lista -> undefined', t => {
    t.is(pendingStatusOf([]), undefined);
});

test('closedStatusOf: typ PL -> "zamkniety" (rola rozpoznana)', t => {
    t.is(closedStatusOf(PL_STATUSY), 'zamkniety');
});

test('closedStatusOf: typ EN -> "closed" (rola rozpoznana)', t => {
    t.is(closedStatusOf(EN_STATUSY), 'closed');
});

test('closedStatusOf: typ własny bez roli rozpoznanej -> statusy[last] ("done")', t => {
    t.is(closedStatusOf(CUSTOM_STATUSY), 'done');
});

test('closedStatusOf: pusta lista -> undefined', t => {
    t.is(closedStatusOf([]), undefined);
});

// ─── acceptedStatusOf / remarksStatusOf: BEZ fallbacku pozycyjnego ───

test('acceptedStatusOf/remarksStatusOf: rozpoznają rolę w PL, EN i typie własnym (ta sama nazwa)', t => {
    t.is(acceptedStatusOf(PL_STATUSY), 'zaakceptowany');
    t.is(remarksStatusOf(PL_STATUSY), 'uwagi');
    t.is(acceptedStatusOf(EN_STATUSY), 'accepted');
    t.is(remarksStatusOf(EN_STATUSY), 'remarks');
    t.is(acceptedStatusOf(CUSTOM_STATUSY), 'zaakceptowany', 'typ własny reużywa literału PL - rola nadal rozpoznana');
    t.is(remarksStatusOf(CUSTOM_STATUSY), 'uwagi');
});

test('acceptedStatusOf/remarksStatusOf: BRAK fallbacku - lista bez roli rozpoznanej daje null, nie zgadywanie pozycji', t => {
    t.is(acceptedStatusOf(['todo', 'in-review', 'done']), null, 'żadna z tych nazw nie ma roli accepted');
    t.is(remarksStatusOf(['todo', 'in-review', 'done']), null);
    t.is(acceptedStatusOf([]), null);
    t.is(remarksStatusOf([]), null);
});
