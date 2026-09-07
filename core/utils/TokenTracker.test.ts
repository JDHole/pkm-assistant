import test from 'ava';
import { TokenTracker } from './TokenTracker.js';

test('record + getSessionTotal sumuje per rola', t => {
    const tt = new TokenTracker();
    tt.record('main', 100, 40);
    tt.record('minion', 10, 5);

    const total = tt.getSessionTotal();
    t.is(total.input, 110);
    t.is(total.output, 45);
    t.is(total.total, 155);
    t.is(total.byRole.main.input, 100);
    t.is(total.byRole.minion.output, 5);
});

test('backward-compat: record bez meta działa (estimated=false)', t => {
    const tt = new TokenTracker();
    tt.record('main', 50, 20); // stary 3-arg call

    t.false(tt.hasEstimates('main'));
    t.false(tt.getBreakdown()[0].estimated);
});

test('meta.estimated=true ustawia flagę per rola (hasEstimates)', t => {
    const tt = new TokenTracker();
    tt.record('minion', 30, 10, { estimated: true });

    t.true(tt.hasEstimates('minion'));
    t.false(tt.hasEstimates('main'));
    t.false(tt.hasEstimates('other'));
    t.true(tt.getBreakdown()[0].estimated);
});

// AUD-dead-code-119 (fabryka kasacji S1, 2026-09-02): rola tu jest dowolna, dołożona
// w runtime — dawniej użyta 'master' sugerowała, że to jeden z kubełków startowych (już nie
// jest, patrz test niżej „zostaje 2 kubełki startowe").
test('flaga estimated jest „sticky" per rola — jeden estymowany wpis wystarczy', t => {
    const tt = new TokenTracker();
    tt.record('other', 100, 50);                       // realne
    tt.record('other', 20, 5, { estimated: true });    // fallback
    tt.record('other', 200, 80);                       // realne

    t.true(tt.hasEstimates('other'), 'jeden estymowany wpis zostawia flagę');
});

test('meta.estimated=false NIE ustawia flagi', t => {
    const tt = new TokenTracker();
    tt.record('minion', 10, 5, { estimated: false });
    t.false(tt.hasEstimates('minion'));
});

test('clear() resetuje totals, wpisy i flagi estimated', t => {
    const tt = new TokenTracker();
    tt.record('minion', 30, 10, { estimated: true });
    tt.clear();

    t.is(tt.getSessionTotal().total, 0);
    t.is(tt.getBreakdown().length, 0);
    t.false(tt.hasEstimates('minion'));
});

test('rola nieznana z góry zakłada własny kubełek (nie ginie w agregacie)', t => {
    const tt = new TokenTracker();
    t.notThrows(() => tt.record('nieznana', 10, 5, { estimated: true }));

    const total = tt.getSessionTotal();
    t.is(total.byRole.nieznana.input, 10);
    t.is(total.byRole.nieznana.output, 5);
    t.is(total.total, 15, 'wpis wchodzi do sumy sesji');
    t.true(tt.hasEstimates('nieznana'));
    t.false(tt.hasEstimates('main'), 'flaga nie rozlewa się na inne role');
});

// Z6 (D10): sub-agenci raportują role `researcher` — wcześniej `if (this.totals[role])`
// wycinało ją cicho i zakładka „Sub-agent" w Token Viewerze pokazywała wieczne 0.
test('rola researcher sumuje się przez wiele wpisów', t => {
    const tt = new TokenTracker();
    tt.record('researcher', 100, 40);
    tt.record('researcher', 25, 10);
    tt.record('main', 5, 5);

    const total = tt.getSessionTotal();
    t.is(total.byRole.researcher.input, 125);
    t.is(total.byRole.researcher.output, 50);
    t.is(total.byRole.main.input, 5);
    t.is(total.total, 185);
});

test('flaga estimated działa dla roli researcher', t => {
    const tt = new TokenTracker();
    tt.record('researcher', 30, 10, { estimated: true });
    tt.record('researcher', 60, 20);

    t.true(tt.hasEstimates('researcher'));
    t.is(tt.getSessionTotal().byRole.researcher.input, 90);
});

// AUD-dead-code-119 (fabryka kasacji S1, 2026-09-02): kubełek startowy 'master' skasowany —
// zostają 2 (main, minion), nie 3.
test('clear() usuwa role dołożone w runtime, zostawia 2 kubełki startowe', t => {
    const tt = new TokenTracker();
    tt.record('researcher', 30, 10, { estimated: true });
    tt.clear();

    const byRole = tt.getSessionTotal().byRole;
    t.deepEqual(Object.keys(byRole).sort(), ['main', 'minion']);
    t.false(tt.hasEstimates('researcher'));
});
