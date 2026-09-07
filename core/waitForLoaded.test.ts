/**
 * `waitForLoaded` — czekanie na `state === 'loaded'`.
 *
 * Testy przyjechały 1:1 ze strażnika startu (AUD-wydajnosc-001/062). Pole źródła nazywa się
 * dziś `events` (bez podkreślnika) — B-03 opisywał je jako „de facto publiczny kontrakt".
 * Test „podmiana instancji pod czekającym" ZOSTAJE: `waitForLoaded` dalej ma ten kontrakt,
 * mimo że runtime po clean-room woła ją na SOBIE i instancji nie podmienia.
 */
import test from 'ava';
import { waitForLoaded } from './waitForLoaded.js';

// ── T8-T11 (behawioralne, AUD-wydajnosc-001/062) — waitForLoaded z core/waitForLoaded.ts ──
// Zastępuje strażnika ze znaleziska: „whenLoaded rozwiązuje się w ≤~10 ms po ustawieniu loaded,
// a nie po pełnym ticku siatki". Minimalny fake-event-bus (bez `obsidian`, bez PKMEnv) — testuje
// PRAWDZIWE zachowanie funkcji, nie regex po źródle.

/** Minimalny fake `events` — wystarcza `on()`, żaden inny kawałek EventBus nie jest tu potrzebny. */
function fakeEventSource() {
    const listeners: Record<string, Array<() => void>> = {};
    return {
        on(key: string, cb: () => void) {
            (listeners[key] ||= []).push(cb);
            return () => { listeners[key] = (listeners[key] || []).filter(x => x !== cb); };
        },
        fire(key: string) {
            for (const cb of [...(listeners[key] || [])]) cb();
        },
        hasListeners(key: string) {
            return (listeners[key] || []).length > 0;
        },
    };
}

test('waitForLoaded: env juz loaded w chwili wywolania -> resolve natychmiast, bez timera', async t => {
    const env = { state: 'loaded' };
    const started = Date.now();
    // pollMs celowo ogromny — gdyby liczyła się siatka zamiast sprawdzenia na wejściu, test
    // przekroczyłby limit czasu AVA zamiast po prostu być powolny.
    const resolved = await waitForLoaded(() => env, 60_000);
    t.is(resolved, env);
    // Próg celowo luźny (nie <20 jak w pierwszej wersji) — pod pełnym `npx ava core` testy lecą
    // równolegle i CPU bywa obciążone; dalej to o rzędy wielkości mniej niż `pollMs` = 60 000.
    t.true(Date.now() - started < 60, 'ścieżka "już gotowe" zajęła zbyt dużo czasu jak na resolve bez timera');
});

test('waitForLoaded: rozwiazuje sie na zdarzenie loaded, NIE czekajac na pelny tick siatki bezpieczenstwa', async t => {
    const bus = fakeEventSource();
    const env: { state: string; events: ReturnType<typeof fakeEventSource> } = { state: 'loading', events: bus };

    // Siatka bezpieczeństwa na 300 ms — jeśli test przejdzie w kilkanaście ms, to dzięki
    // zdarzeniu, nie dzięki tickowi. Mutacja cofająca do "sam poll" zrobi z tego czerwony test
    // (spóźniony resolve, patrz próg niżej), zamiast fałszywie zielonego po prostu wolniejszego biegu.
    const promise = waitForLoaded(() => env, 300);
    await new Promise(r => setTimeout(r, 15));

    env.state = 'loaded';
    const emittedAt = Date.now();
    bus.fire('loaded');

    const resolved = await promise;
    t.is(resolved, env);
    t.true(Date.now() - emittedAt < 50, 'rozwiązanie zajęło zbyt długo po zdarzeniu — wygląda na powrót do samej siatki 100/250 ms');
});

test('waitForLoaded: env bez szyny zdarzen (samo state) -> jedyna droga to siatka odpytywania', async t => {
    let current: { state: string } | undefined;
    setTimeout(() => { current = { state: 'loaded' }; }, 10);
    // Brak env w chwili wywołania I brak `events` = brak czego się podpiąć zdarzeniowo — to
    // JEDYNY przypadek, w którym siatka jest główną drogą, nie asekuracją (fallback strukturalny).
    const resolved = await waitForLoaded(() => current, 20);
    t.is(resolved.state, 'loaded');
});

