export default {
    name: 'vault',
    version: 'plugin',
    // Opis dla UI: resolveServerDescription('vault') → t('mcp.server.vault.desc') (index.ts).
    icon: 'folder',
    tools: [
        'read', 'view_image', 'check_syntax', 'write', 'list',
        'delete', 'create_folder', 'search'
    ],
    requires_permission: ['read_notes'],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
