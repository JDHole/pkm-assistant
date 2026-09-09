export default {
    name: 'komunikator',
    version: 'plugin',
    // Prosta poczta: skrzynka plik-per-wiadomość.
    description: 'Komunikator: prosta poczta między agentami (wyślij / lista / przeczytaj).',
    icon: 'messages-square',
    tools: ['kom_send', 'kom_list', 'kom_read'],
    requires_permission: ['mcp'],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
