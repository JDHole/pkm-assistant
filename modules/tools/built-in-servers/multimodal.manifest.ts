export default {
    name: 'multimodal',
    version: 'plugin',
    // Opis dla UI: resolveServerDescription('multimodal') → t('mcp.server.multimodal.desc') (index.ts).
    icon: 'image',
    tools: ['generate_image', 'add_text_to_image'],
    requires_permission: [],
    timeout_ms: 180000,
    source: 'built-in',
    removable: false
};
