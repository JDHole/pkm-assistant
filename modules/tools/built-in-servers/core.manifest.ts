export default {
    name: 'core',
    version: 'plugin',
    // Opis dla UI: resolveServerDescription('core') → t('mcp.server.core.desc') (index.ts).
    icon: 'circle-dot',
    tools: ['ask_user'],
    requires_permission: [],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
