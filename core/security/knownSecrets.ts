/** Configured chat API keys shared by delegation presentation and handoff. */
export function configuredChatSecrets(chat: { apiKeys?: Record<string, unknown> } | undefined): string[] {
    return Object.values(chat?.apiKeys || {})
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .sort((a, b) => b.length - a.length);
}
