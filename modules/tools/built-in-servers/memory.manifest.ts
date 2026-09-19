export default {
    name: 'memory',
    version: 'plugin',
    // Opis dla UI: resolveServerDescription('memory') → t('mcp.server.memory.desc') (index.ts).
    icon: 'brain-circuit',
    tools: [
        'memory_save', 'memory_delete'
    ],
    requires_permission: ['memory'],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
