/** Recognizable at the UI boundary, without leaking JSON or adapter error text. */
export class StateCorruptionError extends Error {
    constructor(readonly agentName: string) {
        super(`Agent state could not be recovered: ${agentName}`);
        this.name = 'StateCorruptionError';
    }
}
