export default {
    name: 'vault',
    version: 'plugin',
    description: 'Vault file operations + unified search (keyword/semantic hybrid via RRF, where filters).',
    icon: 'folder',
    tools: [
        'read', 'write', 'list',
        'delete', 'create_folder', 'search'
    ],
    requires_permission: ['read_notes'],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
