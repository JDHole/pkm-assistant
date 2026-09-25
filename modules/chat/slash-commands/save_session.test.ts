import test from 'ava';
import { setLocale } from '../../../core/i18n/index.js';
import { describeAnalysisFailure } from './save_session.js';

setLocale('pl');
test('opisuje przerwanie analizy zrozumiałym komunikatem', t => {
    const message = describeAnalysisFailure({ name: 'AbortError', message: 'request aborted' });

    t.is(message, 'Analiza sesji została przerwana. Ponów albo anuluj.');
});

test('opisuje timeout analizy bez surowego błędu', t => {
    const message = describeAnalysisFailure(new Error('Request timed out'));

    t.is(message, 'Model nie odpowiedział na czas. Ponów analizę albo anuluj.');
});

test('rozpoznaje timeout z kodu streamu', t => {
    const error = Object.assign(new Error('Stream stalled: 60000ms without a chunk'), { code: 'stream_stalled' });
    t.is(describeAnalysisFailure(error), 'Model nie odpowiedział na czas. Ponów analizę albo anuluj.');
});

test('rozpoznaje przerwanie z kodu streamu bez podciagu abort w komunikacie', t => {
    const error = Object.assign(new Error('stream closed by caller'), { code: 'aborted' });
    t.is(describeAnalysisFailure(error), 'Analiza sesji została przerwana. Ponów albo anuluj.');
});

test('opisuje pozostałe błędy analizy ogólnym komunikatem bez ujawniania szczegółów', t => {
    const message = describeAnalysisFailure(new Error('boom'));

    t.is(message, 'Analiza sesji nie powiodła się. Szczegóły są w logu. Ponów albo anuluj.');
    t.false(message?.includes('boom'));
});
