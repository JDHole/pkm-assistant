import test from 'ava';
import { Notice, Setting } from 'obsidian';
import { renderModelsSection } from './SettingsContent.js';
import type { ModelsSectionCtx } from './SettingsContent.js';
import { getLocale, setLocale } from '../../core/i18n/index.js';

test.serial('device model toggle saves both choices and clears the runtime model', async t => {
    const locale = getLocale(); setLocale('en'); t.teardown(() => setLocale(locale));
    let change: ((value: boolean) => unknown) | undefined;
    let initial: boolean | undefined;
    let title = '';
    class TestSetting extends Setting {
        // The stock harness slider lacks setLimits; this fixture exercises only the toggle.
        override addSlider() { return this; }
        override setName(value: string) { title = value; return this; }
        override addToggle(callback: Parameters<Setting['addToggle']>[0]) {
            if (title !== 'Use this device’s models') return this;
            const toggle = {
                setValue(value: boolean) { initial = value; return toggle; },
                onChange(handler: (value: boolean) => unknown) { change = handler; return toggle; },
            };
            callback(toggle as never);
            return this;
        }
    }
    const saved: string[] = [];
    const pkm = { useDeviceModels: false, modelLibrary: { main: [], minion: [] } };
    const env = { settings: { pkmAssistant: pkm }, chatModel: { modelId: 'old-agent-model' } as unknown };
    const ctx = { pkm, env, chat: {}, availablePlatforms: [], Setting: TestSetting, Notice,
        icons: { robot: () => '', thermometer: () => '' },
        owner: { _getEmbedModelKey: () => undefined },
        save: () => { saved.push(JSON.stringify({ useDeviceModels: pkm.useDeviceModels })); },
    } as unknown as ModelsSectionCtx;
    await renderModelsSection(createDiv(), ctx);
    t.is(initial, false);
    t.is(typeof change, 'function');
    await change!(true);
    t.is(pkm.useDeviceModels, true);
    t.is(env.chatModel, null);
    await change!(false);
    t.deepEqual(saved, ['{"useDeviceModels":true}', '{"useDeviceModels":false}']);
});
