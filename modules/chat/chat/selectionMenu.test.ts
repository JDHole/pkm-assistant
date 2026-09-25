/**
 * `quoteText`/`insertAtCursor` - funkcje czyste za menu na zaznaczeniu (spec D, "Czat bez ścian").
 *
 * `installSelectionMenu` działa w teście przez lokalną atrapę zdarzeń i zaznaczenia, bo DOM shim
 * harnessu nie udostępnia `window.getSelection` ani nie emuluje zdarzeń.
 */
import test from 'ava';
import 'obsidian';
import { quoteText, insertAtCursor, installSelectionMenu } from './selectionMenu.js';
import { t as translate } from '../../../core/i18n/index.js';
import type { CursorTextArea } from './selectionMenu.js';

type Listener = (...args: TestDynamic[]) => void;
type TestDynamic = any;

class TestElement {
    children: TestElement[] = [];
    parentElement: TestElement | null = null;
    style: TestDynamic = {};
    scrollLeft = 0;
    scrollTop = 0;
    textContent = '';
    listeners = new Map<string, Listener>();
    className = '';

    constructor(public tagName = 'div') {}
    matches(selector: string): boolean { return selector.includes('.cs-message__text') && this.className === 'cs-message__text'; }
    appendChild(child: TestElement): TestElement { child.parentElement = this; this.children.push(child); return child; }
    remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    contains(target: TestDynamic): boolean { return target === this || this.children.some(child => child.contains(target)); }
    addEventListener(name: string, listener: Listener): void { this.listeners.set(name, listener); }
    removeEventListener(name: string): void { this.listeners.delete(name); }
    getBoundingClientRect(): TestDynamic { return { left: 0, top: 0 }; }
}

