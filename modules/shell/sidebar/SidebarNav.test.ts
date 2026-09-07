/**
 * SidebarNav — strażnik AUD-bledy-045.
 *
 * Widoki sidebara wieszają swoje sprzątanie na `nav._currentCleanup` (Komunikator:
 * odsubskrybowanie `agentManager.on(...)` + `clearTimeout` budzika renderu). Do naprawy
 * ten uchwyt wołał WYŁĄCZNIE `_render()` przy przejściu na inny widok — zamknięcie panelu
 * (`AgentSidebar.onClose`) zostawiało nasłuch na zawsze, a przy ponownym otwarciu powstawał
 * NOWY `SidebarNav`. Po pięciu cyklach otwórz/zamknij każda wiadomość mieliła listing
 * skrzynek pięć razy, na odpiętym DOM-ie.
 */
import test from 'ava';
import { SidebarNav } from './SidebarNav.js';

/** Atrapa kontenera — `dispose()` nie renderuje, więc wystarczy pusty obiekt. */
const fakeContainer = () => ({ empty() { }, addClass() { } });

/** Atrapa DOM-u wystarczająca do przejechania `_render()` (createDiv/createEl/scrollTop). */
type FakeEl = {
    cls?: string;
    tag?: string;
    text?: string;
    scrollTop: number;
    children: FakeEl[];
    addClass(): FakeEl;
    empty(): void;
    createDiv(opts?: { cls?: string }): FakeEl;
    createEl(tag: string, opts?: { cls?: string; text?: string }): FakeEl;
    addEventListener(ev: string, cb: () => void): void;
    querySelector(sel: string): FakeEl | null;
};
function makeFakeEl(): FakeEl {
    const el: FakeEl = {
        scrollTop: 0,
        children: [],
        addClass() { return el; },
        empty() { el.children = []; },
        createDiv(opts) { const d = makeFakeEl(); d.cls = opts?.cls; el.children.push(d); return d; },
        createEl(tag, opts) { const e = makeFakeEl(); e.tag = tag; e.cls = opts?.cls; e.text = opts?.text; el.children.push(e); return e; },
        addEventListener() { /* noop — testy nie klikają wstecz */ },
        // `push()` szuka `.sidebar-view-content` żeby zapamiętać scroll — atrapa nie ma czego zwrócić.
        querySelector() { return null; },
    };
    return el;
}

test('dispose() woła sprzątanie bieżącego widoku', t => {
    const nav = new SidebarNav(fakeContainer(), {});
    let calls = 0;
    nav._currentCleanup = () => { calls++; };

    nav.dispose();

    t.is(calls, 1, 'zamknięcie panelu odpina subskrypcję i budzik widoku');
});

test('dispose() jest idempotentny — drugie zamknięcie nie odpala sprzątania ponownie', t => {
    const nav = new SidebarNav(fakeContainer(), {});
    let calls = 0;
    nav._currentCleanup = () => { calls++; };

    nav.dispose();
    nav.dispose();

    t.is(calls, 1);
    t.is(nav._currentCleanup as unknown, null, 'uchwyt wyzerowany po użyciu');
});

test('dispose() bez zarejestrowanego sprzątania nie rzuca', t => {
    const nav = new SidebarNav(fakeContainer(), {});

    t.notThrows(() => nav.dispose());
});

test('dispose() nie przewraca demontażu, gdy sprzątanie widoku rzuci', t => {
    const nav = new SidebarNav(fakeContainer(), {});
    nav._currentCleanup = () => { throw new Error('widok padł przy sprzątaniu'); };

    t.notThrows(() => nav.dispose(), 'onClose leci dalej — reszta panelu też musi się odpiąć');
    t.is(nav._currentCleanup as unknown, null);
});

/**
 * AUD-code-review-042 — `_rendering` stała przy `true` na zawsze, jeśli renderer widoku albo
 * `_currentCleanup` rzucał wyjątek (flaga była zdejmowana tylko w ostatniej linii `_render()`,
 * poza jakimkolwiek try/catch). Wszystkie wejścia nawigacji (`push`/`pop`/`replace`/`goHome`/
 * `refresh`) zaczynają się od `if (this._rendering) return;`, więc jeden wywrócony render
 * zamrażał cały panel do zamknięcia i ponownego otwarcia sidebara.
 */
test('_render() zdejmuje _rendering mimo wyjątku w renderFn — nawigacja nie zamraża się', t => {
    const container = makeFakeEl();
    const nav = new SidebarNav(container, {});
    nav.register('boom', () => { throw new Error('widok padł'); });
    nav.register('ok', () => { /* renderuje się bez problemu */ });

    t.notThrows(() => nav.push('boom'), 'wyjątek renderera nie wychodzi z push()');
    t.false(nav._rendering, '_rendering wraca do false mimo wywrotki');

    // Dowód, że panel NIE jest zamrożony: kolejna nawigacja realnie działa, nie jest cichym no-opem.
    nav.push('ok');
    t.is(nav.currentView(), 'ok');
});

test('_render() zdejmuje _rendering mimo wyjątku w sprzątaniu poprzedniego widoku', t => {
    const container = makeFakeEl();
    const nav = new SidebarNav(container, {});
    nav.register('a', () => { /* noop */ });
    nav.register('b', () => { /* noop */ });
    nav.push('a');
    nav._currentCleanup = () => { throw new Error('sprzątanie widoku padło'); };

    t.notThrows(() => nav.push('b'));
    t.false(nav._rendering);
    t.is(nav.currentView(), 'b', 'nawigacja przeszła na kolejny widok mimo wywrotki sprzątania');
});
