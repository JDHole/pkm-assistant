export type VaultAdapterLike = {
    exists: (path: string) => Promise<boolean>;
    list: (path: string) => Promise<{ files?: string[] } | null | undefined>;
    read: (path: string) => Promise<string | undefined>;
    write: (path: string, content: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
    remove: (path: string) => Promise<void>;
};

/** Zdarzenie realnego Obsidian `Vault` — opaque referencja do `offref`. */
export type VaultEventRef = unknown;
/** Handler zdarzenia vaulta: `file` bywa `TFile` (ma `.path`) albo gołym stringiem (atrapy testowe). */
export type VaultEventFile = { path?: string } | string;

export type VaultLike = {
    adapter: VaultAdapterLike;
    // W8 (AUD-wydajnosc-028/058/101, follow-up po review koordynatora): opcjonalne —
    // realny Obsidian `Vault` je ma, atrapy testowe bez `.on` po prostu nie dostają nasłuchu
    // (kesz wtedy chroni WYŁĄCZNIE TTL, patrz KomunikatorManager.attachVaultEvents).
    on?: (event: 'create' | 'modify' | 'delete' | 'rename', cb: (file: VaultEventFile, oldPath?: VaultEventFile) => void) => VaultEventRef;
    offref?: (ref: VaultEventRef) => void;
};
export type AgentManagerLike = { _emit?: (event: string, data: Record<string, unknown>) => void } | null;
export type MessageHeader = { id: string; from: string; to: string; subject: string; date: string; userRead: boolean; aiRead: boolean; allRead: boolean; hop: number };
export type Message = MessageHeader & { body: string };
export type MessageFrontmatter = { od: string; do: string; temat: string; data: string; user_read: boolean; ai_read: boolean; hop: number };
export type CleanupItem = { agent: string; id: string };
