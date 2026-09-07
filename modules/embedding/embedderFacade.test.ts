/**
 * embedderFacade.test.ts — most rejestr → `EmbedderFacade` dla `VaultIndexer` (`contracts.ts` §9).
 * Nowe testy C-23/C-24. Napisany przed implementacją (czerwony na stubie — `createEmbedderFacade`
 * rzucał `not implemented`), dziś zielony.
 */
import test from 'ava';
import { createEmbedderFacade } from './embedderFacade.js';
import { EmbedBatchError } from './embedErrors.js';
import type { EmbeddingModel } from './EmbeddingModel.js';
import type { EmbeddingRegistry } from './EmbeddingRegistry.js';

/** Rejestr atrapowy — tylko tyle, ile czyta `createEmbedderFacade` (kontrakt §9). */
function fakeRegistry(model: EmbeddingModel | null): EmbeddingRegistry {
    return {
        default: model,
        isConfigured: () => model !== null,
        select: () => { throw new Error('nieużywane w tym teście'); },
        providers: () => [],
    } as unknown as EmbeddingRegistry;
}

test('C-23: isReady()/getModelKey()/getDims() na pustym rejestrze -> false / \'\' / null, bez rzutu', t => {
    const facade = createEmbedderFacade(fakeRegistry(null));

    t.notThrows(() => facade.isReady?.());
    t.is(facade.isReady?.(), false);
    t.is(facade.getModelKey?.(), '');
    t.is(facade.getDims?.(), null);
});

test('C-24: embedBatch przepisuje vector 1:1 i propaguje RZUT nietknięty', async t => {
    const rzut = new EmbedBatchError({ kind: 'api', code: 'http_error', message: 'boom' });
    const model = {
        modelKey: 'openai:text-embedding-3-small',
        dims: 1024,
        embed: async (texts: string[]) => {
            if (texts.includes('__rzuc__')) throw rzut;
            return texts.map(t2 => ({ vector: [t2.length, 0, 0] }));
        },
    } as unknown as EmbeddingModel;

    const facade = createEmbedderFacade(fakeRegistry(model));

    const wynik = await facade.embedBatch(['a', 'bb']);
    t.deepEqual(wynik, [[1, 0, 0], [2, 0, 0]]);

    const err = await t.throwsAsync(() => facade.embedBatch(['__rzuc__']));
    t.is(err, rzut, 'rzut modelu leci dalej NIETKNIĘTY — indekser klasyfikuje po `kind`');
});

test('C-25: getDims() zwraca 0 z modelu bez podmiany na fallback (falsy liczba != brak wartości)', t => {
    const model = { modelKey: 'openai:text-embedding-3-small', dims: 0 } as unknown as EmbeddingModel;
    const facade = createEmbedderFacade(fakeRegistry(model));

    t.is(facade.getDims?.(), 0, 'dims=0 to realna wartość modelu, nie „brak" — `??` musi ją przepuścić');
});

test('C-26: embed() oddaje realny wektor modelu (nie fallback, nie undefined)', async t => {
    const model = {
        modelKey: 'openai:text-embedding-3-small',
        dims: 1024,
        embed: async (texts: string[]) => texts.map(() => ({ vector: [7, 8, 9] })),
    } as unknown as EmbeddingModel;
    const facade = createEmbedderFacade(fakeRegistry(model));

    const wynik = await facade.embed?.('tekst');
    t.deepEqual(wynik, [7, 8, 9]);
});

test('C-27: embed() oddaje null, gdy model nie zwrócił wektora (pusta treść)', async t => {
    const model = {
        modelKey: 'openai:text-embedding-3-small',
        dims: 1024,
        embed: async (texts: string[]) => texts.map(() => ({ vector: null })),
    } as unknown as EmbeddingModel;
    const facade = createEmbedderFacade(fakeRegistry(model));

    const wynik = await facade.embed?.('');
    t.is(wynik, null);
});
