import test from 'ava';
import { BackstageRegistryClass } from './BackstageRegistry.js';

test('BackstageRegistry sorts tabs by order', t => {
    const registry = new BackstageRegistryClass();
    registry.register({ id: 'tools', order: 30, render() {} });
    registry.register({ id: 'skills', order: 10, render() {} });
    registry.register({ id: 'sub-agents', order: 20, render() {} });

    t.deepEqual(registry.getTabs().map(tab => tab.id), ['skills', 'sub-agents', 'tools']);
});
