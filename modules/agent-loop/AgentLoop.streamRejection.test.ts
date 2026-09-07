/**
 * AgentLoop — odrzucenie promisy zwróconej przez `model.stream()`.
 *
 * DLACZEGO ten plik istnieje (audyt nocny 2026-08-12, kandydat #1 z risk registeru):
 * `LoopModelLike.stream()` jest zadeklarowany jako `: void`, ale PRODUKCYJNY adapter
 * (`modules/models/adapters/chat_adapter_base.ts` → `async stream()`) zwraca Promise
 * i przy błędzie robi DWIE rzeczy naraz: woła `handlers.error(normalized_error)`
 * ORAZ rzuca ten sam obiekt dalej (`throw err`, linia 729).
 *
 * `AgentLoop.stream()` woła `model.stream(payload, handlers)` bez `await` i bez
 * `.catch()`. Callbackową ścieżkę pętla obsługuje poprawnie (poniżej: test „pętla
 * odrzuca..."), ale promisa zwrócona przez `stream()` NIE JEST przez nikogo
 * obejrzana → w Node to `ERR_UNHANDLED_REJECTION`. Reprodukcja z nocy, Node 22.22:
 *
 *     UnhandledPromiseRejection: ... The promise rejected with the reason "#<Object>".
 *
 * `#<Object>`, bo `normalized_error` jest gołym obiektem, nie `Error`. Ten sam podpis
 * ubił runner scenariuszy 2026-08-11 (risk register: FLAKY runner scenariuszy).
 *
 * Testy NIE zmieniają zachowania pluginu — pinują je. Drugi test wszedł jako
 * `test.failing` (znany zepsuty stan); po fixie z 2026-08-13 (`Promise.resolve(
 * model.stream(...)).catch(reject)` w `stream()`) `.failing` zdjęte — test
 * pilnuje, żeby pętla już zawsze oglądała promisę adaptera.
 */
import test from 'ava';
import { runAgentLoop } from './AgentLoop.js';
import { ArrayMessageStore } from './MessageStore.js';

type Payload = Record<string, unknown>;
type StreamHandlers = { chunk: (resp: unknown) => void; done: (resp: unknown) => void; error: (err: unknown) => void };

/**
 * Promisa-szpieg: odrzucona, ale z własną siatką (`inner.catch`), żeby TEST nie ubił
 * workera ava. `observed` mówi, czy WOŁAJĄCY sam podpiął się pod wynik — czyli czy
 * odrzucenie miałoby gdzie wylądować w produkcji.
 */
function trackedRejection(err: unknown): { thenable: PromiseLike<never>; wasObserved: () => boolean } {
    let observed = false;
    const inner: Promise<never> = Promise.reject(err);
    inner.catch(() => { /* siatka testu — patrz opis wyżej */ });
    const thenable = {
        then(onOk?: unknown, onErr?: unknown) { observed = true; return inner.then(onOk as never, onErr as never); },
        catch(onErr?: unknown) { observed = true; return inner.catch(onErr as never); },
        finally(onEnd?: unknown) { observed = true; return inner.finally(onEnd as never); },
    } as unknown as PromiseLike<never>;
    return { thenable, wasObserved: () => observed };
}

/** Błąd w kształcie, w jakim oddaje go `normalize_error` — goły obiekt, nie `Error`. */
const normalizedError = () => ({ message: 'stream error', http_status: 500, details: { code: 500 } });

/** Atrapa modelu 1:1 z produkcyjnym adapterem: `handlers.error(obj)` + rzucenie tego samego obj. */
function makeRejectingModel(err: unknown) {
    const tracked = trackedRejection(err);
    return {
        wasObserved: tracked.wasObserved,
        // Sygnatura `LoopModelLike` mówi `: void` — i to jest sedno: TypeScript nie widzi
        // tu wiszącej promisy, bo interfejs zataja, że realny adapter jest `async`.
        stream(_payload: Payload, handlers: StreamHandlers): void {
            handlers.error(err);
            return tracked.thenable as unknown as void;
        },
    };
}

/**
 * `t.throwsAsync` wymaga instancji `Error` — a tu chodzi DOKŁADNIE o to, że powodem
 * odrzucenia jest goły obiekt (`normalize_error`). Stąd ręczny try/catch.
 */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
    try { await p; } catch (e) { return e; }
    throw new Error('oczekiwano odrzucenia, a promisa się spełniła');
}

test('pętla odrzuca błędem z handlers.error (ścieżka callbackowa działa)', async (t) => {
    const err = normalizedError();
    const model = makeRejectingModel(err);
    const store = new ArrayMessageStore([{ role: 'user', content: 'hi' }]);

    const thrown = await rejectionOf(runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 2 },
    }));

    t.false(thrown instanceof Error, 'powodem odrzucenia jest goły obiekt, nie Error — stąd „#<Object>" w logu Node');
    t.is((thrown as { message?: string })?.message, 'stream error');
    t.is((thrown as { http_status?: number })?.http_status, 500);
});

test.serial('pętla obserwuje promisę zwróconą przez model.stream() (fix 2026-08-13: Promise.resolve().catch w stream())', async (t) => {
    // AUD-testy-017: `wasObserved()` SAM nie wystarcza jako dowód. `Promise.resolve(thenable)`
    // WOŁA `.then()` atrapy przez samą asymilację JS (PromiseResolveThenableJob) — NIEZALEŻNIE
    // od tego, czy do WYNIKU tej asymilacji ktoś doczepił `.catch`. Innymi słowy: `wasObserved()`
    // przechodzi na zielono nawet gdyby `.catch((err) => reject(err))` w `stream()` zniknął —
    // mutacja tego dowiodła (bieg audytu 2026-09-01: „2 tests passed" + „2 unhandled rejections"
    // w tym samym pliku). Prawdziwym dowodem, że `stream()` NIE zostawia sierocej odrzuconej
    // promisy, jest brak `unhandledRejection` w Node — dokładnie ten sygnał, który 2026-08-12
    // ubił runner scenariuszy. Wzór testu: `modules/models/adapters/stream_third_exit.test.ts`
    // (007: „fire-and-forget get_models(true) ma właściciela odrzucenia").
    const err = normalizedError();
    const model = makeRejectingModel(err);
    const store = new ArrayMessageStore([{ role: 'user', content: 'hi' }]);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
        await rejectionOf(runAgentLoop({
            model,
            store,
            resolveTools: () => [],
            executeToolCall: async () => 'x',
            limits: { maxIterations: 2 },
        }));
        // Domknięcie mikrozadań — gdyby pętla podpięła handler asynchronicznie. Node ocenia
        // promisy jako „unhandled" na końcu bieżącego przeglądu mikrozadań, więc kilka ticków
        // wystarcza, żeby ewentualny brak .catch zdążył wypalić zdarzenie.
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }

    t.true(
        model.wasObserved(),
        'model.stream() zwraca promisę, której nikt nie ogląda — w produkcji to nieobsłużone odrzucenie',
    );
    t.deepEqual(
        unhandled, [],
        'thenable może zgłosić się jako "obserwowana" (asymilacja JS sama woła .then) i mimo to ' +
        'wyciekać jako unhandledRejection, jeśli Promise.resolve(...) w stream() nie ma własnego ' +
        '.catch — to jest realny skutek, który ta bramka ma pilnować, nie stan atrapy',
    );
});
