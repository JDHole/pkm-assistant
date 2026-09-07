import test from 'ava';
import { SettingsRegistryClass } from './SettingsRegistry.js';

test('SettingsRegistry sorts sections by order', t => {
    const registry = new SettingsRegistryClass();
    registry.register({ id: 'memory', label: 'Memory', order: 30, render() {} });
    registry.register({ id: 'models', label: 'Models', order: 20, render() {} });

    t.deepEqual(registry.getSections().map(s => s.id), ['models', 'memory']);
});

test('SettingsRegistry stores sub-fields per owner section', t => {
    const registry = new SettingsRegistryClass();
    registry.register({ id: 'agents', render() {} });
    registry.registerSubFields('agents', [
        { id: 'skills', order: 20, render() {} },
        { id: 'sub-agents', order: 10, render() {} },
    ]);

    t.deepEqual(registry.getSubFields('agents').map(f => f.id), ['sub-agents', 'skills']);
});
