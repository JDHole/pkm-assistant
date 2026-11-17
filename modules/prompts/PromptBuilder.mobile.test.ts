import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { PromptBuilder } from './PromptBuilder.js';

const agent = { name: 'Ada' };
const base = { vaultName: 'Vault', currentDate: '2026-11-17' };

test.serial('mobile environment follows runtime capabilities and can be overridden or disabled', t => {
    setLocale('pl');
    const mobileEnvironment = { device: 'phone' as const, semanticUnavailable: true, connectedMcp: 0, screenshotUnavailable: true };
    const builder = new PromptBuilder().build(agent, { ...base, mobileEnvironment });
    const section = builder.getSections().find(item => item.key === 'mobile_environment');
    t.is(section?.content, 'Pracujesz w Obsidianie na telefonie.\nWyszukiwanie po znaczeniu jest niedostępne; szukaj po słowach.\nLokalne serwery MCP (stdio) są niedostępne.\nŻaden zewnętrzny serwer MCP nie jest połączony.\nZrzut ekranu jest niedostępny.\nNie obiecuj funkcji wymienionych jako niedostępne.');
    builder.applyDisabledSections(['mobile_environment']);
    t.false(builder.getPrompt().includes('Pracujesz w Obsidianie na telefonie.'));
    const overridden = new PromptBuilder().build({ ...agent, promptOverrides: { mobile_environment: 'Własny opis.' } }, { ...base, mobileEnvironment });
    t.true(overridden.getPrompt().includes('Własny opis.'));
    setLocale('en');
});

test.serial('desktop prompt is unchanged and tablet reports only unavailable capabilities', t => {
    setLocale('en');
    const original = new PromptBuilder().build(agent, base).getPrompt();
    const desktop = new PromptBuilder().build(agent, { ...base, mobileEnvironment: undefined }).getPrompt();
    t.is(desktop, original);
    const tablet = new PromptBuilder().build(agent, { ...base, mobileEnvironment: { device: 'tablet', semanticUnavailable: false, connectedMcp: 1, screenshotUnavailable: false } });
    t.is(tablet.getSections().find(item => item.key === 'mobile_environment')?.content, 'You are working in Obsidian on a tablet.\nLocal MCP servers (stdio) are unavailable.\nDo not promise features listed as unavailable.');
});
