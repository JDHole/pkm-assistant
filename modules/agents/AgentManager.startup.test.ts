import test from 'ava';
import { register } from 'node:module';
import { defaultSettings } from '../../config/defaultSettings.js';
import { PluginRuntime } from '../../core/runtime/PluginRuntime.js';
import { SETTINGS_PATH } from '../../core/runtime/contracts.js';
import type { PluginHost, RuntimeConfig } from '../../core/runtime/contracts.js';
import { setLocale } from '../../core/i18n/index.js';
import {
    PLAN_TYPE_CONTENT, NOTATKA_TYPE_CONTENT, RAPORT_TYPE_CONTENT,
    PLAN_TYPE_CONTENT_EN, NOTATKA_TYPE_CONTENT_EN, RAPORT_TYPE_CONTENT_EN,
} from '../artifacts/ArtifactTypeLoader.js';

const TYPES = '.pkm-assistant/artifacts/types';

// Like src/main.mobile.test.ts: replace browser assets, keep actual startup code.
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    return next(url, context);
}`));
const { AgentManager } = await import('./AgentManager.js');

test.serial('fresh device, unrelated settings save and restart preserve shared types; explicit en translates them', async t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));
    const files = new Map<string, string>([
        [`${TYPES}/plan.md`, PLAN_TYPE_CONTENT],
        [`${TYPES}/notatka.md`, NOTATKA_TYPE_CONTENT],
        [`${TYPES}/raport.md`, RAPORT_TYPE_CONTENT],
    ]);
    const folders = new Set<string>();
    const writes: string[] = [];
    const adapter = {
        async exists(path: string) {
            return files.has(path) || folders.has(path) || [...files.keys()].some(p => p.startsWith(path + '/'));
        },
        async read(path: string) {
            const value = files.get(path);
            if (value === undefined) throw new Error('ENOENT ' + path);
            return value;
        },
        async write(path: string, value: string) { writes.push(path); files.set(path, value); },
        async mkdir(path: string) { folders.add(path); },
        async list(path: string) {
            const prefix = path + '/';
            return {
                files: [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')),
                folders: [...folders].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')),
            };
        },
        async remove(path: string) { files.delete(path); },
        async rmdir(path: string) { folders.delete(path); },
    };
    const vault = { adapter };
    const loadRuntime = async () => {
        // Exercise the real load/merge and save path, without booting UI/services.
        const runtime = new PluginRuntime({ app: { vault } } as unknown as PluginHost,
            { defaults: defaultSettings() } as RuntimeConfig);
        runtime.settingsStore.settings = await runtime.loadSettings();
        t.teardown(() => runtime.dispose());
        return runtime;
    };
    const initialize = async (runtime: PluginRuntime) => {
        const manager = new AgentManager(vault, runtime.settings);
        t.teardown(() => manager.dispose());
        await manager.initialize();
        t.is(manager.getAgent('Jaskier')?.name, 'Jaskier');
        t.is(manager.artifactTypeLoader.getAllTypes().length, 3);
        return manager;
    };
    const first = await loadRuntime();
    await initialize(first);
    t.is(files.get(`${TYPES}/plan.md`), PLAN_TYPE_CONTENT);
    t.is(files.get(`${TYPES}/notatka.md`), NOTATKA_TYPE_CONTENT);
    t.is(files.get(`${TYPES}/raport.md`), RAPORT_TYPE_CONTENT);
    t.deepEqual(writes.filter(p => p.startsWith(TYPES)), []);

    first.settings.pkmAssistant!.chat!.apiKeys!.openai = 'test-device-key';
    await first.settingsStore.save();
    const second = await loadRuntime();
    writes.length = 0;
    await initialize(second);
    t.is(second.settings.pkmAssistant?.chat?.apiKeys?.openai, 'test-device-key');
    t.false(Object.hasOwn(second.settings.pkmAssistant!, 'language'));
    t.is(files.get(`${TYPES}/plan.md`), PLAN_TYPE_CONTENT);
    t.is(files.get(`${TYPES}/notatka.md`), NOTATKA_TYPE_CONTENT);
    t.is(files.get(`${TYPES}/raport.md`), RAPORT_TYPE_CONTENT);
    t.is(writes.length, 0, 'complete existing vault has no bootstrap writes');

    second.settings.pkmAssistant!.language = 'en';
    await second.settingsStore.save();
    t.true(files.get(SETTINGS_PATH)!.includes('"language": "en"'));
    const third = await loadRuntime();
    writes.length = 0;
    await initialize(third);
    t.is(files.get(`${TYPES}/plan.md`), PLAN_TYPE_CONTENT_EN);
    t.is(files.get(`${TYPES}/notatka.md`), NOTATKA_TYPE_CONTENT_EN);
    t.is(files.get(`${TYPES}/raport.md`), RAPORT_TYPE_CONTENT_EN);
    t.deepEqual(writes, [`${TYPES}/plan.md`, `${TYPES}/notatka.md`, `${TYPES}/raport.md`]);
});
