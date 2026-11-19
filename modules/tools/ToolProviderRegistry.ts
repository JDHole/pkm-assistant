import { maskSensitiveData } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import { ExternalMcpManager } from './ExternalMcpManager.js';
import type { ToolDefinition, ToolRegistry } from './ToolRegistry.js';

export interface ProviderToolContext { agentName: string | null; isMobile: boolean; signal: AbortSignal }
export interface ProviderTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    timeoutMs?: number;
    execute(args: Record<string, unknown>, context: ProviderToolContext): Promise<unknown>;
}
export interface ToolProviderRegistration { id: string; name: string; description?: string; tools: ProviderTool[] }
export interface ToolProviderHandle { setTools(tools: ProviderTool[]): void; unregister(): void }
export interface PkmAssistantPublicApi { apiVersion: 1; registerToolProvider(provider: ToolProviderRegistration): ToolProviderHandle }

/** In-process providers own no trusted plugin context; their registrations live only in RAM. */
export class ToolProviderRegistry implements PkmAssistantPublicApi {
    readonly apiVersion = 1 as const;
    private readonly providers = new Map<string, { name: string; tools: string[] }>();
    private disposed = false;
    private readonly active = new Map<AbortController, string>();
    constructor(private readonly registry: ToolRegistry, private readonly configuredIds: () => string[], private readonly isMobile: boolean) {}

