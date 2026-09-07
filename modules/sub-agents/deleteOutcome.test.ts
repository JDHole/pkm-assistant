/**
 * deleteOutcome - AUD-bledy-012. Modal pokazywał „Usunięto: X" także wtedy, gdy
 * `deleteSubAgent` zwróciło `false` (wyjątek adaptera → `catch` → `return false`),
 * a sub zostawał w cache i na liście.
 */
import test from 'ava';
import { resolveDeleteOutcome } from './deleteOutcome.js';
import { pl } from '../../core/i18n/pl.js';

test('kasowanie potwierdzone (true) - komunikat o usunięciu', t => {
    const out = resolveDeleteOutcome(true, 'jaskier-prep');

    t.true(out.ok);
    t.is(out.messageKey, 'modal.sub_agent.deleted');
    t.deepEqual(out.params, { name: 'jaskier-prep' });
});

test('kasowanie NIEudane (false) - komunikat o porażce, nie „Usunięto"', t => {
    const out = resolveDeleteOutcome(false, 'jaskier-prep');

    t.false(out.ok);
    t.is(out.messageKey, 'modal.sub_agent.delete_failed');
    t.not(out.messageKey, 'modal.sub_agent.deleted');
});

test('brak potwierdzenia (undefined z opcjonalnego łańcucha) też jest porażką', t => {
    t.false(resolveDeleteOutcome(undefined, 'x').ok);
    t.false(resolveDeleteOutcome(null, 'x').ok);
    t.false(resolveDeleteOutcome('true', 'x').ok, 'tylko boolean true liczy się jako potwierdzenie');
});

test('oba klucze komunikatów istnieją w słowniku i niosą {{name}}', t => {
    for (const deleted of [true, false]) {
        const out = resolveDeleteOutcome(deleted, 'jaskier-prep');
        const wzor = (pl as Record<string, string>)[out.messageKey];
        t.truthy(wzor, `brak klucza ${out.messageKey} w pl.ts`);
        t.true(wzor.includes('{{name}}'), `${out.messageKey} nie pokazuje nazwy`);
    }
});
