/**
 * Checkbox „Nie pytaj więcej w tej sesji" w `DiffModal` (krok 6b, `MCPClient.ts`).
 *
 * Renderowany TYLKO gdy wołacz poda `rememberAvailable:true`; stan w chwili kliknięcia
 * Zatwierdź trafia do `modal.rememberForSession`, Odrzuć zawsze daje `false`.
 * `Modal.open()` w atrapie `obsidian` (repo harnessu) jest no-opem — testy wołają `onOpen()`
 * wprost, tak jak realny Obsidian robi to za kulisami `open()`.
 */
import test from 'ava';
import { resolveObjectURL } from 'node:buffer';
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

// P4: new preview variants retain the legacy promise and session-consent contract.
function draftModal(preview: NonNullable<ConstructorParameters<typeof DiffModal>[1]['preview']>, path = 'note.md') {
    const modal = new DiffModal({} as ConstructorParameters<typeof DiffModal>[0], {
        path, oldContent: 'legacy old', newContent: 'legacy new', agentName: 'Lead', rememberAvailable: true, preview,
    });
    modal.onOpen(); return modal;
}
function texts(modal: DiffModal, cls: string): string[] {
    return findAll(modal.contentEl, node => !!node.className?.split(' ').includes(cls))
        .map(node => (node as MockNode & { textContent: string }).textContent).reverse();
}

test('P4 deletion preview shows removed text and never offers session consent', t => {
    const modal = draftModal({ kind: 'deleted', oldContent: 'Delete me', newContent: '' });
    t.deepEqual(texts(modal, 'diff-operation'), ['Delete file']);
    t.deepEqual(texts(modal, 'diff-text'), ['Delete me', '']);
    t.is(findCheckbox(modal), undefined);
    findButtonByClass(modal, 'mod-cta')!.onclick!();
    t.deepEqual([modal.result, modal.rememberForSession], ['approve', false]);
});

test('P4 binary preview shows operation and sizes without base64 diff', t => {
    const modal = draftModal({ kind: 'binary', operation: 'replace', oldBytes: 3, newBytes: 4 }, 'data.bin');
    t.deepEqual(texts(modal, 'diff-operation'), ['Replace binary file']);
    t.deepEqual(texts(modal, 'diff-binary-size'), ['Size before: 3 B; after: 4 B']);
    t.deepEqual(texts(modal, 'diff-text'), []);
    findButtonByClass(modal, 'mod-cta')!.onclick!();
    t.deepEqual([modal.result, modal.rememberForSession], ['approve', false]);
});

test('P4 folder preview describes folder creation and retains deny result', t => {
    const modal = draftModal({ kind: 'folder' }, 'Notes');
    t.deepEqual(texts(modal, 'diff-operation'), ['Create folder']);
    findButtonByClass(modal, 'mod-warning')!.onclick!();
    t.deepEqual([modal.result, modal.rememberForSession], ['deny', false]);
});

test('P4 text preview renders approved content with unchanged session checkbox behavior', t => {
    const modal = draftModal({ kind: 'text', oldContent: 'Base', newContent: 'Proposal' });
    t.deepEqual(texts(modal, 'diff-text'), ['Base', 'Proposal']);
    findCheckbox(modal)!.checked = true;
    findButtonByClass(modal, 'mod-cta')!.onclick!();
    t.deepEqual([modal.result, modal.rememberForSession], ['approve', true]);
});

test('P4 aborted preview resolves the existing promise as deny', async t => {
    const controller = new AbortController();
    const modal = new DiffModal({} as ConstructorParameters<typeof DiffModal>[0], {
        path: 'note.md', oldContent: 'Base', newContent: 'Proposal', agentName: 'Lead', signal: controller.signal,
    });
    const result = modal.waitForApproval(); controller.abort();
    t.is(await result, 'deny'); t.is(modal.rememberForSession, false);
});


test.serial('P4 image preview uses the proposed bytes and releases its temporary URL', async t => {
    const original = URL.createObjectURL;
    let imageUrl = '';
    URL.createObjectURL = blob => { imageUrl = original(blob); return imageUrl; };
    try {
        const modal = draftModal({ kind: 'binary', operation: 'create', oldBytes: 0, newBytes: 4,
            image: new Uint8Array([137, 80, 78, 71]) }, 'image.png');
        const blob = resolveObjectURL(imageUrl)!;
        t.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [137, 80, 78, 71]);
        t.is(blob.type, 'image/png');
        t.deepEqual(findAll(modal.contentEl, n => n.tagName === 'IMG').map(n => n.className), ['diff-image']);
        modal.onClose();
        t.is(resolveObjectURL(imageUrl), undefined);
    } finally { URL.createObjectURL = original; }
});