    has(id: string): boolean { return this.providers.has(id); }
    list(): Array<{ id: string; name: string; toolCount: number }> {
        return [...this.providers].map(([id, entry]) => ({ id, name: entry.name, toolCount: entry.tools.length }));
    }
    registerToolProvider(provider: ToolProviderRegistration): ToolProviderHandle {
        if (this.disposed) throw new Error('Provider registry is unloaded');
        if (!provider || typeof provider.id !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(provider.id) || provider.id.endsWith('\n')) throw new Error('Invalid provider id');
        const { id } = provider;
        if (this.has(id) || Object.hasOwn(this.registry.getBuiltinServerMap(), id) || this.configuredIds().includes(id) || this.registry.getAllTools().some(tool => tool.serverName === id)) throw new Error(`Provider id already in use: ${id}`);
        if (typeof provider.name !== 'string' || provider.name.length < 1 || provider.name.length > 60) throw new Error('Invalid provider name');
        if (provider.description !== undefined && (typeof provider.description !== 'string' || provider.description.length > 300)) throw new Error('Invalid provider description');
        const definitions = this.prepare(id, provider.name, provider.tools);
        const entry = { name: provider.name, tools: [] as string[] };
        this.providers.set(id, entry);
        const replace = (next: ToolDefinition[]) => {
            for (const name of entry.tools) this.registry.unregisterTool(name);
            entry.tools = next.map(tool => tool.name);
            for (const tool of next) this.registry.registerTool(tool);
        };
        replace(definitions);
        return {
            setTools: tools => { if (this.providers.get(id) === entry) replace(this.prepare(id, entry.name, tools)); },
            unregister: () => {
                if (this.providers.get(id) !== entry) return;
                replace([]); this.providers.delete(id);
                for (const [controller, owner] of this.active) if (owner === id) controller.abort();
            },
        };
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const entry of this.providers.values()) for (const name of entry.tools) this.registry.unregisterTool(name);
        this.providers.clear();
        for (const controller of this.active.keys()) controller.abort();
    }
    private prepare(id: string, label: string, tools: ProviderTool[]): ToolDefinition[] {
        if (!Array.isArray(tools) || tools.length > 64) throw new Error('Invalid provider tools');
        const names = new Set<string>();
        return Array.from(tools, tool => {
            if (!tool || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{1,47}$/.test(tool.name) || tool.name.endsWith('\n') || names.has(tool.name)) throw new Error('Invalid or duplicate tool name');
            names.add(tool.name);
            if (typeof tool.description !== 'string' || tool.description.length < 1 || tool.description.length > 2000) throw new Error('Invalid tool description');
            if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema) || tool.inputSchema.type !== 'object') throw new Error('Invalid tool input schema');
            if (tool.timeoutMs !== undefined && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1000 || tool.timeoutMs > 120000)) throw new Error('Invalid tool timeout');
            if (typeof tool.execute !== 'function') throw new Error('Invalid tool execute');
            // Snapshot JSON data: later mutations by the registering plugin require setTools.
            let inputSchema: Record<string, unknown>;
            try { inputSchema = JSON.parse(jsonValue(tool.inputSchema)) as Record<string, unknown>; }
            catch { throw new Error('Invalid tool input schema: expected JSON data'); }
            if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema) || inputSchema.type !== 'object') throw new Error('Invalid tool input schema');
            const name = `${id}__${tool.name}`;
            const existing = this.registry.getTool(name);
            if (existing && !this.providers.get(id)?.tools.includes(name)) throw new Error(`Tool already registered: ${name}`);
            const run = tool.execute.bind(tool);
            const timeout = tool.timeoutMs ?? 30000;
            const executeProvider = async (args: Record<string, unknown>, agentName: string | null, signal?: AbortSignal): Promise<unknown> => {
                if (this.disposed || this.registry.getTool(name)?.executeProvider !== executeProvider) {
                    return { isError: true, error: t('mcp.provider.unavailable') };
                }
                const controller = new AbortController();
                this.active.set(controller, id);
                const abort = () => controller.abort();
                let timer: ReturnType<typeof setTimeout> | undefined;
                let cancel: (() => void) | undefined;
                try {
                    const interrupted = new Promise<never>((_, reject) => {
                        cancel = () => reject(new Error(t('chat.substrip.status_aborted')));
                        controller.signal.addEventListener('abort', cancel, { once: true });
                        signal?.addEventListener('abort', abort, { once: true });
                        if (signal?.aborted) abort();
                    });
                    const timedOut = new Promise<never>((_, reject) => {
                        // Browser timers, also usable in the plain JS test host.
                        const schedule = setTimeout;
                        timer = schedule(() => {
                            reject(new Error(t('mcp.provider.timeout', { timeout })));
                            controller.abort();
                        }, timeout);
                    });
                    const result = await Promise.race([
                        interrupted, timedOut,
                        Promise.resolve().then(() => {
                            if (controller.signal.aborted) throw new Error(t('chat.substrip.status_aborted'));
                            return run(ExternalMcpManager.stripInternalArgs(args) as Record<string, unknown>, {
                                agentName, isMobile: this.isMobile, signal: controller.signal,
                            });
                        }),
                    ]);
                    const json = jsonValue(result);
                    const snapshot: unknown = JSON.parse(json);
                    // AgentLoop reserves arrays for trusted multimodal blocks. Provider arrays
                    // are JSON data and must take the ordinary text serialization/budget path.
                    return Array.isArray(snapshot) ? json : snapshot;
                } catch (error) {
                    return { isError: true, error: maskSensitiveData(error instanceof Error ? error.message : String(error)) };
                } finally {
                    const clear = clearTimeout;
                    if (timer !== undefined) clear(timer);
                    signal?.removeEventListener('abort', abort);
                    if (cancel) controller.signal.removeEventListener('abort', cancel);
                    this.active.delete(controller);
                }
            };
            return { name, description: `[${label}] ${tool.description}`, inputSchema, serverName: id, source: 'user', execute: async () => ({ isError: true, error: t('mcp.provider.unavailable') }), executeProvider };
        });
    }
}

/** Reject lossy JSON values as well as cycles/BigInt; never hand live objects to the loop. */
function jsonValue(value: unknown): string {
    const json = JSON.stringify(value, (_key, item: unknown) => {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol'
            || (typeof item === 'number' && !Number.isFinite(item))) {
            throw new Error(t('mcp.provider.invalid_result'));
        }
        return item;
    });
    if (json === undefined) throw new Error(t('mcp.provider.invalid_result'));
    return json;
}
