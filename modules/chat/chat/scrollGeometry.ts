/** The chat's existing streaming follow distance, also used during phone resizes. */
export function followsChatBottom(messages: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
    height = messages.clientHeight): boolean {
    return messages.scrollHeight - messages.scrollTop - height < 150;
}
