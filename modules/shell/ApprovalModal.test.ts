/**
 * Checkbox „Nie pytaj więcej w tej sesji" w `ApprovalModal` (krok 6, `MCPClient.ts`).
 *
 * Renderowany TYLKO dla akcji `vault.write` I TYLKO gdy wołacz poda `rememberAvailable:true`.
 * `rememberForSession` w wyniku jest `true` WYŁĄCZNIE po literalnym kliknięciu Zatwierdź z
 * zaznaczonym checkboxem — nigdy po Odrzuć ani po „Zawsze zezwalaj" (ta ścieżka ma już własną,
 * trwałą pamięć w `ApprovalManager.alwaysApproved`).
 *
 * `Modal.open()` w atrapie `obsidian` (repo harnessu) jest no-opem — testy wołają `onOpen()`
 * wprost i biorą wynik z `waitForResponse()` (jedyne publiczne API klasy, `result`/`resolvePromise`
 * są `private`).
 */
import test from 'ava';
import type { App } from 'obsidian';
import { ApprovalModal } from './ApprovalModal.js';
import type { ApprovalAction } from '../../core/index.js';

type MockNode = {
    type?: string;
    tagName?: string;
    className?: string;
    checked?: boolean;
    onclick?: (() => void) | null;
    children: MockNode[];
};

function baseAction(overrides: Partial<ApprovalAction> = {}): ApprovalAction {
    return {
        type: 'vault.write',
        targetPath: 'Notatki/a.md',
        agentName: 'Jaskier',
        operationMode: 'create',
        ...overrides,
    };
}

function openModal(action: ApprovalAction) {
    const modal = new ApprovalModal({} as unknown as App, action);
    const resultPromise = modal.waitForResponse();
    modal.onOpen();
    return { modal, resultPromise };
}

/**
 * Przeszukuje drzewo atrapy DOM (harness `dom-shim.ts`, `children` = prawdziwa tablica) w
 * KOLEJNOŚCI DOKUMENTU (pre-order) — istotne, bo „Zawsze zezwalaj" i „Przekieruj" dzielą tę
 * samą klasę CSS (`mod-muted`) i test bierze PIERWSZE dopasowanie.
 */
function findAll(root: unknown, predicate: (n: MockNode) => boolean): MockNode[] {
    const found: MockNode[] = [];
    const visit = (node: MockNode | undefined) => {
        if (!node) return;
        if (predicate(node)) found.push(node);
        for (const child of node.children || []) visit(child);
    };
    visit(root as MockNode);
    return found;
}

function findCheckbox(modal: ApprovalModal): MockNode | undefined {
    return findAll(modal.contentEl, n => n.type === 'checkbox')[0];
}

/**
 * Guziki dostają napis przez `setSvg` + `appendText` (rozszerzenie DOM Obsidiana), którego
 * atrapa `dom-shim.ts` NIE implementuje (nieznana metoda = łańcuchowalny no-op) — `textContent`
 * guzika zostaje pusty. Odróżniamy je po klasie CSS, tak jak realny wygląd i tak je stylizuje.
 */
function findButtonByClass(modal: ApprovalModal, cls: string): MockNode | undefined {
    return findAll(modal.contentEl, n => n.tagName === 'BUTTON' && !!n.className?.includes(cls))[0];
}

// ── Widoczność checkboxa ──

test('type !== vault.write — checkbox NIE jest renderowany, nawet z rememberAvailable:true', t => {
    const { modal } = openModal(baseAction({ type: 'vault.delete', rememberAvailable: true }));
    t.falsy(findCheckbox(modal));
});

test('vault.write bez rememberAvailable — checkbox NIE jest renderowany', t => {
    const { modal } = openModal(baseAction());
    t.falsy(findCheckbox(modal));
});

test('vault.write + rememberAvailable:false — checkbox NIE jest renderowany', t => {
    const { modal } = openModal(baseAction({ rememberAvailable: false }));
    t.falsy(findCheckbox(modal));
});

test('vault.write + rememberAvailable:true — checkbox JEST renderowany', t => {
    const { modal } = openModal(baseAction({ rememberAvailable: true }));
    t.truthy(findCheckbox(modal));
});

// ── Wynik ──

test('zaznaczony checkbox + Zatwierdź → rememberForSession true', async t => {
    const { modal, resultPromise } = openModal(baseAction({ rememberAvailable: true }));
    findCheckbox(modal)!.checked = true;

    const approveBtn = findButtonByClass(modal, 'mod-cta');
    t.truthy(approveBtn, 'guzik Zatwierdź (mod-cta) musi istnieć w drzewie');
    approveBtn!.onclick!();

    const result = await resultPromise;
    t.is(result.result, 'approve');
    t.is(result.rememberForSession, true);
});

test('checkbox NIEzaznaczony + Zatwierdź → rememberForSession false', async t => {
    const { modal, resultPromise } = openModal(baseAction({ rememberAvailable: true }));

    const approveBtn = findButtonByClass(modal, 'mod-cta');
    approveBtn!.onclick!();

    const result = await resultPromise;
    t.is(result.result, 'approve');
    t.is(result.rememberForSession, false);
});

test('zaznaczony checkbox + Odrzuć → rememberForSession NIE jest true', async t => {
    const { modal, resultPromise } = openModal(baseAction({ rememberAvailable: true }));
    findCheckbox(modal)!.checked = true;

    // Pierwszy klik Odrzuć tylko odsłania pole powodu; drugi potwierdza.
    const denyBtn = findButtonByClass(modal, 'mod-warning');
    t.truthy(denyBtn, 'guzik Odrzuć (mod-warning) musi istnieć w drzewie');
    denyBtn!.onclick!();
    denyBtn!.onclick!();

    const result = await resultPromise;
    t.is(result.result, 'deny');
    t.not(result.rememberForSession, true);
});

test('zaznaczony checkbox + „Zawsze zezwalaj" → rememberForSession NIE jest true (ma własną trwałą pamięć)', async t => {
    const { modal, resultPromise } = openModal(baseAction({ rememberAvailable: true }));
    findCheckbox(modal)!.checked = true;

    const alwaysBtn = findButtonByClass(modal, 'mod-muted');
    t.truthy(alwaysBtn, 'guzik „Zawsze zezwalaj" (mod-muted) musi istnieć w drzewie');
    alwaysBtn!.onclick!();

    const result = await resultPromise;
    t.is(result.result, 'always');
    t.not(result.rememberForSession, true);
});
