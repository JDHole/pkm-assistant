/**
 * ask_user - strażnik AUD-bledy-026.
 *
 * Tura leci w zakładce W TLE, więc `chat_view._renderAskUserBlock()` nigdy nie odpalił
 * i `plugin._askUserPromise` nie istnieje. Do naprawy narzędzie brało wtedy PIERWSZĄ OPCJĘ
 * z listy i oddawało ją modelowi jako odpowiedź użytkownika (`success:true`, `auto:true`) -
 * model dostawał sfabrykowaną zgodę na operację, której user nie widział.
 */
import test from 'ava';
import { createAskUserTool } from './AskUserTool.js';
import type { AskUserPlugin } from './AskUserTool.js';

/** Zwrotka `ask_user` czytana w asercjach - pola typowane POD UŻYCIE w tym pliku. */
type AskRes = {
    success?: boolean;
    error?: string;
    message?: string;
    question?: string;
    answer?: string;
    auto?: boolean;
};

const exec = (plugin: AskUserPlugin | null, args: Record<string, unknown> = {}) =>
    createAskUserTool().execute(
        { question: 'Nadpisać notatkę X?', options: ['Tak', 'Nie'], ...args },
        {},
        plugin,
    ) as Promise<AskRes>;

test('brak UI (zakładka w tle) - ask_user NIE zmyśla odpowiedzi usera', async t => {
    const plugin: AskUserPlugin = {};

    const res = await exec(plugin);

    t.false(res.success, 'nie było kogo zapytać = to nie jest sukces');
    t.true(String(res.error).includes('no_ui'), 'rozpoznawalny kod błędu dla pętli i modelu');
    t.is(res.answer, undefined, 'ZERO zmyślonej odpowiedzi - pierwsza opcja to nie zgoda usera');
    t.is(res.auto, undefined, 'flaga auto-odpowiedzi znika razem z auto-odpowiedzią');
    t.is(res.question, 'Nadpisać notatkę X?');
});

test('brak UI - model dostaje zdanie, co ma zrobić (nie goły klucz i18n)', async t => {
    const res = await exec({});

    t.true(typeof res.message === 'string' && res.message.length > 20, 'jest tekst dla modelu');
    t.not(res.message, 'mcp.ask_user.no_ui', 'i18n rozwiązane, nie goły klucz');
});

test('brak UI bez listy opcji - też odmowa, nie „OK" wzięte z sufitu', async t => {
    const res = await exec({}, { options: undefined });

    t.false(res.success);
    t.is(res.answer, undefined, 'fallback „OK" był tak samo zmyślony jak pierwsza opcja');
});

test('brak pluginu - odmowa zamiast NPE i zamiast zmyślonej odpowiedzi', async t => {
    const res = await exec(null);

    t.false(res.success);
    t.true(String(res.error).includes('no_ui'));
    t.is(res.answer, undefined);
});

test('UI jest - odpowiedź usera wraca nietknięta (ścieżka zdrowa)', async t => {
    const plugin: AskUserPlugin = { _askUserPromise: Promise.resolve('Nie') };

    const res = await exec(plugin);

    t.true(res.success);
    t.is(res.answer, 'Nie');
    t.is(res.auto, false);
    t.is(plugin._askUserPromise, null, 'sprzątanie w finally działa dalej');
});

test('UI jest, ale user anulował - porażka, nie pierwsza opcja', async t => {
    const res = await exec({ _askUserPromise: Promise.resolve(null) });

    t.false(res.success);
    t.is(res.answer, undefined);
});

test('brak UI - pytanie NIE zostaje w _askUserPending (blok nie powstanie po turze)', async t => {
    const plugin: AskUserPlugin = {};

    await exec(plugin);

    t.is(plugin._askUserPending, null);
});

/**
 * AUD-bledy-030 (resztka) — budzik 5 min ma właściciela także w oknie oczekiwania.
 *
 * `clearTimeout` w `finally` (fala 1) zdejmuje budzik po rozstrzygnięciu wyścigu. Zostaje
 * okno, w którym user JESZCZE nie odpowiedział: wtedy obietnica nigdy się nie rozstrzyga,
 * `finally` nie odpala, a budzik tyka na pluginie po `onunload`. Uchwyt idzie więc dodatkowo
 * do cyklu życia pluginu — kanon z `src/main.ts` (`registerInterval`, `clearInterval` czyści
 * w JS uchwyty obu rodzajów).
 */
