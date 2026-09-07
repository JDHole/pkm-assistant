// TS-any: wyniki narzędzi i runtime-składany ChatView mają otwarty kontrakt zależny od serwera.
type Runtime = any;
type ToolReactor = (result: Runtime, context: Runtime) => unknown;

export class ToolReactorRegistry {
    declare reactors: Map<string, ToolReactor>;

    constructor() {
        this.reactors = new Map();
    }

    register(toolName: string, reactor: ToolReactor): void {
        if (!toolName || typeof reactor !== 'function') return;
        this.reactors.set(toolName, reactor);
    }

    async run(toolName: string, result: Runtime, context: Runtime): Promise<boolean> {
        const reactor = this.reactors.get(toolName);
        if (!reactor) return false;
        await reactor(result, context);
        return true;
    }
}

export function createDefaultToolReactorRegistry(): ToolReactorRegistry {
    const registry = new ToolReactorRegistry();
    // E2.9 FAZA D (D2): live-widok listy `todo` NAD inputem (zastąpił ArtifactProgressModal/polling).
    registry.register('todo', async (result, { view, isActiveTab }) => {
        if (result?.type !== 'todo') return;
        view._activeTodoState = result;
        if (isActiveTab) view._renderTodoPanel?.();
    });
    return registry;
}
