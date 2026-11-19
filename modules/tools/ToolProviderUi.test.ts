import test from 'ava';
import { Platform } from 'obsidian';
import { ToolRegistry } from './ToolRegistry.js';
import { ToolProviderRegistry } from './ToolProviderRegistry.js';
import { renderMcpServersSection } from './SettingsContent.js';
import { renderSkillsTab } from '../agents/profile/profile_skills.js';
import { MCPServerEditorModal } from '../shell/MCPServerEditorModal.js';
import { setLocale } from '../../core/i18n/index.js';

function nodes(root: HTMLElement): HTMLElement[] {
    return [root, ...Array.from(root.children).flatMap(child => nodes(child as HTMLElement))];
}
function withEvents(el: HTMLElement) {
    const target = new EventTarget();
    el.addEventListener = target.addEventListener.bind(target);
    el.dispatchEvent = target.dispatchEvent.bind(target);
    const div = el.createDiv.bind(el), create = el.createEl.bind(el);
    el.createDiv = options => { const child = div(options); withEvents(child); return child; };
    el.createEl = ((tag, options) => { const child = create(tag, options); withEvents(child); return child; }) as typeof el.createEl;
}
for (const locale of ['en', 'pl']) test.serial(`provider settings and agent opt-in on mobile (${locale})`, t => {
    setLocale(locale); Platform.isMobile = true;
    t.teardown(() => { setLocale('en'); Platform.isMobile = false; });
    const registry = new ToolRegistry();
    const providers = new ToolProviderRegistry(registry, () => [], true);
    const handle = providers.registerToolProvider({ id: 'local', name: 'Local plugin', tools: [{ name: 'read', description: 'Read locally', inputSchema: { type: 'object' }, execute: async () => 'local' }] });
    const plugin = { toolProviders: providers, toolRegistry: registry, agentManager: {},
        externalMcpManager: { listServersForUi: () => [{ id: 'local', name: 'Conflicting remote', transport: 'http' }] },
    };
    const container = createDiv();
    renderMcpServersSection(container, { plugin, pkm: {}, save: async () => {}, owner: { app: {}, render() {} } } as never);
    const row = nodes(container).find(node => node.className.includes('mcp-provider-row'))!;
    const texts = nodes(row).map(node => node.textContent);
    t.true(texts.includes('Local plugin'));
    t.true(texts.includes(locale === 'en' ? 'From another plugin · ID: local · Tools: 1' : 'Z innej wtyczki · ID: local · Narzędzia: 1'));
    t.deepEqual(nodes(row).filter(node => ['BUTTON', 'INPUT'].includes(node.tagName)), []);
    const formData = { mcp_servers: [] as string[], preferred_servers: [] as string[] };
    const profile = createDiv(); withEvents(profile);
    let renders = 0;
    renderSkillsTab({ plugin, formData, renderActiveTab: () => { renders++; } } as never, profile);
    t.false(nodes(profile).some(node => node.textContent?.includes('Conflicting remote')));
    t.is(nodes(profile).filter(node => node.className.includes('cs-shard--plugin-provider')).length, 1);
    const toggle = nodes(profile).find(node => node.className.split(' ').includes('cs-toggle'))!;
    t.deepEqual(registry.filterByAgent(formData), []);
    toggle.dispatchEvent(new Event('click'));
    t.deepEqual(formData, { mcp_servers: ['local'], preferred_servers: ['local'] });
    t.deepEqual(registry.filterByAgent(formData).map(tool => tool.name), ['local__read']);
    toggle.dispatchEvent(new Event('click'));
    t.deepEqual(formData, { mcp_servers: [], preferred_servers: [] });
    t.is(renders, 2);
    handle.setTools([]);
    const empty = createDiv();
    renderMcpServersSection(empty, { plugin, pkm: {}, save: async () => {}, owner: { app: {}, render() {} } } as never);
    t.true(nodes(empty).some(node => node.textContent?.includes(locale === 'en' ? 'Tools: 0' : 'Narzędzia: 0')));
});

test('server editor refuses a provider ID before saving MCP settings', async t => {
    const providers = new ToolProviderRegistry(new ToolRegistry(), () => [], false);
    providers.registerToolProvider({ id: 'local', name: 'Local', tools: [] });
    const servers: unknown[] = []; let saves = 0;
    const editor = (id: string) => new MCPServerEditorModal({} as never, { toolProviders: providers,
        env: { settings: { pkmAssistant: { externalMcpServers: servers } } } } as never,
        { save: async () => { saves++; }, existingServer: { id, name: 'Remote', transport: 'http', url: 'https://example.test/mcp' } });
    await editor('local')._handleSave();
    t.is(saves, 0); t.deepEqual(servers, []);
    await editor('remote')._handleSave();
    t.is(saves, 1); t.like(servers[0], { id: 'remote', name: 'Remote' });
});
