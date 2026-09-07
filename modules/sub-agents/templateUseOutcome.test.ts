/**
 * templateUseOutcome - AUD-bledy-014. „Użyj u agenta" wołało `useTemplateAtAgent` bez
 * `try/catch`, a kafel odpalał ten async handler bez `.catch`: awaria zapisu kończyła się
 * ciszą i półstanem (kopia suba na dysku, agent bez przypisania).
 *
 * Test czystej decyzji - zero DOM, zero obsidian.
 */
import test from 'ava';
import { guardTemplateUse, templateUseErrorText } from './templateUseOutcome.js';
import { pl } from '../../core/i18n/pl.js';

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

test('klucz komunikatu istnieje w słowniku i niesie {{error}}', t => {
    const wzor = (pl as Record<string, string>)['backstage.template_use_failed'];

    t.truthy(wzor, 'brak klucza backstage.template_use_failed w pl.ts');
    t.true(wzor.includes('{{error}}'), 'komunikat nie pokazuje powodu');
});
