export default {
    name: 'artifacts',
    version: 'plugin',
    description: 'Artefakty: żywe notatki współtworzone z userem (artifact_*) + prymitywne todo agenta.',
    icon: 'clipboard-list',
    tools: [
        // E2.9 (Artefakty żywe, gatunek 1) — notatki w vaultcie z approval flow.
        'artifact_create', 'artifact_read', 'artifact_update', 'artifact_list',
        // E2.9 (gatunek 2) — prymitywne jednorazowe todo agenta (default ON, patrz toolAxis).
        'todo',
    ],
    requires_permission: [],
    timeout_ms: 60000,
    source: 'built-in',
    removable: false
};
