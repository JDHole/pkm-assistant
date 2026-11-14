import test from 'ava';
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    return next(url, context);
}`));
const { renderProfileTab } = await import('./profile_persona.js');
import { setLocale } from '../../../core/i18n/index.js';

function descendants(el: Element): Element[] { return [el, ...Array.from(el.children).flatMap(descendants)]; }
for (const locale of ['pl', 'en']) test.serial(`D2 persona labels only foreign active sessions (${locale})`, async t => {
    setLocale(locale); t.teardown(() => setLocale('pl'));
    const el = createDiv();
    await renderProfileTab({ formData: { personality: '' }, agent: { name: 'Mira' }, plugin: {}, agentManager: {
        getAgentMemory: () => ({ listActiveSessions: async () => [
            { name: 'mira_2026-11-14_10-00.md', ownership: 'mine' },
            { name: 'mira_2026-11-14_11-00.md', ownership: 'foreign' },
            { name: 'legacy.md', ownership: 'unowned' },
        ] }),
    } } as unknown as Parameters<typeof renderProfileTab>[0], el);
    t.deepEqual(descendants(el).filter(child => child.className === 'cs-mem-item__date').map(child => child.textContent), [
        '2026-11-14  10:00', locale === 'pl' ? '2026-11-14  11:00 · na innym urządzeniu' : '2026-11-14  11:00 · on another device', 'legacy',
    ]);
});