function prepareCopy(writeText: () => Promise<void>) {
    const previousHtmlElement = globalThis.HTMLElement;
    const previousCreateDiv = globalThis.createDiv;
    const previousCreateEl = globalThis.createEl;
    const previousSelection = Object.getOwnPropertyDescriptor(window, 'getSelection');
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const container = new TestElement();
    const selectable = new TestElement();
    selectable.className = 'cs-message__text';
    container.appendChild(selectable);
    let menu: TestElement | null = null;
    let cleanupObserved = false;
    const selection = {
        isCollapsed: false,
        rangeCount: 1,
        toString: () => 'selected text',
        getRangeAt: () => ({ commonAncestorContainer: selectable, getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
        removeAllRanges: () => { cleanupObserved = true; },
    };
    (globalThis as TestDynamic).HTMLElement = TestElement;
    (globalThis as TestDynamic).createDiv = () => { menu = new TestElement(); return menu; };
    (globalThis as TestDynamic).createEl = (tag: string) => new TestElement(tag);
    Object.defineProperty(window, 'getSelection', { configurable: true, value: () => selection });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const notices: Array<[string, TestDynamic]> = [];
    const view: TestDynamic = {
        messages_container: container,
        plugin: { showCrystalNotice: (message: string, options: TestDynamic) => notices.push([message, options]) },
        input_area: { value: '', selectionStart: 0 },
    };
    const detach = installSelectionMenu(view);
    container.listeners.get('mouseup')?.();
    return new Promise<{
        notices: Array<[string, TestDynamic]>;
        clickCopy: () => void;
        cleanupWasObserved: () => boolean;
        menuIsAttached: () => boolean;
        restore: () => void;
    }>(resolve => window.setTimeout(() => {
        const copyButton = (menu as TestElement).children[0];
        resolve({
            notices,
            clickCopy: () => copyButton.listeners.get('click')?.(),
            cleanupWasObserved: () => cleanupObserved,
            menuIsAttached: () => !!menu && container.children.includes(menu),
            restore: () => {
                detach();
                if (previousHtmlElement === undefined) delete (globalThis as TestDynamic).HTMLElement;
                else (globalThis as TestDynamic).HTMLElement = previousHtmlElement;
                if (previousCreateDiv === undefined) delete (globalThis as TestDynamic).createDiv;
                else (globalThis as TestDynamic).createDiv = previousCreateDiv;
                if (previousCreateEl === undefined) delete (globalThis as TestDynamic).createEl;
                else (globalThis as TestDynamic).createEl = previousCreateEl;
                if (previousSelection) Object.defineProperty(window, 'getSelection', previousSelection);
                else delete (window as TestDynamic).getSelection;
                if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
                else delete (navigator as TestDynamic).clipboard;
            },
        });
    }, 0));
}

test.serial('Kopiuj sygnalizuje odmowę schowka i sprząta natychmiast', async t => {
    let rejectWrite!: (reason: Error) => void;
    const state = await prepareCopy(() => new Promise<void>((_resolve, reject) => { rejectWrite = reject; }));
    try {
        state.clickCopy();
        const cleanupBeforeSettlement = state.cleanupWasObserved();
        t.true(cleanupBeforeSettlement, 'menu i zaznaczenie są sprzątane przed rozstrzygnięciem schowka');
        t.false(state.menuIsAttached(), 'menu jest odłączone przed rozstrzygnięciem schowka');
        rejectWrite(new Error('permission denied'));
        await new Promise(resolve => window.setTimeout(resolve, 0));
        t.deepEqual(state.notices, [[translate('chat.selection.copy_failed'), { type: 'error', timeout: 4000 }]]);
        t.true(state.cleanupWasObserved());
    } finally {
        state.restore();
    }
});

test.serial('Kopiuj pokazuje komunikat sukcesu po przyjęciu tekstu przez schowek', async assert => {
    const state = await prepareCopy(() => Promise.resolve());
    try {
        state.clickCopy();
        await new Promise(resolve => window.setTimeout(resolve, 0));
        assert.deepEqual(state.notices, [[translate('chat.selection.copied'), { type: 'success', timeout: 2000 }]]);
    } finally {
        state.restore();
    }
});

// ── quoteText ──

test('quoteText: dwie linie dostają prefiks "> " i jedną pustą linię na końcu', t => {
    t.is(quoteText('a\nb'), '> a\n> b\n\n');
});

test('quoteText: pojedyncza linia', t => {
    t.is(quoteText('hello world'), '> hello world\n\n');
});

test('quoteText: pusta linia w środku zaznaczenia zostaje samym prefiksem', t => {
    t.is(quoteText('a\n\nb'), '> a\n> \n> b\n\n');
});

// ── insertAtCursor ──

test('insertAtCursor: wstawia w środku i przesuwa kursor na koniec wstawki (atrapa bez selectionEnd/setSelectionRange)', t => {
    const textarea: CursorTextArea = { value: 'abcdef', selectionStart: 3 };
    insertAtCursor(textarea, 'XYZ');
    t.is(textarea.value, 'abcXYZdef');
    t.is(textarea.selectionStart, 6);
    t.is(textarea.selectionEnd, 6);
});

test('insertAtCursor: kursor na końcu wartości dopisuje na końcu', t => {
    const textarea: CursorTextArea = { value: 'abc', selectionStart: 3 };
    insertAtCursor(textarea, '> quoted\n\n');
    t.is(textarea.value, 'abc> quoted\n\n');
    t.is(textarea.selectionStart, 13);
});

test('insertAtCursor: selectionStart null (pole nigdy nie miało fokusu) wstawia na końcu wartości', t => {
    const textarea: CursorTextArea = { value: 'abc', selectionStart: null };
    insertAtCursor(textarea, 'X');
    t.is(textarea.value, 'abcX');
    t.is(textarea.selectionStart, 4);
});

test('insertAtCursor: niepuste selectionEnd zastępuje zaznaczony fragment pola, nie tylko wstawia', t => {
    const textarea: CursorTextArea = { value: 'abcdef', selectionStart: 1, selectionEnd: 4 };
    insertAtCursor(textarea, 'Z');
    t.is(textarea.value, 'aZef');
    t.is(textarea.selectionStart, 2);
    t.is(textarea.selectionEnd, 2);
});

test('insertAtCursor: woła setSelectionRange na atrapie, gdy jest dostępne', t => {
    const calls: Array<[number, number]> = [];
    const textarea: CursorTextArea = {
        value: 'ab',
        selectionStart: 2,
        setSelectionRange: (start, end) => { calls.push([start, end]); },
    };
    insertAtCursor(textarea, 'c');
    t.deepEqual(calls, [[3, 3]]);
});
