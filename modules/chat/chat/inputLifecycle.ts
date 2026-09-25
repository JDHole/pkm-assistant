import type { MentionAutocomplete } from '../../ui-components/index.js';

export function replaceMentionAutocomplete<T extends Pick<MentionAutocomplete, 'destroy'>>(
    host: { mentionAutocomplete: T | null },
    create: () => T,
): void {
    host.mentionAutocomplete?.destroy();
    host.mentionAutocomplete = create();
}
