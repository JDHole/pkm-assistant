/**
 * deleteOutcome - guardrail przeciw modalowi, który pokazuje „Usunięto: X" także wtedy, gdy
 * `deleteSubAgent` zwróciło `false` (wyjątek adaptera → `catch` → `return false`),
 * a sub zostaje w cache i na liście.
 */
import test from 'ava';
import { resolveDeleteOutcome, templateCopyNames, templateDeleteConfirmation } from './deleteOutcome.js';
import { t as translate } from '../../core/i18n/index.js';

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

test('potwierdzenie kasowania wymienia rozpoznane kopie i obsługuje brak nazw', t => {
    const copies = templateCopyNames('Zwiadowca', [
        { name: 'klara-zwiadowca', from_template: 'Zwiadowca v2' },
        { name: 'ola-zwiadowca', from_template: 'Zwiadowca v1' },
        { name: 'inna-kopia', from_template: 'Inny szablon v1' },
    ]);
    const withCopies = templateDeleteConfirmation('Zwiadowca', copies, 'Brak kopii');
    const withoutCopies = templateDeleteConfirmation('Brak', templateCopyNames('Brak', []), 'Brak kopii');

    t.deepEqual(copies, ['klara-zwiadowca', 'ola-zwiadowca']);
    t.true(withCopies.copies.includes('klara-zwiadowca'));
    t.true(withCopies.copies.includes('ola-zwiadowca'));
    t.is(withoutCopies.copies, 'Brak kopii');
    t.is(withCopies.messageKey, 'backstage.confirm_delete_sub_template');
    for (const locale of ['pl', 'en']) {
        const message = translate(withCopies.messageKey, withCopies, locale);
        t.true(message.includes('klara-zwiadowca'));
        t.true(message.includes('ola-zwiadowca'));
        t.false(message.includes('{{copies}}'));
        const withoutMessage = translate(withoutCopies.messageKey, withoutCopies, locale);
        t.true(withoutMessage.includes('Brak kopii'));
        t.false(withoutMessage.includes('{{copies}}'));
    }
});

test('dopasowanie from_template nie miesza podobnych nazw szablonów', t => {
    const copies = templateCopyNames('Raport', [
        { name: 'wlasciwy', from_template: 'Raport v2' },
        { name: 'cudzy', from_template: 'Raport v2 v1' },
        { name: 'bledny', from_template: 'Raport v2 extra' },
    ]);
    t.deepEqual(copies, ['wlasciwy']);
    t.deepEqual(templateCopyNames('Raport (PL)', [
        { name: 'specjalny', from_template: 'Raport (PL) v3' },
        { name: 'cudzy', from_template: 'Raport PL v3' },
    ]), ['specjalny']);
});

test('wspólne potwierdzenie usuwania skilla nie ma brakującego placeholdera', t => {
    for (const locale of ['pl', 'en']) {
        const message = translate('backstage.confirm_delete_template', { name: 'Raport' }, locale);
        t.true(message.includes('Raport'));
        t.false(message.includes('{{copies}}'));
    }
});
