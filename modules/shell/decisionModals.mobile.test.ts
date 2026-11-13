import test from 'ava';
import { Platform } from 'obsidian';
import type { App } from 'obsidian';
import { ApprovalModal } from './ApprovalModal.js';
import { DiffModal } from '../ui-components/DiffModal.js';

type RenderedNode = {
    tagName: string;
    className: string;
    type?: string;
    value: string;
    checked: boolean;
    onclick: () => void;
    children: RenderedNode[];
};

// The AVA host exposes children as an array; walk in native document/Tab order.
function descendants(root: unknown): RenderedNode[] {
    const node = root as RenderedNode;
    return [node, ...(node.children ?? []).flatMap(descendants)];
}

for (const platform of ['phone', 'tablet', 'desktop'] as const) {
    function configure(t: import('ava').ExecutionContext) {
        const { isPhone, isMobile } = Platform;
        Platform.isPhone = platform === 'phone';
        Platform.isMobile = platform !== 'desktop';
        t.teardown(() => { Platform.isPhone = isPhone; Platform.isMobile = isMobile; });
    }

    for (const decision of ['approve', 'always', 'redirect', 'deny'] as const) {
        test.serial(`${platform}: approval buttons in reading order keep ${decision} semantics`, async t => {
            configure(t);
            const modal = new ApprovalModal({} as App, {
                type: 'vault.write', targetPath: 'Notatki/propozycja.md', agentName: 'Jaskier',
                contentPreview: 'Proponowana treść', rememberAvailable: true,
            });
            const result = modal.waitForResponse();
            modal.onOpen();
            const nodes = descendants(modal.contentEl);
            const buttons = nodes.filter(n => n.tagName === 'BUTTON');
            const order = platform === 'phone'
                ? ['approve', 'always', 'redirect', 'deny']
                : ['deny', 'approve', 'always', 'redirect'];
            t.deepEqual(buttons.map(n => n.className), platform === 'phone'
                ? ['mod-cta', 'mod-muted', 'mod-muted', 'mod-warning']
                : ['mod-warning', 'mod-cta', 'mod-muted', 'mod-muted']);
            nodes.find(n => n.type === 'checkbox')!.checked = true;
            const button = buttons[order.indexOf(decision)];
            button.onclick();
            if (decision === 'deny') {
                nodes.find(n => n.className === 'approval-deny-input')!.value = '  Zachowaj oryginał  ';
                button.onclick();
                t.deepEqual(await result, { result: 'deny', reason: 'Zachowaj oryginał' });
            } else if (decision === 'redirect') {
                nodes.find(n => n.className === 'approval-redirect-input')!.value = '  Zapisz w innym pliku  ';
                button.onclick();
                t.deepEqual(await result, { result: 'redirect', instruction: 'Zapisz w innym pliku' });
            } else {
                t.deepEqual(await result, { result: decision, reason: '', rememberForSession: true });
            }
        });
    }

    test.serial(`${platform}: parent conversation consent preserves its one-time decisions`, async t => {
        configure(t);
        const modal = new ApprovalModal({} as App, {
            type: 'delegate.share_conversation', agentName: 'Jaskier', preview: 'Rozmowa rodzica',
        });
        const result = modal.waitForResponse();
        modal.onOpen();
        const buttons = descendants(modal.contentEl).filter(n => n.tagName === 'BUTTON');
        t.deepEqual(buttons.map(n => n.className), platform === 'phone'
            ? ['mod-cta', 'mod-muted', 'mod-warning'] : ['mod-warning', 'mod-cta', 'mod-muted']);
        buttons[platform === 'phone' ? 0 : 1].onclick();
        t.deepEqual(await result, { result: 'approve', reason: '', rememberForSession: false });
    });

    for (const decision of ['approve', 'deny'] as const) {
        test.serial(`${platform}: change preview reading order keeps ${decision} and session consent`, async t => {
            configure(t);
            const modal = new DiffModal({} as App, {
                path: 'Notatki/propozycja.md', oldContent: 'Przed', newContent: 'Po',
                agentName: 'Jaskier', rememberAvailable: true,
            });
            const result = modal.waitForApproval();
            modal.onOpen();
            const nodes = descendants(modal.contentEl);
            const buttons = nodes.filter(n => n.tagName === 'BUTTON');
            t.deepEqual(buttons.map(n => n.className), platform === 'phone'
                ? ['mod-cta', 'mod-warning'] : ['mod-warning', 'mod-cta']);
            nodes.find(n => n.type === 'checkbox')!.checked = true;
            buttons.find(n => n.className === (decision === 'approve' ? 'mod-cta' : 'mod-warning'))!.onclick();
            t.is(await result, decision);
            t.is(modal.rememberForSession, decision === 'approve');
        });
    }
}
