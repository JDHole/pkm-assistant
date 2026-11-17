/** Preserve the delegation tests' focus on task content; timestamp behavior is tested in sub-agents. */
export function withoutTaskTime<T>(messages: T[]): T[] {
    return messages.map(message => {
        if (!message || typeof message !== 'object' || !('content' in message) || typeof message.content !== 'string') return message;
        const content = message.content.startsWith('FRAME METHOD\n\n')
            ? 'FRAME METHOD'
            : message.content.replace(/^\[czas wiadomości: [^\n]+\]\n/, '');
        return { ...message, content };
    });
}
