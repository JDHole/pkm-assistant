export default {
    name: 'web',
    version: 'plugin',
    description: 'Web search (Google/Brave/Bing) + page reader. Wymaga klucza API providera.',
    icon: 'globe',
    tools: ['web_search', 'web_read'],
    requires_permission: ['web_search'],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
