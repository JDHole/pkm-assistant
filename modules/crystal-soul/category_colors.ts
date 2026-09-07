// Category -> hex color mapping from the Crystal Soul gemstone palette.
export const CATEGORY_COLORS = {
    productivity: '#B09548',
    writing: '#4A6FA5',
    organization: '#3A8B6E',
    analysis: '#7B5EA7',
    system: '#6B7B8A',
    creative: '#9E708A',
    general: '#8A7E72',
    vault: '#3D8B8A',
    memory: '#8E7BAE',
    communication: '#A87450',
    planning: '#3B8EA0',
    search: '#4878C8',
    mixed: '#5A6575',
};

export function getCategoryColor(category: string): string {
    return (CATEGORY_COLORS as Record<string, string>)[category] || CATEGORY_COLORS.general;
}

export function deriveDelegateCategory(toolsList: string[] | null | undefined): string {
    if (!toolsList || toolsList.length === 0) return 'mixed';
    const groupScores = {
        // E2.6 prymitywy (read/list/write/delete/create_folder) + legacy vault_* dla starych YAML.
        vault: ['read', 'list', 'write', 'delete', 'create_folder', 'vault_read', 'vault_list', 'vault_write', 'vault_delete', 'vault_search'],
        memory: ['memory_save', 'memory_delete'],
        search: ['search', 'vault_search', 'memory_sessions', 'web_search'],
        // S28: `agent_message` skasowany, ale zostaje w liście — stare YAML-e subów mogą go
        // jeszcze nieść i kategoria ma się wtedy policzyć tak jak dotąd.
        communication: ['kom_send', 'kom_list', 'kom_read', 'agent_message', 'agent_delegate', 'ask_user'],
        planning: ['todo', 'artifact_create', 'artifact_read', 'artifact_update', 'artifact_list'],
    };
    let best = 'mixed';
    let bestCount = 0;
    for (const [cat, catTools] of Object.entries(groupScores)) {
        const count = toolsList.filter((t: string) => catTools.includes(t)).length;
        if (count > bestCount) {
            best = cat;
            bestCount = count;
        }
    }
    return best;
}
