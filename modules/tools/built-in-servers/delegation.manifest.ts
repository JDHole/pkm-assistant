export default {
    name: 'delegation',
    version: 'plugin',
    // Poczta między agentami ma własny serwer `komunikator` — `agent_message` się tu nie pojawia.
    description: 'Delegacja do sub-agentów + przekazanie rozmowy innemu agentowi.',
    icon: 'users',
    tools: [
        'delegate', 'agent_delegate'
    ],
    requires_permission: [],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
