export default {
    name: 'core',
    version: 'plugin',
    description: 'Always-available agent essentials (asking user).',
    icon: 'circle-dot',
    tools: ['ask_user'],
    requires_permission: [],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
