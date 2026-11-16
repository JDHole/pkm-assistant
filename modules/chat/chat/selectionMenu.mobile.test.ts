import test from 'ava';
import 'obsidian';
import { getLocale, setLocale } from '../../../core/i18n/index.js';
import { installSelectionMenu, mobileSelectionPosition } from './selectionMenu.js';

type TestDynamic = any;
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rect = (left: number, top: number, width: number, height: number): Rect =>
    ({ left, top, right: left + width, bottom: top + height, width, height });

class Events {
    listeners = new Map<string, Set<(event: TestDynamic) => void>>();
    addEventListener(name: string, callback: (event: TestDynamic) => void): void {
        const callbacks = this.listeners.get(name) ?? new Set();
        callbacks.add(callback);
        this.listeners.set(name, callbacks);
    }
    removeEventListener(name: string, callback: (event: TestDynamic) => void): void {
        this.listeners.get(name)?.delete(callback);
    }
    emit(type: string, data: TestDynamic = {}): boolean {
        let prevented = false;
        const event = { type, preventDefault: () => { prevented = true; }, ...data };
        for (const callback of this.listeners.get(type) ?? []) callback(event);
        return prevented;
    }
    count(): number { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
}

class Element extends Events {
    children: Element[] = [];
    parentElement: Element | null = null;
    className = '';
    textContent = '';
    style: Record<string, string> = {};
    scrollLeft = 0;
    scrollTop = 30;
    clientLeft = 0;
    clientTop = 0;
    clientWidth = 300;
    clientHeight = 500;
    bounds = rect(10, 50, 300, 500);
    appendChild(child: Element): Element { child.parentElement = this; this.children.push(child); return child; }
    remove(): void {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    contains(node: Element): boolean { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector: string): boolean { return selector.split(', ').includes(`.${this.className}`); }
    getBoundingClientRect(): Rect { return this.bounds; }
}

class Clock {
    now = 0;
    nextId = 0;
    tasks = new Map<number, { due: number; callback: () => void }>();
    setTimeout = (callback: () => void, delay: number): number => {
        const id = ++this.nextId;
        this.tasks.set(id, { due: this.now + delay, callback });
        return id;
    };
    clearTimeout = (id: number): void => { this.tasks.delete(id); };
    advance(ms: number): void {
        this.now += ms;
        for (const [id, task] of [...this.tasks]) {
            if (task.due <= this.now) { this.tasks.delete(id); task.callback(); }
        }
    }
}

function setup(isMobile = true, locale = 'pl') {
    const restores: Array<() => void> = [];
    function replace(object: TestDynamic, key: string, value: TestDynamic): void {
        const previous = Object.getOwnPropertyDescriptor(object, key);
        Object.defineProperty(object, key, { configurable: true, value });
        restores.push(() => { if (previous) Object.defineProperty(object, key, previous); else delete object[key]; });
    }
    const previousLocale = getLocale();
    setLocale(locale);
    const doc = new Events();
    const clock = new Clock();
    const container = new Element();
    const selectable = container.appendChild(new Element());
    selectable.className = 'cs-message__text';
    const panel = new Element();
    panel.bounds = rect(10, 550, 300, 100);
    let selectionRects = [rect(40, 100, 180, 20), rect(40, 120, 60, 20)];
    let ancestor = selectable;
    let text = 'Pierwsza linia\nDruga linia';
    let clears = 0;
    let created = 0;
    let focused = 0;
    let resized = 0;
    let reads = 0;
    const attachments: string[] = [];
    const selection = {
        isCollapsed: false,
        rangeCount: 1,
        toString: () => text,
        getRangeAt: () => ({
            commonAncestorContainer: ancestor,
            getBoundingClientRect: () => rect(40, 100, 180, 40),
            getClientRects: () => selectionRects,
        }),
        removeAllRanges: () => { clears++; selection.isCollapsed = true; },
    };
    replace(globalThis, 'HTMLElement', Element);
    replace(globalThis, 'Node', Element);
    replace(document, 'addEventListener', doc.addEventListener.bind(doc));
    replace(document, 'removeEventListener', doc.removeEventListener.bind(doc));
    replace(window, 'getSelection', () => { reads++; return selection; });
    replace(globalThis, 'createDiv', (options: { cls: string }) => {
        const element = new Element();
        element.className = options.cls;
        element.bounds = rect(0, 0, 220, 54);
        created++;
        return element;
    });
    replace(globalThis, 'createEl', (_tag: string, options: { cls: string; text: string }) => {
        const element = new Element();
        element.className = options.cls;
        element.textContent = options.text;
        return element;
    });
    const input = { value: '', selectionStart: 0, selectionEnd: 0, focus: () => { focused++; }, closest: () => panel };
    const view: TestDynamic = {
        messages_container: container, input_area: input,
        handleInputResize: () => { resized++; },
        attachmentManager: { addTextAttachment: (attachment: { text: string }) => attachments.push(attachment.text) },
    };
    const detach = installSelectionMenu(view, { isMobile, timer: clock });
    const menus = () => container.children.filter(child => child.className === 'cs-selection-menu');
    return {
        doc, clock, container, selectable, panel, input, selection, menus, attachments, detach,
        created: () => created, clears: () => clears, focused: () => focused, resized: () => resized, reads: () => reads,
        selectText: (value: string) => { text = value; },
        anchor: (value: Element) => { ancestor = value; },
        rectangles: (value: Rect[]) => { selectionRects = value; },
        show: () => { doc.emit('selectionchange'); clock.advance(250); },
        restore: () => { detach(); for (const restore of restores.reverse()) restore(); setLocale(previousLocale); },
    };
}

const area = rect(10, 50, 300, 500);
const size = { width: 220, height: 54 };

test('mobile position: below the short last line, not the first line or bounding box', t => {
    t.deepEqual(mobileSelectionPosition([rect(30, 100, 240, 20), rect(60, 120, 50, 20)], area, size),
        { left: 60, top: 168, side: 'below' });
});

test('mobile position: insufficient room below uses the first line and toolbar gap', t => {
    t.deepEqual(mobileSelectionPosition([rect(30, 460, 240, 20), rect(60, 480, 50, 20)], area, size),
        { left: 30, top: 342, side: 'above' });
});

test('mobile position: clamps both horizontal edges and keeps the whole menu visible', t => {
    t.deepEqual(mobileSelectionPosition([rect(-20, 100, 80, 20)], area, size), { left: 10, top: 148, side: 'below' });
    t.deepEqual(mobileSelectionPosition([rect(290, 100, 20, 20)], area, size), { left: 90, top: 148, side: 'below' });
});

test('mobile position: shallow area clamps fallback above; empty rectangles have no position', t => {
    t.deepEqual(mobileSelectionPosition([rect(20, 60, 40, 20)], rect(10, 50, 300, 90), size),
        { left: 20, top: 50, side: 'above' });
    t.is(mobileSelectionPosition([], area, size), null);
});

for (const [locale, labels] of [['pl', ['Cytuj', 'Dodaj jako kontekst']], ['en', ['Quote', 'Add as context']]] as const) {
    test.serial(`mobile ${locale}: debounced selection creates exactly two translated actions below`, t => {
        const s = setup(true, locale);
        try {
            s.doc.emit('selectionchange');
            s.clock.advance(200);
            s.doc.emit('selectionchange');
            s.clock.advance(249);
            t.is(s.menus().length, 0);
            s.clock.advance(1);
            t.is(s.menus().length, 1);
            t.deepEqual(s.menus()[0].children.map(child => child.textContent), [...labels]);
            t.deepEqual(s.menus()[0].style, { maxWidth: '300px', maxHeight: '500px', left: '30px', top: '148px' });
            s.container.emit('mouseup');
            s.container.emit('keyup', { shiftKey: true, key: 'ArrowRight' });
            s.clock.advance(250);
            t.is(s.created(), 1);
        } finally { s.restore(); }
    });
}

test.serial('desktop: selectionchange does nothing; mouse and keyboard preserve labels and coordinates', t => {
    const s = setup(false);
    try {
        s.show();
        t.is(s.menus().length, 0);
        s.container.emit('mouseup');
        s.clock.advance(0);
        t.deepEqual(s.menus()[0].children.map(child => child.textContent), ['Kopiuj', 'Dodaj jako kontekst', 'Cytuj']);
        t.deepEqual(s.menus()[0].style, { left: '30px', top: '44px' });
        s.container.emit('scroll');
        s.clock.advance(500);
        t.is(s.menus().length, 0);
        s.container.emit('keyup', { shiftKey: true, key: 'ArrowRight' });
        t.deepEqual(s.menus()[0].style, { left: '30px', top: '44px' });
    } finally { s.restore(); }
});

test.serial('mobile: empty, whitespace, header and another view selection remove the menu', t => {
    const s = setup();
    try {
        s.show();
        t.is(s.menus()[0].children[0].textContent, 'Cytuj');
        s.selection.isCollapsed = true;
        s.show();
        t.is(s.menus().length, 0);
        s.selection.isCollapsed = false;
        s.selectText(' \n ');
        s.show();
        t.is(s.menus().length, 0);
        s.selectText('Tekst');
        s.anchor(s.container.appendChild(new Element()));
        s.show();
        t.is(s.menus().length, 0);
        const other = new Element();
        other.className = 'cs-message__text';
        s.anchor(other);
        s.show();
        t.is(s.menus().length, 0);
        s.anchor(s.selectable);
        s.selectable.className = 'cs-tile__body';
        s.show();
        t.deepEqual(s.menus()[0].children.map(child => child.textContent), ['Cytuj', 'Dodaj jako kontekst']);
    } finally { s.restore(); }
});

for (const action of ['quote', 'context'] as const) {
    for (const press of ['pointerdown', 'mousedown', 'touchstart']) {
        test.serial(`mobile ${action}: ${press}, empty selectionchange, delay, click retains snapshot`, t => {
            const s = setup();
            try {
                s.show();
                const menu = s.menus()[0];
                const button = menu.children[action === 'quote' ? 0 : 1];
                s.doc.emit(press, { target: button });
                t.is(menu.emit(press, { target: button }), press !== 'touchstart');
                s.selection.isCollapsed = true;
                s.selectText('');
                s.doc.emit('selectionchange');
                s.clock.advance(1000);
                t.is(s.menus()[0], menu);
                button.emit('click');
                if (action === 'quote') {
                    t.is(s.input.value, '> Pierwsza linia\n> Druga linia\n\n');
                    t.is(s.input.selectionStart, 32);
                    t.is(s.focused(), 1);
                    t.is(s.resized(), 1);
                } else t.deepEqual(s.attachments, ['Pierwsza linia\nDruga linia']);
                t.is(s.clears(), 1);
                t.is(s.menus().length, 0);
                s.clock.advance(1000);
                t.is(s.menus().length, 0);
            } finally { s.restore(); }
        });
    }
}

for (const [press, release] of [['pointerdown', 'pointerup'], ['mousedown', 'mouseup'], ['touchstart', 'touchend']] as const) {
    test.serial(`mobile padding: ${press}, ${release}, click and empty selection hide the menu`, t => {
        const s = setup();
        try {
            s.show();
            const menu = s.menus()[0];
            t.deepEqual(menu.children.map(child => child.textContent), ['Cytuj', 'Dodaj jako kontekst']);
            menu.emit(press, { target: menu });
            s.doc.emit(release, { target: menu });
            menu.emit('click', { target: menu });
            s.selection.isCollapsed = true;
            s.doc.emit('selectionchange');
            s.clock.advance(249);
            t.is(s.menus()[0], menu);
            s.clock.advance(1);
            t.is(s.menus().length, 0);
        } finally { s.restore(); }
    });

    test.serial(`mobile padding: ${press} refreshes retained selection, position and a later quote`, t => {
        const s = setup();
        try {
            s.show();
            const menu = s.menus()[0];
            menu.emit(press, { target: menu });
            s.doc.emit(release, { target: menu });
            menu.emit('click', { target: menu });
            s.rectangles([rect(70, 180, 90, 20)]);
            // Release itself must evaluate the selection even without selectionchange.
            s.clock.advance(250);
            t.is(s.menus().length, 1);
            t.deepEqual(s.menus()[0].style, { maxWidth: '300px', maxHeight: '500px', left: '60px', top: '208px' });
            s.selectText('Nowy fragment');
            s.rectangles([rect(90, 220, 80, 20)]);
            s.show();
            t.deepEqual(s.menus()[0].style, { maxWidth: '300px', maxHeight: '500px', left: '80px', top: '248px' });
            s.menus()[0].children[0].emit('click');
            t.is(s.input.value, '> Nowy fragment\n\n');
            t.is(s.clears(), 1);
        } finally { s.restore(); }
    });

    for (const target of ['padding', 'button'] as const) {
        test.serial(`mobile ${target}: ${release} without click releases the selection lock`, t => {
            const s = setup();
            try {
                s.show();
                const menu = s.menus()[0];
                const element = target === 'padding' ? menu : menu.children[0];
                t.is(menu.children[0].textContent, 'Cytuj');
                menu.emit(press, { target: element });
                s.doc.emit(release, { target: element });
                s.clock.advance(250);
                t.is(s.menus().length, 1);
                s.selection.isCollapsed = true;
                s.doc.emit('selectionchange');
                s.clock.advance(250);
                t.is(s.menus().length, 0);
            } finally { s.restore(); }
        });
    }

    for (const action of ['quote', 'context'] as const) {
        test.serial(`mobile ${action}: long ${press}, empty selection, ${release}, click acts once`, t => {
            const s = setup();
            try {
                s.show();
                const menu = s.menus()[0];
                const button = menu.children[action === 'quote' ? 0 : 1];
                menu.emit(press, { target: button });
                s.selection.isCollapsed = true;
                s.selectText('');
                s.doc.emit('selectionchange');
                s.clock.advance(10000);
                t.is(s.menus()[0], menu);
                s.doc.emit(release, { target: button });
                s.clock.advance(249);
                t.is(s.menus()[0], menu);
                button.emit('click', { target: button });
                menu.emit('click', { target: button });
                s.clock.advance(1000);
                if (action === 'quote') {
                    t.is(s.input.value, '> Pierwsza linia\n> Druga linia\n\n');
                    t.is(s.resized(), 1);
                    t.is(s.focused(), 1);
                } else t.deepEqual(s.attachments, ['Pierwsza linia\nDruga linia']);
                t.is(s.clears(), 1);
                t.is(s.menus().length, 0);
            } finally { s.restore(); }
        });
    }
}

test.serial('mobile padding: click without release event also unlocks the menu', t => {
    const s = setup();
    try {
        s.show();
        const menu = s.menus()[0];
        t.is(menu.children[0].textContent, 'Cytuj');
        menu.emit('pointerdown', { target: menu });
        menu.emit('click', { target: menu });
        s.selection.isCollapsed = true;
        s.clock.advance(250);
        t.is(s.menus().length, 0);
    } finally { s.restore(); }
});

test.serial('mobile: scroll hides then restores at current coordinates; offscreen selection stays hidden', t => {
    const s = setup();
    try {
        s.show();
        t.is(s.menus()[0].style.top, '148px');
        s.container.emit('scroll');
        t.is(s.menus().length, 0);
        s.container.scrollTop = 80;
        s.rectangles([rect(40, 70, 60, 20)]);
        s.clock.advance(249);
        t.is(s.menus().length, 0);
        s.clock.advance(1);
        t.is(s.menus()[0].style.top, '148px');
        s.rectangles([rect(40, -70, 60, 20)]);
        s.container.emit('scroll');
        s.clock.advance(250);
        t.is(s.menus().length, 0);
    } finally { s.restore(); }
});

test.serial('mobile: panel overlap on tablet limits placement; U7 list resize uses current height', t => {
    const s = setup();
    try {
        s.panel.bounds = rect(10, 200, 300, 100);
        s.show();
        t.deepEqual(s.menus()[0].style, { maxWidth: '300px', maxHeight: '150px', left: '30px', top: '30px' });
        s.panel.bounds = rect(10, 550, 300, 100);
        s.container.clientHeight = 180;
        s.show();
        t.deepEqual(s.menus()[0].style, { maxWidth: '300px', maxHeight: '180px', left: '30px', top: '148px' });
    } finally { s.restore(); }
});

test.serial('mobile: cancel releases pressed menu and Escape cancels pending evaluation', t => {
    const s = setup();
    try {
        s.show();
        t.is(s.menus()[0].children[0].textContent, 'Cytuj');
        s.menus()[0].emit('pointerdown');
        s.selection.isCollapsed = true;
        s.doc.emit('pointercancel');
        s.clock.advance(250);
        t.is(s.menus().length, 0);
        s.selection.isCollapsed = false;
        s.doc.emit('selectionchange');
        s.doc.emit('keydown', { key: 'Escape' });
        s.clock.advance(250);
        t.is(s.menus().length, 0);
    } finally { s.restore(); }
});

for (const mobile of [true, false]) {
    test.serial(`${mobile ? 'mobile' : 'desktop'}: detach cancels queued work and removes all listeners`, t => {
        const s = setup(mobile);
        try {
            if (mobile) s.show(); else { s.container.emit('mouseup'); s.clock.advance(0); }
            t.is(s.menus()[0].children[0].textContent, mobile ? 'Cytuj' : 'Kopiuj');
            if (mobile) { s.doc.emit('selectionchange'); s.container.emit('scroll'); }
            else s.container.emit('mouseup');
            const staleCallbacks = [...s.clock.tasks.values()].map(task => task.callback);
            const reads = s.reads();
            s.detach();
            t.is(s.clock.tasks.size, 0);
            t.is(s.doc.count(), 0);
            t.is(s.container.count(), 0);
            s.clock.advance(1000);
            for (const callback of staleCallbacks) callback();
            t.is(s.reads(), reads);
            t.is(s.created(), 1);
            t.is(s.menus().length, 0);
        } finally { s.restore(); }
    });
}
