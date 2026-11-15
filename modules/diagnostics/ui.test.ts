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
function open(locale = 'en') {
    setLocale(locale);
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
test('closing the dialog cancels the report', async t => {
    const { modal } = open(); modal.onClose();
    t.is(await modal.decision, null);
});
test('unload abort cancels the report even if a stale accept handler runs later', async t => {
    const { modal, controller } = open(); const accept = buttons(modal)[1].onclick!;
    controller.abort(); accept();
    t.is(await modal.decision, null); modal.onClose();
});

for (const locale of ['pl', 'en']) test.serial(`D6b consent renders two separate paragraphs (${locale})`, t => {
    const { modal } = open(locale);
    t.deepEqual(Array.from(modal.contentEl.children).map(node => node.tagName), ['P', 'P', 'DIV']);
    t.deepEqual(Array.from(modal.contentEl.children).slice(0, 2).map(node => node.textContent), locale === 'pl' ? [
        'Dodać test połączenia? Wyśle on jedną krótką wiadomość testową do dostawcy domyślnego modelu i może naliczyć małą opłatę. Nie wysyła notatek ani rozmów. Możesz zapisać raport lokalny bez tego testu.',
        'Raport lokalny zawiera też liczbę plików pamięci ze śladami konfliktu synchronizacji (same liczby).',
    ] : [
        'Include a connection test? This sends one short test message to your default model provider and may incur a small charge. No notes or conversations are sent. You can save the local report without this test.',
        'The local report also includes the number of memory files with synchronization conflict traces (counts only).',
    ]);
    t.deepEqual(buttons(modal).map(b => b.textContent), locale === 'pl'
        ? ['Zapisz bez testu połączenia', 'Sprawdź połączenie i zapisz']
        : ['Save without connection test', 'Test connection and save']);
    modal.onClose();
});

test('closing ignores both stale save handlers', async t => {
    const { modal } = open();
    const choices = buttons(modal);
    modal.onClose();
    choices[0].onclick!(); choices[1].onclick!();
    t.is(await modal.decision, null);
});
