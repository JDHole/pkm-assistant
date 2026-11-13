import test from 'ava';
import type { App } from 'obsidian';
import { DiagnosticsConsentModal } from './ui.js';
import { setLocale } from '../../core/i18n/index.js';

type Node = { tagName: string; textContent: string; children: Node[]; onclick?: () => void };
function buttons(modal: DiagnosticsConsentModal): Node[] {
    const found: Node[] = [];
    function visit(node: Node) { if (node.tagName === 'BUTTON') found.push(node); for (const child of node.children) visit(child); }
    visit(modal.contentEl as unknown as Node); return found;
}
function open() {
    setLocale('en');
    const controller = new AbortController();
    const modal = new DiagnosticsConsentModal({} as App, controller.signal);
    modal.onOpen();
    return { modal, controller };
}

test('consent offers two explicit choices; refusal resolves false', async t => {
    const { modal } = open();
    const choices = buttons(modal);
    t.deepEqual(choices.map(b => b.textContent), ['Save without connection test', 'Test connection and save']);
    choices[0].onclick!();
    t.is(await modal.decision, false); modal.onClose();
});
test('only accepting the connection choice resolves true', async t => {
    const { modal } = open();
    buttons(modal)[1].onclick!();
    t.is(await modal.decision, true); modal.onClose();
});
test('closing the dialog denies consent', async t => {
    const { modal } = open(); modal.onClose();
    t.is(await modal.decision, false);
});
test('unload abort denies consent even if a stale accept handler runs later', async t => {
    const { modal, controller } = open(); const accept = buttons(modal)[1].onclick!;
    controller.abort(); accept();
    t.is(await modal.decision, false); modal.onClose();
});
