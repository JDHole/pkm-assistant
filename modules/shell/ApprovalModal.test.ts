/**
 * Checkbox „Nie pytaj więcej w tej sesji" w `ApprovalModal` (krok 6, `MCPClient.ts`).
 *
 * Renderowany TYLKO dla akcji `vault.write` I TYLKO gdy wołacz poda `rememberAvailable:true`.
 * `rememberForSession` w wyniku jest `true` gdy checkbox jest zaznaczony i user kliknął
 * Zatwierdź ALBO „Zawsze zezwalaj" (obie ścieżki niosą tę samą intencję: „nie pytaj więcej o
 * TEN plik w tej sesji") — nigdy po Odrzuć ani po Przekieruj. „Zawsze zezwalaj" ma NIEZALEŻNIE
 * OD TEGO własną, trwałą pamięć w `ApprovalManager.alwaysApproved` - obie pamięci działają
 * razem, nie zamiast siebie.
 *
 * `Modal.open()` w atrapie `obsidian` (repo harnessu) jest no-opem — testy wołają `onOpen()`
 * wprost i biorą wynik z `waitForResponse()` (jedyne publiczne API klasy, `result`/`resolvePromise`
 * są `private`).
 */
import test from 'ava';
import type { App } from 'obsidian';
import { ApprovalModal } from './ApprovalModal.js';
import type { ApprovalAction } from '../../core/index.js';
import { pl as tr } from '../../core/i18n/pl.js';
import { getLocale, setLocale } from '../../core/i18n/index.js';
const plTranslations: Record<string, string> = tr;

