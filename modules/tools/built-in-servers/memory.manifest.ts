export default {
    name: 'memory',
    version: 'plugin',
    description: 'Hierarchical agent memory (brain + sessions + summaries L1/L2/L3). Read/list/search memory via read/list/search (scope=memory).',
    icon: 'brain-circuit',
    tools: [
        'memory_save', 'memory_delete'
    ],
    requires_permission: ['memory'],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