test('AUD-bledy-030: uchwyt budzika trafia do cyklu życia pluginu', async t => {
    const registered: unknown[] = [];
    const plugin: AskUserPlugin = {
        _askUserPromise: Promise.resolve('Tak'),
        registerInterval: (id: unknown) => { registered.push(id); return id as number; },
    };

    await exec(plugin);

    t.is(registered.length, 1, 'unload pluginu ma czym skasować budzik czekający na odpowiedź');
    t.not(registered[0], undefined, 'oddany jest realny uchwyt, nie undefined');
});

test('AUD-bledy-030: plugin bez registerInterval (starszy host, testy) nie wywraca pytania', async t => {
    const res = await exec({ _askUserPromise: Promise.resolve('Nie') });

    t.true(res.success, 'rejestracja uchwytu jest opcjonalna — brak jej nie psuje ask_user');
    t.is(res.answer, 'Nie');
});

/**
 * AUD-code-review-002 — budzik 5 min NIE zmyśla zgody usera.
 *
 * Ta gałąź niosła DOKŁADNIE ten sam bug, który AUD-bledy-026 naprawił w gałęzi „brak UI":
 * pierwsza opcja z listy szła do modelu jako `{success:true, answer:<opcja>, auto:true}` —
 * sfabrykowana zgoda człowieka na operację, której user nigdy nie widział (odszedł od
 * komputera na 5+ minut). `_askUserPromise` celowo NIGDY się nie rozstrzyga (user nie
 * odpowiada), więc jedyną drogą do rozstrzygnięcia jest budzik — `timeoutMs` w opcjach
 * `createAskUserTool` pozwala go przyspieszyć bez czekania naprawdę 5 minut w teście.
 */
const execTimeout = (plugin: AskUserPlugin, args: Record<string, unknown> = {}) =>
    createAskUserTool({ timeoutMs: 5 }).execute(
        { question: 'Nadpisać notatkę X?', options: ['Tak', 'Nie'], ...args },
        {},
        plugin,
    ) as Promise<AskRes>;

test('AUD-code-review-002: timeout budzika - odmowa, NIE zmyślona pierwsza opcja', async t => {
    // Promise, który świadomie nigdy się nie rozstrzyga - user nie odpowiedział.
    const plugin: AskUserPlugin = { _askUserPromise: new Promise<string | null>(() => {}) };

    const res = await execTimeout(plugin);

    t.false(res.success, 'timeout to porażka, nie sukces ze zmyśloną zgodą');
    t.is(res.answer, undefined, 'ZERO zmyślonej odpowiedzi - "Tak" nie jest zgodą usera');
    t.is(res.auto, undefined, 'flaga auto-odpowiedzi znika razem z auto-odpowiedzią');
    t.true(String(res.error).includes('timeout'), 'rozpoznawalny kod błędu dla pętli i modelu');
    t.is(res.question, 'Nadpisać notatkę X?');
});

test('AUD-code-review-002: timeout budzika bez opcji - dalej odmowa, nie fallback "OK"', async t => {
    const plugin: AskUserPlugin = { _askUserPromise: new Promise<string | null>(() => {}) };

    const res = await execTimeout(plugin, { options: undefined });

    t.false(res.success);
    t.is(res.answer, undefined, 'fallback "OK" był tak samo zmyślony jak pierwsza opcja z listy');
});

test('AUD-code-review-002: timeout budzika - model dostaje zdanie, co się stało (nie goły klucz i18n)', async t => {
    const plugin: AskUserPlugin = { _askUserPromise: new Promise<string | null>(() => {}) };

    const res = await execTimeout(plugin);

    t.true(typeof res.message === 'string' && res.message.length > 20, 'jest tekst dla modelu');
    t.not(res.message, 'mcp.ask_user.timeout', 'i18n rozwiązane, nie goły klucz');
});

test('AUD-code-review-002: timeout budzika - sprzątanie w finally działa jak na innych ścieżkach', async t => {
    const plugin: AskUserPlugin = { _askUserPromise: new Promise<string | null>(() => {}) };

    await execTimeout(plugin);

    t.is(plugin._askUserPromise, null);
    t.is(plugin._askUserPending, null);
});