type MockNode = {
    type?: string;
    tagName?: string;
    className?: string;
    textContent?: string;
    text?: string;
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
    const previousLocale = getLocale();
    setLocale('pl');
    modal.onOpen();
    setLocale(previousLocale);
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

function findText(modal: ApprovalModal, predicate: (n: MockNode) => boolean): string | undefined {
    const node = findAll(modal.contentEl, predicate)[0];
    return node?.textContent ?? node?.text;
}

function description(modal: ApprovalModal): string | undefined {
    return findText(modal, n => n.tagName === 'P');
}

function preview(modal: ApprovalModal): string | undefined {
    return findText(modal, n => n.tagName === 'CODE');
}

function previewHeading(modal: ApprovalModal): string | undefined {
    return findText(modal, n => n.tagName === 'H4');
}

function translated(key: string, params: Record<string, string>): string {
    return Object.entries(params).reduce(
        (value, [name, replacement]) => value.split(`{{${name}}}`).join(replacement),
        plTranslations[key],
    );
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

test('zaznaczony checkbox + „Zawsze zezwalaj" → rememberForSession true (ta sama intencja co Zatwierdź)', async t => {
    const { modal, resultPromise } = openModal(baseAction({ rememberAvailable: true }));
    findCheckbox(modal)!.checked = true;

    const alwaysBtn = findButtonByClass(modal, 'mod-muted');
    t.truthy(alwaysBtn, 'guzik „Zawsze zezwalaj" (mod-muted) musi istnieć w drzewie');
    alwaysBtn!.onclick!();

    const result = await resultPromise;
    t.is(result.result, 'always');
    t.is(result.rememberForSession, true);
});

test('checkbox NIEzaznaczony + „Zawsze zezwalaj" → rememberForSession false', async t => {
    const { modal, resultPromise } = openModal(baseAction({ rememberAvailable: true }));

    const alwaysBtn = findButtonByClass(modal, 'mod-muted');
    alwaysBtn!.onclick!();

    const result = await resultPromise;
    t.is(result.result, 'always');
    t.is(result.rememberForSession, false);
});

test('delegate pokazuje aspekt, skrót zadania i pełny podgląd', t => {
    const task = 'Zbadaj notatki o projekcie i przygotuj krótkie podsumowanie.';
    const { modal } = openModal(baseAction({
        type: 'delegate', toolName: 'delegate', targetPath: '',
        delegateAspect: 'badacz', delegateTask: task,
    }));

    t.is(description(modal), 'Jaskier chce delegować zadanie do sub-agenta badacz: "Zbadaj notatki o projekcie i przygotuj krótkie podsumowanie."');
    t.is(description(modal), translated('approval.desc.delegate_aspect', {
        name: 'Jaskier', aspect: 'badacz', task,
    }));
    t.is(previewHeading(modal), 'Pełne zadanie delegacji:');
    t.is(preview(modal), task);
});

test('delegate bez aspektu pokazuje workera i skrót zadania', t => {
    const task = 'Wykonaj analizę.';
    const { modal } = openModal(baseAction({
        type: 'delegate', toolName: 'delegate', targetPath: '', delegateTask: task,
    }));

    t.is(description(modal), 'Jaskier chce delegować zadanie do workera: "Wykonaj analizę."');
    t.is(description(modal), translated('approval.desc.delegate_worker', {
        name: 'Jaskier', worker: 'workera', task,
    }));
    t.is(preview(modal), task);
});

test('sub_agent task pokazuje odbiorcę, akcję i treść zadania', t => {
    const task = 'Sprawdź trzy ostatnie wpisy.';
    const { modal } = openModal(baseAction({
        type: 'delegate', toolName: 'sub_agent', targetPath: '',
        subAgentId: 'research-2', subAgentAction: 'task', subAgentText: task,
    }));

    t.is(description(modal), 'Jaskier chce dać subowi research-2 kolejne zadanie.');
    t.is(description(modal), translated('approval.desc.sub_agent_task', {
        name: 'Jaskier', subAgentId: 'research-2',
    }));
    t.is(previewHeading(modal), 'Treść kolejnego zadania:');
    t.is(preview(modal), task);
});

test('sub_agent message pokazuje odbiorcę, akcję i treść wiadomości', t => {
    const message = 'Znalazłem trzy przydatne notatki.';
    const { modal } = openModal(baseAction({
        type: 'delegate', toolName: 'sub_agent', targetPath: '',
        subAgentId: 'research-2', subAgentAction: 'message', subAgentText: message,
    }));

    t.is(description(modal), 'Jaskier chce wysłać subowi research-2 wiadomość.');
    t.is(description(modal), translated('approval.desc.sub_agent_message', {
        name: 'Jaskier', subAgentId: 'research-2',
    }));
    t.is(previewHeading(modal), 'Treść wiadomości:');
    t.is(preview(modal), message);
});

test('sub_agent z inną akcją pokazuje jej nazwę, a brak kontekstu daje ogólny opis', t => {
    const { modal: otherAction } = openModal(baseAction({
        type: 'delegate', toolName: 'sub_agent', targetPath: '',
        subAgentId: 'research-2', subAgentAction: 'stop',
    }));
    t.is(description(otherAction), 'Jaskier chce wykonać akcję "stop" na sub-agencie.');
    t.is(description(otherAction), translated('approval.desc.sub_agent_other', {
        name: 'Jaskier', action: 'stop',
    }));
    t.is(preview(otherAction), undefined);

    const { modal: missingContext } = openModal(baseAction({
        type: 'delegate', toolName: 'sub_agent', targetPath: '',
    }));
    t.is(description(missingContext), 'Jaskier chce wykonać akcję "sub_agent" na sub-agencie.');
});

test('delegate i sub_agent przycinają podgląd do 500 znaków, a opis delegate do 80', t => {
    const task = 'a'.repeat(501);
    const { modal: delegate } = openModal(baseAction({
        type: 'delegate', toolName: 'delegate', targetPath: '',
        delegateAspect: 'worker', delegateTask: task,
    }));
    t.is(description(delegate), `Jaskier chce delegować zadanie do sub-agenta worker: "${'a'.repeat(80)}..."`);
    t.is(preview(delegate), `${'a'.repeat(500)}\n${plTranslations['approval.preview.truncated']}`);
    t.is(plTranslations['approval.preview.truncated'], '... (skrócono)');

    const { modal: subAgent } = openModal(baseAction({
        type: 'delegate', toolName: 'sub_agent', targetPath: '',
        subAgentId: 'research-2', subAgentAction: 'task', subAgentText: task,
    }));
    t.is(preview(subAgent), `${'a'.repeat(500)}\n... (skrócono)`);
});
