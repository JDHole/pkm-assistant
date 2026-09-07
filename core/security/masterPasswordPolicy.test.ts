/**
 * AUD-testy-009 — `validateNewMasterPassword` (wyciągnięte z `MasterPasswordModal._submit`,
 * patrz nagłówek masterPasswordPolicy.ts). Obie strony: za krótkie hasło i niezgodne
 * powtórzenie, plus granica progu i tryb `confirm:false` (odblokowanie istniejącego sejfu).
 */
import test from 'ava';
import { MASTER_PASSWORD_MIN_LENGTH, validateNewMasterPassword } from './masterPasswordPolicy.js';

test('MASTER_PASSWORD_MIN_LENGTH: próg to 12 — ten sam, którego pilnuje SecretsStorage.unlock', t => {
    t.is(MASTER_PASSWORD_MIN_LENGTH, 12);
});

test('validateNewMasterPassword: za krótkie hasło → too_short (niezależnie od zgodności powtórzenia)', t => {
    t.deepEqual(validateNewMasterPassword('a'.repeat(11), 'a'.repeat(11), true), { ok: false, code: 'too_short' });
    t.deepEqual(validateNewMasterPassword('', '', true), { ok: false, code: 'too_short' });
    t.deepEqual(validateNewMasterPassword(null, null, true), { ok: false, code: 'too_short' });
    t.deepEqual(validateNewMasterPassword(undefined, undefined, true), { ok: false, code: 'too_short' });
});

test('validateNewMasterPassword: hasło wystarczająco długie, ale NIEZGODNE z powtórzeniem → mismatch', t => {
    const password = 'correct horse battery staple';
    t.deepEqual(validateNewMasterPassword(password, password + 'x', true), { ok: false, code: 'mismatch' });
    t.deepEqual(validateNewMasterPassword(password, '', true), { ok: false, code: 'mismatch' });
    t.deepEqual(validateNewMasterPassword(password, undefined, true), { ok: false, code: 'mismatch' });
});

test('validateNewMasterPassword: zgodne i wystarczająco długie → ok, code:null', t => {
    const password = 'correct horse battery staple';
    t.deepEqual(validateNewMasterPassword(password, password, true), { ok: true, code: null });
});

test('validateNewMasterPassword: granica DOKŁADNIE 12 znaków przechodzi (próg jest "<", nie "<=")', t => {
    const dokladnie12 = 'a'.repeat(12);
    t.deepEqual(validateNewMasterPassword(dokladnie12, dokladnie12, true), { ok: true, code: null });
    t.deepEqual(validateNewMasterPassword('a'.repeat(11), 'a'.repeat(11), true), { ok: false, code: 'too_short' });
});

test('validateNewMasterPassword: confirm:false IGNORUJE pole powtórzenia całkowicie (odblokowanie, nie zakładanie)', t => {
    const password = 'correct horse battery staple';
    t.deepEqual(validateNewMasterPassword(password, 'cos zupelnie innego', false), { ok: true, code: null });
    t.deepEqual(validateNewMasterPassword(password, '', false), { ok: true, code: null });
    t.deepEqual(validateNewMasterPassword(password, undefined, false), { ok: true, code: null });
});

test('validateNewMasterPassword: too_short wygrywa PRZED mismatch — ten sam porządek co oryginalny _submit', t => {
    // Krótkie i niezgodne zarazem: kod ma być too_short, nigdy mismatch.
    t.deepEqual(validateNewMasterPassword('krotkie', 'inne-krotkie-haslo', true), { ok: false, code: 'too_short' });
});
