export default {
    name: 'delegation',
    version: 'plugin',
    // S28 (D3): `agent_message` OUT — poczta między agentami ma własny serwer `komunikator`.
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
