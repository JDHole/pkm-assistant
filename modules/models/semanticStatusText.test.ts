import test from 'ava';
import { computeSemanticStatusText } from './semanticStatusText.js';

/** Stub `t()` — zwraca `key + JSON(params)`, żeby asercje widziały DOKŁADNIE co poszło do i18n. */
function stubT(key: string, params?: Record<string, unknown>): string {
    return params ? `${key}::${JSON.stringify(params)}` : key;
}

test('brak danych (idle) — plugin bez vaultIndexer albo getStatus() zwraca null', t => {
    const r1 = computeSemanticStatusText(null, stubT);
    t.is(r1.variant, 'idle');
    t.is(r1.text, 'settings.semantic_status_idle');

    const r2 = computeSemanticStatusText(undefined, stubT);
    t.is(r2.variant, 'idle');
});

test('ready z niezerowym countDocs — liczy DOKUMENTY, nie progress.total', t => {
    // Regresja główna: progress.total=4420 (plików przeskanowanych), ale docs=4420 realnych
    // wektorów też — happy path, tekst niesie liczbę dokumentów.
    const r = computeSemanticStatusText({ status: 'ready', total: 4420, docs: 4420 }, stubT);
    t.is(r.variant, 'ready');
    t.is(r.text, 'settings.semantic_status_ready::{"count":4420}');
});

test('ready + countDocs=0 + total>0 → indeks pusty, NIE "Aktywne" (regresja W5)', t => {
    // To jest DOKŁADNIE bug z zadania: skan przeszedł 4420 plików, ale indeks pusty
    // (pad pierwszego skanu, _publish() z zerowym db).
    const r = computeSemanticStatusText({ status: 'ready', total: 4420, docs: 0 }, stubT);
    t.is(r.variant, 'ready_empty');
    t.is(r.text, 'settings.semantic_status_ready_empty');
    // Kontrolne: tekst NIE zawiera klucza "ready" (starego, mylącego)
    t.false(r.text.includes('settings.semantic_status_ready::'));
});

test('ready + countDocs=0 + total=0 → to NIE jest "pusty indeks po padzie", tylko legit pusty vault', t => {
    // Mutacja warunku total>0: bez tej bramki świeży, poprawnie pusty vault (0 plików do
    // zaindeksowania) też pokazywałby "kliknij Reindeksuj", co byłoby mylące (nic tam nie ma).
    const r = computeSemanticStatusText({ status: 'ready', total: 0, docs: 0 }, stubT);
    t.is(r.variant, 'ready');
    t.is(r.text, 'settings.semantic_status_ready::{"count":0}');
});

test('ready z lastError dokleja ostrzeżenie do tekstu (nie podmienia go)', t => {
    const r = computeSemanticStatusText(
        { status: 'ready', total: 100, docs: 97, lastError: 'timeout po 60s' },
        stubT,
    );
    t.is(r.variant, 'ready');
    t.true(r.text.startsWith('settings.semantic_status_ready::{"count":97}'));
    t.true(r.text.includes('settings.semantic_status_last_error::{"error":"timeout po 60s"}'));
});

test('ready + skipped>0 dokleja liczbę pominiętych notatek', t => {
    const r = computeSemanticStatusText(
        { status: 'ready', total: 100, docs: 95, skipped: 3 },
        stubT,
    );
    t.true(r.text.includes('settings.semantic_status_skipped::{"count":3}'));
});

test('ready + lastError + skipped naraz — oba ogony w tekście, w kolejności error→skipped', t => {
    const r = computeSemanticStatusText(
        { status: 'ready', total: 100, docs: 90, lastError: 'boom', skipped: 5 },
        stubT,
    );
    const errIdx = r.text.indexOf('settings.semantic_status_last_error');
    const skipIdx = r.text.indexOf('settings.semantic_status_skipped');
    t.true(errIdx > -1 && skipIdx > -1);
    t.true(errIdx < skipIdx);
});

test('building — pokazuje indexed/total z progresu skanu', t => {
    const r = computeSemanticStatusText({ status: 'building', indexed: 12, total: 4420 }, stubT);
    t.is(r.variant, 'building');
    t.is(r.text, 'settings.semantic_status_building::{"indexed":12,"total":4420}');
});

test('error — niesie lastError, spada na "?" gdy brak', t => {
    const withErr = computeSemanticStatusText({ status: 'error', lastError: 'DNS fail' }, stubT);
    t.is(withErr.variant, 'error');
    t.is(withErr.text, 'settings.semantic_status_error::{"error":"DNS fail"}');

    const noErr = computeSemanticStatusText({ status: 'error', lastError: null }, stubT);
    t.is(noErr.text, 'settings.semantic_status_error::{"error":"?"}');
});

test('no_provider i disabled_mobile — statyczne komunikaty bez parametrów', t => {
    t.is(computeSemanticStatusText({ status: 'no_provider' }, stubT).variant, 'no_provider');
    t.is(computeSemanticStatusText({ status: 'disabled_mobile' }, stubT).variant, 'disabled_mobile');
});

test('status nieznany → domyślnie idle (bramka default nie jest martwa)', t => {
    const r = computeSemanticStatusText({ status: 'wat' }, stubT);
    t.is(r.variant, 'idle');
});
