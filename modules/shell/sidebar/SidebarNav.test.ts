/**
 * SidebarNav - strażnik demontażu nawigacji.
 *
 * Widoki sidebara wieszają swoje sprzątanie na `nav._currentCleanup` (Komunikator:
 * odsubskrybowanie `agentManager.on(...)` + `clearTimeout` budzika renderu). Gdyby ten uchwyt
 * był wołany WYŁĄCZNIE przez `_render()` przy przejściu na inny widok, zamknięcie panelu
 * (`AgentSidebar.onClose`) zostawiałoby nasłuch na zawsze, a przy ponownym otwarciu powstawałby
 * NOWY `SidebarNav`. Po pięciu cyklach otwórz/zamknij każda wiadomość mieliłaby listing
 * skrzynek pięć razy, na odpiętym DOM-ie.
 */
import test from 'ava';
import { SidebarNav } from './SidebarNav.js';
import type { PluginApi } from '../../../core/index.js';

const fakePlugin = {} as unknown as PluginApi;

/** Atrapa kontenera - `dispose()` nie renderuje, więc wystarczy pusty obiekt. */
const fakeContainer = () => ({ empty() { }, addClass() { } }) as unknown as HTMLElement;

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
        addEventListener() { /* noop - testy nie klikają wstecz */ },
        // `push()` szuka `.sidebar-view-content` żeby zapamiętać scroll - atrapa nie ma czego zwrócić.
        querySelector() { return null; },
    };
    return el;
}

test('dispose() woła sprzątanie bieżącego widoku', t => {
    const nav = new SidebarNav(fakeContainer(), fakePlugin);
    let calls = 0;
    nav._currentCleanup = () => { calls++; };

    nav.dispose();

    t.is(calls, 1, 'zamknięcie panelu odpina subskrypcję i budzik widoku');
});

test('dispose() jest idempotentny — drugie zamknięcie nie odpala sprzątania ponownie', t => {
    const nav = new SidebarNav(fakeContainer(), fakePlugin);
    let calls = 0;
    nav._currentCleanup = () => { calls++; };

    nav.dispose();
    nav.dispose();

    t.is(calls, 1);
    t.is(nav._currentCleanup as unknown, null, 'uchwyt wyzerowany po użyciu');
});

test('dispose() bez zarejestrowanego sprzątania nie rzuca', t => {
    const nav = new SidebarNav(fakeContainer(), fakePlugin);

    t.notThrows(() => nav.dispose());
});

test('dispose() nie przewraca demontażu, gdy sprzątanie widoku rzuci', t => {
    const nav = new SidebarNav(fakeContainer(), fakePlugin);
    nav._currentCleanup = () => { throw new Error('widok padł przy sprzątaniu'); };

    t.notThrows(() => nav.dispose(), 'onClose leci dalej — reszta panelu też musi się odpiąć');
    t.is(nav._currentCleanup as unknown, null);
});

/**
 * Strażnik pilnuje, żeby `_rendering` NIE została przy `true` na zawsze, jeśli renderer widoku
 * albo `_currentCleanup` rzuci wyjątek (flaga musi być zdejmowana w try/finally, nie tylko
 * w ostatniej linii `_render()`). Wszystkie wejścia nawigacji (`push`/`pop`/`replace`/`goHome`/
 * `refresh`) zaczynają się od `if (this._rendering) return;`, więc jeden wywrócony render
 * zamroziłby cały panel do zamknięcia i ponownego otwarcia sidebara.
 */
test('_render() zdejmuje _rendering mimo wyjątku w renderFn — nawigacja nie zamraża się', t => {
    const container = makeFakeEl();
    const nav = new SidebarNav(container as unknown as HTMLElement, fakePlugin);
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
    const nav = new SidebarNav(container as unknown as HTMLElement, fakePlugin);
    nav.register('a', () => { /* noop */ });
    nav.register('b', () => { /* noop */ });
    nav.push('a');
    nav._currentCleanup = () => { throw new Error('sprzątanie widoku padło'); };

    t.notThrows(() => nav.push('b'));
    t.false(nav._rendering);
    t.is(nav.currentView(), 'b', 'nawigacja przeszła na kolejny widok mimo wywrotki sprzątania');
});

/**
 * BUG D2: `ViewRenderer` dopuszcza `Promise<void>` (dwa renderery w repo są `async`), ale ten
 * `try/catch` w `_render()` jest SYNCHRONICZNY - odrzucenie promisy z async renderera omija go
 * i nigdy nie trafia do przyjaznego `sidebar.render_error`, zamiast tego staje się unhandled
 * rejection. Naprawa ma dawać TĘ SAMĄ treść w UI co throw synchroniczny (test wyżej).
 */
test('_render() łapie odrzucenie async renderera i pokazuje TEN SAM render_error co throw synchroniczny', async t => {
    const container = makeFakeEl();
    const nav = new SidebarNav(container as unknown as HTMLElement, fakePlugin);
    nav.register('asyncBoom', async () => { throw new Error('async widok padł'); });

    nav.push('asyncBoom');
    // Odrzucenie leci po microtaskach — daj promisie szansę się rozwiązać.
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setImmediate(resolve));

    const content = container.children.find(c => c.cls === 'sidebar-view-content');
    t.truthy(content, 'kontener widoku istnieje');
    const errorP = content?.children.find(c => c.tag === 'p' && c.cls === 'agent-error');
    t.is(errorP?.text, 'This view failed to load. Go back and try again.',
        'odrzucenie async renderera ma trafić do TEGO SAMEGO render_error co throw synchroniczny');
});

