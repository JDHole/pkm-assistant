/**
 * Reguła hasła głównego sejfu (`SecretsStorage`), wyciągnięta z `MasterPasswordModal._submit`.
 *
 * `MasterPasswordModal.ts` importuje `Modal`/`Setting` z `obsidian` jako WARTOŚCI, więc nie
 * wstaje w środowisku testów AVA (`ava.require: []` w package.json — brak mocka `obsidian`).
 * Gdyby dwie gałęzie decyzyjne (długość hasła, zgodność z powtórzeniem) mieszkały wyłącznie
 * w `_submit()`, byłyby przez to zerowo testowalne.
 *
 * Ta funkcja jest CZYSTA (zero importów, zero DOM) — modal ją tylko WOŁA i podpina wynik
 * pod `_setError`/`_finish`. Logika i UI są rozdzielone; UI zostaje niepokryte (jak
 * wszystkie widoki Obsidiana w tym repo), logika ma test na obie strony.
 *
 * `MASTER_PASSWORD_MIN_LENGTH` jest WSPÓLNA z `SecretsStorage.unlock` — próg `12` żyje
 * TYLKO TU, więc `SecretsStorage.ts` i `MasterPasswordModal.ts` nie mogą się cicho rozjechać
 * przez dwie osobne stałe.
 */

/** Próg długości hasła głównego. Współdzielony z `SecretsStorage.unlock`. */
export const MASTER_PASSWORD_MIN_LENGTH = 12;

/** Kod odmowy — `null` gdy `ok === true`. */
export type MasterPasswordValidationCode = 'too_short' | 'mismatch';

/** Werdykt walidacji formularza hasła głównego. */
export interface MasterPasswordValidation {
    ok: boolean;
    code: MasterPasswordValidationCode | null;
}

/**
 * Waliduje NOWE hasło główne wpisane w formularzu (`MasterPasswordModal`).
 *
 * Kolejność sprawdzeń jest ISTOTNA i odtwarza dokładnie oryginalny `_submit()`: za krótkie
 * hasło wygrywa PRZED sprawdzeniem zgodności z powtórzeniem — hasło jednocześnie krótkie
 * i niezgodne dostaje `'too_short'`, nie `'mismatch'`.
 *
 * @param password - hasło wpisane przez usera
 * @param confirmPassword - powtórzenie; ignorowane, gdy `confirm` jest `false`
 * @param confirm - czy formularz w ogóle pyta o powtórzenie (`MasterPasswordModal.confirm`,
 *   `false` = pytamy o hasło RAZ — odblokowanie istniejącego sejfu, nie zakładanie nowego)
 */
export function validateNewMasterPassword(
    password: string | null | undefined,
    confirmPassword: string | null | undefined = '',
    confirm: boolean = true,
): MasterPasswordValidation {
    if (!password || password.length < MASTER_PASSWORD_MIN_LENGTH) {
        return { ok: false, code: 'too_short' };
    }
    if (confirm && password !== confirmPassword) {
        return { ok: false, code: 'mismatch' };
    }
    return { ok: true, code: null };
}
