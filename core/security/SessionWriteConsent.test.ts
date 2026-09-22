import test from 'ava';
import { SessionWriteConsent } from './SessionWriteConsent.js';

test('grant + has: ta sama sesja i ścieżka → true', t => {
    const consent = new SessionWriteConsent();
    t.true(consent.grant('S1', 'a.md'));
    t.true(consent.has('S1', 'a.md'));
});

test('has: inna ścieżka w tej samej sesji → false', t => {
    const consent = new SessionWriteConsent();
    consent.grant('S1', 'a.md');
    t.false(consent.has('S1', 'b.md'));
});

test('has: ta sama ścieżka w innej sesji → false', t => {
    const consent = new SessionWriteConsent();
    consent.grant('S1', 'a.md');
    t.false(consent.has('S2', 'a.md'));
});

test('clearSession: kasuje zgody TYLKO wskazanej sesji, inne zostają', t => {
    const consent = new SessionWriteConsent();
    consent.grant('S1', 'a.md');
    consent.grant('S2', 'a.md');
    consent.clearSession('S1');
    t.false(consent.has('S1', 'a.md'));
    t.true(consent.has('S2', 'a.md'));
});

test('grant: pusty klucz sesji → false, no-op (has też false)', t => {
    const consent = new SessionWriteConsent();
    t.false(consent.grant('', 'a.md'));
    t.false(consent.grant(null, 'a.md'));
    t.false(consent.grant(undefined, 'a.md'));
    t.false(consent.has('', 'a.md'));
});

test('grant: pusta ścieżka → false, no-op (has też false)', t => {
    const consent = new SessionWriteConsent();
    t.false(consent.grant('S1', ''));
    t.false(consent.grant('S1', null));
    t.false(consent.has('S1', ''));
});

test('clear(): kasuje zgody wszystkich sesji', t => {
    const consent = new SessionWriteConsent();
    consent.grant('S1', 'a.md');
    consent.grant('S2', 'b.md');
    consent.clear();
    t.false(consent.has('S1', 'a.md'));
    t.false(consent.has('S2', 'b.md'));
});
