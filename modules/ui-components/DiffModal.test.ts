/**
 * Checkbox „Nie pytaj więcej w tej sesji" w `DiffModal` (krok 6b, `MCPClient.ts`).
 *
 * Renderowany TYLKO gdy wołacz poda `rememberAvailable:true`; stan w chwili kliknięcia
 * Zatwierdź trafia do `modal.rememberForSession`, Odrzuć zawsze daje `false`.
 * `Modal.open()` w atrapie `obsidian` (repo harnessu) jest no-opem — testy wołają `onOpen()`
 * wprost, tak jak realny Obsidian robi to za kulisami `open()`.
 */
import test from 'ava';
import { DiffModal } from './DiffModal.js';

type MockNode = {
    type?: string;
    tagName?: string;
    className?: string;
    checked?: boolean;
    onclick?: (() => void) | null;
    children: MockNode[];
};

function makeModal(rememberAvailable?: boolean) {
    const app = {} as unknown as ConstructorParameters<typeof DiffModal>[0];
    const modal = new DiffModal(app, {
        path: 'Notatki/a.md',
        oldContent: 'stara treść',
        newContent: 'nowa treść',
        agentName: 'Jaskier',
        rememberAvailable,
    });
    modal.onOpen();
    return modal;
}

/** Przeszukuje drzewo atrapy DOM (harness `dom-shim.ts`, `children` = prawdziwa tablica). */
function findAll(root: unknown, predicate: (n: MockNode) => boolean): MockNode[] {
    const found: MockNode[] = [];
    const stack: MockNode[] = [root as MockNode];
    while (stack.length) {
        const node = stack.pop()!;
        if (!node) continue;
        if (predicate(node)) found.push(node);
        for (const child of node.children || []) stack.push(child);
    }
    return found;
}

function findCheckbox(modal: DiffModal): MockNode | undefined {
    return findAll(modal.contentEl, n => n.type === 'checkbox')[0];
}

/**
 * Guziki w `DiffModal` (i `ApprovalModal`) dostają swój napis przez `setSvgLabel` →
 * `el.appendText(...)` (rozszerzenie DOM Obsidiana). Atrapa `dom-shim.ts` (repo harnessu) go
 * NIE implementuje — nieznana metoda jest łańcuchowalnym no-opem, więc `textContent` guzika
 * zostaje pusty niezależnie od napisu. Odróżniamy guziki po klasie CSS (`mod-cta` = Zatwierdź,
 * `mod-warning` = Odrzuć), tak jak realny wygląd modala i tak je stylizuje.
 */
function findButtonByClass(modal: DiffModal, cls: string): MockNode | undefined {
    return findAll(modal.contentEl, n => n.tagName === 'BUTTON' && !!n.className?.includes(cls))[0];
}

test('rememberAvailable:false — checkbox NIE jest renderowany', t => {
    const modal = makeModal(false);
    t.falsy(findCheckbox(modal));
});

test('rememberAvailable niepodane — checkbox NIE jest renderowany (domyślnie niedostępny)', t => {
    const modal = makeModal(undefined);
    t.falsy(findCheckbox(modal));
});

test('rememberAvailable:true — checkbox JEST renderowany', t => {
    const modal = makeModal(true);
    t.truthy(findCheckbox(modal));
});

test('zaznaczenie checkboxa + Zatwierdź → rememberForSession true', t => {
    const modal = makeModal(true);
    const checkbox = findCheckbox(modal);
    t.truthy(checkbox);
    checkbox!.checked = true;

    const approveBtn = findButtonByClass(modal, 'mod-cta');
    t.truthy(approveBtn, 'guzik Zatwierdź (mod-cta) musi istnieć w drzewie');
    approveBtn!.onclick!();

    t.is(modal.rememberForSession, true);
    t.is(modal.result, 'approve');
});

test('checkbox NIEzaznaczony + Zatwierdź → rememberForSession false', t => {
    const modal = makeModal(true);
    const approveBtn = findButtonByClass(modal, 'mod-cta');
    approveBtn!.onclick!();

    t.is(modal.rememberForSession, false);
    t.is(modal.result, 'approve');
});

test('zaznaczony checkbox + Odrzuć → rememberForSession ZAWSZE false', t => {
    const modal = makeModal(true);
    const checkbox = findCheckbox(modal);
    checkbox!.checked = true;

    const denyBtn = findButtonByClass(modal, 'mod-warning');
    t.truthy(denyBtn, 'guzik Odrzuć (mod-warning) musi istnieć w drzewie');
    denyBtn!.onclick!();

    t.is(modal.rememberForSession, false);
    t.is(modal.result, 'deny');
});
