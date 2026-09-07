/**
 * Migracja ada-002 → 3-small — strażnik AUD-bledy-040.
 *
 * Do naprawy `_syncEmbeddingModelSettings` (src/main.ts) pokazywał 15-sekundowy Notice
 * „Przełączam na text-embedding-3-small. Wymagany reindex", a DOPIERO POTEM próbował zapisać
 * ustawienia — w `try { save() } catch (_) {}`. Gdy zapis padł (zajęty plik, dysk sieciowy),
 * nie było ani logu, ani drugiego komunikatu: user robił reindex w przekonaniu, że ustawienie
 * jest utrwalone, a przy następnym starcie migracja startowała od zera.
 */
import test from 'ava';
import { announceAdaMigration, ADA_FROM, ADA_TO } from './adaMigration.js';

const collect = () => {
    const notices: string[] = [];
    const errors: unknown[] = [];
    return {
        notices,
        errors,
        notify: (message: string) => { notices.push(message); },
        onError: (error: unknown) => { errors.push(error); },
    };
};

test('zapis przeszedł — user dostaje obietnicę przełączenia i wie o reindeksie', async t => {
    const spy = collect();

    const saved = await announceAdaMigration({ save: async () => { }, notify: spy.notify, onError: spy.onError });

    t.true(saved);
    t.is(spy.notices.length, 1);
    t.true(spy.notices[0].includes(ADA_TO), 'komunikat nazywa nowy model');
    t.regex(spy.notices[0], /reindex/i, 'reindex jest warunkiem działania wyszukiwania');
    t.is(spy.errors.length, 0);
});

test('AUD-bledy-040: zapis padł — komunikat mówi, że przełączenie NIE zostało utrwalone', async t => {
    const spy = collect();
    const boom = new Error('EBUSY: settings.json zajęty');

    const saved = await announceAdaMigration({
        save: async () => { throw boom; },
        notify: spy.notify,
        onError: spy.onError,
    });

    t.false(saved, 'pad zapisu to nie jest udana migracja');
    t.is(spy.notices.length, 1, 'user dostaje DOKŁADNIE jeden komunikat — ten prawdziwy');
    t.regex(spy.notices[0], /po restarcie/i, 'user wie, że po restarcie wróci stary model');
    t.false(/Wymagany reindex/i.test(spy.notices[0]), 'nie wysyłamy usera na reindex pod nieutrwalone ustawienie');
    t.is(spy.errors[0], boom, 'pad idzie do logu z kontekstem, nie do pustego catch');
});

test('AUD-bledy-040: zapis rzucił synchronicznie — ta sama ścieżka co odrzucona obietnica', async t => {
    const spy = collect();

    const saved = await announceAdaMigration({
        save: () => { throw new Error('sync boom'); },
        notify: spy.notify,
        onError: spy.onError,
    });

    t.false(saved);
    t.regex(spy.notices[0], /po restarcie/i);
    t.is(spy.errors.length, 1);
});

test('brak zapisywacza ustawień — melduje pad, nie udaje sukcesu', async t => {
    const spy = collect();

    const saved = await announceAdaMigration({ save: undefined, notify: spy.notify, onError: spy.onError });

    t.false(saved, 'nie ma czym zapisać = nic nie utrwalone (fail-closed w meldunku)');
    t.regex(spy.notices[0], /po restarcie/i);
});

test('komunikat zawsze nazywa model wycofany, żeby user rozpoznał czego dotyczy', async t => {
    const ok = collect();
    const bad = collect();

    await announceAdaMigration({ save: async () => { }, notify: ok.notify, onError: ok.onError });
    await announceAdaMigration({ save: async () => { throw new Error('x'); }, notify: bad.notify, onError: bad.onError });

    t.true(ok.notices[0].includes(ADA_FROM));
    t.true(bad.notices[0].includes(ADA_FROM));
});
