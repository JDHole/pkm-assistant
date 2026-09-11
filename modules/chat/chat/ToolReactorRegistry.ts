import type { ChatPlugin, ChatViewLike } from './chatViewShape.js';
import type { ParsedToolCall } from '../../agent-loop/index.js';
import type { TodoState } from './todoPanel.js';

/**
 * Wynik narzędzia widziany przez reaktor. Kształt należy do SERWERA narzędzia — reaktor
 * rozpoznaje swój po polu `type` i dalej czyta wyłącznie to, co sam zadeklarował.
 */
interface ReactorToolResult {
    type?: string;
    [key: string]: unknown;
}

/** Kontekst wołania reaktora — składa go `chat_streaming._chatOnToolResults`. */
interface ToolReactorContext {
    view: ChatViewLike;
    plugin: ChatPlugin;
    toolCall: ParsedToolCall;
    agentName: string;
    toolCallsContainer: HTMLElement | null | undefined;
    isActiveTab: boolean;
}

type ToolReactor = (result: ReactorToolResult | undefined, context: ToolReactorContext) => unknown;

export class ToolReactorRegistry {
    declare reactors: Map<string, ToolReactor>;

    constructor() {
        this.reactors = new Map();
    }

    register(toolName: string, reactor: ToolReactor): void {
        if (!toolName || typeof reactor !== 'function') return;
        this.reactors.set(toolName, reactor);
    }

    async run(toolName: string, result: ReactorToolResult | undefined, context: ToolReactorContext): Promise<boolean> {
        const reactor = this.reactors.get(toolName);
        if (!reactor) return false;
        await reactor(result, context);
        return true;
    }
}

export function createDefaultToolReactorRegistry(): ToolReactorRegistry {
    const registry = new ToolReactorRegistry();
    // Live-widok listy `todo` NAD inputem, aktualizowany przez reactor zamiast pollingiem.
    registry.register('todo', async (result, { view, isActiveTab }) => {
        if (result?.type !== 'todo') return;
        view._activeTodoState = result as TodoState;
        if (isActiveTab) view._renderTodoPanel?.();
    });
    return registry;
}
