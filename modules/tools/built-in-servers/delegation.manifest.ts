export default {
    name: 'delegation',
    version: 'plugin',
    // Poczta między agentami ma własny serwer `komunikator` — `agent_message` się tu nie pojawia.
    // Opis dla UI: resolveServerDescription('delegation') → t('mcp.server.delegation.desc') (index.ts).
    icon: 'users',
    tools: [
        'delegate', 'agent_delegate'
    ],
    requires_permission: [],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
