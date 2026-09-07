import test from 'ava';
import { truncatePreview } from './textPreview.js';

// AUD-code-review-099: test równoważności — helper musi dawać dokładnie ten sam wynik co stary,
// dwukrotnie skopiowany inline wyraz `text.length > 500 ? text.slice(0, 500) + '...' : text`
// (InlineCommentModal.ts + SendToAgentModal.ts).
function legacyInline(text: string): string {
    return text.length > 500 ? text.slice(0, 500) + '...' : text;
}

test('truncatePreview: tekst krótszy niż limit wraca bez zmian', t => {
    t.is(truncatePreview('krótki tekst'), 'krótki tekst');
});

test('truncatePreview: tekst dokładnie na granicy (500 znaków) wraca bez zmian', t => {
    const exact = 'a'.repeat(500);
    t.is(truncatePreview(exact), exact);
    t.is(truncatePreview(exact), legacyInline(exact));
});

test('truncatePreview: tekst dłuższy niż limit jest obcinany z wielokropkiem', t => {
    const long = 'a'.repeat(600);
    const result = truncatePreview(long);
    t.is(result, 'a'.repeat(500) + '...');
    t.is(result, legacyInline(long));
});

test('truncatePreview: pusty string wraca bez zmian', t => {
    t.is(truncatePreview(''), '');
});

test('truncatePreview: domyślny limit (500) jest zgodny ze starym inline wyrażeniem na próbce długości', t => {
    for (const len of [0, 1, 250, 499, 500, 501, 750, 5000]) {
        const sample = 'x'.repeat(len);
        t.is(truncatePreview(sample), legacyInline(sample), `rozjazd dla długości ${len}`);
    }
});

test('truncatePreview: opcjonalny maxLength działa niezależnie od domyślnych 500', t => {
    t.is(truncatePreview('abcdef', 3), 'abc...');
    t.is(truncatePreview('abc', 3), 'abc');
});
