import type { PluginApi } from '../../core/index.js';
import type { Agent } from '../agents/index.js';
import type { SkillLoader } from './SkillLoader.js';
import type { SkillTemplateStore } from './SkillTemplateStore.js';

export type SkillQuestion = {
    key: string;
    question: string;
    default: string;
    // Opcjonalne: `SkillEditorModal` (formularz „+ dodaj pytanie") nie ma pola UI na `type` i
    // nigdy go nie ustawia — na dysku brakujący `type` dostaje default `'text'` DOPIERO przy
    // odczycie (`parseSkillMarkdown`). Wymaganie go tu złamałoby literał `{key,question,default}`
    // dopisywany przez modal.
    type?: string;
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

/**
 * Minimalny widok AgentManagera, jakiego potrzebuje UI skilli (karty Zaplecza, modal edycji,
 * widok detalu). Ten sam wzorzec co `SubAgentsAgentManagerLike` (`modules/sub-agents/types.ts`)
 * i `DelegateAgentManager` (`modules/tools/DelegateTool.ts`) — lokalny duck-type, bo
 * `AgentManager` (moduł-właściciel, `modules/agents/`) jeszcze nie typuje własnych pól
 * (`skillLoader`/`skillTemplateStore` są tam `any` — osobna fala refaktoru).
 */
export interface SkillsAgentManagerLike {
    getActiveAgent?(): Agent | null | undefined;
    /** Wołane pod pojedynczym `agentManager?.` (bez drugiego `?.`) — więc NIE opcjonalna. */
    getAllAgents(): Agent[];
    getAgent?(name: string): Agent | null | undefined;
    /** Wołane bez `?.` w ogóle (za strażnikiem `if (!agent) return`) — NIE opcjonalna. */
    updateAgent(name: string, updates: Parameters<Agent['update']>[0]): Promise<unknown>;
    skillLoader?: SkillLoader;
    skillTemplateStore?: SkillTemplateStore;
}

/** Kształt pluginu widziany przez UI skilli (karty Zaplecza, modal, widok detalu). */
export interface SkillsPlugin extends PluginApi {
    agentManager?: SkillsAgentManagerLike | null;
}
