import test from 'ava';
import { isVisionModel } from './capabilities.js';

test('isVisionModel detects known multimodal model families', t => {
  t.true(isVisionModel({ modelKey: 'gpt-4o' }));
  t.true(isVisionModel({ modelKey: 'claude-sonnet-4-20250514' }));
  t.true(isVisionModel({ modelKey: 'gemini-1.5-pro' }));
});

test('isVisionModel uses adapter metadata when model key is not obvious', t => {
  t.true(isVisionModel({
    modelKey: 'custom-vision',
    models: [{ id: 'custom-vision', multimodal: true }],
  }));
});

test('isVisionModel returns false for text-only or missing models', t => {
  t.false(isVisionModel(null));
  t.false(isVisionModel({ modelKey: 'llama3.2' }));
});

/**
 * N25 (luka L-09): gdy nazwy modelu NIE MA, ale metadane z `listModels()` są — rozstrzyga
 * metadana `ModelInfo.multimodal`, nie zgadywanie po pustym stringu (B.13 VC-02).
 */
test('L-09: pusty/undefined modelKey przy obecnych metadanych modelu', t => {
  t.false(
    isVisionModel({ modelKey: '', models: [{ id: '', multimodal: false }] }),
    'pusta nazwa + metadana false = brak vision',
  );
  t.true(
    isVisionModel({ modelKey: '', models: [{ id: '', multimodal: true }] }),
    'pusta nazwa + metadana true = vision (metadana rozstrzyga)',
  );
  t.false(
    isVisionModel({ models: [{ id: 'whatever' }] }),
    'brak nazwy i brak metadanej `multimodal` = brak vision, nie wyjątek',
  );
});

/**
 * N26 (luka L-09, B.6 BA-17): decyzja jest 3-warstwowa — dokładne dopasowanie, potem
 * rozmyte, potem regex. Nazwa z doklejonym sufiksem daty/wersji nadal jest vision.
 */
test('L-09: warstwa rozmyta i regexowa (nazwa z sufiksem daty/wersji)', t => {
  t.true(isVisionModel({ modelKey: 'claude-sonnet-4-20250514-v2' }));
  t.true(isVisionModel({ modelKey: 'llama3.2-vision' }));
  t.false(isVisionModel({ modelKey: 'llama3.2' }));
});

/**
 * F10: `inFamily` musi rozstrzygać na TAK, gdy nazwa jest DOKŁADNIE równa nazwie
 * rodziny (bez żadnego separatora po niej) — nie tylko gdy ma po sobie sufiks.
 * `gemini` nie ma dokładnego wpisu w `VISION_MODEL_IDS` ani nie pasuje do wzorca
 * `vision|vl|multimodal`, więc jedyną drogą do TAK jest równość w warstwie rodzin.
 */
test('F10: nazwa rowna dokladnie nazwie rodziny (bez sufiksu) nadal jest vision', t => {
  t.true(
    isVisionModel({ modelKey: 'gemini' }),
    'goła nazwa rodziny bez separatora/sufiksu wciąż rozstrzyga na TAK',
  );
});

/**
 * F10: `metadataFor` musi szukać wpisu, którego `id` ODPOWIADA szukanej nazwie —
 * wpis katalogu opisujący INNY model nie może rozstrzygać za niego. Katalog z
 * metadaną `unrelated-model` nie ma prawa zablokować dopasowania `gpt-4o` po
 * nazwie w warstwie 2.
 */
test('F10: metadana katalogu o INNYM id nie podszywa się pod szukaną nazwę', t => {
  t.true(
    isVisionModel({
      modelKey: 'gpt-4o',
      models: [{ id: 'unrelated-model', multimodal: false }],
    }),
    'wpis katalogu dla innego modelu nie może przesłonić dopasowania po dokładnej nazwie',
  );
});
