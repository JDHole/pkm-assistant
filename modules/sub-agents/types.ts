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
