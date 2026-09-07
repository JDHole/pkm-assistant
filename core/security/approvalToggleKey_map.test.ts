/**
 * AUD-testy-033 — `PermissionSystem._getApprovalToggleKey` (core/security/PermissionSystem.ts:
 * 431-464) mapuje nazwę narzędzia na klucz przełącznika approvalu w profilu agenta. Alias
 * `'add_text_to_image' → 'generate_image'` (linia 443) nie miał ŻADNEGO testu:
 * `AddTextToImageTool.test.ts` sprawdza tylko `checkPermission` (ścieżka źródłowa, K16),
 * nigdy bramkę approvalu. Zła mapa cicho gasi pytanie o zgodę — narzędzie zaczyna zapisywać
 * pliki BEZ pytania usera, a `npm test` zostaje zielony (findings.json: mutacja aliasu na
 * `'delegate'`, którego APPROVAL_DEFAULTS jest domyślnie WYŁĄCZONE, dała 2465/2465 pass).
 */
import test from 'ava';
import { PermissionSystem, APPROVAL_DEFAULTS } from './PermissionSystem.js';

// Pinowana mapa katalogu (core/security/PermissionSystem.ts:432-464, 15 wpisów).
// Uwaga (review 02.09): mapa w PermissionSystem to LOKALNA stała funkcji — ten pin wykrywa
// ZMIANĘ i USUNIĘCIE wpisu, ale nie wykryje wpisu DODANEGO (nie ma jak policzyć źródła).
const EXPECTED_TOGGLE_KEYS: Record<string, string> = {
    write: 'vault_write',
    create_folder: 'vault_create_folder',
    vault_write: 'vault_write',
    vault_create_folder: 'vault_create_folder',
    memory_save: 'memory_save',
    web_search: 'web_search',
    web_read: 'web_read',
    generate_image: 'generate_image',
    add_text_to_image: 'generate_image', // AUD-testy-033 — alias pod lupą
    delegate: 'delegate',
    kom_send: 'kom_send',
    agent_delegate: 'kom_send', // K17 — dzieli przełącznik z pocztą, NIE z 'delegate'
    artifact_create: 'artifact_create',
    artifact_update: 'artifact_update',
    todo: 'todo',
};

test('_getApprovalToggleKey: pinowana mapa katalogu (15 wpisów; zmiana/usunięcie łapane, dodanie nie)', t => {
    const ps = new PermissionSystem(null, {});
    for (const [toolName, expectedKey] of Object.entries(EXPECTED_TOGGLE_KEYS)) {
        t.is(ps._getApprovalToggleKey(toolName), expectedKey, `"${toolName}" -> "${expectedKey}"`);
    }
});

test('_getApprovalToggleKey: nieznane narzędzie i null → null (brak własnego przełącznika)', t => {
    const ps = new PermissionSystem(null, {});
    t.is(ps._getApprovalToggleKey('cos_zupelnie_nieznanego'), null);
    t.is(ps._getApprovalToggleKey(null), null);
});

test('AUD-testy-033: add_text_to_image wskazuje DOKŁADNIE "generate_image", nie inny klucz', t => {
    const ps = new PermissionSystem(null, {});
    const key = ps._getApprovalToggleKey('add_text_to_image');
    t.is(key, 'generate_image', 'alias wskazuje na INNY klucz niż generate_image');
    t.true(
        APPROVAL_DEFAULTS[key as string],
        'generate_image musi być domyślnie WŁĄCZONE (pytaj) w APPROVAL_DEFAULTS — inaczej alias na milczący klucz przechodzi niezauważony',
    );
});

test('AUD-testy-033 (integracja end-to-end): edge pyta o add_text_to_image bez toggla; toggle generate_image=false wycisza OBA narzędzia razem', t => {
    const ps = new PermissionSystem(null, {});

    // Bez żadnego toggla w profilu — domyślnie PYTA (generate_image=true w APPROVAL_DEFAULTS).
    t.true(ps.requiresApproval('image.generate', 'Attachments/x.png', 'add_text_to_image', {}, 'edge'));
    t.true(ps.requiresApproval('image.generate', 'Attachments/y.png', 'generate_image', {}, 'edge'));

    // User wyłącza toggle generate_image w profilu — MUSI wyciszyć OBA narzędzia, bo dzielą klucz.
    const agent = { approvalToggles: { generate_image: false } };
    t.false(ps.requiresApproval('image.generate', 'Attachments/x.png', 'add_text_to_image', agent, 'edge'));
    t.false(ps.requiresApproval('image.generate', 'Attachments/y.png', 'generate_image', agent, 'edge'));
});

test('AUD-testy-033: toggle delegate=false NIE wycisza add_text_to_image (dowód, że klucze są rozłączne)', t => {
    const ps = new PermissionSystem(null, {});
    const agent = { approvalToggles: { delegate: false } };
    t.true(
        ps.requiresApproval('image.generate', 'Attachments/x.png', 'add_text_to_image', agent, 'edge'),
        'add_text_to_image przestało pytać przez toggle INNEGO narzędzia — alias wskazuje złą wartość',
    );
});
