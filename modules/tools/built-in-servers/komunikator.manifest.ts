export default {
    name: 'komunikator',
    version: 'plugin',
    // Prosta poczta: skrzynka plik-per-wiadomość.
    // Opis dla UI: resolveServerDescription('komunikator') → t('mcp.server.komunikator.desc') (index.ts).
    icon: 'messages-square',
    tools: ['kom_send', 'kom_list', 'kom_read'],
    requires_permission: ['mcp'],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
