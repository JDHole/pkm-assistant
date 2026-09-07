export type ArtifactScalar = string | number | boolean | null;
export type ArtifactFrontmatter = Record<string, ArtifactScalar>;

export interface ArtifactItem {
    blockId: string | null;
    text: string;
    checked: boolean;
}

export interface ArtifactSection {
    heading: string;
    level: number;
    text: string;
    items: ArtifactItem[];
}

export interface ParsedArtifact {
    frontmatter: ArtifactFrontmatter;
    sections: ArtifactSection[];
    buttons: boolean;
}

export interface ArtifactTypeField {
    opis: string;
    domyslne?: ArtifactScalar;
}

export interface ArtifactType {
    name: string;
    slug: string;
    opis: string;
    description: string;
    pola: Record<string, ArtifactTypeField>;
    statusy: string[];
    sprzatanie: number;
    template: string;
    path: string;
    builtin: boolean;
}

export type ArtifactPatchOp =
    | { op: 'set_field'; key: string; value: ArtifactScalar }
    | { op: 'set_section'; heading: string; text: string }
    | { op: 'add_item'; heading: string; text: string }
    | { op: 'remove_item'; blockId: string }
    | { op: 'check_item'; blockId: string }
    | { op: 'uncheck_item'; blockId: string };

export interface ArtifactPatchError {
    op: unknown;
    code: string;
    message: string;
}

export interface ThinArtifact {
    id: string | null;
    path: string | null;
    tytul: string | null;
    typ: string | null;
    agent: string | null;
    status: string | null;
    frontmatter: ArtifactFrontmatter;
    sections: ArtifactSection[];
    buttons: boolean;
}
