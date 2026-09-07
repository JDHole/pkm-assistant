export default {
    name: 'multimodal',
    version: 'plugin',
    description: 'Generowanie obrazów (platformy chmurowe) + dodawanie tekstu na obrazy.',
    icon: 'image',
    tools: ['generate_image', 'add_text_to_image'],
    requires_permission: [],
    timeout_ms: 180000,
    source: 'built-in',
    removable: false
};
