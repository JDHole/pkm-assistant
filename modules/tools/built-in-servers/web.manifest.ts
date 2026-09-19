export default {
    name: 'web',
    version: 'plugin',
    // Opis dla UI: resolveServerDescription('web') → t('mcp.server.web.desc') (index.ts).
    icon: 'globe',
    tools: ['web_search', 'web_read'],
    requires_permission: ['web_search'],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
