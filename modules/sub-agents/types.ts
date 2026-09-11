import type { PluginApi } from '../../core/index.js';
import type { Agent } from '../agents/index.js';
import type { SubAgentLoader } from './SubAgentLoader.js';
import type { SubAgentTemplateStore } from './SubAgentTemplateStore.js';

export type ScopeData = {
    folders: string[];
    frontmatter: Record<string, unknown>;
    sections: string[];
    pinned_notes: string[];
};

export type SubAgentData = {
    name: string;
    description: string;
    role: string | null;
    model: string | null;
    tools: string[];
    scope: ScopeData | null;
    scope_type?: string;
    max_iterations: number | null;
    min_iterations: number | null;
    max_tool_result_length: number | null;
    model_timeout?: number;
    enabled: boolean;
    prompt: string;
    from_template?: string | null;
    path?: string;
    format?: string;
    version?: number;
    slug?: string;
    folderPath?: string;
    isTemplate?: boolean;
};

export type SubAgentInput = Partial<SubAgentData> & Pick<SubAgentData, 'name' | 'description'>;

export type SubAgentYaml = {
    name: string;
    description: string;
    role: string;
    model?: string | null;
    tools?: string[];
    scope?: ScopeData | null;
    max_iterations?: number | null;
    min_iterations?: number | null;
    max_tool_result_length?: number | null;
    enabled?: boolean;
    from_template?: string | null;
    version?: number;
};

/**
 * Kształt YAML-a suba/szablonu jak wraca z `parseYaml`, PRZED sprawdzeniem wymaganych pól —
 * `SubAgentLoader`/`SubAgentTemplateStore` parsują najpierw, walidują `name`/`description`
 * dopiero potem. Dlatego wszystko jest opcjonalne (na dysku user może edytować plik ręcznie
 * i zostawić go niekompletnym), w odróżnieniu od `SubAgentYaml` (kształt zapisu).
 */
export type SubAgentYamlRaw = Partial<SubAgentYaml> & { scope_type?: string };

type VaultAdapterLike = {
    exists: (path: string) => Promise<boolean>;
    list: (path: string) => Promise<{ folders?: string[] } | null | undefined>;
    read: (path: string) => Promise<string>;
    write: (path: string, content: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
    remove: (path: string) => Promise<void>;
    rmdir: (path: string, recursive: boolean) => Promise<void>;
};
export type VaultLike = { adapter: VaultAdapterLike };

/**
 * Minimalny widok AgentManagera, jakiego potrzebuje UI subów (karty Zaplecza, modal edycji,
 * widok detalu). Ten sam wzorzec co `DelegateAgentManager` w `modules/tools/DelegateTool.ts` —
 * lokalny duck-type: `AgentManager` (moduł-właściciel, `modules/agents/`) jeszcze nie typuje
 * własnych pól (`subAgentLoader`/`subAgentTemplateStore` są tam `any` — osobna fala refaktoru),
 * więc branie stąd typu klasy wprost przeciekałoby `any` z powrotem do tego modułu.
 */
export interface SubAgentsAgentManagerLike {
    getActiveAgent?(): Agent | null | undefined;
    /** Wołane pod pojedynczym `agentManager?.` (bez drugiego `?.`) — więc NIE opcjonalna. */
    getAllAgents(): Agent[];
    getAgent?(name: string): Agent | null | undefined;
    /** Wołane bez `?.` w ogóle (za strażnikiem `if (!agent) return`) — NIE opcjonalna. */
    updateAgent(name: string, updates: Parameters<Agent['update']>[0]): Promise<unknown>;
    subAgentLoader?: SubAgentLoader;
    subAgentTemplateStore?: SubAgentTemplateStore;
}

/** Kształt pluginu widziany przez UI subów (karty Zaplecza, modal, widok detalu). */
export interface SubAgentsPlugin extends PluginApi {
    agentManager?: SubAgentsAgentManagerLike | null;
    /** Rejestr narzędzi — `filterByAgent` steruje listą widoczną w modalu edycji suba.
     * Realny `ToolDefinition.name` (`modules/tools/ToolRegistry.ts`) jest wymagany, nie opcjonalny. */
    toolRegistry?: { filterByAgent?(agent: unknown): Array<{ name: string }> } | null;
}
