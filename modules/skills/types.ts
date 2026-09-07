export type SkillQuestion = {
    key: string;
    question: string;
    default: string;
    type: string;
    options?: unknown;
    depends_on?: unknown;
    placeholder?: unknown;
    rows?: unknown;
};

export type SkillData = {
    name: string;
    slug: string;
    description: string;
    category: string;
    version: number;
    enabled: boolean;
    preQuestions: SkillQuestion[] | null;
    prompt: string;
    path: string;
    icon: string | null;
    tags: string[] | null;
    model: string | null;
    argumentHint: string | null;
    disableModelInvocation: boolean;
    userInvocable: boolean;
    fromTemplate: string | null;
    folderPath?: string;
    hasTemplate?: boolean;
    hasReferences?: boolean;
    hasExamples?: boolean;
    isTemplate?: boolean;
};

export type SkillInput = Partial<Omit<SkillData, 'name' | 'description'>> & {
    name: string;
    description: string;
    allowedTools?: unknown;
};

export type VaultAdapterLike = {
    exists: (path: string) => Promise<boolean>;
    list: (path: string) => Promise<{ folders?: string[] } | null | undefined>;
    read: (path: string) => Promise<string>;
    write: (path: string, content: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
    remove: (path: string) => Promise<void>;
    rmdir: (path: string, recursive: boolean) => Promise<void>;
};

export type VaultLike = { adapter: VaultAdapterLike };
