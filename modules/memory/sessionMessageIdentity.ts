// Runtime identity is deliberately outside message fields sent to models or rendered as text.
const identities = new WeakMap<object, string>();

export function sessionMessageId(message: object): string {
    let id = identities.get(message);
    if (!id) { id = crypto.randomUUID(); identities.set(message, id); }
    return id;
}

export function knownSessionMessageId(message: object): string | undefined {
    return identities.get(message);
}

export function bindSessionMessageId(message: object, id: string): void {
    identities.set(message, id);
}
