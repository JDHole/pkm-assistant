/**
 * @module vaultReadGate
 * K23 (AUD-security-119) — bramka „czy agent TEJ TURY może CZYTAĆ ten plik", jako czysta decyzja.
 *
 * Jedna bramka dla dwóch kanałów, które wciągają pliki vaulta do promptu BEZ wołania narzędzia:
 * Oczko (osadzenia `![[…]]` z aktywnej notatki) i @-wzmianki. Stoi na TYM SAMYM
 * `checkPermission('vault.read', …)`, co narzędzie `read` — czyli No-Go, pliki chronione,
 * whitelista `focusFolders` i `admin_access`, a nie samo No-Go.
 *
 * DLACZEGO OSOBNY PLIK (AUD-testy-025): predykat mieszkał w `chat_model.ts`, który importuje
 * `obsidian` — AVA go nie zaimportuje, więc jedynym strażnikiem był regex po tekście źródła
 * (`oczkoAccessGate.test.ts`). Podmiana `return permissionSystem.checkPermission(…).allowed === true;`
 * na `permissionSystem.checkPermission(…); return true;` zostawiała dopasowywany napis na miejscu
 * i 486 testów na zielono — a bramka przepuszczała KAŻDĄ ścieżkę, więc bajty obrazu ze strefy
 * No-Go szły do dostawcy modelu. To jest granica „vault → prompt modelu", więc decyzja musi mieć
 * test zachowania, nie test napisu.
 *
 * Plik jest CELOWO wolny od `obsidian`, DOM-u i I/O (wzór `turnOwner.ts`, `queuedMessage.ts`):
 * wszystko, co zależy od pluginu — system uprawnień, tożsamość agenta, logowanie — wchodzi
 * argumentem. `chat_model.ts` tylko podaje te trzy rzeczy i oddaje predykat wołaczom.
 */

/** Werdykt systemu uprawnień. Interesuje nas wyłącznie `allowed === true`. */
// AUD-dead-code-231 (2026-09-02): `export` zdjęty na pięciu typach niżej — zero referencji spoza
// tego pliku (`evaluateVaultRead`/`createVaultReadPredicate` są jedynym publicznym wejściem).
interface PermissionVerdict {
    allowed?: boolean;
    reason?: string;
}

/**
 * Kształt systemu uprawnień, jakiego potrzebuje ta bramka.
 *
 * ⚠️ Trzymamy CAŁY obiekt, nie samą metodę — `checkPermission` jest wołane NA NIM, więc
 * odpięcie metody zabrałoby jej `this` (i przy okazji cały stan systemu uprawnień).
 */
interface PermissionSystemLike {
    checkPermission?: (agent: unknown, action: string, vaultPath: string) => PermissionVerdict;
}

interface VaultReadGateInput {
    /** `plugin.permissionSystem`; brak = fail-closed */
    permissionSystem?: PermissionSystemLike | null;
    /** agent-właściciel tury (przekazywany do `checkPermission` bez interpretacji) */
    agent?: unknown;
    /** log ostrzeżenia, gdy bramka RZUCI — wstrzykiwany, żeby plik nie ciągnął Loggera */
    onError?: (e: unknown) => void;
}

/** Dlaczego ścieżka nie przeszła. `ok` = wolno czytać. */
type VaultReadReason =
    /** brak systemu uprawnień (boot, testy, kontekst bez pluginu) — fail-closed */
    | 'no_permission_system'
    /** system uprawnień powiedział „nie" (No-Go, plik chroniony, poza whitelistą agenta) */
    | 'denied'
    /** bramka rzuciła — traktujemy jak odmowę (fail-closed) */
    | 'gate_threw'
    | 'ok';

interface VaultReadDecision {
    allowed: boolean;
    reason: VaultReadReason;
}

/**
 * Czy ten agent może przeczytać tę ścieżkę.
 *
 * Fail-closed na każdej ścieżce błędu: brak systemu uprawnień, werdykt inny niż jawne
 * `allowed === true`, wyjątek w środku bramki — wszystko znaczy „nie".
 */
export function evaluateVaultRead(input: VaultReadGateInput | null | undefined, vaultPath: string): VaultReadDecision {
    const permissionSystem = input?.permissionSystem;
    if (!permissionSystem?.checkPermission) return { allowed: false, reason: 'no_permission_system' };
    try {
        // `.allowed === true` bez `?.` — świadomie: werdykt `null`/`undefined` to zepsuty system
        // uprawnień, więc ma wpaść w `catch` (log + odmowa), a nie po cichu udawać zwykłe „nie".
        const allowed = permissionSystem.checkPermission(input?.agent, 'vault.read', vaultPath).allowed === true;
        return allowed ? { allowed: true, reason: 'ok' } : { allowed: false, reason: 'denied' };
    } catch (e) {
        input?.onError?.(e);
        return { allowed: false, reason: 'gate_threw' };
    }
}

/**
 * Predykat dla wołaczy, którzy chcą samego `boolean` — Oczko (`canReadImage`) i @-wzmianki.
 *
 * Tożsamość agenta rozwiązuje `resolveAgent`, wołane RAZ i dopiero PO sprawdzeniu, że system
 * uprawnień w ogóle stoi (kolejność jak w dawnym `_vaultReadPredicate`: bez systemu uprawnień
 * nie pytamy nikogo o nic i od razu odmawiamy).
 */
export function createVaultReadPredicate(
    input: (Omit<VaultReadGateInput, 'agent'> & { resolveAgent?: () => unknown }) | null | undefined,
): (vaultPath: string) => boolean {
    const permissionSystem = input?.permissionSystem;
    if (!permissionSystem?.checkPermission) return () => false;
    const agent = input?.resolveAgent?.();
    return (vaultPath: string) => evaluateVaultRead({ permissionSystem, agent, onError: input?.onError }, vaultPath).allowed;
}
