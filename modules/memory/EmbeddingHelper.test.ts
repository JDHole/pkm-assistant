/**
 * EmbeddingHelper.test.ts — reshape po clean-room / F4 (`modules/embedding/contracts.ts` §6).
 *
 * Do clean-room ten plik testował RĘCZNY remapping `originalIndex` (AUD-testy-058): helper
 * filtrował puste teksty przed wysyłką do adaptera i odbudowywał tablicę wyników. Ten
 * mechanizm ZNIKNĄŁ — kontrakt `EmbeddingModel.embed()` (N wejść → N wyników, `vector:null`
 * dla wejścia pustego, zero żądań przy samych pustych wejściach) trzyma wyrównanie SAM,
 * więc helper dziś tylko DELEGUJE (`modules/memory/EmbeddingHelper.ts::embedBatch`).
 * Testy zostają co do TREŚCI (EH-02..EH-07), zreshape'owane na nowy kształt wywołania.
 */
import test from 'ava';
import { EmbeddingHelper } from './EmbeddingHelper.js';
import type { EmbedResult, EmbeddingModelLike, EmbeddingRuntimeLike } from './EmbeddingHelper.js';

/** Wektory rozróżnialne po treści — pozwala assertować DOKŁADNIE, który tekst dał który wektor. */
const VEC: Record<string, number[]> = {
    hello: [1, 0, 0],
    world: [0, 1, 0],
    foo: [0, 0, 1],
};

function fakeModel(capture?: { texts: string[] | null }): EmbeddingModelLike {
    return {
        modelKey: 'fake:test',
        dims: 3,
        async embed(texts: string[]) {
            if (capture) capture.texts = texts;
            return texts.map((text): EmbedResult => (
                text.trim() ? { vector: VEC[text] ?? [-1, -1, -1] } : { vector: null }
            ));
        },
    };
}

function makeEnv(model: EmbeddingModelLike | null): EmbeddingRuntimeLike {
    return { embeddings: { default: model } };
}

// ── EH-04/05/07 (reshape) ────────────────────────────────────────────────────

test('embedBatch: N wejść -> N wyników; helper NIE filtruje (kontrakt modelu, nie helpera)', async t => {
    const capture: { texts: string[] | null } = { texts: null };
    const helper = new EmbeddingHelper(makeEnv(fakeModel(capture)));

    const texts = ['hello', '', 'world', '   ', 'foo'];
    const result = await helper.embedBatch(texts);

    t.is(result.length, 5, 'wynik ma DŁUGOŚĆ ORYGINALNEJ listy');
    t.deepEqual(result[0], VEC.hello);
    t.is(result[1], null, 'pusty string -> null, NIE wektor sąsiada');
    t.deepEqual(result[2], VEC.world, 'nie przesunięty na pozycję 1');
    t.is(result[3], null, 'sam whitespace -> null');
    t.deepEqual(result[4], VEC.foo, 'nie przesunięty o liczbę odfiltrowanych');

    // Helper po clean-room deleguje WPROST do modelu — to model decyduje, co robić z pustymi
    // wejściami (R1). Helper przekazuje WSZYSTKIE teksty, bez własnego filtrowania.
    t.deepEqual(capture.texts, texts, 'helper przekazuje texts 1:1, model odpowiada za puste wejścia');
});

test('embedBatch: WSZYSTKIE teksty puste -> tablica null (krótkie spięcie jest kontraktem modelu)', async t => {
    const helper = new EmbeddingHelper(makeEnv(fakeModel()));

    const result = await helper.embedBatch(['', '   ', '']);
    t.deepEqual(result, [null, null, null]);
});

test('embedBatch: BEZ pustych tekstów -> kolejność zachowana', async t => {
    const helper = new EmbeddingHelper(makeEnv(fakeModel()));

    const result = await helper.embedBatch(['hello', 'world', 'foo']);
    t.deepEqual(result, [VEC.hello, VEC.world, VEC.foo]);
});

test('embedBatch: pusty tekst na SAMYM POCZĄTKU listy -> reszta pozycji nietknięta', async t => {
    const helper = new EmbeddingHelper(makeEnv(fakeModel()));

    const result = await helper.embedBatch(['', 'hello', 'world']);
    t.is(result[0], null);
    t.deepEqual(result[1], VEC.hello);
    t.deepEqual(result[2], VEC.world);
});

test('embedBatch: rzuca, gdy model nie jest gotowy (brak env)', async t => {
    const helper = new EmbeddingHelper(null);
    await t.throwsAsync(() => helper.embedBatch(['hello']), { message: 'Embed model not ready' });
});

// ── EH-02/EH-03 ──────────────────────────────────────────────────────────────

test('embed(): deleguje do model.embed([text]) i oddaje pierwszy wektor', async t => {
    const helper = new EmbeddingHelper(makeEnv(fakeModel()));
    const vec = await helper.embed('hello');
    t.deepEqual(vec, VEC.hello);
});

test('C-31: embed() bez gotowego modelu rzuca "Embed model not ready"', async t => {
    const helper = new EmbeddingHelper(makeEnv(null));
    await t.throwsAsync(() => helper.embed('hello'), { message: 'Embed model not ready' });
});

test('embed(): wynik pusty (vector:null) z modelu rzuca "Embed result is empty"', async t => {
    const helper = new EmbeddingHelper(makeEnv(fakeModel()));
    await t.throwsAsync(() => helper.embed(''), { message: 'Embed result is empty' });
});

// ── C-30 (AUTOR) — luka §F.3 EH-08 ───────────────────────────────────────────

test('C-30: cosineSimilarity — różna długość / null / wektor zerowy -> 0; identyczne -> 1', t => {
    const helper = new EmbeddingHelper(null);
    t.is(helper.cosineSimilarity(null, [1, 2, 3]), 0);
    t.is(helper.cosineSimilarity([1, 2, 3], undefined), 0);
    t.is(helper.cosineSimilarity([1, 2], [1, 2, 3]), 0, 'różna długość -> 0');
    t.is(helper.cosineSimilarity([0, 0, 0], [1, 2, 3]), 0, 'wektor zerowy -> 0 (dzielenie przez zero)');
    t.is(helper.cosineSimilarity([1, 2, 3], [1, 2, 3]), 1, 'identyczne wektory -> cos=1');
});