/**
 * `refresh()` re-renderuje TEN SAM wpis stosu (nie zmienia `this.stack`) — porównanie "czy ten
 * render jest jeszcze aktualny" PO WPISIE STOSU nie odróżnia więc refresh od zwykłej nawigacji:
 * `this.stack[this.stack.length-1] === current` zostaje `true` nawet PO refreshu, mimo że
 * `_render()` już stworzył NOWY element `.sidebar-view-content` i odpiął stary od kontenera.
 * Spóźnione odrzucenie renderu SPRZED refresha musi rozpoznać, że jego `content` już nie jest
 * bieżący, i nic nie dopisywać — inaczej pisze (na szczęście nieszkodliwie, bo do WĘZŁA
 * ODPIĘTEGO, nie do tego co user widzi) do węzła, którego już nikt nie ogląda.
 */
test('_render() rozróżnia refresh() (ten sam wpis stosu) od nawigacji — spóźnione odrzucenie nie pisze do odpiętego contentu', async t => {
    const container = makeFakeEl();
    const nav = new SidebarNav(container as unknown as HTMLElement, fakePlugin);

    let callNum = 0;
    let rejectFirst: ((e: Error) => void) | null = null;
    nav.register('view', () => {
        callNum++;
        if (callNum === 1) {
            // Render #1 (push) zostaje "w locie" - jego promise nie rozwiązuje się od razu.
            return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
        }
        return Promise.resolve();
    });

    nav.push('view'); // render #1
    const staleContent = container.children.find(c => c.cls === 'sidebar-view-content')!;
    t.truthy(staleContent);

    nav.refresh(); // render #2 na TYM SAMYM wpisie stosu — refresh nie zmienia `this.stack`
    const freshContent = container.children.find(c => c.cls === 'sidebar-view-content')!;
    t.not(staleContent, freshContent, 'refresh ma stworzyć NOWY element contentu, nie ponownie użyć starego');

    // Spóźnione odrzucenie renderu #1 dociera PO refreshu.
    rejectFirst!(new Error('spóźniony async render'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setImmediate(resolve));

    t.is(staleContent.children.length, 0,
        'spóźnione odrzucenie NIE MA pisać do już odpiętego (refresh) contentu — porównanie po wpisie stosu nie odróżnia refresh od nawigacji');
    t.is(freshContent.children.length, 0, 'świeży content (z refresh) zostaje nietknięty');
});

/**
 * Przemianowanie agenta: wpisy stosu trzymają `{ agentName }` z chwili `push()`, więc bez
 * przepisania ich parametrów `refresh()` po rename'ie rysuje profil po STAREJ nazwie
 * i user dostaje „Nie znaleziono agenta". Konsument: `AgentSidebar` na evencie `agent:renamed`.
 */
test('updateParams przepisuje parametry we WSZYSTKICH pasujących wpisach stosu', t => {
    const container = makeFakeEl();
    const nav = new SidebarNav(container as unknown as HTMLElement, fakePlugin);
    const widziane: Array<Record<string, unknown>> = [];
    nav.register('home', () => { /* noop */ });
    nav.register('agent-profile', (_el, _plugin, _nav, params) => { widziane.push({ ...params }); });

    nav.push('home');
    nav.push('agent-profile', { agentName: 'Agent1' });
    nav.push('agent-profile', { agentName: 'Agent1', tab: 'pamiec' });
    nav.push('agent-profile', { agentName: 'Ktos inny' });

    const zmienione = nav.updateParams(params => params.agentName === 'Agent1', { agentName: 'Atlas' });

    t.is(zmienione, 2, 'oba wpisy adresujące starą nazwę, także ten spod wierzchu');
    t.deepEqual(nav.stack.map(e => e.params), [
        {},
        { agentName: 'Atlas' },
        { agentName: 'Atlas', tab: 'pamiec' },
        { agentName: 'Ktos inny' },
    ], 'pozostałe pola wpisu zostają, cudzy agent nietknięty');

    // Zmiana jest czysta: żadnego renderu, dopóki wołacz sam nie odświeży.
    const przedRefreshem = widziane.length;
    nav.refresh();
    t.is(widziane.length, przedRefreshem + 1);
    t.deepEqual(widziane[widziane.length - 1], { agentName: 'Ktos inny' });
});

test('updateParams bez trafień zwraca 0 i nie rusza stosu', t => {
    const container = makeFakeEl();
    const nav = new SidebarNav(container as unknown as HTMLElement, fakePlugin);
    nav.register('home', () => { /* noop */ });
    nav.push('home', { agentName: 'Agent1' });

    t.is(nav.updateParams(params => params.agentName === 'Kogos nie ma', { agentName: 'X' }), 0);
    t.deepEqual(nav.stack[0].params, { agentName: 'Agent1' });
});
