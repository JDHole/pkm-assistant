import test from 'ava';
import { summarizeHttpRequest, stripUrlSecrets } from './httpLogSummary.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const PARAMS = {
    url: 'https://openrouter.ai/api/v1/models?key=' + KEY,
    method: 'post',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
    body: JSON.stringify({ model: 'gpt-4' }),
};

test('K8: podsumowanie nie zawiera wartości nagłówków ani klucza', t => {
    const line = summarizeHttpRequest(PARAMS, { status: 401, durationMs: 123 });
    t.false(line.includes(KEY), 'klucz wyciekł do linii logu');
    t.false(line.includes('Bearer'));
    t.false(line.includes('gpt-4'), 'ciało żądania nie ma czego szukać w logu');
});

test('K8: podsumowanie niesie adres bez query, metodę, status i czas', t => {
    const line = summarizeHttpRequest(PARAMS, { status: 401, durationMs: 123 });
    t.true(line.includes('POST'));
    t.true(line.includes('https://openrouter.ai/api/v1/models'));
    t.false(line.includes('?'));
    t.true(line.includes('401'));
    t.true(line.includes('123 ms'));
    // Same NAZWY nagłówków zostają — po to, żeby dało się zdiagnozować brak autoryzacji.
    t.true(line.includes('authorization'));
});

test('K8: brzegi — brak parametrów, brak url, brak nagłówków', t => {
    t.is(summarizeHttpRequest(null), 'GET <brak url>');
    t.is(summarizeHttpRequest({ url: 'https://a.pl/x', method: 'GET' }), 'GET https://a.pl/x');
    t.is(stripUrlSecrets('https://a.pl/x#frag?y'), 'https://a.pl/x');
});
