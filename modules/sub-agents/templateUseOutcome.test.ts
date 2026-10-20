/**
 * templateUseOutcome - guardrail przeciw handlerowi „Użyj u agenta", który woła
 * `useTemplateAtAgent` bez `try/catch`, gdzie kafel odpala ten async handler bez `.catch`:
 * awaria zapisu kończy się ciszą i półstanem (kopia suba na dysku, agent bez przypisania).
 *
 * Test czystej decyzji - zero DOM, zero obsidian.
 */
import test from 'ava';
import { guardTemplateUse, templateUseErrorText, useTemplateWithCompensation } from './templateUseOutcome.js';

test('operacja doszła do końca - brak komunikatu porażki', async t => {
    const out = await guardTemplateUse(async () => 'ok');

    t.true(out.ok);
    t.is(out.messageKey, null);
    t.is(out.error, null);
});

test('rzut z operacji - komunikat porażki zamiast ciszy', async t => {
    const boom = new Error('EACCES: mkdir .pkm-assistant/sub-agents/tola-prep');
    const out = await guardTemplateUse(async () => { throw boom; });

    t.false(out.ok);
    t.is(out.messageKey, 'backstage.template_use_failed');
    t.is(out.params.error, 'EACCES: mkdir .pkm-assistant/sub-agents/tola-prep');
    t.is(out.error, boom, 'surowy rzut zostaje do log.error');
});

test('rzut bez `message` (string, obiekt, null) też daje zdanie', async t => {
    t.is(templateUseErrorText('ENOSPC'), 'ENOSPC');
    t.is(templateUseErrorText({ code: 500 }), 'unknown error');
    t.is(templateUseErrorText(null), 'unknown error');
    t.is(templateUseErrorText({ message: '   ' }), 'unknown error', 'pusty message to nie jest zdanie');
});

test('błąd przypisania usuwa kopię pod nazwą zwróconą przez instantiate', async t => {
    const deleted: string[] = [];
    const out = await useTemplateWithCompensation({
        instantiate: async () => ({ success: true, name: 'klara-zwiadowca-2' }),
        assign: async () => { throw new Error('save failed'); },
        deleteSubAgent: async name => { deleted.push(name); return true; },
    });

    t.deepEqual(deleted, ['klara-zwiadowca-2']);
    t.false(out.ok);
    t.is(out.messageKey, 'backstage.template_use_failed');
    t.is(out.params.error, 'save failed');
});

test('nieudane sprzątanie jest udostępnione do logowania, a błąd przypisania zostaje', async t => {
    const boom = new Error('save failed');
    const out = await useTemplateWithCompensation({
        instantiate: async () => ({ success: true, name: 'klara-zwiadowca' }),
        assign: async () => { throw boom; },
        deleteSubAgent: async () => false,
    });

    t.is(out.messageKey, 'backstage.template_use_failed');
    t.is(out.error, boom);
    t.is(out.cleanupError, 'delete_failed');
});

test('rzut sprzątania jest udostępniony do logowania', async t => {
    const cleanupBoom = new Error('delete failed');
    const out = await useTemplateWithCompensation({
        instantiate: async () => ({ success: true, name: 'klara-zwiadowca' }),
        assign: async () => { throw new Error('save failed'); },
        deleteSubAgent: async () => { throw cleanupBoom; },
    });

    t.is(out.cleanupError, cleanupBoom);
});