// ── T10 (regression guard — review 2026-09-02) ──────────────────────────────
// Pierwsza wersja podpinała się pod `events` TYLKO w chwili wywołania — env powstały PO
// starcie (albo instancja podmieniona pod whenLoaded, patrz test niżej) zostawał złapany
// WYŁĄCZNIE tickiem siatki, czyli 100→250 ms było tu latentną REGRESJĄ, nie poprawą.
// `check()` ma dziś dopinać subskrypcję do KAŻDEJ nowo zobaczonej instancji, nie tylko
// pierwszej — więc nawet env spóźniony ma się rozwiązywać na zdarzenie, nie na tik.
test('waitForLoaded: env powstaje PO wywolaniu -> siatka go ODKRYWA i dopina subskrypcje, dalej czeka na ZDARZENIE nie na KOLEJNY tick', async t => {
    const bus = fakeEventSource();
    let current: { state: string; events: ReturnType<typeof fakeEventSource> } | undefined;

    // Siatka 60 ms. Env pojawia się po 15 ms — ZA WCZEŚNIE, żeby złapać go pierwszym tickiem od
    // razu (ten ma dopiero prawo zajść ~60 ms od startu). Czekamy do 70 ms (tick ~60 ms już
    // zdążył odkryć env i podpiąć subskrypcję), a 'loaded' emitujemy DALEKO od następnego ticku
    // (~120 ms). Jeśli subskrypcja po odkryciu zadziałała, resolve przyjdzie tuż po zdarzeniu;
    // gdyby siatka tylko odkrywała env bez dopięcia się do jego szyny (regresja: subskrypcja
    // liczona tylko raz, przy pierwszym check() na starcie), test czekałby do ~120 ms.
    const promise = waitForLoaded(() => current, 60);

    await new Promise(r => setTimeout(r, 15));
    current = { state: 'loading', events: bus };

    await new Promise(r => setTimeout(r, 55)); // t≈70ms — tick ~60ms już odkrył env i podpiął się

    current.state = 'loaded';
    const emittedAt = Date.now();
    bus.fire('loaded');

    const resolved = await promise;
    t.is(resolved, current);
    t.true(Date.now() - emittedAt < 30, 'rozwiązanie zajęło zbyt długo po zdarzeniu — siatka odkryła env, ale nie dopięła się do jego szyny (czekała na kolejny tick, nie na zdarzenie)');
});

test('waitForLoaded: create() podmienia instancje pod whenLoaded (reload) -> siatka przepina subskrypcje na NOWA instancje, nie czeka na jej kolejny tick', async t => {
    const busA = fakeEventSource();
    const busB = fakeEventSource();
    type Env = { state: string; events: ReturnType<typeof fakeEventSource> };
    let current: Env = { state: 'loading', events: busA };

    // Siatka 80 ms (rozmyślnie duża — sam plain-polling co 80 ms wystarczyłby, żeby ZAWSZE
    // złapać `envB.state === 'loaded'` z jakimś opóźnieniem; test ma odróżnić "złapane od razu
    // po zdarzeniu" od "złapane dopiero na kolejnym tiku siatki", więc próg niżej musi być
    // dużo mniejszy niż pollMs).
    const promise = waitForLoaded(() => current, 80);
    await new Promise(r => setTimeout(r, 5)); // subskrypcja pod A ustawiona synchronicznie na starcie

    // Podmiana instancji — jak `create()` przy `reload` (dawny `create()`): nowy
    // obiekt, NOWA szyna zdarzeń. 'loaded' na STAREJ szynie ma już nie mieć żadnego znaczenia.
    const envB: Env = { state: 'loading', events: busB };
    current = envB;

    await new Promise(r => setTimeout(r, 85)); // t≈90ms — tick ~80ms już odkrył podmianę i podpiął się pod B

    let settled = false;
    void promise.then(() => { settled = true; });

    busA.fire('loaded'); // emisja ze STAREJ instancji — subskrypcja powinna być już odpięta
    await new Promise(r => setTimeout(r, 10));
    t.false(settled, 'zdarzenie ze STAREJ instancji rozwiązało promise — subskrypcja nie przełączyła się na nową');

    envB.state = 'loaded';
    const emittedAt = Date.now();
    busB.fire('loaded');
    const resolved = await promise;
    t.is(resolved, envB);
    t.true(Date.now() - emittedAt < 30, 'rozwiązanie po zdarzeniu na NOWEJ instancji zajęło zbyt dużo czasu — siatka odkryła podmianę, ale nie dopięła się do szyny B (czekała na kolejny tik, nie na zdarzenie)');
});

test('waitForLoaded: zdarzenie unloading kasuje siatke i subskrypcje - promise NIE rozwiazuje sie po demontazu', async t => {
    const bus = fakeEventSource();
    const env: { state: string; events: ReturnType<typeof fakeEventSource> } = { state: 'loading', events: bus };

    let settled = false;
    // pollMs=15: gdyby siatka przeżyła 'unloading', złapałaby `state === 'loaded'` dużo przed
    // 60 ms niżej — więc `settled` zostając `false` po tym oknie dowodzi, że interwał naprawdę
    // przestał chodzić, nie że jeszcze nie zdążył.
    const promise = waitForLoaded(() => env, 15).then(v => { settled = true; return v; });

    await new Promise(r => setTimeout(r, 5));
    t.true(bus.hasListeners('loaded') && bus.hasListeners('unloading'), 'subskrypcje nie powstały — nie ma czego kasować, test nic by nie dowodził');

    bus.fire('unloading');
    t.false(bus.hasListeners('loaded'), "'unloading' nie odsubskrybował listenera 'loaded' — cleanup niepełny");
    t.false(bus.hasListeners('unloading'), "'unloading' nie odsubskrybował samego siebie");

    env.state = 'loaded'; // env "domyka się" już PO demontażu — nikt nie powinien tego zobaczyć
    await new Promise(r => setTimeout(r, 60)); // 4x pollMs — siatka, gdyby żyła, zdążyłaby złapać stan

    t.false(settled, 'promise rozwiązał się mimo demontażu — siatka albo subskrypcja przeżyły unloading (obalone 002 wróciłoby)');
    void promise; // celowo nierozwiązana obietnica do końca testu — to jest oczekiwane zachowanie
});
